const { contextBridge, ipcRenderer } = require("electron");

// NOTE: Electron's sandboxed preload environment restricts `require()` to
// `electron` + a tiny set of built-ins — it cannot load sibling `.cjs`
// modules like `./shared/ipc-contract.cjs`. So the channel strings live
// inline here. The authoritative registry is `apps/shell/shared/ipc-contract.cjs`:
// `PreloadApi` there lists every member exposed below and the channel or
// event it uses, and the object is typed from it (`PreloadElectronApi`, a
// type-only import that is erased at runtime). Two tests hold this file to
// it: `scripts/preload-api-contract.test.mjs` (members, channels, and the
// renderer's electron-api.d.ts) and `apps/ui/src/types/ipc-contract.parity.test.ts`
// (every channel and event is used). Add or rename a bridge method in
// ipc-contract.cjs and here at the same time.

// A random id for this page load. The renderer sends it with the shell
// requests that start terminals and commands; the main process releases it
// (and the backend ends what this page started) when the page crashes,
// reloads or closes. It names a page, it does not authorize anything.
function createClientInstanceId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const clientInstanceId = createClientInstanceId();
ipcRenderer
  .invoke("renderer:client-instance", clientInstanceId)
  .catch((error) => console.warn("[preload] client instance:", error?.message || error));

// How many `onPreviewRequest` callbacks this window holds; the main process
// is told when the first subscribes and the last leaves.
let previewRequestSubscribers = 0;
function setPreviewRequestSubscription(subscribed) {
  ipcRenderer
    .invoke("preview:request-subscribe", subscribed)
    .catch((error) => console.warn("[preload] preview request feed:", error?.message || error));
}

/** @type {import("./shared/ipc-contract.cjs").PreloadElectronApi} */
const electronAPI = {
  platform: process.platform,
  // Sent as `X-BetterC0de-Client-Instance` on /shell/run and /shell/pty/open.
  clientInstanceId,

  // App info (async - call once and cache)
  getAppInfo: () => ipcRenderer.invoke("app:info"),
  sendBugReport: (report) => ipcRenderer.invoke("bug-report:send", report),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
  // Backend port + preview settings; later port changes arrive via onBackendStatus.
  getRuntimeConfig: () => ipcRenderer.invoke("runtime:config"),

  // Window controls
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("window:maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  windowToggleDevTools: () => ipcRenderer.invoke("window:toggleDevTools"),
  windowOpenWith: (opts) => ipcRenderer.invoke("window:open-with", opts || {}),

  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  openPath: (p) => ipcRenderer.invoke("open-path", p),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  openHtmlPreview: (input) => ipcRenderer.invoke("preview:open-html", input),
  writeClipboardText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  // The main process answers only right after real input to this window.
  readClipboardText: () => ipcRenderer.invoke("clipboard:read-text"),
  confirmDialog: (opts) => ipcRenderer.invoke("confirm-dialog", opts),
  // The main process decides whether to mint a capability: an approved hook
  // command, or a command issued within moments of real user input to this
  // window (input events the main process observes itself). The transient
  // user-activation check that used to sit here expired before automatic
  // hooks ran and proved nothing the main process cannot check itself.
  requestShellCapability: (scope) => ipcRenderer.invoke("shell:capability", scope),

  // NOTE: the legacy `claude:*` bridge (a second Claude Agent SDK provider
  // running in the main process) was removed. It accepted `permissionLevel`
  // straight from the renderer and honoured `"bypass"`, so any script running
  // in the renderer could have obtained unattended Bash/Write/Edit at an
  // arbitrary `projectPath`. The renderer had already stopped calling it —
  // every turn now goes through the authenticated backend, which owns the
  // permission decision. Do not reintroduce a privileged IPC channel that
  // takes its policy from its caller.

  onBackendStatus: (callback) => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on("backend:status", listener);
    return () => ipcRenderer.removeListener("backend:status", listener);
  },

  // The computer woke from sleep: timers stretched across the suspend, so a
  // pending reconnect may be far in the future.
  onSystemResume: (callback) => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on("system:resumed", listener);
    return () => ipcRenderer.removeListener("system:resumed", listener);
  },

  // A preview guest of this window was destroyed (`{ webContentsId }`).
  onPreviewGuestDestroyed: (callback) => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on("preview:guest-destroyed", listener);
    return () => ipcRenderer.removeListener("preview:guest-destroyed", listener);
  },

  // Requests the preview guests of this window make, one callback per
  // finished request. The main process only records and sends them while a
  // window is subscribed, and sends them in batches (an array per flush).
  onPreviewRequest: (callback) => {
    const listener = (_, batch) => {
      for (const entry of Array.isArray(batch) ? batch : [batch]) callback(entry);
    };
    ipcRenderer.on("preview:request", listener);
    previewRequestSubscribers += 1;
    if (previewRequestSubscribers === 1) setPreviewRequestSubscription(true);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      ipcRenderer.removeListener("preview:request", listener);
      previewRequestSubscribers -= 1;
      if (previewRequestSubscribers === 0) setPreviewRequestSubscription(false);
    };
  },

  // Onboarding
  onboardingIsDone: () => ipcRenderer.invoke("onboarding:is-done"),
  onboardingScan: (scanContext) =>
    ipcRenderer.invoke("onboarding:scan", scanContext),
  onboardingImport: (selections) => ipcRenderer.invoke("onboarding:import", selections),
  onboardingComplete: () => ipcRenderer.invoke("onboarding:complete"),
  onboardingReset: () => ipcRenderer.invoke("onboarding:reset"),

  // CLI auto-sync (startup import of new CLI-configured servers/skills/agents)
  cliAutoSync: (scanContext) =>
    ipcRenderer.invoke("cli:auto-sync", scanContext),

  // Checkpoint / Rewind
  rewindFiles: (pluginId, threadId, userMessageId) => ipcRenderer.invoke("plugin:send", { pluginId, method: "rewindFiles", args: { threadId, userMessageId } }),

  // MCP Servers
  mcpList: () => ipcRenderer.invoke("mcp:list"),
  mcpInstall: (config) => ipcRenderer.invoke("mcp:install", config),
  mcpRemove: (id) => ipcRenderer.invoke("mcp:remove", { id }),
  mcpUpdateEnv: (id, env) => ipcRenderer.invoke("mcp:update-env", { id, env }),
  mcpSetEnabled: (id, enabled) =>
    ipcRenderer.invoke("mcp:set-enabled", { id, enabled }),
  mcpProbe: (config) => ipcRenderer.invoke("mcp:probe", config),

  // Custom Skills
  skillList: () => ipcRenderer.invoke("skill:list"),
  skillSave: (data) => ipcRenderer.invoke("skill:save", data),
  skillDelete: (id) => ipcRenderer.invoke("skill:delete", { id }),
  skillImportUrl: (url, name) => ipcRenderer.invoke("skill:import-url", { url, name }),
  skillsShPreview: (repo) => ipcRenderer.invoke("skill:skills-sh-preview", { repo }),
  skillsShAdd: (repo, skill) => ipcRenderer.invoke("skill:skills-sh-add", { repo, skill }),
  skillsShSearch: (query) => ipcRenderer.invoke("skill:skills-sh-search", { query }),

  // Runtime rules / hooks / subagents
  rulesGet: () => ipcRenderer.invoke("rules:get"),
  rulesSave: (content) => ipcRenderer.invoke("rules:save", content),
  hookList: () => ipcRenderer.invoke("hook:list"),
  hookSave: (hook) => ipcRenderer.invoke("hook:save", hook),
  hookDelete: (id) => ipcRenderer.invoke("hook:delete", { id }),
  hookUpdateRun: (id, status, exitCode, error) =>
    ipcRenderer.invoke("hook:update-run", { id, status, exitCode, error }),
  subagentList: () => ipcRenderer.invoke("subagent:list"),
  subagentSave: (agent) => ipcRenderer.invoke("subagent:save", agent),
  subagentDelete: (id) => ipcRenderer.invoke("subagent:delete", { id }),

  // Provider catalog. The Settings UI reads `providerList()` to render its
  // rows and clears stored credentials via `providerAuthClear(id)`. (The
  // ChatGPT sign-in bridge was removed with that flow.)
  providerList: () => ipcRenderer.invoke("provider:list"),
  providerAuthStatus: () => ipcRenderer.invoke("provider:auth-status"),
  providerAuthClear: (providerId) =>
    ipcRenderer.invoke("provider:auth-clear", { providerId }),

  // CLI plugins (Claude Code / Codex plugin inventory)
  cliPluginInventory: (opts) => ipcRenderer.invoke("cliPlugin:inventory", opts || {}),
  cliPluginAvailable: () => ipcRenderer.invoke("cliPlugin:available"),
  cliPluginToggle: (source, id, enabled) =>
    ipcRenderer.invoke("cliPlugin:toggle", { source, id, enabled }),
  cliPluginInstall: (source, id) =>
    ipcRenderer.invoke("cliPlugin:install", { source, id }),
  cliPluginUninstall: (source, id) =>
    ipcRenderer.invoke("cliPlugin:uninstall", { source, id }),

  // Plugin system
  pluginList: () => ipcRenderer.invoke("plugin:list"),
  pluginInstall: (sourcePath) => ipcRenderer.invoke("plugin:install", { sourcePath }),
  pluginInstallDefault: (pluginId) => ipcRenderer.invoke("plugin:install-default", { pluginId }),
  pluginRemove: (pluginId) => ipcRenderer.invoke("plugin:remove", { pluginId }),
  pluginToggle: (pluginId, enabled) => ipcRenderer.invoke("plugin:toggle", { pluginId, enabled }),
  pluginConfigGet: (pluginId) => ipcRenderer.invoke("plugin:config-get", { pluginId }),
  pluginConfigSet: (pluginId, key, value) => ipcRenderer.invoke("plugin:config-set", { pluginId, key, value }),
  pluginSend: (pluginId, method, args) => ipcRenderer.invoke("plugin:send", { pluginId, method, args }),
  onPluginEvent: (callback) => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on("plugin:event", listener);
    return () => ipcRenderer.removeListener("plugin:event", listener);
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
