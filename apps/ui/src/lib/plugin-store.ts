import { create } from "zustand"
import { toast } from "sonner"
import { createLogger } from "@/lib/logger"

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
  installPlugin: (sourcePath?: string) => Promise<boolean>
  removePlugin: (pluginId: string) => Promise<void>
  togglePlugin: (pluginId: string, enabled: boolean) => Promise<void>
  updateConfig: (pluginId: string, key: string, value: unknown) => Promise<void>
}

const api = () => window.electronAPI

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
        return true
      }
      if (res?.error) log.error("Install failed:", res.error)
      return false
    } catch (e) {
      log.error("Install error:", e)
      return false
    }
  },

  removePlugin: async (pluginId: string) => {
    const bridge = api()
    if (!bridge?.pluginRemove) return
    await bridge.pluginRemove(pluginId)
    await get().refresh()
  },

  togglePlugin: async (pluginId: string, enabled: boolean) => {
    const bridge = api()
    if (!bridge?.pluginToggle) return
    await bridge.pluginToggle(pluginId, enabled)
    await get().refresh()
  },

  updateConfig: async (pluginId: string, key: string, value: unknown) => {
    const bridge = api()
    if (!bridge?.pluginConfigSet) return
    await bridge.pluginConfigSet(pluginId, key, value)
    // Reconcile from the main-process redacted response; never retain a newly
    // submitted secret in renderer state.
    await get().refresh()
  },
}))
