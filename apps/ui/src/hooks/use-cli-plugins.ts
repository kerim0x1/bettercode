import { useCallback, useEffect, useRef, useState } from "react"
import type { CliPlugin, CliPluginInventory } from "@betterc0de/schema"
import { refreshProviderInstance } from "@/services/backend/providersApi"
import { getElectronApi } from "@/services/ipc-facade"

export type CliPluginMutation = "toggle" | "install" | "uninstall"

/**
 * Inventory of plugins installed in the user's Claude Code CLI and Codex
 * CLI, fetched over the `cliPlugin:*` IPC channels. Distinct from
 * BetterC0de's own provider-plugin store (`use-providers` / plugin-store).
 *
 * After a successful mutation the affected provider instance is refreshed
 * on the backend so skill/command snapshots (e.g. the `$`-picker) update
 * without an app restart.
 */
export function useCliPlugins() {
  const [inventory, setInventory] = useState<CliPluginInventory | null>(null)
  const [available, setAvailable] = useState<{
    claude: CliPlugin[]
    codex: CliPlugin[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [availableLoading, setAvailableLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mutating, setMutating] = useState<string | null>(null)
  const aliveRef = useRef(true)

  const refresh = useCallback(async (force = false) => {
    const fetcher = getElectronApi()?.cliPluginInventory
    if (!fetcher) {
      setError("CLI plugin inventory is unavailable in this environment.")
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const result = await fetcher({ force })
      if (!aliveRef.current) return
      setInventory(result ?? null)
      setError(null)
    } catch (err) {
      if (!aliveRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [])

  const loadAvailable = useCallback(async () => {
    const fetcher = getElectronApi()?.cliPluginAvailable
    if (!fetcher) return
    setAvailableLoading(true)
    try {
      const result = await fetcher()
      if (!aliveRef.current) return
      setAvailable(result ?? { claude: [], codex: [] })
    } catch {
      if (aliveRef.current) setAvailable({ claude: [], codex: [] })
    } finally {
      if (aliveRef.current) setAvailableLoading(false)
    }
  }, [])

  const refreshProviderSnapshot = useCallback((source: "claude" | "codex") => {
    // Backend instance ids match the provider kinds for the builtin CLIs.
    void refreshProviderInstance(source).catch(() => {
      // Snapshot refresh is best-effort; the 30s TTL catches up anyway.
    })
  }, [])

  const mutate = useCallback(
    async (
      mutation: CliPluginMutation,
      source: "claude" | "codex",
      id: string,
      enabled?: boolean
    ): Promise<{ ok: boolean; error?: string }> => {
      const apiSurface = getElectronApi()
      if (!apiSurface) return { ok: false, error: "Electron API unavailable" }
      const call =
        mutation === "toggle"
          ? apiSurface.cliPluginToggle?.(source, id, enabled === true)
          : mutation === "install"
            ? apiSurface.cliPluginInstall?.(source, id)
            : apiSurface.cliPluginUninstall?.(source, id)
      if (!call) return { ok: false, error: "Operation unavailable" }
      setMutating(`${source}:${id}`)
      try {
        const result = await call
        if (result?.ok && result.inventory && aliveRef.current) {
          setInventory(result.inventory)
        }
        if (result?.ok) {
          refreshProviderSnapshot(source)
          if (mutation !== "toggle") void loadAvailable()
        }
        return { ok: result?.ok === true, error: result?.error }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      } finally {
        if (aliveRef.current) setMutating(null)
      }
    },
    [loadAvailable, refreshProviderSnapshot]
  )

  useEffect(() => {
    aliveRef.current = true
    void refresh(false)
    return () => {
      aliveRef.current = false
    }
  }, [refresh])

  return {
    inventory,
    available,
    loading,
    availableLoading,
    error,
    mutating,
    refresh,
    loadAvailable,
    mutate,
  }
}
