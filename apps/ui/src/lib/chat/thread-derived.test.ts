import { describe, expect, it } from "vitest"
import type { ThreadActivity } from "@betterc0de/schema"
import { threadProviderLock } from "./thread-derived"

function activity(
  id: string,
  overrides: Partial<ThreadActivity> = {}
): ThreadActivity {
  return {
    id,
    threadId: "thread-1",
    kind: "tool.updated",
    tone: "tool",
    summary: "tool",
    payload: {},
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("threadProviderLock", () => {
  it("reads the newest provider instance and continuation key", () => {
    const lock = threadProviderLock([
      activity("a", {
        providerInstanceId: "old",
        payload: { continuationKey: "k1" },
      }),
      activity("b", { providerInstanceId: "codex-work" }),
    ])
    expect(lock).toEqual({ instanceId: "codex-work", continuationKey: "k1" })
  })

  it("is computed once per activities array", () => {
    const activities = [activity("a", { providerInstanceId: "p" })]
    expect(threadProviderLock(activities)).toBe(threadProviderLock(activities))
    expect(threadProviderLock([...activities])).not.toBe(
      threadProviderLock(activities)
    )
  })

  it("is empty without provider activities", () => {
    expect(threadProviderLock([])).toEqual({
      instanceId: null,
      continuationKey: null,
    })
  })
})
