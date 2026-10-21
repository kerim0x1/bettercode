import { create } from "zustand"
import { toast } from "sonner"
import { createLogger } from "@/lib/logger"
import { getElectronApi } from "@/services/ipc-facade"

const log = createLogger("plugins")

export interface PluginConfigField {
  key: string
  type: "string" | "secret" | "select" | "boolean" | "number"
  label: string
  default?: string
  placeholder?: string
  options?: string[]
}

export interface PluginModel {
  id: string
  name: string
  context: string
  tier: string
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author: string
  type: "provider"
  icon?: string
  config: PluginConfigField[]
  models: PluginModel[]
  entry: string
}

export interface InstalledPlugin {
  manifest: PluginManifest
  enabled: boolean
  config: Record<
    string,
    string | { configured: boolean; storage: "encrypted" | "plaintext" }
  >
  status: "active" | "error" | "disabled"
  error?: string | null
}

interface PluginState {
  plugins: InstalledPlugin[]
  loaded: boolean

  init: () => Promise<void>
  refresh: () => Promise<void>
  /** Resolves true once installed; a failure shows a toast with the reason. */
  installPlugin: (sourcePath?: string) => Promise<boolean>
  /** The actions below resolve false and show a toast when they fail. */
  removePlugin: (pluginId: string) => Promise<boolean>
  togglePlugin: (pluginId: string, enabled: boolean) => Promise<boolean>
  updateConfig: (
    pluginId: string,
    key: string,
    value: unknown
  ) => Promise<boolean>
}

const api = () => getElectronApi()

/** The `error` of a `{ ok: false }` envelope, or null when it succeeded. */
export function pluginEnvelopeError(result: unknown): string | null {
  if (!result || typeof result !== "object") return null
  const envelope = result as { ok?: unknown; error?: unknown }
  if (envelope.ok !== false) return null
  return typeof envelope.error === "string" && envelope.error.trim()
    ? envelope.error.trim()
    : "Unknown error"
}

/** Closing the folder picker or the install confirmation is not a failure. */
export function isCancelledPluginInstall(result: unknown): boolean {
  if (!result || typeof result !== "object") return false
  const envelope = result as { ok?: unknown; error?: unknown }
  if (envelope.ok !== false) return false
  return (
    envelope.error === undefined ||
    (typeof envelope.error === "string" && /cancel/i.test(envelope.error))
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pluginName(pluginId: string): string {
  return (
    usePluginStore
      .getState()
      .plugins.find((plugin) => plugin.manifest.id === pluginId)?.manifest
      .name || pluginId
  )
}

/**
 * Run a plugin IPC call that answers with an envelope. A rejection or
 * `{ ok: false }` shows `title` with the reason and resolves false.
 */
async function runPluginAction(
  title: string,
  call: () => Promise<unknown>
): Promise<boolean> {
  try {
    const error = pluginEnvelopeError(await call())
    if (error) {
      toast.error(title, { description: error })
      return false
    }
    return true
  } catch (error) {
    log.error(title, error)
    toast.error(title, { description: errorText(error) })
    return false
  }
}

export const usePluginStore = create<PluginState>((set, get) => ({
  plugins: [],
  loaded: false,

  init: async () => {
    if (get().loaded) return
    const bridge = api()
    if (!bridge?.pluginList) {
      set({ loaded: true })
      return
    }
    try {
      const list = await bridge.pluginList()
      set({ plugins: (list as InstalledPlugin[]) || [], loaded: true })
    } catch {
      set({ loaded: true })
    }
  },

  refresh: async () => {
    const bridge = api()
    if (!bridge?.pluginList) return
    try {
      const list = await bridge.pluginList()
      set({ plugins: (list as InstalledPlugin[]) || [] })
    } catch (err) {
      log.warn("Failed to refresh plugin list", err)
    }
  },

  installPlugin: async (sourcePath?: string) => {
    const bridge = api()
    if (!bridge?.pluginInstall) {
      log.warn(
        "electronAPI.pluginInstall not available — restart app if you just added plugin support"
      )
      // A toast rather than `alert()`: the native dialog blocks the renderer
      // and ignores the theme, and it is the last of the browser dialogs left
      // here — `prompt()` was worse, it simply throws in Electron.
      toast.error("Plugin system needs a restart", {
        description: "Close and reopen BetterC0de to finish enabling plugins.",
      })
      return false
    }
    try {
      const res = await bridge.pluginInstall(sourcePath || undefined)
      if (res?.ok) {
        await get().refresh()
        const name =
          res.manifest &&
          typeof res.manifest === "object" &&
          typeof (res.manifest as { name?: unknown }).name === "string"
            ? (res.manifest as { name: string }).name
            : null
        toast.success(name ? `Installed ${name}` : "Plugin installed")
        return true
      }
      if (isCancelledPluginInstall(res)) return false
      const reason = pluginEnvelopeError(res) ?? "No response from BetterC0de."
      log.error("Install failed:", reason)
      toast.error("Couldn't install the plugin", { description: reason })
      return false
    } catch (e) {
      log.error("Install error:", e)
      toast.error("Couldn't install the plugin", { description: errorText(e) })
      return false
    }
  },

  removePlugin: async (pluginId: string) => {
    const bridge = api()
    if (!bridge?.pluginRemove) return false
    const name = pluginName(pluginId)
    const removed = await runPluginAction(`Couldn't remove ${name}`, () =>
      bridge.pluginRemove(pluginId)
    )
    await get().refresh()
    return removed
  },

  togglePlugin: async (pluginId: string, enabled: boolean) => {
    const bridge = api()
    if (!bridge?.pluginToggle) return false
    const name = pluginName(pluginId)
    const toggled = await runPluginAction(
      enabled ? `Couldn't turn on ${name}` : `Couldn't turn off ${name}`,
      () => bridge.pluginToggle(pluginId, enabled)
    )
    // The desktop may have switched it back off after a failed activation.
    await get().refresh()
    return toggled
  },

  updateConfig: async (pluginId: string, key: string, value: unknown) => {
    const bridge = api()
    if (!bridge?.pluginConfigSet) return false
    const saved = await runPluginAction(
      `Couldn't save the ${pluginName(pluginId)} setting`,
      () => bridge.pluginConfigSet(pluginId, key, value)
    )
    // Reconcile from the main-process redacted response; never retain a newly
    // submitted secret in renderer state.
    await get().refresh()
    return saved
  },
}))
