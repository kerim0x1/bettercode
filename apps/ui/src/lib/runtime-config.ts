import type { WorkspaceProjectMcpServer } from "@betterc0de/schema/http-contracts"
import type {
  RuntimeHookView,
  RuntimeMcpServerRecord,
} from "@betterc0de/schema/runtime-records"
import { ipcApi, getElectronApi } from "@/services/ipc-facade"
import { dispatchProviderMetadataChanged } from "@/lib/provider-metadata-events"
import { HttpError } from "@/lib/errors"

/**
 * What the desktop process sends instead of a saved MCP env or header value
 * (`apps/shell/mcp-ipc.cjs`). Sending it back unchanged keeps the saved value.
 */
export const RUNTIME_MCP_SECRET_PLACEHOLDER = "••••••••"

/**
 * An MCP server as the settings list it: an entry of the desktop's
 * `mcp-servers.json` (`RuntimeMcpServerRecord`, as `mcp:list` sends it: no
 * approval marker, secret values replaced, `envKeys`/`headerKeys` naming
 * them) with its defaults filled in, or a server a project configuration
 * declares (the `sourcePath`, `oauth` and `auth*` fields of
 * `WorkspaceProjectMcpServer`).
 */
export type RuntimeMcpServer = Required<
  Pick<
    RuntimeMcpServerRecord,
    "id" | "name" | "command" | "args" | "env" | "enabled"
  >
> &
  Pick<
    RuntimeMcpServerRecord,
    "headers" | "headerEnv" | "installedAt" | "type" | "url" | "authenticated"
  > &
  Partial<
    Pick<
      WorkspaceProjectMcpServer,
      | "envKeys"
      | "headerKeys"
      | "sourcePath"
      | "timeoutMs"
      | "oauth"
      | "oauthKeys"
      | "authStatus"
      | "authStorageKeys"
      | "authSourcePath"
      | "authServerUrl"
    >
  > & {
    /**
     * The CLI an imported server came from (`claude`, `codex`); absent for
     * one added in BetterC0de and for imports from before it was kept.
     */
    source?: string
  }

export interface RuntimeSkill {
  id: string
  name: string
  version: string
  public: boolean
  enabled: boolean
  description?: string
  content: string
  createdAt?: string
  updatedAt?: string
  source?: string
  sourceUrl?: string
  sourcePath?: string
  providerKinds?: string[]
  providerInstanceIds?: string[]
}

/**
 * A hook as `hook:list` sends it: the `hooks.json` record without its
 * approval marker. `approved` says whether the desktop process holds a valid
 * approval for this exact command; an unapproved hook does not run on its
 * own, and saving it again asks for approval. Absent from an older desktop
 * process.
 */
export type RuntimeHook = RuntimeHookView

export interface RuntimeSubagent {
  id: string
  name: string
  description: string
  prompt: string
  enabled: boolean
  hidden?: boolean
  mode?: string
  model?: string
  variant?: string
  temperature?: number
  topP?: number
  color?: string
  steps?: number
  tools?: Record<string, boolean>
  optionKeys?: string[]
  permissions?: Array<{
    permission: string
    pattern: string
    action: "ask" | "allow" | "deny"
    sourcePath: string
  }>
  createdAt?: string
  updatedAt?: string
  source?: string
  sourcePath?: string
}

function normalizeNativeSkillProviderKind(
  value: string | null | undefined
): string | null {
  const key = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
  if (["codex", "codex-cli", "openai-cli"].includes(key)) return "codex"
  if (["claude", "claude-cli", "anthropic-cli"].includes(key)) return "claude"
  return null
}

function notifyNativeSkillMetadataChanged(
  skill: Pick<RuntimeSkill, "providerKinds" | "providerInstanceIds">
): void {
  const instanceIds = Array.from(
    new Set(
      (skill.providerInstanceIds ?? [])
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  )
  for (const providerInstanceId of instanceIds) {
    dispatchProviderMetadataChanged({
      providerInstanceId,
      metadataKind: "skills",
    })
  }

  const providerKinds = Array.from(
    new Set(
      (skill.providerKinds ?? [])
        .map(normalizeNativeSkillProviderKind)
        .filter((entry): entry is string => Boolean(entry))
    )
  )
  for (const providerKind of providerKinds) {
    dispatchProviderMetadataChanged({
      providerKind,
      metadataKind: "skills",
    })
  }
}

function api() {
  return getElectronApi()
}

function ensureString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function ensureRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, raw]) => [
      key,
      typeof raw === "string" ? raw : String(raw ?? ""),
    ])
  )
}

function extractDescriptionFromMarkdown(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#") && !line.startsWith(">"))
  return lines[0] || ""
}

/** The user's rules as this window can show them. */
export interface CustomRules {
  /** The text of `rules.md`; empty when there is none or it cannot be shown. */
  content: string
  /**
   * Why the rules cannot be shown here: a paired browser on a read-only
   * (plain HTTP) session is not given them, or they could not be read.
   * `null` when `content` is the rules.
   */
  unavailable: "read-only-session" | "unreadable" | null
}

/**
 * The user's own rules: `rules.md` in BetterC0de's settings folder, which
 * the backend owns. The desktop app reads them through its own process
 * (`rules:get`) and can edit them; a paired browser reads them from the
 * backend (`GET /settings/rules`), only to show them, and only on a full
 * session. There is no second copy in settings any more; the backend moved
 * the old `custom_rules` setting into `rules.md`.
 */
export async function readCustomRules(): Promise<CustomRules> {
  const desktop = api()
  try {
    if (desktop?.rulesGet) {
      return {
        content: ensureString((await desktop.rulesGet())?.content),
        unavailable: null,
      }
    }
    const { getUserRules } = await import("@/services/backend/coreApi")
    return { content: (await getUserRules()).content, unavailable: null }
  } catch (error) {
    return {
      content: "",
      unavailable:
        error instanceof HttpError && error.code === "remote_read_only"
          ? "read-only-session"
          : "unreadable",
    }
  }
}

/** The text of the user's rules, or `""` when there are none to show. */
export async function getCustomRules(): Promise<string> {
  return (await readCustomRules()).content
}

/** What Settings → Rules says above the rules, by how this window reads them. */
export function customRulesDescription(
  editable: boolean,
  unavailable: CustomRules["unavailable"]
): string {
  if (editable) {
    return "Define global instructions, saved as rules.md in BetterC0de's settings folder. They merge before project, directory, and target rules on each turn."
  }
  if (unavailable === "read-only-session") {
    return "This browser is paired read-only, so your global instructions are not shown here. View and edit them in the BetterC0de desktop app."
  }
  if (unavailable === "unreadable") {
    return "Your global instructions could not be loaded. View and edit them in the BetterC0de desktop app."
  }
  return "Your global instructions, read-only. Edit them in the BetterC0de desktop app."
}

/** Save the user's rules (`rules.md`); only the desktop app can. */
export async function saveCustomRules(content: string): Promise<void> {
  if (!api()?.rulesSave) {
    throw new Error("Rules are edited in the BetterC0de desktop app.")
  }
  await ipcApi.rules.save(content)
}

/** Whether this window can edit the user's rules (the desktop app). */
export function canEditCustomRules(): boolean {
  return Boolean(api()?.rulesSave)
}

/**
 * The user's hooks. By default an unreadable hook list reads as empty (the
 * settings list). Pass `throwOnError` where hooks gate an action: the desktop
 * process rejects `hook:list` when hooks.json cannot be read, and treating
 * that as "no hooks" would skip blocking hooks silently.
 */
export async function listRuntimeHooks(
  options: { throwOnError?: boolean } = {}
): Promise<RuntimeHook[]> {
  try {
    const hooks = (await api()?.hookList?.()) || []
    return Array.isArray(hooks)
      ? (hooks as Record<string, unknown>[]).map((hook) => ({
          id: ensureString(hook.id),
          event: (hook.event as RuntimeHook["event"]) || "on_message_send",
          command: ensureString(hook.command),
          enabled: hook.enabled !== false,
          createdAt: ensureString(hook.createdAt),
          updatedAt: ensureString(hook.updatedAt),
          lastRunAt: typeof hook.lastRunAt === "string" ? hook.lastRunAt : null,
          lastStatus:
            hook.lastStatus === "running" ||
            hook.lastStatus === "success" ||
            hook.lastStatus === "error"
              ? hook.lastStatus
              : "idle",
          lastExitCode:
            typeof hook.lastExitCode === "number" ? hook.lastExitCode : null,
          lastError: typeof hook.lastError === "string" ? hook.lastError : null,
          ...(typeof hook.approved === "boolean"
            ? { approved: hook.approved }
            : {}),
        }))
      : []
  } catch (error) {
    if (options.throwOnError) throw error
    return []
  }
}

export async function saveRuntimeHook(
  hook: Partial<RuntimeHook>
): Promise<string> {
  const { id } = await ipcApi.hook.save(hook)
  return id
}

export async function deleteRuntimeHook(id: string): Promise<void> {
  await ipcApi.hook.delete(id)
}

export async function updateRuntimeHookRun(
  id: string,
  status: RuntimeHook["lastStatus"],
  exitCode?: number | null,
  error?: string | null
): Promise<void> {
  // updateRun's envelope is `{ok:true}` only — no payload — so no return
  // value to surface. Swallows errors for consistency with the prior
  // fire-and-forget behaviour; the run-status update is best-effort.
  try {
    await ipcApi.hook.updateRun(
      id,
      status ?? "idle",
      exitCode ?? null,
      error ?? null
    )
  } catch {
    /* intentional: run-status is telemetry, not correctness-critical */
  }
}

export async function listRuntimeMcps(): Promise<RuntimeMcpServer[]> {
  try {
    const mcps = (await api()?.mcpList?.()) || []
    return Array.isArray(mcps)
      ? (mcps as Record<string, unknown>[]).map((item) => ({
          id: ensureString(item.id),
          name: ensureString(item.name),
          command: ensureString(item.command),
          args: Array.isArray(item.args)
            ? item.args.filter(
                (value): value is string => typeof value === "string"
              )
            : [],
          env: ensureRecord(item.env),
          headers: ensureRecord(item.headers),
          headerEnv: ensureRecord(item.headerEnv),
          enabled: item.enabled !== false,
          installedAt: ensureString(item.installedAt),
          type: ensureString(item.type),
          url: typeof item.url === "string" ? item.url : null,
          authenticated: !!item.authenticated,
          ...(typeof item.source === "string" && item.source
            ? { source: item.source }
            : {}),
        }))
      : []
  } catch {
    return []
  }
}

/**
 * Whether this window manages skills, subagents and MCP servers: only the
 * desktop app can. A paired browser has no desktop bridge, and the lists
 * below read as empty there, which is not the same as "none configured".
 */
export function canManageRuntimeConfig(): boolean {
  return api() !== undefined
}

export async function saveRuntimeMcp(
  server: Partial<RuntimeMcpServer>
): Promise<string> {
  const { id } = await ipcApi.mcp.install(server)
  return id
}

export async function deleteRuntimeMcp(id: string): Promise<void> {
  await ipcApi.mcp.remove(id)
}

export async function setRuntimeMcpEnabled(
  id: string,
  enabled: boolean
): Promise<void> {
  await ipcApi.mcp.setEnabled(id, enabled)
}

export async function probeRuntimeMcp(
  server: Partial<RuntimeMcpServer>
): Promise<{
  ok: boolean
  error?: string
  stdout?: string
  stderr?: string
  note?: string
}> {
  // Probe's envelope is non-standard (carries stdout/stderr on both
  // success and failure). ipcApi.mcp.probe preserves the raw shape but
  // throws on the `{ok:false}` error path; here we swallow to keep the
  // prior contract where callers pattern-match on the result envelope.
  try {
    const result = (await ipcApi.mcp.probe(server)) as
      | {
          ok: boolean
          error?: string
          stdout?: string
          stderr?: string
          note?: string
        }
      | null
      | undefined
    return result || { ok: false, error: "Probe unavailable" }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Probe unavailable",
    }
  }
}

export async function listRuntimeSkills(): Promise<RuntimeSkill[]> {
  try {
    const skills = (await api()?.skillList?.()) || []
    return Array.isArray(skills)
      ? (skills as Record<string, unknown>[]).map((skill) => {
          const content = ensureString(skill.content)
          return {
            id: ensureString(skill.id),
            name: ensureString(skill.name),
            version: ensureString(skill.version, "1.0.0"),
            public: !!skill.public,
            enabled: skill.enabled !== false,
            description:
              ensureString(skill.description) ||
              extractDescriptionFromMarkdown(content),
            content,
            createdAt: ensureString(skill.createdAt),
            updatedAt: ensureString(skill.updatedAt),
            source: ensureString(skill.source),
            sourceUrl: ensureString(skill.sourceUrl),
            sourcePath: ensureString(skill.sourcePath),
            providerKinds: Array.isArray(skill.providerKinds)
              ? skill.providerKinds.filter(
                  (entry): entry is string => typeof entry === "string"
                )
              : [],
            providerInstanceIds: Array.isArray(skill.providerInstanceIds)
              ? skill.providerInstanceIds.filter(
                  (entry): entry is string => typeof entry === "string"
                )
              : [],
          }
        })
      : []
  } catch {
    return []
  }
}

export async function saveRuntimeSkill(skill: {
  id?: string
  name: string
  version?: string
  isPublic?: boolean
  public?: boolean
  enabled?: boolean
  description?: string
  content: string
  source?: string
  sourceUrl?: string
  sourcePath?: string
  providerKinds?: string[]
  providerInstanceIds?: string[]
}): Promise<string> {
  const { id } = await ipcApi.skill.save(skill)
  notifyNativeSkillMetadataChanged(skill)
  return id
}

export async function deleteRuntimeSkill(id: string): Promise<void> {
  const existing = (await listRuntimeSkills()).find((skill) => skill.id === id)
  await ipcApi.skill.delete(id)
  if (existing) notifyNativeSkillMetadataChanged(existing)
}

export async function listRuntimeSubagents(): Promise<RuntimeSubagent[]> {
  try {
    const agents = (await api()?.subagentList?.()) || []
    return Array.isArray(agents)
      ? (agents as Record<string, unknown>[]).map((agent) => ({
          id: ensureString(agent.id),
          name: ensureString(agent.name),
          description: ensureString(agent.description),
          prompt: ensureString(agent.prompt),
          enabled: agent.enabled !== false,
          createdAt: ensureString(agent.createdAt),
          updatedAt: ensureString(agent.updatedAt),
          source: ensureString(agent.source),
          sourcePath: ensureString(agent.sourcePath),
        }))
      : []
  } catch {
    return []
  }
}

export async function saveRuntimeSubagent(agent: {
  id?: string
  name: string
  description?: string
  prompt: string
  enabled?: boolean
  source?: string
  sourcePath?: string
}): Promise<string> {
  const { id } = await ipcApi.subagent.save(agent)
  return id
}

export async function deleteRuntimeSubagent(id: string): Promise<void> {
  await ipcApi.subagent.delete(id)
}
