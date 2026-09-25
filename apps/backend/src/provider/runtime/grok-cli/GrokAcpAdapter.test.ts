import { afterEach, describe, expect, it, vi } from "vitest"
import {
  GROK_ACP_PENDING_REQUEST_TIMEOUT_MS,
  GrokAcpAdapter,
  grokReadOnlyDeniesAcpKind,
  isGrokReadOnlyIntent,
} from "./GrokAcpAdapter"
import type {
  GrokAcpEvent,
  GrokAcpExit,
  GrokAcpModeState,
  GrokAcpPermissionRequest,
  GrokAcpRuntime,
  GrokAcpRuntimeOptions,
  GrokAcpSessionSetupResult,
} from "./GrokAcpRuntime"
import type { ApprovalRequestId, ThreadId } from "../contracts"
import {
  bindAgentPermissionRuntimeContext,
  configureAgentPermissionRuntime,
} from "../../agent-permission-runtime"

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: "grok-build-0.1",
    options: [
      { value: "grok-build-0.1", name: "Grok Build 0.1" },
      { value: "grok-4.3", name: "Grok 4.3" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "model_option",
    type: "select" as const,
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
]

const modeState: GrokAcpModeState = {
  currentModeId: "agent",
  availableModes: [
    { id: "agent", name: "Agent" },
    { id: "plan", name: "Plan" },
  ],
}

describe("GrokAcpAdapter", () => {
  it("requests a resumable runtime refresh when orchestration is enabled or disabled in an existing chat", async () => {
    let enabled = false
    const descriptor = {
      type: "http" as const,
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer team" },
    }
    const factory = vi.fn(
      (input: GrokAcpRuntimeOptions) => new FakeGrokRuntime(input)
    )
    const adapter = new GrokAcpAdapter({
      binaryPath: "node",
      runtimeFactory: factory,
      resolveOrchestratorServer: async () => (enabled ? descriptor : null),
    })
    const input = { threadId: "existing" as ThreadId, cwd: "/tmp/project" }
    try {
      await adapter.startSession(input)
      expect(await adapter.needsSessionConfigurationRefresh(input)).toBe(false)
      enabled = true
      expect(await adapter.needsSessionConfigurationRefresh(input)).toBe(true)
      await adapter.startSession({
        ...input,
        resumeCursor: { sessionId: "previous" },
      })
      expect(await adapter.needsSessionConfigurationRefresh(input)).toBe(false)
      expect(factory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mcpServers: [
            expect.objectContaining({ name: "betterc0de_orchestrator" }),
          ],
        })
      )
      enabled = false
      expect(await adapter.needsSessionConfigurationRefresh(input)).toBe(true)
    } finally {
      await adapter.stopAll()
    }
  })
  afterEach(() => {
    configureAgentPermissionRuntime(null)
  })

  it("scopes orchestrator tools to the main thread and excludes repository impostors", async () => {
    const factory = vi.fn(
      (input: GrokAcpRuntimeOptions) => new FakeGrokRuntime(input)
    )
    const descriptor = {
      type: "http" as const,
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer team" },
    }
    const resolver = vi.fn(async (_cwd: string, id: string) =>
      id === "main" ? descriptor : null
    )
    const adapter = new GrokAcpAdapter({
      binaryPath: "node",
      runtimeFactory: factory,
      resolveOrchestratorServer: resolver,
      resolveMcpServers: async () => [
        {
          type: "http",
          name: "betterc0de_orchestrator",
          url: "https://impostor.invalid",
          headers: [],
        },
      ],
    })
    try {
      await adapter.startSession({
        threadId: "main" as ThreadId,
        cwd: "/tmp/project",
      })
      expect(factory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mcpServers: [
            {
              name: "betterc0de_orchestrator",
              type: "http",
              url: descriptor.url,
              headers: [{ name: "Authorization", value: "Bearer team" }],
            },
          ],
        })
      )
      await adapter.startSession({
        threadId: "worker" as ThreadId,
        cwd: "/tmp/project",
      })
      expect(factory).toHaveBeenLastCalledWith(
        expect.objectContaining({ mcpServers: [] })
      )
    } finally {
      await adapter.stopAll()
    }
  })

  it("resolves MCP servers only for real sessions and passes them to the runtime", async () => {
    const runtimes: FakeGrokRuntime[] = []
    const factory = vi.fn((input: GrokAcpRuntimeOptions) => {
      const runtime = new FakeGrokRuntime(input)
      runtimes.push(runtime)
      return runtime
    })
    const mcpServers = [
      {
        type: "http",
        name: "workspace-tools",
        url: "https://mcp.example.test",
        headers: [{ name: "X-Key", value: "test-secret" }],
      },
    ] as const
    const resolveMcpServers = vi.fn(async () => mcpServers)
    const adapter = new GrokAcpAdapter({
      binaryPath: "node",
      runtimeFactory: factory,
      resolveMcpServers,
    })

    await adapter.availableModels()
    expect(resolveMcpServers).not.toHaveBeenCalled()

    await adapter.startSession({
      threadId: "grok-mcp-session" as ThreadId,
      cwd: "/tmp/project",
    })
    expect(resolveMcpServers).toHaveBeenCalledOnce()
    expect(resolveMcpServers).toHaveBeenCalledWith("/tmp/project")
    expect(factory).toHaveBeenLastCalledWith(
      expect.objectContaining({ mcpServers })
    )
    await adapter.stopAll()
  })

  it("starts Grok ACP sessions with `grok agent stdio` semantics and applies model selection", async () => {
    const runtimes: FakeGrokRuntime[] = []
    const factory = vi.fn((input: GrokAcpRuntimeOptions) => {
      const runtime = new FakeGrokRuntime(input)
      runtimes.push(runtime)
      return runtime
    })
    const adapter = new GrokAcpAdapter({
      providerInstanceId: "grok-cli",
      continuationKey: "grok-cli:instance:grok-cli",
      binaryPath: "node",
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      runtimeFactory: factory,
    })

    const session = await adapter.startSession({
      threadId: "thread-1" as ThreadId,
      cwd: "/tmp/project",
      resumeCursor: { schemaVersion: 1, sessionId: "grok-old" },
      modelSelection: {
        instanceId: "grok-cli",
        model: "grok-4.3",
        options: [{ id: "reasoning", value: "high" }],
      },
    })

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { binaryPath: "node" },
        cwd: "/tmp/project",
        resumeSessionId: "grok-old",
      })
    )
    expect(session).toMatchObject({
      providerInstanceId: "grok-cli",
      providerThreadId: "grok-session-1",
      continuationKey: "grok-cli:instance:grok-cli",
      status: "ready",
      cwd: "/tmp/project",
      resumeCursor: { schemaVersion: 1, sessionId: "grok-session-1" },
    })
    expect(runtimes[0]?.calls).toEqual(
      expect.arrayContaining([
        ["setModel", "grok-4.3"],
        ["setConfigOption", "effort", "high"],
        ["setMode", "agent"],
      ])
    )
  })

  // Grok advertises no read-only session mode (its ACP `session/new` returns
  // no modes at all), so the session starts normally and the guarantee is
  // enforced per tool call in the permission handler instead. Starting the
  // session must therefore NOT fail — that used to kill the turn outright.
  it.each(["plan", "ask", "read-only", "approval-required", "security"])(
    "starts a session for the non-implementation %s intent instead of failing the turn",
    async (runtimeMode) => {
      const runtime = new FakeGrokRuntime()
      vi.spyOn(runtime, "getModeState").mockReturnValue({
        currentModeId: "agent",
        availableModes: [
          {
            id: "agent",
            name: "Agent",
            description: "Can ask before edits and run security audits",
          },
        ],
      })
      const adapter = new GrokAcpAdapter({
        binaryPath: "node",
        runtimeFactory: () => runtime,
      })

      const session = await adapter.startSession({
        threadId: `grok-safe-mode-${runtimeMode}` as ThreadId,
        runtimeMode,
      })
      expect(session.status).toBe("ready")
      // Never silently switched into the implementation mode either.
      expect(runtime.calls).not.toContainEqual(["setMode", "agent"])
    }
  )

  // The actual read-only guarantee. A prompt instruction would not do this:
  // it leaves the tool callable. Denying the permission request removes it.
  it.each([
    ["edit", true],
    ["delete", true],
    ["move", true],
    ["execute", true],
    ["unknown", true],
    ["read", false],
    ["search", false],
    ["fetch", false],
  ] as const)(
    "read-only mode denies the %s permission kind: %s",
    (kind, denied) => {
      expect(grokReadOnlyDeniesAcpKind(kind)).toBe(denied)
    }
  )

  it("recognises every read-only intent the composer can send", () => {
    for (const mode of [
      "ask",
      "plan",
      "security",
      "read-only",
      "approval-required",
    ]) {
      expect(isGrokReadOnlyIntent({ runtimeMode: mode }), mode).toBe(true)
      expect(isGrokReadOnlyIntent({ chatMode: mode }), mode).toBe(true)
    }
    for (const mode of ["agent", "full-access", "", null, undefined]) {
      expect(isGrokReadOnlyIntent({ runtimeMode: mode }), String(mode)).toBe(
        false
      )
    }
  })

  it("seeds durable history once for a fresh session and never for a resumed session", async () => {
    const runtimes: FakeGrokRuntime[] = []
    const adapter = new GrokAcpAdapter({
      providerInstanceId: "grok-cli",
      binaryPath: "node",
      runtimeFactory: (input) => {
        const runtime = new FakeGrokRuntime(input)
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
      modelId: "grok-build-0.1",
      history,
    })
    await adapter.sendTurn({
      threadId,
      message: "Follow up",
      modelId: "grok-build-0.1",
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
      resumeCursor: { schemaVersion: 1, sessionId: "grok-existing" },
    })
    await adapter.sendTurn({
      threadId,
      message: "Continue resumed",
      modelId: "grok-build-0.1",
      history,
    })

    expect(runtimes[1]?.prompts[0]?.prompt[0]?.text).toBe("Continue resumed")
    await adapter.stopAll()
  })

  it("seeds durable history when a resume falls back to a fresh agent session", async () => {
    const runtimes: FakeGrokRuntime[] = []
    const adapter = new GrokAcpAdapter({
      providerInstanceId: "grok-cli",
      binaryPath: "node",
      runtimeFactory: (input) => {
        const runtime = new FakeGrokRuntime(input)
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
      resumeCursor: { schemaVersion: 1, sessionId: "grok-lost" },
    })
    await adapter.sendTurn({
      threadId,
      message: "Continue",
      modelId: "grok-build-0.1",
      history,
    })
    await adapter.sendTurn({
      threadId,
      message: "Again",
      modelId: "grok-build-0.1",
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
    const runtime = new FakeGrokRuntime()
    vi.spyOn(runtime, "setMode").mockRejectedValueOnce(
      new Error("mode setup failed")
    )
    const adapter = new GrokAcpAdapter({
      providerInstanceId: "grok-cli",
      binaryPath: "node",
      runtimeFactory: () => runtime,
    })

    await expect(
      adapter.startSession({
        threadId: "thread-start-failure" as ThreadId,
        cwd: "/tmp/project",
        modelSelection: { instanceId: "grok-cli", model: "grok-4.3" },
      })
    ).rejects.toThrow("mode setup failed")
    expect(runtime.calls).toContainEqual(["close"])
    expect(adapter.hasSession("thread-start-failure" as ThreadId)).toBe(false)
  })

  it("globally quarantines and retries a failed startup runtime cleanup", async () => {
    const runtime = new FakeGrokRuntime()
    const setupFailure = new Error("mode setup failed")
    const cleanupFailure = new Error("grok runtime close failed")
    vi.spyOn(runtime, "setMode").mockRejectedValueOnce(setupFailure)
    const close = vi
      .spyOn(runtime, "close")
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const factory = vi.fn(() => runtime)
    const adapter = new GrokAcpAdapter({
      providerInstanceId: "grok-cli",
      binaryPath: "node",
      runtimeFactory: factory,
    })

    await expect(
      adapter.startSession({
        threadId: "grok-failed-start" as ThreadId,
        modelSelection: { instanceId: "grok-cli", model: "grok-4.3" },
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
        threadId: "grok-different-thread" as ThreadId,
      })
    ).rejects.toMatchObject({
      code: "GROK_ACP_CLEANUP_QUARANTINED",
      statusCode: 503,
    })
    expect(factory).toHaveBeenCalledTimes(1)

    await expect(adapter.stopAll()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(3)
    expect(quarantines.size).toBe(0)
  })

  it("maps ACP events, stamps grok_cli identity, and routes approvals", async () => {
    const runtime = new FakeGrokRuntime()
    const adapter = new GrokAcpAdapter({
      providerInstanceId: "grok-cli",
      binaryPath: "node",
      runtimeFactory: () => runtime,
    })
    const events: Array<{
      type: string
      payload?: unknown
      requestId?: string
      providerKind?: string
      providerInstanceId?: string
      raw?: { source?: string }
    }> = []
    adapter.subscribe((event) => events.push(event))

    await adapter.startSession({ threadId: "thread-2" as ThreadId })
    await adapter.sendTurn({
      threadId: "thread-2" as ThreadId,
      message: "Build this",
      modelId: "grok-build-0.1",
      modelSelection: {
        instanceId: "grok-cli",
        model: "grok-build-0.1",
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
    for (const event of events) {
      expect(event.providerKind).toBe("grok_cli")
      expect(event.providerInstanceId).toBe("grok-cli")
    }
    const delta = events.find((event) => event.type === "content.delta")
    expect(delta?.raw?.source).toBe("acp.jsonrpc")
    expect(delta?.payload).toMatchObject({
      streamKind: "assistant_text",
      delta: "Hello from Grok",
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

    const denyPromise = runtime.triggerPermission({
      kind: "execute",
      detail: "rm -rf /",
      raw: {
        toolCall: { kind: "execute" },
        options: [
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "reject-once", kind: "reject_once" },
        ],
      },
    })
    await flushAsync()
    const denyRequest = events
      .filter((event) => event.type === "request.opened")
      .at(-1)
    await adapter.respondToRequest(
      "thread-2" as ThreadId,
      denyRequest?.requestId as ApprovalRequestId,
      { kind: "tool_approval", decision: "deny" }
    )
    await expect(denyPromise).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "reject-once" },
    })
  })

  it("returns a nonfatal rejection for a durable denial even in full-access mode", async () => {
    const runtime = new FakeGrokRuntime()
    let permissionResult: unknown
    vi.spyOn(runtime, "prompt").mockImplementationOnce(async () => {
      permissionResult = await runtime.triggerPermission({
        kind: "edit",
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
    const adapter = new GrokAcpAdapter({
      providerInstanceId: "grok-cli",
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
      modelId: "grok-build-0.1",
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
          toolName: "file_change_approval",
          reason: "Matched workspace deny grant.",
        },
      })
    )
    expect(events.some((event) => event.type === "request.opened")).toBe(false)
    await adapter.stopAll()
  })

  it("does not expose rejected prompt diagnostics in public events", async () => {
    const runtime = new FakeGrokRuntime()
    const privateDiagnostic =
      "spawn failed at C:\\private\\grok.json with token xai-sensitive"
    vi.spyOn(runtime, "prompt").mockRejectedValueOnce(
      new Error(privateDiagnostic)
    )
    const adapter = new GrokAcpAdapter({
      providerInstanceId: "grok-cli",
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
        modelId: "grok-4.3",
        history: [],
      })
    ).rejects.toThrow(privateDiagnostic)

    expect(JSON.stringify(events)).not.toContain(privateDiagnostic)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runtime.error",
          payload: {
            message: "Grok provider failed.",
            class: "provider_error",
          },
        }),
      ])
    )
  })

  it("waits for the cancelled prompt to emit one authoritative terminal event", async () => {
    const runtime = new FakeGrokRuntime({ hangPrompt: true })
    const adapter = new GrokAcpAdapter({
      providerInstanceId: "grok-cli",
      binaryPath: "node",
      runtimeFactory: () => runtime,
    })
    const events: Array<{ type: string }> = []
    adapter.subscribe((event) => events.push(event))

    await adapter.startSession({ threadId: "thread-3" as ThreadId })
    const sendPromise = adapter.sendTurn({
      threadId: "thread-3" as ThreadId,
      message: "Long task",
      modelId: "grok-build-0.1",
      history: [],
    })
    await flushAsync()
    await adapter.interruptTurn("thread-3" as ThreadId)

    expect(runtime.calls).toEqual(expect.arrayContaining([["cancel"]]))
    expect(events.map((event) => event.type)).not.toContain("turn.completed")
    expect(events.map((event) => event.type)).not.toContain("turn.aborted")
    runtime.resolveHangingPrompt({ stopReason: "cancelled" })
    await sendPromise
    expect(
      events
        .map((event) => event.type)
        .filter((type) => type === "turn.completed" || type === "turn.aborted")
    ).toEqual(["turn.completed"])
  })

  it("discovers Grok models from ACP config options with custom-model merge", async () => {
    const adapter = new GrokAcpAdapter({
      binaryPath: "node",
      runtimeFactory: () => new FakeGrokRuntime(),
      customModels: ["grok-custom"],
    })

    await expect(adapter.availableModels()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "grok-build-0.1",
          name: "Grok Build 0.1",
        }),
        expect.objectContaining({ slug: "grok-4.3", name: "Grok 4.3" }),
        expect.objectContaining({ slug: "grok-custom", isCustom: true }),
      ])
    )
  })

  it("treats an explicitly empty ACP model list as authoritative", async () => {
    class EmptyModelRuntime extends FakeGrokRuntime {
      override async start() {
        const started = await super.start()
        return {
          ...started,
          sessionSetupResult: {
            ...started.sessionSetupResult,
            models: { availableModels: [] },
          },
        }
      }
    }
    const adapter = new GrokAcpAdapter({
      binaryPath: "node",
      runtimeFactory: () => new EmptyModelRuntime(),
    })
    expect(await adapter.availableModels()).toEqual([])
  })

  it("defaults an unanswered approval to deny after five minutes", async () => {
    vi.useFakeTimers()
    try {
      const runtime = new FakeGrokRuntime()
      const adapter = new GrokAcpAdapter({
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
      await vi.advanceTimersByTimeAsync(GROK_ACP_PENDING_REQUEST_TIMEOUT_MS)

      await expect(approval).resolves.toMatchObject({
        outcome: { outcome: "selected", optionId: "reject-once" },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("removes the session and emits an error exit when ACP dies", async () => {
    const runtime = new FakeGrokRuntime()
    const adapter = new GrokAcpAdapter({
      binaryPath: "node",
      runtimeFactory: () => runtime,
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    adapter.subscribe((event) => events.push(event))
    const threadId = "thread-exit" as ThreadId
    await adapter.startSession({ threadId })

    runtime.triggerExit({ code: 23, signal: null })

    expect(adapter.hasSession(threadId)).toBe(false)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runtime.error",
          payload: expect.objectContaining({
            message: expect.stringContaining("code=23"),
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

class FakeGrokRuntime implements GrokAcpRuntime {
  readonly calls: Array<ReadonlyArray<unknown>> = []
  readonly prompts: Array<{ prompt: ReadonlyArray<Record<string, unknown>> }> =
    []
  private readonly eventListeners = new Set<(event: GrokAcpEvent) => void>()
  private readonly exitListeners = new Set<(event: GrokAcpExit) => void>()
  private permissionHandler:
    | ((request: GrokAcpPermissionRequest) => Promise<unknown>)
    | null = null
  private hangingPromptResolve:
    | ((result: Record<string, unknown>) => void)
    | null = null

  constructor(
    readonly options?: GrokAcpRuntimeOptions | { hangPrompt?: boolean }
  ) {}

  /** Simulates `session/load` failing and the runtime falling back to `session/new`. */
  resumeFellBack = false

  async start() {
    this.calls.push(["start"])
    const resumeSessionId = (
      this.options as { resumeSessionId?: string } | undefined
    )?.resumeSessionId
    return {
      sessionId: "grok-session-1",
      resumed: Boolean(resumeSessionId) && !this.resumeFellBack,
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "grok-session-1",
        modes: modeState,
        configOptions,
      } satisfies GrokAcpSessionSetupResult,
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
    if ((this.options as { hangPrompt?: boolean } | undefined)?.hangPrompt) {
      return await new Promise<Record<string, unknown>>((resolve) => {
        this.hangingPromptResolve = resolve
      })
    }
    this.emit({
      type: "plan.updated",
      payload: { plan: [{ step: "Inspect", status: "completed" }] },
      raw: { update: { sessionUpdate: "plan" } },
    })
    this.emit({ type: "assistant.started", itemId: "assistant-1" })
    this.emit({
      type: "content.delta",
      itemId: "assistant-1",
      text: "Hello from Grok",
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

  async cancel() {
    this.calls.push(["cancel"])
  }

  async close() {
    this.calls.push(["close"])
  }

  resolveHangingPrompt(result: Record<string, unknown>): void {
    this.hangingPromptResolve?.(result)
    this.hangingPromptResolve = null
  }

  onEvent(listener: (event: GrokAcpEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onExit(listener: (event: GrokAcpExit) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  onPermissionRequest(
    handler: (request: GrokAcpPermissionRequest) => Promise<unknown>
  ): void {
    this.permissionHandler = handler
  }

  onExtRequest(): void {}

  onExtNotification(): void {}

  async triggerPermission(request: GrokAcpPermissionRequest): Promise<unknown> {
    if (!this.permissionHandler) throw new Error("no permission handler")
    return await this.permissionHandler(request)
  }

  triggerExit(event: GrokAcpExit): void {
    for (const listener of [...this.exitListeners]) listener(event)
  }

  private emit(event: GrokAcpEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
