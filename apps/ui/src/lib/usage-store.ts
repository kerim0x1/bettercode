import { create } from "zustand"
import { loadProviderUsage, type ProviderUsageReport } from "@/services/backend"

const REPORT_TTL_MS = 30_000

interface UsageState {
  reports: ProviderUsageReport[]
  loading: boolean
  error: string | null
  loadedAt: number
  load: (refresh?: boolean) => Promise<void>
}

let pending: Promise<void> | null = null

/** Keep reports across page navigation and coalesce StrictMode/refresh requests. */
export const useUsageStore = create<UsageState>((set, get) => ({
  reports: [],
  loading: false,
  error: null,
  loadedAt: 0,
  load(refresh = false) {
    if (pending) return pending
    if (
      !refresh &&
      get().loadedAt > 0 &&
      Date.now() - get().loadedAt < REPORT_TTL_MS
    )
      return Promise.resolve()
    set({ loading: true, error: null })
    pending = loadProviderUsage({ refresh })
      .then((reports) =>
        set({
          reports,
          loadedAt: reports.some((report) => report.status === "error")
            ? 0
            : Date.now(),
          error: null,
        })
      )
      .catch(() =>
        set({
          loadedAt: 0,
          error: "Could not update usage. Try refreshing again.",
        })
      )
      .finally(() => {
        pending = null
        set({ loading: false })
      })
    return pending
  },
}))
