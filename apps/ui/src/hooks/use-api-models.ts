import { useCallback, useEffect, useRef, useState } from "react"
import { listModels } from "@/services/backend/providersApi"
import { SETTINGS_UPDATED_EVENT } from "@/lib/settings-store"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"

type ApiModels = Awaited<ReturnType<typeof listModels>>

/** The backend owns credentials, timeouts, account scoping and the cache. */
export function useApiModels(): ApiModels | null {
  const [models, setModels] = useState<ApiModels | null>(null)
  const requestId = useRef(0)
  const refresh = useCallback(() => {
    const currentRequest = ++requestId.current
    void listModels()
      .then((next) => {
        if (currentRequest === requestId.current) setModels(next)
      })
      .catch(() => {
        // Keep the last good snapshot during a temporary transport outage.
      })
  }, [])

  useEffect(() => {
    refresh()
    const onSettingsUpdated = () => {
      // Settings may have switched API accounts. Hide the previous account's
      // models until the new catalog has been loaded.
      setModels(null)
      refresh()
    }
    window.addEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    return () => {
      requestId.current += 1
      window.removeEventListener(SETTINGS_UPDATED_EVENT, onSettingsUpdated)
    }
  }, [refresh])
  useVisibilityInterval(refresh, 15 * 60_000)
  return models
}
