import { randomUUID } from "node:crypto"
import {
  CODE_SEARCH_SERVER,
  type CodeSearchServer,
} from "../../../services/code-search/contracts"
import { EventEmitter } from "node:events"
import {
  CodexRpcClient,
  CodexServerResponseRefusedError,
  type SpawnOptions,
} from "./rpc"
import {
  classifyCodexStderrLine,
  isRecoverableResumeMessage,
  type CodexStderrLine,
} from "./stderr"
import {
  codexThreadStartedSchema,
  isCodexHandledServerRequestMethod,
} from "./protocol"
import type {
  ProviderApprovalDecision,
  ProviderSteerTurnResult,
} from "../contracts"
import { classifyCodexSteerError } from "./steer"
import { logger } from "../../../observability/logger"
import { redactSensitiveText } from "../../../observability/redact"
import {
  codexVersionAdvisory,
  parseCodexInitializeVersion,
} from "./codexVersion"
import {
  pendingRequestKindFromDecisionKind,
  StalePendingProviderRequestError,
} from "../pendingRequestErrors"

export interface CodexSessionStartOptions {
  readonly codeSearchServer?: CodeSearchServer | null
  readonly orchestratorServer?:
    | import("../../../services/orchestrator/mcp").OrchestratorServer
    | null
  readonly cwd?: string | null
  readonly env?: NodeJS.ProcessEnv
  readonly storedProviderThreadId?: string | null
  readonly model?: string
  readonly approvalPolicy?: string
  readonly sandbox?: unknown
  readonly serviceTier?: "fast" | "flex"
  readonly clientInfo: { name: string; title: string; version: string }
}

export interface CodexTurnStartParams {
  readonly model?: string
  readonly message: string
  readonly images?: ReadonlyArray<{
    readonly url: string
    readonly detail?: "auto" | "low" | "high" | "original"
  }>
  readonly approvalPolicy?: string
  readonly sandboxPolicy?: unknown
  readonly effort?: string
  readonly personality?: string
  /** Codex `serviceTier` enum from the official schema: `"fast" | "flex"`.
   *  Forwarded as-is into `turn/start` payload. Set by `CodexAdapter` when
   *  the renderer toggles Fast Mode and the model exposes `additionalSpeedTiers`. */
  readonly serviceTier?: "fast" | "flex"
  readonly collaborationMode?: unknown
}

/** Input for the running turn (`turn/steer`); same shape as a turn's input. */
export interface CodexTurnSteerParams {
  readonly message: string
  readonly images?: CodexTurnStartParams["images"]
}

/** `turn/steer` only checks the turn and queues the input; it answers fast. */
const CODEX_STEER_TIMEOUT_MS = 15_000

export interface CodexNativeEvent {
  readonly kind:
    | "notification"
    | "server-request"
    | "stderr"
    | "child-exit"
    | "spawn-error"
    /** The process started but its pipe failed mid-run (EPIPE, kill error). */
    | "child-error"
  readonly method?: string
  readonly params?: unknown
  readonly requestId?: string
  readonly stderr?: CodexStderrLine
  readonly exit?: { code: number | null; signal: NodeJS.Signals | null }
  readonly error?: string
}

/**
 * Non-fatal stderr warnings become at most one transcript warning per window;
 * every line still reaches the backend log. Codex logs WARN lines routinely,
 * and one journaled warning per line only buried the transcript.
 */
const STDERR_WARNING_WINDOW_MS = 60_000

interface PendingServerRequest {
  readonly jsonRpcMethod: string
  readonly params: unknown
  readonly respond: (result: unknown) => void
  readonly respondError: (code: number, message: string) => void
  readonly requestId: string
}

export class CodexSessionRuntime extends EventEmitter {
  private readonly rpc: CodexRpcClient
  private providerThreadId: string | null = null
  private activeTurnId: string | null = null
  private initialized = false
  /** Set once the child process exists; errors before that are spawn failures. */
  private spawned = false
  /**
   * Set by close(): the child is being torn down on purpose, so a pipe error
   * from a write caught mid-teardown is not a lost connection. Without it a
   * mid-write crash surfaced twice — "connection lost" and the exit itself.
   */
  private closing = false
  private resumedExistingThread = false
  private successfulTurnCount = 0
  /** True while `turn/start` is awaiting its response. */
  private turnStartInFlight = false
  /** The pending `turn/start`, so a steer sent right after it can wait for its turn id. */
  private turnStart: Promise<unknown> | null = null
  /** Stop pressed before the turn id was known; sent once it arrives. */
  private interruptQueued = false
  private lastCompletedTurnId: string | null = null
  private lastStderrWarningAt = 0
  private agentVersion: string | null = null
  private readonly pendingServerRequests = new Map<
    string,
    PendingServerRequest
  >()

  constructor(private readonly spawnOptions: SpawnOptions) {
    super()
    this.rpc = new CodexRpcClient(spawnOptions)
  }

  getProviderThreadId(): string | null {
    return this.providerThreadId
  }
  getActiveTurnId(): string | null {
    return this.activeTurnId
  }
  requiresHistorySeed(): boolean {
    return !this.resumedExistingThread && this.successfulTurnCount === 0
  }
  isAlive(): boolean {
    return this.rpc.isAlive()
  }
  /** Codex CLI version reported by `initialize`, when readable. */
  getAgentVersion(): string | null {
    return this.agentVersion
  }

  async start(options: CodexSessionStartOptions): Promise<void> {
    this.wireRpcListeners()
    await this.rpc.spawnChild()
    this.spawned = true
    const initialize = await this.rpc.call("initialize", {
      clientInfo: options.clientInfo,
      capabilities: { experimentalApi: true },
    })
    this.agentVersion = parseCodexInitializeVersion(initialize)
    const advisory = codexVersionAdvisory(this.agentVersion)
    if (advisory) {
      logger.warn({ version: this.agentVersion }, advisory)
    }
    this.rpc.notify("initialized", {})
    this.initialized = true

    if (options.storedProviderThreadId) {
      try {
        await this.rpc.call("thread/resume", {
          threadId: options.storedProviderThreadId,
          ...threadOpenParams(options),
        })
        this.providerThreadId = options.storedProviderThreadId
        this.resumedExistingThread = true
      } catch (e) {
        const message = (e as Error).message
        if (isRecoverableResumeMessage(message)) {
          this.providerThreadId = await this.startFreshThread(options)
          this.resumedExistingThread = false
        } else {
          throw e
        }
      }
    } else {
      this.providerThreadId = await this.startFreshThread(options)
      this.resumedExistingThread = false
    }
  }

  private async startFreshThread(
    options: CodexSessionStartOptions
  ): Promise<string> {
    const res = await this.rpc.call<unknown>(
      "thread/start",
      threadOpenParams(options)
    )
    const parsed = codexThreadStartedSchema.safeParse(res)
    if (!parsed.success)
      throw new Error("thread/start did not return thread id")
    return parsed.data.thread.id
  }

  async sendTurn(params: CodexTurnStartParams): Promise<void> {
    if (!this.initialized || !this.providerThreadId) {
      throw new Error("codex session not initialized")
    }
    const payload: Record<string, unknown> = {
      threadId: this.providerThreadId,
      input: codexUserInput(params.message, params.images),
    }
    if (params.model) payload.model = params.model
    if (params.approvalPolicy) payload.approvalPolicy = params.approvalPolicy
    if (params.sandboxPolicy !== undefined)
      payload.sandboxPolicy = params.sandboxPolicy
    if (params.effort) payload.effort = params.effort
    if (params.personality) payload.personality = params.personality
    if (params.serviceTier !== undefined)
      payload.serviceTier = params.serviceTier
    if (params.collaborationMode !== undefined)
      payload.collaborationMode = params.collaborationMode
    this.interruptQueued = false
    this.turnStartInFlight = true
    const started = this.rpc.call("turn/start", payload)
    this.turnStart = started
    let response: unknown
    try {
      response = await started
    } finally {
      this.turnStartInFlight = false
      if (this.turnStart === started) this.turnStart = null
    }
    // The response already names the turn; `turn/started` may arrive later.
    // Without this a Stop pressed in that window silently did nothing.
    const turnId = readStartedTurnId(response)
    if (turnId && !this.activeTurnId && turnId !== this.lastCompletedTurnId) {
      this.activeTurnId = turnId
    }
    this.successfulTurnCount += 1
    this.flushQueuedInterrupt()
  }

  async interruptTurn(): Promise<void> {
    if (!this.providerThreadId) return
    if (!this.activeTurnId) {
      // `turn/start` is still in flight: interrupt as soon as its id is known.
      if (this.turnStartInFlight) this.interruptQueued = true
      return
    }
    this.interruptQueued = false
    await this.rpc.call("turn/interrupt", {
      threadId: this.providerThreadId,
      turnId: this.activeTurnId,
    })
  }

  /**
   * Adds the user's input to the running turn (`turn/steer`). The request
   * names the turn it is meant for, so input never lands in a later turn.
   * Refusals (no turn, a turn that takes no input, an app-server without
   * the method) come back as a status; other errors are thrown.
   */
  async steerTurn(
    params: CodexTurnSteerParams
  ): Promise<ProviderSteerTurnResult> {
    // Sent right after the message that starts the turn: once `turn/start`
    // answers, its turn id is known (sendTurn sets it before this resumes).
    if (!this.activeTurnId && this.turnStart) {
      await this.turnStart.then(
        () => undefined,
        () => undefined
      )
    }
    const expectedTurnId = this.activeTurnId
    if (!this.initialized || !this.providerThreadId || !expectedTurnId) {
      return { status: "not_running", reason: "No Codex turn is running." }
    }
    try {
      const response = await this.rpc.call(
        "turn/steer",
        {
          threadId: this.providerThreadId,
          input: codexUserInput(params.message, params.images),
          expectedTurnId,
        },
        CODEX_STEER_TIMEOUT_MS
      )
      return {
        status: "steered",
        turnId: readSteeredTurnId(response) ?? expectedTurnId,
      }
    } catch (error) {
      const refusal = classifyCodexSteerError(
        error instanceof Error ? error.message : String(error)
      )
      if (refusal) return refusal
      throw error
    }
  }

  private flushQueuedInterrupt(): void {
    if (!this.interruptQueued || !this.activeTurnId) return
    this.interruptQueued = false
    void this.interruptTurn().catch((error: unknown) => {
      logger.warn({ err: error }, "codex queued interrupt failed")
    })
  }

  async rollbackThread(numTurns: number): Promise<void> {
    if (!this.initialized || !this.providerThreadId) {
      throw new Error("codex session not initialized")
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1")
    }
    await this.rpc.call("thread/rollback", {
      threadId: this.providerThreadId,
      numTurns,
    })
    this.activeTurnId = null
    this.successfulTurnCount = Math.max(0, this.successfulTurnCount - numTurns)
  }

  respondToRequest(
    requestId: string,
    decision: ProviderApprovalDecision
  ): void {
    const entry = this.pendingServerRequests.get(requestId)
    if (!entry) {
      throw new StalePendingProviderRequestError(
        pendingRequestKindFromDecisionKind(decision.kind),
        requestId
      )
    }

    if (entry.jsonRpcMethod === "mcpServer/elicitation/request") {
      if (
        decision.kind !== "user_input" &&
        decision.kind !== "user_input_reject"
      ) {
        throw new Error("MCP elicitation requests require user input answers")
      }
      this.pendingServerRequests.delete(requestId)
      if (decision.kind === "user_input_reject") {
        entry.respond({
          action: "decline",
        })
        this.emit("event", {
          kind: "notification",
          method: "item/tool/requestUserInput/answered",
          requestId,
          params: {
            requestId,
            answers: {},
            rejected: true,
          },
        } satisfies CodexNativeEvent)
        return
      }
      entry.respond({
        action: "accept",
        content: decision.answers,
      })
      this.emit("event", {
        kind: "notification",
        method: "item/tool/requestUserInput/answered",
        requestId,
        params: {
          requestId,
          answers: decision.answers,
        },
      } satisfies CodexNativeEvent)
      return
    }

    if (entry.jsonRpcMethod === "item/permissions/requestApproval") {
      if (decision.kind !== "tool_approval") {
        throw new Error(
          "Permission approval requests require an approval decision"
        )
      }
      this.pendingServerRequests.delete(requestId)
      if (decision.decision === "approve") {
        // "Always allow" is the only signal that the user wants this decision
        // to outlive the single call they were shown.
        const persistForTurn = (decision.updatedPermissions?.length ?? 0) > 0
        entry.respond(
          buildPermissionApprovalResponse(entry.params, persistForTurn)
        )
      } else {
        entry.respondError(-32000, "permission request denied")
      }
      this.emit("event", {
        kind: "notification",
        method: "item/requestApproval/decision",
        requestId,
        params: {
          requestId,
          method: entry.jsonRpcMethod,
          decision: decision.decision,
        },
      } satisfies CodexNativeEvent)
      return
    }

    const requiresUserInput =
      entry.jsonRpcMethod === "tool/requestUserInput" ||
      entry.jsonRpcMethod === "item/tool/requestUserInput"
    if (
      requiresUserInput
        ? decision.kind !== "user_input" &&
          decision.kind !== "user_input_reject"
        : decision.kind !== "tool_approval"
    ) {
      throw new StalePendingProviderRequestError(
        pendingRequestKindFromDecisionKind(decision.kind),
        requestId
      )
    }
    this.pendingServerRequests.delete(requestId)
    if (decision.kind === "tool_approval") {
      entry.respond({
        decision: decision.decision === "approve" ? "accept" : "decline",
      })
      this.emit("event", {
        kind: "notification",
        method: "item/requestApproval/decision",
        requestId,
        params: {
          requestId,
          method: entry.jsonRpcMethod,
          decision: decision.decision,
        },
      } satisfies CodexNativeEvent)
    } else {
      if (decision.kind === "user_input_reject") {
        entry.respond({ answers: {} })
        this.emit("event", {
          kind: "notification",
          method: "item/tool/requestUserInput/answered",
          requestId,
          params: {
            requestId,
            answers: {},
            rejected: true,
          },
        } satisfies CodexNativeEvent)
        return
      }
      if (decision.kind !== "user_input") {
        // plan_approval is Claude-runtime-only; Codex never opens one.
        throw new StalePendingProviderRequestError(
          pendingRequestKindFromDecisionKind(decision.kind),
          requestId
        )
      }
      const answers = toCodexUserInputAnswers(decision.answers)
      entry.respond({ answers })
      this.emit("event", {
        kind: "notification",
        method: "item/tool/requestUserInput/answered",
        requestId,
        params: {
          requestId,
          answers,
        },
      } satisfies CodexNativeEvent)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    this.activeTurnId = null
    this.interruptQueued = false
    this.pendingServerRequests.clear()
    await this.rpc.close()
  }

  private wireRpcListeners(): void {
    this.rpc.setServerRequestHandler(
      (method, params, respond, respondError) => {
        if (!isCodexHandledServerRequestMethod(method)) {
          respondError(-32601, `unsupported method: ${method}`)
          return
        }
        const requestId = extractRequestId(params) || randomUUID()
        this.pendingServerRequests.set(requestId, {
          jsonRpcMethod: method,
          params,
          respond,
          respondError,
          requestId,
        })
        const native: CodexNativeEvent = {
          kind: "server-request",
          method,
          params,
          requestId,
        }
        this.emit("event", native)
      }
    )

    this.rpc.onNotification("*", (m, params) => {
      if (process.env.BETTERC0DE_TRACE_PROVIDER_EVENTS === "1") {
        // [REASON-TRACE:CODEX-RPC-IN]
        const _p = (params ?? {}) as Record<string, unknown>
        const _itemType =
          (_p.item as { type?: string } | undefined)?.type ?? "-"
        console.log(
          `[REASON-TRACE:CODEX-RPC-IN] method=${m} keys=${Object.keys(_p).join(",")} itemType=${_itemType}`
        )
      }
      if (m === "turn/started") {
        const turn = (params as { turn?: { id?: string } } | null)?.turn
        if (turn?.id) this.activeTurnId = turn.id
      }
      if (m === "turn/completed" || m === "turn/aborted") {
        this.lastCompletedTurnId =
          readStartedTurnId(params) ?? this.activeTurnId
        this.activeTurnId = null
        this.interruptQueued = false
      }
      const native: CodexNativeEvent = {
        kind: "notification",
        method: m,
        params,
      }
      this.emit("event", native)
      if (m === "turn/started") this.flushQueuedInterrupt()
    })

    this.rpc.onStderr((line) => {
      const classified = classifyCodexStderrLine(line)
      if (!classified || classified.benign) return
      // The text itself goes to the log only (redacted, bounded); events stay
      // generic so no path or credential reaches the transcript.
      if (
        classified.fatal ||
        classified.level === "error" ||
        classified.level === "warn"
      ) {
        logger.warn(
          {
            level: classified.level,
            line: redactSensitiveText(classified.message).slice(0, 1_000),
          },
          "codex app-server stderr"
        )
      } else {
        logger.debug(
          {
            level: classified.level,
            line: redactSensitiveText(classified.message).slice(0, 1_000),
          },
          "codex app-server stderr"
        )
      }
      if (!classified.fatal) {
        if (classified.level !== "error" && classified.level !== "warn") return
        const now = Date.now()
        if (now - this.lastStderrWarningAt < STDERR_WARNING_WINDOW_MS) return
        this.lastStderrWarningAt = now
      }
      const native: CodexNativeEvent = { kind: "stderr", stderr: classified }
      this.emit("event", native)
    })

    this.rpc.on(
      "exit",
      (info: { code: number | null; signal: NodeJS.Signals | null }) => {
        this.activeTurnId = null
        this.interruptQueued = false
        this.pendingServerRequests.clear()
        if (!this.closing && info.code !== 0) {
          // The cause of an unexpected exit is in stderr, not in the exit code.
          logger.warn(
            {
              code: info.code,
              signal: info.signal,
              stderr: this.rpc.stderrText(1_200),
            },
            "codex app-server exited unexpectedly"
          )
        }
        const native: CodexNativeEvent = { kind: "child-exit", exit: info }
        this.emit("event", native)
      }
    )

    this.rpc.on("child-error", (err: Error) => {
      // A pipe error while we are closing the child ourselves is expected;
      // the exit event that follows is the one terminal the caller needs.
      if (this.closing) return
      // The message stays generic (the raw error can carry paths); the kind
      // says which situation the user is in. Every rpc `child-error` used to
      // read "could not be started", including an EPIPE halfway through a
      // turn on a process that had been running for an hour.
      const native: CodexNativeEvent = !this.spawned
        ? {
            kind: "spawn-error",
            error: "Codex provider process could not be started.",
          }
        : err instanceof CodexServerResponseRefusedError
          ? {
              kind: "child-error",
              error: `Codex did not receive the reply to its ${describeCodexServerRequest(
                err.method
              )} because its input backlog is full; the turn was stopped.`,
            }
          : {
              kind: "child-error",
              error: "Codex provider connection lost.",
            }
      this.emit("event", native)
    })
  }
}

/** The `input` of `turn/start` and `turn/steer`: the text, then the images. */
function codexUserInput(
  message: string,
  images: CodexTurnStartParams["images"]
): unknown[] {
  return [
    { type: "text", text: message },
    ...(images ?? []).map((image) => ({
      type: "image",
      url: image.url,
      ...(image.detail ? { detail: image.detail } : {}),
    })),
  ]
}

/** `turn/steer` answers with the turn that took the input. */
function readSteeredTurnId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const id = (value as { turnId?: unknown }).turnId
  return typeof id === "string" && id.trim() ? id : null
}

function readStartedTurnId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const turn = (value as { turn?: unknown }).turn
  if (!turn || typeof turn !== "object") return null
  const id = (turn as { id?: unknown }).id
  return typeof id === "string" && id.trim() ? id : null
}

function describeCodexServerRequest(method: string): string {
  if (method.endsWith("/requestApproval")) return "approval request"
  if (method.endsWith("/requestUserInput")) return "question"
  if (method.endsWith("/requestPermissions")) return "permission request"
  return "request"
}

function threadOpenParams(
  options: CodexSessionStartOptions
): Record<string, unknown> {
  return {
    // Per-thread override; never write transient capability headers to user config.
    ...(options.codeSearchServer !== undefined ||
    options.orchestratorServer !== undefined
      ? {
          config: {
            ...(options.orchestratorServer !== undefined
              ? {
                  "mcp_servers.betterc0de_orchestrator":
                    options.orchestratorServer
                      ? {
                          url: options.orchestratorServer.url,
                          http_headers: options.orchestratorServer.headers,
                          enabled: true,
                        }
                      : { url: "http://127.0.0.1:9/mcp", enabled: false },
                }
              : {}),
            ...(options.codeSearchServer !== undefined
              ? {
                  [`mcp_servers.${CODE_SEARCH_SERVER}`]:
                    options.codeSearchServer
                      ? {
                          url: options.codeSearchServer.url,
                          http_headers: options.codeSearchServer.headers,
                          enabled: true,
                        }
                      : // Codex validates transport fields even for disabled entries.
                        { url: "http://127.0.0.1:9/mcp", enabled: false },
                }
              : {}),
          },
        }
      : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.approvalPolicy
      ? { approvalPolicy: options.approvalPolicy }
      : {}),
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
    ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
  }
}

function toCodexUserInputAnswers(
  answers: Record<string, unknown>
): Record<string, { answers: string[] }> {
  const out: Record<string, { answers: string[] }> = Object.create(null)
  for (const [questionId, value] of Object.entries(answers)) {
    if (typeof value === "string") {
      out[questionId] = { answers: [value] }
      continue
    }
    if (Array.isArray(value)) {
      out[questionId] = {
        answers: value.filter(
          (entry): entry is string => typeof entry === "string"
        ),
      }
      continue
    }
    if (value && typeof value === "object") {
      const nested = (value as { answers?: unknown }).answers
      if (Array.isArray(nested)) {
        out[questionId] = {
          answers: nested.filter(
            (entry): entry is string => typeof entry === "string"
          ),
        }
        continue
      }
    }
    out[questionId] = { answers: [] }
  }
  return out
}

/**
 * Build the reply to `item/permissions/requestApproval`.
 *
 * Codex's response shape is `{ permissions, scope, strictAutoReview? }`, and
 * `scope: "turn"` means "hold these permissions for the rest of the turn".
 * This used to echo the requested permission set back unconditionally at turn
 * scope, so a plain one-off Approve on a single command silently authorized
 * every later call in that turn that fell under the same permission class —
 * the approval card showed one command, the grant covered the rest of the
 * turn, and BetterC0de's own gate never saw those calls because Codex stopped
 * asking.
 *
 * The narrowing runs through `permissions` and `strictAutoReview`, not `scope`.
 * Per the app-server schema, `scope` is `"turn" | "session"` — there is no
 * per-call value, so `"turn"` is already the narrowest scope available and
 * swapping it for anything else would fail deserialization.
 *
 * What actually narrows the grant:
 *   * `permissions: {}` — `GrantedPermissionProfile` has only optional keys, so
 *     an empty profile is valid and grants nothing beyond the current call.
 *   * `strictAutoReview: true` — schema doc: "Review every subsequent command
 *     in this turn before normal sandboxed execution." This is the explicit
 *     switch for "do not let the rest of the turn ride on this approval".
 *
 * `persistForTurn` is set only when the user explicitly chose to remember the
 * decision ("Always allow"), which is the one case where a turn-wide grant is
 * what they actually asked for.
 */
function buildPermissionApprovalResponse(
  params: unknown,
  persistForTurn: boolean
): {
  permissions: unknown
  scope: "turn"
  strictAutoReview?: boolean
} {
  const record =
    params && typeof params === "object"
      ? (params as Record<string, unknown>)
      : {}
  const requested =
    record.permissions && typeof record.permissions === "object"
      ? record.permissions
      : {}
  if (persistForTurn) {
    return { permissions: requested, scope: "turn" }
  }
  return { permissions: {}, scope: "turn", strictAutoReview: true }
}

function extractRequestId(params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>
  for (const key of [
    "requestId",
    "approvalId",
    "itemId",
    "callId",
    "elicitationId",
  ]) {
    const v = p[key]
    if (typeof v === "string" && v.length > 0) return v
    if (typeof v === "number") return String(v)
  }
  return ""
}
