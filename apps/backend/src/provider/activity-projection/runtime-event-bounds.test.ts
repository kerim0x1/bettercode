import { describe, expect, it } from "vitest"
import type { LegacyProviderEvent } from "../types"
import { TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES } from "./output-bounds"
import { boundProviderRuntimeEventForBroadcast } from "./runtime-event-bounds"

const BUDGET = TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function event(
  event_type: string,
  payload: Record<string, unknown>
): LegacyProviderEvent {
  return { event_type, thread_id: "thread-1", payload }
}

describe("boundProviderRuntimeEventForBroadcast", () => {
  it("returns a small event as the same object", () => {
    const small = event("tool_result", { tool_id: "t1", output: "ok" })
    expect(boundProviderRuntimeEventForBroadcast(small)).toBe(small)
  })

  it("bounds a large tool result like its activity", () => {
    const output = `HEAD${"x".repeat(2 * 1024 * 1024)}TAIL`
    const original = event("tool_result", {
      turn_id: "turn-1",
      tool_id: "tool-big",
      tool_name: "exec_command",
      input: { command: "cat big.log" },
      output,
    })

    const bounded = boundProviderRuntimeEventForBroadcast(original)
    const payload = bounded.payload

    expect(bounded).not.toBe(original)
    expect(bounded.event_type).toBe("tool_result")
    expect(bounded.thread_id).toBe("thread-1")
    expect(jsonBytes(payload)).toBeLessThanOrEqual(BUDGET)
    expect(payload.tool_id).toBe("tool-big")
    expect(payload.tool_name).toBe("exec_command")
    expect(payload.turn_id).toBe("turn-1")
    expect(payload.input).toEqual({ command: "cat big.log" })
    expect(String(payload.output).startsWith("HEAD")).toBe(true)
    expect(String(payload.output).endsWith("TAIL")).toBe(true)
    expect(payload.outputTruncated).toBe(true)
    expect(payload.outputBytes).toBe(Buffer.byteLength(output, "utf8"))
    // Only the wire copy is bounded.
    expect(original.payload.output).toBe(output)
  })

  it("cuts a cumulative tool snapshot so that it still reads as one", () => {
    const snapshot = "s".repeat(512 * 1024)
    const bounded = boundProviderRuntimeEventForBroadcast(
      event("tool_call_delta", {
        tool_id: "tool-1",
        output_delta: snapshot,
        detail: snapshot,
      })
    )

    expect(jsonBytes(bounded.payload)).toBeLessThanOrEqual(BUDGET)
    // `isCumulativeToolOutputPayload` compares the two copies.
    expect(bounded.payload.output_delta).toBe(bounded.payload.detail)
  })

  it("bounds a tool item but never an assistant message item", () => {
    const text = "m".repeat(512 * 1024)
    const message = event("item.completed", {
      itemType: "assistant_message",
      text,
    })
    const command = event("item.completed", {
      itemType: "command_execution",
      item_id: "item-1",
      output: text,
    })

    expect(boundProviderRuntimeEventForBroadcast(message)).toBe(message)
    expect(
      jsonBytes(boundProviderRuntimeEventForBroadcast(command).payload)
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("leaves assistant text, plans and questions whole", () => {
    const large = "p".repeat(512 * 1024)
    const untouched = [
      event("content_replace", { text: large }),
      event("turn.proposed.completed", { planMarkdown: large }),
      event("request.opened", {
        requestId: "plan-1",
        kind: "plan_approval",
        input: { plan: large },
      }),
      event("request.opened", {
        requestId: "question-1",
        kind: "user_input",
        questions: [{ question: large }],
      }),
      event("request.opened", {
        requestId: "question-2",
        requestType: "tool_user_input",
        input: { questions: [{ question: large }] },
      }),
    ]
    for (const original of untouched) {
      expect(boundProviderRuntimeEventForBroadcast(original)).toBe(original)
    }
  })

  it("bounds an approval request's input and keeps what answers it", () => {
    const content = "w".repeat(1024 * 1024)
    const original = event("tool_approval_requested", {
      requestId: "req-1",
      providerKind: "claude",
      tool: "Write",
      input: { file_path: "/repo/a.txt", content },
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Write", ruleContent: "/repo/a.txt" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    })

    const bounded = boundProviderRuntimeEventForBroadcast(original)
    const payload = bounded.payload
    const input = payload.input as { file_path: string; content: string }

    expect(jsonBytes(payload)).toBeLessThanOrEqual(BUDGET)
    expect(payload.requestId).toBe("req-1")
    expect(payload.providerKind).toBe("claude")
    expect(payload.tool).toBe("Write")
    expect(payload.suggestions).toBe(original.payload.suggestions)
    expect(input.file_path).toBe("/repo/a.txt")
    expect(input.content).toContain("[input truncated:")
    expect(payload.inputTruncated).toBe(true)
  })

  it("keeps a canonical approval's command whole", () => {
    const command = `echo ${"a".repeat(200 * 1024)}`
    const original = event("request.opened", {
      requestId: "req-2",
      requestType: "command_execution_approval",
      input: { command },
    })

    const bounded = boundProviderRuntimeEventForBroadcast(original)

    expect((bounded.payload.input as { command: string }).command).toBe(command)
  })
})
