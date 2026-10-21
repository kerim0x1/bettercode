/**
 * Plugin IPC — Electron IPC handlers for plugin system
 *
 * Startup order: `registerPluginHandlers()` only registers handlers (no
 * I/O, no plugin code), so it can run before the first window. Plugin
 * install/scan/require and event setup happen in `startPlugins()`, which
 * main.cjs starts after the window exists and does not wait for; handlers
 * that depend on loaded plugins wait for it instead.
 */

const { dialog, BrowserWindow, app } = require("electron")
const path = require("path")
const fs = require("fs")
const { PluginManager, validatePluginId, runtimeModulePaths } = require("./plugin-manager.cjs")
const { IpcChannel, IpcEvent } = require("./shared/ipc-contract.cjs")
const { safeHandle, rawHandle } = require("./shared/ipc-handlers-factory.cjs")
const { assertPathContained } = require("./shared/security-checks.cjs")
const { broadcast } = require("./shared/broadcast.cjs")

/**
 * Where plugin code runs. With BETTERC0DE_PLUGIN_HOST=utility it runs in a
 * separate utility process (shared/plugin-host-client.cjs): a plugin that
 * spins the CPU, crashes or leaks child processes no longer takes the app
 * with it. Otherwise plugins are `require()`d into this process, as before;
 * that stays the default until the host has been verified in packaged
 * builds on every platform.
 */
function usePluginHost(env = process.env) {
  return env.BETTERC0DE_PLUGIN_HOST === "utility"
}

function createPluginHost() {
  const {
    createPluginHostClient,
    spawnUtilityPluginHost,
  } = require("./shared/plugin-host-client.cjs")
  return createPluginHostClient({
    spawnHost: () => spawnUtilityPluginHost(),
    getModulePaths: runtimeModulePaths,
    // An uncaught error the host traced to one plugin: same handling as an
    // in-process plugin fault (handlePluginUncaughtException).
    onFault: (pluginId, error) => {
      if (!manager.plugins.has(pluginId)) return
      manager.disablePluginAfterFault(pluginId, error)
      console.error(
        `[plugin] ${pluginId} threw an uncaught error and was disabled:`,
        error?.stack || error,
      )
    },
    // The host exited unexpectedly. Its plugins are reloaded (in a new host,
    // after the client's restart backoff) and their events wired again, as
    // at startup; after repeated crashes they stay stopped until used again.
    onCrash: ({ reason, gaveUp }) => {
      const affected = manager.handleHostExit(reason)
      if (gaveUp) return
      for (const pluginId of affected) {
        void manager
          .loadPlugin(pluginId)
          .then(() => setupEvents(pluginId))
          .catch((error) => {
            console.error(
              `[plugin] Could not restart ${pluginId} after the plugin host stopped:`,
              error?.message || error,
            )
          })
      }
    },
  })
}

const pluginHost = usePluginHost() ? createPluginHost() : null
const manager = new PluginManager({ host: pluginHost })

// Resolve "the window the user is interacting with" for dialog parents
// (`dialog.showOpenDialog`, `dialog.showMessageBox`). With multi-window
// support the previous "remembered mainWindow" hint became misleading —
// dialogs anchored to the wrong window when the user triggered an
// install from a secondary BrowserWindow. Letting Electron pick the
// focused window resolves this correctly in every case.
function getWindow() {
  return (
    BrowserWindow.getFocusedWindow() ||
    BrowserWindow.getAllWindows()[0] ||
    null
  )
}
let handlersRegistered = false
let pluginsReady = null

/** Resolves once startup loading finished (successfully or not). */
function whenPluginsReady() {
  return pluginsReady || Promise.resolve()
}

async function activateInstalledPlugin(manifest) {
  try {
    await manager.loadPlugin(manifest.id)
    await setupEvents(manifest.id)
  } catch (activationError) {
    try {
      await manager.togglePlugin(manifest.id, false)
    } catch (disableError) {
      throw new AggregateError(
        [activationError, disableError],
        `Plugin ${manifest.id} was installed, failed to activate, and could not be disabled`,
      )
    }
    throw new Error(
      `Plugin ${manifest.id} was installed but disabled because activation failed: ${
        activationError?.message || String(activationError)
      }`,
      { cause: activationError },
    )
  }
}

function getBundledPluginsDirectory() {
  return app.isPackaged
    ? path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "apps",
        "shell",
        "default-plugins",
      )
    : path.join(__dirname, "default-plugins")
}

function registerPluginHandlers() {
  if (handlersRegistered) return
  handlersRegistered = true

  rawHandle(
    IpcChannel.PluginList,
    async () => {
      await whenPluginsReady()
      return manager.listPlugins()
    },
    { fallback: [], warnTag: "plugin-ipc" },
  )

  // Install plugin from folder.
  // SECURITY: any renderer-supplied `sourcePath` is treated as untrusted and
  // requires an explicit user confirmation dialog before we copy+require code
  // into the main process. When the caller omits `sourcePath`, the native
  // file-picker provides the approval implicitly.
  safeHandle(IpcChannel.PluginInstall, async (_event, { sourcePath } = {}) => {
    if (!sourcePath) {
      const result = await dialog.showOpenDialog(getWindow(), {
        properties: ["openDirectory"],
        title: "Select Plugin Folder",
      })
      if (result.canceled || !result.filePaths[0]) return { ok: false }
      sourcePath = result.filePaths[0]
    } else {
      if (typeof sourcePath !== "string" || sourcePath.length === 0) {
        throw new Error("Invalid sourcePath")
      }
      const confirm = await dialog.showMessageBox(getWindow(), {
        type: "warning",
        title: "Install plugin?",
        message: "Install plugin from this folder?",
        detail:
          `${sourcePath}\n\n` +
          (pluginHost
            ? "Plugins run native code with your permissions, in BetterC0de's plugin host process. "
            : "Plugins execute native code in the BetterC0de main process. ") +
          "Only install plugins from sources you trust.",
        buttons: ["Cancel", "Install"],
        defaultId: 0,
        cancelId: 0,
      })
      if (confirm.response !== 1) throw new Error("User cancelled")
    }
    await whenPluginsReady()
    const manifest = await manager.installPlugin(sourcePath)
    await activateInstalledPlugin(manifest)
    return { manifest }
  })

  safeHandle(IpcChannel.PluginRemove, async (_event, { pluginId } = {}) => {
    await whenPluginsReady()
    await manager.removePlugin(pluginId)
  })

  safeHandle(IpcChannel.PluginToggle, async (_event, { pluginId, enabled } = {}) => {
    await whenPluginsReady()
    await manager.togglePlugin(pluginId, enabled)
    if (enabled) {
      try {
        await manager.loadPlugin(pluginId)
        await setupEvents(pluginId)
      } catch (activationError) {
        try {
          await manager.togglePlugin(pluginId, false)
        } catch (disableError) {
          throw new AggregateError(
            [activationError, disableError],
            `Plugin ${pluginId} failed to activate and could not be disabled`,
          )
        }
        throw activationError
      }
    }
  })

  // Plugin config is a free-form object; renderer expects the raw object,
  // not the `{ok, ...}` envelope, so this stays on `rawHandle`.
  rawHandle(
    IpcChannel.PluginConfigGet,
    async (_event, { pluginId } = {}) => manager.getPublicConfig(pluginId),
    { fallback: {}, warnTag: "plugin-ipc" },
  )

  safeHandle(IpcChannel.PluginConfigSet, async (_event, { pluginId, key, value } = {}) => {
    await manager.setConfig(pluginId, key, value)
  })

  safeHandle(IpcChannel.PluginSend, async (_event, { pluginId, method, args } = {}) => {
    await whenPluginsReady()
    const result = await manager.sendToPlugin(pluginId, method, args)
    return { result }
  })

  // Install a specific default plugin by ID (for marketplace).
  safeHandle(IpcChannel.PluginInstallDefault, async (_event, { pluginId } = {}) => {
    validatePluginId(pluginId)
    // After the apps/ migration the shell lives at `apps/shell/` and its
    // default plugins at `apps/shell/default-plugins/`. The pre-migration
    // path `electron/default-plugins` no longer exists — using it in a
    // packaged build would surface as "Plugin not found in default plugins"
    // for every marketplace install.
    const resourcesDir = getBundledPluginsDirectory()
    if (!fs.existsSync(resourcesDir)) {
      throw new Error(
        "This build does not include a bundled plugin catalog. Install the plugin from a trusted folder instead.",
      )
    }

    // Resolve + contain via the shared helper. validatePluginId already
    // precludes traversal via the id format; this is the second line of
    // defence so the file system layer can't see a path escaping the
    // default-plugins root.
    const sourcePath = assertPathContained(resourcesDir, pluginId, "Plugin path")
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Plugin ${pluginId} not found in default plugins`)
    }

    await whenPluginsReady()
    const manifest = await manager.installPlugin(sourcePath)
    await activateInstalledPlugin(manifest)
    return { manifest }
  })

  console.log("[plugin-ipc] Handlers registered")
}

/**
 * Install bundled defaults, then load every enabled plugin and wire its
 * events. Started once, after the first window; never rejects (a plugin that
 * fails to load is reported on that plugin, not as an app startup failure).
 */
function startPlugins() {
  pluginsReady ??= (async () => {
    try {
      await installDefaultPlugins()
    } catch (err) {
      console.error("[plugin-ipc] Bundled plugin install failed:", err)
    }
    try {
      manager.init()
      await manager.loadAllEnabled()
    } catch (err) {
      console.error("[plugin-ipc] Loading enabled plugins failed:", err)
    }
    // Event setup runs plugin code with a per-plugin deadline; do the
    // plugins side by side so one slow plugin does not hold up the others.
    await Promise.all(
      [...manager.plugins.keys()].map((id) =>
        setupEvents(id).catch((err) => {
          console.error(`[plugin-ipc] Failed to register events for ${id}:`, err)
        }),
      ),
    )
  })()
  return pluginsReady
}

/**
 * Called from the main process's uncaughtException handler. When the error's
 * stack points into a loaded plugin, that plugin is quarantined, unloaded and
 * disabled, and true is returned so the app keeps running.
 */
function handlePluginUncaughtException(error) {
  let pluginId = null
  try {
    pluginId = manager.containPluginFault(error)
  } catch {
    return false
  }
  if (!pluginId) return false
  console.error(
    `[plugin] ${pluginId} threw an uncaught error and was disabled:`,
    error?.stack || error,
  )
  // The plugin list reports it as an error with this message.
  return true
}

async function setupEvents(pluginId) {
  // Plugin events used to be pinned to the (single) `mainWindow`; that
  // dropped events for secondary windows opened via `WindowOpenWith`.
  // Broadcasting reaches every renderer; each renderer's plugin-store
  // filters by `pluginId` so unrelated windows just discard the frame.
  await manager.setupPluginEvents(pluginId, (event) => {
    broadcast(IpcEvent.PluginEvent, event)
  })
}

/** Kept as a no-op for back-compat with `main.cjs` callers — plugin
 *  events now go through `broadcast()` and dialog parents come from
 *  `BrowserWindow.getFocusedWindow()`. Safe to delete in a future
 *  cleanup pass once no caller imports it. */
function setPluginWindow(_win) {
  // intentional no-op
}

async function installDefaultPlugins() {
  const result = await manager.installDefaults(getBundledPluginsDirectory())
  if (!result.available) {
    console.info(
      "[plugin] No bundled plugin catalog is included in this build; folder installs remain available.",
    )
  }
  return result
}

function setPluginEncryptionKey(base64Key) {
  manager.setEncryptionKey(base64Key)
}

async function disposePlugins() {
  try {
    await manager.disposeAll()
  } finally {
    // Plugin host mode: end the host process and whatever it started.
    await pluginHost?.dispose()
  }
}

module.exports = {
  usePluginHost,
  registerPluginHandlers,
  startPlugins,
  handlePluginUncaughtException,
  setPluginWindow,
  installDefaultPlugins,
  setPluginEncryptionKey,
  disposePlugins,
}
