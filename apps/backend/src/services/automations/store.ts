import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import {
  AUTOMATION_ID_PATTERN,
  AUTOMATION_LIMITS,
  AUTOMATION_RUN_LOCATIONS,
  automationDeliverySchema,
  automationRunSchema,
  automationTriggerSchema,
  modelSelectionSchema,
  type AutomationDelivery,
  type AutomationRun,
} from "@betterc0de/schema"
import { logger } from "../../observability/logger"
import { readRegularFile, writeFileAtomic } from "../desktop-config/files"

/**
 * Where automations live: two files in the runtime home, next to the other
 * desktop configuration (`hooks.json`, `mcp-servers.json`).
 *
 * - `automations.json`: the definitions. The webhook token and the GitHub
 *   signature secret are stored encrypted with the desktop's key
 *   (`settings/crypto.ts`), like MCP secrets, and never sent back to a
 *   client except as the webhook path on the desktop's own page.
 * - `automation-history.json`: per automation, when the scheduler last
 *   handled a due run and the last 50 runs and webhook deliveries.
 *
 * Both are replaced atomically. A file that cannot be read is moved aside
 * (`<name>.unreadable-<uuid>`) instead of being overwritten, and the
 * service starts without it.
 */

export const AUTOMATIONS_FILE = "automations.json"
export const AUTOMATION_HISTORY_FILE = "automation-history.json"

const MAX_DEFINITIONS_BYTES = 8 * 1024 * 1024
const MAX_HISTORY_BYTES = 16 * 1024 * 1024

export const storedAutomationSchema = z.object({
  id: z.string().regex(AUTOMATION_ID_PATTERN),
  name: z.string().min(1),
  projectPath: z.string().min(1),
  prompt: z.string(),
  providerKind: z.string().min(1),
  providerInstanceId: z.string().nullable(),
  modelId: z.string().min(1),
  modelSelection: modelSelectionSchema.nullable(),
  reasoningEffort: z.string().nullable(),
  permissionLevel: z.string().min(1),
  runLocation: z.enum(AUTOMATION_RUN_LOCATIONS),
  trigger: automationTriggerSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** When the schedule was last set; intervals count from here. */
  scheduleAnchorAt: z.string(),
  /** The webhook URL's token as stored (encrypted where a key exists). */
  webhookToken: z.string().nullable(),
  /** The GitHub signature secret as stored (encrypted), or `null`. */
  webhookSecret: z.string().nullable(),
})
export type StoredAutomation = z.infer<typeof storedAutomationSchema>

const historySchema = z.object({
  lastHandledAt: z.string().nullable(),
  runs: z.array(automationRunSchema),
  deliveries: z.array(automationDeliverySchema),
})
export interface AutomationHistory {
  /** The last moment the scheduler handled a due run; nothing before it is due. */
  lastHandledAt: string | null
  /** Newest first, at most `AUTOMATION_LIMITS.maxHistory`. */
  runs: AutomationRun[]
  /** Newest first, at most `AUTOMATION_LIMITS.maxHistory`. */
  deliveries: AutomationDelivery[]
}

export function emptyAutomationHistory(): AutomationHistory {
  return { lastHandledAt: null, runs: [], deliveries: [] }
}

export interface AutomationStoreSnapshot {
  readonly automations: StoredAutomation[]
  readonly history: Record<string, AutomationHistory>
}

export interface AutomationStore {
  /** Never throws: an unreadable file is moved aside and reads as empty. */
  load(): AutomationStoreSnapshot
  saveAutomations(automations: readonly StoredAutomation[]): void
  saveHistory(history: Readonly<Record<string, AutomationHistory>>): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class FileAutomationStore implements AutomationStore {
  readonly automationsFile: string
  readonly historyFile: string

  constructor(home: string) {
    if (!path.isAbsolute(home)) {
      throw new Error("The automations folder must be an absolute path")
    }
    this.automationsFile = path.join(home, AUTOMATIONS_FILE)
    this.historyFile = path.join(home, AUTOMATION_HISTORY_FILE)
  }

  load(): AutomationStoreSnapshot {
    return {
      automations: this.loadAutomations(),
      history: this.loadHistory(),
    }
  }

  saveAutomations(automations: readonly StoredAutomation[]): void {
    this.write(this.automationsFile, { version: 1, automations })
  }

  saveHistory(history: Readonly<Record<string, AutomationHistory>>): void {
    this.write(this.historyFile, { version: 1, automations: history })
  }

  private write(file: string, document: unknown): void {
    writeFileAtomic(file, Buffer.from(`${JSON.stringify(document, null, 2)}\n`))
  }

  private loadAutomations(): StoredAutomation[] {
    const document = this.readJson(this.automationsFile, MAX_DEFINITIONS_BYTES)
    if (document === null) return []
    const list = z
      .object({ automations: z.array(z.unknown()) })
      .safeParse(document)
    if (!list.success) {
      this.moveAside(this.automationsFile, "it is not a list of automations")
      return []
    }
    const automations: StoredAutomation[] = []
    const ids = new Set<string>()
    let dropped = 0
    for (const entry of list.data.automations.slice(
      0,
      AUTOMATION_LIMITS.maxAutomations
    )) {
      const parsed = storedAutomationSchema.safeParse(entry)
      if (!parsed.success || ids.has(parsed.data.id)) {
        dropped += 1
        continue
      }
      ids.add(parsed.data.id)
      automations.push(parsed.data)
    }
    if (
      dropped > 0 ||
      list.data.automations.length > AUTOMATION_LIMITS.maxAutomations
    ) {
      // Keep the original before the next save writes the usable entries.
      this.copyAside(this.automationsFile)
      logger.warn(
        { dropped },
        "automations.json had entries that could not be read; a copy was kept"
      )
    }
    return automations
  }

  private loadHistory(): Record<string, AutomationHistory> {
    const document = this.readJson(this.historyFile, MAX_HISTORY_BYTES)
    if (document === null) return {}
    const parsed = z
      .object({ automations: z.record(z.string(), z.unknown()) })
      .safeParse(document)
    if (!parsed.success) {
      this.moveAside(this.historyFile, "it is not an automation history")
      return {}
    }
    const history: Record<string, AutomationHistory> = {}
    for (const [id, value] of Object.entries(parsed.data.automations)) {
      const entry = historySchema.safeParse(value)
      // A history entry that does not read is dropped; it is only a log.
      if (!entry.success || !AUTOMATION_ID_PATTERN.test(id)) continue
      history[id] = {
        lastHandledAt: entry.data.lastHandledAt,
        runs: entry.data.runs.slice(0, AUTOMATION_LIMITS.maxHistory),
        deliveries: entry.data.deliveries.slice(
          0,
          AUTOMATION_LIMITS.maxHistory
        ),
      }
    }
    return history
  }

  /** The parsed JSON of `file`, or `null` when it is absent or unusable. */
  private readJson(file: string, maxBytes: number): unknown {
    let bytes: Buffer | null
    try {
      bytes = readRegularFile(file, maxBytes)
    } catch (error) {
      this.moveAside(file, errorMessage(error))
      return null
    }
    if (bytes === null) return null
    try {
      return JSON.parse(bytes.toString("utf8"))
    } catch {
      this.moveAside(file, "it is not valid JSON")
      return null
    }
  }

  private moveAside(file: string, reason: string): void {
    const target = `${file}.unreadable-${randomUUID()}`
    try {
      fs.renameSync(file, target)
      logger.warn(
        { file: path.basename(file), reason, movedTo: path.basename(target) },
        "an automations file could not be read and was moved aside"
      )
    } catch (error) {
      logger.error(
        { file: path.basename(file), reason, err: errorMessage(error) },
        "an unreadable automations file could not be moved aside"
      )
    }
  }

  private copyAside(file: string): void {
    try {
      fs.copyFileSync(
        file,
        `${file}.unreadable-${randomUUID()}`,
        fs.constants.COPYFILE_EXCL
      )
    } catch (error) {
      logger.error(
        { file: path.basename(file), err: errorMessage(error) },
        "a copy of automations.json could not be kept"
      )
    }
  }
}
