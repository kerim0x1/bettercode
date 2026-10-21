import { describe, expect, it } from "vitest"
import type { ProviderUsageReport } from "@/services/backend/coreApi"
import {
  activityStreaks,
  dailySeries,
  dayRows,
  formatMoney,
  formatShare,
  modelRows,
  providerTotals,
  rangeDays,
  usageTotals,
} from "./usage-overview"

function report(
  partial: Partial<ProviderUsageReport> & Pick<ProviderUsageReport, "provider">
): ProviderUsageReport {
  return {
    label: partial.provider,
    status: "ready",
    installed: true,
    authenticated: true,
    version: null,
    plan: null,
    source: "",
    fetchedAt: "2026-10-15T12:00:00.000Z",
    scannedMs: 0,
    summary: {
      totalTokens: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      peakDayTokens: 0,
      peakDayDate: null,
      longestSessionMs: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      sessions: 0,
      messages: 0,
      activeDays: 0,
      firstActivity: null,
      lastActivity: null,
      cost: null,
    },
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
    ...partial,
  }
}

const now = new Date("2026-10-15T15:00:00").getTime()

const claude = report({
  provider: "claude",
  daily: [
    { date: "2026-09-01", tokens: 900, messages: 0, sessions: 1 },
    { date: "2026-10-14", tokens: 300, messages: 0, sessions: 2, cost: 6 },
    { date: "2026-10-15", tokens: 100, messages: 0, sessions: 1, cost: 2 },
  ],
  pricing: {
    currency: "USD",
    total: 40,
    breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    pricedTokens: 0,
    unpricedTokens: 0,
    unpricedModels: [],
    hasOverrides: false,
    notes: [],
    cacheSavings: 12,
  },
  models: [
    { id: "claude-opus-5", label: "claude-opus-5", value: 1000, cost: 30 },
    { id: "claude-haiku-4-5", label: "claude-haiku-4-5", value: 300, cost: 10 },
  ],
})
const codex = report({
  provider: "codex",
  daily: [
    { date: "2026-10-15", tokens: 600, messages: 0, sessions: 3, cost: 2 },
  ],
  models: [{ id: "gpt-6-sol", label: "gpt-6-sol", value: 600 }],
})

describe("rangeDays", () => {
  it("ends today and counts calendar days", () => {
    const days = rangeDays([claude], 7, now)
    expect(days).toHaveLength(7)
    expect(days.at(0)).toBe("2026-10-09")
    expect(days.at(-1)).toBe("2026-10-15")
  })

  it("starts All at the first day any report has", () => {
    expect(rangeDays([codex, claude], null, now).at(0)).toBe("2026-09-01")
  })
})

describe("dailySeries", () => {
  it("gives every day a value per provider, 0 where nothing was recorded", () => {
    const rows = dailySeries(
      [claude, codex],
      ["2026-10-13", "2026-10-15"],
      "cost"
    )
    expect(rows).toEqual([
      { date: "2026-10-13", claude: 0, codex: 0 },
      { date: "2026-10-15", claude: 2, codex: 2 },
    ])
    expect(dailySeries([codex], ["2026-10-15"], "tokens")).toEqual([
      { date: "2026-10-15", codex: 600 },
    ])
  })
})

describe("providerTotals", () => {
  it("sums a range and counts days that recorded tokens without a cost", () => {
    const days = new Set(rangeDays([claude], 90, now))
    expect(providerTotals(claude, days)).toEqual({
      provider: "claude",
      cost: 8,
      tokens: 1300,
      sessions: 4,
      unpricedDays: 1,
    })
  })

  it("uses the all-time totals for All", () => {
    expect(providerTotals(claude, null).cost).toBe(40)
  })

  it("keeps cost unknown for a provider without rates", () => {
    expect(providerTotals(report({ provider: "codex" }), new Set()).cost).toBe(
      null
    )
  })
})

describe("modelRows", () => {
  it("ranks every provider's models by cost with their share", () => {
    const rows = modelRows([claude, codex], "cost")
    expect(rows.map((row) => row.label)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5",
      "gpt-6-sol",
    ])
    expect(rows[0].share).toBeCloseTo(0.75)
    expect(rows[2].cost).toBeNull()
  })

  it("ranks by tokens in the Tokens view", () => {
    expect(modelRows([claude, codex], "tokens").at(1)?.label).toBe("gpt-6-sol")
  })
})

describe("dayRows", () => {
  it("lists active days newest first with their share of the range", () => {
    const rows = dayRows([claude, codex], rangeDays([], 7, now), "tokens")
    expect(rows.map((row) => row.date)).toEqual(["2026-10-15", "2026-10-14"])
    expect(rows[0]).toMatchObject({ cost: 4, tokens: 700, sessions: 4 })
    expect(rows[0].share).toBeCloseTo(0.7)
  })
})

describe("usageTotals", () => {
  it("adds the token split and the cache savings that are reported", () => {
    expect(usageTotals([claude, codex]).cacheSavings).toBe(12)
    expect(usageTotals([codex]).cacheSavings).toBeNull()
  })
})

describe("formats", () => {
  it("writes money and shares the way the tables show them", () => {
    expect(formatMoney(9833.47)).toBe("$9,833.47")
    expect(formatMoney(0.004)).toBe("<$0.01")
    expect(formatShare(0.332)).toBe("33.2%")
    expect(formatShare(0.0004)).toBe("<0.1%")
  })
})

describe("activityStreaks", () => {
  it("counts the current run back from today and keeps the longest", () => {
    const points = (dates: string[]) =>
      dates.map((date) => ({ date, tokens: 1, messages: 0, sessions: 1 }))
    const reports = [
      report({
        provider: "claude",
        daily: points(["2026-09-01", "2026-09-02", "2026-09-03", "2026-10-14"]),
      }),
      report({ provider: "codex", daily: points(["2026-10-13"]) }),
    ]
    // Today (10-15) is quiet, so the run ending yesterday still counts.
    expect(activityStreaks(reports, now)).toEqual({
      current: 2,
      longest: 3,
      longestEnd: "2026-09-03",
    })
  })
})
