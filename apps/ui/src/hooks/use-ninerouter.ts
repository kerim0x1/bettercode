import { useCallback, useEffect, useRef, useState } from "react"
import type { NineRouterProviderView } from "@betterc0de/schema"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import { SETTINGS_UPDATED_EVENT } from "@/lib/settings-store"
import { getNineRouter } from "@/services/backend/providersApi"
import { NINEROUTER_UPDATED_EVENT } from "@/lib/ninerouter-providers"

// Per-viewer convenience: the last connection list lets the picker keep a
// stored 9Router selection while the first live request is still running.
const CACHE_KEY = "betterc0de:ninerouter-connections"

function readCachedView(): NineRouterProviderView | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      enabled?: unknown
      connections?: Array<{ id?: unknown; name?: unknown }>
    }
    if (!Array.isArray(parsed.connections)) return null
    return {
      enabled: parsed.enabled !== false,
      connections: parsed.connections.flatMap((entry) =>
        typeof entry.id === "string" && typeof entry.name === "string"
          ? [
              {
                id: entry.id,
                name: entry.name,
                baseUrl: "",
                dashboardUrl: "",
                enabled: true,
                tokenSaver: true,
                secret: { configured: false, storage: "encrypted" as const },
                customModels: [],
                hiddenModels: [],
                // "unknown" marks the models as not loaded yet.
                status: {
                  state: "unknown" as const,
                  message: null,
                  version: null,
                  latestVersion: null,
                  latencyMs: null,
                  modelCount: null,
                  checkedAt: null,
                },
                models: [],
              },
            ]
          : []
      ),
    }
  } catch {
    return null
  }
}

function writeCachedView(view: NineRouterProviderView): void {
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        enabled: view.enabled,
        connections: view.connections
          .filter((connection) => connection.enabled)
          .map(({ id, name }) => ({ id, name })),
      })
    )
  } catch {
    // Storage is optional.
  }
}

/**
 * The 9Router connections with their models, kept fresh on settings changes
 * and while the window is visible. The backend caches each router's model
 * list for five minutes, so polling here is cheap.
 */
export function useNineRouterView(active: boolean): {
  view: NineRouterProviderView | null
  reload: (refresh?: boolean) => Promise<void>
} {
  const [view, setView] = useState<NineRouterProviderView | null>(() =>
    typeof window === "undefined" ? null : readCachedView()
  )
  const generation = useRef(0)
  const reload = useCallback(async (refresh = false) => {
    const current = ++generation.current
    try {
      const next = await getNineRouter({ refresh })
      if (current !== generation.current) return
      setView(next)
      writeCachedView(next)
    } catch {
      // Keep the last known list: a backend restart must not empty the picker.
    }
  }, [])

  useEffect(() => {
    void reload()
    const onChange = () => void reload()
    window.addEventListener(SETTINGS_UPDATED_EVENT, onChange)
    window.addEventListener(NINEROUTER_UPDATED_EVENT, onChange)
    return () => {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onChange)
      window.removeEventListener(NINEROUTER_UPDATED_EVENT, onChange)
    }
  }, [reload])

  useVisibilityInterval(() => void reload(), 5 * 60_000, {
    enabled: active,
    runOnVisible: true,
  })

  return { view, reload }
}
