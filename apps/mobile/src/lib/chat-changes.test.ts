import { describe, expect, it } from "vitest"
import { changeItems } from "./chat-changes"

describe("a chat's changes", () => {
  it("list turn and checkpoint diffs newest first, with ids that stay the same", () => {
    const diffs = {
      turnDiffs: [
        {
          threadId: "t",
          turnIndex: 1,
          diffText: "diff --git a/a b/a",
          filesChanged: 1,
          insertions: 2,
          deletions: 0,
          createdAt: "2026-09-24T10:00:00.000Z",
        },
      ],
      checkpointDiffs: [
        {
          id: "checkpoint-7",
          threadId: "t",
          turnId: "turn-7",
          checkpointRef: "refs/betterc0de/checkpoints/7",
          diffContent: "diff --git a/b b/b",
          createdAt: "2026-09-24T11:00:00.000Z",
        },
      ],
    }
    const items = changeItems(diffs)
    expect(items.map((item) => item.id)).toEqual([
      "checkpoint-7",
      "turn-1-2026-09-24T10:00:00.000Z",
    ])
    expect(changeItems(diffs).map((item) => item.id)).toEqual(
      items.map((item) => item.id)
    )
    expect(items[1]).toMatchObject({
      title: "Turn 1",
      additions: 2,
      deletions: 0,
      files: 1,
    })
    expect(changeItems(null)).toEqual([])
  })
})
