import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emptySummary, type ProviderUsageReport } from "./types"

vi.mock("./claude", () => ({ collectClaudeUsage: vi.fn() }))
vi.mock("./codex", () => ({ collectCodexUsage: vi.fn() }))

import { collectClaudeUsage } from "./claude"
import { collectCodexUsage } from "./codex"

const report = (provider: "claude" | "codex"): ProviderUsageReport => ({
  provider,
  label: provider,
  status: "ready",
  installed: true,
  authenticated: true,
  version: null,
  plan: null,
  source: "fixture",
  fetchedAt: new Date().toISOString(),
  scannedMs: 0,
  summary: emptySummary(),
  daily: [],
  pricing: null,
  pricesFile: null,
  models: [],
  insights: [],
  lists: [],
  limits: [],
  limitsObservedAt: null,
  limitNotes: [],
  notes: [],
})

describe("provider report cache", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.mocked(collectClaudeUsage).mockResolvedValue(report("claude"))
    vi.mocked(collectCodexUsage).mockResolvedValue(report("codex"))
  })
  afterEach(() => vi.useRealTimers())

  it("only collects Claude and Codex and reuses recent reports", async () => {
    const { collectProviderUsage } = await import("./index")
    const first = await collectProviderUsage({ dataDir: "profile-a" })
    expect(first.map((item) => item.provider)).toEqual(["claude", "codex"])
    expect(await collectProviderUsage({ dataDir: "profile-a" })).toBe(first)
    expect(collectClaudeUsage).toHaveBeenCalledTimes(1)
    expect(collectCodexUsage).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_001)
    await collectProviderUsage({ dataDir: "profile-a" })
    expect(collectClaudeUsage).toHaveBeenCalledTimes(2)
  })

  it("coalesces overlapping refreshes and isolates profiles", async () => {
    const { collectProviderUsage } = await import("./index")
    await collectProviderUsage({ dataDir: "profile-a" })
    await Promise.all([
      collectProviderUsage({ dataDir: "profile-a", refresh: true }),
      collectProviderUsage({ dataDir: "profile-a", refresh: true }),
    ])
    expect(collectClaudeUsage).toHaveBeenCalledTimes(2)
    expect(collectClaudeUsage).toHaveBeenLastCalledWith({
      dataDir: "profile-a",
      refresh: true,
    })
    await collectProviderUsage({ dataDir: "profile-b" })
    expect(collectClaudeUsage).toHaveBeenCalledTimes(3)
  })

  it("returns the healthy provider when another fails and retries errors", async () => {
    const { collectProviderUsage } = await import("./index")
    vi.mocked(collectClaudeUsage).mockRejectedValueOnce(
      new Error("Store unavailable")
    )
    const reports = await collectProviderUsage({ dataDir: null })
    expect(reports[0]).toMatchObject({
      status: "error",
      error: "Store unavailable",
    })
    expect(reports[1]?.status).toBe("ready")
    const retry = await collectProviderUsage({ dataDir: null })
    expect(retry[0]?.status).toBe("ready")
    expect(collectClaudeUsage).toHaveBeenCalledTimes(2)
  })
})
