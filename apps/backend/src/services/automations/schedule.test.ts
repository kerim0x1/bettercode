import {
  automationInputSchema,
  automationOnceInPast,
  automationScheduleProblem,
  cronRunsTooOften,
  describeAutomationSchedule,
  nextAutomationRun,
  nextCronOccurrence,
  parseCronExpression,
  upcomingAutomationRuns,
  type CronExpression,
} from "@betterc0de/schema"
import { describe, expect, it } from "vitest"

// Schedules are in the desktop's local time, so every date here is built and
// read in local time, and none falls near a daylight-saving change.

function cron(expression: string): CronExpression {
  const parsed = parseCronExpression(expression)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.cron
}

function local(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

describe("parseCronExpression", () => {
  it("reads numbers, ranges, steps, lists and names", () => {
    const parsed = cron("*/15 9-17 1,15 JAN-MAR mon-fri")
    expect([...parsed.minutes]).toEqual([0, 15, 30, 45])
    expect([...parsed.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect([...parsed.daysOfMonth]).toEqual([1, 15])
    expect([...parsed.months]).toEqual([1, 2, 3])
    expect([...parsed.daysOfWeek]).toEqual([1, 2, 3, 4, 5])
    expect(parsed.dayOfMonthRestricted).toBe(true)
    expect(parsed.dayOfWeekRestricted).toBe(true)
  })

  it("reads 7 as Sunday and a/n as a to the end of the field", () => {
    expect([...cron("0 0 * * 7").daysOfWeek]).toEqual([0])
    expect([...cron("10/20 * * * *").minutes]).toEqual([10, 30, 50])
  })

  it("expands the shorthands", () => {
    expect([...cron("@daily").hours]).toEqual([0])
    expect([...cron("@weekly").daysOfWeek]).toEqual([0])
    expect([...cron("@hourly").minutes]).toEqual([0])
  })

  it.each([
    ["", "Enter a cron expression."],
    ["* * * *", "5 fields"],
    ["60 * * * *", "minute"],
    ["* 24 * * *", "hour"],
    ["*/0 * * * *", "step"],
    ["5-1 * * * *", "backwards"],
    ["* * * FOO *", "month"],
    ["@reboot", "shorthand"],
    ["1,,2 * * * *", "minute"],
  ])("refuses %j", (expression, message) => {
    const parsed = parseCronExpression(expression)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain(message)
  })
})

describe("nextCronOccurrence", () => {
  it("finds the next weekday morning after a Friday", () => {
    // 2026-06-12 is a Friday; the next weekday is Monday the 15th.
    expect(
      nextCronOccurrence(cron("30 9 * * 1-5"), local(2026, 6, 12, 10, 0))
    ).toEqual(local(2026, 6, 15, 9, 30))
  })

  it("is strictly after the given moment", () => {
    expect(
      nextCronOccurrence(cron("*/15 * * * *"), local(2026, 6, 15, 10, 15))
    ).toEqual(local(2026, 6, 15, 10, 30))
    expect(
      nextCronOccurrence(
        cron("*/15 * * * *"),
        new Date(local(2026, 6, 15, 10, 7).getTime() + 30_000)
      )
    ).toEqual(local(2026, 6, 15, 10, 15))
  })

  it("matches day of month or day of week when both are restricted", () => {
    // The 13th, or any Friday: Friday the 5th of June 2026 comes first.
    expect(
      nextCronOccurrence(cron("0 0 13 * 5"), local(2026, 6, 1, 0, 0))
    ).toEqual(local(2026, 6, 5, 0, 0))
  })

  it("rolls over months and years", () => {
    expect(
      nextCronOccurrence(cron("0 0 1 * *"), local(2026, 12, 15, 12, 0))
    ).toEqual(local(2027, 1, 1, 0, 0))
    expect(
      nextCronOccurrence(cron("0 12 29 2 *"), local(2026, 3, 1, 0, 0))
    ).toEqual(local(2028, 2, 29, 12, 0))
  })

  it("answers null for a date that never comes", () => {
    expect(nextCronOccurrence(cron("0 0 30 2 *"), local(2026, 1, 1))).toBe(null)
  })
})

describe("cronRunsTooOften", () => {
  it.each([
    ["*/5 * * * *", false],
    ["*/4 * * * *", true],
    ["* * * * *", true],
    ["0,58 * * * *", true],
    ["0,58 9 * * *", false],
    ["0 * * * *", false],
  ])("%s → %s", (expression, expected) => {
    expect(cronRunsTooOften(cron(expression))).toBe(expected)
  })
})

describe("automationScheduleProblem", () => {
  it("keeps intervals at five minutes or more", () => {
    expect(
      automationScheduleProblem({ kind: "interval", every: 4, unit: "minutes" })
    ).toContain("5 minutes")
    expect(
      automationScheduleProblem({ kind: "interval", every: 5, unit: "minutes" })
    ).toBeNull()
    expect(
      automationScheduleProblem({ kind: "interval", every: 1, unit: "hours" })
    ).toBeNull()
  })

  it("checks daily times, weekdays and cron expressions", () => {
    expect(
      automationScheduleProblem({ kind: "daily", time: "25:00", weekdays: [1] })
    ).not.toBeNull()
    expect(
      automationScheduleProblem({ kind: "daily", time: "09:00", weekdays: [] })
    ).toContain("day")
    expect(
      automationScheduleProblem({ kind: "cron", expression: "*/2 * * * *" })
    ).toContain("5 minutes")
    expect(
      automationScheduleProblem({ kind: "cron", expression: "0 0 30 2 *" })
    ).toBe("This expression never runs.")
    expect(
      automationScheduleProblem({ kind: "cron", expression: "0 9 * * 1-5" })
    ).toBeNull()
  })
})

describe("nextAutomationRun", () => {
  const anchor = local(2026, 6, 15, 10, 0)

  it("counts intervals from the anchor", () => {
    const every15 = { kind: "interval", every: 15, unit: "minutes" } as const
    expect(nextAutomationRun(every15, anchor, anchor)).toEqual(
      local(2026, 6, 15, 10, 15)
    )
    expect(
      nextAutomationRun(every15, local(2026, 6, 15, 10, 20), anchor)
    ).toEqual(local(2026, 6, 15, 10, 30))
    // A late run does not shift the next ones.
    expect(
      nextAutomationRun(every15, local(2026, 6, 15, 10, 31), anchor)
    ).toEqual(local(2026, 6, 15, 10, 45))
  })

  it("runs daily schedules on the chosen weekdays only", () => {
    // Monday and Wednesday at 08:00; from Monday 08:00 the next is Wednesday.
    expect(
      nextAutomationRun(
        { kind: "daily", time: "08:00", weekdays: [1, 3] },
        local(2026, 6, 15, 8, 0),
        anchor
      )
    ).toEqual(local(2026, 6, 17, 8, 0))
  })

  it("runs a one-time schedule once", () => {
    const at = local(2026, 6, 16, 9, 0)
    const once = { kind: "once", at: at.toISOString() } as const
    expect(nextAutomationRun(once, anchor, anchor)).toEqual(at)
    expect(nextAutomationRun(once, at, anchor)).toBeNull()
    expect(automationOnceInPast(once, anchor)).toBe(false)
    expect(automationOnceInPast(once, at)).toBe(true)
  })

  it("lists upcoming runs", () => {
    expect(
      upcomingAutomationRuns(
        { kind: "cron", expression: "0 9 * * *" },
        local(2026, 6, 15, 10, 0),
        anchor,
        3
      )
    ).toEqual([
      local(2026, 6, 16, 9, 0),
      local(2026, 6, 17, 9, 0),
      local(2026, 6, 18, 9, 0),
    ])
  })
})

describe("describeAutomationSchedule", () => {
  it("names schedules in plain words", () => {
    expect(
      describeAutomationSchedule({
        kind: "interval",
        every: 15,
        unit: "minutes",
      })
    ).toBe("Every 15 minutes")
    expect(
      describeAutomationSchedule({ kind: "interval", every: 1, unit: "hours" })
    ).toBe("Every hour")
    expect(
      describeAutomationSchedule({
        kind: "daily",
        time: "09:00",
        weekdays: [5, 1, 2, 3, 4],
      })
    ).toBe("Weekdays at 09:00")
    expect(
      describeAutomationSchedule({
        kind: "daily",
        time: "07:30",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      })
    ).toBe("Every day at 07:30")
    expect(
      describeAutomationSchedule({
        kind: "daily",
        time: "18:00",
        weekdays: [1, 3],
      })
    ).toBe("Mon, Wed at 18:00")
    expect(
      describeAutomationSchedule({ kind: "cron", expression: " 0 9 * * * " })
    ).toBe("Cron 0 9 * * *")
  })
})

describe("automationInputSchema", () => {
  const base = {
    name: "  Nightly triage  ",
    projectPath: "/work/project",
    prompt: "Look at the open issues.",
    providerKind: "codex",
    providerInstanceId: null,
    modelId: "gpt-5.5",
    modelSelection: null,
    reasoningEffort: null,
    permissionLevel: "ask-on-edit",
    runLocation: "local",
    trigger: {
      type: "schedule",
      schedule: { kind: "cron", expression: "0 9 * * 1-5" },
    },
    enabled: true,
  }

  it("accepts a complete automation and trims its name", () => {
    expect(automationInputSchema.parse(base).name).toBe("Nightly triage")
  })

  it("refuses schedules that run too often, never, or are malformed", () => {
    for (const schedule of [
      { kind: "interval", every: 4, unit: "minutes" },
      { kind: "cron", expression: "*/2 * * * *" },
      { kind: "cron", expression: "0 0 30 2 *" },
      { kind: "daily", time: "9:00", weekdays: [1] },
      { kind: "once", at: "tomorrow" },
    ]) {
      expect(
        automationInputSchema.safeParse({
          ...base,
          trigger: { type: "schedule", schedule },
        }).success,
        JSON.stringify(schedule)
      ).toBe(false)
    }
  })

  it("refuses unknown fields, permission presets and short secrets", () => {
    expect(
      automationInputSchema.safeParse({ ...base, extra: true }).success
    ).toBe(false)
    expect(
      automationInputSchema.safeParse({ ...base, permissionLevel: "root" })
        .success
    ).toBe(false)
    expect(
      automationInputSchema.safeParse({
        ...base,
        trigger: { type: "webhook", verifyGithubSignature: true },
        webhookSecret: "short",
      }).success
    ).toBe(false)
  })
})
