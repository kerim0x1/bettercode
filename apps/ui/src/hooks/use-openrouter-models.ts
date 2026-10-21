import { useEffect, useRef } from "react"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import { SETTINGS_UPDATED_EVENT } from "@/lib/settings-store"
import { getSettings } from "@/services/backend/coreApi"
import {
  listOpenRouterModels,
  type OpenRouterLiveModel,
} from "@/services/backend/providersApi"

// Mirrors use-lm-studio-models: the backend owns the network call (and a 6h
// catalog cache); this hook only polls the local endpoint while an OpenRouter
// context is active. `null` state means "no live data" — the picker keeps its
// curated fallback entries. Without a configured OpenRouter key the backend
// answers `not_configured` and no external traffic ever happens.

/**
 * Variant matching {@link useLmStudioModelsSync}'s shape: the caller owns the
 * state, this hook manages the polling.
 */
export function useOpenRouterModelsSync(
  active: boolean,
  setModels: React.Dispatch<React.SetStateAction<OpenRouterLiveModel[] | null>>
) {
  // Latest-active guard so an in-flight fetch resolving after the picker
  // closed doesn't stamp stale data back onto state.
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  useVisibilityInterval(
    async () => {
      try {
        const result = await listOpenRouterModels()
        if (!activeRef.current) return
        setModels(result.data && result.data.length > 0 ? result.data : null)
      } catch {
        if (activeRef.current) setModels(null)
      }
    },
    // The backend cache holds 6h; this cadence only bounds how long an
    // already-open session waits for a refresh.
    30 * 60_000,
    { enabled: active, runOnVisible: true }
  )
}

/**
 * The user-entered model ids from Settings → Providers → OpenRouter →
 * Custom models, kept fresh via the same `betterc0de:settings-updated`
 * DOM event the settings store dispatches after every successful PATCH —
 * an id added in Settings shows up in the picker without a reload.
 */
export function useOpenRouterCustomModelsSync(
  setCustomModels: React.Dispatch<React.SetStateAction<string[]>>
) {
  useEffect(() => {
    let disposed = false
    const load = async () => {
      try {
        const settings = await getSettings()
        const providers = (settings?.providers ?? {}) as Record<
          string,
          { custom_models?: unknown } | undefined
        >
        const raw = providers.openrouter?.custom_models
        const list = Array.isArray(raw)
          ? raw.filter(
              (item): item is string =>
                typeof item === "string" && item.trim().length > 0
            )
          : []
        if (!disposed) setCustomModels(list)
      } catch {
        // Keep last-known state — a settings blip must not empty the picker.
      }
    }
    void load()
    const onUpdated = () => void load()
    window.addEventListener(SETTINGS_UPDATED_EVENT, onUpdated)
    return () => {
      disposed = true
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onUpdated)
    }
  }, [setCustomModels])
}
