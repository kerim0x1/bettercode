import { describe, expect, it, vi } from "vitest"

// The default deps pull in the backend client and the stores; the helper is
// exercised with injected ones so the decision flow is tested on its own.
vi.mock("@/services/backend/chatApi", () => ({
  respondToPlanApproval: vi.fn(),
}))
vi.mock("@/lib/preferences-store", () => ({
  usePreferencesStore: { getState: () => ({ set: vi.fn() }) },
}))
vi.mock("@/components/chat/approval-request-context", () => ({
  recordRequestResponseFailure: vi.fn(),
}))

import {
  submitPlanApprovalDecision,
  type PlanApprovalSubmitDeps,
} from "./plan-approval-submit"

const PLAN = {
  providerKind: "claude",
  requestId: "plan-1",
  providerInstanceId: "claude-main",
}

function deps(respond: PlanApprovalSubmitDeps["respond"]) {
  return {
    respond,
    recordFailure: vi.fn<PlanApprovalSubmitDeps["recordFailure"]>(),
    setPermissionLevel: vi.fn<PlanApprovalSubmitDeps["setPermissionLevel"]>(),
  } satisfies PlanApprovalSubmitDeps
}

describe("submitPlanApprovalDecision", () => {
  it("posts the decision and switches the composer to allow-edits on approve+acceptEdits", async () => {
    const respond = vi.fn(async () => ({ ok: true }))
    const d = deps(respond)

    await expect(
      submitPlanApprovalDecision(
        "thread-1",
        PLAN,
        "approve",
        { permissionMode: "acceptEdits" },
        d
      )
    ).resolves.toBe(true)

    expect(respond).toHaveBeenCalledWith(
      "thread-1",
      "claude",
      "plan-1",
      "approve",
      "claude-main",
      { permissionMode: "acceptEdits" }
    )
    expect(d.setPermissionLevel).toHaveBeenCalledWith("allow-edits")
    expect(d.recordFailure).not.toHaveBeenCalled()
  })

  it("leaves the permission chip alone for manual approvals and feedback", async () => {
    const d = deps(vi.fn(async () => ({ ok: true })))
    await submitPlanApprovalDecision(
      "thread-1",
      PLAN,
      "approve",
      { permissionMode: "default" },
      d
    )
    await submitPlanApprovalDecision(
      "thread-1",
      { ...PLAN, providerInstanceId: undefined },
      "deny",
      { message: "shorter" },
      d
    )
    expect(d.setPermissionLevel).not.toHaveBeenCalled()
    expect(d.respond).toHaveBeenLastCalledWith(
      "thread-1",
      "claude",
      "plan-1",
      "deny",
      null,
      { message: "shorter" }
    )
  })

  it("records a refused response as a failed activity instead of throwing", async () => {
    const error = Object.assign(
      new Error("Provider claude refused the plan response"),
      { status: 502 }
    )
    const d = deps(vi.fn(async () => Promise.reject(error)))

    await expect(
      submitPlanApprovalDecision(
        "thread-1",
        PLAN,
        "approve",
        { permissionMode: "acceptEdits" },
        d
      )
    ).resolves.toBe(false)

    expect(d.recordFailure).toHaveBeenCalledWith({
      threadId: "thread-1",
      requestId: "plan-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      requestKind: "plan-approval",
      error,
    })
    // A refused approval must not flip the composer to allow-edits.
    expect(d.setPermissionLevel).not.toHaveBeenCalled()
  })
})
