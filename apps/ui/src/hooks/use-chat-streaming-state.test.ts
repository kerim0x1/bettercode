import { describe, expect, it } from "vitest"
import type { ThreadActivity } from "@/lib/chat-store"
import {
  derivePersistedPlans,
  samePlanEntries,
} from "./use-chat-streaming-state"

const PLAN = "<proposed_plan>\n# Plan\n\n1. Do the thing\n</proposed_plan>"

function planActivity(id: string, createdAt: string): ThreadActivity {
  return {
    id,
    threadId: "thread-1",
    kind: "turn.proposed.completed",
    tone: "info",
    summary: "Plan",
    payload: { planMarkdown: PLAN },
    createdAt,
  }
}

function toolActivity(id: string): ThreadActivity {
  return {
    id,
    threadId: "thread-1",
    kind: "tool.updated",
    tone: "tool",
    summary: "Read",
    payload: {},
    createdAt: "2026-01-01T00:00:05Z",
  }
}

describe("derivePersistedPlans", () => {
  it("computes once per messages/activities pair and shares the result", () => {
    const messages = [
      {
        id: "m1",
        role: "user",
        content: "plan it",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]
    const activities = [planActivity("plan-1", "2026-01-01T00:00:01Z")]

    const first = derivePersistedPlans(messages, activities)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ id: "plan-1", streaming: false })
    // Another consumer reading the same thread gets the cached array.
    expect(derivePersistedPlans(messages, activities)).toBe(first)
    // A new activities array is a new history and is scanned again.
    const next = derivePersistedPlans(messages, [...activities])
    expect(next).not.toBe(first)
  })

  it("treats a tool event that adds no plan as the same plan list", () => {
    const messages: { id: string; role: string; content: string }[] = []
    const before = derivePersistedPlans(messages, [
      planActivity("plan-1", "2026-01-01T00:00:01Z"),
    ])
    const after = derivePersistedPlans(messages, [
      planActivity("plan-1", "2026-01-01T00:00:01Z"),
      toolActivity("tool-1"),
    ])
    expect(after).not.toBe(before)
    expect(samePlanEntries(before, after)).toBe(true)
  })

  it("notices an implemented plan", () => {
    const messages: { id: string; role: string; content: string }[] = []
    const plan = planActivity("plan-1", "2026-01-01T00:00:01Z")
    const before = derivePersistedPlans(messages, [plan])
    const after = derivePersistedPlans(messages, [
      plan,
      {
        ...toolActivity("impl-1"),
        kind: "turn.proposed.implemented",
        payload: {
          sourceProposedPlan: { threadId: "thread-1", planId: "plan-1" },
        },
      },
    ])
    expect(after[0]?.implemented).toBe(true)
    expect(samePlanEntries(before, after)).toBe(false)
  })
})
