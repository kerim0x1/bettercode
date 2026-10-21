import { describe, expect, it } from "vitest"
import type { ThreadActivity } from "@betterc0de/schema"
import {
  boundThreadActivity,
  TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS,
  TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES,
} from "@betterc0de/schema/output-bounds"
import {
  boundLiveToolActivity,
  OUTPUT_BOUNDED_IN_RENDERER,
} from "./tool-output-bounds"

// The bound itself is shared with the backend and tested with it
// (apps/backend/src/provider/activity-projection/output-bounds.test.ts).
// These cases cover what the renderer adds: the flag, and nothing else.

const BUDGET = TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES
const encoder = new TextEncoder()

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

const base: ThreadActivity = {
  id: "thread-1::tool.completed::tool-1",
  threadId: "thread-1",
  turnId: "turn-1",
  kind: "tool.completed",
  tone: "tool",
  summary: "Ran command",
  payload: {},
  sequence: 7,
  createdAt: "2026-10-07T00:00:00.000Z",
}

/**
 * The same activity as the backend stores it (`ThreadActivityProjection`),
 * bounded the way the backend bounds every row it projects.
 */
function boundAsStored(activity: ThreadActivity) {
  return boundThreadActivity({
    activity_id: activity.id,
    thread_id: activity.threadId,
    turn_id: activity.turnId ?? null,
    kind: activity.kind,
    tone: activity.tone,
    summary: activity.summary,
    payload: activity.payload,
    sequence: activity.sequence ?? null,
    created_at: activity.createdAt,
  })
}

describe("boundLiveToolActivity", () => {
  it("leaves non-tool activities alone, however large", () => {
    const plan: ThreadActivity = {
      ...base,
      kind: "turn.proposed.completed",
      payload: { planMarkdown: "p".repeat(512 * 1024) },
    }
    expect(boundLiveToolActivity(plan)).toBe(plan)
  })

  it("returns a small tool activity as the same object", () => {
    const small = { ...base, payload: { toolId: "tool-1", output: "ok" } }
    expect(boundLiveToolActivity(small)).toBe(small)
  })

  it("bounds the payload, the summary and the presentation, and marks the cut as the renderer's", () => {
    const output = "z".repeat(1024 * 1024)
    const activity: ThreadActivity = {
      ...base,
      summary: `Fetch: ${output}`,
      payload: {
        toolId: "tool-1",
        output,
        presentation: { summary: "Fetch", detail: output },
      },
    }

    const bounded = boundLiveToolActivity(activity)
    const payload = bounded.payload as Record<string, unknown>
    const presentation = payload.presentation as { detail: string }

    expect(bounded.summary.length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS
    )
    expect(presentation.detail.length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS
    )
    expect(jsonBytes(payload)).toBeLessThanOrEqual(BUDGET + 64)
    expect(payload.outputTruncated).toBe(true)
    expect(payload.outputBytes).toBe(1024 * 1024)
    expect(payload[OUTPUT_BOUNDED_IN_RENDERER]).toBe(true)
    expect(bounded.id).toBe(activity.id)
    expect(bounded.sequence).toBe(activity.sequence)
  })

  it("does not mark an activity whose only change is a shorter summary", () => {
    const activity: ThreadActivity = {
      ...base,
      summary: "s".repeat(TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS + 10),
      payload: { toolId: "tool-1", output: "ok" },
    }

    const bounded = boundLiveToolActivity(activity)

    expect(bounded.summary.length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS
    )
    expect(bounded.payload).toBe(activity.payload)
  })

  it("does not mark an activity whose only change is shorter presentation text", () => {
    const activity: ThreadActivity = {
      ...base,
      payload: {
        toolId: "tool-1",
        output: "ok",
        presentation: { summary: "Read", detail: "d".repeat(5_000) },
      },
    }

    const bounded = boundLiveToolActivity(activity)
    const payload = bounded.payload as Record<string, unknown>

    expect(payload.presentation).not.toBe(
      (activity.payload as Record<string, unknown>).presentation
    )
    expect(payload[OUTPUT_BOUNDED_IN_RENDERER]).toBeUndefined()
    expect(payload.truncatedFields).toBeUndefined()
  })

  it("bounds a payload exactly as the backend stores it, plus the flag", () => {
    const output = `HEAD${"x".repeat(2 * 1024 * 1024)}TAIL`
    const payloads: Array<Record<string, unknown>> = [
      // A mirrored string output next to the call's input.
      {
        toolId: "tool-1",
        tool_name: "exec_command",
        input: { command: "cat big.log" },
        output,
        detail: output,
      },
      // Structured MCP content.
      {
        toolId: "mcp-1",
        output: {
          content: [
            { type: "text", text: `first\n${"row\n".repeat(300_000)}last` },
            { type: "text", text: "trailer" },
          ],
          isError: false,
        },
      },
      // Large without one large string: the structural pass.
      {
        toolId: "grok-1",
        output: {
          stdout: Array.from({ length: 200_000 }, (_, index) => index % 256),
          exit_code: 0,
        },
      },
      // Only the input is over the budget.
      { toolId: "write-1", input: { content: "c".repeat(512 * 1024) } },
      // Multi-byte text, surrogate pairs, lone surrogates and a BOM.
      {
        toolId: "utf-1",
        output: `\uFEFF${"a😀é€\uD800".repeat(60_000)}`,
        presentation: { summary: "Run", detail: "é".repeat(5_000) },
      },
    ]

    for (const payload of payloads) {
      const activity: ThreadActivity = {
        ...base,
        summary: `Ran: ${"s".repeat(3_000)}`,
        payload,
      }

      const live = boundLiveToolActivity(activity)
      const stored = boundAsStored(activity)

      // The case is one the bound cuts.
      expect(stored.payload).not.toBe(payload)
      expect(live.summary).toBe(stored.summary)
      expect(JSON.stringify(live.payload)).toBe(
        JSON.stringify({
          ...(stored.payload as Record<string, unknown>),
          [OUTPUT_BOUNDED_IN_RENDERER]: true,
        })
      )
    }
  })
})
