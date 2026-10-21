import { afterEach, describe, expect, it, vi } from "vitest"
import { CursorAcpAdapter } from "../cursor/CursorAcpAdapter"
import { GrokAcpAdapter } from "../grok-cli/GrokAcpAdapter"
import type {
  ApprovalRequestId,
  ProviderRuntimeEvent,
  ThreadId,
} from "../contracts"
import type {
  AcpEvent,
  AcpExit,
  AcpModeState,
  AcpPermissionRequest,
  AcpRuntime,
  AcpRuntimeOptions,
  AcpSessionSetupResult,
} from "./AcpRuntimeBase"

/**
 * Both ACP adapters are the same `AcpAdapterBase` under two profiles. This
 * test drives ONE scripted runtime through both and pins that the canonical
 * event stream is identical except for provider identity — and that the
 * deliberate divergences (Grok's read-only ceiling, Grok's missing user-input
 * request) stay exactly where the profiles put them. A regression that
 * re-forks the adapters, or one that quietly unifies a divergence, fails here.
 */

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select" as const,
    currentValue: "default",
    options: [
      { value: "default", name: "Auto" },
      { value: "fast-1", name: "Fast 1" },
    ],
  },
]

const modeState: AcpModeState = {
  currentModeId: "ask",
  availableModes: [
    { id: "ask", name: "Ask" },
    { id: "plan", name: "Plan" },
    { id: "code", name: "Code" },
  ],
}

const PERMISSION_OPTIONS = [
  { optionId: "allow-once", kind: "allow_once" },
  { optionId: "reject-once", kind: "reject_once" },
]

const IDENTITY_KEYS = new Set([
  "providerKind",
  "provider",
  "providerInstanceId",
  "eventId",
  "at",
  "turnId",
  "requestId",
  "createdAt",
])

/** Strips per-run and per-provider identity so two streams can be compared. */
function canonical(event: ProviderRuntimeEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (IDENTITY_KEYS.has(key)) continue
    out[key] = value
  }
  const payload = out.payload as Record<string, unknown> | undefined
  if (payload && typeof payload.reason === "string") {
    // "<label> ACP session ready" carries the vendor label on purpose.
    out.payload = {
      ...payload,
      reason: payload.reason.replace(/^(Cursor|Grok) /, "<label> "),
    }
  }
  return out
}

const PROFILES = [
  {
    name: "cursor",
    kind: "cursor",
    instanceId: "cursor",
    continuationKey: "cursor:cursor",
    codePrefix: "CURSOR_ACP",
    make: (factory: (input: AcpRuntimeOptions) => AcpRuntime) =>
      new CursorAcpAdapter({ binaryPath: "node", runtimeFactory: factory }),
  },
  {
    name: "grok",
    kind: "grok_cli",
    instanceId: "grok-cli",
    continuationKey: "grok-cli:grok-cli",
    codePrefix: "GROK_ACP",
    make: (factory: (input: AcpRuntimeOptions) => AcpRuntime) =>
      new GrokAcpAdapter({ binaryPath: "node", runtimeFactory: factory }),
  },
] as const

async function runScenario(profile: (typeof PROFILES)[number]) {
  const runtime = new FakeAcpRuntime()
  const adapter = profile.make(() => runtime)
  const events: ProviderRuntimeEvent[] = []
  adapter.subscribe((event) => events.push(event))
  // Same thread id on both adapters (they are separate instances) so the
  // canonical streams are comparable field by field.
  const threadId = "parity-thread" as ThreadId

  const session = await adapter.startSession({
    threadId,
    cwd: "/tmp/project",
    modelSelection: {
      instanceId: profile.instanceId,
      model: "fast-1",
      options: [],
    },
  })
  const startupEvents = events.splice(0)

  await adapter.sendTurn({
    threadId,
    message: "Change it",
    modelId: "fast-1",
    modelSelection: { instanceId: profile.instanceId, model: "fast-1" },
    history: [],
  })
  const turnEvents = events.splice(0)

  const permissionPromise = runtime.triggerPermission({
    kind: "edit",
    detail: "write src/index.ts",
    raw: { toolCall: { kind: "edit" }, options: PERMISSION_OPTIONS },
  })
  await flushAsync()
  const opened = events.find((event) => event.type === "request.opened")
  await adapter.respondToRequest(
    threadId,
    opened?.requestId as ApprovalRequestId,
    { kind: "tool_approval", decision: "approve" }
  )
  const permissionOutcome = await permissionPromise
  const permissionEvents = events.splice(0)

  return {
    adapter,
    runtime,
    session,
    startupEvents,
    turnEvents,
    permissionEvents,
    permissionOutcome,
  }
}

describe("ACP adapter parity (Cursor vs Grok)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(PROFILES)(
    "$name: applies a stricter per-turn approval policy to an existing full-access session",
    async (profile) => {
      const runtime = new FakeAcpRuntime()
      const adapter = profile.make(() => runtime)
      const threadId = "change-permission-mode" as ThreadId
      const events: ProviderRuntimeEvent[] = []
      adapter.subscribe((event) => {
        events.push(event)
        if (event.type === "request.opened") {
          void adapter.respondToRequest(
            threadId,
            event.requestId as ApprovalRequestId,
            { kind: "tool_approval", decision: "deny" }
          )
        }
      })
      await adapter.startSession({ threadId, runtimeMode: "full-access" })
      try {
        await adapter.sendTurn({
          threadId,
          message: "Inspect only",
          modelId: "default",
          history: [],
          permissionLevel: "ask",
        })
        await expect(
          runtime.triggerPermission({
            kind: "edit",
            raw: { options: PERMISSION_OPTIONS },
          })
        ).resolves.toMatchObject({ outcome: { optionId: "reject-once" } })
        expect(
          events.some(
            (event) =>
              event.type ===
              (profile.name === "cursor" ? "request.opened" : "tool.denied")
          )
        ).toBe(true)
        expect((await adapter.listSessions())[0]?.runtimeMode).toBe(
          "approval-required"
        )
      } finally {
        await adapter.stopAll()
      }
    }
  )

  it.each(PROFILES)(
    "$name: sends images as ACP blocks when advertised and announces the rest",
    async (profile) => {
      const attachments = [
        {
          type: "file",
          filename: "shot.png",
          mediaType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgo=",
        },
        {
          type: "file",
          filename: "spec.pdf",
          mediaType: "application/pdf",
          url: "data:application/pdf;base64,JVBERi0=",
        },
      ]
      for (const acceptsImages of [true, false]) {
        const runtime = new FakeAcpRuntime()
        const start = runtime.start.bind(runtime)
        vi.spyOn(runtime, "start").mockImplementation(async () => ({
          ...(await start()),
          initializeResult: Object.assign(
            { protocolVersion: 1 },
            {
              agentCapabilities: {
                promptCapabilities: { image: acceptsImages },
              },
            }
          ),
        }))
        const adapter = profile.make(() => runtime)
        const events: ProviderRuntimeEvent[] = []
        adapter.subscribe((event) => events.push(event))
        const threadId = `attachments-${acceptsImages}` as ThreadId
        await adapter.startSession({ threadId })
        try {
          await adapter.sendTurn({
            threadId,
            message: "Look",
            modelId: "default",
            history: [],
            attachments,
          })
          const [prompt] = runtime.prompts
          const text = String(prompt?.prompt[0]?.text)
          expect(text).toContain("spec.pdf")
          if (acceptsImages) {
            expect(prompt?.prompt.slice(1)).toEqual([
              { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
            ])
            expect(text).not.toContain("shot.png")
          } else {
            expect(prompt?.prompt).toHaveLength(1)
            expect(text).toContain("shot.png")
          }
          // Nothing disappears silently: the user is told what was not sent.
          expect(events.some((event) => event.type === "runtime.warning")).toBe(
            true
          )
        } finally {
          await adapter.stopAll()
        }
      }
    }
  )

  it.each(PROFILES)(
    '$name: never inherits full access for a turn without a level, nor grants it for "full-access"',
    async (profile) => {
      const runtime = new FakeAcpRuntime()
      const adapter = profile.make(() => runtime)
      const threadId = "no-inherited-bypass" as ThreadId
      const events: ProviderRuntimeEvent[] = []
      adapter.subscribe((event) => {
        events.push(event)
        if (event.type === "request.opened") {
          void adapter.respondToRequest(
            threadId,
            event.requestId as ApprovalRequestId,
            { kind: "tool_approval", decision: "deny" }
          )
        }
      })
      await adapter.startSession({ threadId, runtimeMode: "full-access" })
      try {
        for (const permissionLevel of [undefined, "full-access"]) {
          await adapter.sendTurn({
            threadId,
            message: "Edit it",
            modelId: "default",
            history: [],
            ...(permissionLevel ? { permissionLevel } : {}),
          })
          // Not auto-approved: the request reaches the user, who denies it.
          await expect(
            runtime.triggerPermission({
              kind: "edit",
              raw: { options: PERMISSION_OPTIONS },
            })
          ).resolves.toMatchObject({ outcome: { optionId: "reject-once" } })
        }
        expect(
          events.filter((event) => event.type === "request.opened")
        ).toHaveLength(2)
      } finally {
        await adapter.stopAll()
      }
    }
  )

  it("applies the Grok read-only ceiling for a direct first turn and later mode changes", async () => {
    const runtime = new FakeAcpRuntime()
    const adapter = PROFILES[1].make(() => runtime)
    const threadId = "direct-read-only" as ThreadId
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => {
      events.push(event)
      if (event.type === "request.opened") {
        void adapter.respondToRequest(
          threadId,
          event.requestId as ApprovalRequestId,
          { kind: "tool_approval", decision: "approve" }
        )
      }
    })
    try {
      for (const permissionLevel of ["bypass", "full"] as const) {
        await adapter.sendTurn({
          threadId,
          message: "Inspect only",
          modelId: "default",
          history: [],
          permissionLevel,
          chatMode: "ask",
        })
        await expect(
          runtime.triggerPermission({
            kind: "edit",
            raw: { options: PERMISSION_OPTIONS },
          })
        ).resolves.toMatchObject({ outcome: { optionId: "reject-once" } })
      }
      expect(
        events.filter((event) => event.type === "tool.denied")
      ).toHaveLength(2)
      expect(events.some((event) => event.type === "request.opened")).toBe(
        false
      )
    } finally {
      await adapter.stopAll()
    }
  })

  it.each(PROFILES)(
    "$name: accepts an approval reply synchronously triggered by the opened event",
    async (profile) => {
      const runtime = new FakeAcpRuntime()
      const adapter = profile.make(() => runtime)
      const threadId = "immediate-approval" as ThreadId
      let response: Promise<void> | undefined
      adapter.subscribe((event) => {
        if (event.type !== "request.opened") return
        response = adapter.respondToRequest(
          threadId,
          event.requestId as ApprovalRequestId,
          { kind: "tool_approval", decision: "approve" }
        )
        void response.catch(() => {})
      })
      await adapter.startSession({ threadId })
      try {
        const permission = runtime.triggerPermission({
          kind: "edit",
          raw: { options: PERMISSION_OPTIONS },
        })
        await expect(response).resolves.toBeUndefined()
        await expect(permission).resolves.toMatchObject({
          outcome: { outcome: "selected", optionId: "allow-once" },
        })
      } finally {
        await adapter.stopAll()
      }
    }
  )

  it.each(PROFILES)(
    "$name: stopping from the opened event settles the request without a late resolution event",
    async (profile) => {
      vi.useFakeTimers()
      const runtime = new FakeAcpRuntime()
      const adapter = profile.make(() => runtime)
      const threadId = "stop-on-approval" as ThreadId
      const events: ProviderRuntimeEvent[] = []
      let stop: Promise<void> | undefined
      let settled = false
      adapter.subscribe((event) => {
        events.push(event)
        if (event.type === "request.opened")
          stop = adapter.stopSession(threadId)
      })
      await adapter.startSession({ threadId })
      try {
        const permission = runtime
          .triggerPermission({
            kind: "edit",
            raw: { options: PERMISSION_OPTIONS },
          })
          .then((outcome) => {
            settled = true
            return outcome
          })
        await stop
        await Promise.resolve()
        expect(settled).toBe(true)
        await expect(permission).resolves.toEqual({
          outcome: { outcome: "cancelled" },
        })
        expect(events.some((event) => event.type === "request.resolved")).toBe(
          false
        )
      } finally {
        await adapter.stopAll()
        await vi.runOnlyPendingTimersAsync()
      }
    }
  )

  it("projects the same canonical stream from the same runtime script, modulo identity", async () => {
    const cursor = await runScenario(PROFILES[0])
    const grok = await runScenario(PROFILES[1])

    // Identity is the only thing allowed to differ on the session itself.
    expect(cursor.session).toMatchObject({
      providerInstanceId: "cursor",
      continuationKey: "cursor:cursor",
      providerThreadId: "acp-session-1",
      status: "ready",
    })
    expect(grok.session).toMatchObject({
      providerInstanceId: "grok-cli",
      continuationKey: "grok-cli:grok-cli",
      providerThreadId: "acp-session-1",
      status: "ready",
    })

    // Startup: session.started, session.state.changed, thread.started — same
    // order and payload shape.
    expect(cursor.startupEvents.map((event) => event.type)).toEqual([
      "session.started",
      "session.state.changed",
      "thread.started",
    ])
    expect(cursor.startupEvents.map(canonical)).toEqual(
      grok.startupEvents.map(canonical)
    )
    for (const event of cursor.startupEvents) {
      expect(event).toMatchObject({
        providerKind: "cursor",
        provider: "cursor",
        providerInstanceId: "cursor",
      })
    }
    for (const event of grok.startupEvents) {
      expect(event).toMatchObject({
        providerKind: "grok_cli",
        provider: "grok_cli",
        providerInstanceId: "grok-cli",
      })
    }

    // Turn: identical canonical sequence; both stamp raw.source acp.jsonrpc.
    expect(cursor.turnEvents.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.plan.updated",
      "item.started",
      "content.delta",
      "item.completed",
      "item.updated",
      "item.completed",
      "turn.completed",
    ])
    expect(cursor.turnEvents.map(canonical)).toEqual(
      grok.turnEvents.map(canonical)
    )
    const rawSources = (events: ProviderRuntimeEvent[]) =>
      events.flatMap((event) =>
        event.raw ? [(event.raw as { source?: string }).source] : []
      )
    expect(new Set(rawSources(cursor.turnEvents))).toEqual(
      new Set(["acp.jsonrpc"])
    )
    expect(new Set(rawSources(grok.turnEvents))).toEqual(
      new Set(["acp.jsonrpc"])
    )
    const fileChange = cursor.turnEvents
      .filter((event) => event.type === "item.completed")
      .find((event) => event.itemId === "tool-1")
    expect(fileChange?.payload).toMatchObject({
      itemType: "file_change",
      status: "completed",
      detail: "write src/index.ts",
    })

    // Permission request in the default (non-read-only) mode: both forward
    // it and both resolve it to the same ACP option.
    expect(cursor.permissionEvents.map((event) => event.type)).toEqual([
      "request.opened",
      "request.resolved",
    ])
    expect(cursor.permissionEvents.map(canonical)).toEqual(
      grok.permissionEvents.map(canonical)
    )
    expect(cursor.permissionOutcome).toEqual(grok.permissionOutcome)
    expect(cursor.permissionOutcome).toMatchObject({
      outcome: { outcome: "selected", optionId: "allow-once" },
    })
    // Both prompts were sent verbatim (no history to seed).
    expect(cursor.runtime.prompts).toEqual(grok.runtime.prompts)
    expect(cursor.runtime.prompts).toEqual([
      { prompt: [{ type: "text", text: "Change it" }] },
    ])

    await cursor.adapter.stopAll()
    await grok.adapter.stopAll()
  })

  // Documented divergence #6: Grok advertises no read-only session mode, so
  // its profile enforces read-only per permission request. Cursor selects
  // the `ask` mode instead and forwards the request as an approval.
  it("read-only: Cursor forwards the edit request, Grok denies it before any approval", async () => {
    const cursorRuntime = new FakeAcpRuntime()
    const cursor = PROFILES[0].make(() => cursorRuntime)
    const grokRuntime = new FakeAcpRuntime()
    const grok = PROFILES[1].make(() => grokRuntime)
    const cursorEvents: ProviderRuntimeEvent[] = []
    const grokEvents: ProviderRuntimeEvent[] = []
    cursor.subscribe((event) => cursorEvents.push(event))
    grok.subscribe((event) => grokEvents.push(event))

    await cursor.startSession({
      threadId: "cursor-ro" as ThreadId,
      runtimeMode: "read-only",
    })
    await grok.startSession({
      threadId: "grok-ro" as ThreadId,
      runtimeMode: "read-only",
    })
    // Mode selection is shared: when the agent advertises `ask`, both take it.
    expect(cursorRuntime.calls).toContainEqual(["setMode", "ask"])
    expect(grokRuntime.calls).toContainEqual(["setMode", "ask"])

    const request: AcpPermissionRequest = {
      kind: "edit",
      detail: "write src/index.ts",
      raw: { toolCall: { kind: "edit" }, options: PERMISSION_OPTIONS },
    }

    const cursorPending = cursorRuntime.triggerPermission(request)
    await flushAsync()
    const opened = cursorEvents.find((event) => event.type === "request.opened")
    expect(opened?.payload).toMatchObject({
      requestType: "file_change_approval",
    })
    expect(cursorEvents.some((event) => event.type === "tool.denied")).toBe(
      false
    )
    await cursor.respondToRequest(
      "cursor-ro" as ThreadId,
      opened?.requestId as ApprovalRequestId,
      { kind: "tool_approval", decision: "deny" }
    )
    await expect(cursorPending).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "reject-once" },
    })

    await expect(grokRuntime.triggerPermission(request)).resolves.toMatchObject(
      { outcome: { outcome: "selected", optionId: "reject-once" } }
    )
    expect(grokEvents.some((event) => event.type === "request.opened")).toBe(
      false
    )
    expect(
      grokEvents.find((event) => event.type === "tool.denied")?.payload
    ).toMatchObject({
      toolName: "file_change_approval",
      reason: expect.stringContaining("Read-only mode"),
    })

    // A read stays allowed for Grok — the ceiling is per kind, not blanket.
    const readPending = grokRuntime.triggerPermission({
      kind: "read",
      raw: { toolCall: { kind: "read" }, options: PERMISSION_OPTIONS },
    })
    await flushAsync()
    const readOpened = grokEvents.find(
      (event) =>
        event.type === "request.opened" &&
        (event.payload as { requestType?: string }).requestType ===
          "file_read_approval"
    )
    expect(readOpened).toBeDefined()
    await grok.respondToRequest(
      "grok-ro" as ThreadId,
      readOpened?.requestId as ApprovalRequestId,
      { kind: "tool_approval", decision: "approve" }
    )
    await expect(readPending).resolves.toMatchObject({
      outcome: { outcome: "selected", optionId: "allow-once" },
    })

    await cursor.stopAll()
    await grok.stopAll()
  })

  // Documented divergence #11: with no plan/ask/security mode advertised,
  // Cursor fails closed (it normally has them, so this is a broken build)
  // while Grok keeps its native mode — its read-only guarantee comes from the
  // permission ceiling, not from a mode label.
  it("missing safe mode: Cursor rejects the session, Grok starts on its native mode", async () => {
    const implementationOnly: AcpModeState = {
      currentModeId: "code",
      availableModes: [{ id: "code", name: "Code" }],
    }
    const cursorRuntime = new FakeAcpRuntime()
    vi.spyOn(cursorRuntime, "getModeState").mockReturnValue(implementationOnly)
    const grokRuntime = new FakeAcpRuntime()
    vi.spyOn(grokRuntime, "getModeState").mockReturnValue(implementationOnly)
    const cursor = PROFILES[0].make(() => cursorRuntime)
    const grok = PROFILES[1].make(() => grokRuntime)

    await expect(
      cursor.startSession({
        threadId: "cursor-nomode" as ThreadId,
        runtimeMode: "read-only",
      })
    ).rejects.toThrow(/Cursor Agent does not support/)
    expect(cursorRuntime.calls).toContainEqual(["close"])

    await expect(
      grok.startSession({
        threadId: "grok-nomode" as ThreadId,
        runtimeMode: "read-only",
      })
    ).resolves.toMatchObject({ status: "ready" })
    // Never silently switched into the implementation mode either.
    expect(grokRuntime.calls).not.toContainEqual(["setMode", "code"])

    await cursor.stopAll()
    await grok.stopAll()
  })

  // Documented divergence #10: a rejected `setModel` is fatal for Cursor and
  // ignored for Grok (whose session may advertise no model picker).
  it("rejected setModel: Cursor fails the session, Grok keeps the CLI default", async () => {
    const cursorRuntime = new FakeAcpRuntime()
    vi.spyOn(cursorRuntime, "setModel").mockRejectedValue(
      new Error("no model picker")
    )
    const grokRuntime = new FakeAcpRuntime()
    vi.spyOn(grokRuntime, "setModel").mockRejectedValue(
      new Error("no model picker")
    )
    const cursor = PROFILES[0].make(() => cursorRuntime)
    const grok = PROFILES[1].make(() => grokRuntime)

    await expect(
      cursor.startSession({
        threadId: "cursor-model" as ThreadId,
        modelSelection: { instanceId: "cursor", model: "fast-1" },
      })
    ).rejects.toThrow("no model picker")
    await expect(
      grok.startSession({
        threadId: "grok-model" as ThreadId,
        modelSelection: { instanceId: "grok-cli", model: "fast-1" },
      })
    ).resolves.toMatchObject({ status: "ready" })

    await cursor.stopAll()
    await grok.stopAll()
  })

  // Documented divergence #7/#8: only Cursor has a user-input request
  // (`cursor/ask_question`). Grok answers with a typed 409 rather than a
  // stale-request error, because there is never a pending one.
  it("user_input replies: Cursor resolves the pending question, Grok rejects the kind as unsupported", async () => {
    const cursorRuntime = new FakeAcpRuntime()
    const cursor = PROFILES[0].make(() => cursorRuntime)
    const grokRuntime = new FakeAcpRuntime()
    const grok = PROFILES[1].make(() => grokRuntime)
    const cursorEvents: ProviderRuntimeEvent[] = []
    cursor.subscribe((event) => cursorEvents.push(event))

    await cursor.startSession({ threadId: "cursor-ui" as ThreadId })
    await grok.startSession({ threadId: "grok-ui" as ThreadId })

    expect(cursorRuntime.extRequestHandlers.has("cursor/ask_question")).toBe(
      true
    )
    expect(grokRuntime.extRequestHandlers.size).toBe(0)

    const question = cursorRuntime.triggerExtRequest("cursor/ask_question", {
      questions: [{ id: "scope", prompt: "Which scope?" }],
    })
    await flushAsync()
    const requested = cursorEvents.find(
      (event) => event.type === "user-input.requested"
    )
    expect(requested?.raw).toMatchObject({
      source: "acp.cursor.extension",
      method: "cursor/ask_question",
    })
    await cursor.respondToRequest(
      "cursor-ui" as ThreadId,
      requested?.requestId as ApprovalRequestId,
      { kind: "user_input", answers: { scope: "workspace" } }
    )
    await expect(question).resolves.toEqual({
      answers: { scope: "workspace" },
    })
    expect(
      cursorEvents.find((event) => event.type === "user-input.resolved")
        ?.payload
    ).toEqual({ answers: { scope: "workspace" } })

    await expect(
      grok.respondToRequest(
        "grok-ui" as ThreadId,
        "never-opened" as ApprovalRequestId,
        { kind: "user_input", answers: { scope: "workspace" } }
      )
    ).rejects.toMatchObject({
      code: "GROK_ACP_REQUEST_KIND_UNSUPPORTED",
      statusCode: 409,
    })

    await cursor.stopAll()
    await grok.stopAll()
  })

  it.each(PROFILES)(
    "$name: stopAll after a failed close quarantines the runtime and blocks the next startSession with $codePrefix_CLEANUP_QUARANTINED",
    async (profile) => {
      const runtime = new FakeAcpRuntime()
      const close = vi
        .spyOn(runtime, "close")
        .mockRejectedValue(new Error("close failed"))
      const factory = vi.fn(() => runtime)
      const adapter = profile.make(factory)

      await adapter.startSession({
        threadId: `${profile.name}-q` as ThreadId,
      })
      await expect(adapter.stopAll()).rejects.toMatchObject({
        name: "AggregateError",
      })
      await expect(
        adapter.startSession({ threadId: `${profile.name}-q2` as ThreadId })
      ).rejects.toMatchObject({
        code: `${profile.codePrefix}_CLEANUP_QUARANTINED`,
        statusCode: 503,
      })
      expect(factory).toHaveBeenCalledTimes(1)

      // Only a confirmed close releases the quarantine.
      close.mockResolvedValue(undefined)
      await expect(adapter.stopAll()).resolves.toBeUndefined()
      await expect(
        adapter.startSession({ threadId: `${profile.name}-q3` as ThreadId })
      ).resolves.toMatchObject({ status: "ready" })
      await adapter.stopAll()
    }
  )
})

class FakeAcpRuntime implements AcpRuntime {
  readonly calls: Array<ReadonlyArray<unknown>> = []
  readonly prompts: Array<{ prompt: ReadonlyArray<Record<string, unknown>> }> =
    []
  readonly extRequestHandlers = new Map<
    string,
    (params: unknown) => Promise<unknown>
  >()
  private readonly eventListeners = new Set<(event: AcpEvent) => void>()
  private readonly exitListeners = new Set<(event: AcpExit) => void>()
  private permissionHandler:
    | ((request: AcpPermissionRequest) => Promise<unknown>)
    | null = null

  async start() {
    this.calls.push(["start"])
    return {
      sessionId: "acp-session-1",
      resumed: false,
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "acp-session-1",
        modes: modeState,
        configOptions,
      } satisfies AcpSessionSetupResult,
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
      text: "Editing now",
      raw: { update: { sessionUpdate: "agent_message_chunk" } },
    })
    this.emit({ type: "assistant.completed", itemId: "assistant-1" })
    for (const status of ["inProgress", "completed"] as const) {
      this.emit({
        type: "tool.updated",
        raw: { update: { sessionUpdate: "tool_call_update" } },
        toolCall: {
          toolCallId: "tool-1",
          kind: "edit",
          title: "Edit",
          status,
          detail: "write src/index.ts",
          data: { path: "src/index.ts" },
        },
      })
    }
    return { stopReason: "end_turn" }
  }

  async cancel() {}

  async close() {
    this.calls.push(["close"])
  }

  onEvent(listener: (event: AcpEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onExit(listener: (event: AcpExit) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  onPermissionRequest(
    handler: (request: AcpPermissionRequest) => Promise<unknown>
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

  async triggerPermission(request: AcpPermissionRequest): Promise<unknown> {
    if (!this.permissionHandler) throw new Error("no permission handler")
    return await this.permissionHandler(request)
  }

  async triggerExtRequest(method: string, params: unknown): Promise<unknown> {
    const handler = this.extRequestHandlers.get(method)
    if (!handler) throw new Error(`no handler for ${method}`)
    return await handler(params)
  }

  private emit(event: AcpEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
