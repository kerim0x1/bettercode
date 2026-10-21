import { checkpointRefForThreadTurn } from "@betterc0de/schema"
import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { registerThreadsRoutes as registerThreadsRoutesUnfilled } from "./threads"
import { withInertStateArgument } from "../../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const registerThreadsRoutes = withInertStateArgument(
  registerThreadsRoutesUnfilled,
  1
)

// GET /threads/:id/diffs used to hand back up to 1,000 full diff bodies, and
// /undo fetched all of them only to find the newest turn. The summary view
// answers that from refs alone; full pages are bounded and carry cursors.

function turnDiff(turnIndex: number) {
  return {
    thread_id: "thread-1",
    turn_index: turnIndex,
    diff_text: `diff for turn ${turnIndex}`,
    files_changed: 1,
    insertions: 2,
    deletions: 3,
    created_at: "2026-01-01T00:00:00.000Z",
  }
}

function app(options: {
  latestTurnIndex: number
  checkpointRefs: string[]
  turnDiffs?: ReturnType<typeof turnDiff>[]
}) {
  const listTurnDiffsByThread = vi.fn(
    (_threadId: string, page: { limit?: number }) =>
      (options.turnDiffs ?? []).slice(-(page.limit ?? 500))
  )
  const listCheckpointDiffsByThread = vi.fn(() => [])
  const checkpointDiffs = {
    latestTurnIndex: vi.fn(() => options.latestTurnIndex),
    listCheckpointRefsByThread: vi.fn(() => options.checkpointRefs),
    listTurnDiffsByThread,
    listCheckpointDiffsByThread,
  }
  const hono = new Hono()
  registerThreadsRoutes(hono, { checkpointDiffs } as unknown as AppState)
  return { hono, checkpointDiffs }
}

describe("GET /threads/:id/diffs", () => {
  it("summarises the restorable turn without loading any diff body", async () => {
    const { hono, checkpointDiffs } = app({
      latestTurnIndex: 2,
      // Paired slot 5 is checkpoint turn 3.
      checkpointRefs: [
        checkpointRefForThreadTurn("thread-1", 0),
        checkpointRefForThreadTurn("thread-1", 5),
      ],
    })
    const response = await hono.request("/threads/thread-1/diffs?summary=1")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      threadId: "thread-1",
      currentTurnCount: 3,
    })
    expect(checkpointDiffs.listTurnDiffsByThread).not.toHaveBeenCalled()
    expect(checkpointDiffs.listCheckpointDiffsByThread).not.toHaveBeenCalled()
  })

  it("bounds the page size and returns a cursor for the next older page", async () => {
    const { hono, checkpointDiffs } = app({
      latestTurnIndex: 3,
      checkpointRefs: [],
      turnDiffs: [turnDiff(1), turnDiff(2), turnDiff(3)],
    })
    const page = await hono.request("/threads/thread-1/diffs?limit=2")
    const body = (await page.json()) as {
      turnDiffs: Array<{ turnIndex: number }>
      nextBeforeTurnIndex: number | null
      nextBeforeCheckpointId: number | null
    }
    expect(body.turnDiffs.map((diff) => diff.turnIndex)).toEqual([2, 3])
    expect(body.nextBeforeTurnIndex).toBe(2)
    expect(body.nextBeforeCheckpointId).toBeNull()

    await hono.request("/threads/thread-1/diffs?limit=100000")
    expect(checkpointDiffs.listTurnDiffsByThread).toHaveBeenLastCalledWith(
      "thread-1",
      expect.objectContaining({ limit: 500 })
    )
  })

  it("reports a complete history without a cursor", async () => {
    const { hono } = app({
      latestTurnIndex: 1,
      checkpointRefs: [],
      turnDiffs: [turnDiff(1)],
    })
    const body = (await (
      await hono.request("/threads/thread-1/diffs")
    ).json()) as { nextBeforeTurnIndex: number | null }
    expect(body.nextBeforeTurnIndex).toBeNull()
  })
})
