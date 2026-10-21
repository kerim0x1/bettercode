import { afterEach, describe, expect, it, vi } from "vitest"
import {
  MAX_TIMER_DELAY_MS,
  normalizeTurnLimits,
  TURN_IDLE_TIMEOUT_DEFAULT_MS,
  TURN_MAX_DURATION_DEFAULT_MS,
  TurnWatchdog,
  type TurnTimeoutKind,
} from "./turnLimits"

afterEach(() => {
  vi.useRealTimers()
})

describe("normalizeTurnLimits", () => {
  it("uses the defaults for unset, non-finite and non-positive values", () => {
    const defaults = {
      idleTimeoutMs: TURN_IDLE_TIMEOUT_DEFAULT_MS,
      maxDurationMs: TURN_MAX_DURATION_DEFAULT_MS,
    }
    expect(normalizeTurnLimits()).toEqual(defaults)
    expect(
      normalizeTurnLimits({ idleTimeoutMs: Number.NaN, maxDurationMs: 0 })
    ).toEqual(defaults)
    expect(
      normalizeTurnLimits({
        idleTimeoutMs: -5,
        maxDurationMs: Number.POSITIVE_INFINITY,
      })
    ).toEqual(defaults)
  })

  it("keeps delays inside the timer range and the ceiling above the idle limit", () => {
    expect(
      normalizeTurnLimits({ idleTimeoutMs: 1e12, maxDurationMs: 1e13 })
    ).toEqual({
      idleTimeoutMs: MAX_TIMER_DELAY_MS,
      maxDurationMs: MAX_TIMER_DELAY_MS,
    })
    expect(
      normalizeTurnLimits({ idleTimeoutMs: 60_000, maxDurationMs: 1_000 })
    ).toEqual({ idleTimeoutMs: 60_000, maxDurationMs: 60_000 })
    expect(normalizeTurnLimits({ idleTimeoutMs: 1_500.7 }).idleTimeoutMs).toBe(
      1_500
    )
  })
})

describe("TurnWatchdog", () => {
  function start(
    options: {
      idleTimeoutMs?: number
      maxDurationMs?: number
      isWaitingOnUser?: () => boolean
    } = {}
  ) {
    const timeouts: Array<{ kind: TurnTimeoutKind; limitMs: number }> = []
    const watchdog = new TurnWatchdog({
      idleTimeoutMs: options.idleTimeoutMs ?? 100,
      maxDurationMs: options.maxDurationMs ?? 10_000,
      isWaitingOnUser: options.isWaitingOnUser,
      onTimeout: (kind, limitMs) => timeouts.push({ kind, limitMs }),
    })
    return { watchdog, timeouts }
  }

  it("times out after the idle limit without activity", async () => {
    vi.useFakeTimers()
    const { timeouts } = start()
    await vi.advanceTimersByTimeAsync(99)
    expect(timeouts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(timeouts).toEqual([{ kind: "idle", limitMs: 100 }])
  })

  it("keeps a turn that stays active alive past the idle limit", async () => {
    vi.useFakeTimers()
    const { watchdog, timeouts } = start()
    for (let elapsed = 0; elapsed < 1_000; elapsed += 50) {
      await vi.advanceTimersByTimeAsync(50)
      watchdog.touch()
    }
    expect(timeouts).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(timeouts).toEqual([{ kind: "idle", limitMs: 100 }])
  })

  it("pauses the idle limit while the user is asked and restarts it afterwards", async () => {
    vi.useFakeTimers()
    let waiting = true
    const { timeouts } = start({ isWaitingOnUser: () => waiting })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(timeouts).toEqual([])
    waiting = false
    await vi.advanceTimersByTimeAsync(99)
    expect(timeouts).toEqual([])
    await vi.advanceTimersByTimeAsync(101)
    expect(timeouts).toEqual([{ kind: "idle", limitMs: 100 }])
  })

  it("ends the turn at the absolute ceiling whatever its activity", async () => {
    vi.useFakeTimers()
    const { watchdog, timeouts } = start({ maxDurationMs: 300 })
    for (let elapsed = 0; elapsed < 300; elapsed += 50) {
      await vi.advanceTimersByTimeAsync(50)
      watchdog.touch()
    }
    expect(timeouts).toEqual([{ kind: "max-duration", limitMs: 300 }])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(timeouts).toHaveLength(1)
  })

  it("never fires after stop", async () => {
    vi.useFakeTimers()
    const { watchdog, timeouts } = start({ maxDurationMs: 200 })
    watchdog.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(timeouts).toEqual([])
  })
})
