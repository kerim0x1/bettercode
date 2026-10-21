import { parseRealtimeEvent } from "@betterc0de/schema"
import { describe, expect, it } from "vitest"

// The renderer applies a WebSocket frame only after its payload matched the
// channel's schema; anything else is dropped and logged, never cast.

describe("parseRealtimeEvent", () => {
  it("reads legacy and canonical provider runtime events", () => {
    const legacy = parseRealtimeEvent("provider.runtimeEvent", {
      event_type: "content_delta",
      thread_id: "thread-1",
      payload: { text: "hi" },
    })
    expect(legacy).toMatchObject({
      kind: "event",
      event: { eventType: "content_delta", threadId: "thread-1" },
    })
    const canonical = parseRealtimeEvent("provider.runtimeEvent", {
      type: "turn.completed",
      threadId: "thread-2",
      thread_id: null,
    })
    expect(canonical).toMatchObject({
      kind: "event",
      event: { eventType: "turn.completed", threadId: "thread-2" },
    })
  })

  it("drops a runtime event without a type, a thread or an object payload", () => {
    for (const data of [
      { thread_id: "thread-1" },
      { event_type: "content_delta" },
      { event_type: "content_delta", thread_id: "thread-1", payload: "text" },
      { event_type: 7, thread_id: "thread-1" },
      null,
    ]) {
      expect(parseRealtimeEvent("provider.runtimeEvent", data).kind).toBe(
        "invalid"
      )
    }
  })

  it("never puts payload values into the reported problem", () => {
    const parsed = parseRealtimeEvent("thread.activity", {
      id: "a-1",
      threadId: "thread-1",
      kind: "tool.completed",
      tone: "secret-tone-value",
      summary: "Ran a tool",
      payload: {},
      createdAt: "2026-10-07T00:00:00.000Z",
    })
    expect(parsed.kind).toBe("invalid")
    if (parsed.kind !== "invalid") return
    expect(parsed.channel).toBe("thread.activity")
    expect(parsed.issue).toMatch(/^tone: /)
    expect(parsed.issue).not.toContain("secret-tone-value")
  })

  it("keeps the fields a newer desktop adds to an activity", () => {
    const parsed = parseRealtimeEvent("thread.activity", {
      id: "a-1",
      threadId: "thread-1",
      kind: "tool.completed",
      tone: "tool",
      summary: "Ran a tool",
      payload: { output: "ok" },
      createdAt: "2026-10-07T00:00:00.000Z",
      laterField: true,
    })
    expect(parsed).toMatchObject({
      kind: "event",
      event: { channel: "thread.activity", data: { laterField: true } },
    })
  })

  it("reads titles and replay gaps, and ignores channels it does not apply", () => {
    expect(
      parseRealtimeEvent("thread.metadata", {
        threadId: "thread-1",
        title: "Renamed",
        updatedAt: "2026-10-07T00:00:00.000Z",
      }).kind
    ).toBe("event")
    expect(
      parseRealtimeEvent("thread.metadata", { threadId: "thread-1" }).kind
    ).toBe("invalid")
    expect(
      parseRealtimeEvent("provider.replayGap", {
        type: "provider_replay_gap",
        journalId: "j",
      }).kind
    ).toBe("event")
    expect(parseRealtimeEvent("terminal.output", { anything: true })).toEqual({
      kind: "unknown",
    })
  })

  it("reads a chat's changed settings on the metadata channel", () => {
    expect(
      parseRealtimeEvent("thread.metadata", {
        threadId: "thread-1",
        settings: { permissionLevel: "allow-edits" },
      })
    ).toEqual({
      kind: "event",
      event: {
        channel: "thread.metadata",
        data: {
          threadId: "thread-1",
          settings: { permissionLevel: "allow-edits" },
        },
      },
    })
    expect(
      parseRealtimeEvent("thread.metadata", {
        threadId: "thread-1",
        settings: "allow-edits",
      }).kind
    ).toBe("invalid")
  })

  it("reads a chat's resume record on the metadata channel", () => {
    expect(
      parseRealtimeEvent("thread.metadata", {
        threadId: "thread-1",
        resume: null,
      }).kind
    ).toBe("event")
    expect(
      parseRealtimeEvent("thread.metadata", {
        threadId: "thread-1",
        resume: { reason: "usage_limit" },
        resumePrompt: { messageId: "message-1" },
      })
    ).toMatchObject({
      kind: "event",
      event: {
        channel: "thread.metadata",
        data: {
          resume: { reason: "usage_limit" },
          resumePrompt: { messageId: "message-1" },
        },
      },
    })
  })
})
