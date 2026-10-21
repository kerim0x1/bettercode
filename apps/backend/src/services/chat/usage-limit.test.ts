import { describe, expect, it } from "vitest"
import {
  limitKindFromText,
  mergeProviderLimits,
  normalizeResetInstant,
  providerLimitFromError,
  providerLimitFromTurnError,
  resetAtFromRateLimits,
  resetAtFromText,
  retryAtFromHeaders,
} from "./usage-limit"

const now = Date.parse("2026-10-20T10:00:00Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe("providerLimitFromTurnError: Claude Code", () => {
  it("reads the reset from the older `limit reached|epoch` message", () => {
    expect(
      providerLimitFromTurnError(
        { error: "Claude AI usage limit reached|1792501200" },
        now
      )
    ).toEqual({ kind: "usage", resetAt: Date.parse("2026-10-20T13:00:00Z") })
  })

  it("reads a reset time in the zone the message names", () => {
    expect(
      providerLimitFromTurnError(
        { error: "You've hit your limit · resets 3pm (Europe/Berlin)" },
        now
      )
    ).toEqual({ kind: "usage", resetAt: Date.parse("2026-10-20T13:00:00Z") })
    expect(
      providerLimitFromTurnError(
        {
          error:
            "5-hour limit reached ∙ resets 7pm (America/New_York)\n/upgrade to increase your usage limit.",
        },
        now
      )
    ).toEqual({ kind: "usage", resetAt: Date.parse("2026-10-20T23:00:00Z") })
    expect(
      providerLimitFromTurnError(
        {
          error:
            "Claude usage limit reached. Your limit will reset at 3pm (Europe/Berlin).",
        },
        now
      )
    ).toEqual({ kind: "usage", resetAt: Date.parse("2026-10-20T13:00:00Z") })
  })

  it("prefers the rate-limit event the adapter attached", () => {
    expect(
      providerLimitFromTurnError(
        {
          error: "Claude SDK reported a failure",
          detail: { limit: { kind: "usage", resetAt: 1792501200 } },
        },
        now
      )
    ).toEqual({ kind: "usage", resetAt: Date.parse("2026-10-20T13:00:00Z") })
  })

  it("knows a usage limit without a reset time", () => {
    expect(
      providerLimitFromTurnError(
        { error: "Claude AI usage limit reached|1000000000" },
        now
      )
    ).toEqual({ kind: "usage", resetAt: null })
  })
})

describe("providerLimitFromTurnError: Codex", () => {
  const usageLimitError = {
    error: "You've hit your usage limit. Try again at 3:45 PM.",
    class: "provider_error",
    detail: {
      error: {
        message: "You've hit your usage limit. Try again at 3:45 PM.",
        codexErrorInfo: "usageLimitExceeded",
      },
    },
  }

  it("takes the reset of the exhausted window from the latest report", () => {
    expect(
      providerLimitFromTurnError(usageLimitError, now, {
        snapshot: {
          rateLimits: {
            primary: {
              usedPercent: 100,
              windowDurationMins: 300,
              resetsAt: 1792501200,
            },
            secondary: { usedPercent: 40, resetsAt: 1792900000 },
          },
        },
        receivedAt: now - MINUTE,
      })
    ).toEqual({ kind: "usage", resetAt: Date.parse("2026-10-20T13:00:00Z") })
  })

  it("reads older reports that count seconds until the reset", () => {
    expect(
      resetAtFromRateLimits(
        {
          snapshot: { primary: { used_percent: 100, resets_in_seconds: 600 } },
          receivedAt: now - MINUTE,
        },
        now
      )
    ).toBe(now - MINUTE + 10 * MINUTE)
    expect(
      resetAtFromRateLimits(
        {
          snapshot: { primary: { used_percent: 60, resets_in_seconds: 600 } },
          receivedAt: now,
        },
        now
      )
    ).toBeNull()
  })

  it("falls back to the time in the message", () => {
    const expected = new Date(now)
    expected.setHours(15, 45, 0, 0)
    if (expected.getTime() <= now) expected.setDate(expected.getDate() + 1)
    expect(providerLimitFromTurnError(usageLimitError, now)).toEqual({
      kind: "usage",
      resetAt: expected.getTime(),
    })
  })

  it("reads a dated reset and a relative one", () => {
    expect(
      resetAtFromText(
        "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 21st, 2026 3:45 PM.",
        now
      )
    ).toBe(new Date(2026, 9, 21, 15, 45).getTime())
    expect(
      providerLimitFromTurnError(
        {
          error:
            "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 30 minutes.",
        },
        now
      )
    ).toEqual({ kind: "usage", resetAt: now + 2.5 * HOUR })
  })

  it("treats a 429 the client gave up on as a rate limit", () => {
    expect(
      providerLimitFromTurnError(
        {
          error: "exceeded retry limit, last status: 429",
          detail: {
            error: {
              message: "exceeded retry limit",
              codexErrorInfo: {
                responseTooManyFailedAttempts: { httpStatusCode: 429 },
              },
            },
          },
        },
        now
      )
    ).toEqual({ kind: "rate", resetAt: null })
  })
})

describe("providerLimitFromTurnError: API keys and other failures", () => {
  it("uses the rate limit the key pool attached", () => {
    expect(
      providerLimitFromTurnError(
        {
          error: "Provider turn failed.",
          status: "failed",
          limit: { kind: "rate", resetAt: now + 30_000 },
        },
        now
      )
    ).toEqual({ kind: "rate", resetAt: now + 30_000 })
  })

  it("recognizes a rate limit in the wording", () => {
    expect(
      providerLimitFromTurnError(
        {
          error:
            'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization."}}',
        },
        now
      )
    ).toEqual({ kind: "rate", resetAt: null })
    expect(
      providerLimitFromTurnError(
        { error: "Rate limit reached. Please try again in 20s." },
        now
      )
    ).toEqual({ kind: "rate", resetAt: now + 20_000 })
    expect(
      providerLimitFromTurnError(
        { class: "rate_limit", message: "Slow down" },
        now
      )
    ).toEqual({ kind: "rate", resetAt: null })
  })

  it("reads an ISO reset", () => {
    expect(
      providerLimitFromTurnError(
        { error: "Rate limit exceeded. Retry after 2026-10-20T10:05:00Z." },
        now
      )
    ).toEqual({ kind: "rate", resetAt: now + 5 * MINUTE })
  })

  it("leaves every other failure alone", () => {
    for (const error of [
      "Claude SDK reported a failure",
      "Overloaded",
      "Your credit balance is too low to access the Anthropic API.",
      "prompt is too long: the context window is exceeded",
      "Provider turn failed.",
    ]) {
      expect(providerLimitFromTurnError({ error }, now), error).toBeNull()
    }
    expect(limitKindFromText("")).toBeNull()
  })
})

describe("reset times", () => {
  it("accepts seconds, milliseconds and dates within a week", () => {
    expect(normalizeResetInstant(1792501200, now)).toBe(1792501200000)
    expect(normalizeResetInstant(1792501200000, now)).toBe(1792501200000)
    expect(normalizeResetInstant("2026-10-20T13:00:00Z", now)).toBe(
      1792501200000
    )
    expect(normalizeResetInstant(now + 9 * 24 * HOUR, now)).toBeNull()
    expect(normalizeResetInstant(now - HOUR, now)).toBeNull()
    expect(normalizeResetInstant("soon", now)).toBeNull()
  })

  it("reads retry headers", () => {
    expect(retryAtFromHeaders(new Headers({ "retry-after": "30" }), now)).toBe(
      now + 30_000
    )
    expect(retryAtFromHeaders({ "retry-after-ms": "1500" }, now)).toBe(
      now + 1500
    )
    expect(
      retryAtFromHeaders(
        new Headers({ "retry-after": "Tue, 20 Oct 2026 10:10:00 GMT" }),
        now
      )
    ).toBe(now + 10 * MINUTE)
    expect(retryAtFromHeaders(new Headers(), now)).toBeNull()
  })

  it("finds the limit of an API failure", () => {
    expect(
      providerLimitFromError(
        { status: 429, headers: new Headers({ "retry-after": "120" }) },
        now
      )
    ).toEqual({ kind: "rate", resetAt: now + 120_000 })
    expect(
      providerLimitFromError(
        { limit: { kind: "rate", resetAt: now + 1000 } },
        now
      )
    ).toEqual({ kind: "rate", resetAt: now + 1000 })
    expect(providerLimitFromError({ status: 500 }, now)).toBeNull()
    expect(providerLimitFromError(new Error("boom"), now)).toBeNull()
  })

  it("merges two reports of one turn", () => {
    expect(
      mergeProviderLimits(
        { kind: "usage", resetAt: null },
        { kind: "rate", resetAt: now + HOUR }
      )
    ).toEqual({ kind: "usage", resetAt: now + HOUR })
    expect(
      mergeProviderLimits(
        { kind: "usage", resetAt: now },
        { kind: "usage", resetAt: now + HOUR }
      )
    ).toEqual({ kind: "usage", resetAt: now })
  })
})
