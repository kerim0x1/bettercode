import { describe, expect, it } from "vitest"
import { chatSendSchema, type ThreadResume } from "@betterc0de/schema"
import {
  afterFailedAttempt,
  backoffDelay,
  isResumableOrigin,
  limitRecord,
  RESTART_RETRY_MS,
  resumeAtForLimit,
  resumeMessage,
  resumeSendBody,
  resumeTemplate,
  scheduledRecord,
  stricterPermissionLevel,
  timerDelay,
} from "./resume-policy"

const now = Date.parse("2026-10-20T10:00:00Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE

function record(patch: Partial<ThreadResume> = {}): ThreadResume {
  return {
    reason: "usage_limit",
    stoppedAt: now,
    resetAt: now + HOUR,
    mode: "auto",
    resumeAt: now + HOUR + MINUTE,
    status: "waiting",
    failures: 0,
    resumable: true,
    providerKind: "claude",
    note: null,
    ...patch,
  }
}

describe("when to resume", () => {
  it("goes out 30 to 90 seconds after a known reset", () => {
    const resetAt = now + HOUR
    expect(
      resumeAtForLimit({ resetAt, failures: 0, now, random: () => 0 })
    ).toBe(resetAt + 30_000)
    expect(
      resumeAtForLimit({ resetAt, failures: 0, now, random: () => 1 })
    ).toBe(resetAt + 90_000)
  })

  it("backs off 30 minutes, 1 hour and 2 hours without one", () => {
    const at = (failures: number) =>
      resumeAtForLimit({ resetAt: null, failures, now, random: () => 0.5 })
    expect(at(0)).toBe(now + 30 * MINUTE)
    expect(at(1)).toBe(now + HOUR)
    expect(at(2)).toBe(now + 2 * HOUR)
    expect(backoffDelay(9)).toBe(2 * HOUR)
    // A reset already past counts as unknown.
    expect(
      resumeAtForLimit({
        resetAt: now - MINUTE,
        failures: 0,
        now,
        random: () => 0,
      })
    ).toBe(now + 30 * MINUTE)
  })

  it("keeps timers within what Node can schedule", () => {
    expect(timerDelay(now - 1, now)).toBe(0)
    expect(timerDelay(now + 40 * 24 * HOUR, now)).toBe(2_147_483_647)
  })
})

describe("limitRecord", () => {
  const limit = { kind: "usage", resetAt: now + HOUR } as const

  it("resumes by itself when the setting allows it", () => {
    expect(
      limitRecord({
        limit,
        now,
        random: () => 0,
        autoResume: true,
        resumable: true,
        providerKind: "claude",
      })
    ).toEqual(record({ resumeAt: now + HOUR + 30_000 }))
  })

  it("waits for the user without the setting, settings to resume with, or a reset", () => {
    for (const input of [
      { autoResume: false, resumable: true },
      { autoResume: true, resumable: false },
    ]) {
      expect(
        limitRecord({
          limit,
          now,
          random: () => 0,
          providerKind: null,
          ...input,
        })
      ).toMatchObject({ mode: "off", resumeAt: null, failures: 0 })
    }
    expect(
      limitRecord({
        limit: { kind: "rate", resetAt: null },
        now,
        random: () => 0,
        autoResume: true,
        resumable: true,
        providerKind: null,
      })
    ).toMatchObject({
      reason: "rate_limit",
      mode: "auto",
      resumeAt: now + 30 * MINUTE,
    })
  })

  it("re-arms a resume that met the limit again and gives up at the third", () => {
    const again = limitRecord({
      limit: { kind: "usage", resetAt: null },
      now,
      random: () => 0,
      autoResume: true,
      resumable: true,
      providerKind: "codex",
      previous: record({ status: "resuming", failures: 0 }),
    })
    expect(again).toMatchObject({
      mode: "auto",
      failures: 1,
      resumeAt: now + HOUR,
    })
    expect(
      limitRecord({
        limit,
        now,
        random: () => 0,
        autoResume: true,
        resumable: true,
        providerKind: "codex",
        previous: record({ status: "resuming", failures: 2 }),
      })
    ).toMatchObject({
      mode: "off",
      resumeAt: null,
      failures: 3,
      note: expect.stringContaining("3 tries"),
    })
  })
})

describe("afterFailedAttempt", () => {
  it("tries a limit again after the backoff, then stops", () => {
    expect(
      afterFailedAttempt({ record: record(), reason: "busy", now })
    ).toMatchObject({
      mode: "auto",
      status: "waiting",
      failures: 1,
      resumeAt: now + HOUR,
    })
    expect(
      afterFailedAttempt({
        record: record({ failures: 2 }),
        reason: "busy",
        now,
      })
    ).toMatchObject({
      mode: "off",
      resumeAt: null,
      failures: 3,
      note: "Couldn't resume the chat: busy",
    })
  })

  it("retries a restart continuation sooner", () => {
    expect(
      afterFailedAttempt({
        record: record({ reason: "restart", resetAt: null }),
        reason: "provider starting",
        now,
      })
    ).toMatchObject({ mode: "auto", resumeAt: now + RESTART_RETRY_MS[0] })
  })
})

describe("scheduledRecord", () => {
  it("arms a stopped chat for the reset and forgets earlier failures", () => {
    expect(
      scheduledRecord({
        record: record({ mode: "off", resumeAt: null, failures: 3, note: "x" }),
        now,
        random: () => 0,
      })
    ).toMatchObject({
      mode: "auto",
      resumeAt: now + HOUR + 30_000,
      failures: 0,
      note: null,
    })
    expect(
      scheduledRecord({
        record: record({ reason: "restart", mode: "off", resumeAt: null }),
        now,
        random: () => 0,
      })
    ).toMatchObject({ mode: "auto", resumeAt: now })
  })
})

describe("the resumed turn", () => {
  it("sends a canned message marked by its cause", () => {
    expect(resumeMessage({ reason: "usage_limit" })).toEqual({
      content: "Continue.",
      automatic: "usage-limit",
    })
    expect(resumeMessage({ reason: "restart" })).toEqual({
      content:
        "The app restarted while you were working. Continue where you left off.",
      automatic: "restart",
    })
  })

  it("never runs with more permission than the stopped turn or the chat now", () => {
    expect(stricterPermissionLevel("bypass", "ask-on-edit")).toBe("ask-on-edit")
    expect(stricterPermissionLevel("read-only", "bypass")).toBe("read-only")
    expect(stricterPermissionLevel(null, "allow-edits")).toBe("allow-edits")
    expect(stricterPermissionLevel("allow-edits", null)).toBe("allow-edits")
  })

  it("keeps the request's settings, never its content", () => {
    const body = chatSendSchema.parse({
      threadId: "thread",
      message: "Refactor the parser",
      userMessageId: "message-1",
      userMessageContent: "Refactor the parser",
      providerKind: "claude",
      providerInstanceId: "claude",
      modelId: "claude-opus-4-7",
      reasoningEffort: "high",
      permissionLevel: "bypass",
      projectPath: "/repo",
      history: [{ role: "user", content: "earlier" }],
      prepareTurn: true,
    })
    const template = resumeTemplate(body)
    expect(template).not.toHaveProperty("message")
    expect(template).not.toHaveProperty("history")
    expect(template).not.toHaveProperty("user_message_id")
    const resumed = resumeSendBody({
      threadId: "thread",
      template: JSON.parse(JSON.stringify(template)) as Record<string, unknown>,
      content: "Continue.",
      messageId: "message-2",
      createdAt: new Date(now).toISOString(),
      permissionLevel: "ask-on-edit",
    })
    expect(resumed).toMatchObject({
      thread_id: "thread",
      message: "Continue.",
      user_message_id: "message-2",
      user_message_content: "Continue.",
      provider_kind: "claude",
      provider_instance_id: "claude",
      model_id: "claude-opus-4-7",
      reasoning_effort: "high",
      permission_level: "ask-on-edit",
      prepare_turn: true,
      project_path: null,
      history: [],
      attachments: [],
    })
  })

  it("resumes only turns the user (or the resume itself) sent", () => {
    expect(isResumableOrigin("user")).toBe(true)
    expect(isResumableOrigin("resume")).toBe(true)
    expect(isResumableOrigin("restart")).toBe(true)
    expect(isResumableOrigin("scheduler")).toBe(false)
    expect(isResumableOrigin("worker")).toBe(false)
    expect(isResumableOrigin(null)).toBe(false)
  })
})
