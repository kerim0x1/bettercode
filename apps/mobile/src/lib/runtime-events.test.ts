import { describe, expect, it } from "vitest"
import {
  decodeRuntimeFrame,
  eventDelta,
  isReplayGapFrame,
  isTurnTerminal,
  pendingRequestFromEvent,
  reasoningDelta,
  replacementText,
  resolvedRequestId,
} from "./runtime-events"

describe("mobile runtime event decoding", () => {
  it.each([" ", "\n", "\t", ""])(
    "preserves whitespace-only stream chunks: %j",
    (delta) => {
      const frame = (type: string) =>
        decodeRuntimeFrame({
          channel: "provider.runtimeEvent",
          data: { type, threadId: "thread", payload: { delta } },
        })!
      expect(eventDelta(frame("content.delta"))).toBe(delta)
      expect(reasoningDelta(frame("reasoning.delta"))).toBe(delta)
    }
  )
  it("reads the tool and the provider's Always allow suggestions of an approval", () => {
    const scoped = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm run lint" }],
      behavior: "allow",
      destination: "localSettings",
    }
    const request = pendingRequestFromEvent(
      decodeRuntimeFrame({
        channel: "provider.runtimeEvent",
        data: {
          event_type: "tool_approval_requested",
          thread_id: "thread-1",
          providerKind: "claude",
          payload: {
            requestId: "approval-1",
            tool_name: "Bash",
            input: { command: "npm run lint" },
            // Malformed suggestions are dropped, not trusted.
            suggestions: [scoped, { type: "addRules", rules: "everything" }],
          },
        },
      })!
    )
    expect(request).toMatchObject({
      kind: "approval",
      toolName: "Bash",
      suggestions: [scoped],
    })
    const question = pendingRequestFromEvent(
      decodeRuntimeFrame({
        channel: "provider.runtimeEvent",
        data: {
          event_type: "user_input_requested",
          thread_id: "thread-1",
          payload: { requestId: "question-1", toolName: "AskUserQuestion" },
        },
      })!
    )
    expect(question?.toolName).toBeUndefined()
  })

  it("recognizes replay gaps that require durable rehydration", () => {
    expect(
      isReplayGapFrame({
        type: "provider_replay_gap",
        reason: "journal_changed",
      })
    ).toBe(true)
    expect(isReplayGapFrame({ type: "provider_replay_complete" })).toBe(false)
  })

  it("decodes canonical streamed assistant content", () => {
    const event = decodeRuntimeFrame({
      channel: "provider.runtimeEvent",
      data: {
        type: "content.delta",
        threadId: "thread-1",
        turnId: "turn-1",
        providerKind: "codex",
        payload: { streamKind: "assistant_text", delta: "Hallo" },
      },
    })
    expect(event).not.toBeNull()
    expect(eventDelta(event!)).toBe("Hallo")
    expect(reasoningDelta(event!)).toBeNull()
  })

  it("keeps reasoning out of the visible assistant stream", () => {
    const event = decodeRuntimeFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "reasoning_delta",
        thread_id: "thread-1",
        payload: { delta: "prüfen", streamKind: "reasoning_text" },
      },
    })!
    expect(reasoningDelta(event)).toBe("prüfen")
    expect(eventDelta(event)).toBeNull()
  })

  it("supports legacy replacement events", () => {
    const event = decodeRuntimeFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "content_replace",
        thread_id: "thread-1",
        payload: { text: "Vollständige Antwort" },
      },
    })!
    expect(replacementText(event)).toEqual({
      kind: "content",
      text: "Vollständige Antwort",
    })
  })

  it("normalizes an approval request and its resolution", () => {
    const opened = decodeRuntimeFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "tool_approval_requested",
        thread_id: "thread-1",
        payload: {
          providerKind: "codex",
          providerInstanceId: "codex-work",
          requestId: "request-1",
          tool: "Run npm test",
          input: { command: "npm test" },
        },
      },
    })!
    expect(pendingRequestFromEvent(opened)).toMatchObject({
      id: "request-1",
      kind: "approval",
      providerKind: "codex",
      providerInstanceId: "codex-work",
    })

    const resolved = decodeRuntimeFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "tool_approval_resolved",
        thread_id: "thread-1",
        payload: { requestId: "request-1" },
      },
    })!
    expect(resolvedRequestId(resolved)).toBe("request-1")
  })

  it("routes a canonical user-input request by its kind, like the desktop", () => {
    const opened = decodeRuntimeFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "request.opened",
        thread_id: "thread-1",
        payload: {
          providerKind: "claude",
          requestId: "question-1",
          kind: "user_input",
          questions: [
            { id: "q1", question: "Which branch?", options: ["main", "dev"] },
          ],
        },
      },
    })!
    expect(pendingRequestFromEvent(opened)).toMatchObject({
      id: "question-1",
      kind: "user-input",
      title: "Input required",
      questions: [{ id: "q1", question: "Which branch?" }],
    })

    // Without a kind the canonical open is still a tool approval.
    const approval = decodeRuntimeFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "request.opened",
        thread_id: "thread-1",
        payload: { providerKind: "claude", requestId: "tool-1", tool: "Bash" },
      },
    })!
    expect(pendingRequestFromEvent(approval)?.kind).toBe("approval")
  })

  it("keeps plan markdown visible on approval requests", () => {
    const event = decodeRuntimeFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "plan_approval_requested",
        thread_id: "thread-1",
        payload: {
          providerKind: "claude",
          requestId: "plan-1",
          planMarkdown: "## Plan\n\n- Tests ergänzen",
        },
      },
    })!
    expect(pendingRequestFromEvent(event)).toMatchObject({
      id: "plan-1",
      kind: "plan",
      detail: "## Plan\n\n- Tests ergänzen",
    })
  })

  it("recognizes canonical and legacy terminal turns", () => {
    expect(isTurnTerminal("turn.completed")).toBe(true)
    expect(isTurnTerminal("turn_error")).toBe(true)
    expect(isTurnTerminal("content_delta")).toBe(false)
  })
})
