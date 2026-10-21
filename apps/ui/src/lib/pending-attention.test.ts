import { describe, expect, it } from "vitest"
import type { ThreadActivity } from "@/lib/chat-store"
import { deriveThreadAttention } from "./pending-attention"

let sequence = 0

function activity(
  kind: string,
  payload: Record<string, unknown>,
  overrides: Partial<ThreadActivity> = {}
): ThreadActivity {
  sequence += 1
  return {
    id: `activity-${sequence}`,
    threadId: "thread-1",
    kind,
    tone: "info",
    summary: kind,
    payload,
    sequence,
    createdAt: `2026-07-02T10:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...overrides,
  }
}

describe("deriveThreadAttention", () => {
  it("does not revive an approved plan after reordered replay or its legacy capture", () => {
    const capture = activity(
      "turn.proposed.completed",
      { planMarkdown: "# Ship it", planId: "plan-1" },
      { turnId: "turn-1" }
    )
    const requested = activity(
      "plan-approval.requested",
      { requestId: "plan-req" },
      { turnId: "turn-1", sequence: 100 }
    )
    const resolved = activity(
      "plan-approval.resolved",
      { requestId: "plan-req", decision: "approve" },
      { sequence: 1 }
    )
    expect(
      deriveThreadAttention("thread-1", [capture, requested, resolved]).total
    ).toBe(0)
    const later = activity(
      "turn.proposed.completed",
      { planMarkdown: "# Next plan", planId: "plan-2" },
      { turnId: "turn-2" }
    )
    expect(
      deriveThreadAttention("thread-1", [resolved, requested, capture, later])
        .openRequestKeys
    ).toEqual(["plan:thread-1::plan-2"])
    expect(
      deriveThreadAttention("thread-1", [
        capture,
        requested,
        { ...resolved, payload: { requestId: "plan-req", decision: "deny" } },
      ]).planApprovals
    ).toBe(1)
  })
  it("counts open approvals and clears them on resolve", () => {
    const requested = activity("approval.requested", {
      requestId: "req-1",
      tool: "Bash",
      input: { command: "npm test" },
    })
    const open = deriveThreadAttention("thread-1", [requested])
    expect(open.approvals).toBe(1)
    expect(open.total).toBe(1)
    expect(open.openRequestKeys).toEqual(["approval:req-1"])

    const resolved = deriveThreadAttention("thread-1", [
      requested,
      activity("approval.resolved", {
        requestId: "req-1",
        decision: "approve",
      }),
    ])
    expect(resolved.approvals).toBe(0)
    expect(resolved.total).toBe(0)
    expect(resolved.openRequestKeys).toEqual([])
  })

  it("clears approvals via stale-failure activities", () => {
    const attention = deriveThreadAttention("thread-1", [
      activity("approval.requested", { requestId: "req-1", tool: "Edit" }),
      activity("provider.approval.respond.failed", {
        requestId: "req-1",
        detail: "Stale pending approval request: req-1.",
      }),
    ])
    expect(attention.approvals).toBe(0)
    expect(attention.total).toBe(0)
  })

  it("counts open user-input requests with questions", () => {
    const attention = deriveThreadAttention("thread-1", [
      activity("user-input.requested", {
        requestId: "input-1",
        questions: [
          {
            id: "q1",
            header: "Auth",
            question: "Which auth method?",
            options: [
              { label: "OAuth", description: "Standards-based" },
              { label: "API key" },
            ],
            multiSelect: false,
          },
        ],
      }),
    ])
    expect(attention.questions).toBe(1)
    expect(attention.openRequestKeys).toEqual(["input:input-1"])

    const resolved = deriveThreadAttention("thread-1", [
      activity("user-input.requested", {
        requestId: "input-2",
        questions: [{ id: "q1", question: "Pick one", options: ["a"] }],
      }),
      activity("user-input.resolved", { requestId: "input-2" }),
    ])
    expect(resolved.questions).toBe(0)
  })

  it("counts interactive plan approvals and caps plan attention at 1", () => {
    const attention = deriveThreadAttention("thread-1", [
      activity("plan-approval.requested", {
        requestId: "plan-req-1",
        planMarkdown: "## Plan",
      }),
      activity("turn.proposed.completed", {
        planId: "legacy-plan",
        planMarkdown: "## Legacy plan",
      }),
    ])
    expect(attention.planApprovals).toBe(1)
    expect(attention.openRequestKeys).toEqual(["plan:plan-req-1"])

    const resolved = deriveThreadAttention("thread-1", [
      activity("plan-approval.requested", {
        requestId: "plan-req-2",
        planMarkdown: "## Plan",
      }),
      activity("plan-approval.resolved", {
        requestId: "plan-req-2",
        decision: "approve",
      }),
    ])
    expect(resolved.planApprovals).toBe(0)
  })

  it("tracks legacy captured plans until implemented", () => {
    const completed = activity("turn.proposed.completed", {
      planId: "plan-1",
      planMarkdown: "## Do things",
    })
    const open = deriveThreadAttention("thread-1", [completed])
    expect(open.planApprovals).toBe(1)
    expect(open.openRequestKeys).toEqual(["plan:thread-1::plan-1"])

    const implemented = deriveThreadAttention("thread-1", [
      completed,
      activity("turn.proposed.implemented", {
        sourceProposedPlan: { threadId: "thread-1", planId: "plan-1" },
      }),
    ])
    expect(implemented.planApprovals).toBe(0)
  })

  it("ignores empty legacy plan captures", () => {
    const attention = deriveThreadAttention("thread-1", [
      activity("turn.proposed.completed", { planMarkdown: "   " }),
    ])
    expect(attention.planApprovals).toBe(0)
  })

  it("aggregates mixed attention with stable key ordering", () => {
    const attention = deriveThreadAttention("thread-1", [
      activity("approval.requested", { requestId: "req-1", tool: "Bash" }),
      activity("user-input.requested", {
        requestId: "input-1",
        questions: [{ id: "q1", question: "Pick", options: ["a"] }],
      }),
      activity("plan-approval.requested", {
        requestId: "plan-1",
        planMarkdown: "## P",
      }),
    ])
    expect(attention.total).toBe(3)
    expect(attention.openRequestKeys).toEqual([
      "approval:req-1",
      "input:input-1",
      "plan:plan-1",
    ])
  })

  // The phone counts the same requests (`@betterc0de/schema/pending-requests`).
  it("counts a question request without questions, and settles it by any resolution", () => {
    const asked = activity("user-input.requested", { requestId: "input-9" })
    const open = deriveThreadAttention("thread-1", [asked])
    expect(open.questions).toBe(1)
    expect(open.openRequestKeys).toEqual(["input:input-9"])

    const cancelled = deriveThreadAttention("thread-1", [
      asked,
      activity("approval.resolved", {
        requestId: "input-9",
        decision: "cancel",
      }),
    ])
    expect(cancelled.total).toBe(0)
  })
})
