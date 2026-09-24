import { describe, expect, it } from "vitest"
import type { ChatMessage, ThreadActivity } from "@/types/remote"
import { restorableTurns, restorePoints } from "./checkpoints"

function captured(
  turnId: string | null,
  payload: Record<string, unknown>,
  id = `capture-${turnId}`
): ThreadActivity {
  return {
    id,
    threadId: "thread-1",
    turnId,
    providerInstanceId: null,
    kind: "checkpoint.captured",
    tone: "info",
    summary: "Checkpoint captured",
    payload,
    createdAt: "2026-09-24T10:00:00.000Z",
  }
}

const message = (
  id: string,
  role: ChatMessage["role"],
  turnId?: string
): ChatMessage => ({
  id,
  role,
  content: id,
  createdAt: "2026-09-24T10:00:00.000Z",
  ...(turnId ? { turnId } : {}),
})

describe("which turns can be restored", () => {
  it("reads the turn and its checkpoint from each ready capture", () => {
    const turns = restorableTurns([
      captured("t1", {
        status: "ready",
        checkpointRef: "ref-1",
        turn_index: 1,
      }),
      captured(null, {
        checkpointRef: "ref-2",
        turn_id: "t2",
        checkpointTurnCount: 2,
      }),
    ])
    expect([...turns]).toEqual([
      ["t1", 1],
      ["t2", 2],
    ])
  })

  it("skips captures that cannot be returned to", () => {
    expect(
      restorableTurns([
        captured("t1", {
          status: "missing",
          checkpointRef: "ref",
          turn_index: 1,
        }),
        captured("t2", {
          status: "error",
          checkpointRef: "ref",
          turn_index: 2,
        }),
        captured("t3", { status: "ready", turn_index: 3 }),
        captured(null, {
          status: "ready",
          checkpointRef: "ref",
          turn_index: 4,
        }),
        captured("t5", {
          status: "ready",
          checkpointRef: "ref",
          turn_index: -1,
        }),
        captured("t6", { status: "ready", checkpointRef: "ref" }),
      ]).size
    ).toBe(0)
  })

  it("takes the latest capture of a turn", () => {
    const turns = restorableTurns([
      captured("t1", { checkpointRef: "old", turn_index: 1 }, "a"),
      captured("t1", { checkpointRef: "new", turn_index: 2 }, "b"),
    ])
    expect(turns.get("t1")).toBe(2)
  })
})

describe("where a restore is offered", () => {
  const turns = new Map([
    ["t1", 1],
    ["t2", 2],
  ])

  it("after the last reply of each restorable turn, not after the last message", () => {
    const points = restorePoints(
      [
        message("u1", "user"),
        message("a1", "assistant", "t1"),
        message("a1b", "assistant", "t1"),
        message("u2", "user"),
        message("a2", "assistant", "t2"),
      ],
      turns
    )
    expect([...points]).toEqual([["a1b", 1]])
  })

  it("nowhere for replies without a known turn", () => {
    const points = restorePoints(
      [
        message("a0", "assistant"),
        message("a9", "assistant", "t9"),
        message("u1", "user"),
      ],
      turns
    )
    expect(points.size).toBe(0)
  })
})
