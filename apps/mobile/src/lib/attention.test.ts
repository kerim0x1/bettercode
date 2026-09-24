import { describe, expect, it } from "vitest"
import type { PendingRequest } from "@/types/remote"
import { attentionSummary, threadAttention } from "./attention"

const request = (kind: PendingRequest["kind"], id: string): PendingRequest => ({
  id,
  threadId: "thread-1",
  kind,
  providerKind: "claude",
  providerInstanceId: null,
  title: "Request",
})

describe("what a chat waits for", () => {
  it("is nothing without open requests", () => {
    expect(threadAttention(undefined)).toBeNull()
    expect(threadAttention([])).toBeNull()
  })

  it("counts approvals, questions and plan reviews, and says so", () => {
    const attention = threadAttention([
      request("approval", "a"),
      request("approval", "b"),
      request("user-input", "c"),
      request("plan", "d"),
    ])!
    expect(attention).toEqual({
      approvals: 2,
      questions: 1,
      plans: 1,
      total: 4,
    })
    expect(attentionSummary(attention)).toBe(
      "2 approvals, 1 question and a plan review"
    )
    expect(attentionSummary(threadAttention([request("approval", "a")])!)).toBe(
      "1 approval"
    )
    expect(
      attentionSummary(
        threadAttention([request("user-input", "a"), request("plan", "b")])!
      )
    ).toBe("1 question and a plan review")
  })
})
