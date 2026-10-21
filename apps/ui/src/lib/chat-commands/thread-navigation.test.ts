import { describe, expect, it } from "vitest"
import {
  archivedThreadIdsAfterAction,
  resolveAdjacentProjectThread,
  resolveAdjacentSessionThread,
  resolveChildThread,
  resolveParentThread,
  resolvePinnedThreadSlot,
  resolveSessionCommandThread,
  resolveSiblingChildThread,
} from "@/lib/chat-commands/thread-navigation"
import type { ChatThread } from "@/lib/chat-store"

function thread(id: string, overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    title: id,
    projectName: "proj",
    projectPath: "/repo",
    messages: [],
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-23T10:00:00.000Z",
    ...overrides,
  }
}

describe("resolveParentThread", () => {
  const child = thread("child", { parentThreadId: "parent" })
  const parent = thread("parent")

  it("finds the parent", () => {
    expect(resolveParentThread([parent, child], "child")?.id).toBe("parent")
  })

  it("returns null for a root thread", () => {
    expect(resolveParentThread([parent, child], "parent")).toBeNull()
  })

  it("returns null when the parent is not loaded", () => {
    expect(resolveParentThread([child], "child")).toBeNull()
  })

  it("returns null without a thread id", () => {
    expect(resolveParentThread([parent, child], null)).toBeNull()
  })
})

describe("resolveAdjacentSessionThread", () => {
  const threads = [thread("a"), thread("b"), thread("c")]

  it("steps forward and back", () => {
    expect(resolveAdjacentSessionThread(threads, "a", 1)?.id).toBe("b")
    expect(resolveAdjacentSessionThread(threads, "b", -1)?.id).toBe("a")
  })

  it("wraps around at both ends", () => {
    expect(resolveAdjacentSessionThread(threads, "c", 1)?.id).toBe("a")
    expect(resolveAdjacentSessionThread(threads, "a", -1)?.id).toBe("c")
  })

  it("has nowhere to go with fewer than two threads", () => {
    expect(resolveAdjacentSessionThread([thread("only")], "only", 1)).toBeNull()
  })

  it("starts from the first thread when the current one is unknown", () => {
    expect(resolveAdjacentSessionThread(threads, "gone", 1)?.id).toBe("b")
  })
})

describe("resolveAdjacentProjectThread", () => {
  // One entry per project, newest thread representing it.
  const threads = [
    thread("alpha-old", {
      projectPath: "/repo/alpha",
      updatedAt: "2026-08-23T09:00:00.000Z",
    }),
    thread("alpha-new", {
      projectPath: "/repo/alpha",
      updatedAt: "2026-08-23T11:00:00.000Z",
    }),
    thread("beta", { projectPath: "/repo/beta" }),
  ]

  it("cycles projects, not threads", () => {
    const next = resolveAdjacentProjectThread(threads, "alpha-new", 1)
    expect(next?.id).toBe("beta")
  })

  it("represents a project by its most recently updated thread", () => {
    const next = resolveAdjacentProjectThread(threads, "beta", 1)
    expect(next?.id).toBe("alpha-new")
  })

  it("treats backslashes and casing as the same project", () => {
    // A Windows path and a posix one must not read as two projects.
    const mixed = [
      thread("win", { projectPath: "C:\\Repo\\Alpha" }),
      thread("posix", { projectPath: "c:/repo/alpha" }),
    ]
    expect(resolveAdjacentProjectThread(mixed, "win", 1)).toBeNull()
  })

  it("falls back to the worktree path when there is no project path", () => {
    const worktrees = [
      thread("one", { projectPath: "", worktreePath: "/wt/one" }),
      thread("two", { projectPath: "", worktreePath: "/wt/two" }),
    ]
    expect(resolveAdjacentProjectThread(worktrees, "one", 1)?.id).toBe("two")
  })
})

describe("resolveChildThread", () => {
  const threads = [
    thread("parent"),
    thread("kid-old", {
      parentThreadId: "parent",
      title: "Refactor",
      updatedAt: "2026-08-23T09:00:00.000Z",
    }),
    thread("kid-new", {
      parentThreadId: "parent",
      title: "Tests",
      updatedAt: "2026-08-23T11:00:00.000Z",
    }),
  ]

  it("picks the newest child when no query is given", () => {
    expect(resolveChildThread(threads, "parent")?.id).toBe("kid-new")
  })

  it("matches a child by title substring", () => {
    expect(resolveChildThread(threads, "parent", "refac")?.id).toBe("kid-old")
  })

  it("matches a child by id prefix", () => {
    expect(resolveChildThread(threads, "parent", "kid-o")?.id).toBe("kid-old")
  })

  it("returns null when nothing matches the query", () => {
    expect(resolveChildThread(threads, "parent", "nope")).toBeNull()
  })

  it("returns null for a thread with no children", () => {
    expect(resolveChildThread(threads, "kid-new")).toBeNull()
  })
})

describe("resolveSiblingChildThread", () => {
  const threads = [
    thread("parent"),
    thread("a", {
      parentThreadId: "parent",
      updatedAt: "2026-08-23T12:00:00.000Z",
    }),
    thread("b", {
      parentThreadId: "parent",
      updatedAt: "2026-08-23T11:00:00.000Z",
    }),
  ]

  it("steps between siblings and wraps", () => {
    expect(resolveSiblingChildThread(threads, "a", 1)?.id).toBe("b")
    expect(resolveSiblingChildThread(threads, "b", 1)?.id).toBe("a")
  })

  it("returns null for a root thread", () => {
    expect(resolveSiblingChildThread(threads, "parent", 1)).toBeNull()
  })

  it("returns null for an only child", () => {
    const lonely = [
      thread("parent"),
      thread("solo", { parentThreadId: "parent" }),
    ]
    expect(resolveSiblingChildThread(lonely, "solo", 1)).toBeNull()
  })
})

describe("resolvePinnedThreadSlot", () => {
  const threads = [thread("first"), thread("second")]
  const pinned = new Set(["first", "second"])

  it("resolves slots from one", () => {
    expect(resolvePinnedThreadSlot(threads, pinned, 1)?.id).toBe("first")
    expect(resolvePinnedThreadSlot(threads, pinned, 2)?.id).toBe("second")
  })

  it("rejects slots outside 1–9", () => {
    for (const slot of [0, -1, 10, 1.5, Number.NaN]) {
      expect(
        resolvePinnedThreadSlot(threads, pinned, slot),
        `${slot}`
      ).toBeNull()
    }
  })

  it("returns null for an empty slot", () => {
    expect(resolvePinnedThreadSlot(threads, pinned, 3)).toBeNull()
  })

  it("skips a pinned id whose thread is gone", () => {
    const stale = new Set(["missing", "first"])
    expect(resolvePinnedThreadSlot(threads, stale, 1)?.id).toBe("first")
  })
})

describe("resolveSessionCommandThread", () => {
  const threads = [
    thread("abc123", { title: "Fix the parser" }),
    thread("abc999", { title: "Something else" }),
  ]

  it("falls back to the active thread without a query", () => {
    expect(resolveSessionCommandThread(threads, "abc999", "  ")?.id).toBe(
      "abc999"
    )
  })

  it("prefers an exact id over a prefix", () => {
    expect(resolveSessionCommandThread(threads, null, "abc999")?.id).toBe(
      "abc999"
    )
  })

  it("falls back to an id prefix, then a title match", () => {
    expect(resolveSessionCommandThread(threads, null, "abc1")?.id).toBe(
      "abc123"
    )
    expect(resolveSessionCommandThread(threads, null, "parser")?.id).toBe(
      "abc123"
    )
  })

  it("returns null when nothing matches", () => {
    expect(resolveSessionCommandThread(threads, null, "zzz")).toBeNull()
  })
})

describe("archivedThreadIdsAfterAction", () => {
  it("adds and removes", () => {
    expect(archivedThreadIdsAfterAction(["a"], "b", "archive")).toEqual([
      "a",
      "b",
    ])
    expect(archivedThreadIdsAfterAction(["a", "b"], "b", "unarchive")).toEqual([
      "a",
    ])
  })

  it("is idempotent in both directions", () => {
    expect(archivedThreadIdsAfterAction(["a"], "a", "archive")).toEqual(["a"])
    expect(archivedThreadIdsAfterAction(["a"], "b", "unarchive")).toEqual(["a"])
  })

  it("does not mutate the input", () => {
    const input = ["a"]
    archivedThreadIdsAfterAction(input, "b", "archive")
    expect(input).toEqual(["a"])
  })
})
