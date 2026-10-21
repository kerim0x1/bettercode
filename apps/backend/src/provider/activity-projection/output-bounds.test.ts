import * as sharedOutputBounds from "@betterc0de/schema/output-bounds"
import {
  boundApprovalRequestPayload,
  boundThreadActivity,
  boundToolActivity,
  boundToolActivityPayload,
  formatByteSize,
  TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS,
  TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES,
  truncateInlineText,
  truncateTextMiddle,
  utf8ByteLength,
} from "@betterc0de/schema/output-bounds"
import { extractToolOutputText } from "@betterc0de/schema/tool-activity"
import { describe, expect, it } from "vitest"
import type { ThreadActivityProjection } from "../../persistence/projections"
import * as backendOutputBounds from "./output-bounds"

// The bound is shared with the renderer (`@betterc0de/schema/output-bounds`);
// these cases are its suite. `apps/ui/src/lib/tool-output-bounds.test.ts`
// covers the renderer's flag and checks it bounds a payload exactly as the
// backend does.

const BUDGET = TOOL_ACTIVITY_PAYLOAD_BUDGET_BYTES
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

describe("backend output-bounds module", () => {
  it("is the shared implementation", () => {
    expect(backendOutputBounds.boundThreadActivity).toBe(
      sharedOutputBounds.boundThreadActivity
    )
    expect(backendOutputBounds.boundToolActivity).toBe(
      sharedOutputBounds.boundToolActivity
    )
    expect(backendOutputBounds.boundToolActivityPayload).toBe(
      sharedOutputBounds.boundToolActivityPayload
    )
    expect(backendOutputBounds.boundApprovalRequestPayload).toBe(
      sharedOutputBounds.boundApprovalRequestPayload
    )
  })
})

describe("utf8ByteLength", () => {
  const samples = [
    "",
    "ascii",
    "é",
    "€",
    "😀",
    "a😀é€",
    "\uD800",
    "x\uDC00y",
    "\uD83D",
    "\uD83Dx",
    "﻿bom",
  ]

  it("counts what Buffer and TextEncoder encode, lone surrogates included", () => {
    for (const text of samples) {
      expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, "utf8"))
      expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length)
    }
  })

  it("encodes through TextEncoder exactly as Buffer does", () => {
    // The bound cuts the TextEncoder bytes; Buffer was the reference.
    for (const text of samples) {
      expect(
        Buffer.from(new TextEncoder().encode(text)).equals(
          Buffer.from(text, "utf8")
        )
      ).toBe(true)
    }
  })
})

describe("truncateTextMiddle", () => {
  it("returns text within the limit unchanged", () => {
    expect(truncateTextMiddle("hello", 1_024)).toEqual({
      text: "hello",
      truncated: false,
      originalBytes: 5,
    })
  })

  it("keeps the head and the tail and names the sizes in the marker", () => {
    const text = `${"a".repeat(600_000)}${"z".repeat(600_000)}`
    const result = truncateTextMiddle(text, 32 * 1024)

    expect(result.truncated).toBe(true)
    expect(result.originalBytes).toBe(1_200_000)
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      32 * 1024
    )
    expect(result.text.startsWith("aaaa")).toBe(true)
    expect(result.text.endsWith("zzzz")).toBe(true)
    expect(result.text).toMatch(
      /\n… \[output truncated: 1\.1 MiB total, showing the first [\d.]+ KiB and the last [\d.]+ KiB\] …\n/
    )
  })

  it("never splits a multi-byte character or a surrogate pair", () => {
    for (const unit of ["é", "€", "😀", "a😀é"]) {
      for (const limit of [1_024, 1_025, 1_026, 1_027, 2_049]) {
        const result = truncateTextMiddle(unit.repeat(5_000), limit)
        expect(result.truncated).toBe(true)
        expect(result.text).not.toContain("�")
        expect(result.text).not.toMatch(LONE_SURROGATE)
        expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
          limit
        )
      }
    }
  })

  it("keeps a leading byte order mark", () => {
    const result = truncateTextMiddle(`\uFEFF${"b".repeat(10_000)}`, 2_048)
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith("﻿bbb")).toBe(true)
  })
})

describe("truncateInlineText", () => {
  it("cuts with an ellipsis and keeps surrogate pairs whole", () => {
    const text = `${"x".repeat(TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS - 2)}😀😀😀`
    const cut = truncateInlineText(text)
    expect(cut.length).toBeLessThanOrEqual(TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS)
    expect(cut.endsWith("…")).toBe(true)
    expect(cut).not.toMatch(LONE_SURROGATE)
    expect(truncateInlineText("short")).toBe("short")
  })
})

describe("formatByteSize", () => {
  it("uses binary units with at most one decimal", () => {
    expect(formatByteSize(512)).toBe("512 B")
    expect(formatByteSize(32 * 1024)).toBe("32 KiB")
    expect(formatByteSize(1.25 * 1024 * 1024)).toBe("1.3 MiB")
  })
})

describe("boundToolActivityPayload", () => {
  it("returns a payload within the budget as the same object", () => {
    const payload = { toolId: "t1", output: "x".repeat(10_000) }
    expect(boundToolActivityPayload(payload)).toBe(payload)
  })

  it("cuts a large string output and records the original size", () => {
    const output = `HEAD${"x".repeat(2 * 1024 * 1024)}TAIL`
    const payload = {
      toolId: "tool-1",
      tool_name: "exec_command",
      input: { command: "cat big.log" },
      output,
      detail: output,
    }

    const bounded = boundToolActivityPayload(payload)

    expect(jsonBytes(bounded)).toBeLessThanOrEqual(BUDGET)
    expect(bounded.toolId).toBe("tool-1")
    expect(bounded.input).toEqual({ command: "cat big.log" })
    expect(String(bounded.output).startsWith("HEAD")).toBe(true)
    expect(String(bounded.output).endsWith("TAIL")).toBe(true)
    expect(String(bounded.output)).toContain("[output truncated: 2 MiB total")
    // Mirrored copies are cut the same way, so `output_delta === detail`
    // style comparisons keep holding.
    expect(bounded.detail).toBe(bounded.output)
    expect(bounded.outputTruncated).toBe(true)
    expect(bounded.outputBytes).toBe(Buffer.byteLength(output, "utf8"))
    expect(bounded.truncatedFields).toEqual(["output", "detail"])
  })

  it("keeps the tool input whole when the output alone can be cut to fit", () => {
    const content = "file body ".repeat(2_000)
    const payload = {
      toolId: "write-1",
      input: { file_path: "/tmp/a.txt", content },
      output: "y".repeat(1024 * 1024),
    }

    const bounded = boundToolActivityPayload(payload)

    expect(jsonBytes(bounded)).toBeLessThanOrEqual(BUDGET)
    expect(bounded.input).toBe(payload.input)
    expect(bounded.truncatedFields).toEqual(["output"])
  })

  it("cuts the input too when it alone is over the budget", () => {
    const payload = {
      toolId: "write-2",
      input: { content: "c".repeat(512 * 1024) },
    }

    const bounded = boundToolActivityPayload(payload)

    expect(jsonBytes(bounded)).toBeLessThanOrEqual(BUDGET)
    expect(bounded.truncatedFields).toEqual(["input.content"])
    // Only output fields set the output flag.
    expect(bounded.outputTruncated).toBeUndefined()
  })

  it("keeps the shape of structured MCP content", () => {
    const text = `first line\n${"row\n".repeat(300_000)}last line`
    const payload = {
      toolId: "mcp-1",
      output: {
        content: [
          { type: "text", text },
          { type: "text", text: "trailer" },
        ],
        isError: false,
      },
    }

    const bounded = boundToolActivityPayload(payload)
    const output = bounded.output as {
      content: Array<{ type: string; text: string }>
      isError: boolean
    }

    expect(jsonBytes(bounded)).toBeLessThanOrEqual(BUDGET)
    expect(output.isError).toBe(false)
    expect(output.content).toHaveLength(2)
    expect(output.content[0]!.type).toBe("text")
    expect(output.content[0]!.text.startsWith("first line")).toBe(true)
    expect(output.content[0]!.text.endsWith("last line")).toBe(true)
    expect(output.content[1]!.text).toBe("trailer")
    expect(extractToolOutputText(output)).toContain("first line")
    expect(bounded.truncatedFields).toEqual(["output.content[0].text"])
  })

  it("replaces a huge non-string value with a cut copy of its JSON", () => {
    const bytes = Array.from({ length: 200_000 }, (_, index) => index % 256)
    const payload = {
      toolId: "grok-1",
      output: { stdout: bytes, exit_code: 0 },
    }

    const bounded = boundToolActivityPayload(payload)

    expect(jsonBytes(bounded)).toBeLessThanOrEqual(BUDGET)
    expect(bounded.toolId).toBe("grok-1")
    expect(bounded.outputTruncated).toBe(true)
    expect(bounded.outputBytes).toBe(jsonBytes(payload.output))
    expect(bounded.truncatedFields).toEqual(["output.stdout"])
    const output = bounded.output as { stdout: unknown; exit_code: number }
    expect(output.exit_code).toBe(0)
    expect(typeof output.stdout).toBe("string")
    expect(String(output.stdout)).toContain("[output truncated:")
  })

  it("never cuts identity keys", () => {
    const toolId = `tool-${"i".repeat(4_000)}`
    const payload = { toolId, output: "o".repeat(512 * 1024) }

    const bounded = boundToolActivityPayload(payload)

    expect(bounded.toolId).toBe(toolId)
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(BUDGET)
  })
})

describe("boundToolActivity", () => {
  const base: ThreadActivityProjection = {
    activity_id: "thread-1::tool.completed::tool-1",
    thread_id: "thread-1",
    turn_id: "turn-1",
    kind: "tool.completed",
    tone: "tool",
    summary: "Ran command",
    payload: {},
    sequence: 7,
    created_at: "2026-10-07T00:00:00.000Z",
  }

  it("leaves non-tool activities alone, however large", () => {
    const plan: ThreadActivityProjection = {
      ...base,
      kind: "turn.proposed.completed",
      payload: { planMarkdown: "p".repeat(512 * 1024) },
    }
    expect(boundToolActivity(plan)).toBe(plan)
  })

  it("returns a small tool activity as the same object", () => {
    const small = { ...base, payload: { toolId: "tool-1", output: "ok" } }
    expect(boundToolActivity(small)).toBe(small)
  })

  it("bounds the payload, the summary and the presentation text", () => {
    const output = "z".repeat(1024 * 1024)
    const activity: ThreadActivityProjection = {
      ...base,
      summary: `Fetch: ${output}`,
      payload: {
        toolId: "tool-1",
        output,
        presentation: { summary: "Fetch", detail: output },
      },
    }

    const bounded = boundToolActivity(activity)
    const payload = bounded.payload as Record<string, unknown>
    const presentation = payload.presentation as { detail: string }

    expect(bounded.summary.length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS
    )
    expect(presentation.detail.length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_INLINE_TEXT_MAX_CHARS
    )
    expect(jsonBytes(payload)).toBeLessThanOrEqual(BUDGET)
    expect(payload.outputTruncated).toBe(true)
    expect(payload.outputBytes).toBe(1024 * 1024)
  })
})

describe("boundApprovalRequestPayload", () => {
  it("returns a payload within the budget as the same object", () => {
    const payload = {
      requestId: "req-1",
      toolName: "Write",
      input: { file_path: "/repo/a.txt", content: "small" },
    }
    expect(boundApprovalRequestPayload(payload)).toBe(payload)
  })

  it("cuts a large file body, marks it as input and keeps what the card needs", () => {
    const content = `BEGIN${"c".repeat(512 * 1024)}END`
    const suggestions = [
      {
        type: "addRules",
        rules: [{ toolName: "Write", ruleContent: "/repo/a.txt" }],
        behavior: "allow",
        destination: "session",
      },
    ]
    const payload = {
      requestId: "req-1",
      providerKind: "claude",
      toolName: "Write",
      requestKind: "file_change",
      suggestions,
      input: { file_path: "/repo/a.txt", content },
    }

    const bounded = boundApprovalRequestPayload(payload)
    const input = bounded.input as { file_path: string; content: string }

    expect(jsonBytes(bounded)).toBeLessThanOrEqual(BUDGET)
    expect(bounded.requestId).toBe("req-1")
    expect(bounded.toolName).toBe("Write")
    expect(bounded.requestKind).toBe("file_change")
    expect(bounded.suggestions).toBe(suggestions)
    expect(input.file_path).toBe("/repo/a.txt")
    expect(input.content.startsWith("BEGIN")).toBe(true)
    expect(input.content.endsWith("END")).toBe(true)
    expect(input.content).toContain("[input truncated: 512 KiB total")
    expect(bounded.inputTruncated).toBe(true)
    expect(bounded.inputBytes).toBe(jsonBytes(payload.input))
    expect(bounded.truncatedFields).toEqual(["input.content"])
    expect(bounded.outputTruncated).toBeUndefined()
  })

  it("never cuts the command a shell approval runs", () => {
    // The card promises the whole command is reachable: a cut could hide
    // the payload of a padded command. Nothing else is large, so the
    // payload stays over the budget rather than lose the command.
    const command = `echo ${"a".repeat(200 * 1024)}`
    const payload = {
      requestId: "req-2",
      toolName: "Bash",
      input: { command, description: "pad" },
    }

    const bounded = boundApprovalRequestPayload(payload)

    expect(bounded).toBe(payload)
    expect((bounded.input as { command: string }).command).toBe(command)
  })

  it("cuts the other input around a whole command", () => {
    const command = "cat > notes.txt"
    const stdin = "s".repeat(256 * 1024)
    const payload = {
      requestId: "req-3",
      toolName: "Bash",
      input: { command, cwd: "/repo", stdin },
    }

    const bounded = boundApprovalRequestPayload(payload)
    const input = bounded.input as {
      command: string
      cwd: string
      stdin: string
    }

    expect(jsonBytes(bounded)).toBeLessThanOrEqual(BUDGET)
    expect(input.command).toBe(command)
    expect(input.cwd).toBe("/repo")
    expect(input.stdin).toContain("[input truncated:")
    expect(bounded.truncatedFields).toEqual(["input.stdin"])
  })

  it("does not replace a record holding a protected key as a whole", () => {
    // Thousands of small edits: no single string to cut, so the structural
    // pass cuts the edit list, never the input record with its path.
    const edits = Array.from({ length: 20_000 }, (_, index) => ({
      old_string: `a${index}`,
      new_string: `b${index}`,
    }))
    const payload = {
      requestId: "req-4",
      toolName: "MultiEdit",
      input: { file_path: "/repo/big.ts", edits },
    }

    const bounded = boundApprovalRequestPayload(payload)
    const input = bounded.input as { file_path: string; edits: unknown }

    expect(jsonBytes(bounded)).toBeLessThanOrEqual(BUDGET)
    expect(input.file_path).toBe("/repo/big.ts")
    expect(typeof input.edits).toBe("string")
    expect(String(input.edits)).toContain("[input truncated:")
    expect(bounded.inputTruncated).toBe(true)
    expect(bounded.truncatedFields).toEqual(["input.edits"])
  })
})

describe("boundThreadActivity", () => {
  const approval: ThreadActivityProjection = {
    activity_id: "thread-1::approval.requested::req-1",
    thread_id: "thread-1",
    turn_id: "turn-1",
    kind: "approval.requested",
    tone: "approval",
    summary: "Approval requested: Write",
    payload: {},
    sequence: 8,
    created_at: "2026-10-07T00:00:00.000Z",
  }

  it("bounds an approval request's payload", () => {
    const activity: ThreadActivityProjection = {
      ...approval,
      payload: {
        requestId: "req-1",
        toolName: "Write",
        input: { file_path: "/repo/a.txt", content: "w".repeat(1024 * 1024) },
      },
    }

    const bounded = boundThreadActivity(activity)
    const payload = bounded.payload as Record<string, unknown>

    expect(bounded.summary).toBe(activity.summary)
    expect(jsonBytes(payload)).toBeLessThanOrEqual(BUDGET)
    expect(payload.requestId).toBe("req-1")
    expect(payload.inputTruncated).toBe(true)
  })

  it("returns a small approval request as the same object", () => {
    const small = {
      ...approval,
      payload: { requestId: "req-1", input: { command: "ls" } },
    }
    expect(boundThreadActivity(small)).toBe(small)
  })

  it("bounds tool activities and leaves other kinds alone", () => {
    const tool: ThreadActivityProjection = {
      ...approval,
      kind: "tool.completed",
      tone: "tool",
      payload: { toolId: "tool-1", output: "o".repeat(512 * 1024) },
    }
    const plan: ThreadActivityProjection = {
      ...approval,
      kind: "plan-approval.requested",
      payload: { requestId: "req-9", planMarkdown: "p".repeat(512 * 1024) },
    }

    expect(jsonBytes(boundThreadActivity(tool).payload)).toBeLessThanOrEqual(
      BUDGET
    )
    expect(boundThreadActivity(plan)).toBe(plan)
  })
})
