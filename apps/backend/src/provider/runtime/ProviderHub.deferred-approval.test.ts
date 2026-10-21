import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  ProviderAdapterShape,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderKind,
  ThreadId,
} from "./contracts"
import { ProviderHub } from "./ProviderHub"
import {
  configureAgentPermissionRuntime,
  currentAgentPermissionRuntimeContext,
} from "../agent-permission-runtime"

afterEach(() => configureAgentPermissionRuntime(null))

/**
 * Regression cover for adapters that manage their own lifecycle.
 *
 * Codex and the ACP adapters resolve `sendTurn` as soon as the provider
 * *accepts* the turn — `turn/start` returns, the turn then runs on the other
 * side of an RPC channel and its approval requests arrive afterwards. The
 * existing hub tests all use an adapter whose `sendTurn` spans the whole turn,
 * so two bugs lived in the gap:
 *
 *  1. the permission runtime context was released in a `finally` around
 *     `sendTurn`, leaving durable grants inert for exactly these providers, and
 *  2. nothing enforced the Plan/Ask/read-only ceiling on approvals the provider
 *     asked for, so a provider that requests escalation instead of refusing
 *     (Codex maps read-only onto `approvalPolicy: "untrusted"`) could still get
 *     a write approved in a mode documented as a hard denial.
 */
function deferredApprovalAdapter(): {
  adapter: ProviderAdapterShape
  emit: (event: ProviderRuntimeEvent) => void
  responses: Array<{ requestId: string; decision: ProviderApprovalDecision }>
} {
  const sessions = new Map<string, ProviderSession>()
  const listeners = new Set<(event: ProviderRuntimeEvent) => void>()
  const responses: Array<{
    requestId: string
    decision: ProviderApprovalDecision
  }> = []

  const adapter: ProviderAdapterShape = {
    provider: "codex",
    displayName: "Deferred approval provider",
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      supportsApprovals: true,
      supportsResume: true,
      managesOwnLifecycle: true,
    },
    isConfigured: () => true,
    availableModels: async () => [{ slug: "test-model", name: "Test model" }],
    startSession: async (input) => {
      const now = Date.now()
      const session: ProviderSession = {
        threadId: input.threadId,
        providerThreadId: null,
        status: "ready",
        cwd: input.cwd ?? null,
        activeTurnId: null,
        runtimeMode: input.runtimeMode ?? null,
        createdAt: now,
        updatedAt: now,
      }
      sessions.set(input.threadId, session)
      return session
    },
    listSessions: async () => [...sessions.values()],
    // Returns immediately: the turn is only *accepted* here.
    sendTurn: async () => {},
    interruptTurn: async () => {},
    respondToRequest: async (_threadId, requestId, decision) => {
      responses.push({ requestId: requestId as string, decision })
      for (const listener of listeners)
        listener({
          threadId: _threadId,
          eventId: `resolved-${requestId}`,
          at: Date.now(),
          type: "request.resolved",
          kind: "tool_approval",
          requestId,
          decision:
            decision.kind === "tool_approval" ? decision.decision : "deny",
        } as ProviderRuntimeEvent)
    },
    stopSession: async (threadId) => {
      sessions.delete(threadId)
    },
    hasSession: (threadId) => sessions.has(threadId),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stopAll: async () => {
      sessions.clear()
    },
  }

  return {
    adapter,
    emit: (event) => {
      for (const listener of listeners) listener(event)
    },
    responses,
  }
}

/** Narrow the approval union so tests can assert on decision/message. */
function toolApproval(decision: ProviderApprovalDecision): {
  decision: "approve" | "deny"
  message?: string
} {
  if (decision.kind !== "tool_approval") {
    throw new Error(`expected a tool_approval decision, got ${decision.kind}`)
  }
  return decision
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe("ProviderHub approvals that arrive after sendTurn resolves", () => {
  it("denies a mutating tool in plan mode instead of forwarding it to the user", async () => {
    const { adapter, emit, responses } = deferredApprovalAdapter()
    const hub = new ProviderHub({
      adapters: [adapter],
      projectProviderPolicyLoader: async () => null,
    })
    const events: ProviderRuntimeEvent[] = []
    const unsubscribe = hub.subscribe((event) => events.push(event))

    const turn = hub.startTurn("codex", {
      threadId: "thread-deferred",
      message: "plan the change",
      modelId: "test-model",
      history: [],
      projectPath: process.cwd(),
      appMode: "agent",
      chatMode: "plan",
    })
    await turn.completion
    await flush()

    // The provider asks for permission to write — after sendTurn already
    // resolved, which is the shape that used to escape the ceiling.
    emit({
      threadId: "thread-deferred",
      providerKind: "codex",
      providerInstanceId: "codex",
      eventId: "evt-approval-1",
      at: Date.now(),
      type: "request.opened",
      kind: "tool_approval",
      requestId: "req-1",
      tool: "Write",
      input: { file_path: "src/a.ts", content: "x" },
    } as ProviderRuntimeEvent)
    await flush()

    expect(responses).toHaveLength(1)
    expect(responses[0].requestId).toBe("req-1")
    expect(toolApproval(responses[0].decision).decision).toBe("deny")
    expect(toolApproval(responses[0].decision).message).toContain("Plan mode")

    unsubscribe()
    await hub.stopAll()
  })

  it("leaves read tools alone in plan mode", async () => {
    const { adapter, emit, responses } = deferredApprovalAdapter()
    const hub = new ProviderHub({
      adapters: [adapter],
      projectProviderPolicyLoader: async () => null,
    })

    const turn = hub.startTurn("codex", {
      threadId: "thread-deferred-read",
      message: "plan the change",
      modelId: "test-model",
      history: [],
      projectPath: process.cwd(),
      appMode: "agent",
      chatMode: "plan",
    })
    await turn.completion
    await flush()

    emit({
      threadId: "thread-deferred-read",
      providerKind: "codex",
      providerInstanceId: "codex",
      eventId: "evt-approval-2",
      at: Date.now(),
      type: "request.opened",
      kind: "tool_approval",
      requestId: "req-2",
      tool: "Read",
      input: { file_path: "src/a.ts" },
    } as ProviderRuntimeEvent)
    await flush()

    // Not auto-denied — a read in plan mode is legitimate and the request
    // stays open for the normal approval flow.
    expect(
      responses.filter((r) => toolApproval(r.decision).decision === "deny")
    ).toHaveLength(0)

    await hub.stopAll()
  })

  it("applies the same ceiling under a read-only permission level", async () => {
    const { adapter, emit, responses } = deferredApprovalAdapter()
    const hub = new ProviderHub({
      adapters: [adapter],
      projectProviderPolicyLoader: async () => null,
    })

    const turn = hub.startTurn("codex", {
      threadId: "thread-deferred-readonly",
      message: "look around",
      modelId: "test-model",
      history: [],
      projectPath: process.cwd(),
      appMode: "agent",
      permissionLevel: "read-only",
    })
    await turn.completion
    await flush()

    emit({
      threadId: "thread-deferred-readonly",
      providerKind: "codex",
      providerInstanceId: "codex",
      eventId: "evt-approval-3",
      at: Date.now(),
      type: "request.opened",
      kind: "tool_approval",
      requestId: "req-3",
      tool: "Bash",
      input: { command: "rm -rf dist" },
    } as ProviderRuntimeEvent)
    await flush()

    expect(responses).toHaveLength(1)
    expect(toolApproval(responses[0].decision).decision).toBe("deny")
    expect(toolApproval(responses[0].decision).message).toContain("Read-only")

    await hub.stopAll()
  })
})

describe("live permission changes with pending approvals", () => {
  function configurePolicy(
    decision: "allow" | "ask" | "deny" = "ask",
    source: "default" | "grant" | "workspace_trust" = "default"
  ) {
    const evaluateTool = vi.fn(() => ({
      decision,
      source,
      reason: "Configured policy",
      normalizedPath: null,
      grant: null,
    }))
    configureAgentPermissionRuntime({ evaluateTool, listGrants: () => [] })
    return evaluateTool
  }

  async function start(provider: ProviderKind = "codex", chatMode = "agent") {
    const fixture = deferredApprovalAdapter()
    const adapter = { ...fixture.adapter, provider }
    const hub = new ProviderHub({
      adapters: [adapter],
      projectProviderPolicyLoader: async () => null,
    })
    const events: ProviderRuntimeEvent[] = []
    hub.subscribe((event) => events.push(event))
    const thread = "live-switch" as ThreadId
    const turn = hub.startTurn(provider, {
      threadId: thread,
      message: "inspect",
      modelId: "test-model",
      history: [],
      projectPath: process.cwd(),
      appMode: "editor",
      chatMode,
      permissionLevel: "ask-on-edit",
    })
    await turn.completion
    const request = (
      requestId: string,
      kind: "tool_approval" | "user_input" = "tool_approval",
      target = thread
    ) =>
      fixture.emit({
        threadId: target,
        providerKind: provider,
        providerInstanceId: provider,
        eventId: `opened-${requestId}`,
        at: Date.now(),
        type: "request.opened",
        kind,
        requestId,
        tool: "shell",
        input: { command: "npm run check" },
      } as ProviderRuntimeEvent)
    const switchMode = (level: "bypass" | "ask-on-edit" | "read-only") =>
      hub.setPermissionMode(
        provider,
        thread,
        level === "bypass" ? "bypassPermissions" : "default",
        provider,
        undefined,
        level
      )
    return { ...fixture, adapter, hub, thread, events, request, switchMode }
  }

  it.each(["codex", "claude", "cursor", "grok_cli", "betterc0de"] as const)(
    "%s settles existing and subsequent tool requests when Ask first switches to Bypass",
    async (provider) => {
      configurePolicy()
      const f = await start(provider)
      try {
        f.request("pending")
        f.request("question", "user_input")
        f.request("foreign", "tool_approval", "other-thread" as ThreadId)
        expect(f.responses).toEqual([])
        expect(await f.switchMode("bypass")).toEqual({ applied: "live" })
        f.request("next")
        await flush()
        expect(f.responses.map((r) => r.requestId)).toEqual(["pending", "next"])
        expect(
          f.responses.every(
            (r) => toolApproval(r.decision).decision === "approve"
          )
        ).toBe(true)
        expect(
          f.events.filter((e) => e.requestId === "pending").map((e) => e.type)
        ).toEqual(["request.opened", "request.resolved"])
        expect(
          currentAgentPermissionRuntimeContext(f.thread)?.permissionLevel
        ).toBe("bypass")
      } finally {
        await f.hub.stopAll()
      }
    }
  )

  it("stops auto-approving after switching back to Ask, and enforces a live read-only ceiling", async () => {
    configurePolicy()
    const f = await start()
    try {
      await f.switchMode("bypass")
      expect(await f.switchMode("ask-on-edit")).toEqual({ applied: "queued" })
      f.request("ask-again")
      await flush()
      expect(f.responses).toEqual([])
      await f.switchMode("read-only")
      expect(f.responses.map((r) => toolApproval(r.decision).decision)).toEqual(
        ["deny"]
      )
      expect(
        currentAgentPermissionRuntimeContext(f.thread)?.permissionLevel
      ).toBe("read-only")
    } finally {
      await f.hub.stopAll()
    }
  })

  it.each(["plan", "ask", "security"])(
    "preserves the %s chat-mode ceiling",
    async (chatMode) => {
      configurePolicy()
      const f = await start("codex", chatMode)
      try {
        await f.switchMode("bypass")
        f.request("restricted")
        await flush()
        expect(
          f.responses.some(
            (r) => toolApproval(r.decision).decision === "approve"
          )
        ).toBe(false)
        expect(currentAgentPermissionRuntimeContext(f.thread)?.chatMode).toBe(
          chatMode
        )
      } finally {
        await f.hub.stopAll()
      }
    }
  )

  it.each([
    ["ask", "grant"],
    ["deny", "grant"],
    ["deny", "workspace_trust"],
  ] as const)("preserves %s from %s in Bypass", async (decision, source) => {
    configurePolicy(decision, source)
    const f = await start()
    try {
      f.request("restricted")
      await f.switchMode("bypass")
      await flush()
      expect(
        f.responses.some((r) => toolApproval(r.decision).decision === "approve")
      ).toBe(false)
      expect(f.responses).toHaveLength(decision === "ask" ? 0 : 1)
    } finally {
      await f.hub.stopAll()
    }
  })

  it("does not answer an already resolved request or send concurrent responses twice", async () => {
    configurePolicy()
    const f = await start()
    try {
      f.request("resolved")
      await f.hub.respondToRequest(
        "codex",
        f.thread,
        "resolved" as Parameters<ProviderHub["respondToRequest"]>[2],
        { kind: "tool_approval", decision: "deny" }
      )
      f.request("pending")
      await Promise.all([f.switchMode("bypass"), f.switchMode("bypass")])
      expect(f.responses.map((r) => r.requestId)).toEqual([
        "resolved",
        "pending",
      ])
    } finally {
      await f.hub.stopAll()
    }
  })

  it("retains the pending request on a provider response failure and allows retry", async () => {
    configurePolicy()
    const f = await start()
    const respond = f.adapter.respondToRequest
    const spy = vi
      .spyOn(f.adapter, "respondToRequest")
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockImplementation(respond)
    try {
      f.request("retry")
      await expect(f.switchMode("bypass")).rejects.toThrow("connection closed")
      expect(f.events.some((e) => e.type === "request.resolved")).toBe(false)
      await f.switchMode("bypass")
      expect(spy).toHaveBeenCalledTimes(2)
      expect(f.responses.map((r) => r.requestId)).toEqual(["retry"])
    } finally {
      await f.hub.stopAll()
    }
  })

  it("reports Bypass as live when hub approvals work but the native update is queued", async () => {
    configurePolicy()
    const f = await start("claude")
    f.adapter.setPermissionMode = vi.fn(async () => ({
      applied: "queued" as const,
    }))
    try {
      f.request("pending")
      expect(await f.switchMode("bypass")).toEqual({ applied: "live" })
      expect(f.responses.map((r) => r.requestId)).toEqual(["pending"])
    } finally {
      await f.hub.stopAll()
    }
  })

  it("does not send native Bypass while the active turn remains in Plan mode", async () => {
    configurePolicy()
    const f = await start("claude", "plan")
    f.adapter.setPermissionMode = vi.fn(async () => ({
      applied: "live" as const,
    }))
    try {
      expect(await f.switchMode("bypass")).toEqual({ applied: "queued" })
      expect(f.adapter.setPermissionMode).not.toHaveBeenCalled()
    } finally {
      await f.hub.stopAll()
    }
  })
})
