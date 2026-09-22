import { describe, expect, it } from "vitest"
import { parseLimits } from "./claude"
import {
  addDay,
  countMax,
  localDay,
  percent,
  streaks,
  summarize,
  topEntries,
} from "./shared"
import { emptyTokenBreakdown } from "./types"

type DayMap = Map<
  string,
  { tokens: number; messages: number; sessions: number }
>

function daysBefore(count: number): string {
  const date = new Date()
  date.setDate(date.getDate() - count)
  return localDay(date)
}

describe("streaks", () => {
  it("counts a run that ends today", () => {
    expect(streaks([daysBefore(0), daysBefore(1), daysBefore(2)])).toEqual({
      current: 3,
      longest: 3,
    })
  })

  it("keeps yesterday's streak alive before today is worked on", () => {
    expect(streaks([daysBefore(1), daysBefore(2)])).toEqual({
      current: 2,
      longest: 2,
    })
  })

  it("stops the current streak at the first missing day", () => {
    const runs = streaks([daysBefore(0), daysBefore(2), daysBefore(3)])
    expect(runs.current).toBe(1)
    expect(runs.longest).toBe(2)
  })

  it("ignores duplicates and unordered input", () => {
    expect(
      streaks(["2026-03-02", "2026-03-01", "2026-03-02", "2026-03-03"]).longest
    ).toBe(3)
  })
})

describe("summarize", () => {
  it("totals tokens and finds the peak day among days that used tokens", () => {
    const daily: DayMap = new Map()
    addDay(daily, "2026-03-01", { tokens: 10, messages: 2, sessions: 1 })
    addDay(daily, "2026-03-02", { tokens: 40, messages: 1, sessions: 1 })
    addDay(daily, "2026-03-03", { tokens: 0, messages: 0, sessions: 1 })
    const summary = summarize({
      daily,
      tokens: emptyTokenBreakdown(),
      sessions: 3,
      messages: 3,
      longestSessionMs: 900_000,
    })
    expect(summary.totalTokens).toBe(50)
    expect(summary.peakDayDate).toBe("2026-03-02")
    expect(summary.peakDayTokens).toBe(40)
    // A day with sessions but no tokens is still an active day.
    expect(summary.activeDays).toBe(3)
    expect(summary.firstActivity).toBe("2026-03-01")
    expect(summary.lastActivity).toBe("2026-03-03")
  })

  it("reports no peak when nothing used tokens", () => {
    const daily: DayMap = new Map()
    addDay(daily, "2026-03-01", { sessions: 1 })
    const summary = summarize({
      daily,
      tokens: emptyTokenBreakdown(),
      sessions: 1,
      messages: 0,
      longestSessionMs: 0,
    })
    expect(summary.peakDayDate).toBeNull()
    expect(summary.totalTokens).toBe(0)
  })
})

describe("topEntries and countMax", () => {
  it("ranks by value and reports each share", () => {
    const counts = new Map([
      ["vercel", 30],
      ["other", 10],
      ["unused", 0],
    ])
    const entries = topEntries(counts)
    expect(entries.map((entry) => entry.id)).toEqual(["vercel", "other"])
    expect(entries[0]?.share).toBeCloseTo(0.75)
  })

  it("returns the dominant key with its share", () => {
    expect(
      countMax(
        new Map([
          ["xhigh", 3],
          ["high", 1],
        ])
      )
    ).toEqual({
      key: "xhigh",
      value: 3,
      share: 0.75,
    })
    expect(countMax(new Map())).toBeNull()
  })
})

describe("percent", () => {
  it("rounds above ten and keeps one decimal below", () => {
    expect(percent(0.639)).toBe("64%")
    expect(percent(0.054)).toBe("5.4%")
    expect(percent(0)).toBe("0%")
  })
})

describe("parseLimits", () => {
  const raw = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 9% used · resets Sep 22, 7pm (Europe/Berlin)",
    "Current week (all models): 81% used · resets Sep 22, 4pm (Europe/Berlin)",
    "Current week (Fable): 100% used · resets Sep 22, 3:59pm (Europe/Berlin)",
    "",
    "What's contributing to your limits usage?",
    "Last 24h · 957 requests · 10 sessions",
    "  94% of your usage was at >150k context",
  ].join("\n")

  it("reads every window with its reset text", () => {
    const parsed = parseLimits(raw)
    expect(parsed.limits.map((limit) => limit.label)).toEqual([
      "Current session",
      "Current week (all models)",
      "Current week (Fable)",
    ])
    expect(parsed.limits[1]?.usedPercent).toBe(81)
    expect(parsed.limits[0]?.resetLabel).toBe(
      "resets Sep 22, 7pm (Europe/Berlin)"
    )
  })

  it("keeps the plan line and the contribution block apart", () => {
    const parsed = parseLimits(raw)
    expect(parsed.plan).toBe("Subscription")
    // Indentation is preserved so the renderer can nest the detail lines.
    expect(parsed.contributions).toEqual([
      "Last 24h · 957 requests · 10 sessions",
      "  94% of your usage was at >150k context",
    ])
  })

  it("survives output without any percentages", () => {
    expect(parseLimits("Nothing to report").limits).toEqual([])
  })
})
