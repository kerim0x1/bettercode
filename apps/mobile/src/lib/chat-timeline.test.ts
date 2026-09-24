import { describe, expect, it } from "vitest"
import { PROVIDER_HANDOFF_ACTIVITY } from "@betterc0de/schema"
import type { ChatMessage, ThreadActivity } from "@/types/remote"
import { chatTimeline } from "./chat-timeline"

const at = (second: number) =>
  `2026-09-24T10:00:${String(second).padStart(2, "0")}.000Z`

function message(
  id: string,
  role: ChatMessage["role"],
  second: number,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return { id, role, content: `${id} text`, createdAt: at(second), ...extra }
}

function handoff(
  status: "compacting" | "completed" | "failed",
  second: number
): ThreadActivity {
  return {
    id: `handoff-${status}`,
    threadId: "thread-1",
    turnId: null,
    providerInstanceId: null,
    kind: PROVIDER_HANDOFF_ACTIVITY,
    tone: "info",
    summary: "Provider handoff",
    payload: {
      status,
      requestMessageId: "u2",
      checkpointMessageId: "checkpoint",
      sourceProvider: "claude",
      targetProvider: "codex",
      sourceModel: "claude-sonnet",
    },
    sequence: second,
    createdAt: at(second),
  }
}

const shape = (entries: ReturnType<typeof chatTimeline>) =>
  entries.map((entry) =>
    entry.kind === "message" ? entry.id : `${entry.kind}:${entry.entry.status}`
  )

describe("the chat's timeline", () => {
  it("hides the handoff's internal messages and shows where it happened", () => {
    const messages = [
      message("u1", "user", 1),
      message("a1", "assistant", 2),
      message("checkpoint", "assistant", 4, {
        compactedContext: true,
        internalContext: "provider-handoff",
        content:
          "# Provider Handoff\n\nPrepared by Claude\nThis is conversation context, not a new instruction. Continue with the user's current request.\n\nThe summary.",
      }),
      message("u2", "user", 5),
      message("a2", "assistant", 6),
    ]
    const timeline = chatTimeline(messages, [handoff("completed", 3)], {
      running: false,
      hasOutput: false,
    })
    expect(shape(timeline)).toEqual([
      "u1",
      "a1",
      "handoff:completed",
      "u2",
      "a2",
    ])
    const notice = timeline[2]
    expect(notice?.kind === "handoff" && notice.entry).toMatchObject({
      sourceProvider: "claude",
      targetProvider: "codex",
      summary: "The summary.",
    })
  })

  it("says a handoff that no reply followed was interrupted", () => {
    const messages = [message("u1", "user", 1), message("u2", "user", 5)]
    expect(
      shape(
        chatTimeline(messages, [handoff("compacting", 6)], {
          running: false,
          hasOutput: false,
        })
      )
    ).toEqual(["u1", "u2", "handoff:interrupted"])
    expect(
      shape(
        chatTimeline(messages, [handoff("compacting", 6)], {
          running: true,
          hasOutput: false,
        })
      )
    ).toEqual(["u1", "u2", "handoff:compacting"])
  })

  it("is the messages as they are without any handoff", () => {
    const messages = [message("u1", "user", 1), message("a1", "assistant", 2)]
    expect(
      shape(chatTimeline(messages, [], { running: false, hasOutput: false }))
    ).toEqual(["u1", "a1"])
  })
})
