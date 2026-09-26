import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CURSOR_ACP_PENDING_REQUEST_TIMEOUT_MS,
  CursorAcpAdapter,
} from "./CursorAcpAdapter"
import type {
  CursorAcpEvent,
  CursorAcpExit,
  CursorAcpModeState,
  CursorAcpPermissionRequest,
  CursorAcpRuntime,
  CursorAcpRuntimeOptions,
  CursorAcpSessionSetupResult,
} from "./CursorAcpRuntime"
import type { ApprovalRequestId, ThreadId } from "../contracts"
import {
  bindAgentPermissionRuntimeContext,
  configureAgentPermissionRuntime,
} from "../../agent-permission-runtime"
import { CLEANUP_QUARANTINE_RETRY_WINDOW_MS } from "../CleanupQuarantine"
import { logger } from "../../../observability/logger"

const configOptions = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select" as const,
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask" },
      { value: "architect", name: "Architect" },
      { value: "code", name: "Code" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: "default",
    options: [
      { value: "default", name: "Auto" },
      { value: "composer-2", name: "Composer 2" },
      { value: "gpt-5.4", name: "GPT 5.4" },
    ],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select" as const,
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select" as const,
    currentValue: "272k",
    options: [
      { value: "272k", name: "272K" },
      { value: "1m", name: "1M" },
    ],
  },
  {
    id: "fast",
    name: "Fast",
    category: "model_config",
    type: "select" as const,
    currentValue: "false",
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  },
]

const modeState: CursorAcpModeState = {
  currentModeId: "ask",
  availableModes: [
    { id: "ask", name: "Ask" },
    { id: "architect", name: "Architect" },
    { id: "code", name: "Code" },
  ],
}

describe("CursorAcpAdapter", () => {
  afterEach(() => {
    configureAgentPermissionRuntime(null)
  })

  it("resolves MCP servers only for real sessions and passes them to the runtime", async () => {
    const runtimes: FakeCursorRuntime[] = []
    const factory = vi.fn((input: CursorAcpRuntimeOptions) => {
      const runtime = new FakeCursorRuntime(input)
      runtimes.push(runtime)
      return runtime
    })
    const mcpServers = [
      {
        name: "workspace-tools",
        command: "node",
        args: ["server.js"],
        env: [{ name: "MODE", value: "test" }],
      },
    ] as const
    const resolveMcpServers = vi.fn(async () => mcpServers)
    const adapter = new CursorAcpAdapter({
      binaryPath: "node",
      runtimeFactory: factory,
      resolveMcpServers,
    })

    await adapter.availableModels()
    expect(resolveMcpServers).not.toHaveBeenCalled()

    await adapter.startSession({
      threadId: "cursor-mcp-session" as ThreadId,
      cwd: "/tmp/project",
    })
    expect(resolveMcpServers).toHaveBeenCalledOnce()
    expect(resolveMcpServers).toHaveBeenCalledWith("/tmp/project")
    expect(factory).toHaveBeenLastCalledWith(
      expect.objectContaining({ mcpServers })
    )
    await adapter.stopAll()
  })

  it("starts Cursor ACP sessions and applies BetterC0de model/config/mode selection", async () => {
    const runtimes: FakeCursorRuntime[] = []
    const factory = vi.fn((input: CursorAcpRuntimeOptions) => {
      const runtime = new FakeCursorRuntime(input)
      runtimes.push(runtime)
      return runtime
    })
    const adapter = new CursorAcpAdapter({
      providerInstanceId: "cursor-main",
      continuationKey: "cursor:instance:cursor-main",
      binaryPath: "node",
      apiEndpoint: "http://127.0.0.1:3939",
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      runtimeFactory: factory,
    })

    const session = await adapter.startSession({
      threadId: "thread-1" as ThreadId,
      cwd: "/tmp/project",
      resumeCursor: { schemaVersion: 1, sessionId: "cursor-old" },
      runtimeMode: "read-only",
      modelSelection: {
        instanceId: "cursor-main",
        model: "gpt-5.4[reasoning=medium]",
        options: [
          { id: "reasoning", value: "xhigh" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
      },
    })

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: {
          binaryPath: "node",
          apiEndpoint: "http://127.0.0.1:3939",
        },
        cwd: "/tmp/project",
        resumeSessionId: "cursor-old",
      })
    )
    expect(session).toMatchObject({
      providerInstanceId: "cursor-main",
      providerThreadId: "cursor-session-1",
      continuationKey: "cursor:instance:cursor-main",
      status: "ready",
      cwd: "/tmp/project",
      resumeCursor: { schemaVersion: 1, sessionId: "cursor-session-1" },
    })
    expect(runtimes[0]?.calls).toEqual(
      expect.arrayContaining([
        ["setModel", "gpt-5.4"],
        ["setConfigOption", "reasoning", "extra-high"],
        ["setConfigOption", "context", "1m"],
        ["setConfigOption", "fast", "true"],
        ["setMode", "ask"],
      ])
    )
  })

  it("closes a startup child and prevents a late session after stopAll", async () => {
    const runtime = new FakeCursorRuntime()
    const originalStart = runtime.start.bind(runtime)
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const start = vi.spyOn(runtime, "start").mockImplementation(async () => {
      await startGate
      return originalStart()
    })
    const close = vi.spyOn(runtime, "close")
    const adapter = new CursorAcpAdapter({
      binaryPath: "node",
      runtimeFactory: () => runtime,
    })
    const threadId = "cursor-late-start" as ThreadId

    const starting = adapter.startSession({ threadId })
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())

    const stopping = adapter.stopAll()
    await vi.waitFor(() => expect(close).toHaveBeenCalled())
    releaseStart()

    await expect(starting).rejects.toThrow("session startup was cancelled")
    await expect(stopping).resolves.toBeUndefined()
    expect(adapter.hasSession(threadId)).toBe(false)
    await expect(adapter.listSessions()).resolves.toEqual([])
  })

  it.each(["plan", "ask", "read-only", "approval-required", "security"])(
    "fails closed for the non-implementation %s intent when Cursor only advertises implementation",
    async (runtimeMode) => {
      const runtime = new FakeCursorRuntime()
      vi.spyOn(runtime, "getModeState").mockReturnValue({
        currentModeId: "code",
        availableModes: [
          {
            id: "code",
            name: "Code",
            description: "Can ask before edits and run security audits",
          },
        ],
      })
      const adapter = new CursorAcpAdapter({
        binaryPath: "node",
        runtimeFactory: () => runtime,
      })

      await expect(
        adapter.startSession({
          threadId: `cursor-safe-mode-${runtimeMode}` as ThreadId,
          runtimeMode,
        })
      ).rejects.toThrow(/Cursor Agent does not support/)
      expect(runtime.calls).not.toContainEqual(["setMode", "code"])
      expect(runtime.calls).toContainEqual(["close"])
    }
  )

  it("seeds durable history once for a fresh session and never for a resumed session", async () => {
    const runtimes: FakeCursorRuntime[] = []
    const adapter = new CursorAcpAdapter({
      providerInstanceId: "cursor",
      binaryPath: "node",
      runtimeFactory: (input) => {
        const runtime = new FakeCursorRuntime(input)
        runtimes.push(runtime)
        return runtime
      },
    })
    const threadId = "thread-history" as ThreadId
    const history = [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ]

    await adapter.startSession({ threadId })
    await adapter.sendTurn({
      threadId,
      message: "Build this",
      modelId: "composer-2",
      history,
    })
    await adapter.sendTurn({
      threadId,
      message: "Follow up",
      modelId: "composer-2",
      history,
    })

    const freshPrompts = runtimes[0]?.prompts.map(
      (entry) => entry.prompt[0]?.text
    )
    expect(freshPrompts?.[0]).toEqual(
      expect.stringContaining("<conversation_history_json>")
    )
    expect(freshPrompts?.[0]).toEqual(
      expect.stringContaining("Earlier question")
    )
    expect(freshPrompts?.[0]).toEqual(expect.stringMatching(/Build this$/))
    expect(freshPrompts?.[1]).toBe("Follow up")

    await adapter.startSession({
      threadId,
      resumeCursor: { schemaVersion: 1, sessionId: "cursor-existing" },
    })
    await adapter.sendTurn({
      threadId,
      message: "Continue resumed",
      modelId: "composer-2",
      history,
    })

    expect(runtimes[1]?.prompts[0]?.prompt[0]?.text).toBe("Continue resumed")
    await adapter.stopAll()
  })

  it("seeds durable history when a resume falls back to a fresh agent session", async () => {
    const runtimes: FakeCursorRuntime[] = []
    const adapter = new CursorAcpAdapter({
      providerInstanceId: "cursor",
      binaryPath: "node",
      runtimeFactory: (input) => {
        const runtime = new FakeCursorRuntime(input)
        runtime.resumeFellBack = true
        runtimes.push(runtime)
        return runtime
      },
    })
    const threadId = "thread-history-fallback" as ThreadId
    const history = [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ]

    await adapter.startSession({
      threadId,
      resumeCursor: { schemaVersion: 1, sessionId: "cursor-lost" },
    })
    await adapter.sendTurn({
      threadId,
      message: "Continue",
      modelId: "composer-2",
      history,
    })
    await adapter.sendTurn({
      threadId,
      message: "Again",
      modelId: "composer-2",
      history,
    })

    const prompts = runtimes[0]?.prompts.map((entry) => entry.prompt[0]?.text)
    // session/load failed, so the agent has no memory of the thread: seed once.
    expect(prompts?.[0]).toEqual(
      expect.stringContaining("<conversation_history_json>")
    )
    expect(prompts?.[0]).toEqual(expect.stringMatching(/Continue$/))
    expect(prompts?.[1]).toBe("Again")
    await adapter.stopAll()
  })

  it("closes the runtime when session configuration fails", async () => {
    const runtime = new FakeCursorRuntime()
    vi.spyOn(runtime, "setModel").mockRejectedValueOnce(
      new Error("model setup failed")
    )
    const adapter = new CursorAcpAdapter({
      providerInstanceId: "cursor",
      binaryPath: "node",
      runtimeFactory: () => runtime,
    })

    await expect(
      adapter.startSession({
        threadId: "thread-start-failure" as ThreadId,
        cwd: "/tmp/project",
        modelSelection: { instanceId: "cursor", model: "gpt-5.4" },
      })
    ).rejects.toThrow("model setup failed")
    expect(runtime.calls).toContainEqual(["close"])
    expect(adapter.hasSession("thread-start-failure" as ThreadId)).toBe(false)
  })

  it("globally quarantines and retries a failed startup runtime cleanup", async () => {
    const runtime = new FakeCursorRuntime()
    const setupFailure = new Error("model setup failed")
    const cleanupFailure = new Error("cursor runtime close failed")
    vi.spyOn(runtime, "setModel").mockRejectedValueOnce(setupFailure)
    const close = vi
      .spyOn(runtime, "close")
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const factory = vi.fn(() => runtime)
    const adapter = new CursorAcpAdapter({
      providerInstanceId: "cursor",
      binaryPath: "node",
      runtimeFactory: factory,
    })

    await expect(
      adapter.startSession({
        threadId: "cursor-failed-start" as ThreadId,
        modelSelection: { instanceId: "cursor", model: "gpt-5.4" },
      })
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [setupFailure, cleanupFailure],
    })
    const quarantines = (
      adapter as unknown as {
        runtimeCleanupQuarantines: Map<unknown, unknown>
      }
    ).runtimeCleanupQuarantines
    expect(quarantines.size).toBe(1)

    await expect(
      adapter.startSession({
        threadId: "cursor-different-thread" as ThreadId,
      })
    ).rejects.toMatchObject({
      code: "CURSOR_ACP_CLEANUP_QUARANTINED",
      statusCode: 503,
    })
    expect(factory).toHaveBeenCalledTimes(1)

    await expect(adapter.stopAll()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(3)
    expect(quarantines.size).toBe(0)
  })

  it("re-attempts a quarantined runtime after the retry window and releases it only once the close is confirmed", async () => {
    const stuck = new FakeCursorRuntime()
    vi.spyOn(stuck, "setModel").mockRejectedValueOnce(
      new Error("model setup failed")
    )
    const close = vi
      .spyOn(stuck, "close")
      .mockRejectedValue(new Error("cursor runtime close failed"))
    const healthy = new FakeCursorRuntime()
    const factory = vi.fn().mockReturnValueOnce(stuck).mockReturnValue(healthy)
    const adapter = new CursorAcpAdapter({
      providerInstanceId: "cursor",
      binaryPath: "node",
      runtimeFactory: factory,
    })

    await expect(
      adapter.startSession({
        threadId: "cursor-ttl-a" as ThreadId,
        modelSelection: { instanceId: "cursor", model: "gpt-5.4" },
      })
    ).rejects.toMatchObject({ name: "AggregateError" })
    await expect(
      adapter.startSession({ threadId: "cursor-ttl-b" as ThreadId })
    ).rejects.toMatchObject({ code: "CURSOR_ACP_CLEANUP_QUARANTINED" })
    const quarantines = (
      adapter as unknown as {
        runtimeCleanupQuarantines: Map<
          unknown,
          { firstFailedAt: number | null }
        >
      }
    ).runtimeCleanupQuarantines
    expect(quarantines.size).toBe(1)

    const error = vi.spyOn(logger, "error").mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(Date.now() + CLEANUP_QUARANTINE_RETRY_WINDOW_MS + 1)
      const expiredAt = Date.now()
      // The window passed but the runtime still will not close: it is NOT
      // released on the timer (that forgot a live process), it stays
      // quarantined with a fresh window and new sessions stay blocked.
      await expect(
        adapter.startSession({ threadId: "cursor-ttl-c" as ThreadId })
      ).rejects.toMatchObject({ code: "CURSOR_ACP_CLEANUP_QUARANTINED" })
      expect(quarantines.size).toBe(1)
      expect([...quarantines.values()][0]?.firstFailedAt).toBe(expiredAt)
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ attempts: 3 }),
        expect.stringContaining(
          "quarantined Cursor ACP runtime still would not close after the retry window; keeping it quarantined"
        )
      )
      expect(factory).toHaveBeenCalledTimes(1)

      // Only a confirmed close releases it.
      close.mockResolvedValue(undefined)
      await expect(
        adapter.startSession({ threadId: "cursor-ttl-d" as ThreadId })
      ).resolves.toBeDefined()
      expect(quarantines.size).toBe(0)
    } finally {
      vi.useRealTimers()
      error.mockRestore()
    }
    await adapter.stopAll()
  })

  it("maps Cursor ACP events and routes approval plus user-input replies", async () => {
    const runtime = new FakeCursorRuntime()
    const adapter = new CursorAcpAdapter({
      providerInstanceId: "cursor",
      binaryPath: "node",
      runtimeFactory: () => runtime,
    })
    const events: Array<{
      type: string
      payload?: unknown
      requestId?: string
    }> = []
    adapter.subscribe((event) => events.push(event))

    await adapter.startSession({ threadId: "thread-2" as ThreadId })
    await adapter.sendTurn({
      threadId: "thread-2" as ThreadId,
      message: "Build this",
      modelId: "composer-2",
      modelSelection: {
        instanceId: "cursor",
        model: "composer-2",
        options: [],
      },
      history: [],
    })

    expect(runtime.prompts).toEqual([
      { prompt: [{ type: "text", text: "Build this" }] },
    ])
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "item.updated",
        "turn.completed",
      ])
    )
    const commandEvents = events.filter(
      (event) =>
        (event.type === "item.updated" || event.type === "item.completed") &&
        (event.payload as { itemType?: string } | undefined)?.itemType ===
          "command_execution"
    )
    expect(commandEvents.map((event) => event.type)).toEqual([
      "item.updated",
      "item.updated",
      "item.completed",
    ])
    expect(commandEvents.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        itemType: "command_execution",
        status: "inProgress",
        detail: "pwd",
      }),
      expect.objectContaining({
        itemType: "command_execution",
        status: "inProgress",
        detail: "pwd",
      }),
      expect.objectContaining({
        itemType: "command_execution",
        status: "completed",
        detail: "pwd",
      }),
    ])
    expect(
      events.find((event) => event.type === "turn.plan.updated")?.payload
    ).toMatchObject({
      plan: [{ step: "Inspect", status: "completed" }],
    })

    const permissionPromise = runtime.triggerPermission({
      kind: "execute",
      detail: "cat package.json",
      raw: {
        toolCall: { kind: "execute" },
        options: [
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "reject-once", kind: "reject_once" },
        ],
      },
    })
    await flushAsync()
    const permissionRequest = events.find(
      (event) => event.type === "request.opened"
    )
    expect(permissionRequest?.payload).toMatchObject({
      requestType: "exec_command_approval",
      detail: "cat package.json",
    })
    await adapter.respondToRequest(
      "thread-2" as ThreadId,
      permissionRequest?.requestId as ApprovalRequestId,
      { kind: "tool_approval", decision: "approve" }
    )
    await expect(permissionPromise).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "allow-once" },
    })

    const questionPromise = runtime.triggerAskQuestion({
      questions: [
        {
          id: "scope",
          prompt: "Which scope?",
          options: [{ id: "workspace", label: "Workspace" }],
        },
      ],
    })
    await flushAsync()
    const questionRequest = events.find(
      (event) => event.type === "user-input.requested"
    )
    expect(questionRequest?.payload).toMatchObject({
      questions: [
        {
          id: "scope",
          question: "Which scope?",
          options: [{ label: "Workspace", description: "Workspace" }],
        },
      ],
    })
    await adapter.respondToRequest(
      "thread-2" as ThreadId,
      questionRequest?.requestId as ApprovalRequestId,
      { kind: "user_input", answers: { scope: "workspace" } }
    )
    await expect(questionPromise).resolves.toEqual({
      answers: { scope: "workspace" },
    })
  })

  it("returns a nonfatal rejection for a durable denial even in full-access mode", async () => {
    const runtime = new FakeCursorRuntime()
    let permissionResult: unknown
    vi.spyOn(runtime, "prompt").mockImplementationOnce(async () => {
      permissionResult = await runtime.triggerPermission({
        kind: "execute",
        detail: "write src/blocked.ts",
        raw: {
          path: "src/blocked.ts",
          options: [
            { optionId: "allow-once", kind: "allow_once" },
            { optionId: "reject-once", kind: "reject_once" },
          ],
        },
      })
      return { stopReason: "end_turn" }
    })
    const adapter = new CursorAcpAdapter({
      providerInstanceId: "cursor",
      binaryPath: "node",
      runtimeFactory: () => runtime,
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    adapter.subscribe((event) => events.push(event))
    configureAgentPermissionRuntime({
      evaluateTool: () => ({
        decision: "deny",
        source: "grant",
        reason: "Matched workspace deny grant.",
        normalizedPath: "src/blocked.ts",
        grant: null,
      }),
      listGrants: () => [],
    })
    bindAgentPermissionRuntimeContext({
      threadId: "thread-durable-deny",
      workspacePath: "/tmp/project",
      appMode: "agent",
      permissionLevel: "full-access",
    })

    await adapter.startSession({
      threadId: "thread-durable-deny" as ThreadId,
      cwd: "/tmp/project",
      runtimeMode: "full-access",
    })
    await adapter.sendTurn({
      threadId: "thread-durable-deny" as ThreadId,
      message: "Write the file",
      modelId: "composer-2",
      history: [],
      projectPath: "/tmp/project",
      appMode: "agent",
      permissionLevel: "full-access",
    })

    expect(permissionResult).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.denied",
        payload: {
          toolName: "exec_command_approval",
          reason: "Matched workspace deny grant.",
        },
      })
    )
    expect(events.some((event) => event.type === "request.opened")).toBe(false)
    await adapter.stopAll()
  })

  it("does not expose rejected prompt diagnostics in public events", async () => {
    const runtime = new FakeCursorRuntime()
    const privateDiagnostic =
      "spawn failed at C:\\private\\cursor.json with token sk-sensitive"
    vi.spyOn(runtime, "prompt").mockRejectedValueOnce(
      new Error(privateDiagnostic)
    )
    const adapter = new CursorAcpAdapter({
      providerInstanceId: "cursor",
      binaryPath: "node",
      runtimeFactory: () => runtime,
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    adapter.subscribe((event) => events.push(event))

    await adapter.startSession({ threadId: "thread-private-error" as ThreadId })
    await expect(
      adapter.sendTurn({
        threadId: "thread-private-error" as ThreadId,
        message: "Build this",
        modelId: "composer-2",
        history: [],
      })
    ).rejects.toThrow(privateDiagnostic)

    expect(JSON.stringify(events)).not.toContain(privateDiagnostic)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runtime.error",
          payload: {
            message: "Cursor provider failed.",
            class: "provider_error",
          },
        }),
      ])
    )
  })

  it("discovers Cursor models from ACP config options", async () => {
    const adapter = new CursorAcpAdapter({
      binaryPath: "node",
      runtimeFactory: () => new FakeCursorRuntime(),
      customModels: ["cursor/custom"],
    })

    await expect(adapter.availableModels()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "default", name: "Auto" }),
        expect.objectContaining({ slug: "composer-2", name: "Composer 2" }),
        expect.objectContaining({ slug: "gpt-5.4", name: "GPT 5.4" }),
        expect.objectContaining({
          slug: "cursor/custom",
          isCustom: true,
        }),
      ])
    )
  })

  it("defaults unanswered approval and user-input requests after five minutes", async () => {
    vi.useFakeTimers()
    try {
      const runtime = new FakeCursorRuntime()
      const adapter = new CursorAcpAdapter({
        binaryPath: "node",
        runtimeFactory: () => runtime,
      })
      await adapter.startSession({ threadId: "thread-timeout" as ThreadId })

      const approval = runtime.triggerPermission({
        kind: "execute",
        raw: {
          options: [
            { optionId: "allow-once", kind: "allow_once" },
            { optionId: "reject-once", kind: "reject_once" },
          ],
        },
      })
      const question = runtime.triggerAskQuestion({
        questions: [{ id: "scope", prompt: "Which scope?" }],
      })

      await vi.advanceTimersByTimeAsync(CURSOR_ACP_PENDING_REQUEST_TIMEOUT_MS)

      await expect(approval).resolves.toMatchObject({
        outcome: { outcome: "selected", optionId: "reject-once" },
      })
      await expect(question).resolves.toEqual({ answers: {} })
    } finally {
      vi.useRealTimers()
    }
  })

  it("removes the session and emits an error exit when ACP dies", async () => {
    const runtime = new FakeCursorRuntime()
    const adapter = new CursorAcpAdapter({
      binaryPath: "node",
      runtimeFactory: () => runtime,
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    adapter.subscribe((event) => events.push(event))
    const threadId = "thread-exit" as ThreadId
    await adapter.startSession({ threadId })

    runtime.triggerExit({ code: 17, signal: null })

    expect(adapter.hasSession(threadId)).toBe(false)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runtime.error",
          payload: expect.objectContaining({
            message: expect.stringContaining("code=17"),
          }),
        }),
        expect.objectContaining({
          type: "session.exited",
          payload: expect.objectContaining({
            exitKind: "error",
            recoverable: true,
          }),
        }),
      ])
    )
  })
})

class FakeCursorRuntime implements CursorAcpRuntime {
  readonly calls: Array<ReadonlyArray<unknown>> = []
  readonly prompts: Array<{ prompt: ReadonlyArray<Record<string, unknown>> }> =
    []
  private readonly eventListeners = new Set<(event: CursorAcpEvent) => void>()
  private readonly exitListeners = new Set<(event: CursorAcpExit) => void>()
  private permissionHandler:
    | ((request: CursorAcpPermissionRequest) => Promise<unknown>)
    | null = null
  private extRequestHandlers = new Map<
    string,
    (params: unknown) => Promise<unknown>
  >()

  /** Simulates `session/load` failing and the runtime falling back to `session/new`. */
  resumeFellBack = false

  constructor(readonly options?: CursorAcpRuntimeOptions) {}

  async start() {
    this.calls.push(["start"])
    return {
      sessionId: "cursor-session-1",
      resumed: Boolean(this.options?.resumeSessionId) && !this.resumeFellBack,
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "cursor-session-1",
        modes: modeState,
        configOptions,
      } satisfies CursorAcpSessionSetupResult,
      modeState,
      configOptions,
      modelConfigId: "model",
    }
  }

  getConfigOptions() {
    return configOptions
  }

  getModeState() {
    return modeState
  }

  async setConfigOption(configId: string, value: string | boolean) {
    this.calls.push(["setConfigOption", configId, value])
    return { configOptions }
  }

  async setModel(model: string) {
    this.calls.push(["setModel", model])
  }

  async setMode(modeId: string) {
    this.calls.push(["setMode", modeId])
  }

  async prompt(input: { prompt: ReadonlyArray<Record<string, unknown>> }) {
    this.prompts.push(input)
    this.emit({
      type: "plan.updated",
      payload: { plan: [{ step: "Inspect", status: "completed" }] },
      raw: { update: { sessionUpdate: "plan" } },
    })
    this.emit({ type: "assistant.started", itemId: "assistant-1" })
    this.emit({
      type: "content.delta",
      itemId: "assistant-1",
      text: "Hello from Cursor",
      raw: { update: { sessionUpdate: "agent_message_chunk" } },
    })
    this.emit({ type: "assistant.completed", itemId: "assistant-1" })
    this.emit({
      type: "tool.updated",
      raw: { update: { sessionUpdate: "tool_call_update" } },
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        title: "Terminal",
        status: "pending",
        command: "pwd",
        detail: "pwd",
        data: { command: "pwd" },
      },
    })
    this.emit({
      type: "tool.updated",
      raw: { update: { sessionUpdate: "tool_call_update" } },
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        title: "Terminal",
        status: "inProgress",
        command: "pwd",
        detail: "pwd",
        data: { command: "pwd" },
      },
    })
    this.emit({
      type: "tool.updated",
      raw: { update: { sessionUpdate: "tool_call_update" } },
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        title: "Terminal",
        status: "completed",
        command: "pwd",
        detail: "pwd",
        data: { command: "pwd" },
      },
    })
    return { stopReason: "end_turn" }
  }

  async cancel() {}
  async close() {
    this.calls.push(["close"])
  }

  onEvent(listener: (event: CursorAcpEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onExit(listener: (event: CursorAcpExit) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  onPermissionRequest(
    handler: (request: CursorAcpPermissionRequest) => Promise<unknown>
  ): void {
    this.permissionHandler = handler
  }

  onExtRequest(
    method: string,
    handler: (params: unknown) => Promise<unknown>
  ): void {
    this.extRequestHandlers.set(method, handler)
  }

  onExtNotification(): void {}

  async triggerPermission(
    request: CursorAcpPermissionRequest
  ): Promise<unknown> {
    if (!this.permissionHandler) throw new Error("no permission handler")
    return await this.permissionHandler(request)
  }

  async triggerAskQuestion(params: unknown): Promise<unknown> {
    const handler = this.extRequestHandlers.get("cursor/ask_question")
    if (!handler) throw new Error("no ask question handler")
    return await handler(params)
  }

  triggerExit(event: CursorAcpExit): void {
    for (const listener of [...this.exitListeners]) listener(event)
  }

  private emit(event: CursorAcpEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
