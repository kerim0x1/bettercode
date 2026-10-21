import { useCallback, useEffect, useState } from "react"
import {
  getProviderStatus,
  type ProviderStatus,
} from "@/services/backend/providersApi"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import { SETTINGS_UPDATED_EVENT } from "@/lib/settings-store"

const POLL_INTERVAL_MS = 30_000

/**
 * Live provider-status map keyed by `providerKind` (e.g. `"anthropic"`,
 * `"openai"`, `"lmstudio"`). Returns the snapshot plus a `refetch()`
 * for callers that want to force-update after a known mutation.
 *
 * Data is sourced from `GET /providers/status`; the backend assembles
 * `{provider, name, configured, authType, hint}` per registered adapter.
 *
 * The hook self-refreshes on three signals:
 *   - mount,
 *   - every 30 s while the window is visible (paused via
 *     `useVisibilityInterval` when the user switches away),
 *   - on the `betterc0de:settings-updated` DOM event the settings store
 *     dispatches after a successful `updateSettings()`.
 *
 * Last-known state is preserved on fetch failures — the model picker
 * doesn't suddenly disable a provider just because the backend HTTP
 * blip'd; staleness is preferred over false negatives.
 */
export function useProviderStatus(): {
  status: Map<string, ProviderStatus>
  refetch: () => void
} {
  const [status, setStatus] = useState<Map<string, ProviderStatus>>(
    () => new Map()
  )

  const refetch = useCallback(async () => {
    try {
      const list = await getProviderStatus()
      const next = new Map<string, ProviderStatus>()
      for (const item of list) next.set(item.provider, item)
      setStatus(next)
    } catch {
      // Keep last-known state — covers transient backend-not-ready,
      // sidecar restart, network blip. Never disable a provider just
      // because the status route 5xx'd for a moment.
    }
  }, [])

  useEffect(() => {
    void refetch()
  }, [refetch])

  useVisibilityInterval(() => {
    void refetch()
  }, POLL_INTERVAL_MS)

  useEffect(() => {
    const handler = () => {
      void refetch()
    }
    window.addEventListener(SETTINGS_UPDATED_EVENT, handler)
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, handler)
  }, [refetch])

  return { status, refetch: () => void refetch() }
}
