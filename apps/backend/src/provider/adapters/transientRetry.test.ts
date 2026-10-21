import { describe, expect, it, vi } from "vitest"
import { retryAfterMs, withTransientRetry } from "./transientRetry"

function options(overrides: Record<string, unknown> = {}) {
  const sleep = vi.fn(
    async (_ms: number, _signal?: AbortSignal): Promise<void> => undefined
  )
  return {
    sleep,
    options: { sleep, random: () => 0.5, ...overrides },
  }
}

describe("withTransientRetry", () => {
  it.each([429, 500, 503, 529])(
    "retries a %s response on the same key with growing backoff",
    async (status) => {
      const { sleep, options: retryOptions } = options()
      const attempt = vi
        .fn<(started: () => void) => Promise<string>>()
        .mockRejectedValueOnce({ status })
        .mockRejectedValueOnce({ status })
        .mockResolvedValueOnce("ok")

      await expect(
        withTransientRetry(attempt, undefined, retryOptions)
      ).resolves.toBe("ok")
      expect(attempt).toHaveBeenCalledTimes(3)
      // 2s then 4s steps, jittered into the upper half (random 0.5 -> 75%).
      expect(sleep.mock.calls.map((call) => call[0])).toEqual([1_500, 3_000])
    }
  )

  it("treats an overloaded_error body as transient", async () => {
    const { options: retryOptions } = options()
    const attempt = vi
      .fn<(started: () => void) => Promise<string>>()
      .mockRejectedValueOnce({ error: { error: { type: "overloaded_error" } } })
      .mockResolvedValueOnce("ok")
    await expect(
      withTransientRetry(attempt, undefined, retryOptions)
    ).resolves.toBe("ok")
  })

  it("gives up after the attempt budget so the pool can fail over", async () => {
    const { options: retryOptions } = options()
    const attempt = vi.fn(async () => {
      throw { status: 529 }
    })
    await expect(
      withTransientRetry(attempt, undefined, retryOptions)
    ).rejects.toMatchObject({ status: 529 })
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it("does not retry authentication, quota or request errors", async () => {
    for (const status of [400, 401, 402, 403]) {
      const { sleep, options: retryOptions } = options()
      const attempt = vi.fn(async () => {
        throw { status }
      })
      await expect(
        withTransientRetry(attempt, undefined, retryOptions)
      ).rejects.toMatchObject({ status })
      expect(attempt).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
    }
  })

  it("never retries after output was streamed", async () => {
    const started = vi.fn()
    const { options: retryOptions } = options()
    const attempt = vi.fn(async (markStarted: () => void) => {
      markStarted()
      throw { status: 529 }
    })
    await expect(
      withTransientRetry(attempt, started, retryOptions)
    ).rejects.toMatchObject({ status: 529 })
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(started).toHaveBeenCalledTimes(1)
  })

  it("waits for a short Retry-After and hands a long one to the key pool", async () => {
    const short = options()
    const shortAttempt = vi
      .fn<(started: () => void) => Promise<string>>()
      .mockRejectedValueOnce({ status: 429, headers: { "retry-after": "7" } })
      .mockResolvedValueOnce("ok")
    await expect(
      withTransientRetry(shortAttempt, undefined, short.options)
    ).resolves.toBe("ok")
    expect(short.sleep).toHaveBeenCalledWith(7_000, undefined)

    const long = options()
    const longAttempt = vi.fn(async () => {
      throw {
        status: 429,
        headers: new Headers({ "retry-after": "3600" }),
      }
    })
    await expect(
      withTransientRetry(longAttempt, undefined, long.options)
    ).rejects.toMatchObject({ status: 429 })
    expect(longAttempt).toHaveBeenCalledTimes(1)
    expect(long.sleep).not.toHaveBeenCalled()
  })

  it("stops retrying once the turn is cancelled", async () => {
    const controller = new AbortController()
    const { options: retryOptions } = options({ signal: controller.signal })
    const attempt = vi.fn(async () => {
      controller.abort()
      throw { status: 503 }
    })
    await expect(
      withTransientRetry(attempt, undefined, retryOptions)
    ).rejects.toMatchObject({ status: 503 })
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it("aborts a pending backoff with the default sleep", async () => {
    const controller = new AbortController()
    const attempt = vi.fn(async () => {
      throw { status: 503 }
    })
    const pending = withTransientRetry(attempt, undefined, {
      signal: controller.signal,
      baseDelayMs: 60_000,
    })
    // Let the first failure reach the backoff before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(attempt).toHaveBeenCalledTimes(1)
    controller.abort(new Error("stopped"))
    await expect(pending).rejects.toThrow("stopped")
  })
})

describe("retryAfterMs", () => {
  it("reads millisecond, second and date forms", () => {
    const now = Date.parse("2026-01-01T00:00:00Z")
    expect(retryAfterMs({ headers: { "retry-after-ms": "250" } }, now)).toBe(
      250
    )
    expect(retryAfterMs({ headers: { "retry-after": "2" } }, now)).toBe(2_000)
    expect(
      retryAfterMs(
        { headers: { "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" } },
        now
      )
    ).toBe(5_000)
    expect(retryAfterMs({ headers: {} }, now)).toBeNull()
    expect(retryAfterMs(new Error("no headers"), now)).toBeNull()
  })
})
