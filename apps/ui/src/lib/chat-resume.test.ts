import { describe, expect, it } from "vitest"
import type { ThreadResume } from "@betterc0de/schema"
import {
  isLimitedNow,
  limitedLabel,
  mergePersistedThreadResumes,
  queueHold,
  QUEUE_RELEASE_LEAD_MS,
  resumeStatusText,
  resumeTitle,
} from "./chat-resume"

const now = Date.parse("2026-10-20T10:00:00Z")
const HOUR = 60 * 60_000
const at = (time: number) => `@${(time - now) / 60_000}m`

function resume(patch: Partial<ThreadResume> = {}): ThreadResume {
  return {
    reason: "usage_limit",
    stoppedAt: now,
    resetAt: now + HOUR,
    mode: "auto",
    resumeAt: now + HOUR + 30_000,
    status: "waiting",
    failures: 0,
    resumable: true,
    providerKind: "claude",
    note: null,
    ...patch,
  }
}

describe("the sidebar's Limited status", () => {
  it("shows while a limit holds the chat", () => {
    expect(isLimitedNow(resume(), now)).toBe(true)
    expect(isLimitedNow(resume({ mode: "off" }), now)).toBe(true)
    expect(
      isLimitedNow(resume({ mode: "off", resetAt: null, resumeAt: null }), now)
    ).toBe(true)
  })

  it("goes once the chat resumes, the reset passed or it was a restart", () => {
    expect(isLimitedNow(null, now)).toBe(false)
    expect(isLimitedNow(resume({ status: "resuming" }), now)).toBe(false)
    expect(isLimitedNow(resume({ mode: "off", resetAt: now - 1 }), now)).toBe(
      false
    )
    expect(isLimitedNow(resume({ reason: "restart" }), now)).toBe(false)
  })

  it("names the reset while it lies ahead", () => {
    expect(limitedLabel(resume(), now, at)).toBe("Limited · resets @60m")
    expect(limitedLabel(resume({ resetAt: null }), now, at)).toBe("Limited")
    expect(limitedLabel(resume({ resetAt: now - 1 }), now, at)).toBe("Limited")
  })
})

describe("the resume card", () => {
  it("titles each cause", () => {
    expect(resumeTitle({ reason: "usage_limit" })).toBe("Usage limit reached")
    expect(resumeTitle({ reason: "rate_limit" })).toBe("Rate limit reached")
    expect(resumeTitle({ reason: "restart" })).toBe("Stopped by a restart")
  })

  it("says what happens next", () => {
    expect(resumeStatusText(resume(), now, at)).toBe(
      "Resumes at @60.5m, just after the reset."
    )
    expect(
      resumeStatusText(
        resume({ resetAt: null, resumeAt: now + 30 * 60_000 }),
        now,
        at
      )
    ).toBe("The reset time is unknown. Tries again at @30m.")
    expect(
      resumeStatusText(resume({ mode: "off", resumeAt: null }), now, at)
    ).toBe("Resets at @60m. Not resuming by itself.")
    expect(
      resumeStatusText(
        resume({ mode: "off", resumeAt: null, resetAt: now - 1 }),
        now,
        at
      )
    ).toBe("The limit has reset.")
    expect(
      resumeStatusText(
        resume({ reason: "restart", resetAt: null, resumeAt: now + 15_000 }),
        now,
        at
      )
    ).toBe("Continues at @0.25m.")
    expect(resumeStatusText(resume({ note: "Gave up." }), now, at)).toBe(
      "Gave up."
    )
  })
})

describe("queueHold", () => {
  it("releases queued messages just before the backend resumes", () => {
    expect(queueHold(resume(), now)).toEqual({
      releaseAt: now + HOUR + 30_000 - QUEUE_RELEASE_LEAD_MS,
    })
  })

  it("holds until the reset, or the user's choice when none is known", () => {
    expect(queueHold(resume({ mode: "off", resumeAt: null }), now)).toEqual({
      releaseAt: now + HOUR,
    })
    expect(
      queueHold(resume({ mode: "off", resumeAt: null, resetAt: null }), now)
    ).toEqual({ releaseAt: null })
    expect(queueHold(resume({ status: "resuming" }), now)).toEqual({
      releaseAt: null,
    })
  })

  it("lets go once nothing holds the chat", () => {
    expect(queueHold(null, now)).toBeNull()
    expect(queueHold(resume({ reason: "restart" }), now)).toBeNull()
    expect(
      queueHold(resume({ mode: "off", resumeAt: null, resetAt: now - 1 }), now)
    ).toBeNull()
  })
})

describe("mergePersistedThreadResumes", () => {
  it("takes the loaded records unless a push changed one meanwhile", () => {
    const pushed = resume({ failures: 1 })
    const stale = resume({ reason: "rate_limit" })
    const loaded = resume()
    const beforeLoad = { gone: stale }
    const current = { gone: stale, pushed }
    expect(
      mergePersistedThreadResumes(
        current,
        [
          { id: "gone", resume: null },
          { id: "pushed", resume: loaded },
          { id: "new", resume: loaded },
        ],
        beforeLoad
      )
    ).toEqual({ pushed, new: loaded })
  })

  it("keeps the same object when nothing changes", () => {
    const current = {}
    expect(mergePersistedThreadResumes(current, [{ id: "a" }], {})).toBe(
      current
    )
  })
})
