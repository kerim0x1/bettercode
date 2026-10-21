import { describe, expect, it } from "vitest"
import {
  applyLimitReadings,
  describeCountdown,
  describeLimit,
  formatAgo,
  formatCountdown,
  limitPace,
  limitResetAt,
  limitStatus,
  limitTone,
  limitTrend,
  limitWindowMs,
  parseResetLabel,
  remainingPercent,
  resetLabelText,
  resetTimelineSpan,
  timelineLanes,
  TREND_WINDOW_MS,
} from "./limits"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (iso: string) => Date.parse(iso)

describe("remainingPercent", () => {
  it("turns the used share into a whole remaining share", () => {
    expect(remainingPercent({ usedPercent: 3 })).toBe(97)
    expect(remainingPercent({ usedPercent: 12.4 })).toBe(88)
  })

  it("stays inside 0..100 for out-of-range or missing values", () => {
    expect(remainingPercent({ usedPercent: 110 })).toBe(0)
    expect(remainingPercent({ usedPercent: -5 })).toBe(100)
    expect(remainingPercent({ usedPercent: Number.NaN })).toBe(100)
  })
})

describe("limitTone and limitStatus", () => {
  it("match the Usage page: getting close at 70% used, almost at 90%", () => {
    expect(limitTone(31)).toBe("normal")
    expect(limitTone(30)).toBe("low")
    expect(limitTone(11)).toBe("low")
    expect(limitTone(10)).toBe("critical")
    expect(limitTone(0)).toBe("critical")
    expect(limitStatus(31)).toBe("Available")
    expect(limitStatus(30)).toBe("Getting close")
    expect(limitStatus(10)).toBe("Almost at limit")
    expect(limitStatus(0)).toBe("Limit reached")
  })
})

describe("limitWindowMs", () => {
  it("reads the window length from Codex and Claude Code labels", () => {
    expect(limitWindowMs("5-hour limit")).toBe(5 * HOUR)
    expect(limitWindowMs("Weekly limit")).toBe(7 * DAY)
    expect(limitWindowMs("Current session")).toBe(5 * HOUR)
    expect(limitWindowMs("Current week (Opus)")).toBe(7 * DAY)
    expect(limitWindowMs("Monthly credits")).toBeNull()
  })
})

describe("limitPace", () => {
  const now = at("2026-10-15T12:00:00Z")
  const week = 7 * DAY

  it("says how far into the window a limit is and keeps a slow one", () => {
    expect(
      limitPace({
        usedPercent: 30,
        resetAt: now + 3.5 * DAY,
        windowMs: week,
        now,
      })
    ).toEqual({ elapsedPercent: 50, runsOutInMs: null })
  })

  it("projects when a fast rate uses the window up before the reset", () => {
    const pace = limitPace({
      usedPercent: 75,
      resetAt: now + 3.5 * DAY,
      windowMs: week,
      now,
    })
    expect(pace?.elapsedPercent).toBe(50)
    expect(pace?.runsOutInMs).toBeCloseTo((3.5 * DAY) / 3, -3)
  })

  it("projects nothing early in a window, and 0 once it is used up", () => {
    expect(
      limitPace({
        usedPercent: 20,
        resetAt: now + week - HOUR,
        windowMs: week,
        now,
      })?.runsOutInMs
    ).toBeNull()
    expect(
      limitPace({ usedPercent: 100, resetAt: now + DAY, windowMs: week, now })
        ?.runsOutInMs
    ).toBe(0)
  })

  it("needs a reset inside the window and a known length", () => {
    expect(
      limitPace({ usedPercent: 50, resetAt: null, windowMs: week, now })
    ).toBeNull()
    expect(
      limitPace({ usedPercent: 50, resetAt: now + DAY, windowMs: null, now })
    ).toBeNull()
    expect(
      limitPace({ usedPercent: 50, resetAt: now - MINUTE, windowMs: week, now })
    ).toBeNull()
    expect(
      limitPace({
        usedPercent: 50,
        resetAt: now + 8 * DAY,
        windowMs: week,
        now,
      })
    ).toBeNull()
  })
})

describe("formatCountdown", () => {
  it.each([
    [6 * DAY + 20 * HOUR + 12 * MINUTE, "6d 20h"],
    [HOUR + 44 * MINUTE + 30_000, "1h 44m"],
    [12 * MINUTE + 59_000, "12m"],
    [59_000, "<1m"],
    [0, "now"],
    [-5 * MINUTE, "now"],
  ])("formats %s ms as %s", (ms, text) => {
    expect(formatCountdown(ms)).toBe(text)
  })
})

describe("describeCountdown", () => {
  it("spells the countdown out for screen readers", () => {
    expect(describeCountdown(5 * DAY)).toBe("5 days")
    expect(describeCountdown(DAY + HOUR)).toBe("1 day 1 hour")
    expect(describeCountdown(HOUR + 44 * MINUTE)).toBe("1 hour 44 minutes")
    expect(describeCountdown(MINUTE)).toBe("1 minute")
    expect(describeCountdown(30_000)).toBe("less than a minute")
  })
})

describe("formatAgo", () => {
  it("counts seconds, then minutes, hours and days", () => {
    expect(formatAgo(2_000)).toBe("just now")
    expect(formatAgo(12_000)).toBe("12s ago")
    expect(formatAgo(3 * MINUTE + 5_000)).toBe("3 min ago")
    expect(formatAgo(2 * HOUR)).toBe("2 h ago")
    expect(formatAgo(3 * DAY)).toBe("3 d ago")
    expect(formatAgo(-1_000)).toBe("just now")
  })
})

describe("resetLabelText", () => {
  it("drops the leading resets word for the reset chip", () => {
    expect(resetLabelText("resets Sep 22, 7pm (Europe/Berlin)")).toBe(
      "Sep 22, 7pm (Europe/Berlin)"
    )
    expect(resetLabelText("Resets in 2h 14m")).toBe("in 2h 14m")
    expect(resetLabelText("Next week")).toBe("Next week")
  })
})

describe("parseResetLabel", () => {
  // 14:00 in Berlin (CEST, UTC+2).
  const reference = at("2026-10-15T12:00:00Z")

  it("reads the date and time Claude Code prints in its own zone", () => {
    expect(
      parseResetLabel(
        "resets Sep 22, 7pm (Europe/Berlin)",
        at("2026-09-20T10:00:00Z")
      )
    ).toBe(at("2026-09-22T17:00:00Z"))
    expect(
      parseResetLabel(
        "resets Sep 22, 3:59pm (Europe/Berlin)",
        at("2026-09-20T10:00:00Z")
      )
    ).toBe(at("2026-09-22T13:59:00Z"))
    expect(
      parseResetLabel("Resets Oct 21 at 9am (Europe/Berlin)", reference)
    ).toBe(at("2026-10-21T07:00:00Z"))
  })

  it("applies the zone's offset after a daylight-saving change", () => {
    // Berlin is back on CET (UTC+1) from 25 October 2026.
    expect(
      parseResetLabel("Resets Nov 2 at 9am (Europe/Berlin)", reference)
    ).toBe(at("2026-11-02T08:00:00Z"))
  })

  it("takes a bare time as its next occurrence after the reading", () => {
    expect(parseResetLabel("Resets 5pm (Europe/Berlin)", reference)).toBe(
      at("2026-10-15T15:00:00Z")
    )
    // 18:00 in Berlin: today's 5pm has passed, so it is tomorrow's.
    expect(
      parseResetLabel("Resets 5pm (Europe/Berlin)", at("2026-10-15T16:00:00Z"))
    ).toBe(at("2026-10-16T15:00:00Z"))
    expect(parseResetLabel("resets 17:30 (UTC)", reference)).toBe(
      at("2026-10-15T17:30:00Z")
    )
  })

  it("counts a relative reset from when it was printed", () => {
    expect(parseResetLabel("Resets in 2h 14m", reference)).toBe(
      reference + 2 * HOUR + 14 * MINUTE
    )
    expect(parseResetLabel("resets in 5 days", reference)).toBe(
      reference + 5 * DAY
    )
    expect(parseResetLabel("Resets in 3d 4h", reference)).toBe(
      reference + 3 * DAY + 4 * HOUR
    )
  })

  it("moves a date without a year into the nearest year", () => {
    expect(
      parseResetLabel(
        "Resets Jan 2 at 9am (Europe/Berlin)",
        at("2026-12-30T12:00:00Z")
      )
    ).toBe(at("2027-01-02T08:00:00Z"))
  })

  it("reads tomorrow and weekday forms", () => {
    expect(
      parseResetLabel("resets tomorrow at 9:30am (Europe/Berlin)", reference)
    ).toBe(at("2026-10-16T07:30:00Z"))
    // 15 October 2026 is a Thursday.
    expect(parseResetLabel("resets Mon 9am (Europe/Berlin)", reference)).toBe(
      at("2026-10-19T07:00:00Z")
    )
  })

  it("assumes local time for a zone the runtime does not know", () => {
    expect(
      parseResetLabel("Resets Oct 21 at 9am (Mars/Olympus)", reference)
    ).toBe(new Date(2026, 9, 21, 9, 0).getTime())
  })

  it("leaves ambiguous or unknown wording alone", () => {
    expect(parseResetLabel("resets soon", reference)).toBeNull()
    expect(
      parseResetLabel("Resets Oct 21 (Europe/Berlin)", reference)
    ).toBeNull()
    expect(parseResetLabel("resets in 2 months", reference)).toBeNull()
    expect(parseResetLabel("resets Feb 30 at 9am", reference)).toBeNull()
    expect(parseResetLabel("resets 13pm", reference)).toBeNull()
    expect(parseResetLabel("", reference)).toBeNull()
  })
})

describe("limitResetAt", () => {
  it("prefers the provider's exact reset instant", () => {
    expect(
      limitResetAt(
        { resetsAt: "2026-10-20T08:00:00.000Z", resetLabel: "Resets 5pm" },
        0
      )
    ).toBe(at("2026-10-20T08:00:00Z"))
  })

  it("falls back to the reset sentence, then to nothing", () => {
    const reference = at("2026-10-15T12:00:00Z")
    expect(
      limitResetAt(
        { resetsAt: null, resetLabel: "Resets in 1h 44m" },
        reference
      )
    ).toBe(reference + HOUR + 44 * MINUTE)
    expect(
      limitResetAt({ resetsAt: null, resetLabel: null }, reference)
    ).toBeNull()
  })
})

describe("describeLimit", () => {
  it("names the provider, the window, what is left and the reset", () => {
    expect(
      describeLimit({
        provider: "Claude",
        label: "Weekly limit",
        remaining: 94,
        resetInMs: 5 * DAY,
        resetLabel: null,
      })
    ).toBe("Claude weekly limit, 94% left, resets in 5 days")
  })

  it("adds the low state and falls back to the reset sentence", () => {
    expect(
      describeLimit({
        provider: "Codex",
        label: "5-hour limit",
        remaining: 3,
        resetInMs: null,
        resetLabel: "resets someday",
      })
    ).toBe("Codex 5-hour limit, 3% left, almost used up, resets someday")
    expect(
      describeLimit({
        provider: "Codex",
        label: "Weekly limit",
        remaining: 15,
        resetInMs: -MINUTE,
        resetLabel: null,
      })
    ).toBe("Codex weekly limit, 15% left, running low, reset time has passed")
  })
})

describe("limit readings and trend", () => {
  const now = at("2026-10-15T12:00:00Z")

  it("starts without a trend and keeps the object when nothing changed", () => {
    const first = applyLimitReadings(
      {},
      [{ provider: "claude", id: "session", remaining: 97 }],
      now
    )
    expect(first["claude:session"]).toEqual({
      remaining: 97,
      previous: null,
      changedAt: now,
    })
    expect(limitTrend(first["claude:session"], now)).toBeNull()
    const same = applyLimitReadings(
      first,
      [{ provider: "claude", id: "session", remaining: 97 }],
      now + MINUTE
    )
    expect(same).toBe(first)
  })

  it("points down after use and up after a reset", () => {
    const first = applyLimitReadings(
      {},
      [{ provider: "codex", id: "primary", remaining: 40 }],
      now
    )
    const used = applyLimitReadings(
      first,
      [{ provider: "codex", id: "primary", remaining: 37 }],
      now + MINUTE
    )
    expect(limitTrend(used["codex:primary"], now + MINUTE)).toBe("down")
    // A later identical poll keeps the change it last saw.
    const steady = applyLimitReadings(
      used,
      [{ provider: "codex", id: "primary", remaining: 37 }],
      now + 2 * MINUTE
    )
    expect(limitTrend(steady["codex:primary"], now + 2 * MINUTE)).toBe("down")
    const reset = applyLimitReadings(
      steady,
      [{ provider: "codex", id: "primary", remaining: 100 }],
      now + 3 * MINUTE
    )
    expect(limitTrend(reset["codex:primary"], now + 3 * MINUTE)).toBe("up")
  })

  it("drops the arrow once the change is old", () => {
    const reading = { remaining: 80, previous: 90, changedAt: now }
    expect(limitTrend(reading, now + TREND_WINDOW_MS)).toBe("down")
    expect(limitTrend(reading, now + TREND_WINDOW_MS + 1)).toBeNull()
  })

  it("forgets limits a provider stopped reporting but keeps silent providers", () => {
    const start = applyLimitReadings(
      {},
      [
        { provider: "claude", id: "session", remaining: 90 },
        { provider: "claude", id: "week", remaining: 70 },
        { provider: "codex", id: "primary", remaining: 50 },
      ],
      now
    )
    const next = applyLimitReadings(
      start,
      [{ provider: "claude", id: "session", remaining: 90 }],
      now + MINUTE
    )
    expect(Object.keys(next).sort()).toEqual([
      "claude:session",
      "codex:primary",
    ])
  })
})

describe("reset timeline", () => {
  it("looks a little past the last reset, between a day and a week", () => {
    expect(resetTimelineSpan(2 * HOUR)).toBe(DAY)
    expect(resetTimelineSpan(5 * DAY)).toBeCloseTo(5.4 * DAY)
    expect(resetTimelineSpan(30 * DAY)).toBe(7 * DAY)
  })

  it("moves close labels to other lanes and reuses lanes once there is room", () => {
    expect(timelineLanes([2, 5, 9, 40, 95], 4, 16)).toEqual([0, 1, 2, 0, 0])
    // Every lane taken: the one whose label is furthest left.
    expect(timelineLanes([1, 2, 3], 2, 16)).toEqual([0, 1, 0])
  })
})
