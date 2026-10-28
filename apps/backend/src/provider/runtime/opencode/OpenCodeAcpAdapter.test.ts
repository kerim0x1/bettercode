import { afterEach, describe, expect, it, vi } from "vitest"
import {
  OpenCodeAcpAdapter,
  openCodeReadOnlyDeniesAcpKind,
} from "./OpenCodeAcpAdapter"
import type {
  OpenCodeAcpEvent,
  OpenCodeAcpExit,
  OpenCodeAcpModeState,
  OpenCodeAcpPermissionRequest,
  OpenCodeAcpRuntime,
  OpenCodeAcpRuntimeOptions,
  OpenCodeAcpSessionSetupResult,
} from "./OpenCodeAcpRuntime"
import { modeStateFromConfigOptions } from "../acp/AcpSessionConfig"
import type { AcpSessionConfigOption } from "../acp/AcpSessionConfig"
import type { ApprovalRequestId, ThreadId } from "../contracts"
import { setDefaultAgentPermissionRuntime } from "../../agent-permission-runtime"

const OPENCODE_CONFIG_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: "opencode/big-pickle",
    options: [
      { value: "opencode/big-pickle", name: "Big Pickle" },
      { value: "opencode/grok-code", name: "Grok Code" },
      {
        value: "anthropic/claude-sonnet-4:thinking",
        name: "Claude Sonnet 4 (thinking)",
      },
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
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select" as const,
    currentValue: "build",
    options: [
      { value: "build", name: "Build" },
      { value: "plan", name: "Plan" },
    ],
  },
] satisfies ReadonlyArray<AcpSessionConfigOption>

const PERMISSION_OPTIONS = {
  options: [
    { optionId: "once", kind: "allow_once" },
    { optionId: "always", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ],
}

interface TestEvent {
  readonly type: string
  readonly payload?: unknown
  readonly usage?: unknown
  readonly requestId?: string
  readonly providerKind?: string
  readonly providerInstanceId?: string
  readonly raw?: { source?: string }
}

function createAdapter(runtime: FakeOpenCodeRuntime) {
  const factory = vi.fn(() => runtime)
  const adapter = new OpenCodeAcpAdapter({
    providerInstanceId: "opencode-cli",
    binaryPath: "/usr/local/bin/opencode",
    runtimeFactory: factory,
  })
  const events: TestEvent[] = []
  adapter.subscribe((event) => events.push(event))
  return { adapter, events, factory }
}

afterEach(() => {
  setDefaultAgentPermissionRuntime(null)
  vi.restoreAllMocks()
})

describe("OpenCodeAcpAdapter", () => {
  it("starts an ACP session, selects the model, effort and native plan mode", async () => {
    const runtime = new FakeOpenCodeRuntime()
    const { adapter, factory } = createAdapter(runtime)

    const session = await adapter.startSession({
      threadId: "thread-1" as ThreadId,
      cwd: "/tmp/project",
      runtimeMode: "plan",
      resumeCursor: { schemaVersion: 1, sessionId: "opencode-old" },
      modelSelection: {
        instanceId: "opencode-cli",
        model: "opencode/big-pickle",
        options: [{ id: "effort", value: "high" }],
      },
    })

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { binaryPath: "/usr/local/bin/opencode" },
        cwd: "/tmp/project",
        resumeSessionId: "opencode-old",
      })
    )
    expect(session).toMatchObject({
      providerInstanceId: "opencode-cli",
      providerThreadId: "opencode-session-1",
      continuationKey: "opencode-cli:opencode-cli",
      status: "ready",
      cwd: "/tmp/project",
      runtimeMode: "plan",
      resumeCursor: { schemaVersion: 1, sessionId: "opencode-session-1" },
    })
    expect(runtime.calls).toEqual(
      expect.arrayContaining([
        ["setModel", "opencode/big-pickle"],
        ["setConfigOption", "effort", "high"],
        ["setMode", "plan"],
      ])
    )

    await adapter.stopAll()
  })

  it("discovers provider-qualified model slugs from ACP config options", async () => {
    const { adapter } = createAdapter(new FakeOpenCodeRuntime())

    const models = await adapter.availableModels()

    expect(models.map((model) => model.slug)).toEqual([
      "opencode/big-pickle",
      "opencode/grok-code",
      "anthropic/claude-sonnet-4:thinking",
    ])
    expect(models[2]).toMatchObject({
      name: "Claude Sonnet 4 (thinking)",
      shortName: "Claude Sonnet 4 (thinking)",
    })
  })

  it("falls back to the hardcoded Big Pickle entry when the agent advertises no models", async () => {
    const runtime = new FakeOpenCodeRuntime(undefined, { configOptions: [] })
    const { adapter } = createAdapter(runtime)

    await expect(adapter.availableModels()).resolves.toEqual([
      expect.objectContaining({
        slug: "opencode/big-pickle",
        name: "Big Pickle",
        tier: "Fallback",
      }),
    ])
  })

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
      expect(openCodeReadOnlyDeniesAcpKind(kind)).toBe(denied)
    }
  )

  it("denies an edit in read-only mode without opening an approval", async () => {
    const runtime = new FakeOpenCodeRuntime()
    const { adapter, events } = createAdapter(runtime)
    const threadId = "thread-read-only" as ThreadId
    await adapter.startSession({ threadId, runtimeMode: "read-only" })
    // The runtime advertises build/plan but no approval/ask mode, so the
    // native mode is kept and the per-tool ceiling is what protects the
    // workspace (it is checked before durable grants).
    expect(runtime.calls.filter((call) => call[0] === "setMode")).toEqual([])

    await expect(
      runtime.triggerPermission({
        kind: "edit",
        detail: "write src/app.ts",
        raw: PERMISSION_OPTIONS,
      })
    ).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "reject" },
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.denied",
        payload: {
          toolName: "file_change_approval",
          reason:
            "Read-only mode: OpenCode may read and search this workspace but not change it.",
        },
      })
    )
    expect(events.some((event) => event.type === "request.opened")).toBe(false)

    await adapter.stopAll()
  })

  it("routes once/always/reject permission options through the approval decision", async () => {
    const runtime = new FakeOpenCodeRuntime()
    const { adapter, events } = createAdapter(runtime)
    const threadId = "thread-approvals" as ThreadId
    await adapter.startSession({ threadId })

    const approve = runtime.triggerPermission({
      kind: "edit",
      detail: "write src/app.ts",
      raw: PERMISSION_OPTIONS,
    })
    await flushAsync()
    const approveRequest = events.find(
      (event) => event.type === "request.opened"
    )
    expect(approveRequest?.payload).toMatchObject({
      requestType: "file_change_approval",
      detail: "write src/app.ts",
    })
    await adapter.respondToRequest(
      threadId,
      approveRequest?.requestId as ApprovalRequestId,
      { kind: "tool_approval", decision: "approve" }
    )
    await expect(approve).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "once" },
    })

    const deny = runtime.triggerPermission({
      kind: "edit",
      detail: "write src/other.ts",
      raw: PERMISSION_OPTIONS,
    })
    await flushAsync()
    const denyRequest = events
      .filter((event) => event.type === "request.opened")
      .at(-1)
    await adapter.respondToRequest(
      threadId,
      denyRequest?.requestId as ApprovalRequestId,
      { kind: "tool_approval", decision: "deny" }
    )
    await expect(deny).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "reject" },
    })

    await adapter.stopAll()
  })

  it("selects allow_always without asking in full-access mode", async () => {
    const runtime = new FakeOpenCodeRuntime()
    const { adapter, events } = createAdapter(runtime)
    const threadId = "thread-full-access" as ThreadId
    await adapter.startSession({ threadId, runtimeMode: "full-access" })

    await expect(
      runtime.triggerPermission({
        kind: "edit",
        detail: "write src/app.ts",
        raw: PERMISSION_OPTIONS,
      })
    ).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "always" },
    })
    expect(events.some((event) => event.type === "request.opened")).toBe(false)

    await adapter.stopAll()
  })

  it("auto-approves edits but still asks before running bash in auto-accept-edits", async () => {
    const runtime = new FakeOpenCodeRuntime()
    const { adapter, events } = createAdapter(runtime)
    const threadId = "thread-auto-edits" as ThreadId
    await adapter.startSession({ threadId, runtimeMode: "auto-accept-edits" })

    await expect(
      runtime.triggerPermission({
        kind: "edit",
        detail: "write src/app.ts",
        raw: PERMISSION_OPTIONS,
      })
    ).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "once" },
    })
    expect(events.some((event) => event.type === "request.opened")).toBe(false)

    const bash = runtime.triggerPermission({
      kind: "execute",
      detail: "bash -lc 'rm -rf dist'",
      raw: PERMISSION_OPTIONS,
    })
    await flushAsync()
    const bashRequest = events
      .filter((event) => event.type === "request.opened")
      .at(-1)
    expect(bashRequest?.payload).toMatchObject({
      requestType: "exec_command_approval",
    })
    await adapter.respondToRequest(
      threadId,
      bashRequest?.requestId as ApprovalRequestId,
      { kind: "tool_approval", decision: "deny" }
    )
    await expect(bash).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "reject" },
    })

    await adapter.stopAll()
  })

  it("emits token usage once before the turn completes", async () => {
    const runtime = new FakeOpenCodeRuntime(undefined, {
      promptResult: {
        stopReason: "end_turn",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedReadTokens: 4,
        },
      },
      usage: { totalTokens: 15, totalCostUsd: 0.02 },
    })
    const { adapter, events } = createAdapter(runtime)
    const threadId = "thread-usage" as ThreadId
    await adapter.startSession({ threadId })

    await adapter.sendTurn({
      threadId,
      message: "Build this",
      modelId: "opencode/big-pickle",
      history: [],
    })

    const types = events.map((event) => event.type)
    expect(types.filter((type) => type === "token.usage")).toHaveLength(1)
    expect(
      types.filter((type) => type === "thread.token-usage.updated")
    ).toHaveLength(1)
    const tokenIndex = types.indexOf("token.usage")
    const updatedIndex = types.indexOf("thread.token-usage.updated")
    const completedIndex = types.indexOf("turn.completed")
    expect(tokenIndex).toBeGreaterThan(-1)
    expect(tokenIndex).toBeLessThan(updatedIndex)
    expect(updatedIndex).toBeLessThan(completedIndex)
    expect(events[tokenIndex]).toMatchObject({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 4,
        cacheReadTokens: 4,
        totalCostUsd: 0.02,
      },
    })
    expect(events[updatedIndex]?.payload).toMatchObject({
      usage: {
        usedTokens: 15,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 4,
        totalCostUsd: 0.02,
      },
    })

    await adapter.stopAll()
  })

  it("emits no usage events when neither the result nor the snapshot reports usage", async () => {
    const runtime = new FakeOpenCodeRuntime()
    const { adapter, events } = createAdapter(runtime)
    const threadId = "thread-no-usage" as ThreadId
    await adapter.startSession({ threadId })

    await adapter.sendTurn({
      threadId,
      message: "Build this",
      modelId: "opencode/big-pickle",
      history: [],
    })

    expect(events.some((event) => event.type === "token.usage")).toBe(false)
    expect(
      events.some((event) => event.type === "thread.token-usage.updated")
    ).toBe(false)
    expect(events.some((event) => event.type === "turn.completed")).toBe(true)

    await adapter.stopAll()
  })

  it("passes a versioned resume cursor and a bare providerThreadId to the runtime", async () => {
    const runtime = new FakeOpenCodeRuntime()
    const { adapter, factory } = createAdapter(runtime)

    await adapter.startSession({
      threadId: "thread-resume" as ThreadId,
      resumeCursor: { schemaVersion: 1, sessionId: "opencode-old" },
    })
    expect(factory).toHaveBeenLastCalledWith(
      expect.objectContaining({ resumeSessionId: "opencode-old" })
    )

    await adapter.startSession({
      threadId: "thread-bare-resume" as ThreadId,
      resumeCursor: { providerThreadId: "opencode-bare" },
    })
    expect(factory).toHaveBeenLastCalledWith(
      expect.objectContaining({ resumeSessionId: "opencode-bare" })
    )

    await adapter.stopAll()
  })

  it("removes the session and emits an error exit when the ACP process dies", async () => {
    const runtime = new FakeOpenCodeRuntime()
    const { adapter, events } = createAdapter(runtime)
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

  it("globally quarantines and retries a failed startup runtime cleanup", async () => {
    const runtime = new FakeOpenCodeRuntime()
    const setupFailure = new Error("mode setup failed")
    const cleanupFailure = new Error("opencode runtime close failed")
    vi.spyOn(runtime, "setMode").mockRejectedValueOnce(setupFailure)
    const close = vi
      .spyOn(runtime, "close")
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const { adapter, factory } = createAdapter(runtime)

    await expect(
      adapter.startSession({
        threadId: "opencode-failed-start" as ThreadId,
        modelSelection: {
          instanceId: "opencode-cli",
          model: "opencode/big-pickle",
        },
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
        threadId: "opencode-different-thread" as ThreadId,
      })
    ).rejects.toMatchObject({
      code: "OPENCODE_ACP_CLEANUP_QUARANTINED",
      statusCode: 503,
    })
    expect(factory).toHaveBeenCalledTimes(1)

    await expect(adapter.stopAll()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(3)
    expect(quarantines.size).toBe(0)
  })
})

interface FakeOpenCodeTweaks {
  readonly configOptions?: ReadonlyArray<AcpSessionConfigOption>
  readonly promptResult?: Record<string, unknown>
  readonly usage?: { totalTokens?: number; totalCostUsd?: number }
}

class FakeOpenCodeRuntime implements OpenCodeAcpRuntime {
  readonly calls: Array<ReadonlyArray<unknown>> = []
  readonly prompts: Array<{ prompt: ReadonlyArray<Record<string, unknown>> }> =
    []
  readonly configOptions: ReadonlyArray<AcpSessionConfigOption>
  readonly modeState: OpenCodeAcpModeState | undefined
  readonly promptResult: Record<string, unknown>
  readonly usage?: { totalTokens?: number; totalCostUsd?: number }
  private readonly eventListeners = new Set<(event: OpenCodeAcpEvent) => void>()
  private readonly exitListeners = new Set<(event: OpenCodeAcpExit) => void>()
  private permissionHandler:
    | ((request: OpenCodeAcpPermissionRequest) => Promise<unknown>)
    | null = null

  constructor(
    readonly options?: OpenCodeAcpRuntimeOptions,
    tweaks: FakeOpenCodeTweaks = {}
  ) {
    this.configOptions = tweaks.configOptions ?? OPENCODE_CONFIG_OPTIONS
    this.modeState = modeStateFromConfigOptions(this.configOptions)
    this.promptResult = tweaks.promptResult ?? { stopReason: "end_turn" }
    this.usage = tweaks.usage
  }

  async start() {
    this.calls.push(["start"])
    const resumeSessionId = this.options?.resumeSessionId
    return {
      sessionId: "opencode-session-1",
      resumed: Boolean(resumeSessionId),
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "opencode-session-1",
        ...(this.modeState ? { modes: this.modeState } : {}),
        configOptions: this.configOptions,
      } satisfies OpenCodeAcpSessionSetupResult,
      ...(this.modeState ? { modeState: this.modeState } : {}),
      configOptions: this.configOptions,
      modelConfigId: "model",
    }
  }

  getConfigOptions() {
    return this.configOptions
  }

  getModeState() {
    return this.modeState
  }

  async setConfigOption(configId: string, value: string | boolean) {
    this.calls.push(["setConfigOption", configId, value])
    return { configOptions: this.configOptions }
  }

  async setModel(model: string) {
    this.calls.push(["setModel", model])
  }

  async setMode(modeId: string) {
    this.calls.push(["setMode", modeId])
  }

  usageSnapshot() {
    return this.usage
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
      text: "Hello from OpenCode",
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
        status: "completed",
        command: "pwd",
        detail: "pwd",
        data: { command: "pwd" },
      },
    })
    return this.promptResult
  }

  async cancel() {
    this.calls.push(["cancel"])
  }

  async close() {
    this.calls.push(["close"])
  }

  onEvent(listener: (event: OpenCodeAcpEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onExit(listener: (event: OpenCodeAcpExit) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  onPermissionRequest(
    handler: (request: OpenCodeAcpPermissionRequest) => Promise<unknown>
  ): void {
    this.permissionHandler = handler
  }

  onExtRequest(): void {}

  onExtNotification(): void {}

  async triggerPermission(
    request: OpenCodeAcpPermissionRequest
  ): Promise<unknown> {
    if (!this.permissionHandler) throw new Error("no permission handler")
    return await this.permissionHandler(request)
  }

  triggerExit(event: OpenCodeAcpExit): void {
    for (const listener of [...this.exitListeners]) listener(event)
  }

  private emit(event: OpenCodeAcpEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
