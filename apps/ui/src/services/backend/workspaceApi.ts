import type {
  WorkspaceContextArtifactResult as SchemaWorkspaceContextArtifactResult,
  WorkspaceContextSource as SchemaWorkspaceContextSource,
  WorkspaceEffectiveRuleSource as SchemaWorkspaceEffectiveRuleSource,
  WorkspaceEffectiveRulesResult as SchemaWorkspaceEffectiveRulesResult,
} from "@betterc0de/schema"
import type {
  WorkspaceBinaryFile,
  WorkspaceFileContent,
  WorkspaceMapDirectory,
  WorkspaceMapExtension,
  WorkspaceMapFile,
  WorkspaceMapFileKind,
  WorkspaceMapOverview,
  WorkspaceProjectAgent,
  WorkspaceProjectCommand,
  WorkspaceProjectConfigSetting,
  WorkspaceProjectFormatResult,
  WorkspaceProjectFormatRun,
  WorkspaceProjectFormatter,
  WorkspaceProjectInstruction,
  WorkspaceProjectLspServer,
  WorkspaceProjectMcpServer,
  WorkspaceProjectPermissionRule,
  WorkspaceProjectPlugin,
  WorkspaceProjectProvider,
  WorkspaceProjectProviderAuth,
  WorkspaceProjectProviderModel,
  WorkspaceProjectProvidersSummary,
  WorkspaceProjectReference,
  WorkspaceProjectSkill,
  WorkspaceProjectToolFlag,
  WorkspaceQuickOpenFile,
  WorkspaceScratchAdoptResult,
  WorkspaceSearchEntriesResult,
  WorkspaceSearchEntriesTruncationReason,
  WorkspaceSearchEntry,
  ShellCommandResult,
  ShellInfo,
  TerminalPtySnapshot,
} from "@betterc0de/schema/http-contracts"
import {
  isAbsoluteEditorPath,
  normalizeEditorPath,
  workspaceRelativeEditorPath,
} from "@/lib/editor-path"
import { HttpError } from "@/lib/errors"
import type {
  ShellCapabilityLaunch,
  ShellCapabilityScope,
} from "@/types/electron-api"
import { clientInstanceRequestOptions } from "./client-instance"
import { invokeContract } from "./contracts"
import { isRemoteRuntime } from "./runtime"

// The `/workspace/*` calls go through their shared contracts
// (`@betterc0de/schema/http-contracts`): the request is checked before it is
// sent and the response validated before a caller sees it. The read models
// are defined once, in `@betterc0de/schema`, and re-exported here.

export type WorkspaceEffectiveRuleSource = SchemaWorkspaceEffectiveRuleSource
export type WorkspaceEffectiveRulesResult = SchemaWorkspaceEffectiveRulesResult
export type WorkspaceContextSource = SchemaWorkspaceContextSource
export type WorkspaceContextArtifactResult =
  SchemaWorkspaceContextArtifactResult

export type {
  WorkspaceBinaryFile,
  WorkspaceFileContent,
  WorkspaceMapDirectory,
  WorkspaceMapExtension,
  WorkspaceMapFile,
  WorkspaceMapFileKind,
  WorkspaceMapOverview,
  WorkspaceProjectAgent,
  WorkspaceProjectCommand,
  WorkspaceProjectConfigSetting,
  WorkspaceProjectFormatResult,
  WorkspaceProjectFormatRun,
  WorkspaceProjectFormatter,
  WorkspaceProjectInstruction,
  WorkspaceProjectLspServer,
  WorkspaceProjectMcpServer,
  WorkspaceProjectPermissionRule,
  WorkspaceProjectPlugin,
  WorkspaceProjectProvider,
  WorkspaceProjectProviderAuth,
  WorkspaceProjectProviderModel,
  WorkspaceProjectProvidersSummary,
  WorkspaceProjectReference,
  WorkspaceProjectSkill,
  WorkspaceProjectToolFlag,
  WorkspaceQuickOpenFile,
  WorkspaceScratchAdoptResult,
  WorkspaceSearchEntriesResult,
  WorkspaceSearchEntriesTruncationReason,
  WorkspaceSearchEntry,
}

export type { ShellInfo }

/**
 * Probe the backend for available shells. Returns the list the backend
 * detected on this machine — `[]` if the backend isn't ready or the
 * detection failed. Used by the terminal panel to populate its shell
 * picker; no auth/permission flags are required because the route is
 * read-only.
 */
export const detectShells = (): Promise<ShellInfo[]> =>
  invokeContract("shellDetect")

/**
 * The truncation flag wins over a stray reason, so a UI keyed on
 * `truncatedReason` alone can never show a cut that did not happen. Anything
 * that is not a detailed result reads as an empty, complete one.
 */
export function unwrapSearchEntriesResponse(
  raw: unknown
): WorkspaceSearchEntriesResult {
  const detailed = (raw ?? {}) as Partial<WorkspaceSearchEntriesResult>
  return {
    entries: Array.isArray(detailed.entries) ? detailed.entries : [],
    truncated: detailed.truncated === true,
    ...(detailed.truncated === true && detailed.truncatedReason
      ? { truncatedReason: detailed.truncatedReason }
      : {}),
  }
}

export const searchEntriesDetailed = (
  cwd: string,
  query: string
): Promise<WorkspaceSearchEntriesResult> =>
  invokeContract("workspaceSearch", { body: { cwd, query } }).then(
    unwrapSearchEntriesResponse
  )

/**
 * Array form kept for callers that only need the rows. It cannot tell the
 * user a cap cut the list short — prefer {@link searchEntriesDetailed}
 * anywhere the result is shown as a list.
 */
export const searchEntries = (cwd: string, query: string) =>
  searchEntriesDetailed(cwd, query).then((result) => result.entries)

export interface WorkspaceContentSearchMatch {
  line: number
  column: number
  length: number
  previewColumn: number
  previewLength: number
  preview: string
}

export interface WorkspaceContentSearchResult {
  path: string
  name: string
  matches: WorkspaceContentSearchMatch[]
}

export interface WorkspaceContentSearchOptions {
  limit?: number
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  include?: string
  exclude?: string
}

/** Why the backend stopped a content search early (`services/workspace/search`). */
export type WorkspaceContentSearchTruncationReason =
  | "limit"
  | "files"
  | "bytes"
  | "deadline"

export interface WorkspaceContentSearchDetailedResult {
  results: WorkspaceContentSearchResult[]
  /** True when a cap stopped the walk; more matches may exist. */
  truncated: boolean
  truncatedReason?: WorkspaceContentSearchTruncationReason
}

const CONTENT_SEARCH_TRUNCATION_REASONS: ReadonlySet<string> =
  new Set<WorkspaceContentSearchTruncationReason>([
    "limit",
    "files",
    "bytes",
    "deadline",
  ])

/**
 * See {@link unwrapSearchEntriesResponse}. The wire's reason is any string
 * (a newer desktop may add one); this client keeps only the reasons it knows.
 */
export function unwrapContentSearchResponse(
  raw: unknown
): WorkspaceContentSearchDetailedResult {
  const detailed = (raw ?? {}) as Partial<
    Omit<WorkspaceContentSearchDetailedResult, "truncatedReason">
  > & { truncatedReason?: unknown }
  const reason = detailed.truncatedReason
  return {
    results: Array.isArray(detailed.results) ? detailed.results : [],
    truncated: detailed.truncated === true,
    ...(detailed.truncated === true &&
    typeof reason === "string" &&
    CONTENT_SEARCH_TRUNCATION_REASONS.has(reason)
      ? { truncatedReason: reason as WorkspaceContentSearchTruncationReason }
      : {}),
  }
}

export const searchContentDetailed = (
  cwd: string,
  query: string,
  limitOrOptions: number | WorkspaceContentSearchOptions = 200
): Promise<WorkspaceContentSearchDetailedResult> => {
  const options =
    typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : limitOrOptions
  return invokeContract("workspaceSearchContent", {
    body: { cwd, query, ...options },
  }).then(unwrapContentSearchResponse)
}

/**
 * Array form kept for callers that only need the rows. It cannot tell the
 * user a cap cut the search short — prefer {@link searchContentDetailed}
 * anywhere the result is shown as a list.
 */
export const searchContent = (
  cwd: string,
  query: string,
  limitOrOptions: number | WorkspaceContentSearchOptions = 200
) =>
  searchContentDetailed(cwd, query, limitOrOptions).then(
    (result) => result.results
  )

export interface WorkspaceQuickOpenOptions {
  limit?: number
  include?: string
}

export const quickOpenFiles = (
  cwd: string,
  query: string,
  limitOrOptions: number | WorkspaceQuickOpenOptions = 80
): Promise<WorkspaceQuickOpenFile[]> => {
  const options =
    typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : limitOrOptions
  return invokeContract("workspaceQuickOpen", {
    body: { cwd, query, ...options },
  })
}

export const getWorkspaceMap = (
  cwd: string,
  maxFiles = 5000
): Promise<WorkspaceMapOverview> =>
  invokeContract("workspaceMap", { body: { cwd, maxFiles } })

export const listProjectCommands = (
  cwd: string
): Promise<WorkspaceProjectCommand[]> =>
  invokeContract("workspaceProjectCommands", { body: { cwd } })

export const listProjectAgents = (
  cwd: string
): Promise<WorkspaceProjectAgent[]> =>
  invokeContract("workspaceProjectAgents", { body: { cwd } })

export const listProjectSkills = (
  cwd: string
): Promise<WorkspaceProjectSkill[]> =>
  invokeContract("workspaceProjectSkills", { body: { cwd } })

export const listProjectMcpServers = (
  cwd: string
): Promise<WorkspaceProjectMcpServer[]> =>
  invokeContract("workspaceProjectMcpServers", { body: { cwd } })

export const listProjectInstructions = (
  cwd: string
): Promise<WorkspaceProjectInstruction[]> =>
  invokeContract("workspaceProjectInstructions", { body: { cwd } })

export const getEffectiveRules = (
  cwd: string,
  targetPath = "."
): Promise<WorkspaceEffectiveRulesResult> =>
  invokeContract("workspaceEffectiveRules", { body: { cwd, targetPath } })

export const getContextArtifact = (
  cwd: string,
  targetPath = ".",
  threadId?: string,
  pending?: {
    messageCharacters?: number
    attachments?: Array<{
      id: string
      name: string
      mediaType: string | null
      sizeBytes: number | null
    }>
  }
): Promise<WorkspaceContextArtifactResult> => {
  const normalizedThreadId = threadId?.trim()
  const pendingMessageCharacters = Math.max(
    0,
    Math.floor(pending?.messageCharacters ?? 0)
  )
  const pendingAttachments = pending?.attachments ?? []
  const request = {
    cwd,
    targetPath,
    ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
    ...(pendingMessageCharacters > 0 ? { pendingMessageCharacters } : {}),
    ...(pendingAttachments.length > 0 ? { pendingAttachments } : {}),
  }
  return invokeContract("workspaceContextArtifact", { body: request })
}

export const listProjectReferences = (
  cwd: string
): Promise<WorkspaceProjectReference[]> =>
  invokeContract("workspaceProjectReferences", { body: { cwd } })

export const listProjectFormatters = (
  cwd: string
): Promise<WorkspaceProjectFormatter[]> =>
  invokeContract("workspaceProjectFormatters", { body: { cwd } })

export const formatProjectFile = (
  cwd: string,
  relativePath: string,
  formatterId?: string
): Promise<WorkspaceProjectFormatResult> =>
  invokeContract("workspaceProjectFormat", {
    body: { cwd, relativePath, formatterId },
  })

export const listProjectLspServers = (
  cwd: string
): Promise<WorkspaceProjectLspServer[]> =>
  invokeContract("workspaceProjectLspServers", { body: { cwd } })

export const listProjectPermissions = (
  cwd: string
): Promise<WorkspaceProjectPermissionRule[]> =>
  invokeContract("workspaceProjectPermissions", { body: { cwd } })

export const listProjectConfigSettings = (
  cwd: string
): Promise<WorkspaceProjectConfigSetting[]> =>
  invokeContract("workspaceProjectConfig", { body: { cwd } })

export const listProjectProviders = (
  cwd: string
): Promise<WorkspaceProjectProvidersSummary> =>
  invokeContract("workspaceProjectProviders", { body: { cwd } })

export const listProjectPlugins = (
  cwd: string
): Promise<WorkspaceProjectPlugin[]> =>
  invokeContract("workspaceProjectPlugins", { body: { cwd } })

export const listProjectTools = (
  cwd: string
): Promise<WorkspaceProjectToolFlag[]> =>
  invokeContract("workspaceProjectTools", { body: { cwd } })

/**
 * Resolve `{cwd, relativePath}` for `/workspace/read` from a single-string
 * path.
 *
 * - A path inside the active workspace keeps that registered root and sends
 *   the remainder as `relativePath`. This is required by the backend's
 *   workspace trust boundary, including for deeply nested files.
 * - A relative path is resolved against the active worktree/project.
 * - Without an active workspace, an absolute path is split at its last
 *   separator and bare filenames keep the legacy `"."` fallback.
 */
export function splitReadPathForWorkspace(
  path: string,
  workspacePath?: string | null
): { cwd: string; relativePath: string } | null {
  const workspace = workspacePath?.trim()
  if (workspace) {
    const relative = workspaceRelativeEditorPath(workspace, path)
    if (relative) return { cwd: workspace, relativePath: relative }

    if (!isAbsoluteEditorPath(path)) {
      const normalizedRelative = normalizeEditorPath(path).replace(/^\/+/, "")
      if (normalizedRelative) {
        return { cwd: workspace, relativePath: normalizedRelative }
      }
    }
  }

  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  if (lastSlash > 0) {
    return {
      cwd: path.slice(0, lastSlash),
      relativePath: path.slice(lastSlash + 1),
    }
  }
  return null
}

/**
 * Splits `path` against the first root that actually contains it. The backend
 * only accepts a `cwd` that is a registered project/worktree root (403
 * otherwise), so for an absolute path the file's parent directory is never a
 * valid guess — but any known thread root that contains the path is. Pure so
 * the multi-root behavior is testable without the store.
 */
export function splitReadPathForKnownRoots(
  path: string,
  roots: ReadonlyArray<string | null | undefined>
): { cwd: string; relativePath: string } | null {
  for (const root of roots) {
    const workspace = root?.trim()
    if (!workspace) continue
    const relative = workspaceRelativeEditorPath(workspace, path)
    if (relative) return { cwd: workspace, relativePath: relative }
  }
  return null
}

/** Workspace roots the renderer knows, used to resolve a single-string read path. */
export interface WorkspaceReadRoots {
  /** The active thread's worktree or project root. */
  readonly active: string | null
  /** Every thread root, active first. Each is a backend-approved root. */
  readonly known: readonly string[]
}

/** Collects read roots from chat state. Pure so it is testable without the store. */
export function workspaceReadRootsFromThreads(state: {
  readonly activeThreadId: string | null
  readonly threads: ReadonlyArray<{
    readonly id: string
    readonly worktreePath?: string | null
    readonly projectPath?: string | null
  }>
}): WorkspaceReadRoots {
  const active = state.threads.find((t) => t.id === state.activeThreadId)
  const activeRoot =
    active?.worktreePath?.trim() || active?.projectPath?.trim() || null
  // The pane grid can show a file from a project other than the active
  // thread's (file tree in another pane, file-editor modal). Every thread
  // root the renderer knows is a backend-approved root, so collect them
  // all as containment candidates — active thread first.
  const known: string[] = activeRoot ? [activeRoot] : []
  for (const thread of state.threads) {
    for (const root of [thread.worktreePath, thread.projectPath]) {
      const value = typeof root === "string" ? root.trim() : ""
      if (value && !known.includes(value)) known.push(value)
    }
  }
  return { active: activeRoot, known }
}

/**
 * Reads the roots from the chat store. The store is imported on demand, not
 * statically: it depends on this module (through editor-store), so a static
 * import would form a load-time cycle. A dynamic `import()` is resolved by the
 * bundler and returns the already-loaded module; the `require()` used before
 * does not exist in the sandboxed ESM renderer and always threw, which left
 * every read without its workspace root.
 */
async function currentWorkspaceReadRoots(): Promise<WorkspaceReadRoots> {
  try {
    const { useChatStore } = await import("@/lib/chat-store")
    return workspaceReadRootsFromThreads(useChatStore.getState())
  } catch (error) {
    console.warn("[workspace] could not read workspace roots:", error)
    return { active: null, known: [] }
  }
}

/** Resolves `{cwd, relativePath}` for `/workspace/read` against known roots. */
export function splitReadPathForRoots(
  path: string,
  roots: WorkspaceReadRoots
): { cwd: string; relativePath: string } {
  return (
    splitReadPathForKnownRoots(path, roots.known) ??
    splitReadPathForWorkspace(path, roots.active) ?? {
      cwd: roots.active || ".",
      relativePath: normalizeEditorPath(path).replace(/^\/+/, ""),
    }
  )
}

async function splitReadPath(
  path: string
): Promise<{ cwd: string; relativePath: string }> {
  return splitReadPathForRoots(path, await currentWorkspaceReadRoots())
}

/**
 * @param path Single-string path; resolved via {@link splitReadPath}.
 * @param opts.silent404 When true, suppresses the transport's auto-`console.error`
 *   on 404 responses. Used by soft-probe callers (e.g. @-mention file
 *   resolution, project-rules detection) where a missing file is expected
 *   and would otherwise spam DevTools. The Promise still rejects with an
 *   {@link HttpError}, so caller try/catch logic is unchanged.
 */
export const readFile = async (
  path: string,
  opts?: { silent404?: boolean }
): Promise<WorkspaceFileContent> =>
  invokeContract("workspaceRead", {
    body: await splitReadPath(path),
    silentStatuses: opts?.silent404 ? [404] : undefined,
  })

export const readBinaryFile = async (
  path: string
): Promise<WorkspaceBinaryFile> =>
  invokeContract("workspaceReadBinary", {
    body: await splitReadPath(path),
    // During renderer HMR an older development sidecar can briefly lack this
    // route. The preview surfaces a useful restart message without flooding
    // DevTools with duplicate React StrictMode errors.
    silentStatuses: [404],
  })

function normalizedWorkspacePath(cwd: string, relativePath: string): string {
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "")
  const normalizedRelative = relativePath.replace(/\\/g, "/").replace(/^\//, "")
  return normalizedRelative
    ? `${normalizedCwd}/${normalizedRelative}`
    : normalizedCwd
}

function dispatchWorkspaceFileChanged(
  cwd: string,
  relativePath: string,
  extra?: Record<string, unknown>
): void {
  window.dispatchEvent(
    new CustomEvent("betterc0de:file-changed", {
      detail: {
        cwd,
        relativePath,
        path: normalizedWorkspacePath(cwd, relativePath),
        ...extra,
      },
    })
  )
}

/**
 * Writes a file. With `expectedSha256` (from a read) the backend refuses
 * (409) when the file changed since; with `null`, when it exists at all.
 */
export const writeFile = (
  cwd: string,
  relativePath: string,
  contents: string,
  options: { expectedSha256?: string | null } = {}
): Promise<void> => {
  const body = {
    cwd,
    relativePath,
    contents,
    ...(options.expectedSha256 === undefined
      ? {}
      : { expectedSha256: options.expectedSha256 }),
  }
  return invokeContract("workspaceWrite", { body }).then(() => {
    dispatchWorkspaceFileChanged(cwd, relativePath)
  })
}

export const createDirectory = (
  cwd: string,
  relativePath: string
): Promise<void> =>
  invokeContract("workspaceMkdir", { body: { cwd, relativePath } }).then(() => {
    dispatchWorkspaceFileChanged(cwd, relativePath)
  })

/**
 * Copies a project-less chat's scratch workspace into the repository it is
 * being forked into. Files already present in the destination are reported as
 * `skipped` rather than overwritten.
 */
export const adoptScratchWorkspace = (
  threadId: string,
  destination: string
): Promise<WorkspaceScratchAdoptResult> =>
  invokeContract("workspaceScratchAdopt", {
    body: { threadId, destination },
  })

export const moveWorkspacePath = (
  cwd: string,
  fromRelativePath: string,
  toRelativePath: string
): Promise<void> =>
  invokeContract("workspaceMove", {
    body: { cwd, fromRelativePath, toRelativePath },
  }).then(() => {
    dispatchWorkspaceFileChanged(cwd, toRelativePath, {
      previousRelativePath: fromRelativePath,
      previousPath: normalizedWorkspacePath(cwd, fromRelativePath),
    })
  })

export const deleteWorkspacePath = (
  cwd: string,
  relativePath: string,
  recursive = false
): Promise<void> =>
  invokeContract("workspaceDelete", {
    body: { cwd, relativePath, recursive },
  }).then(() => {
    dispatchWorkspaceFileChanged(cwd, relativePath, { deleted: true })
  })

type HumanShellCapabilityScope = ShellCapabilityScope

/**
 * The launch a capability is bound to: exactly the shell, PTY arguments and
 * environment the request that spends it sends (the backend refuses the
 * capability for any other). Absent fields stay absent ("the default").
 */
function shellCapabilityLaunch(input: {
  shell?: string
  args?: string[]
  env?: Record<string, string>
}): ShellCapabilityLaunch {
  return {
    ...(input.shell !== undefined ? { shell: input.shell } : {}),
    ...(input.args !== undefined ? { args: input.args } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  }
}

const REMOTE_TERMINAL_HINT =
  'Enable "Allow terminal from remote devices" in Remote Access settings on the desktop app.'

/** The backend's nominal code for "the desktop owner has not granted this
 *  device a terminal" (`http/remoteTerminalPolicy.ts`). */
const REMOTE_TERMINAL_DISABLED_CODE = "remote_terminal_disabled"
/** The message the backend sends with that code when the *switch* is off —
 *  the only refusal the settings hint is the right answer to. Matched only
 *  when no code reached us (an older backend). */
const REMOTE_TERMINAL_SWITCH_OFF_MESSAGE =
  /terminal access from paired devices is disabled on the desktop host/i
/** The same code also covers a read-only or plaintext-downgraded session;
 *  no settings switch fixes that, so the backend's own message stands. */
const REMOTE_SESSION_READ_ONLY_MESSAGE = /session is read-only/i

/**
 * Whether a refused `/shell/capability` call means the desktop owner's
 * "Allow terminal from remote devices" switch is off. Every other 403
 * (unregistered cwd, read-only session, desktop-only) keeps its own message.
 */
export function isRemoteTerminalSwitchOffError(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.status !== 403) return false
  if (REMOTE_SESSION_READ_ONLY_MESSAGE.test(error.message)) return false
  if (error.code !== undefined) {
    return error.code === REMOTE_TERMINAL_DISABLED_CODE
  }
  return REMOTE_TERMINAL_SWITCH_OFF_MESSAGE.test(error.message)
}

/**
 * A 403 from `/shell/capability` in remote mode is the desktop host
 * refusing this device a terminal. When the reason is the owner's switch,
 * tell the user where it lives instead of surfacing the bare refusal.
 */
export function remoteShellCapabilityError(error: unknown): Error {
  if (isRemoteTerminalSwitchOffError(error)) {
    return new Error(
      `${(error as HttpError).message.trim()} ${REMOTE_TERMINAL_HINT}`.trim()
    )
  }
  return error instanceof Error ? error : new Error(String(error))
}

const requestHumanShellCapability = async (
  scope: HumanShellCapabilityScope
): Promise<string> => {
  const request = window.electronAPI?.requestShellCapability
  if (request) return request(scope)
  if (!isRemoteRuntime()) {
    throw new Error(
      "Shell capabilities require the trusted desktop bridge or a paired remote session."
    )
  }
  // Always ask: whether a paired device may open a terminal is the desktop
  // host's decision (`remote_access_allow_terminal`), not something the
  // renderer can know up front.
  try {
    const result = await invokeContract("shellCapability", { body: scope })
    return result.capability
  } catch (error) {
    throw remoteShellCapabilityError(error)
  }
}

export const terminalOpen = async (input: {
  sessionId?: string
  cwd: string
  shell?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
}): Promise<TerminalPtySnapshot> => {
  const humanCapability = await requestHumanShellCapability({
    operation: "pty-open",
    cwd: input.cwd,
    sessionId: input.sessionId,
    command: input.command,
    launch: shellCapabilityLaunch(input),
  })
  return invokeContract("terminalOpen", {
    body: {
      ...input,
      humanOrigin: true,
      permissionLevel: "bypass",
      humanCapability,
    },
    // The desktop shell ends this terminal when the page goes away.
    ...clientInstanceRequestOptions(),
  })
}

export const terminalRead = (
  sessionId: string,
  cursor = 0
): Promise<TerminalPtySnapshot> =>
  invokeContract("terminalRead", {
    body: { sessionId, cursor },
    timeoutMs: 15_000,
    silentStatuses: [404],
  })

export const terminalWrite = async (
  sessionId: string,
  data: string
): Promise<{ ok: boolean }> => {
  const humanCapability = await requestHumanShellCapability({
    operation: "pty-write",
    sessionId,
    data,
  })
  return invokeContract("terminalWrite", {
    body: {
      sessionId,
      data,
      humanOrigin: true,
      permissionLevel: "bypass",
      humanCapability,
    },
    // The terminal ended between two keystrokes: the caller shows that.
    silentStatuses: [404],
  })
}

/** Tells the shell the terminal's new size; a 404 means it has ended. */
export const terminalResize = (
  sessionId: string,
  cols: number,
  rows: number
): Promise<{ ok: boolean }> =>
  invokeContract("terminalResize", {
    body: { sessionId, cols, rows },
    silentStatuses: [404],
  })

export const terminalClose = (sessionId: string): Promise<{ ok: boolean }> =>
  invokeContract("terminalClose", {
    body: { sessionId },
    silentStatuses: [404],
  })

export const runShellCommandDetailed = async (
  command: string,
  cwd: string,
  shell?: string,
  env?: Record<string, string>,
  opts?: { humanOrigin?: boolean; permissionLevel?: string }
): Promise<ShellCommandResult> => {
  // Read-only git/gh queries and similar commands (classified as `read` by
  // the backend) pass the permission gate without extra flags. For anything
  // that may classify as `execute`, the caller must mark it human-origin
  // with `permissionLevel:"bypass"` (e.g. user-typed terminal, user-
  // configured hooks that the user explicitly opted into).
  const humanOrigin = opts?.humanOrigin ?? false
  const permissionLevel =
    opts?.permissionLevel ?? (humanOrigin ? "bypass" : undefined)
  const humanCapability = humanOrigin
    ? await requestHumanShellCapability({
        operation: "run",
        command,
        cwd,
        launch: shellCapabilityLaunch({ shell, env }),
      })
    : undefined
  return invokeContract("shellRun", {
    body: {
      command,
      cwd,
      shell,
      env,
      humanOrigin,
      permissionLevel,
      humanCapability,
    },
    ...clientInstanceRequestOptions(),
  })
}

export const runShellCommand = async (
  command: string,
  cwd: string,
  shell?: string,
  env?: Record<string, string>
) => {
  const result = await runShellCommandDetailed(command, cwd, shell, env)
  return result.combined
}
