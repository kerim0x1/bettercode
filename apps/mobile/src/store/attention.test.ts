import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteApi } from "@/transport/types"
import type { ChatThread, ThreadActivity } from "@/types/remote"
import { ATTENTION_REFRESH_LIMIT, useAppStore } from "./app-store"

// Which chats wait for the user. The desktop sends every activity it
// records as a `thread.activity` frame, including approvals answered on the
// desktop itself; the phone keeps its requests in step with them.

let sequence = 0
function activity(
  threadId: string,
  kind: string,
  payload: Record<string, unknown>,
  tone: ThreadActivity["tone"] = "approval"
): ThreadActivity {
  sequence += 1
  return {
    id: `${threadId}-${kind}-${sequence}`,
    threadId,
    turnId: "turn-1",
    providerInstanceId: "claude-1",
    kind,
    tone,
    summary: kind,
    payload,
    sequence,
    createdAt: `2026-09-24T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  }
}
const frame = (data: ThreadActivity) => ({ channel: "thread.activity", data })
const requested = (threadId: string, requestId: string) =>
  activity(threadId, "approval.requested", {
    requestId,
    providerKind: "claude",
    providerInstanceId: "claude-1",
    toolName: "Bash",
    input: { command: "npm test" },
  })
const resolved = (threadId: string, requestId: string) =>
  activity(threadId, "approval.resolved", { requestId, decision: "approve" })

const store = () => useAppStore.getState()

describe("requests from live activity", () => {
  beforeEach(() => store().reset())

  it("tracks a chat that was never opened without keeping its history", () => {
    expect(store().applyFrame(frame(requested("far", "r1")))).toBeNull()
    expect(store().requestsByThread.far).toEqual([
      expect.objectContaining({
        id: "r1",
        kind: "approval",
        providerKind: "claude",
        toolName: "Bash",
      }),
    ])
    store().applyFrame(
      frame(activity("far", "tool.updated", { output: "…" }, "tool"))
    )
    expect(store().activitiesByThread.far).toBeUndefined()

    // Answered on the desktop: the phone lets go of it.
    store().applyFrame(frame(resolved("far", "r1")))
    expect(store().requestsByThread.far).toEqual([])
  })

  it("keeps a loaded chat's activities and derives its requests again", () => {
    useAppStore.setState({
      activitiesByThread: { open: [] },
      requestsByThread: {
        // Announced by a runtime event before its activity arrived.
        open: [
          {
            id: "from-event",
            threadId: "open",
            kind: "approval",
            providerKind: "claude",
            providerInstanceId: "claude-1",
            title: "Edit",
          },
        ],
      },
    })
    store().applyFrame(frame(requested("open", "r2")))
    expect(store().activitiesByThread.open).toHaveLength(1)
    expect(store().requestsByThread.open?.map((request) => request.id)).toEqual(
      ["from-event", "r2"]
    )
    store().applyFrame(frame(resolved("open", "from-event")))
    store().applyFrame(frame(resolved("open", "r2")))
    expect(store().requestsByThread.open).toEqual([])
    expect(store().activitiesByThread.open).toHaveLength(3)
  })

  it("ignores frames that are not activities", () => {
    store().applyFrame({ channel: "thread.activity", data: { id: "x" } })
    expect(store().requestsByThread).toEqual({})
  })
})

describe("catching up after a connection", () => {
  beforeEach(() => store().reset())

  const chat = (id: string, running: boolean): ChatThread => ({
    id,
    title: id,
    projectName: "Project",
    projectPath: "/repo",
    messages: [],
    createdAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T08:00:00.000Z",
    session: running ? { activeTurnId: "turn" } : null,
  })

  it("loads the activities of chats a turn runs in, or with an open request", async () => {
    const listActivities = vi.fn(async (threadId: string) =>
      threadId === "running" ? [requested("running", "r3")] : []
    )
    useAppStore.setState({
      threads: [
        chat("running", true),
        chat("idle", false),
        chat("asked", false),
      ],
      requestsByThread: {
        asked: [
          {
            id: "old",
            threadId: "asked",
            kind: "approval",
            providerKind: "claude",
            providerInstanceId: null,
            title: "Old",
          },
        ],
      },
    })
    await store().refreshAttention({ listActivities } as unknown as RemoteApi)
    expect(listActivities.mock.calls.map(([id]) => id).sort()).toEqual([
      "asked",
      "running",
    ])
    expect(store().requestsByThread.running?.[0]?.id).toBe("r3")
    // The desktop no longer lists the old request as open.
    expect(store().requestsByThread.asked).toEqual([])
  })

  it("loads at most a few chats at a time", async () => {
    const listActivities = vi.fn(async () => [])
    useAppStore.setState({
      threads: Array.from({ length: ATTENTION_REFRESH_LIMIT + 3 }, (_, index) =>
        chat(`chat-${index}`, true)
      ),
    })
    await store().refreshAttention({ listActivities } as unknown as RemoteApi)
    expect(listActivities).toHaveBeenCalledTimes(ATTENTION_REFRESH_LIMIT)
  })
})
