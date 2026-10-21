import { describe, expect, it } from "vitest"
import type { ThreadActivity } from "@betterc0de/schema"
import { buildUserInputAnswerPayload } from "./permission-commands"
import { buildPendingUserInputsOutput } from "./request-actions"
import {
  deriveChatPendingApprovals,
  deriveChatPendingUserInputs,
} from "./session-commands"

function activity(overrides: Partial<ThreadActivity>): ThreadActivity {
  return {
    id: overrides.id ?? "activity",
    threadId: "thread-1",
    kind: "approval.requested",
    tone: "approval",
    summary: "Approval requested",
    payload: {},
    sequence: 1,
    createdAt: "2026-10-07T10:00:00.000Z",
    ...overrides,
  }
}

describe("deriveChatPendingApprovals", () => {
  it("settles a request whose resolution sorts before it", () => {
    const approvals = deriveChatPendingApprovals([
      activity({
        id: "resolved",
        kind: "approval.resolved",
        tone: "info",
        sequence: 1,
        payload: { requestId: "req-early" },
      }),
      activity({
        id: "requested",
        sequence: 2,
        payload: { requestId: "req-early", toolName: "shell" },
      }),
      activity({
        id: "other",
        sequence: 3,
        payload: {
          requestId: "req-open",
          providerKind: "codex_cli",
          toolName: "edit",
          input: { file_path: "src/app.tsx" },
        },
      }),
    ])

    expect(approvals).toEqual([
      expect.objectContaining({
        requestId: "req-open",
        providerKind: "codex",
        toolName: "edit",
        input: { file_path: "src/app.tsx" },
      }),
    ])
  })

  it("keeps a request open after a transient response failure", () => {
    const approvals = deriveChatPendingApprovals([
      activity({ id: "requested", payload: { requestId: "req-1" } }),
      activity({
        id: "failed",
        kind: "provider.approval.respond.failed",
        tone: "error",
        sequence: 2,
        payload: { requestId: "req-1", detail: "network timeout" },
      }),
    ])

    expect(approvals.map((approval) => approval.requestId)).toEqual(["req-1"])
  })

  it("settles a request the provider no longer knows", () => {
    const approvals = deriveChatPendingApprovals([
      activity({ id: "requested", payload: { requestId: "req-1" } }),
      activity({
        id: "failed",
        kind: "provider.approval.respond.failed",
        tone: "error",
        sequence: 2,
        payload: {
          requestId: "req-1",
          detail: "Unknown pending approval request: req-1",
        },
      }),
    ])

    expect(approvals).toEqual([])
  })
})

describe("deriveChatPendingUserInputs", () => {
  it("keeps a question request without questions open as one free-text answer", () => {
    const inputs = deriveChatPendingUserInputs([
      activity({
        id: "asked",
        kind: "user-input.requested",
        summary: "Provider asks for input",
        payload: {
          requestId: "question-free",
          providerKind: "claude",
          description: "Which branch should I use?",
        },
      }),
    ])

    expect(inputs).toEqual([
      expect.objectContaining({
        requestId: "question-free",
        providerKind: "claude",
        questions: [
          {
            id: "question-free",
            text: "Which branch should I use?",
            options: [],
          },
        ],
      }),
    ])
    expect(buildPendingUserInputsOutput(inputs)).toContain(
      "Which branch should I use?"
    )
    expect(buildUserInputAnswerPayload(inputs[0]!, ["main"])).toEqual({
      ok: true,
      answers: { "question-free": "main" },
    })
  })

  it("settles a question that the provider resolved under another kind", () => {
    const inputs = deriveChatPendingUserInputs([
      activity({
        id: "asked",
        kind: "user-input.requested",
        payload: {
          requestId: "question-cancelled",
          questions: [{ header: "Mode", question: "Which mode?" }],
        },
      }),
      activity({
        id: "cancelled",
        kind: "approval.resolved",
        tone: "info",
        sequence: 2,
        payload: { requestId: "question-cancelled" },
      }),
    ])

    expect(inputs).toEqual([])
  })

  it("keeps the question normalization of the slash commands", () => {
    const inputs = deriveChatPendingUserInputs([
      activity({
        id: "asked",
        kind: "user-input.requested",
        payload: {
          requestId: "question-scope",
          questions: [
            {
              header: "Scope",
              question: "Which scope?",
              options: ["Backend", { label: "Frontend", description: "UI" }],
              multiSelect: true,
            },
          ],
        },
      }),
    ])

    expect(inputs[0]?.questions).toEqual([
      {
        id: "scope",
        header: "Scope",
        text: "Which scope?",
        options: [
          { label: "Backend" },
          { label: "Frontend", description: "UI" },
        ],
        multiSelect: true,
      },
    ])
  })
})
