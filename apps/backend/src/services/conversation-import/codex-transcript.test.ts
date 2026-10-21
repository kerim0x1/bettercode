import { describe, expect, it } from "vitest"
import { CodexTranscriptParser, isInjectedCodexText } from "./codex-transcript"

// Synthetic rows in the shape Codex writes to
// `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.

const THREAD = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"
const CWD = "/work/codex-demo"

function at(second: number): string {
  return new Date(Date.UTC(2026, 3, 2, 9, 0, second)).toISOString()
}

function envelope(type: string, payload: unknown, second: number): string {
  return JSON.stringify({ timestamp: at(second), type, payload })
}

function meta(second = 0, extra: Record<string, unknown> = {}): string {
  return envelope(
    "session_meta",
    {
      id: THREAD,
      session_id: THREAD,
      timestamp: at(second),
      cwd: CWD,
      originator: "codex_cli",
      cli_version: "0.0.0-test",
      source: "cli",
      base_instructions: { text: "Hidden system prompt" },
      ...extra,
    },
    second
  )
}

function message(role: string, blocks: unknown[], second: number): string {
  return envelope(
    "response_item",
    { type: "message", role, content: blocks },
    second
  )
}

function parse(lines: string[], keepMessages = true) {
  const parser = new CodexTranscriptParser({ keepMessages })
  for (const line of lines) parser.pushLine(line)
  return parser.finish()
}

describe("CodexTranscriptParser", () => {
  it("reads the session, its prompt, reasoning summary, tool calls and reply", () => {
    const transcript = parse([
      meta(0),
      message(
        "developer",
        [{ type: "input_text", text: "Developer instructions" }],
        1
      ),
      message(
        "user",
        [
          {
            type: "input_text",
            text: "# AGENTS.md instructions for /work/codex-demo\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>",
          },
          {
            type: "input_text",
            text: "<environment_context>\n  <cwd>/work/codex-demo</cwd>\n</environment_context>",
          },
        ],
        2
      ),
      envelope(
        "turn_context",
        { cwd: CWD, model: "gpt-test-codex", effort: "medium" },
        3
      ),
      message(
        "user",
        [{ type: "input_text", text: "List the files and explain them" }],
        4
      ),
      envelope(
        "event_msg",
        { type: "user_message", message: "List the files and explain them" },
        4
      ),
      envelope(
        "response_item",
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "**Listing files**" }],
          encrypted_content: "opaque",
        },
        5
      ),
      envelope(
        "response_item",
        {
          type: "function_call",
          name: "shell",
          arguments: JSON.stringify({
            command: ["bash", "-lc", "ls -la"],
            workdir: CWD,
          }),
          call_id: "call_1",
        },
        6
      ),
      envelope(
        "response_item",
        {
          type: "function_call_output",
          call_id: "call_1",
          output: JSON.stringify({
            output: "a.txt\nb.txt",
            metadata: { exit_code: 0 },
          }),
        },
        7
      ),
      envelope(
        "response_item",
        {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch\n" + "+x\n".repeat(500),
          call_id: "call_2",
        },
        8
      ),
      envelope(
        "response_item",
        {
          type: "custom_tool_call_output",
          call_id: "call_2",
          output: "Success",
        },
        9
      ),
      message(
        "assistant",
        [{ type: "output_text", text: "There are two files." }],
        10
      ),
    ])

    expect(transcript.sessionId).toBe(THREAD)
    expect(transcript.cwd).toBe(CWD)
    expect(transcript.internal).toBe(false)
    expect(transcript.title).toBe("List the files and explain them")
    expect(transcript.messages).toHaveLength(2)

    const [prompt, reply] = transcript.messages
    expect(prompt).toMatchObject({
      role: "user",
      text: "List the files and explain them",
      createdAt: at(4),
    })
    expect(reply).toMatchObject({
      role: "assistant",
      text: "There are two files.",
      reasoning: "**Listing files**",
      modelId: "gpt-test-codex",
    })
    const [shell, patch] = reply?.toolCalls ?? []
    expect(shell).toMatchObject({
      id: "call_1",
      name: "shell",
      output: "a.txt\nb.txt",
    })
    expect((shell?.input as { command: string }).command).toBe("ls -la")
    expect(patch).toMatchObject({
      id: "call_2",
      name: "apply_patch",
      output: "Success",
    })
    expect((patch?.input as { input: string }).input.length).toBeLessThan(400)
  })

  it("marks a failed shell call from its exit code", () => {
    const transcript = parse([
      meta(),
      message("user", [{ type: "input_text", text: "Run the tests" }], 1),
      envelope(
        "response_item",
        {
          type: "function_call",
          name: "shell",
          arguments: '{"command":"npm test"}',
          call_id: "c1",
        },
        2
      ),
      envelope(
        "response_item",
        {
          type: "function_call_output",
          call_id: "c1",
          output: JSON.stringify({
            output: "1 failed",
            metadata: { exit_code: 1 },
          }),
        },
        3
      ),
    ])
    expect(transcript.messages[1]?.toolCalls?.[0]).toMatchObject({
      failed: true,
      output: "1 failed",
    })
  })

  it("marks sub-agent sessions as internal", () => {
    const transcript = parse([
      meta(0, { source: { subagent: "review" } }),
      message("user", [{ type: "input_text", text: "Review this" }], 1),
    ])
    expect(transcript.internal).toBe(true)
  })

  it("marks sessions BetterC0de's own chats ran as internal", () => {
    const transcript = parse([
      meta(0, { originator: "BetterC0de" }),
      message("user", [{ type: "input_text", text: "From a chat" }], 1),
    ])
    expect(transcript.internal).toBe(true)
  })

  it("reads early rollouts without the envelope", () => {
    const transcript = parse([
      JSON.stringify({ id: THREAD, timestamp: at(0), instructions: null }),
      JSON.stringify({ record_type: "state" }),
      JSON.stringify({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Old prompt" }],
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Old answer" }],
      }),
    ])
    expect(transcript.sessionId).toBe(THREAD)
    expect(transcript.messages.map((entry) => entry.text)).toEqual([
      "Old prompt",
      "Old answer",
    ])
  })

  it("counts without keeping messages", () => {
    const lines = [
      meta(),
      message("user", [{ type: "input_text", text: "One" }], 1),
      message("assistant", [{ type: "output_text", text: "Two" }], 2),
      message("user", [{ type: "input_text", text: "Three" }], 3),
      envelope(
        "response_item",
        { type: "function_call", name: "shell", arguments: "{}", call_id: "c" },
        4
      ),
    ]
    const counted = parse(lines, false)
    expect(counted.messages).toEqual([])
    expect(counted.messageCount).toBe(4)
    expect(parse(lines).messageCount).toBe(4)
  })
})

describe("isInjectedCodexText", () => {
  it("tells injected context from typed text", () => {
    expect(
      isInjectedCodexText(
        "<environment_context>\n<cwd>/x</cwd>\n</environment_context>"
      )
    ).toBe(true)
    expect(
      isInjectedCodexText("<user_instructions>be brief</user_instructions>")
    ).toBe(true)
    expect(
      isInjectedCodexText(
        "<turn_aborted>\nThe user interrupted.\n</turn_aborted>"
      )
    ).toBe(true)
    expect(
      isInjectedCodexText(
        "<permissions instructions>sandbox</permissions instructions>"
      )
    ).toBe(true)
    expect(
      isInjectedCodexText("# AGENTS.md instructions for /x\n\nrules")
    ).toBe(true)
    expect(isInjectedCodexText("<image name=[Image #1]>")).toBe(true)
    expect(isInjectedCodexText("<div>keep my markup</div>")).toBe(false)
    expect(isInjectedCodexText("Explain <environment_context> please")).toBe(
      false
    )
  })
})
