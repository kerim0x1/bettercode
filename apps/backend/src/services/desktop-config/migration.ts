import {
  runtimeHookRecordSchema,
  runtimeMcpServerRecordSchema,
  RUNTIME_MCP_LIMITS,
} from "@betterc0de/schema/runtime-records"
import path from "node:path"
import { logger } from "../../observability/logger"
import {
  parseSettingsArgs,
  parseSettingsEnvironment,
} from "../../provider/runtime/acp/AcpMcpServers"
import {
  decryptSecret,
  encryptSecret,
  getMasterKey,
  isEncrypted,
} from "../../settings/crypto"
import { writeFileAtomic } from "./files"
import type {
  DesktopConfigStore,
  StoredDirectoryEntry,
  StoredEntry,
} from "./store"

/**
 * One-time move of the desktop configuration out of `settings.json`.
 *
 * Rules, skills, MCP servers and hooks used to have two stores each: keys in
 * `settings.json` (`custom_rules`, `skills`, `mcp_servers`, `hooks`) and the
 * files in the runtime home. The files are the one store now, owned by this
 * backend (store.ts). At boot, whatever the legacy keys still hold is merged
 * into the files, then the keys are removed from `settings.json`.
 *
 * Nothing is lost and nothing starts doing more than it did:
 * - `custom_rules` is added to `rules.md` (after its content, the order the
 *   two were applied in); text already in `rules.md` is not added twice.
 * - `mcp_servers` become `mcp-servers.json` entries with the same id (their
 *   `envVars` encrypted like the desktop's own entries). They were attached
 *   to turns before and still are. A desktop entry with the same id, which
 *   they used to shadow, is kept, disabled, under a new id.
 * - `hooks` never ran from settings (only `hooks.json` did); they are added
 *   without an approval marker, so they still do not run until the user
 *   approves them on the desktop.
 * - `skills` were never put into prompts from settings; they are added
 *   disabled, with their prompt template as content.
 * - Anything a store cannot hold (an MCP server whose command or arguments
 *   exceed the limits, an environment variable BetterC0de refuses to pass,
 *   hooks beyond what a turn reads) goes to
 *   `settings-config-unmigrated-<time>.json` next to the files, secrets
 *   encrypted.
 *
 * Idempotent: an entry already merged is recognized by id and content, so
 * a run that stopped before the keys were removed is simply repeated. A key
 * is removed only after its values were stored; if `settings.json` cannot be
 * written, the keys stay and the readers keep honoring them.
 *
 * Also moved here from the desktop: plaintext MCP secrets that an older
 * desktop left in `mcp-servers.json` are encrypted once the settings key is
 * available.
 */

export const LEGACY_DESKTOP_CONFIG_SETTINGS_KEYS = [
  "custom_rules",
  "skills",
  "mcp_servers",
  "hooks",
] as const

type LegacyKey = (typeof LEGACY_DESKTOP_CONFIG_SETTINGS_KEYS)[number]

/** Most hooks a turn reads from `hooks.json` (turn preparation's limit). */
const MAX_HOOKS_READ_BY_TURNS = 256
const MAX_SLUG_CHARS = 120
const MCP_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** Environment names the desktop refuses for MCP servers (apps/shell/mcp-ipc.cjs). */
const FORBIDDEN_MCP_ENV_KEYS = new Set([
  "BETTERC0DE_SETTINGS_KEY",
  "BASH_ENV",
  "ENV",
  "ELECTRON_RUN_AS_NODE",
  "LD_AUDIT",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
])

export interface MigrationSettings {
  get(): unknown
  update(patch: Record<string, unknown>): unknown
}

export interface DesktopConfigMigrationReport {
  encryptedMcpSecrets: number
  rules: "none" | "already-present" | "written"
  mcpServers: number
  hooks: number
  skills: number
  /** Desktop entries kept under a new id because a migrated one took theirs. */
  renamed: string[]
  leftovers: number
  leftoverFile: string | null
  /** Legacy keys removed from settings.json. */
  cleared: LegacyKey[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** The desktop's `slugify` (apps/shell/shared/runtime-paths.cjs). */
export function desktopSlug(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
}

/** `base-suffix`, `base-suffix-2`, … — the first id not in `taken`. */
function freeId(
  base: string,
  suffix: string,
  taken: ReadonlySet<string>
): string {
  const room = MAX_SLUG_CHARS - suffix.length - 4
  const stem = base.slice(0, Math.max(1, room)).replace(/-+$/g, "")
  let candidate = `${stem}-${suffix}`
  for (let index = 2; taken.has(candidate); index += 1) {
    candidate = `${stem}-${suffix}-${index}`
  }
  return candidate
}

/** A secret as the desktop stores it: encrypted when a key exists, empty as is. */
function sealed(value: string): string {
  return value && getMasterKey() ? encryptSecret(value) : value
}

/** A record's secret-bearing values (`env`, `headers`) mapped by `transform`. */
function mapMcpSecrets(
  entry: StoredEntry,
  transform: (value: string) => string
): { entry: StoredEntry; changed: boolean } {
  let changed = false
  const next: Record<string, unknown> = { ...entry }
  for (const field of ["env", "headers"] as const) {
    const record = entry[field]
    if (!isPlainRecord(record)) continue
    const mapped: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(record)) {
      const output = typeof value === "string" ? transform(value) : value
      if (output !== value) changed = true
      Object.defineProperty(mapped, name, {
        value: output,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    next[field] = mapped
  }
  return { entry: next as StoredEntry, changed }
}

/**
 * Encrypt the plaintext `env`/`headers` values an older desktop left in
 * `mcp-servers.json` (the desktop did this itself before the backend owned
 * the file). Without a settings key the values stay as they are, matching
 * the settings fallback. Returns the number of entries changed.
 */
export function encryptStoredMcpSecrets(store: DesktopConfigStore): number {
  if (!getMasterKey()) return 0
  const document = store.readMcp()
  if (document.problem || document.entries.length === 0) return 0
  let changedEntries = 0
  const entries = document.entries.map((entry) => {
    const { entry: next, changed } = mapMcpSecrets(entry, (value) =>
      value && !isEncrypted(value) ? encryptSecret(value) : value
    )
    if (changed) changedEntries += 1
    return next
  })
  if (changedEntries > 0) store.writeMcp(entries, document.revision)
  return changedEntries
}

function plainEnvironment(record: unknown): Record<string, string> | null {
  if (record === undefined) return {}
  if (!isPlainRecord(record)) return null
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== "string") return null
    const plain = isEncrypted(value) ? decryptSecret(value) : value
    if (plain === null) return null
    output[name] = plain
  }
  return output
}

function sameEnvironment(
  left: Record<string, string> | null,
  right: Record<string, string>
): boolean {
  if (!left) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && right[key] === left[key])
  )
}

interface Leftover {
  readonly kind: LegacyKey | "mcp_servers.env"
  readonly reason: string
  readonly value: unknown
}

/** A legacy `settings.mcp_servers` entry as the desktop store keeps it. */
function migratedMcpRecord(
  server: Record<string, unknown>,
  id: string,
  installedAt: string,
  leftovers: Leftover[]
): { record: StoredEntry; env: Record<string, string> } | null {
  const command = text(server.command).trim()
  const args = parseSettingsArgs(text(server.args))
  const environment = parseSettingsEnvironment(text(server.envVars))
  const unmigrated = (reason: string): null => {
    leftovers.push({
      kind: "mcp_servers",
      reason,
      value: { ...server, envVars: sealed(text(server.envVars)) },
    })
    return null
  }
  if (!command) return unmigrated("it has no command")
  if (!args) return unmigrated("its arguments exceed the MCP limits")
  if (!environment) return unmigrated("its environment exceeds the MCP limits")
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    const upper = name.toUpperCase()
    if (
      !MCP_ENV_KEY_RE.test(name) ||
      FORBIDDEN_MCP_ENV_KEYS.has(upper) ||
      upper.startsWith("DYLD_") ||
      value.length > RUNTIME_MCP_LIMITS.maxEnvValueChars
    ) {
      // BetterC0de no longer passes such a variable to an MCP server; the
      // server is kept, the value is set aside.
      leftovers.push({
        kind: "mcp_servers.env",
        reason:
          "BetterC0de does not pass this environment variable to MCP servers",
        value: { serverId: id, name, value: sealed(value) },
      })
      continue
    }
    env[name] = value
  }
  const record: StoredEntry = {
    id,
    name: text(server.name).trim() || id,
    command,
    args,
    env: Object.fromEntries(
      Object.entries(env).map(([name, value]) => [name, sealed(value)])
    ),
    enabled: server.enabled !== false,
    installedAt,
    type: "command",
    url: null,
    authenticated: false,
  }
  if (!runtimeMcpServerRecordSchema.safeParse(record).success) {
    return unmigrated("it exceeds the MCP limits")
  }
  return { record, env }
}

function migrateMcpServers(
  store: DesktopConfigStore,
  servers: ReadonlyArray<unknown>,
  installedAt: string,
  report: DesktopConfigMigrationReport,
  leftovers: Leftover[]
): void {
  const document = store.readMcp()
  const entries: StoredEntry[] = [...document.entries]
  const taken = new Set(entries.map((entry) => entry.id))
  let added = 0
  for (const [index, raw] of servers.entries()) {
    if (!isPlainRecord(raw)) continue
    const id = desktopSlug(raw.id || raw.name) || `settings-mcp-${index + 1}`
    const migrated = migratedMcpRecord(raw, id, installedAt, leftovers)
    if (!migrated) continue
    const existingIndex = entries.findIndex((entry) => entry.id === id)
    const existing = existingIndex >= 0 ? entries[existingIndex]! : null
    if (
      existing &&
      text(existing.command) === migrated.record.command &&
      JSON.stringify(existing.args ?? []) ===
        JSON.stringify(migrated.record.args) &&
      sameEnvironment(plainEnvironment(existing.env), migrated.env)
    ) {
      continue
    }
    if (entries.length >= RUNTIME_MCP_LIMITS.maxServers) {
      leftovers.push({
        kind: "mcp_servers",
        reason: `mcp-servers.json holds at most ${RUNTIME_MCP_LIMITS.maxServers} servers`,
        value: { ...raw, envVars: sealed(text(raw.envVars)) },
      })
      continue
    }
    if (existing) {
      // The settings server used to win over this entry; keep the entry,
      // disabled, so behavior stays and nothing is deleted.
      const renamedId = freeId(id, "previous", taken)
      taken.add(renamedId)
      entries[existingIndex] = { ...existing, id: renamedId, enabled: false }
      report.renamed.push(`mcp-servers.json: ${id} -> ${renamedId}`)
    }
    taken.add(id)
    entries.push(migrated.record)
    added += 1
  }
  if (added > 0 || report.renamed.length > 0) {
    store.writeMcp(entries, document.revision)
  }
  report.mcpServers = added
}

function migrateHooks(
  store: DesktopConfigStore,
  hooks: ReadonlyArray<unknown>,
  now: string,
  report: DesktopConfigMigrationReport,
  leftovers: Leftover[]
): void {
  const document = store.readHooks()
  const entries: StoredEntry[] = [...document.entries]
  const taken = new Set(entries.map((entry) => entry.id))
  let added = 0
  for (const raw of hooks) {
    if (!isPlainRecord(raw)) continue
    const command = text(raw.command)
    const event = text(raw.event) || "on_message_send"
    const settingsId = text(raw.id)
    const alreadyMigrated = entries.some(
      (entry) =>
        (entry.id === settingsId ||
          (entry.migratedFrom === "settings.hooks" &&
            entry.settingsId === settingsId)) &&
        text(entry.command) === command &&
        (text(entry.event) || "on_message_send") === event
    )
    if (alreadyMigrated) continue
    const baseId = settingsId.trim() || "settings-hook"
    const id = taken.has(baseId)
      ? freeId(desktopSlug(baseId) || "hook", "settings", taken)
      : baseId
    // Never approved: it does not run until the user saves it on the desktop.
    const record = {
      id,
      event,
      command,
      enabled: raw.enabled !== false,
      approval: null,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastStatus: "idle",
      lastExitCode: null,
      lastError: null,
      migratedFrom: "settings.hooks",
      settingsId,
    }
    if (!runtimeHookRecordSchema.safeParse(record).success) {
      leftovers.push({
        kind: "hooks",
        reason: "it is not a valid hook",
        value: raw,
      })
      continue
    }
    if (entries.length >= MAX_HOOKS_READ_BY_TURNS) {
      leftovers.push({
        kind: "hooks",
        reason: `turns read at most ${MAX_HOOKS_READ_BY_TURNS} hooks`,
        value: raw,
      })
      continue
    }
    taken.add(id)
    entries.push(record)
    added += 1
  }
  if (added > 0) store.writeHooks(entries, document.revision)
  report.hooks = added
}

function migrateSkills(
  store: DesktopConfigStore,
  skills: ReadonlyArray<unknown>,
  now: string,
  report: DesktopConfigMigrationReport
): void {
  const existing = new Map<string, StoredDirectoryEntry>(
    store.listDirectory("skills").map((entry) => [entry.id, entry])
  )
  const taken = new Set(existing.keys())
  let added = 0
  for (const [index, raw] of skills.entries()) {
    if (!isPlainRecord(raw)) continue
    const content = text(raw.promptTemplate)
    const baseId =
      desktopSlug(raw.id || raw.name) || `settings-skill-${index + 1}`
    const alreadyMigrated = [...existing.values()].some(
      (entry) =>
        entry.manifest.migratedFrom === "settings.skills" &&
        entry.manifest.settingsId === text(raw.id) &&
        entry.text === content
    )
    if (alreadyMigrated) continue
    const id = taken.has(baseId) ? freeId(baseId, "settings", taken) : baseId
    taken.add(id)
    store.putDirectoryEntry(
      "skills",
      id,
      {
        id,
        name: text(raw.name).trim() || id,
        version: "1.0.0",
        public: false,
        // Settings skills were never put into prompts; enabling one is the
        // user's decision.
        enabled: false,
        description: text(raw.description),
        createdAt: now,
        updatedAt: now,
        source: "settings",
        migratedFrom: "settings.skills",
        settingsId: text(raw.id),
        settingsEnabled: raw.enabled !== false,
        triggerPattern: text(raw.triggerPattern),
      },
      content
    )
    added += 1
  }
  report.skills = added
}

function migrateRules(
  store: DesktopConfigStore,
  customRules: string,
  report: DesktopConfigMigrationReport
): void {
  if (!customRules.trim()) return
  const current = store.readRules()
  if (current.content.includes(customRules.trim())) {
    report.rules = "already-present"
    return
  }
  const base = current.content.replace(/\s+$/u, "")
  store.writeRules(
    base ? `${base}\n\n${customRules}` : customRules,
    current.revision
  )
  report.rules = "written"
}

function writeLeftovers(
  store: DesktopConfigStore,
  leftovers: ReadonlyArray<Leftover>,
  now: Date
): string {
  const file = path.join(
    store.paths.home,
    `settings-config-unmigrated-${now.toISOString().replace(/[:.]/g, "-")}.json`
  )
  writeFileAtomic(
    file,
    Buffer.from(
      JSON.stringify(
        {
          note: "Values from settings.json that BetterC0de could not move into its configuration files. Secrets are encrypted with this computer's settings key.",
          createdAt: now.toISOString(),
          items: leftovers,
        },
        null,
        2
      ),
      "utf8"
    )
  )
  return file
}

/**
 * Run the one-time migration. Never throws: a part that fails is logged and
 * its settings key is kept, so the next start tries again.
 */
export function migrateDesktopConfig(
  store: DesktopConfigStore,
  settings: MigrationSettings,
  options: { readonly now?: () => Date } = {}
): DesktopConfigMigrationReport {
  const now = (options.now ?? (() => new Date()))()
  const timestamp = now.toISOString()
  const report: DesktopConfigMigrationReport = {
    encryptedMcpSecrets: 0,
    rules: "none",
    mcpServers: 0,
    hooks: 0,
    skills: 0,
    renamed: [],
    leftovers: 0,
    leftoverFile: null,
    cleared: [],
  }
  try {
    report.encryptedMcpSecrets = encryptStoredMcpSecrets(store)
  } catch (error) {
    logger.warn(
      { err: error },
      "desktop config: could not encrypt stored MCP secrets"
    )
  }

  const legacy = settings.get() as Partial<Record<LegacyKey, unknown>>
  const present = LEGACY_DESKTOP_CONFIG_SETTINGS_KEYS.filter(
    (key) => legacy[key] !== undefined
  )
  if (present.length === 0) return report

  const leftovers: Leftover[] = []
  const migrated = new Set<LegacyKey>()
  const attempt = (key: LegacyKey, run: () => void) => {
    if (!present.includes(key)) return
    try {
      run()
      migrated.add(key)
    } catch (error) {
      logger.warn(
        { err: error, key },
        "desktop config: could not move a settings key into its file; it stays in settings.json"
      )
    }
  }
  attempt("custom_rules", () =>
    migrateRules(store, text(legacy.custom_rules), report)
  )
  attempt("mcp_servers", () =>
    migrateMcpServers(
      store,
      Array.isArray(legacy.mcp_servers) ? legacy.mcp_servers : [],
      timestamp,
      report,
      leftovers
    )
  )
  attempt("hooks", () =>
    migrateHooks(
      store,
      Array.isArray(legacy.hooks) ? legacy.hooks : [],
      timestamp,
      report,
      leftovers
    )
  )
  attempt("skills", () =>
    migrateSkills(
      store,
      Array.isArray(legacy.skills) ? legacy.skills : [],
      timestamp,
      report
    )
  )

  if (leftovers.length > 0) {
    try {
      report.leftoverFile = writeLeftovers(store, leftovers, now)
      report.leftovers = leftovers.length
    } catch (error) {
      // Without the record of what could not move, keep the keys.
      logger.warn(
        { err: error },
        "desktop config: could not write the unmigrated values"
      )
      for (const leftover of leftovers) {
        migrated.delete(
          leftover.kind === "mcp_servers.env" ? "mcp_servers" : leftover.kind
        )
      }
    }
  }

  const cleared = [...migrated]
  if (cleared.length > 0) {
    try {
      settings.update(
        Object.fromEntries(cleared.map((key) => [key, undefined]))
      )
      report.cleared = cleared
    } catch (error) {
      logger.warn(
        { err: error, keys: cleared },
        "desktop config: moved the settings keys into their files but could not remove them from settings.json; they are merged again at the next start"
      )
    }
  }
  logger.info(
    {
      rules: report.rules,
      mcpServers: report.mcpServers,
      hooks: report.hooks,
      skills: report.skills,
      renamed: report.renamed,
      leftovers: report.leftovers,
      leftoverFile: report.leftoverFile,
      cleared: report.cleared,
    },
    "desktop config: moved the configuration out of settings.json"
  )
  return report
}
