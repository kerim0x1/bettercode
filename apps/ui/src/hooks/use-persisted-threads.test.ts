import {
  mergePersistedThreadSkeletons,
  mergePersistedThreadGoals,
  waitForRetry,
} from "@/hooks/use-persisted-threads"
import type { ThreadGoal } from "@betterc0de/schema"
import { useChatStore, type ChatThread } from "@/lib/chat-store"
import { afterEach, describe, expect, it, vi } from "vitest"

function thread(id: string, messages: ChatThread["messages"] = []): ChatThread {
  return {
    id,
    title: id,
    projectName: "Project",
    projectPath: "/repo",
    messages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("mergePersistedThreadSkeletons", () => {
  it("keeps a task created while the initial thread request was in flight", () => {
    const local = thread("new-task")
    const persisted = thread("saved-chat")

    expect(
      mergePersistedThreadSkeletons([local], [persisted]).map((item) => item.id)
    ).toEqual(["new-task", "saved-chat"])
  })

  it("does not replace already hydrated messages with an empty skeleton", () => {
    const message: ChatThread["messages"][number] = {
      id: "message-1",
      role: "user",
      content: "keep me",
      createdAt: "2026-01-01T00:00:01.000Z",
    }
    const current = thread("saved-chat", [message])
    const staleSnapshot = { ...thread("saved-chat"), title: "stale title" }

    const [merged] = mergePersistedThreadSkeletons([current], [staleSnapshot])

    expect(merged).toBe(current)
    expect(merged.messages).toEqual([message])
  })
})

describe("restoring provider goals", () => {
  const goal: ThreadGoal = {
    objective: "Finish migration",
    status: "active",
    startedAt: 1000,
    updatedAt: 2000,
    providerKind: "codex",
    tokens: 123,
  }
  it("restores a backend goal while retaining model preferences changed during loading", () => {
    const before = { saved: { goalRevision: 2 } }
    const current = { saved: { goalRevision: 2, model: "new-model" } }
    const result = mergePersistedThreadGoals(
      current,
      [{ ...thread("saved"), goal }],
      before
    )
    expect(result.saved).toMatchObject({ goal, model: "new-model" })
  })
  it("restores a durable clear and keeps legacy state when the backend has not observed a goal", () => {
    const current = { saved: { goal }, legacy: { goal } }
    const result = mergePersistedThreadGoals(
      current,
      [{ ...thread("saved"), goal: null }, thread("legacy")],
      current
    )
    expect(result.saved.goal).toBeNull()
    expect(result.legacy).toBe(current.legacy)
  })
  it("never resurrects a goal cleared by a newer live event, even when both local values are null", () => {
    const before = { saved: { goal: null, goalRevision: 3 } }
    const current = { saved: { goal: null, goalRevision: 4 } }
    expect(
      mergePersistedThreadGoals(current, [{ ...thread("saved"), goal }], before)
    ).toBe(current)
  })
  it("increments the live revision for repeated clear notifications", () => {
    useChatStore.setState({ settingsByThread: {} })
    useChatStore.getState().setThreadSetting("saved", "goal", null)
    const before = useChatStore.getState().settingsByThread
    useChatStore.getState().setThreadSetting("saved", "goal", null)
    const current = useChatStore.getState().settingsByThread
    expect(current.saved.goalRevision).toBe(
      (before.saved.goalRevision ?? 0) + 1
    )
    expect(
      mergePersistedThreadGoals(current, [{ ...thread("saved"), goal }], before)
    ).toBe(current)
  })
})

describe("retrying the initial thread load", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function stubShell() {
    let report!: (event: unknown) => void
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
      electronAPI: {
        onBackendStatus: (callback: (event: unknown) => void) => {
          report = callback
          return () => {}
        },
      },
    })
    return (event: unknown) => report(event)
  }

  it("retries at once when the backend reports ready instead of waiting out the backoff", async () => {
    vi.useFakeTimers()
    const report = stubShell()
    const done = vi.fn()
    void waitForRetry(5_000, new AbortController().signal).then(done)
    await vi.advanceTimersByTimeAsync(100)
    expect(done).not.toHaveBeenCalled()

    report({ status: "ready", port: 4600 })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("still retries after the backoff delay without any event", async () => {
    vi.useFakeTimers()
    stubShell()
    const done = vi.fn()
    void waitForRetry(500, new AbortController().signal).then(done)
    await vi.advanceTimersByTimeAsync(500)
    expect(done).toHaveBeenCalledOnce()
  })

  it("returns on unmount", async () => {
    stubShell()
    const controller = new AbortController()
    const waiting = waitForRetry(60_000, controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBeUndefined()
  })
})
