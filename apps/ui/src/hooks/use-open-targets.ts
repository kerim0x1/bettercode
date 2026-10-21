/**
 * Fetches which external "Open in" tools are installed (backend
 * GET /git/open-targets, cached server-side for 5 minutes).
 *
 * A module-level in-flight promise + result cache means the right-panel
 * header and the chat toolbar share ONE request per session instead of
 * probing twice. On fetch failure we fall back to the historic static
 * set so the menu degrades to the old behavior instead of going empty.
 */

import { useCallback, useEffect, useState } from "react"
import { getOpenTargets, type OpenTarget } from "@/services/backend/gitApi"

const FALLBACK_TARGETS: OpenTarget[] = [
  { id: "cursor", label: "Cursor", group: "editor", available: true },
  { id: "vscode", label: "VS Code", group: "editor", available: true },
  { id: "zed", label: "Zed", group: "editor", available: true },
  { id: "explorer", label: "File Explorer", group: "system", available: true },
]

let cached: OpenTarget[] | null = null
let inFlight: Promise<OpenTarget[]> | null = null

function fetchTargets(refresh: boolean): Promise<OpenTarget[]> {
  if (!refresh && cached) return Promise.resolve(cached)
  if (!refresh && inFlight) return inFlight
  const request = getOpenTargets({ refresh })
    .then((res) => {
      cached = res?.targets?.length ? res.targets : FALLBACK_TARGETS
      return cached
    })
    .catch(() => {
      cached = cached ?? FALLBACK_TARGETS
      return cached
    })
    .finally(() => {
      inFlight = null
    })
  inFlight = request
  return request
}

export function useOpenTargets(enabled: boolean): {
  targets: OpenTarget[] | null
  loading: boolean
  refresh: () => void
} {
  const [targets, setTargets] = useState<OpenTarget[] | null>(cached)

  useEffect(() => {
    if (!enabled || targets) return
    let cancelled = false
    void fetchTargets(false).then((result) => {
      if (!cancelled) setTargets(result)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, targets])

  const refresh = useCallback(() => {
    void fetchTargets(true).then(setTargets)
  }, [])

  return { targets, loading: enabled && targets === null, refresh }
}
