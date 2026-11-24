import { create } from "zustand"
import {
  loadProviderUsage,
  type ProviderUsageReport,
} from "@/services/backend/coreApi"

const REPORT_TTL_MS = 30_000
/** While the backend reads newer reports behind its answer, ask this often. */
const FOLLOW_UP_MS = 1_000
/** A read that never settles stops being asked about after two minutes. */
const MAX_FOLLOW_UPS = 120

interface UsageState {
  reports: ProviderUsageReport[]
  loading: boolean
  /** The backend is reading newer reports than the ones shown. */
  refreshing: boolean
  error: string | null
  loadedAt: number
  load: (refresh?: boolean) => Promise<void>
}

let pending: Promise<void> | null = null
let followUp: ReturnType<typeof setTimeout> | null = null
let followUps = 0

function cancelFollowUp(): void {
  if (followUp !== null) clearTimeout(followUp)
  followUp = null
}

/**
 * Keep reports across page navigation and coalesce StrictMode/refresh
 * requests. The backend answers at once with the reports it has and flags
 * them `refreshing` while it reads newer ones (or Claude's limits), so the
 * store asks again each second until they are in.
 */
export const useUsageStore = create<UsageState>((set, get) => {
  const request = (refresh: boolean): Promise<void> => {
    cancelFollowUp()
    set({ loading: true, error: null })
    pending = loadProviderUsage({ refresh })
      .then((reports) => {
        const refreshing = reports.some((report) => report.refreshing === true)
        set({
          reports,
          refreshing,
          loadedAt: reports.some((report) => report.status === "error")
            ? 0
            : Date.now(),
          error: null,
        })
        if (!refreshing || followUps >= MAX_FOLLOW_UPS) {
          followUps = 0
          if (refreshing) set({ refreshing: false })
          return
        }
        followUps += 1
        followUp = setTimeout(() => {
          followUp = null
          if (!pending) void request(false)
        }, FOLLOW_UP_MS)
      })
      .catch(() => {
        followUps = 0
        set({
          loadedAt: 0,
          refreshing: false,
          error: "Could not update usage. Try refreshing again.",
        })
      })
      .finally(() => {
        pending = null
        set({ loading: false })
      })
    return pending
  }

  return {
    reports: [],
    loading: false,
    refreshing: false,
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
      followUps = 0
      return request(refresh)
    },
  }
})
