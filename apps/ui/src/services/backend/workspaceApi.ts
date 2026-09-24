import type { ShellCommandResult, TerminalPtySnapshot } from "./types"
import type {
  WorkspaceContextArtifactResult as SchemaWorkspaceContextArtifactResult,
  WorkspaceContextSource as SchemaWorkspaceContextSource,
  WorkspaceEffectiveRuleSource as SchemaWorkspaceEffectiveRuleSource,
  WorkspaceEffectiveRulesResult as SchemaWorkspaceEffectiveRulesResult,
} from "@betterc0de/schema"
import {
  isAbsoluteEditorPath,
  normalizeEditorPath,
  workspaceRelativeEditorPath,
} from "@/lib/editor-path"
import { HttpError } from "@/lib/errors"
import { httpInvoke, invoke, isRemoteRuntime } from "./runtime"

export type WorkspaceEffectiveRuleSource = SchemaWorkspaceEffectiveRuleSource
export type WorkspaceEffectiveRulesResult = SchemaWorkspaceEffectiveRulesResult
export type WorkspaceContextSource = SchemaWorkspaceContextSource
export type WorkspaceContextArtifactResult =
  SchemaWorkspaceContextArtifactResult

export interface ShellInfo {
  id: string
  name: string
  path: string
  default?: boolean
}

/**
 * Probe the backend for available shells. Returns the list the backend
 * detected on this machine — `[]` if the backend isn't ready or the
 * detection failed. Used by the terminal panel to populate its shell
 * picker; no auth/permission flags are required because the route is
 * read-only.
 */
export const detectShells = () => httpInvoke<ShellInfo[]>("/shell/detect")

/** One row of `/workspace/search`: project-relative, forward-slash `path`. */
export interface WorkspaceSearchEntry {
  path: string
  name: string
  is_dir: boolean
}

/** Why the backend stopped an entry walk early (`services/workspace/search`). */
export type WorkspaceSearchEntriesTruncationReason =
  | "results"
  | "visited"
  | "deadline"

export interface WorkspaceSearchEntriesResult {
  entries: WorkspaceSearchEntry[]
  /** True when a cap stopped the walk; `entries` is then incomplete. */
  truncated: boolean
  truncatedReason?: WorkspaceSearchEntriesTruncationReason
}

/**
 * The backend answers both search routes with a detailed object. A bare array
 * is what an older backend build sent (the dev sidecar is not hot-reloaded,
 * so a stale `dist` is a real state); it is accepted and reported as
 * complete because that is all such a backend can say.
 */
export function unwrapSearchEntriesResponse(
  raw: unknown
): WorkspaceSearchEntriesResult {
  if (Array.isArray(raw)) {
    return { entries: raw as WorkspaceSearchEntry[], truncated: false }
  }
  const detailed = (raw ?? {}) as Partial<WorkspaceSearchEntriesResult>
  return {
    entries: Array.isArray(detailed.entries) ? detailed.entries : [],
    truncated: detailed.truncated === true,
    ...(detailed.truncated === true && detailed.truncatedReason
      ? { truncatedReason: detailed.truncatedReason }
      : {}),
  }
}

export const searchEntriesDetailed = (cwd: string, query: string) =>
  invoke<unknown>("/workspace/search", {
    args: { cwd, query },
    method: "POST",
    body: { cwd, query },
  }).then(unwrapSearchEntriesResponse)

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

/** See {@link unwrapSearchEntriesResponse} for why a bare array is accepted. */
export function unwrapContentSearchResponse(
  raw: unknown
): WorkspaceContentSearchDetailedResult {
  if (Array.isArray(raw)) {
    return { results: raw as WorkspaceContentSearchResult[], truncated: false }
  }
  const detailed = (raw ?? {}) as Partial<WorkspaceContentSearchDetailedResult>
  return {
    results: Array.isArray(detailed.results) ? detailed.results : [],
    truncated: detailed.truncated === true,
    ...(detailed.truncated === true && detailed.truncatedReason
      ? { truncatedReason: detailed.truncatedReason }
      : {}),
  }
}

export const searchContentDetailed = (
  cwd: string,
  query: string,
  limitOrOptions: number | WorkspaceContentSearchOptions = 200
) => {
  const options =
    typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : limitOrOptions
  return invoke<unknown>("/workspace/search-content", {
    args: { cwd, query, ...options },
    method: "POST",
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

export interface WorkspaceQuickOpenFile {
  path: string
  name: string
}

export interface WorkspaceQuickOpenOptions {
  limit?: number
  include?: string
}

export const quickOpenFiles = (
  cwd: string,
  query: string,
  limitOrOptions: number | WorkspaceQuickOpenOptions = 80
) => {
  const options =
    typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : limitOrOptions
  return invoke<WorkspaceQuickOpenFile[]>("/workspace/quick-open", {
    args: { cwd, query, ...options },
    method: "POST",
    body: { cwd, query, ...options },
  })
}

export type WorkspaceMapFileKind = "source" | "config" | "docs" | "data"

export interface WorkspaceMapFile {
  path: string
  name: string
  directory: string
  extension: string
  sizeBytes: number
  kind: WorkspaceMapFileKind
}

export interface WorkspaceMapDirectory {
  path: string
  name: string
  fileCount: number
  codeFileCount: number
  totalBytes: number
}

export interface WorkspaceMapExtension {
  extension: string
  label: string
  fileCount: number
  codeFileCount: number
  totalBytes: number
}

export interface WorkspaceMapOverview {
  rootName: string
  totalFiles: number
  scannedFiles: number
  codeFiles: number
  totalBytes: number
  truncated: boolean
  files: WorkspaceMapFile[]
  topDirectories: WorkspaceMapDirectory[]
  extensions: WorkspaceMapExtension[]
  importantFiles: WorkspaceMapFile[]
  largestFiles: WorkspaceMapFile[]
}

export const getWorkspaceMap = (cwd: string, maxFiles = 5000) =>
  invoke<WorkspaceMapOverview>("/workspace/map", {
    args: { cwd, maxFiles },
    method: "POST",
    body: { cwd, maxFiles },
  })

export interface WorkspaceProjectCommand {
  name: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
  sourcePath: string
  template: string
}

export const listProjectCommands = (cwd: string) =>
  invoke<WorkspaceProjectCommand[]>("/workspace/project-commands", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectAgent {
  id: string
  name: string
  description?: string
  enabled: boolean
  hidden?: boolean
  mode?: string
  model?: string
  variant?: string
  temperature?: number
  topP?: number
  color?: string
  steps?: number
  tools: Record<string, boolean>
  optionKeys: string[]
  permissions: WorkspaceProjectPermissionRule[]
  sourcePath: string
  prompt: string
}

export const listProjectAgents = (cwd: string) =>
  invoke<WorkspaceProjectAgent[]>("/workspace/project-agents", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectSkill {
  id: string
  name: string
  description?: string
  sourcePath: string
  sourceUrl?: string
  content: string
}

export const listProjectSkills = (cwd: string) =>
  invoke<WorkspaceProjectSkill[]>("/workspace/project-skills", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectMcpServer {
  id: string
  name: string
  type: "local" | "remote"
  command: string
  args: string[]
  env: Record<string, string>
  envKeys?: string[]
  headerKeys?: string[]
  enabled: boolean
  sourcePath: string
  url?: string | null
  timeoutMs?: number
  oauth?: "auto" | "disabled" | "configured"
  oauthKeys?: string[]
  authStatus?: "authenticated" | "expired" | "not_authenticated"
  authStorageKeys?: string[]
  authSourcePath?: string
  authServerUrl?: string | null
}

export const listProjectMcpServers = (cwd: string) =>
  invoke<WorkspaceProjectMcpServer[]>("/workspace/project-mcp-servers", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectInstruction {
  sourcePath: string
  content: string
}

export const listProjectInstructions = (cwd: string) =>
  invoke<WorkspaceProjectInstruction[]>("/workspace/project-instructions", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export const getEffectiveRules = (cwd: string, targetPath = ".") =>
  invoke<WorkspaceEffectiveRulesResult>("/workspace/effective-rules", {
    args: { cwd, targetPath },
    method: "POST",
    body: { cwd, targetPath },
  })

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
) => {
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
  return invoke<WorkspaceContextArtifactResult>("/workspace/context-artifact", {
    args: request,
    method: "POST",
    body: request,
  })
}

export interface WorkspaceProjectReference {
  id: string
  name: string
  kind: "local" | "git" | "invalid"
  sourcePath: string
  path?: string
  relativePath?: string
  repository?: string
  branch?: string
  exists?: boolean
  message?: string
}

export const listProjectReferences = (cwd: string) =>
  invoke<WorkspaceProjectReference[]>("/workspace/project-references", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectFormatter {
  id: string
  name: string
  enabled: boolean
  available?: boolean
  sourcePath: string
  command: string
  args: string[]
  env: Record<string, string>
  extensions: string[]
  builtin: boolean
}

export const listProjectFormatters = (cwd: string) =>
  invoke<WorkspaceProjectFormatter[]>("/workspace/project-formatters", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectFormatRun {
  id: string
  name: string
  sourcePath: string
  command: string
  args: string[]
  success: boolean
  exitCode: number | null
  signal?: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  skippedReason?: string
}

export interface WorkspaceProjectFormatResult {
  file: string
  formatted: boolean
  results: WorkspaceProjectFormatRun[]
  skippedReason?: string
}

export const formatProjectFile = (
  cwd: string,
  relativePath: string,
  formatterId?: string
) =>
  invoke<WorkspaceProjectFormatResult>("/workspace/project-format", {
    args: { cwd, relativePath, formatterId },
    method: "POST",
    body: { cwd, relativePath, formatterId },
  })

export interface WorkspaceProjectLspServer {
  id: string
  name: string
  enabled: boolean
  sourcePath: string
  command: string
  args: string[]
  env: Record<string, string>
  extensions: string[]
  initialization: Record<string, unknown>
  builtin: boolean
}

export const listProjectLspServers = (cwd: string) =>
  invoke<WorkspaceProjectLspServer[]>("/workspace/project-lsp-servers", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectPermissionRule {
  permission: string
  pattern: string
  action: "ask" | "allow" | "deny"
  sourcePath: string
}

export const listProjectPermissions = (cwd: string) =>
  invoke<WorkspaceProjectPermissionRule[]>("/workspace/project-permissions", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectConfigSetting {
  key: string
  label: string
  kind: "scalar" | "toggle" | "list" | "object"
  value: string
  sourcePath: string
}

export const listProjectConfigSettings = (cwd: string) =>
  invoke<WorkspaceProjectConfigSetting[]>("/workspace/project-config", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectProviderModel {
  id: string
  name?: string
  family?: string
  releaseDate?: string
  sourcePath: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  toolCall?: boolean
  interleaved?: boolean
  interleavedField?: string
  experimental?: boolean
  status?: string
  contextLimit?: number
  inputLimit?: number
  outputLimit?: number
  inputModalities?: string[]
  outputModalities?: string[]
  cost?: Record<string, number>
  contextOver200kCost?: Record<string, number>
  providerApi?: string
  providerNpm?: string
  optionKeys: string[]
  headerKeys: string[]
  variants: string[]
  disabledVariants: string[]
}

export interface WorkspaceProjectProvider {
  id: string
  name?: string
  sourcePath: string
  api?: string
  npm?: string
  env: string[]
  whitelist: string[]
  blacklist: string[]
  optionKeys: string[]
  hasApiKey: boolean
  baseURL?: string
  enterpriseUrl?: string
  setCacheKey?: boolean
  timeout?: number | false
  chunkTimeout?: number
  models: WorkspaceProjectProviderModel[]
}

export interface WorkspaceProjectProviderAuth {
  serviceId: string
  sourcePath: string
  accountCount: number
  credentialTypes: string[]
  activeAccountId?: string
  activeDescription?: string
  activeCredentialType?: string
  activeExpiresAt?: number
  activeExpired?: boolean
  metadataKeys?: string[]
}

export interface WorkspaceProjectProvidersSummary {
  defaultModel?: string
  smallModel?: string
  enabledProviders: string[]
  disabledProviders: string[]
  providers: WorkspaceProjectProvider[]
  authAccounts: WorkspaceProjectProviderAuth[]
}

export const listProjectProviders = (cwd: string) =>
  invoke<WorkspaceProjectProvidersSummary>("/workspace/project-providers", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectPlugin {
  id: string
  spec: string
  kind: "npm" | "file" | "url" | "invalid"
  sourcePath: string
  optionsKeys: string[]
  path?: string
  relativePath?: string
  exists?: boolean
  message?: string
  skipped?: boolean
  skippedReason?: string
  metaSourcePath?: string
  metaSource?: "file" | "npm"
  metaTarget?: string
  metaRequested?: string
  metaVersion?: string
  metaLoadCount?: number
  metaLastTime?: number
  metaTimeChanged?: number
  metaThemes?: string[]
}

export const listProjectPlugins = (cwd: string) =>
  invoke<WorkspaceProjectPlugin[]>("/workspace/project-plugins", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

export interface WorkspaceProjectToolFlag {
  tool: string
  enabled: boolean
  sourcePath: string
  kind?: "flag" | "custom"
  exportName?: string
}

export const listProjectTools = (cwd: string) =>
  invoke<WorkspaceProjectToolFlag[]>("/workspace/project-tools", {
    args: { cwd },
    method: "POST",
    body: { cwd },
  })

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
 *
 * Dynamic require into chat-store avoids a module cycle at load time
 * (`workspaceApi` ← `editor-store` ← `chat-store` ← `workspaceApi`).
 * By the time any read fires the store is always initialised.
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

function splitReadPath(path: string): { cwd: string; relativePath: string } {
  let workspacePath: string | null = null
  const knownRoots: string[] = []
  try {
    const { useChatStore } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("@/lib/chat-store") as typeof import("@/lib/chat-store")
    const state = useChatStore.getState()
    const active = state.threads.find((t) => t.id === state.activeThreadId)
    workspacePath =
      active?.worktreePath?.trim() || active?.projectPath?.trim() || null
    // The pane grid can show a file from a project other than the active
    // thread's (file tree in another pane, file-editor modal). Every thread
    // root the renderer knows is a backend-approved root, so collect them
    // all as containment candidates — active thread first.
    for (const thread of state.threads) {
      for (const root of [thread.worktreePath, thread.projectPath]) {
        const value = typeof root === "string" ? root.trim() : ""
        if (value && !knownRoots.includes(value)) knownRoots.push(value)
      }
    }
  } catch {
    // Store not yet ready (very early boot) — fall through.
  }
  return (
    splitReadPathForKnownRoots(path, [workspacePath, ...knownRoots]) ??
    splitReadPathForWorkspace(path, workspacePath) ?? {
      cwd: workspacePath || ".",
      relativePath: normalizeEditorPath(path).replace(/^\/+/, ""),
    }
  )
}

/**
 * @param path Single-string path; resolved via {@link splitReadPath}.
 * @param opts.silent404 When true, suppresses the transport's auto-`console.error`
 *   on 404 responses. Used by soft-probe callers (e.g. @-mention file
 *   resolution, project-rules detection) where a missing file is expected
 *   and would otherwise spam DevTools. The Promise still rejects with an
 *   {@link HttpError}, so caller try/catch logic is unchanged.
 */
export const readFile = (path: string, opts?: { silent404?: boolean }) =>
  httpInvoke<{ content: string; path: string }>("/workspace/read", {
    method: "POST",
    body: splitReadPath(path),
    silentStatuses: opts?.silent404 ? [404] : undefined,
  })

export interface WorkspaceBinaryFile {
  base64: string
  path: string
  size: number
}

export const readBinaryFile = (path: string) =>
  httpInvoke<WorkspaceBinaryFile>("/workspace/read-binary", {
    method: "POST",
    body: splitReadPath(path),
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
) => {
  const body = {
    cwd,
    relativePath,
    contents,
    ...(options.expectedSha256 === undefined
      ? {}
      : { expectedSha256: options.expectedSha256 }),
  }
  return invoke<void>("/workspace/write", {
    args: body,
    method: "POST",
    body,
  }).then((result) => {
    dispatchWorkspaceFileChanged(cwd, relativePath)
    return result
  })
}

export const createDirectory = (cwd: string, relativePath: string) =>
  invoke<void>("/workspace/mkdir", {
    args: { cwd, relativePath },
    method: "POST",
    body: { cwd, relativePath },
  }).then((result) => {
    dispatchWorkspaceFileChanged(cwd, relativePath)
    return result
  })

/**
 * Copies a project-less chat's scratch workspace into the repository it is
 * being forked into. Files already present in the destination are reported as
 * `skipped` rather than overwritten.
 */
export const adoptScratchWorkspace = (threadId: string, destination: string) =>
  invoke<{ copied: number; skipped: string[]; truncated?: boolean }>(
    "/workspace/scratch/adopt",
    {
      args: { threadId, destination },
      method: "POST",
      body: { threadId, destination },
    }
  )

export const moveWorkspacePath = (
  cwd: string,
  fromRelativePath: string,
  toRelativePath: string
) =>
  invoke<void>("/workspace/move", {
    args: { cwd, fromRelativePath, toRelativePath },
    method: "POST",
    body: { cwd, fromRelativePath, toRelativePath },
  }).then((result) => {
    dispatchWorkspaceFileChanged(cwd, toRelativePath, {
      previousRelativePath: fromRelativePath,
      previousPath: normalizedWorkspacePath(cwd, fromRelativePath),
    })
    return result
  })

export const deleteWorkspacePath = (
  cwd: string,
  relativePath: string,
  recursive = false
) =>
  invoke<void>("/workspace/delete", {
    args: { cwd, relativePath, recursive },
    method: "POST",
    body: { cwd, relativePath, recursive },
  }).then((result) => {
    dispatchWorkspaceFileChanged(cwd, relativePath, { deleted: true })
    return result
  })

type HumanShellCapabilityScope =
  | { operation: "run"; command: string; cwd: string }
  | {
      operation: "pty-open"
      cwd: string
      sessionId?: string
      command?: string
    }
  | { operation: "pty-write"; sessionId: string; data: string }

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
    const result = await httpInvoke<{ capability: string }>(
      "/shell/capability",
      { method: "POST", body: scope }
    )
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
}) => {
  const humanCapability = await requestHumanShellCapability({
    operation: "pty-open",
    cwd: input.cwd,
    sessionId: input.sessionId,
    command: input.command,
  })
  return httpInvoke<TerminalPtySnapshot>("/shell/pty/open", {
    method: "POST",
    body: {
      ...input,
      humanOrigin: true,
      permissionLevel: "bypass",
      humanCapability,
    },
  })
}

export const terminalRead = (sessionId: string, cursor = 0) =>
  httpInvoke<TerminalPtySnapshot>("/shell/pty/read", {
    method: "POST",
    body: { sessionId, cursor },
    timeoutMs: 15_000,
    silentStatuses: [404],
  })

export const terminalWrite = async (sessionId: string, data: string) => {
  const humanCapability = await requestHumanShellCapability({
    operation: "pty-write",
    sessionId,
    data,
  })
  return httpInvoke<{ ok: boolean }>("/shell/pty/write", {
    method: "POST",
    body: {
      sessionId,
      data,
      humanOrigin: true,
      permissionLevel: "bypass",
      humanCapability,
    },
  })
}

export const terminalClose = (sessionId: string) =>
  httpInvoke<{ ok: boolean }>("/shell/pty/close", {
    method: "POST",
    body: { sessionId },
    silentStatuses: [404],
  })

export const runShellCommandDetailed = async (
  command: string,
  cwd: string,
  shell?: string,
  env?: Record<string, string>,
  opts?: { humanOrigin?: boolean; permissionLevel?: string }
) => {
  // Read-only git/gh queries and similar commands (classified as `read` by
  // the backend) pass the permission gate without extra flags. For anything
  // that may classify as `execute`, the caller must mark it human-origin
  // with `permissionLevel:"bypass"` (e.g. user-typed terminal, user-
  // configured hooks that the user explicitly opted into).
  const humanOrigin = opts?.humanOrigin ?? false
  const permissionLevel =
    opts?.permissionLevel ?? (humanOrigin ? "bypass" : undefined)
  const humanCapability = humanOrigin
    ? await requestHumanShellCapability({ operation: "run", command, cwd })
    : undefined
  return invoke<ShellCommandResult>("/shell/run", {
    args: {
      command,
      cwd,
      shell,
      env,
      humanOrigin,
      permissionLevel,
      humanCapability,
    },
    method: "POST",
    body: {
      command,
      cwd,
      shell,
      env,
      humanOrigin,
      permissionLevel,
      humanCapability,
    },
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
