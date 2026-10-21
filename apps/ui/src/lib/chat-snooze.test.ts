import { describe, expect, it } from "vitest"
import {
  formatSnoozeTime,
  nextSnoozeWake,
  parseSnoozeInput,
  restoreSnoozes,
  snoozeChats,
  snoozeInputValues,
  snoozePresetTime,
  snoozeStatus,
  unsnoozeChats,
  type SnoozedChat,
} from "./chat-snooze"

// Tuesday 20 October 2026, 14:30 local time.
const NOW = new Date(2026, 9, 20, 14, 30, 0, 0)

function entry(overrides: Partial<SnoozedChat> = {}): SnoozedChat {
  return {
    thread_id: "t1",
    until: new Date(2026, 9, 21, 9, 0).toISOString(),
    since: NOW.toISOString(),
    ...overrides,
  }
}

describe("snooze presets", () => {
  it("wakes after one or three hours", () => {
    expect(snoozePresetTime("1h", NOW).getTime() - NOW.getTime()).toBe(
      60 * 60 * 1000
    )
    expect(snoozePresetTime("3h", NOW).getTime() - NOW.getTime()).toBe(
      3 * 60 * 60 * 1000
    )
  })

  it("wakes tomorrow at 9:00 and next Monday at 9:00", () => {
    const tomorrow = snoozePresetTime("tomorrow", NOW)
    expect([
      tomorrow.getDate(),
      tomorrow.getHours(),
      tomorrow.getMinutes(),
    ]).toEqual([21, 9, 0])
    const monday = snoozePresetTime("next-week", NOW)
    expect(monday.getDay()).toBe(1)
    expect([monday.getDate(), monday.getHours()]).toEqual([26, 9])
  })

  it("picks the Monday a week later on a Monday, and tomorrow on a Sunday", () => {
    const onMonday = snoozePresetTime("next-week", new Date(2026, 9, 26, 8))
    expect([onMonday.getMonth(), onMonday.getDate()]).toEqual([10, 2])
    const onSunday = snoozePresetTime("next-week", new Date(2026, 9, 25, 20))
    expect(onSunday.getDate()).toBe(26)
  })
})

describe("snooze times", () => {
  it("names today, tomorrow, the weekday and later dates", () => {
    expect(formatSnoozeTime(new Date(2026, 9, 20, 18, 5), NOW, "en-GB")).toBe(
      "Today 18:05"
    )
    expect(formatSnoozeTime(new Date(2026, 9, 21, 9, 0), NOW, "en-GB")).toBe(
      "Tomorrow 09:00"
    )
    expect(formatSnoozeTime(new Date(2026, 9, 23, 9, 0), NOW, "en-GB")).toBe(
      "Fri 09:00"
    )
    expect(formatSnoozeTime(new Date(2026, 10, 12, 9, 0), NOW, "en-GB")).toBe(
      "12 Nov, 09:00"
    )
  })

  it("reads the custom dialog's date and time inputs", () => {
    const value = parseSnoozeInput("2026-10-22", "07:45")
    expect(value?.getFullYear()).toBe(2026)
    expect(value?.getMonth()).toBe(9)
    expect(value?.getDate()).toBe(22)
    expect(value?.getHours()).toBe(7)
    expect(value?.getMinutes()).toBe(45)
    expect(parseSnoozeInput("2026-02-31", "09:00")).toBeNull()
    expect(parseSnoozeInput("", "09:00")).toBeNull()
    expect(parseSnoozeInput("2026-10-22", "25:00")).toBeNull()
    expect(snoozeInputValues(new Date(2026, 0, 5, 8, 3))).toEqual({
      date: "2026-01-05",
      time: "08:03",
    })
  })
})

describe("snooze status", () => {
  const quiet = {
    updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    running: false,
    waiting: false,
  }

  it("stays away until its time", () => {
    expect(snoozeStatus(entry(), quiet, NOW.getTime())).toBe("snoozed")
    const due = new Date(2026, 9, 21, 9, 0).getTime()
    expect(snoozeStatus(entry(), quiet, due)).toBe("back")
  })

  it("comes back early on a new message, a request or a finished turn", () => {
    const later = new Date(NOW.getTime() + 5 * 60_000).toISOString()
    expect(
      snoozeStatus(entry(), { ...quiet, updatedAt: later }, NOW.getTime())
    ).toBe("back")
    expect(
      snoozeStatus(entry(), { ...quiet, waiting: true }, NOW.getTime())
    ).toBe("back")
    expect(snoozeStatus(entry({ running: true }), quiet, NOW.getTime())).toBe(
      "back"
    )
    // Still running: stays away.
    expect(
      snoozeStatus(
        entry({ running: true }),
        { ...quiet, running: true },
        NOW.getTime()
      )
    ).toBe("snoozed")
  })

  it("treats an unreadable time as due", () => {
    expect(snoozeStatus(entry({ until: "soon" }), quiet, NOW.getTime())).toBe(
      "back"
    )
  })
})

describe("snooze edits", () => {
  it("snoozes, replacing an earlier snooze of the same chat", () => {
    const until = new Date(2026, 9, 21, 9, 0)
    const first = snoozeChats([], ["t1", "t2"], until, NOW, new Set(["t2"]))
    expect(first).toEqual([
      {
        thread_id: "t1",
        until: until.toISOString(),
        since: NOW.toISOString(),
      },
      {
        thread_id: "t2",
        until: until.toISOString(),
        since: NOW.toISOString(),
        running: true,
      },
    ])
    const later = new Date(2026, 9, 26, 9, 0)
    const again = snoozeChats(first, ["t1"], later, NOW)
    expect(again.map((item) => item.thread_id)).toEqual(["t2", "t1"])
    expect(again[1]!.until).toBe(later.toISOString())
  })

  it("unsnoozes and restores what was there for undo", () => {
    const entries = [entry({ thread_id: "a" }), entry({ thread_id: "b" })]
    expect(unsnoozeChats(entries, ["x"])).toBe(entries)
    const woken = unsnoozeChats(entries, ["a"])
    expect(woken.map((item) => item.thread_id)).toEqual(["b"])
    const restored = restoreSnoozes(woken, ["a"], entries)
    expect(restored.map((item) => item.thread_id).sort()).toEqual(["a", "b"])
    // Undo of a new snooze removes it again.
    const snoozed = snoozeChats(entries, ["c"], new Date(2026, 9, 22), NOW)
    expect(
      restoreSnoozes(snoozed, ["c"], entries).map((item) => item.thread_id)
    ).toEqual(["a", "b"])
    expect(restoreSnoozes(entries, ["x"], [])).toBe(entries)
  })

  it("finds the next wake time in the future", () => {
    const soon = new Date(NOW.getTime() + 60_000).toISOString()
    const past = new Date(NOW.getTime() - 60_000).toISOString()
    expect(
      nextSnoozeWake(
        [
          entry({ until: past }),
          entry({ until: soon }),
          entry({ until: "bad" }),
        ],
        NOW.getTime()
      )
    ).toBe(Date.parse(soon))
    expect(nextSnoozeWake([entry({ until: past })], NOW.getTime())).toBeNull()
  })
})
