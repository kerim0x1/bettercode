/**
 * IPC channel names — the single registry for the bridge. The preload
 * (`preload.cjs`, which cannot require this file) repeats the strings, and
 * `apps/ui/src/types/ipc-contract.parity.test.ts` checks that the preload
 * exposes every channel and event here and that the main process registers
 * every channel exactly once.
 *
 * Use these constants everywhere in .cjs code instead of string literals so
 * rename-refactors actually rename all references.
 */

const IpcChannel = Object.freeze({
  // App / window
  AppInfo: "app:info",
  BugReportSend: "bug-report:send",
  BackendRestart: "backend:restart",
  // Backend port and preview settings for the renderer (replaces the old
  // executeJavaScript injection of window.__BETTERC0DE__).
  RuntimeConfigGet: "runtime:config",
  WindowMinimize: "window:minimize",
  WindowMaximize: "window:maximize",
  WindowClose: "window:close",
  WindowIsMaximized: "window:isMaximized",
  WindowToggleDevTools: "window:toggleDevTools",
  // Spawns a secondary BrowserWindow with mode + cwd carried in the URL
  // hash. Used by the file-tree's "Open in Editor Mode" right-click.
  WindowOpenWith: "window:open-with",
  OpenExternal: "open-external",
  OpenPath: "open-path",
  PickFolder: "pick-folder",
  OpenHtmlPreview: "preview:open-html",
  // A window starts/stops receiving its preview guests' request feed
  // (IpcEvent.PreviewRequest). Nothing is captured while nobody subscribes.
  PreviewRequestSubscribe: "preview:request-subscribe",
  ClipboardWriteText: "clipboard:write-text",
  // Right after real input only: the terminal pastes on right-click, and
  // Chromium's clipboard read permission stays denied.
  ClipboardReadText: "clipboard:read-text",
  ConfirmDialog: "confirm-dialog",
  ShellCapability: "shell:capability",
  // The preload reports the random id of the page it just loaded; terminals
  // and shell runs that page starts are released with it (renderer crash,
  // reload, window close).
  RendererClientInstance: "renderer:client-instance",

  // Onboarding
  OnboardingIsDone: "onboarding:is-done",
  OnboardingScan: "onboarding:scan",
  OnboardingImport: "onboarding:import",
  OnboardingComplete: "onboarding:complete",
  OnboardingReset: "onboarding:reset",

  // CLI auto-sync
  CliAutoSync: "cli:auto-sync",

  // MCP servers
  McpList: "mcp:list",
  McpInstall: "mcp:install",
  McpRemove: "mcp:remove",
  McpUpdateEnv: "mcp:update-env",
  McpSetEnabled: "mcp:set-enabled",
  McpProbe: "mcp:probe",

  // Custom skills
  SkillList: "skill:list",
  SkillSave: "skill:save",
  SkillDelete: "skill:delete",
  SkillImportUrl: "skill:import-url",
  // skills.sh registry (npx skills)
  SkillsShPreview: "skill:skills-sh-preview",
  SkillsShAdd: "skill:skills-sh-add",
  SkillsShSearch: "skill:skills-sh-search",

  // Rules
  RulesGet: "rules:get",
  RulesSave: "rules:save",

  // Hooks
  HookList: "hook:list",
  HookSave: "hook:save",
  HookDelete: "hook:delete",
  HookUpdateRun: "hook:update-run",

  // Subagents
  SubagentList: "subagent:list",
  SubagentSave: "subagent:save",
  SubagentDelete: "subagent:delete",

  // CLI plugins (Claude Code / Codex CLI plugin inventory — distinct from
  // the BetterC0de provider-plugin system on the `plugin:*` namespace)
  CliPluginInventory: "cliPlugin:inventory",
  CliPluginAvailable: "cliPlugin:available",
  CliPluginToggle: "cliPlugin:toggle",
  CliPluginInstall: "cliPlugin:install",
  CliPluginUninstall: "cliPlugin:uninstall",

  // Plugin system
  PluginList: "plugin:list",
  PluginInstall: "plugin:install",
  PluginInstallDefault: "plugin:install-default",
  PluginRemove: "plugin:remove",
  PluginToggle: "plugin:toggle",
  PluginConfigGet: "plugin:config-get",
  PluginConfigSet: "plugin:config-set",
  PluginSend: "plugin:send",

  // Provider catalog
  ProviderList: "provider:list",
  ProviderAuthStatus: "provider:auth-status",
  ProviderAuthClear: "provider:auth-clear",
})

/** Event channels (renderer subscribes via `ipcRenderer.on`). */
const IpcEvent = Object.freeze({
  BackendStatus: "backend:status",
  PluginEvent: "plugin:event",
  /**
   * Finished requests of the preview guests a window hosts (canvas runtime
   * pane), as an array per flush; sent only to subscribed owner windows.
   */
  PreviewRequest: "preview:request",
  /**
   * A preview guest this window hosted was destroyed (`{ webContentsId }`),
   * so state kept per guest id can be dropped.
   */
  PreviewGuestDestroyed: "preview:guest-destroyed",
  /** The computer woke from sleep; reconnect and refresh what went stale. */
  SystemResumed: "system:resumed",
})

/**
 * The bridge the preload exposes as `window.electronAPI`, member by member:
 *  - `invoke`: the method calls `ipcRenderer.invoke` on this channel;
 *  - `events`: the method subscribes to this event and returns an
 *    unsubscribe function;
 *  - `values`: plain properties;
 *  - `internal`: channels the preload invokes on its own (page-load client
 *    id, preview request subscription), not exposed as methods.
 *
 * The sandboxed preload cannot require this file, so it repeats the strings.
 * `scripts/preload-api-contract.test.mjs` runs the real preload and fails
 * when its members or channels differ from this registry, or when the
 * renderer's hand-written `apps/ui/src/types/electron-api.d.ts` names a
 * different set of members. Add a bridge method here first.
 */
const PreloadApi = Object.freeze({
  invoke: Object.freeze({
    // App / window
    getAppInfo: IpcChannel.AppInfo,
    sendBugReport: IpcChannel.BugReportSend,
    restartBackend: IpcChannel.BackendRestart,
    getRuntimeConfig: IpcChannel.RuntimeConfigGet,
    windowMinimize: IpcChannel.WindowMinimize,
    windowMaximize: IpcChannel.WindowMaximize,
    windowClose: IpcChannel.WindowClose,
    windowIsMaximized: IpcChannel.WindowIsMaximized,
    windowToggleDevTools: IpcChannel.WindowToggleDevTools,
    windowOpenWith: IpcChannel.WindowOpenWith,
    openExternal: IpcChannel.OpenExternal,
    openPath: IpcChannel.OpenPath,
    pickFolder: IpcChannel.PickFolder,
    openHtmlPreview: IpcChannel.OpenHtmlPreview,
    writeClipboardText: IpcChannel.ClipboardWriteText,
    readClipboardText: IpcChannel.ClipboardReadText,
    confirmDialog: IpcChannel.ConfirmDialog,
    requestShellCapability: IpcChannel.ShellCapability,
    // Onboarding and CLI auto-sync
    onboardingIsDone: IpcChannel.OnboardingIsDone,
    onboardingScan: IpcChannel.OnboardingScan,
    onboardingImport: IpcChannel.OnboardingImport,
    onboardingComplete: IpcChannel.OnboardingComplete,
    onboardingReset: IpcChannel.OnboardingReset,
    cliAutoSync: IpcChannel.CliAutoSync,
    // Checkpoint / rewind goes through the plugin bridge.
    rewindFiles: IpcChannel.PluginSend,
    // MCP servers
    mcpList: IpcChannel.McpList,
    mcpInstall: IpcChannel.McpInstall,
    mcpRemove: IpcChannel.McpRemove,
    mcpUpdateEnv: IpcChannel.McpUpdateEnv,
    mcpSetEnabled: IpcChannel.McpSetEnabled,
    mcpProbe: IpcChannel.McpProbe,
    // Custom skills and skills.sh
    skillList: IpcChannel.SkillList,
    skillSave: IpcChannel.SkillSave,
    skillDelete: IpcChannel.SkillDelete,
    skillImportUrl: IpcChannel.SkillImportUrl,
    skillsShPreview: IpcChannel.SkillsShPreview,
    skillsShAdd: IpcChannel.SkillsShAdd,
    skillsShSearch: IpcChannel.SkillsShSearch,
    // Rules, hooks, subagents
    rulesGet: IpcChannel.RulesGet,
    rulesSave: IpcChannel.RulesSave,
    hookList: IpcChannel.HookList,
    hookSave: IpcChannel.HookSave,
    hookDelete: IpcChannel.HookDelete,
    hookUpdateRun: IpcChannel.HookUpdateRun,
    subagentList: IpcChannel.SubagentList,
    subagentSave: IpcChannel.SubagentSave,
    subagentDelete: IpcChannel.SubagentDelete,
    // Provider catalog
    providerList: IpcChannel.ProviderList,
    providerAuthStatus: IpcChannel.ProviderAuthStatus,
    providerAuthClear: IpcChannel.ProviderAuthClear,
    // CLI plugins
    cliPluginInventory: IpcChannel.CliPluginInventory,
    cliPluginAvailable: IpcChannel.CliPluginAvailable,
    cliPluginToggle: IpcChannel.CliPluginToggle,
    cliPluginInstall: IpcChannel.CliPluginInstall,
    cliPluginUninstall: IpcChannel.CliPluginUninstall,
    // Plugin system
    pluginList: IpcChannel.PluginList,
    pluginInstall: IpcChannel.PluginInstall,
    pluginInstallDefault: IpcChannel.PluginInstallDefault,
    pluginRemove: IpcChannel.PluginRemove,
    pluginToggle: IpcChannel.PluginToggle,
    pluginConfigGet: IpcChannel.PluginConfigGet,
    pluginConfigSet: IpcChannel.PluginConfigSet,
    pluginSend: IpcChannel.PluginSend,
  }),
  events: Object.freeze({
    onBackendStatus: IpcEvent.BackendStatus,
    onSystemResume: IpcEvent.SystemResumed,
    onPreviewGuestDestroyed: IpcEvent.PreviewGuestDestroyed,
    onPreviewRequest: IpcEvent.PreviewRequest,
    onPluginEvent: IpcEvent.PluginEvent,
  }),
  values: Object.freeze(["platform", "clientInstanceId"]),
  internal: Object.freeze({
    clientInstance: IpcChannel.RendererClientInstance,
    previewRequestSubscription: IpcChannel.PreviewRequestSubscribe,
  }),
})

/**
 * The type of the preload's `window.electronAPI` object, generated from
 * `PreloadApi`: preload.cjs annotates its object with it, so under checkJs a
 * member missing from (or not in) the registry is a type error. Payloads are
 * not modelled here yet; the renderer's view of them is
 * apps/ui/src/types/electron-api.d.ts.
 *
 * @typedef {{
 *   [K in keyof typeof PreloadApi.invoke]: (...args: any[]) => Promise<any>
 * } & {
 *   [K in keyof typeof PreloadApi.events]: (callback: (payload: any) => void) => () => void
 * } & {
 *   platform: NodeJS.Platform
 *   clientInstanceId: string
 * }} PreloadElectronApi
 */

module.exports = { IpcChannel, IpcEvent, PreloadApi }
