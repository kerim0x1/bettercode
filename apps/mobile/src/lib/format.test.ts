import { describe, expect, it } from "vitest"
import {
  formatBytes,
  formatDateTime,
  formatDay,
  formatShortDateTime,
  formatTime,
} from "./format"

const WHEN = "2026-09-24T14:05:00.000Z"

describe("formatting in the device's locale", () => {
  it("follows the locale it is given instead of a fixed one", () => {
    const us = formatDateTime(WHEN, "en-US")
    const de = formatDateTime(WHEN, "de-DE")
    expect(us).not.toBe(de)
    expect(us).toContain("2026")
    expect(formatShortDateTime(WHEN, "en-US")).not.toContain("2026")
    expect(formatTime(WHEN, "en-US")).toMatch(/\d{1,2}:\d{2}/)
    expect(formatDay(WHEN, "en-US")).toMatch(/Sep/)
  })

  it("says so for a missing or broken date instead of 'Invalid Date'", () => {
    expect(formatDateTime(undefined)).toBe("–")
    expect(formatDateTime("not a date")).toBe("–")
    expect(formatTime("")).toBe("")
  })

  it("shows sizes with a unit", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2_048)).toBe("2.0 KB")
    expect(formatBytes(50_000)).toBe("49 KB")
    expect(formatBytes(3 * 1024 ** 2)).toBe("3.0 MB")
    expect(formatBytes(null)).toBe("")
  })
})
