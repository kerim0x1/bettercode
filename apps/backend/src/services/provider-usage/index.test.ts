import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emptySummary, type ProviderUsageReport } from "./types"

vi.mock("./claude", () => ({
  collectClaudeUsage: vi.fn(),
  withClaudeLimits: vi.fn(),
}))
vi.mock("./codex", () => ({ collectCodexUsage: vi.fn() }))

import { collectClaudeUsage, withClaudeLimits } from "./claude"
import { collectCodexUsage } from "./codex"

const report = (
  provider: "claude" | "codex",
  source = "fixture"
): ProviderUsageReport => ({
  provider,
  label: provider,
  status: "ready",
  installed: true,
  authenticated: true,
  version: null,
  plan: null,
  source,
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

type Collect = (options: {
  dataDir: string | null
  refresh?: boolean
}) => Promise<ProviderUsageReport[]>

/** Asks again, as the page does, until the reports are no longer refreshing. */
async function settled(
  collect: Collect,
  dataDir: string | null
): Promise<ProviderUsageReport[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const reports = await collect({ dataDir })
    if (!reports.some((item) => item.refreshing)) return reports
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("The reports never settled.")
}

describe("provider usage reports", () => {
  let root = ""
  let profileA = ""
  let profileB = ""

  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-16T12:00:00.000Z"))
    root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-reports-"))
    profileA = path.join(root, "a")
    profileB = path.join(root, "b")
    fs.mkdirSync(profileA)
    fs.mkdirSync(profileB)
    vi.mocked(collectClaudeUsage).mockResolvedValue(report("claude"))
    vi.mocked(collectCodexUsage).mockResolvedValue(report("codex"))
    vi.mocked(withClaudeLimits).mockImplementation((item) => item)
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("waits only for the first read, then answers at once and reads again behind stale reports", async () => {
    const { collectProviderUsage } = await import("./index")
    const first = await collectProviderUsage({ dataDir: profileA })
    expect(first.map((item) => item.provider)).toEqual(["claude", "codex"])
    expect(first.some((item) => item.refreshing)).toBe(false)
    await collectProviderUsage({ dataDir: profileA })
    expect(collectClaudeUsage).toHaveBeenCalledTimes(1)
    expect(collectCodexUsage).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 30_001)
    const stale = await collectProviderUsage({ dataDir: profileA })
    expect(stale.map((item) => item.refreshing)).toEqual([true, true])
    expect(collectClaudeUsage).toHaveBeenCalledTimes(2)
    await settled(collectProviderUsage, profileA)
    expect(collectClaudeUsage).toHaveBeenCalledTimes(2)
  })

  it("answers the first request after a restart from the saved reports", async () => {
    const before = await import("./index")
    await before.collectProviderUsage({ dataDir: profileA })
    expect(fs.existsSync(path.join(profileA, "usage-reports.json"))).toBe(true)

    vi.resetModules()
    const after = await import("./index")
    let finish = () => {}
    vi.mocked(collectClaudeUsage).mockImplementationOnce(
      () =>
        new Promise<ProviderUsageReport>((resolve) => {
          finish = () => resolve(report("claude", "new read"))
        })
    )
    const restored = await after.collectProviderUsage({ dataDir: profileA })
    expect(restored.map((item) => item.source)).toEqual(["fixture", "fixture"])
    expect(restored.map((item) => item.refreshing)).toEqual([true, true])

    finish()
    const updated = await settled(after.collectProviderUsage, profileA)
    expect(updated[0]?.source).toBe("new read")
  })

  it("ignores a saved copy from another version", async () => {
    fs.writeFileSync(
      path.join(profileA, "usage-reports.json"),
      JSON.stringify({ version: 0, reports: [report("claude", "old")] })
    )
    const { collectProviderUsage } = await import("./index")
    const reports = await collectProviderUsage({ dataDir: profileA })
    expect(reports[0]?.source).toBe("fixture")
    expect(reports.some((item) => item.refreshing)).toBe(false)
  })

  it("coalesces overlapping refreshes and isolates profiles", async () => {
    const { collectProviderUsage } = await import("./index")
    await collectProviderUsage({ dataDir: profileA })
    await Promise.all([
      collectProviderUsage({ dataDir: profileA, refresh: true }),
      collectProviderUsage({ dataDir: profileA, refresh: true }),
    ])
    expect(collectClaudeUsage).toHaveBeenCalledTimes(2)
    expect(collectClaudeUsage).toHaveBeenLastCalledWith({
      dataDir: profileA,
      refresh: true,
    })
    await collectProviderUsage({ dataDir: profileB })
    expect(collectClaudeUsage).toHaveBeenCalledTimes(3)
  })

  it("adds Claude's current limits to every answer", async () => {
    vi.mocked(withClaudeLimits).mockImplementation((item) => ({
      ...item,
      limits: [
        {
          id: "week",
          label: "Current week",
          usedPercent: 40,
          resetsAt: null,
          resetLabel: null,
        },
      ],
      refreshing: true,
    }))
    const { collectProviderUsage } = await import("./index")
    const reports = await collectProviderUsage({
      dataDir: profileA,
      refresh: true,
    })
    expect(withClaudeLimits).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "claude" }),
      { dataDir: profileA, refresh: true }
    )
    expect(reports[0]).toMatchObject({ refreshing: true })
    expect(reports[0]?.limits).toHaveLength(1)
    expect(reports[1]?.refreshing).toBeUndefined()
  })

  it("returns the healthy provider when another fails, without a read per poll", async () => {
    const { collectProviderUsage } = await import("./index")
    vi.mocked(collectClaudeUsage).mockRejectedValueOnce(
      new Error("Store unavailable")
    )
    const reports = await collectProviderUsage({ dataDir: profileA })
    expect(reports[0]).toMatchObject({
      status: "error",
      error: "Store unavailable",
    })
    expect(reports[1]?.status).toBe("ready")
    expect(fs.existsSync(path.join(profileA, "usage-reports.json"))).toBe(false)

    const again = await collectProviderUsage({ dataDir: profileA })
    expect(again[0]?.refreshing).toBeUndefined()
    expect(collectClaudeUsage).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 10_001)
    await collectProviderUsage({ dataDir: profileA })
    const retried = await settled(collectProviderUsage, profileA)
    expect(retried[0]?.status).toBe("ready")
    expect(collectClaudeUsage).toHaveBeenCalledTimes(2)
  })
})
