import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderUsageReport } from "@/services/backend/coreApi"

vi.mock("@/services/backend/coreApi", () => ({
  loadProviderUsage: vi.fn(),
}))
import { loadProviderUsage } from "@/services/backend/coreApi"
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
      refreshing: false,
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

  it("asks again while the backend reads newer reports behind its answer", async () => {
    const stale = [
      { provider: "claude", status: "ready", refreshing: true },
    ] as ProviderUsageReport[]
    vi.mocked(loadProviderUsage)
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(reports)

    await useUsageStore.getState().load(true)
    expect(useUsageStore.getState()).toMatchObject({
      reports: stale,
      refreshing: true,
      loading: false,
    })
    expect(loadProviderUsage).toHaveBeenLastCalledWith({ refresh: true })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(loadProviderUsage).toHaveBeenCalledTimes(2)
    // Follow-ups pick up the running read; they never start another one.
    expect(loadProviderUsage).toHaveBeenLastCalledWith({ refresh: false })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(loadProviderUsage).toHaveBeenCalledTimes(3)
    expect(useUsageStore.getState()).toMatchObject({
      reports,
      refreshing: false,
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(loadProviderUsage).toHaveBeenCalledTimes(3)
  })

  it("stops asking again after a failed follow-up", async () => {
    vi.mocked(loadProviderUsage)
      .mockResolvedValueOnce([
        { provider: "claude", status: "ready", refreshing: true },
      ] as ProviderUsageReport[])
      .mockRejectedValueOnce(new Error("Offline"))

    await useUsageStore.getState().load()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(useUsageStore.getState()).toMatchObject({
      refreshing: false,
      error: expect.any(String),
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(loadProviderUsage).toHaveBeenCalledTimes(2)
  })
})
