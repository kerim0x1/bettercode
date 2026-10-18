/**
 * Type declarations for the Electron preload API surface
 * exposed via `contextBridge.exposeInMainWorld("electronAPI", ...)`.
 *
 * Keep in sync with `electron/preload.cjs`.
 */

export interface ProviderAuthMethodApiKey {
  type: "api-key"
  label: string
  placeholder?: string
  envVars?: string[]
}
export interface ProviderAuthMethodOauth {
  type: "oauth"
  label: string
  handler: string
}
export interface ProviderAuthMethodLocalServer {
  type: "local-server"
  label: string
  defaultBaseUrl: string
  hint?: string
}
export interface ProviderAuthMethodCli {
  type: "cli"
  label: string
  /** Binary name expected on PATH. */
  command: string
  /** Args to fetch the version (used by `/cli/status`). */
  versionArgs: string[]
  /** Human-readable install command, shown in Settings when the CLI is missing. */
  installHint?: string
  /** Command the user runs to log in, shown when installed but not authenticated. */
  loginCommand?: string
}
export type ProviderAuthMethod =
  | ProviderAuthMethodApiKey
  | ProviderAuthMethodOauth
  | ProviderAuthMethodLocalServer
  | ProviderAuthMethodCli

export interface ProviderCatalogEntry {
  id: string
  name: string
  description?: string
  docsUrl?: string
  defaultModels: string[]
  authMethods: ProviderAuthMethod[]
}

export interface ElectronAppInfo {
  isPackaged: boolean
  baseDirName: string
  baseDir: string
  /**
   * S4: when false, the OS keyring is unavailable and provider API keys
   * are stored as plaintext in `<baseDir>/userdata/settings.json`. The UI
   * uses this signal to render a warning banner. Optional for wire-compat
   * with older main-process builds; absent ⇒ assume encrypted (matches
   * the historic behaviour on Windows/macOS where this never fires false).
   */
  secretsEncryptionAvailable?: boolean
  /** Process platform — `process.platform` on the main side. Used by the
   *  warning banner to surface platform-specific setup instructions. */
  platform?: NodeJS.Platform
  /**
   * Non-null when this install will never auto-update, so the UI can say so
   * instead of the user silently running an old build forever.
   *
   * `"unsigned-build"` — Windows or macOS build packaged without a signing
   * certificate: SmartScreen would re-warn on the Windows installer, and
   * Squirrel.Mac refuses unsigned macOS updates.
   * `"updater-unavailable"` — the electron-updater dependency is missing.
   */
  updatesDisabledReason?: "unsigned-build" | "updater-unavailable" | null
}

export interface CliScanContext {
  projectPath: string
  workspaceTrusted: boolean
}

export interface CliScanProjectScope {
  status: "not-selected" | "invalid" | "unavailable" | "untrusted" | "trusted"
  projectPath: string | null
  workspaceTrusted: boolean
}

export interface BugReportPayload {
  message: string
  stack: string
  logs?: string
  automatic?: boolean
}

export type BugReportResult =
  | { ok: true; retryAfterMs: number }
  | { ok: false; error: string; retryAfterMs: number }

export interface ElectronAPI {
  /** Synchronous process platform exposed by preload for platform-gated UI. */
  platform?: NodeJS.Platform

  // ── App info ──
  getAppInfo: () => Promise<ElectronAppInfo>
  sendBugReport: (report: BugReportPayload) => Promise<BugReportResult>
  /** Restart the sidecar after host-level settings such as remote access change. */
  restartBackend: () => Promise<{ port: number }>

  // ── Provider catalog + OAuth ──
  providerList: () => Promise<ProviderCatalogEntry[]>
  providerAuthStatus: () => Promise<
    Record<string, "oauth" | "api" | "wellknown">
  >
  providerOauthStart: (
    providerId: string,
    handler: string
  ) => Promise<{ ok: boolean; provider: string; instructions: string }>
  providerAuthClear: (providerId: string) => Promise<{ ok: boolean }>

  // ── Window controls ──
  windowMinimize: () => Promise<void>
  windowMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  windowToggleDevTools: () => Promise<void>
  /** Spawn a secondary BrowserWindow that boots the same renderer with
   *  `mode` (default: persisted preference) + `cwd` (default: none)
   *  passed through the URL hash. The new window has its own visible
   *  shell; localStorage / IndexedDB are shared with the primary. */
  windowOpenWith: (opts: {
    mode?: "agent" | "editor" | "design"
    cwd?: string
  }) => Promise<{ ok: boolean; error?: string }>

  // ── Shell / dialogs ──
  openExternal: (url: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  pickFolder: () => Promise<string | null>
  openHtmlPreview: (input: {
    projectPath: string
    relativePath?: string
  }) => Promise<import("@/lib/canvas-preview-source").HtmlPreviewResult>
  writeClipboardText?: (text: string) => Promise<void>
  confirmDialog: (opts: { title: string; message: string }) => Promise<boolean>
  requestShellCapability: (
    scope:
      | { operation: "run"; command: string; cwd: string }
      | {
          operation: "pty-open"
          cwd: string
          sessionId?: string
          command?: string
        }
      | { operation: "pty-write"; sessionId: string; data: string }
  ) => Promise<string>

  // NOTE: the `claude:*` main-process bridge was removed — it took its
  // permission level from the renderer and honoured "bypass". Provider turns
  // go through the authenticated backend, which owns that decision.

  // ── Backend status listener ──
  onBackendStatus: (callback: (event: unknown) => void) => () => void

  /** Requests the preview guests make; parsed by `parsePreviewRequest`. */
  onPreviewRequest: (callback: (entry: unknown) => void) => () => void

  // ── CLI Auto-Sync ──
  cliAutoSync: (scanContext?: CliScanContext) => Promise<{
    ok: boolean
    error?: string
    imported: { mcpServers: number; skills: number; agents: number }
    total: { mcpServers: number; skills: number; agents: number }
    projectScope: CliScanProjectScope
  }>

  // ── Onboarding ──
  onboardingIsDone: () => Promise<boolean>
  onboardingScan: (scanContext?: CliScanContext) => Promise<unknown>
  onboardingImport: (selections: Record<string, unknown>) => Promise<unknown>
  onboardingComplete: () => Promise<{ ok: boolean; error?: string }>
  onboardingReset: () => Promise<{ ok: boolean; error?: string }>

  // ── Checkpoint / Rewind ──
  rewindFiles: (
    pluginId: string,
    threadId: string,
    userMessageId: string
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>

  // ── MCP Servers ──
  mcpList: () => Promise<unknown[]>
  mcpInstall: (
    config: Record<string, unknown>
  ) => Promise<{ ok: boolean; id?: string; error?: string }>
  mcpRemove: (id: string) => Promise<{ ok: boolean; error?: string }>
  mcpUpdateEnv: (
    id: string,
    env: Record<string, string>
  ) => Promise<{ ok: boolean; error?: string }>
  mcpSetEnabled: (
    id: string,
    enabled: boolean
  ) => Promise<{ ok: boolean; error?: string }>
  mcpProbe: (config: Record<string, unknown>) => Promise<{
    ok: boolean
    error?: string
    stdout?: string
    stderr?: string
    note?: string
  }>

  // ── Custom Skills ──
  skillList: () => Promise<unknown[]>
  skillSave: (
    data: Record<string, unknown>
  ) => Promise<{ ok: boolean; id?: string; error?: string }>
  skillDelete: (id: string) => Promise<{ ok: boolean; error?: string }>
  skillImportUrl: (
    url: string,
    name?: string
  ) => Promise<{ ok: boolean; id?: string; error?: string }>
  skillsShPreview: (repo: string) => Promise<{
    ok: boolean
    error?: string
    skills?: string[]
    raw?: string
  }>
  skillsShAdd: (
    repo: string,
    skill?: string
  ) => Promise<{
    ok: boolean
    error?: string
    installed?: Array<{ target: "claude" | "codex"; name: string }>
  }>
  skillsShSearch: (query?: string) => Promise<{
    ok: boolean
    error?: string
    skills?: Array<{
      id: string
      skillId: string
      name: string
      source: string
      installs: number
    }>
  }>

  // ── Runtime rules / hooks / subagents ──
  rulesGet: () => Promise<{ content: string }>
  rulesSave: (content: string) => Promise<{ ok: boolean; error?: string }>
  hookList: () => Promise<unknown[]>
  hookSave: (
    hook: Record<string, unknown>
  ) => Promise<{ ok: boolean; id?: string; error?: string }>
  hookDelete: (id: string) => Promise<{ ok: boolean; error?: string }>
  hookUpdateRun: (
    id: string,
    status: string,
    exitCode?: number | null,
    error?: string | null
  ) => Promise<{ ok: boolean; error?: string }>
  subagentList: () => Promise<unknown[]>
  subagentSave: (
    agent: Record<string, unknown>
  ) => Promise<{ ok: boolean; id?: string; error?: string }>
  subagentDelete: (id: string) => Promise<{ ok: boolean; error?: string }>

  // ── CLI plugins (Claude Code / Codex plugin inventory) ──
  cliPluginInventory: (opts?: {
    force?: boolean
  }) => Promise<import("@betterc0de/schema").CliPluginInventory>
  cliPluginAvailable: () => Promise<{
    claude: import("@betterc0de/schema").CliPlugin[]
    codex: import("@betterc0de/schema").CliPlugin[]
  }>
  cliPluginToggle: (
    source: "claude" | "codex",
    id: string,
    enabled: boolean
  ) => Promise<{
    ok: boolean
    error?: string
    inventory?: import("@betterc0de/schema").CliPluginInventory
  }>
  cliPluginInstall: (
    source: "claude" | "codex",
    id: string
  ) => Promise<{
    ok: boolean
    error?: string
    inventory?: import("@betterc0de/schema").CliPluginInventory
  }>
  cliPluginUninstall: (
    source: "claude" | "codex",
    id: string
  ) => Promise<{
    ok: boolean
    error?: string
    inventory?: import("@betterc0de/schema").CliPluginInventory
  }>

  // ── Plugin system ──
  pluginList: () => Promise<unknown[]>
  pluginInstall: (
    sourcePath?: string
  ) => Promise<{ ok: boolean; manifest?: unknown; error?: string }>
  pluginInstallDefault: (
    pluginId: string
  ) => Promise<{ ok: boolean; manifest?: unknown; error?: string }>
  pluginRemove: (pluginId: string) => Promise<{ ok: boolean; error?: string }>
  pluginToggle: (
    pluginId: string,
    enabled: boolean
  ) => Promise<{ ok: boolean; error?: string }>
  pluginConfigGet: (pluginId: string) => Promise<unknown>
  pluginConfigSet: (
    pluginId: string,
    key: string,
    value: unknown
  ) => Promise<{ ok: boolean; error?: string }>
  pluginSend: (
    pluginId: string,
    method: string,
    args?: Record<string, unknown>
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>
  onPluginEvent: (
    callback: (event: {
      threadId: string
      type: string
      payload: Record<string, unknown>
      pluginId?: string
    }) => void
  ) => () => void
}

export interface BetterC0deConfig {
  port: number
  mode: string
  baseUrl?: string
  electronPath?: string
  previewPartition?: string
  homePath?: string
}

/** Shape exposed on `window` by the terminal panel for attaching output to prompts. */
interface BetterC0deTerminalInfo {
  id: string
  label: string
  shell: string
  output: string
  lineCount: number
}

/** Tool-call tracking used by `lib/provider-events/` for live editor updates. */
interface BetterC0deToolCallInfo {
  name: string
  input: Record<string, unknown>
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
    __BETTERC0DE__?: BetterC0deConfig
    __BETTERC0DE_TERMINALS__?: BetterC0deTerminalInfo[]
    __betterc0de_tool_calls__?: Record<string, BetterC0deToolCallInfo>
    __betterc0de_active_thread__?: { projectPath?: string }
  }
}
