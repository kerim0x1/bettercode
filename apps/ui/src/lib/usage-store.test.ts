import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderUsageReport } from "@/services/backend"

vi.mock("@/services/backend", () => ({ loadProviderUsage: vi.fn() }))
import { loadProviderUsage } from "@/services/backend"
import { useUsageStore } from "./usage-store"

describe("usage page report loading", () => {
  const reports = [
    { provider: "claude", status: "ready" },
  ] as ProviderUsageReport[]
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    useUsageStore.setState({
      reports: [],
      loading: false,
      loadedAt: 0,
      error: null,
    })
    vi.mocked(loadProviderUsage).mockResolvedValue(reports)
  })
  afterEach(() => vi.useRealTimers())

  it("reopens from memory without issuing another request", async () => {
    await Promise.all([
      useUsageStore.getState().load(),
      useUsageStore.getState().load(),
    ])
    await useUsageStore.getState().load()
    expect(loadProviderUsage).toHaveBeenCalledTimes(1)
    expect(useUsageStore.getState().reports).toBe(reports)
    vi.advanceTimersByTime(30_001)
    await useUsageStore.getState().load()
    expect(loadProviderUsage).toHaveBeenCalledTimes(2)
  })

  it("keeps visible reports during refresh and after a failed update", async () => {
    await useUsageStore.getState().load()
    vi.mocked(loadProviderUsage).mockRejectedValueOnce(new Error("Offline"))
    const refresh = useUsageStore.getState().load(true)
    expect(useUsageStore.getState()).toMatchObject({ reports, loading: true })
    await refresh
    expect(useUsageStore.getState()).toMatchObject({
      reports,
      loading: false,
      error: expect.any(String),
    })
    expect(loadProviderUsage).toHaveBeenLastCalledWith({ refresh: true })
    await useUsageStore.getState().load()
    expect(useUsageStore.getState().error).toBeNull()
  })
})
