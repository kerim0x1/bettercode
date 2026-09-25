import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mock the Anthropic SDK: a fake client whose `messages.stream` returns a
//    queued MessageStream-like object (`.on()` + `.finalMessage()`). ─────────
const streamMock = vi.fn()
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: streamMock }
    constructor(_opts: unknown) {}
  },
}))

vi.mock("../../services/workspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/workspace")>()
  return {
    ...actual,
    getProjectToolOutputLimits: vi.fn(async () => ({
      maxLines: 2000,
      maxBytes: 50_000,
    })),
  }
})
vi.mock("../agent-loop/tool-executor", () => ({
  executeTool: vi.fn(async () => ({ output: "FILE CONTENTS" })),
}))

import { ClaudeApiAdapter } from "./claudeApi"
import { executeTool } from "../agent-loop/tool-executor"
import type { ProviderRuntimeEvent, ProviderSendTurnInput } from "../types"

type Block = Record<string, unknown> & { type: string }

function makeStream(message: { content: Block[]; usage?: unknown }) {
  const handlers: Record<string, Array<(arg: unknown) => void>> = {}
  return {
    on(event: string, cb: (arg: unknown) => void) {
      ;(handlers[event] ??= []).push(cb)
      return this
    },
    async finalMessage() {
      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .join("")
      if (text) for (const cb of handlers.text ?? []) cb(text)
      return message
    },
  }
}

const USAGE = { input_tokens: 10, output_tokens: 5 }

function baseInput(
  over: Partial<ProviderSendTurnInput> = {}
): ProviderSendTurnInput {
  return {
    thread_id: "t1",
    message: "read package.json and tell me the version",
    model_id: "claude-opus-4-8",
    history: [],
    permission_level: "bypass",
    chat_mode: "agent",
    project_path: "/proj",
    ...over,
  }
}

beforeEach(() => vi.clearAllMocks())

describe("ClaudeApiAdapter agent loop", () => {
  it.each(["plan", "ask"])(
    "blocks an unadvertised mutation in %s mode even with bypass",
    async (chatMode) => {
      streamMock
        .mockReturnValueOnce(
          makeStream({
            content: [
              {
                type: "tool_use",
                id: "write",
                name: "Write",
                input: { path: "a", content: "x" },
              },
            ],
          })
        )
        .mockReturnValueOnce(
          makeStream({ content: [{ type: "text", text: "done" }] })
        )
      const adapter = new ClaudeApiAdapter("sk-test")
      const events: ProviderRuntimeEvent[] = []
      adapter
        .subscribeEvents()
        .on("event", (event: ProviderRuntimeEvent) => events.push(event))

      await adapter.sendMessage(
        baseInput({ chat_mode: chatMode, permission_level: "bypass" })
      )
      expect(executeTool).not.toHaveBeenCalled()
      expect(
        events.find((event) => event.event_type === "tool.denied")?.payload
      ).toMatchObject({ toolName: "Write" })
    }
  )

  it("keeps the turn client when the API key is cleared between tool calls", async () => {
    streamMock
      .mockReturnValueOnce(
        makeStream({
          content: [
            {
              type: "tool_use",
              id: "read",
              name: "Read",
              input: { path: "a" },
            },
          ],
        })
      )
      .mockReturnValueOnce(
        makeStream({ content: [{ type: "text", text: "done" }] })
      )
    const adapter = new ClaudeApiAdapter("sk-test")
    vi.mocked(executeTool).mockImplementationOnce(async () => {
      adapter.setApiKey(null)
      return { output: "content" }
    })

    await expect(adapter.sendMessage(baseInput())).resolves.toBeUndefined()
    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(adapter.isConfigured()).toBe(false)
    await expect(adapter.sendMessage(baseInput())).rejects.toThrow(
      "not configured"
    )
  })

  it("executes a tool_use then loops back to a final answer", async () => {
    streamMock
      .mockReturnValueOnce(
        makeStream({
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "Read",
              input: { path: "package.json" },
            },
          ],
          usage: USAGE,
        })
      )
      .mockReturnValueOnce(
        makeStream({
          content: [{ type: "text", text: "The version is 1.0." }],
          usage: USAGE,
        })
      )

    const adapter = new ClaudeApiAdapter("sk-test")
    const events: ProviderRuntimeEvent[] = []
    adapter
      .subscribeEvents()
      .on("event", (e: ProviderRuntimeEvent) => events.push(e))

    await adapter.sendMessage(baseInput())

    expect(streamMock).toHaveBeenCalledTimes(2)
    expect(executeTool).toHaveBeenCalledWith(
      "Read",
      { path: "package.json" },
      expect.objectContaining({
        cwd: "/proj",
        toolId: "tu_1",
        signal: expect.any(AbortSignal),
        timeoutMs: 60_000,
      })
    )
    expect(events.map((e) => e.event_type)).toEqual([
      "token_usage",
      "tool_call",
      "tool_result",
      "content_delta",
      "token_usage",
    ])
    expect(
      events.find((e) => e.event_type === "tool_result")?.payload
    ).toMatchObject({
      tool_id: "tu_1",
      tool_name: "Read",
      output: "FILE CONTENTS",
    })

    // The tool result was fed back as a user message of tool_result blocks.
    const secondTurnMessages = streamMock.mock.calls[1][0].messages as Array<{
      role: string
      content: unknown
    }>
    const toolResultMsg = secondTurnMessages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some(
          (b) => b.type === "tool_result"
        )
    )
    expect(toolResultMsg).toBeTruthy()
  })

  it("advances the prompt-cache breakpoint onto the newest tool_result", async () => {
    streamMock
      .mockReturnValueOnce(
        makeStream({
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "Read",
              input: { path: "a" },
            },
          ],
          usage: USAGE,
        })
      )
      .mockReturnValueOnce(
        makeStream({
          content: [{ type: "text", text: "done" }],
          usage: USAGE,
        })
      )

    const adapter = new ClaudeApiAdapter("sk-test")
    await adapter.sendMessage(baseInput())

    const secondTurnMessages = streamMock.mock.calls[1][0].messages as Array<{
      role: string
      content: unknown
    }>
    const toolResultMsg = secondTurnMessages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some(
          (b) => b.type === "tool_result"
        )
    )
    const toolResultBlock = (
      toolResultMsg?.content as Array<{ type: string; cache_control?: unknown }>
    ).find((b) => b.type === "tool_result")
    expect(toolResultBlock?.cache_control).toEqual({ type: "ephemeral" })
  })

  it("projects direct file mutations as canonical structured diffs", async () => {
    streamMock
      .mockReturnValueOnce(
        makeStream({
          content: [
            {
              type: "tool_use",
              id: "tu_edit",
              name: "Edit",
              input: {
                path: "src/a.ts",
                old_string: "a",
                new_string: "b",
              },
            },
          ],
          usage: USAGE,
        })
      )
      .mockReturnValueOnce(
        makeStream({
          content: [{ type: "text", text: "Updated." }],
          usage: USAGE,
        })
      )
    vi.mocked(executeTool).mockResolvedValueOnce({
      output: "Edited src/a.ts (1 replacement).",
      mutation: {
        path: "src/a.ts",
        operation: "edit",
        preimageHash: "a".repeat(64),
        resultHash: "b".repeat(64),
        unifiedDiff: "diff --git a/src/a.ts b/src/a.ts\n",
        additions: 1,
        deletions: 1,
        isNew: false,
        patchComplete: true,
      },
    })

    const adapter = new ClaudeApiAdapter("sk-test")
    const events: ProviderRuntimeEvent[] = []
    adapter
      .subscribeEvents()
      .on("event", (event: ProviderRuntimeEvent) => events.push(event))

    await adapter.sendMessage(baseInput())

    expect(events.map((event) => event.event_type)).toEqual([
      "token_usage",
      "tool_call",
      "turn.diff.updated",
      "tool_result",
      "content_delta",
      "token_usage",
    ])
    expect(
      events.find((event) => event.event_type === "turn.diff.updated")?.payload
    ).toMatchObject({
      files: [{ path: "src/a.ts", additions: 1, deletions: 1 }],
      edits: [
        {
          path: "src/a.ts",
          operation: "edit",
          preimageHash: "a".repeat(64),
          resultHash: "b".repeat(64),
          patchComplete: true,
        },
      ],
    })
  })

  it("publishes one cancelled tool result when the turn is interrupted", async () => {
    streamMock.mockReturnValueOnce(
      makeStream({
        content: [
          {
            type: "tool_use",
            id: "tu_cancel",
            name: "Bash",
            input: { command: "long-running" },
          },
        ],
        usage: USAGE,
      })
    )
    vi.mocked(executeTool).mockImplementationOnce(
      async (_name, _input, context) => {
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) {
            resolve()
            return
          }
          context.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          })
        })
        return {
          output: "Error: Tool execution was cancelled.",
          error: "Tool execution was cancelled.",
          status: "cancelled",
        }
      }
    )
    const adapter = new ClaudeApiAdapter("sk-test")
    const events: ProviderRuntimeEvent[] = []
    adapter
      .subscribeEvents()
      .on("event", (event: ProviderRuntimeEvent) => events.push(event))

    const pending = adapter.sendMessage(baseInput())
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalledOnce())
    await adapter.interrupt("t1")
    await pending

    expect(
      events.filter((event) => event.event_type === "tool_result")
    ).toHaveLength(1)
    expect(
      events.find((event) => event.event_type === "tool_result")?.payload
    ).toMatchObject({
      tool_id: "tu_cancel",
      error: "Tool execution was cancelled.",
      status: "cancelled",
    })
    expect(streamMock).toHaveBeenCalledTimes(1)
  })

  it("advertises Anthropic tools in agent mode", async () => {
    streamMock.mockReturnValueOnce(
      makeStream({ content: [{ type: "text", text: "hi" }], usage: USAGE })
    )
    const adapter = new ClaudeApiAdapter("sk-test")
    await adapter.sendMessage(baseInput({ message: "hi" }))
    const tools = (streamMock.mock.calls[0][0].tools ?? []) as Array<{
      name: string
      input_schema: unknown
    }>
    expect(tools.map((t) => t.name)).toEqual([
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
    ])
    expect(executeTool).not.toHaveBeenCalled()
  })

  it("discovers, gates, executes, and closes a turn-scoped MCP tool", async () => {
    const close = vi.fn(async () => undefined)
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "MCP RESULT" }],
    }))
    streamMock
      .mockImplementationOnce(
        (request: { tools?: Array<{ name: string }> }) => {
          const mcpName = request.tools
            ?.map((tool) => tool.name)
            .find((name) => name.startsWith("mcp__"))
          return makeStream({
            content: [
              {
                type: "tool_use",
                id: "mcp_use",
                name: mcpName ?? "",
                input: { query: "x" },
              },
            ],
            usage: USAGE,
          })
        }
      )
      .mockReturnValueOnce(
        makeStream({
          content: [{ type: "text", text: "done" }],
          usage: USAGE,
        })
      )

    const adapter = new ClaudeApiAdapter("sk-test", {
      mcpServerResolver: async () => [
        {
          id: "search",
          name: "Search",
          transport: "stdio",
          command: "search-mcp",
          args: [],
          env: {},
        },
      ],
      mcpClientFactory: async () => ({
        listTools: async () => ({
          tools: [
            {
              name: "lookup",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
              },
            },
          ],
        }),
        callTool,
        close,
      }),
    })

    await adapter.sendMessage(baseInput())

    expect(callTool).toHaveBeenCalledWith(
      { name: "lookup", arguments: { query: "x" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(executeTool).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    const secondRequest = streamMock.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(secondRequest.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              content: "MCP RESULT",
            }),
          ]),
        }),
      ])
    )
  })

  it("emits a nonfatal canonical denial and returns an error tool result", async () => {
    streamMock
      .mockReturnValueOnce(
        makeStream({
          content: [
            {
              type: "tool_use",
              id: "tu_denied",
              name: "Write",
              input: { path: "a.txt", content: "x" },
            },
          ],
          usage: USAGE,
        })
      )
      .mockReturnValueOnce(
        makeStream({
          content: [{ type: "text", text: "I will continue without writing." }],
          usage: USAGE,
        })
      )
    const adapter = new ClaudeApiAdapter("sk-test")
    const events: ProviderRuntimeEvent[] = []
    adapter
      .subscribeEvents()
      .on("event", (event: ProviderRuntimeEvent) => events.push(event))

    await adapter.sendMessage(baseInput({ permission_level: "read-only" }))

    expect(executeTool).not.toHaveBeenCalled()
    expect(
      events.find((event) => event.event_type === "tool.denied")?.payload
    ).toMatchObject({
      toolUseId: "tu_denied",
      toolName: "Write",
    })
    expect(
      events.find((event) => event.event_type === "tool_result")?.payload
    ).toMatchObject({
      tool_id: "tu_denied",
      tool_name: "Write",
      error: expect.any(String),
    })
    const secondRequest = streamMock.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: unknown }>
    }
    const resultBlock = secondRequest.messages
      .flatMap((message) =>
        Array.isArray(message.content) ? message.content : []
      )
      .find(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          "tool_use_id" in block &&
          block.tool_use_id === "tu_denied"
      ) as { is_error?: boolean } | undefined
    expect(resultBlock?.is_error).toBe(true)
  })

  it("fails explicitly when the provider never exits the bounded tool loop", async () => {
    streamMock.mockImplementation(() =>
      makeStream({
        content: [
          {
            type: "tool_use",
            id: "tu_repeat",
            name: "Read",
            input: { path: "package.json" },
          },
        ],
        usage: USAGE,
      })
    )
    const adapter = new ClaudeApiAdapter("sk-test")

    await expect(
      adapter.sendMessage(baseInput({ chat_mode: "ask" }))
    ).rejects.toThrow("10-turn safety limit")
    expect(streamMock).toHaveBeenCalledTimes(10)
  })

  it("keeps max_tokens above the configured extended-thinking budget", async () => {
    streamMock.mockReturnValueOnce(
      makeStream({ content: [{ type: "text", text: "done" }], usage: USAGE })
    )
    const adapter = new ClaudeApiAdapter("sk-test")
    await adapter.sendMessage(
      baseInput({
        model_id: "claude-sonnet-4-5",
        reasoning_effort: "ultrathink",
      })
    )

    const request = streamMock.mock.calls[0][0] as {
      max_tokens: number
      thinking?: { budget_tokens: number }
    }
    expect(request.thinking?.budget_tokens).toBe(48_000)
    expect(request.max_tokens).toBeGreaterThan(
      request.thinking?.budget_tokens ?? 0
    )
    expect(request.max_tokens).toBeLessThanOrEqual(64_000)
  })

  it("requests adaptive thinking + effort on 4.7+ and nothing on unknown models", async () => {
    streamMock
      .mockReturnValueOnce(
        makeStream({ content: [{ type: "text", text: "done" }], usage: USAGE })
      )
      .mockReturnValueOnce(
        makeStream({ content: [{ type: "text", text: "done" }], usage: USAGE })
      )
    const adapter = new ClaudeApiAdapter("sk-test")

    await adapter.sendMessage(baseInput({ reasoning_effort: "ultrathink" }))
    await adapter.sendMessage(
      baseInput({
        model_id: "custom-claude-model",
        reasoning_effort: "ultrathink",
      })
    )

    // 4.7+ rejects budget_tokens; thinking must be requested as adaptive
    // (on Opus 4.7/4.8 omitting it would disable thinking outright), with
    // an explicit summarized display and the effort in output_config.
    expect(streamMock.mock.calls[0][0]).toMatchObject({
      model: "claude-opus-4-8",
      max_tokens: 64_000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    })
    // Unknown/custom ids stay on the safe baseline: no thinking payload the
    // endpoint might reject.
    expect(streamMock.mock.calls[1][0]).toMatchObject({
      model: "custom-claude-model",
      max_tokens: 4_096,
    })
    expect(streamMock.mock.calls[1][0].thinking).toBeUndefined()
  })

  it("keeps Opus 5.5 thinking blocks intact through a tool continuation", async () => {
    streamMock
      .mockReturnValueOnce(
        makeStream({
          content: [
            {
              type: "thinking",
              thinking: "checking",
              signature: "signed-thinking",
            },
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: { path: "a.txt" },
            },
          ],
          usage: USAGE,
        })
      )
      .mockReturnValueOnce(
        makeStream({ content: [{ type: "text", text: "done" }], usage: USAGE })
      )
    const adapter = new ClaudeApiAdapter("sk-test")
    await adapter.sendMessage(
      baseInput({ model_id: "claude-opus-5-5", reasoning_effort: null })
    )
    expect(streamMock.mock.calls[0][0]).toMatchObject({
      model: "claude-opus-5-5",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
    })
    expect(streamMock.mock.calls[1][0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            {
              type: "thinking",
              thinking: "checking",
              signature: "signed-thinking",
            },
            expect.objectContaining({ type: "tool_use", id: "read-1" }),
          ]),
        }),
      ])
    )
  })

  it("replays durable tool history as tool_use + tool_result blocks", async () => {
    streamMock.mockReturnValueOnce(
      makeStream({ content: [{ type: "text", text: "ok" }], usage: USAGE })
    )
    const adapter = new ClaudeApiAdapter("sk-test")
    await adapter.sendMessage(
      baseInput({
        history: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c1", name: "Read", input: { path: "a.txt" } }],
          },
          { role: "tool", tool_call_id: "c1", content: "FILE BODY" },
        ],
      })
    )

    const messages = streamMock.mock.calls[0][0].messages as Array<{
      role: string
      content: unknown
    }>
    const asst = messages.find(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some(
          (b) => b.type === "tool_use"
        )
    )
    expect(asst).toBeTruthy()
    const toolResult = messages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string; tool_use_id?: string }>).some(
          (b) => b.type === "tool_result" && b.tool_use_id === "c1"
        )
    )
    expect(toolResult).toBeTruthy()
  })
})
