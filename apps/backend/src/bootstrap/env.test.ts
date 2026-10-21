import { afterEach, describe, expect, it, vi } from "vitest"
import { nonNegativeEnvCount, positiveEnvMs, readTuningEnv } from "./env"

const NAME = "BETTERC0DE_TEST_TUNING_VALUE"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("nonNegativeEnvCount", () => {
  it("accepts whole numbers including zero and an explicit unlimited", () => {
    vi.stubEnv(NAME, "0")
    expect(nonNegativeEnvCount(NAME)).toBe(0)
    vi.stubEnv(NAME, " 12 ")
    expect(nonNegativeEnvCount(NAME)).toBe(12)
    vi.stubEnv(NAME, "Unlimited")
    expect(nonNegativeEnvCount(NAME)).toBe(Number.POSITIVE_INFINITY)
    vi.stubEnv(NAME, "infinity")
    expect(nonNegativeEnvCount(NAME)).toBe(Number.POSITIVE_INFINITY)
  })

  it("rejects negative, fractional, non-numeric and oversized values", () => {
    for (const raw of ["-1", "1.5", "four", "1e3", "99999999999999999999"]) {
      vi.stubEnv(NAME, raw)
      expect(nonNegativeEnvCount(NAME), raw).toBeUndefined()
    }
    vi.stubEnv(NAME, "")
    expect(nonNegativeEnvCount(NAME)).toBeUndefined()
  })
})

describe("readTuningEnv", () => {
  it("reports a set but rejected value and falls back to the default", () => {
    const onInvalid = vi.fn()
    vi.stubEnv(NAME, "ten minutes")
    expect(readTuningEnv(NAME, positiveEnvMs, onInvalid)).toBeUndefined()
    expect(onInvalid).toHaveBeenCalledWith(NAME)
  })

  it("stays quiet for unset and accepted values", () => {
    const onInvalid = vi.fn()
    vi.stubEnv(NAME, "")
    expect(readTuningEnv(NAME, positiveEnvMs, onInvalid)).toBeUndefined()
    vi.stubEnv(NAME, "600000")
    expect(readTuningEnv(NAME, positiveEnvMs, onInvalid)).toBe(600_000)
    expect(onInvalid).not.toHaveBeenCalled()
  })
})
