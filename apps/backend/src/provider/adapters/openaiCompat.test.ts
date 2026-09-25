import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mock the OpenAI SDK: a fake client whose `chat.completions.create`
//    returns queued async-iterable chunk streams. ───────────────────────────
const createMock = vi.fn()
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } }
    constructor(_opts: unknown) {}
  },
}))

// Avoid touching the real filesystem/shell.
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
vi.mock("../../constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../constants")>()),
  probeLmStudioBaseUrl: vi.fn(async () => null),
}))

import { OpenAiCompatAdapter } from "./openaiCompat"
import { executeTool } from "../agent-loop/tool-executor"
import { probeLmStudioBaseUrl } from "../../constants"
import type { ProviderRuntimeEvent, ProviderSendTurnInput } from "../types"

function stream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

function toolCallTurn(id: string, name: string, args: string): unknown[] {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id, function: { name, arguments: args } }],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]
}

function textTurn(text: string): unknown[] {
  return [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } },
  ]
}

function baseInput(
  over: Partial<ProviderSendTurnInput> = {}
): ProviderSendTurnInput {
  return {
    thread_id: "t1",
    message: "read package.json and tell me the version",
    model_id: "gpt-x",
    history: [],
    permission_level: "bypass",
    chat_mode: "agent",
    project_path: "/proj",
    ...over,
  }
}

beforeEach(() => vi.clearAllMocks())

describe("OpenAiCompatAdapter agent loop", () => {
  it.each(["none", "xhigh", "max"])(
    "passes OpenAI %s reasoning through to chat completions",
    async (effort) => {
      createMock.mockReturnValueOnce(stream(textTurn("done")))
      const adapter = new OpenAiCompatAdapter(
        { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
        "sk-test"
      )
      await adapter.sendMessage(
        baseInput({ model_id: "gpt-5.6-sol", reasoning_effort: effort })
      )
      expect(createMock.mock.calls[0][0]).toMatchObject({
        reasoning_effort: effort,
      })
    }
  )
  it.each(["plan", "ask"])(
    "blocks an unadvertised mutation in %s mode even with bypass",
    async (chatMode) => {
      createMock
        .mockReturnValueOnce(
          stream(toolCallTurn("write", "Write", '{"path":"a","content":"x"}'))
        )
        .mockReturnValueOnce(stream(textTurn("done")))
      const adapter = new OpenAiCompatAdapter(
        { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
        "sk-test"
      )
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

  it("does not start a turn after interruption during the LM Studio probe", async () => {
    let finishProbe: (url: string | null) => void = () => undefined
    vi.mocked(probeLmStudioBaseUrl).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve
        })
    )
    const adapter = new OpenAiCompatAdapter(
      { providerKind: "lmstudio", displayName: "LM Studio", defaultModels: [] },
      null
    )
    const pending = adapter.sendMessage(baseInput())
    expect(probeLmStudioBaseUrl).toHaveBeenCalledOnce()
    await adapter.interrupt("t1")
    finishProbe("http://localhost:1111/v1")
    await pending
    expect(createMock).not.toHaveBeenCalled()
    expect(executeTool).not.toHaveBeenCalled()
    expect(await adapter.interruptAll()).toBe(0)
  })

  it("keeps the turn client when the API key is cleared between tool calls", async () => {
    createMock
      .mockReturnValueOnce(stream(toolCallTurn("read", "Read", '{"path":"a"}')))
      .mockReturnValueOnce(stream(textTurn("done")))
    const adapter = new OpenAiCompatAdapter(
      { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
      "sk-test"
    )
    vi.mocked(executeTool).mockImplementationOnce(async () => {
      adapter.setApiKey(null)
      return { output: "content" }
    })

    await expect(adapter.sendMessage(baseInput())).resolves.toBeUndefined()
    expect(createMock).toHaveBeenCalledTimes(2)
    expect(adapter.isConfigured()).toBe(false)
    await expect(adapter.sendMessage(baseInput())).rejects.toThrow(
      "not configured"
    )
  })

  it("executes a tool then loops back to a final answer", async () => {
    createMock
      .mockReturnValueOnce(
        stream(toolCallTurn("call_1", "Read", '{"path":"package.json"}'))
      )
      .mockReturnValueOnce(stream(textTurn("The version is 1.0.")))

    const adapter = new OpenAiCompatAdapter(
      { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
      "sk-test"
    )
    const events: ProviderRuntimeEvent[] = []
    adapter
      .subscribeEvents()
      .on("event", (e: ProviderRuntimeEvent) => events.push(e))

    await adapter.sendMessage(baseInput())

    const types = events.map((e) => e.event_type)
    // Two model turns happened.
    expect(createMock).toHaveBeenCalledTimes(2)
    // The tool was executed with the parsed input + project cwd.
    expect(executeTool).toHaveBeenCalledWith(
      "Read",
      { path: "package.json" },
      expect.objectContaining({
        cwd: "/proj",
        toolId: "call_1",
        signal: expect.any(AbortSignal),
        timeoutMs: 60_000,
      })
    )
    // Adapter-owned stream/tool events in the right order. ProviderService
    // owns the exactly-once turn lifecycle.
    expect(types).toEqual([
      "token_usage",
      "tool_call",
      "tool_result",
      "content_delta",
      "token_usage",
    ])

    const toolResult = events.find((e) => e.event_type === "tool_result")
    expect(toolResult?.payload).toMatchObject({
      tool_id: "call_1",
      tool_name: "Read",
      output: "FILE CONTENTS",
    })
    const finalText = events.find((e) => e.event_type === "content_delta")
    expect(finalText?.payload).toMatchObject({ delta: "The version is 1.0." })
  })

  it("projects direct file mutations as canonical structured diffs", async () => {
    createMock
      .mockReturnValueOnce(
        stream(
          toolCallTurn(
            "call_edit",
            "Edit",
            '{"path":"src/a.ts","old_string":"a","new_string":"b"}'
          )
        )
      )
      .mockReturnValueOnce(stream(textTurn("Updated.")))
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

    const adapter = new OpenAiCompatAdapter(
      { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
      "sk-test"
    )
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
    createMock.mockReturnValueOnce(
      stream(toolCallTurn("call_cancel", "Bash", '{"command":"long-running"}'))
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
    const adapter = new OpenAiCompatAdapter(
      { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
      "sk-test"
    )
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
      tool_id: "call_cancel",
      error: "Tool execution was cancelled.",
      status: "cancelled",
    })
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it("plain chat emits content without duplicating service lifecycle", async () => {
    createMock.mockReturnValueOnce(stream(textTurn("Hello there.")))
    const adapter = new OpenAiCompatAdapter(
      { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
      "sk-test"
    )
    const events: ProviderRuntimeEvent[] = []
    adapter
      .subscribeEvents()
      .on("event", (e: ProviderRuntimeEvent) => events.push(e))

    await adapter.sendMessage(baseInput({ message: "hi" }))

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(executeTool).not.toHaveBeenCalled()
    expect(events.map((e) => e.event_type)).toEqual([
      "content_delta",
      "token_usage",
    ])
  })

  it("emits a nonfatal canonical denial and feeds the blocked result back", async () => {
    createMock
      .mockReturnValueOnce(
        stream(
          toolCallTurn("call_denied", "Write", '{"path":"a.txt","content":"x"}')
        )
      )
      .mockReturnValueOnce(stream(textTurn("I will continue without writing.")))
    const adapter = new OpenAiCompatAdapter(
      { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
      "sk-test"
    )
    const events: ProviderRuntimeEvent[] = []
    adapter
      .subscribeEvents()
      .on("event", (event: ProviderRuntimeEvent) => events.push(event))

    await adapter.sendMessage(baseInput({ permission_level: "read-only" }))

    expect(executeTool).not.toHaveBeenCalled()
    expect(events.map((event) => event.event_type)).toContain("tool.denied")
    expect(
      events.find((event) => event.event_type === "tool.denied")?.payload
    ).toMatchObject({
      toolUseId: "call_denied",
      toolName: "Write",
    })
    expect(
      events.find((event) => event.event_type === "tool_result")?.payload
    ).toMatchObject({
      tool_id: "call_denied",
      tool_name: "Write",
      error: expect.any(String),
    })
    expect(createMock).toHaveBeenCalledTimes(2)
  })

  it("fails explicitly when the provider never exits the bounded tool loop", async () => {
    createMock.mockImplementation(() =>
      stream(toolCallTurn("call_repeat", "Read", '{"path":"package.json"}'))
    )
    const adapter = new OpenAiCompatAdapter(
      { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
      "sk-test"
    )

    await expect(
      adapter.sendMessage(baseInput({ chat_mode: "ask" }))
    ).rejects.toThrow("10-turn safety limit")
    expect(createMock).toHaveBeenCalledTimes(10)
  })

  it("advertises tools to the model in agent mode", async () => {
    createMock.mockReturnValueOnce(stream(textTurn("done")))
    const adapter = new OpenAiCompatAdapter(
      { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
      "sk-test"
    )
    await adapter.sendMessage(baseInput())
    const params = createMock.mock.calls[0][0] as {
      tools?: Array<{ function: { name: string } }>
      tool_choice?: string
    }
    const names = (params.tools ?? []).map((t) => t.function.name)
    expect(names).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep"])
    expect(params.tool_choice).toBe("auto")
  })

  it("discovers, gates, executes, and closes a turn-scoped MCP tool", async () => {
    const close = vi.fn(async () => undefined)
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "MCP RESULT" }],
    }))
    createMock
      .mockImplementationOnce(
        (request: { tools?: Array<{ function: { name: string } }> }) => {
          const mcpName = request.tools
            ?.map((tool) => tool.function.name)
            .find((name) => name.startsWith("mcp__"))
          return stream(
            toolCallTurn("mcp_call", mcpName ?? "", '{"query":"x"}')
          )
        }
      )
      .mockReturnValueOnce(stream(textTurn("done")))

    const adapter = new OpenAiCompatAdapter(
      { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
      "sk-test",
      {
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
      }
    )

    await adapter.sendMessage(baseInput())

    expect(callTool).toHaveBeenCalledWith(
      { name: "lookup", arguments: { query: "x" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(executeTool).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    const secondRequest = createMock.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content?: unknown }>
    }
    expect(secondRequest.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: "MCP RESULT" }),
      ])
    )
  })

  it("replays durable tool-call history into the OpenAI message array", async () => {
    createMock.mockReturnValueOnce(stream(textTurn("ok")))
    const adapter = new OpenAiCompatAdapter(
      { providerKind: "openai", displayName: "OpenAI", defaultModels: [] },
      "sk-test"
    )
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
          { role: "assistant", content: "it says hi" },
        ],
      })
    )

    const params = createMock.mock.calls[0][0] as {
      messages: Array<{
        role: string
        content: unknown
        tool_calls?: Array<{
          id: string
          type: string
          function: { name: string; arguments: string }
        }>
        tool_call_id?: string
      }>
    }
    const asst = params.messages.find(
      (m) => m.role === "assistant" && m.tool_calls
    )
    expect(asst?.tool_calls?.[0]).toMatchObject({
      id: "c1",
      type: "function",
      function: { name: "Read" },
    })
    expect(JSON.parse(asst!.tool_calls![0].function.arguments)).toEqual({
      path: "a.txt",
    })
    const toolMsg = params.messages.find((m) => m.role === "tool")
    expect(toolMsg).toMatchObject({ tool_call_id: "c1", content: "FILE BODY" })
  })

  it("falls back to plain chat when the model rejects the tools param", async () => {
    createMock
      .mockRejectedValueOnce(
        Object.assign(new Error("This model does not support tools"), {
          status: 400,
        })
      )
      .mockReturnValueOnce(stream(textTurn("plain answer")))

    const adapter = new OpenAiCompatAdapter(
      { providerKind: "lmstudio", displayName: "LM Studio", defaultModels: [] },
      "sk-test"
    )
    const events: ProviderRuntimeEvent[] = []
    adapter
      .subscribeEvents()
      .on("event", (e: ProviderRuntimeEvent) => events.push(e))

    await adapter.sendMessage(baseInput())

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(createMock.mock.calls[0][0].tools).toBeTruthy()
    expect(createMock.mock.calls[1][0].tools).toBeUndefined()
    expect(events.map((e) => e.event_type)).toEqual([
      "content_delta",
      "token_usage",
    ])
  })
})
