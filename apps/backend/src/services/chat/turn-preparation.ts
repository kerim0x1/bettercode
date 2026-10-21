import fs from "node:fs/promises"
import path from "node:path"
import {
  designDefaultsSchema,
  type DesignBrief,
  type DesignDefaults,
} from "@betterc0de/schema/design"
import { isRecord } from "@betterc0de/schema/json-read"
import {
  RUNTIME_HOOK_LIMITS,
  runtimeHookRecordSchema,
} from "@betterc0de/schema/runtime-records"
import {
  formatBetterC0deProjectPermissionRulesForPrompt,
  mergePromptSkills,
  mergePromptSubagents,
  projectAgentsToPromptSubagents,
  selectPromptSkillsForProvider,
  type PromptMcp,
  type PromptPermissionRule,
  type PromptSubagent,
  type RuntimePromptSkill,
} from "@betterc0de/schema/prompt-context"
import {
  blockingHookFailureMessage,
  buildHookEnv,
  hookFailureText,
  resolveHookCwd,
  type RuntimeHookPayload,
} from "@betterc0de/schema/runtime-hooks"
import {
  buildSystemInstruction,
  type EnvContext,
} from "@betterc0de/schema/system-instruction"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import { isCommandApprovalMarkerValid } from "../../security/commandApproval"
import { recordHookRun } from "../desktop-config/hooks"
import {
  promptMcpsFromServers,
  resolveConfiguredMcpServers,
} from "../desktop-config/mcp"
import { desktopConfigStoreFor, runtimeHomeOf } from "../desktop-config/store"
import { resolveAppEffectiveRules } from "../effective-rules"
import { isScratchWorkspacePath } from "../scratchWorkspace"
import { listProjectAgents } from "../workspace/agents"
import { listProjectPermissions } from "../workspace/permissions"
import { listProjectSkills } from "../workspace/resources"

/**
 * A turn's preparation, for every client: the user's "on message send"
 * hooks (for every message, see dispatch.ts), and, for a turn sent with
 * `prepareTurn` (the desktop, the remote web UI and the phone app all send
 * it), the system instruction, built from the user's skills, MCP servers
 * and subagents, the project's own, and the project's rules. The sources
 * are the desktop configuration in the runtime home (`config.runtimeHome`,
 * services/desktop-config), the backend settings and the project folder;
 * the MCP servers are the one list the turn also attaches
 * (`resolveConfiguredMcpServers`). What only the client knows (the chat
 * and focus modes, the design brief, the rule target) comes with the
 * request. `turn-preparation.parity.test.ts` pins the instruction to the
 * one the desktop built itself before it left this to the backend.
 */

type PreparationState = Pick<AppState, "config" | "settings"> &
  // Decides whether a project may add MCP servers; without it none may.
  Partial<Pick<AppState, "agentPermissions">>

/** The parts of a `/chat/send` request that the preparation reads. */
export interface PreparedTurnRequest {
  thread_id: string
  message: string
  model_id: string
  provider_kind: string
  provider_instance_id?: string | null
  project_path?: string | null
  rule_target_path?: string | null
  chat_mode?: string | null
  /** The composer's focus overlay (security, frontend, …). */
  special_mode?: string | null
  permission_level?: string | null
  app_mode?: "agent" | "editor" | "design" | null
  /** The chat's design brief (Canvas mode), from the client. */
  design_context?: DesignBrief | null
}

export interface RuntimeHookEntry {
  id: string
  event: string
  command: string
  enabled: boolean
  /**
   * Whether the stored approval marker matches this exact command
   * (security/commandApproval.ts). Unapproved commands are never run here.
   */
  approved: boolean
}

/** Most entries read from one settings file or folder. */
const MAX_ENTRIES = 256
/** Approval kind of hook commands (apps/shell/hooks-ipc.cjs). */
const HOOK_APPROVAL_KIND = "hook"
/** Largest settings file read (the desktop's MCP store allows 4 MB). */
const MAX_FILE_BYTES = 4 * 1024 * 1024

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

async function readTextFile(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    return await fs.readFile(file, "utf8")
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/** A settings file's JSON, or `null` when it is missing or not JSON (logged). */
async function readJsonFile(file: string): Promise<unknown> {
  const content = await readTextFile(file)
  if (content === null) return null
  try {
    return JSON.parse(content) as unknown
  } catch (error) {
    logger.warn(
      { file, err: error instanceof Error ? error.message : String(error) },
      "turn preparation: a settings file is not JSON; it is left out"
    )
    return null
  }
}

async function directoryNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .slice(0, MAX_ENTRIES)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

/** The user's skills (`skills/<id>/manifest.json` and `content.md`), enabled ones. */
export async function readRuntimeSkills(
  home: string
): Promise<RuntimePromptSkill[]> {
  const dir = path.join(home, "skills")
  const skills: RuntimePromptSkill[] = []
  for (const name of await directoryNames(dir)) {
    const manifest = await readJsonFile(path.join(dir, name, "manifest.json"))
    if (!isRecord(manifest) || manifest.enabled === false) continue
    skills.push({
      name: text(manifest.name),
      content: (await readTextFile(path.join(dir, name, "content.md"))) ?? "",
      providerKinds: strings(manifest.providerKinds),
      providerInstanceIds: strings(manifest.providerInstanceIds),
      source: text(manifest.source),
      sourcePath: text(manifest.sourcePath),
    })
  }
  return skills
}

/** The user's subagents (`subagents/<id>/manifest.json` and `prompt.md`), enabled ones. */
export async function readRuntimeSubagents(
  home: string
): Promise<PromptSubagent[]> {
  const dir = path.join(home, "subagents")
  const subagents: PromptSubagent[] = []
  for (const name of await directoryNames(dir)) {
    const manifest = await readJsonFile(path.join(dir, name, "manifest.json"))
    if (!isRecord(manifest) || manifest.enabled === false) continue
    subagents.push({
      name: text(manifest.name),
      description: text(manifest.description),
      prompt: (await readTextFile(path.join(dir, name, "prompt.md"))) ?? "",
      source: text(manifest.source),
      sourcePath: text(manifest.sourcePath),
    })
  }
  return subagents
}

/**
 * The user's hooks (`hooks.json`); one without an event runs on message send,
 * as on the desktop. Read strictly, like the desktop does: a missing file is
 * "no hooks", but a file that cannot be read, is not JSON, or is not a list
 * of hooks throws. Reporting "no hooks" instead would let a message pass the
 * user's blocking hooks unchecked.
 */
export async function readRuntimeHooks(
  home: string
): Promise<RuntimeHookEntry[]> {
  const file = path.join(home, "hooks.json")
  let content: string
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error("hooks.json is not a file")
    if (stat.size > RUNTIME_HOOK_LIMITS.maxFileBytes) {
      throw new Error(
        `hooks.json is larger than ${RUNTIME_HOOK_LIMITS.maxFileBytes} bytes`
      )
    }
    content = await fs.readFile(file, "utf8")
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  let stored: unknown
  try {
    stored = JSON.parse(content) as unknown
  } catch {
    throw new Error("hooks.json is not valid JSON")
  }
  if (!Array.isArray(stored) || !stored.every(isRecord)) {
    throw new Error("hooks.json is not a list of hooks")
  }
  if (stored.length > RUNTIME_HOOK_LIMITS.maxHooks) {
    throw new Error(
      `hooks.json lists more than ${RUNTIME_HOOK_LIMITS.maxHooks} hooks`
    )
  }
  return stored.map((entry, index) => {
    // The desktop reads a hook without an event as a message hook and one
    // without `enabled` as switched on; records from older releases have
    // neither. The rest is the shared record (runtime-records.ts).
    const event = text(entry.event) || "on_message_send"
    const record = runtimeHookRecordSchema.safeParse({
      ...entry,
      event,
      enabled: entry.enabled ?? true,
    })
    const command = text(entry.command)
    if (!record.success) {
      // A message hook that does not read as a hook stops every message
      // rather than being skipped. One for another event is never run here.
      if (event === "on_message_send") {
        const issue = record.error.issues[0]
        const where = issue?.path?.length ? ` (${issue.path.join(".")})` : ""
        throw new Error(
          `hooks.json entry ${index + 1} is not a valid hook${where}: ${issue?.message ?? "invalid"}`
        )
      }
      return {
        id: text(entry.id),
        event,
        command,
        enabled: entry.enabled !== false,
        approved: false,
      }
    }
    return {
      id: record.data.id,
      event: record.data.event,
      command: record.data.command,
      enabled: record.data.enabled,
      approved:
        command.trim() !== "" &&
        isCommandApprovalMarkerValid(
          HOOK_APPROVAL_KIND,
          command,
          entry.approval
        ),
    }
  })
}

interface PromptContext {
  skills: RuntimePromptSkill[]
  mcps: PromptMcp[]
  subagents: PromptSubagent[]
  permissionRules: PromptPermissionRule[]
}

/**
 * The user's and the project's skills, MCP servers and subagents, merged as
 * the desktop merges them. Like the desktop, a project whose settings do
 * not load contributes nothing, and settings that do not load at all leave
 * the prompt without them; both are logged here.
 */
async function gatherPromptContext(
  state: PreparationState,
  projectPath: string | null
): Promise<PromptContext> {
  const context: PromptContext = {
    skills: [],
    mcps: [],
    subagents: [],
    permissionRules: [],
  }
  const home = runtimeHomeOf(state.config)
  try {
    if (home) {
      const [skills, subagents] = await Promise.all([
        readRuntimeSkills(home),
        readRuntimeSubagents(home),
      ])
      context.skills = skills
      context.subagents = subagents
    }
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "turn preparation: the desktop's skills and subagents did not load; the turn goes without them"
    )
    return context
  }
  // The MCP servers the turn attaches, resolved once for both: the desktop's
  // `mcp-servers.json`, the user's global config and, in an explicitly
  // trusted project, the project's own servers.
  try {
    context.mcps = promptMcpsFromServers(
      await resolveConfiguredMcpServers(state, projectPath ?? "")
    )
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "turn preparation: the MCP servers did not resolve; the prompt lists none"
    )
  }
  if (!projectPath) return context
  try {
    const [projectSkills, projectAgents, permissions] = await Promise.all([
      listProjectSkills(projectPath),
      listProjectAgents(projectPath),
      listProjectPermissions(projectPath),
    ])
    context.permissionRules = permissions
    context.skills = mergePromptSkills(
      context.skills,
      projectSkills.map((skill) => ({
        name: skill.name,
        content: skill.content,
        source: "betterc0de",
        sourcePath: skill.sourcePath,
      }))
    )
    context.subagents = mergePromptSubagents(
      context.subagents,
      projectAgentsToPromptSubagents(projectAgents)
    )
  } catch (error) {
    logger.warn(
      {
        projectPath,
        err: error instanceof Error ? error.message : String(error),
      },
      "turn preparation: the project's skills and agents did not load; the turn goes without them"
    )
  }
  return context
}

/** The operating system as the desktop names it in the prompt. */
function desktopOsName(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "windows"
  if (platform === "darwin") return "macos"
  return "linux"
}

function envContext(projectPath: string | null): EnvContext {
  return {
    os: desktopOsName(),
    shell: "bash",
    projectPath: projectPath || undefined,
    projectName: projectPath
      ? projectPath.replace(/\\/g, "/").split("/").pop()
      : undefined,
  }
}

/**
 * The user's own rules where the project's rules do not resolve: the
 * backend setting, else the desktop's older `rules.md`, as the desktop read
 * them (apps/ui runtime-config `getCustomRules`).
 */
async function userRuntimeRules(state: PreparationState): Promise<string> {
  const settings = state.settings.get() as unknown as {
    custom_rules?: unknown
  }
  const configured = text(settings.custom_rules)
  if (configured.trim()) return configured
  const home = runtimeHomeOf(state.config)
  if (!home) return configured
  try {
    return (await readTextFile(path.join(home, "rules.md"))) ?? configured
  } catch {
    return configured
  }
}

/** The Canvas mode style and font presets the user keeps (settings `design_defaults`). */
function designDefaults(state: PreparationState): DesignDefaults | null {
  const settings = state.settings.get() as unknown as {
    design_defaults?: unknown
  }
  if (settings.design_defaults === undefined) return null
  const parsed = designDefaultsSchema.safeParse(settings.design_defaults)
  return parsed.success ? parsed.data : null
}

/**
 * Settings → Chat → Visual Replies (`visual_replies`). The settings service
 * parses with the schema, which defaults it to on; only an explicit `true`
 * adds the instruction.
 */
function visualRepliesEnabled(state: PreparationState): boolean {
  const settings = state.settings.get() as unknown as {
    visual_replies?: unknown
  }
  return settings.visual_replies === true
}

/**
 * The system instruction for a prepared turn: the shared builder, the
 * user's and the project's skills, MCP servers and subagents, the project's
 * rules, and the chat's modes and design brief from the request. A chat
 * without a folder runs in its scratch workspace (dispatch.ts) but is told,
 * as the desktop tells it, that no project is open.
 */
export async function buildPreparedTurnInstruction(
  state: PreparationState,
  request: PreparedTurnRequest
): Promise<string> {
  const requestedPath = request.project_path?.trim() || null
  const projectPath =
    requestedPath && isScratchWorkspacePath(state.config.dataDir, requestedPath)
      ? null
      : requestedPath
  const context = await gatherPromptContext(state, projectPath)

  // The project's rules (its rule files and the user's rules) come from the
  // same resolution the desktop asks this backend for. Without a project,
  // or when that fails, the user's rules go in as they are.
  let effectiveRules: string | null = null
  let effectiveRulesLoaded = false
  if (projectPath) {
    try {
      const resolution = await resolveAppEffectiveRules(state, {
        workspaceRoot: projectPath,
        targetPath: request.rule_target_path ?? null,
      })
      effectiveRules = resolution.content || null
      effectiveRulesLoaded = true
    } catch (error) {
      logger.warn(
        {
          projectPath,
          err: error instanceof Error ? error.message : String(error),
        },
        "turn preparation: the project's rules did not resolve"
      )
    }
  }
  const customRules = effectiveRulesLoaded ? "" : await userRuntimeRules(state)
  const projectRules = [
    effectiveRules,
    formatBetterC0deProjectPermissionRulesForPrompt(context.permissionRules),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n")

  return buildSystemInstruction(
    request.chat_mode || "agent",
    request.special_mode ?? null,
    request.permission_level ?? null,
    envContext(projectPath),
    selectPromptSkillsForProvider(context.skills, {
      providerKind: request.provider_kind,
      providerInstanceId: request.provider_instance_id ?? null,
    }),
    context.mcps,
    customRules,
    context.subagents,
    projectRules || null,
    request.app_mode ?? "agent",
    request.design_context ?? null,
    designDefaults(state),
    { visualReplies: visualRepliesEnabled(state) }
  )
}

/**
 * Runs the user's enabled "on message send" hooks, in order, before every
 * message from every client (the desktop no longer runs them itself). The
 * first that fails refuses the message (422 `message_hook_failed`). Each
 * run's outcome is recorded in `hooks.json` (`recordHookRun`, through the
 * backend's config store), where Settings → Hooks shows it.
 *
 * Fails closed: an unreadable `hooks.json`, or an enabled hook whose command
 * the user has not approved on the desktop (no valid approval marker),
 * refuses the message instead of skipping the hook. Nothing unapproved is
 * ever run, and a blocking hook is never silently left out.
 */
export async function runMessageSendHooks(
  state: PreparationState & Pick<AppState, "shellSessions">,
  request: PreparedTurnRequest
): Promise<void> {
  const home = runtimeHomeOf(state.config)
  if (!home) return
  let stored: RuntimeHookEntry[]
  try {
    stored = await readRuntimeHooks(home)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.warn({ err: reason }, "turn preparation: hooks.json is unreadable")
    throw new HttpError(
      422,
      `Your hooks (hooks.json) could not be read: ${reason}. Fix or remove the file on the desktop; messages are not sent until it can be read.`,
      "message_hook_failed"
    )
  }
  const hooks = stored.filter(
    (hook) =>
      hook.enabled &&
      hook.event === "on_message_send" &&
      hook.command.trim() !== ""
  )
  if (hooks.length === 0) return
  const unapproved = hooks.find((hook) => !hook.approved)
  if (unapproved) {
    throw new HttpError(
      422,
      `Hook "${unapproved.command}" is not approved on this computer. Open Settings → Hooks in BetterC0de on the desktop and save it again to approve its command.`,
      "message_hook_failed"
    )
  }
  const payload: RuntimeHookPayload = {
    threadId: request.thread_id,
    message: request.message,
    modelId: request.model_id,
    providerKind: request.provider_kind,
    projectPath: request.project_path ?? undefined,
  }
  const store = desktopConfigStoreFor(state.config)
  for (const hook of hooks) {
    let failure: string | null = null
    let exitCode: number | null = null
    try {
      const result = await state.shellSessions.runCommand({
        command: hook.command,
        cwd: resolveHookCwd(payload),
        env: buildHookEnv("on_message_send", payload),
      })
      exitCode = result.exitCode
      if (!result.success) failure = hookFailureText(result)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (store) {
      recordHookRun(store, hook.id, {
        status: failure === null ? "success" : "error",
        exitCode,
        error: failure,
      })
    }
    if (failure !== null) {
      throw new HttpError(
        422,
        blockingHookFailureMessage(hook.command, failure),
        "message_hook_failed"
      )
    }
  }
}
