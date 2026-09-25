import { asRecord, readTrimmed } from "@betterc0de/schema"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import {
  type ApprovalRequestId,
  type ModelSelection,
  type ProviderAdapterShape,
  type ProviderApprovalDecision,
  type ProviderCapabilities,
  type ProviderKind,
  type ProviderModel,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSkill,
  type ProviderSlashCommand,
  type ProviderThreadSnapshot,
  type ThreadId,
  type TurnId,
} from "../contracts"
import type { EventNdjsonLogger } from "../EventNdjsonLogger"
import { acpTurnFailureMessage } from "../cursor/AcpJsonRpcClient"
import {
  mergeCursorCustomModels as mergeAcpCustomModels,
  resolveCursorAcpBaseModelId as resolveAcpBaseModelId,
  resolveCursorAcpConfigUpdates as resolveAcpConfigUpdates,
} from "../cursor/CursorAcpSupport"
import {
  createAcpRuntime,
  type AcpEvent,
  type AcpExit,
  type AcpMode,
  type AcpModeState,
  type AcpPermissionRequest,
  type AcpPlanUpdate,
  type AcpRuntime,
  type AcpRuntimeOptions,
  type AcpRuntimeProfile,
  type AcpRuntimeSettings,
  type AcpStarted,
} from "./AcpRuntimeBase"
import {
  redactAcpMcpSecrets,
  resolveAcpMcpServers,
  type AcpMcpServer,
  type AcpMcpServerResolver,
} from "../cursor/AcpMcpServers"
import {
  pendingRequestKindFromDecisionKind,
  StalePendingProviderRequestError,
} from "../pendingRequestErrors"
import { prependProviderHistoryForFreshSession } from "../ProviderHistoryPrompt"
import {
  newCleanupQuarantineState,
  recordCleanupQuarantineFailure,
  retryCleanupQuarantines,
  type CleanupQuarantineState,
} from "../CleanupQuarantine"
import { logger } from "../../../observability/logger"
import {
  configuredAgentAllowMayAutoApprove,
  evaluateConfiguredAgentToolPermission,
} from "../../agent-permission-runtime"

/**
 * Provider-neutral adapter over an {@link AcpRuntime}: session lifecycle,
 * turn dispatch, permission routing, cleanup quarantine, event projection.
 *
 * Every way a concrete CLI diverges — identity, binary resolution, model
 * discovery, protocol extensions, the read-only ceiling, how a missing safe
 * mode or a rejected model update is treated — is a field on
 * {@link AcpProviderProfile}. This file must stay free of per-vendor
 * knowledge (a structure test enforces that); the protocol helpers it imports
 * from `../cursor/` are generic ACP code that merely lives there.
 */

const ACP_RESUME_VERSION = 1 as const
const METADATA_CACHE_TTL_MS = 15 * 60 * 1000
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"]
const ACP_IMPLEMENT_MODE_ALIASES = [
  "code",
  "agent",
  "default",
  "chat",
  "implement",
]
const ACP_APPROVAL_MODE_ALIASES = ["ask"]
const ACP_SECURITY_MODE_ALIASES = ["security", "audit"]

const CAPABILITIES: ProviderCapabilities = {
  supportsStreaming: true,
  supportsTools: true,
  supportsApprovals: true,
  supportsResume: true,
  managesOwnLifecycle: true,
}

/** `raw.source` for native-event logging and projected events. */
export type AcpNativeLogSource = "acp.jsonrpc" | `acp.${string}.extension`

export interface AcpAdapterOptions<
  TSettings extends AcpRuntimeSettings = AcpRuntimeSettings,
> {
  readonly providerInstanceId?: string
  readonly continuationKey?: string
  readonly binaryPath?: string | null
  readonly environment?: ReadonlyArray<{
    readonly name: string
    readonly value: string
  }>
  readonly customModels?: ReadonlyArray<string>
  readonly clientInfo?: {
    readonly name: string
    readonly title: string
    readonly version: string
  }
  readonly nativeEventLogger?: EventNdjsonLogger | null
  readonly runtimeFactory?: AcpRuntimeFactory<TSettings>
  readonly resolveMcpServers?: AcpMcpServerResolver
  readonly resolveOrchestratorServer?: import("../../../services/orchestrator/mcp").OrchestratorServerResolver
}

export type AcpRuntimeFactory<
  TSettings extends AcpRuntimeSettings = AcpRuntimeSettings,
> = (input: AcpRuntimeOptions<TSettings>) => AcpRuntime

export interface AcpStartSessionInput {
  readonly threadId: ThreadId
  readonly cwd?: string | null
  readonly modelSelection?: ModelSelection | null
  readonly resumeCursor?: unknown | null
  readonly runtimeMode?: string | null
}

export interface UserInputQuestion {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly options?: Array<{
    readonly label: string
    readonly description?: string
  }>
  readonly multiSelect?: boolean
}

export interface PendingUserInput {
  readonly questions: UserInputQuestion[]
  readonly resolve: (answers: Record<string, unknown>) => void
}

export interface AcpEventBase {
  readonly threadId: string
  readonly provider: ProviderKind
  readonly providerKind: ProviderKind
  readonly providerInstanceId: string
  readonly eventId: string
  readonly at: number
  readonly createdAt?: string
}

/**
 * What a profile's `registerExtensions` hook may reach into. Everything is a
 * function because the session context does not exist until `runtime.start()`
 * has returned, while extension handlers are registered before that.
 */
export interface AcpExtensionContext {
  readonly threadKey: string
  readonly pendingUserInputs: Map<string, PendingUserInput>
  readonly pendingRequestTimeoutMs: number
  /** False before the session exists and after it was stopped. */
  isActive(): boolean
  activeTurnId(): TurnId | undefined
  eventBase(): AcpEventBase
  emitEvent(event: ProviderRuntimeEvent): void
  logNative(method: string, payload: unknown, source: AcpNativeLogSource): void
  emitPlanUpdate(
    payload: AcpPlanUpdate,
    rawPayload: unknown,
    source: AcpNativeLogSource,
    method: string
  ): void
}

export interface AcpProviderProfile<
  TSettings extends AcpRuntimeSettings,
  TOptions extends AcpAdapterOptions<TSettings>,
> {
  readonly kind: ProviderKind
  readonly displayName: string
  /** Short name used in messages and error text ("<label> ACP …"). */
  readonly label: string
  readonly defaultInstanceId: string
  /** `continuationKey` defaults to `<continuationPrefix>:<instanceId>`. */
  readonly continuationPrefix: string
  /** `<errorCodePrefix>_STARTUP_IN_PROGRESS`, `_CLEANUP_QUARANTINED`, … */
  readonly errorCodePrefix: string
  /** Thread id stamped on native-event logs of the model-discovery probe. */
  readonly modelProbeThreadId: string
  readonly pendingRequestTimeoutMs: number
  readonly isConfigured: (options: TOptions) => boolean
  /**
   * Runtime settings for a fresh child. May reject (e.g. the CLI binary
   * cannot be verified); the rejection propagates out of `startSession`.
   */
  readonly resolveRuntimeSettings: (options: TOptions) => Promise<TSettings>
  readonly runtimeProfile: AcpRuntimeProfile<TSettings>
  readonly models: {
    /** Base list used when the probe is skipped or fails (before custom-model merge). */
    readonly fallback: (options: TOptions) => ReadonlyArray<ProviderModel>
    /** Live inventory read off a started probe session; empty usually uses fallback. */
    readonly fromStarted: (started: AcpStarted) => ReadonlyArray<ProviderModel>
    /** Some agents explicitly advertise an empty model list. */
    readonly isEmptyAuthoritative?: (started: AcpStarted) => boolean
    /** Namespace a cached list by the account selected in the CLI. */
    readonly cacheIdentity?: (options: TOptions) => string | null
    readonly onLiveModels?: (
      options: TOptions,
      models: ReadonlyArray<ProviderModel>
    ) => void
    /**
     * Which timestamp the cache gets when `isConfigured()` is false:
     * `"probe-start"` = the `Date.now()` captured on entry to
     * `availableModels`, `"now"` = a fresh `Date.now()`. Preserved per
     * provider rather than unified.
     */
    readonly unconfiguredCheckedAt: "probe-start" | "now"
  }
  /**
   * Consulted BEFORE durable grants on every permission request. A non-null
   * result denies the tool with `tool.denied` and never opens an approval —
   * an "always allow" rule cannot punch through it.
   */
  readonly permissionCeiling?: (input: {
    readonly runtimeMode: string | null | undefined
    readonly kind: string
  }) => { readonly reason: string } | null
  /** Vendor `onExtRequest`/`onExtNotification` registrations. */
  readonly registerExtensions?: (
    runtime: AcpRuntime,
    context: AcpExtensionContext
  ) => void
  /**
   * Whether the provider can ever open a `user-input.requested` event. When
   * false, answering one is a `<errorCodePrefix>_REQUEST_KIND_UNSUPPORTED`
   * (409) rather than a stale-request error.
   */
  readonly supportsUserInput: boolean
  /** A rejected `setModel` during session configuration: fail, or keep the CLI's default. */
  readonly setModelFailure: "throw" | "ignore"
  /**
   * A plan/ask/security intent for which the session advertises no matching
   * mode: fail closed with the provider's error, or leave the native mode.
   */
  readonly missingSafeMode:
    | {
        readonly behaviour: "throw"
        readonly error: (intent: string, compatibleMode: string) => Error
      }
    | { readonly behaviour: "keep-native" }
}

interface SessionContext {
  permissionRuntimeMode: string | null
  readonly orchestrationConfig: string
  session: ProviderSession
  readonly runtime: AcpRuntime
  readonly pendingApprovals: Map<string, PendingApproval>
  readonly pendingUserInputs: Map<string, PendingUserInput>
  readonly unsubscribeRuntime: () => void
  readonly unsubscribeExit: () => void
  readonly turns: Array<{ id: TurnId; items: unknown[] }>
  readonly modelSelection?: ModelSelection | null
  activeTurnId: TurnId | null
  activeDispatchTurnId: string | null
  lastPlanFingerprint: string | null
  /** ACP session id whose first prompt already carried the thread history. */
  historySeededSessionId: string | null
  stopped: boolean
  stopComplete: boolean
  stopPromise: Promise<void> | null
}

interface RuntimeCleanupContext extends CleanupQuarantineState {
  readonly runtime: AcpRuntime
}

interface PendingApproval {
  readonly permissionRequest: AcpPermissionRequest
  readonly resolve: (decision: ProviderApprovalDecision) => void
}

interface MetadataCache<T> {
  readonly checkedAt: number
  readonly value: T
}

export class AcpAdapterBase<
  TSettings extends AcpRuntimeSettings,
  TOptions extends AcpAdapterOptions<TSettings>,
> implements ProviderAdapterShape {
  readonly provider: ProviderKind
  readonly displayName: string
  readonly capabilities = CAPABILITIES

  private readonly bus = new EventEmitter()
  private readonly sessions = new Map<string, SessionContext>()
  private readonly runtimeCleanupQuarantines = new Map<
    AcpRuntime,
    RuntimeCleanupContext
  >()
  private startupInProgress = false
  private modelsCache: MetadataCache<ReadonlyArray<ProviderModel>> | null = null
  private modelsCacheIdentity: string | null = null
  // In-flight dedup: concurrent cold-cache callers (several listInstances
  // at app start) must share ONE probe child instead of spawning one each.
  private modelsInFlight: Promise<ReadonlyArray<ProviderModel>> | null = null

  constructor(
    protected readonly profile: AcpProviderProfile<TSettings, TOptions>,
    protected readonly options: TOptions
  ) {
    this.provider = profile.kind
    this.displayName = profile.displayName
  }

  isConfigured(): boolean {
    return this.profile.isConfigured(this.options)
  }

  async availableModels(): Promise<ReadonlyArray<ProviderModel>> {
    const now = Date.now()
    const identity = this.profile.models.cacheIdentity?.(this.options) ?? null
    if (identity !== this.modelsCacheIdentity) {
      this.modelsCacheIdentity = identity
      this.modelsCache = null
      this.modelsInFlight = null
    }
    if (
      this.modelsCache &&
      now - this.modelsCache.checkedAt < METADATA_CACHE_TTL_MS
    ) {
      return this.modelsCache.value
    }
    if (this.modelsInFlight) return this.modelsInFlight
    const probe = this.fetchAvailableModels(now, identity).finally(() => {
      if (this.modelsInFlight === probe) this.modelsInFlight = null
    })
    this.modelsInFlight = probe
    return probe
  }

  private async fetchAvailableModels(
    startedAt: number,
    identity: string | null
  ): Promise<ReadonlyArray<ProviderModel>> {
    const fallback = mergeAcpCustomModels(
      this.profile.models.fallback(this.options),
      this.options.customModels ?? []
    )
    if (!this.isConfigured()) {
      if (identity === this.modelsCacheIdentity)
        this.modelsCache = {
          checkedAt:
            this.profile.models.unconfiguredCheckedAt === "probe-start"
              ? startedAt
              : Date.now(),
          value: fallback,
        }
      return fallback
    }

    try {
      await this.closeAllRuntimeCleanupQuarantines()
      const runtime = await this.createRuntime(
        normalizeCwd(null),
        null,
        this.profile.modelProbeThreadId
      )
      try {
        const started = await runtime.start()
        const live = this.profile.models.fromStarted(started)
        const models =
          live.length > 0 || this.profile.models.isEmptyAuthoritative?.(started)
            ? mergeAcpCustomModels(live, this.options.customModels ?? [])
            : fallback
        if (identity === this.modelsCacheIdentity) {
          this.modelsCache = { checkedAt: Date.now(), value: models }
          if (
            live.length > 0 ||
            this.profile.models.isEmptyAuthoritative?.(started)
          )
            this.profile.models.onLiveModels?.(this.options, live)
        }
        return models
      } finally {
        await this.closeTrackedRuntime(runtime)
      }
    } catch {
      if (identity === this.modelsCacheIdentity)
        this.modelsCache = { checkedAt: Date.now(), value: fallback }
      return fallback
    }
  }

  async availableSkills(): Promise<ReadonlyArray<ProviderSkill>> {
    return []
  }

  async availableSlashCommands(): Promise<ReadonlyArray<ProviderSlashCommand>> {
    return []
  }

  async startSession(input: AcpStartSessionInput): Promise<ProviderSession> {
    if (this.startupInProgress) {
      throw Object.assign(
        new Error(
          `Another ${this.profile.label} ACP startup cleanup is already in progress.`
        ),
        {
          code: `${this.profile.errorCodePrefix}_STARTUP_IN_PROGRESS`,
          statusCode: 503,
        }
      )
    }
    this.startupInProgress = true
    try {
      return await this.startSessionWithAdmission(input)
    } finally {
      this.startupInProgress = false
    }
  }

  private async startSessionWithAdmission(
    input: AcpStartSessionInput
  ): Promise<ProviderSession> {
    try {
      await this.closeAllRuntimeCleanupQuarantines()
      this.pruneCleanedStoppedSessions()
    } catch (error) {
      throw Object.assign(
        new Error(
          `${this.profile.label} ACP startup is quarantined until prior runtime cleanup succeeds.`,
          { cause: error }
        ),
        {
          code: `${this.profile.errorCodePrefix}_CLEANUP_QUARANTINED`,
          statusCode: 503,
        }
      )
    }
    const key = input.threadId as string
    const existing = this.sessions.get(key)
    if (existing) await this.stopSession(input.threadId)

    const cwd = normalizeCwd(input.cwd)
    const resumeSessionId = readAcpResumeSessionId(input.resumeCursor)
    const configuredServers = (await this.resolveSessionMcpServers(cwd)).filter(
      (server) => server.name !== "betterc0de_orchestrator"
    )
    const teamServer = await this.options.resolveOrchestratorServer?.(cwd, key)
    const mcpServers: ReadonlyArray<AcpMcpServer> = teamServer
      ? [
          ...configuredServers,
          {
            name: "betterc0de_orchestrator",
            type: "http",
            url: teamServer.url,
            headers: Object.entries(teamServer.headers).map(
              ([name, value]) => ({ name, value })
            ),
          },
        ]
      : configuredServers
    const runtime = await this.createRuntime(
      cwd,
      resumeSessionId,
      key,
      mcpServers
    )
    const pendingApprovals = new Map<string, PendingApproval>()
    const pendingUserInputs = new Map<string, PendingUserInput>()
    let context: SessionContext | null = null

    const unsubscribeRuntime = runtime.onEvent((event) => {
      if (context && !context.stopped) this.handleRuntimeEvent(context, event)
    })
    const unsubscribeExit =
      runtime.onExit?.((event) => {
        if (context && !context.stopped) {
          this.handleRuntimeExit(context, event)
        }
      }) ?? (() => {})
    runtime.onPermissionRequest(async (permissionRequest) => {
      if (!context || context.stopped) {
        return { outcome: { outcome: "cancelled" } }
      }
      const permissionTool = canonicalRequestTypeFromAcpKind(
        permissionRequest.kind
      )
      // A profile ceiling (e.g. read-only enforced per tool call because the
      // agent advertises no read-only mode) is checked before durable grants
      // so an "always allow" rule cannot punch a hole in the mode the user
      // chose.
      const ceiling = this.profile.permissionCeiling?.({
        runtimeMode: context.permissionRuntimeMode,
        kind: permissionRequest.kind,
      })
      if (ceiling) {
        this.emitEvent({
          ...this.eventBase(key),
          turnId: context.activeTurnId ?? undefined,
          type: "tool.denied",
          payload: {
            toolName: permissionTool,
            reason: ceiling.reason,
          },
        })
        return {
          outcome: {
            outcome: "selected",
            optionId:
              selectRejectPermissionOption(permissionRequest.raw) ??
              "reject-once",
          },
        }
      }
      const durable = evaluateConfiguredAgentToolPermission({
        threadId: key,
        toolName: permissionTool,
        toolInput: permissionRequest.raw,
      })
      if (
        durable &&
        durable.source !== "default" &&
        durable.decision === "deny"
      ) {
        this.emitEvent({
          ...this.eventBase(key),
          turnId: context.activeTurnId ?? undefined,
          type: "tool.denied",
          payload: {
            toolName: permissionTool,
            reason: durable.reason,
          },
        })
        return {
          outcome: {
            outcome: "selected",
            optionId:
              selectRejectPermissionOption(permissionRequest.raw) ??
              "reject-once",
          },
        }
      }
      if (
        durable &&
        durable.source !== "default" &&
        durable.decision === "allow" &&
        configuredAgentAllowMayAutoApprove(key)
      ) {
        return {
          outcome: {
            outcome: "selected",
            optionId:
              selectAllowPermissionOption(permissionRequest.raw) ??
              "allow-once",
          },
        }
      }
      if (
        context.permissionRuntimeMode === "full-access" &&
        (!durable || durable.source === "default")
      ) {
        const autoApproved = selectAutoApprovedPermissionOption(
          permissionRequest.raw
        )
        if (autoApproved) {
          return { outcome: { outcome: "selected", optionId: autoApproved } }
        }
      }
      const requestId = randomUUID()
      const turnId = context.activeTurnId ?? undefined
      const decisionPromise = waitForApprovalDecision(
        pendingApprovals,
        requestId,
        permissionRequest,
        this.profile.pendingRequestTimeoutMs
      )
      try {
        this.emitEvent({
          ...this.eventBase(key),
          turnId,
          requestId,
          raw: {
            source: "acp.jsonrpc",
            method: "session/request_permission",
            payload: permissionRequest.raw,
          },
          type: "request.opened",
          payload: {
            requestType: permissionTool,
            detail:
              permissionRequest.detail ??
              safeJson(permissionRequest.raw)?.slice(0, 2000) ??
              `${this.profile.label} permission request`,
            args: permissionRequest.raw,
          },
        })
      } catch (error) {
        pendingApprovals
          .get(requestId)
          ?.resolve({ kind: "tool_approval", decision: "deny" })
        throw error
      }
      const decision = await decisionPromise
      if (context.stopped) return { outcome: { outcome: "cancelled" } }
      this.emitEvent({
        ...this.eventBase(key),
        turnId,
        requestId,
        type: "request.resolved",
        payload: {
          requestType: permissionTool,
          decision:
            decision.kind === "tool_approval" ? decision.decision : "deny",
        },
      })
      return {
        outcome: {
          outcome: "selected",
          optionId:
            decision.kind === "tool_approval" && decision.decision === "approve"
              ? (selectAllowPermissionOption(permissionRequest.raw) ??
                "allow-once")
              : (selectRejectPermissionOption(permissionRequest.raw) ??
                "reject-once"),
        },
      }
    })
    this.profile.registerExtensions?.(runtime, {
      threadKey: key,
      pendingUserInputs,
      pendingRequestTimeoutMs: this.profile.pendingRequestTimeoutMs,
      isActive: () => Boolean(context && !context.stopped),
      activeTurnId: () => context?.activeTurnId ?? undefined,
      eventBase: () => this.eventBase(key),
      emitEvent: (event) => this.emitEvent(event),
      logNative: (method, payload, source) =>
        this.logNative(key, method, payload, source),
      emitPlanUpdate: (payload, rawPayload, source, method) => {
        if (!context) return
        this.emitPlanUpdate(context, payload, rawPayload, source, method)
      },
    })

    let started: Awaited<ReturnType<AcpRuntime["start"]>>
    try {
      started = await runtime.start()
      await this.applySessionConfiguration({
        runtime,
        runtimeMode: input.runtimeMode ?? null,
        chatMode: null,
        modelSelection: this.modelSelectionForInstance(input.modelSelection),
      })
    } catch (error) {
      unsubscribeRuntime()
      unsubscribeExit()
      try {
        await this.closeTrackedRuntime(runtime)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${this.profile.label} ACP session startup failed and runtime cleanup also failed.`
        )
      }
      throw error
    }

    const now = Date.now()
    const runtimeMode = normalizeProviderRuntimeMode(input.runtimeMode)
    const session: ProviderSession = {
      threadId: key,
      providerInstanceId: this.providerInstanceId(),
      providerThreadId: started.sessionId,
      resumeCursor: {
        schemaVersion: ACP_RESUME_VERSION,
        sessionId: started.sessionId,
      },
      continuationKey: this.continuationKey(),
      status: "ready",
      cwd,
      activeTurnId: null,
      runtimeMode,
      createdAt: now,
      updatedAt: now,
    }
    context = {
      permissionRuntimeMode: runtimeMode,
      orchestrationConfig: JSON.stringify(teamServer ?? null),
      session,
      runtime,
      pendingApprovals,
      pendingUserInputs,
      unsubscribeRuntime,
      unsubscribeExit,
      turns: [],
      modelSelection: input.modelSelection ?? null,
      activeTurnId: null,
      activeDispatchTurnId: null,
      lastPlanFingerprint: null,
      historySeededSessionId: null,
      stopped: false,
      stopComplete: false,
      stopPromise: null,
    }
    this.sessions.set(key, context)

    this.emitEvent({
      ...this.eventBase(key),
      type: "session.started",
      payload: { resume: started.initializeResult },
    })
    this.emitEvent({
      ...this.eventBase(key),
      type: "session.state.changed",
      payload: {
        state: "ready",
        reason: `${this.profile.label} ACP session ready`,
      },
    })
    this.emitEvent({
      ...this.eventBase(key),
      type: "thread.started",
      payload: { providerThreadId: started.sessionId },
    })

    return session
  }

  async listSessions(): Promise<ReadonlyArray<ProviderSession>> {
    return Array.from(this.sessions.values(), (context) => ({
      ...context.session,
    }))
  }

  async needsSessionConfigurationRefresh(input: {
    threadId: ThreadId
    cwd?: string | null
  }): Promise<boolean> {
    const context = this.sessions.get(input.threadId)
    if (!context || !this.options.resolveOrchestratorServer) return false
    const server = input.cwd
      ? await this.options.resolveOrchestratorServer(input.cwd, input.threadId)
      : null
    return context.orchestrationConfig !== JSON.stringify(server ?? null)
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const key = input.threadId as string
    let context = this.sessions.get(key)
    if (!context || context.stopped) {
      await this.startSession({
        threadId: input.threadId as ThreadId,
        cwd: input.projectPath ?? undefined,
        modelSelection: input.modelSelection ?? null,
        runtimeMode: runtimeModeForAcpTurn(input),
      })
      context = this.sessions.get(key)
    }
    if (!context) {
      throw new Error(
        `${this.profile.label} session not found for thread ${key}`
      )
    }

    const turnId = randomUUID() as TurnId
    const modelSelection = this.modelSelectionForInstance(input.modelSelection)
    const runtimeMode =
      runtimeModeForAcpTurn(input) ?? context.session.runtimeMode ?? null
    // Install the current ceiling before configuration can invoke callbacks.
    context.permissionRuntimeMode = runtimeMode
    await this.applySessionConfiguration({
      runtime: context.runtime,
      runtimeMode,
      chatMode: input.chatMode ?? null,
      modelSelection,
    })
    this.updateSession(context, { runtimeMode })
    const modelId = resolveAcpBaseModelId(
      modelSelection?.model ?? input.modelId
    )
    context.activeTurnId = turnId
    context.activeDispatchTurnId = input.dispatchTurnId ?? null
    context.lastPlanFingerprint = null
    this.updateSession(context, { status: "running", activeTurnId: turnId })
    this.emitEvent({
      ...this.eventBase(key),
      turnId,
      type: "turn.started",
      payload: {
        model: modelId,
        ...(input.dispatchTurnId
          ? { dispatchTurnId: input.dispatchTurnId }
          : {}),
      },
    })

    try {
      const currentPrompt = input.message.trim()
      if (!currentPrompt) {
        throw new Error(
          `${this.profile.label} turn requires a non-empty message`
        )
      }
      // Start (idempotent) before building the prompt: only now do we know
      // whether `session/load` actually resumed or fell back to `session/new`.
      // A fallback session is empty and needs the history seed exactly like a
      // fresh one; a session we already seeded (same ACP session id) does not.
      const started = await context.runtime.start()
      const seeded =
        started.resumed || context.historySeededSessionId === started.sessionId
      const prompt = prependProviderHistoryForFreshSession({
        history: input.history,
        currentPrompt,
        resumed: seeded,
      })
      const result = await context.runtime.prompt({
        prompt: [{ type: "text", text: prompt }],
      })
      context.historySeededSessionId = started.sessionId
      context.turns.push({
        id: turnId,
        items: [{ prompt, result }],
      })
      context.activeTurnId = null
      this.updateSession(context, { status: "ready", activeTurnId: null })
      this.emitEvent({
        ...this.eventBase(key),
        turnId,
        type: "turn.completed",
        payload: {
          state:
            readTrimmed(result, "stopReason") === "cancelled"
              ? "cancelled"
              : "completed",
          stopReason: readTrimmed(result, "stopReason") ?? null,
          ...(input.dispatchTurnId
            ? { dispatchTurnId: input.dispatchTurnId }
            : {}),
        },
      })
      context.activeDispatchTurnId = null
    } catch (error) {
      if (context.stopped) throw error
      context.activeTurnId = null
      this.updateSession(context, { status: "error", activeTurnId: null })
      const publicMessage = acpTurnFailureMessage(error, this.profile.label)
      this.emitEvent({
        ...this.eventBase(key),
        turnId,
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: publicMessage,
          ...(input.dispatchTurnId
            ? { dispatchTurnId: input.dispatchTurnId }
            : {}),
        },
      })
      context.activeDispatchTurnId = null
      this.emitEvent({
        ...this.eventBase(key),
        type: "runtime.error",
        payload: { message: publicMessage, class: "provider_error" },
      })
      throw error
    }
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const context = this.sessions.get(threadId as string)
    if (!context || context.stopped) return
    settlePending(context)
    await context.runtime.cancel()
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision
  ): Promise<void> {
    const context = this.ensureContext(threadId)
    const key = requestId as string
    if (decision.kind === "tool_approval") {
      const pending = context.pendingApprovals.get(key)
      if (!pending) {
        throw new StalePendingProviderRequestError("approval", requestId)
      }
      pending.resolve(decision)
      return
    }
    if (!this.profile.supportsUserInput) {
      // A provider with no user-input request over ACP never opens one, so an
      // always-empty map would report every answer as a *stale* request and
      // send users hunting for a restart problem that does not exist. Say
      // what is actually going on.
      throw Object.assign(
        new Error(
          `${this.profile.displayName} does not surface ${pendingRequestKindFromDecisionKind(
            decision.kind
          )} requests; there is no pending request '${key}' to answer.`
        ),
        {
          code: `${this.profile.errorCodePrefix}_REQUEST_KIND_UNSUPPORTED`,
          statusCode: 409,
        }
      )
    }
    const pending = context.pendingUserInputs.get(key)
    if (!pending) {
      throw new StalePendingProviderRequestError(
        pendingRequestKindFromDecisionKind(decision.kind),
        requestId
      )
    }
    pending.resolve(decision.kind === "user_input" ? decision.answers : {})
  }

  async readThread(threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    const context = this.ensureContext(threadId)
    return { threadId, turns: context.turns }
  }

  async rollbackThread(
    threadId: ThreadId,
    numTurns: number
  ): Promise<ProviderThreadSnapshot> {
    const context = this.ensureContext(threadId)
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1")
    }
    const nextLength = Math.max(0, context.turns.length - numTurns)
    context.turns.splice(nextLength)
    return { threadId, turns: context.turns }
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const key = threadId as string
    const context = this.sessions.get(key)
    if (!context || context.stopComplete) return
    if (context.stopPromise) return context.stopPromise
    context.stopped = true
    settlePending(context)
    context.unsubscribeRuntime()
    context.unsubscribeExit()
    const stopPromise = (async () => {
      await this.closeTrackedRuntime(context.runtime)
      context.stopComplete = true
      if (this.sessions.get(key) === context) this.sessions.delete(key)
      this.emitEvent({
        ...this.eventBase(key),
        type: "session.exited",
        payload: { exitKind: "graceful" },
      })
    })()
    context.stopPromise = stopPromise
    try {
      await stopPromise
    } finally {
      if (context.stopPromise === stopPromise) context.stopPromise = null
    }
  }

  hasSession(threadId: ThreadId): boolean {
    const context = this.sessions.get(threadId as string)
    return Boolean(context && !context.stopped)
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.bus.on("event", listener)
    return () => this.bus.off("event", listener)
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.sessions.keys()).map((threadId) =>
        this.stopSession(threadId as ThreadId)
      )
    )
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    try {
      await this.closeAllRuntimeCleanupQuarantines()
      this.pruneCleanedStoppedSessions()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to stop all ${this.profile.label} ACP sessions`
      )
    }
  }

  private handleRuntimeEvent(context: SessionContext, event: AcpEvent): void {
    const threadId = context.session.threadId
    switch (event.type) {
      case "mode.changed":
        return
      case "assistant.started":
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId: context.activeTurnId ?? undefined,
          itemId: event.itemId,
          type: "item.started",
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
          },
        })
        return
      case "assistant.completed":
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId: context.activeTurnId ?? undefined,
          itemId: event.itemId,
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
          },
        })
        return
      case "plan.updated":
        this.logNative(threadId, "session/update", event.raw, "acp.jsonrpc")
        this.emitPlanUpdate(
          context,
          event.payload,
          event.raw,
          "acp.jsonrpc",
          "session/update"
        )
        return
      case "tool.updated":
        this.logNative(threadId, "session/update", event.raw, "acp.jsonrpc")
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId: context.activeTurnId ?? undefined,
          itemId: event.toolCall.toolCallId,
          raw: {
            source: "acp.jsonrpc",
            method: "session/update",
            payload: event.raw,
          },
          type:
            event.toolCall.status === "completed" ||
            event.toolCall.status === "failed"
              ? "item.completed"
              : "item.updated",
          payload: {
            itemType: canonicalItemTypeFromAcpToolKind(event.toolCall.kind),
            ...(runtimeItemStatusFromAcpToolStatus(event.toolCall.status)
              ? {
                  status: runtimeItemStatusFromAcpToolStatus(
                    event.toolCall.status
                  ),
                }
              : {}),
            ...(event.toolCall.title ? { title: event.toolCall.title } : {}),
            ...(event.toolCall.detail ? { detail: event.toolCall.detail } : {}),
            data: event.toolCall.data,
          },
        })
        return
      case "content.delta":
        this.logNative(threadId, "session/update", event.raw, "acp.jsonrpc")
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId: context.activeTurnId ?? undefined,
          ...(event.itemId ? { itemId: event.itemId } : {}),
          raw: {
            source: "acp.jsonrpc",
            method: "session/update",
            payload: event.raw,
          },
          type: "content.delta",
          payload: {
            streamKind: "assistant_text",
            delta: event.text,
          },
        })
        return
      case "reasoning.delta":
        this.logNative(threadId, "session/update", event.raw, "acp.jsonrpc")
        this.emitEvent({
          ...this.eventBase(threadId),
          turnId: context.activeTurnId ?? undefined,
          raw: {
            source: "acp.jsonrpc",
            method: "session/update",
            payload: event.raw,
          },
          type: "reasoning.delta",
          payload: {
            streamKind: "reasoning_text",
            delta: event.text,
          },
        })
        return
    }
  }

  private handleRuntimeExit(context: SessionContext, exit: AcpExit): void {
    const threadId = context.session.threadId
    if (context.stopped || this.sessions.get(threadId) !== context) {
      return
    }
    context.stopped = true
    context.unsubscribeRuntime()
    context.unsubscribeExit()
    settlePending(context)

    const message = `${this.profile.label} ACP process exited unexpectedly (code=${exit.code ?? "unknown"}, signal=${exit.signal ?? "none"}).`
    const turnId = context.activeTurnId
    const dispatchTurnId = context.activeDispatchTurnId
    context.activeTurnId = null
    context.activeDispatchTurnId = null
    this.updateSession(context, { status: "error", activeTurnId: null })
    if (turnId) {
      this.emitEvent({
        ...this.eventBase(threadId),
        turnId,
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: message,
          ...(dispatchTurnId ? { dispatchTurnId } : {}),
        },
      })
    }
    this.emitEvent({
      ...this.eventBase(threadId),
      type: "runtime.error",
      payload: {
        message,
        class: "provider_error",
        detail: exit,
      },
    })
    this.emitEvent({
      ...this.eventBase(threadId),
      type: "session.exited",
      payload: {
        reason: message,
        recoverable: true,
        exitKind: "error",
      },
    })
    this.trackUnexpectedContextCleanup(threadId, context)
  }

  private trackUnexpectedContextCleanup(
    key: string,
    context: SessionContext
  ): void {
    if (context.stopPromise) return
    const operation = (async () => {
      await this.closeTrackedRuntime(context.runtime)
      context.stopComplete = true
      if (this.sessions.get(key) === context) this.sessions.delete(key)
    })()
    context.stopPromise = operation
    void operation
      .catch(() => {
        // Context plus runtimeCleanupQuarantines retain the exact runtime for a
        // later startSession/stopSession/stopAll retry.
      })
      .finally(() => {
        if (context.stopPromise === operation) context.stopPromise = null
      })
  }

  private async closeTrackedRuntime(runtime: AcpRuntime): Promise<void> {
    let context = this.runtimeCleanupQuarantines.get(runtime)
    if (!context) {
      context = { runtime, ...newCleanupQuarantineState() }
      this.runtimeCleanupQuarantines.set(runtime, context)
    }
    if (context.closePromise) return await context.closePromise
    const closePromise = runtime.close()
    context.closePromise = closePromise
    try {
      await closePromise
      context.closeFailure = null
      this.runtimeCleanupQuarantines.delete(runtime)
    } catch (error) {
      recordCleanupQuarantineFailure(context, error)
      throw error
    } finally {
      if (context.closePromise === closePromise) context.closePromise = null
    }
  }

  /**
   * Re-attempts every quarantined close. An entry past its retry window is
   * released only by a confirmed close; otherwise it stays quarantined (see
   * `retryCleanupQuarantines`) — a runtime nobody confirmed dead must not be
   * forgotten just because it has been failing for a while.
   */
  private async closeAllRuntimeCleanupQuarantines(): Promise<void> {
    const contexts = Array.from(this.runtimeCleanupQuarantines.values())
    if (contexts.length === 0) return
    const failures = await retryCleanupQuarantines({
      contexts,
      close: (context) => this.closeTrackedRuntime(context.runtime),
      label: `${this.profile.label} ACP runtime`,
      logger,
    })
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to clean up quarantined ${this.profile.label} ACP runtimes`
      )
    }
  }

  private pruneCleanedStoppedSessions(): void {
    for (const [key, context] of this.sessions) {
      if (
        context.stopped &&
        !this.runtimeCleanupQuarantines.has(context.runtime)
      ) {
        context.stopComplete = true
        this.sessions.delete(key)
      }
    }
  }

  private emitPlanUpdate(
    context: SessionContext,
    payload: AcpPlanUpdate,
    rawPayload: unknown,
    source: AcpNativeLogSource,
    method: string
  ): void {
    const fingerprint = `${context.activeTurnId ?? "no-turn"}:${safeJson(payload)}`
    if (context.lastPlanFingerprint === fingerprint) return
    context.lastPlanFingerprint = fingerprint
    this.emitEvent({
      ...this.eventBase(context.session.threadId),
      turnId: context.activeTurnId ?? undefined,
      raw: { source, method, payload: rawPayload },
      type: "turn.plan.updated",
      payload: {
        ...(payload.explanation !== undefined
          ? { explanation: payload.explanation }
          : {}),
        plan: payload.plan.map((step) => ({ ...step })),
      },
    })
  }

  private updateSession(
    context: SessionContext,
    patch: Partial<
      Pick<ProviderSession, "status" | "activeTurnId" | "runtimeMode">
    >
  ): void {
    context.session = {
      ...context.session,
      ...patch,
      updatedAt: Date.now(),
    }
  }

  private ensureContext(threadId: ThreadId): SessionContext {
    const context = this.sessions.get(threadId as string)
    if (!context || context.stopped) {
      throw new Error(
        `${this.profile.label} session not found for thread ${threadId}`
      )
    }
    return context
  }

  private modelSelectionForInstance(
    selection: ModelSelection | null | undefined
  ): ModelSelection | undefined {
    if (!selection) return undefined
    if (selection.instanceId === this.providerInstanceId()) return selection
    return undefined
  }

  private async createRuntime(
    cwd: string,
    resumeSessionId: string | null,
    threadIdForLogs: string,
    mcpServers?: ReadonlyArray<AcpMcpServer>
  ): Promise<AcpRuntime> {
    const settings = await this.profile.resolveRuntimeSettings(this.options)
    const env = environmentArrayToProcessEnv(this.options.environment)
    const factory: AcpRuntimeFactory<TSettings> =
      this.options.runtimeFactory ??
      ((runtimeOptions) =>
        createAcpRuntime(this.profile.runtimeProfile, runtimeOptions))
    return factory({
      settings,
      cwd,
      ...(env ? { env } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      clientInfo: this.options.clientInfo ?? {
        name: "betterc0de",
        title: "BetterC0de",
        version: "0.0.0",
      },
      protocolLogger: (event) => {
        this.logNative(
          threadIdForLogs,
          "acp.protocol",
          redactAcpMcpSecrets(event.payload),
          "acp.jsonrpc"
        )
      },
    })
  }

  private async resolveSessionMcpServers(
    cwd: string
  ): Promise<ReadonlyArray<AcpMcpServer>> {
    const resolver =
      this.options.resolveMcpServers ??
      // `runtimeFactory` is the adapter's deterministic test seam. Avoid
      // consulting developer/user config from unit tests unless the test
      // explicitly supplies a resolver.
      (this.options.runtimeFactory ? null : resolveAcpMcpServers)
    return resolver ? await resolver(cwd) : []
  }

  private async applySessionConfiguration(input: {
    readonly runtime: AcpRuntime
    readonly runtimeMode: string | null
    readonly chatMode: string | null
    readonly modelSelection?: ModelSelection
  }): Promise<void> {
    if (input.modelSelection) {
      const model = resolveAcpBaseModelId(input.modelSelection.model)
      if (this.profile.setModelFailure === "ignore") {
        // The agent may not accept a synthetic "model" configId when its
        // session advertises no model picker — treat a rejected model update
        // as non-fatal and let the CLI keep its own default.
        try {
          await input.runtime.setModel(model)
        } catch {
          /* model picker unsupported by this CLI build — keep native default */
        }
      } else {
        await input.runtime.setModel(model)
      }
      const updates = resolveAcpConfigUpdates(
        input.runtime.getConfigOptions(),
        input.modelSelection.options
      )
      for (const update of updates) {
        await input.runtime.setConfigOption(update.configId, update.value)
      }
    }
    const modeId = this.resolveRequestedModeId({
      chatMode: input.chatMode,
      runtimeMode: input.runtimeMode,
      modeState: input.runtime.getModeState(),
    })
    if (modeId) await input.runtime.setMode(modeId)
  }

  private resolveRequestedModeId(input: {
    readonly chatMode: string | null
    readonly runtimeMode: string | null
    readonly modeState: AcpModeState | undefined
  }): string | undefined {
    const chatMode = input.chatMode?.trim().toLowerCase()
    const runtimeMode = input.runtimeMode?.trim().toLowerCase()
    const modeState = input.modeState
    const safeIntent =
      chatMode === "plan"
        ? "plan"
        : chatMode === "ask"
          ? "approval"
          : chatMode === "security"
            ? "security"
            : runtimeMode === "plan"
              ? "plan"
              : runtimeMode === "ask" ||
                  runtimeMode === "approval-required" ||
                  runtimeMode === "read-only"
                ? "approval"
                : runtimeMode === "security"
                  ? "security"
                  : null
    if (safeIntent) {
      const mode = modeState
        ? safeIntent === "plan"
          ? findModeByExactAliases(
              modeState.availableModes,
              ACP_PLAN_MODE_ALIASES
            )
          : safeIntent === "security"
            ? (findModeByExactAliases(
                modeState.availableModes,
                ACP_SECURITY_MODE_ALIASES
              ) ??
              findModeByExactAliases(
                modeState.availableModes,
                ACP_APPROVAL_MODE_ALIASES
              ))
            : findModeByExactAliases(
                modeState.availableModes,
                ACP_APPROVAL_MODE_ALIASES
              )
        : undefined
      if (mode) return mode.id
      if (this.profile.missingSafeMode.behaviour === "keep-native") {
        // Nothing to select: the profile guarantees the intent another way
        // (e.g. a per-tool-call permission ceiling), so leaving the session
        // on its native mode is safe.
        return undefined
      }
      const intent =
        chatMode === "plan" || chatMode === "ask" || chatMode === "security"
          ? chatMode
          : (runtimeMode ?? safeIntent)
      throw this.profile.missingSafeMode.error(
        intent,
        safeIntent === "security"
          ? "security/approval"
          : safeIntent === "approval"
            ? "approval/read-only"
            : "plan"
      )
    }
    if (!modeState) return undefined
    return (
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)
        ?.id ??
      modeState.availableModes.find(
        (mode) => !findModeByAliases([mode], ACP_PLAN_MODE_ALIASES)
      )?.id ??
      modeState.currentModeId
    )
  }

  private providerInstanceId(): string {
    return this.options.providerInstanceId ?? this.profile.defaultInstanceId
  }

  private continuationKey(): string {
    return (
      this.options.continuationKey ??
      `${this.profile.continuationPrefix}:${this.providerInstanceId()}`
    )
  }

  private eventBase(threadId: string, createdAt?: string): AcpEventBase {
    return {
      threadId,
      provider: this.profile.kind,
      providerKind: this.profile.kind,
      providerInstanceId: this.providerInstanceId(),
      eventId: randomUUID(),
      at: Date.now(),
      ...(createdAt ? { createdAt } : {}),
    }
  }

  private emitEvent(event: ProviderRuntimeEvent): void {
    this.bus.emit("event", event)
  }

  private logNative(
    threadId: string,
    method: string,
    payload: unknown,
    source: AcpNativeLogSource
  ): void {
    const logger = this.options.nativeEventLogger
    if (!logger) return
    const observedAt = new Date().toISOString()
    try {
      logger.write(
        {
          observedAt,
          event: {
            id: randomUUID(),
            kind: "notification",
            provider: this.profile.kind,
            createdAt: observedAt,
            method,
            threadId,
            payload: { source, payload },
          },
        },
        threadId
      )
    } catch {
      /* logger is best-effort */
    }
  }
}

function findModeByAliases(
  modes: ReadonlyArray<AcpMode>,
  aliases: ReadonlyArray<string>
): AcpMode | undefined {
  const exact = findModeByExactAliases(modes, aliases)
  if (exact) return exact
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase())
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) =>
      [mode.id, mode.name, mode.description ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(alias)
    )
    if (partial) return partial
  }
  return undefined
}

function findModeByExactAliases(
  modes: ReadonlyArray<AcpMode>,
  aliases: ReadonlyArray<string>
): AcpMode | undefined {
  const priorities = new Map<string, number>()
  aliases.forEach((alias, index) => {
    const key = alias.toLowerCase()
    if (!priorities.has(key)) priorities.set(key, index)
  })
  let chosen: AcpMode | undefined
  let best = Infinity
  for (const mode of modes) {
    const rank = Math.min(
      priorities.get(mode.id.toLowerCase()) ?? Infinity,
      priorities.get(mode.name.toLowerCase()) ?? Infinity
    )
    if (rank < best) {
      best = rank
      chosen = mode
    }
  }
  return chosen
}

function canonicalRequestTypeFromAcpKind(kind: string | "unknown"): string {
  switch (kind) {
    case "execute":
      return "exec_command_approval"
    case "read":
      return "file_read_approval"
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval"
    default:
      return "unknown"
  }
}

function canonicalItemTypeFromAcpToolKind(kind: string | undefined): string {
  switch (kind) {
    case "execute":
      return "command_execution"
    case "edit":
    case "delete":
    case "move":
      return "file_change"
    case "search":
    case "fetch":
      return "web_search"
    default:
      return "dynamic_tool_call"
  }
}

function runtimeItemStatusFromAcpToolStatus(
  status: "pending" | "inProgress" | "completed" | "failed" | undefined
): string | undefined {
  switch (status) {
    case "pending":
    case "inProgress":
      return "inProgress"
    case "completed":
      return "completed"
    case "failed":
      return "failed"
    default:
      return undefined
  }
}

function selectAutoApprovedPermissionOption(raw: unknown): string | undefined {
  return selectPermissionOption(raw, ["allow_always", "allow_once"])
}

function selectAllowPermissionOption(raw: unknown): string | undefined {
  return selectPermissionOption(raw, ["allow_once", "allow_always"])
}

function selectRejectPermissionOption(raw: unknown): string | undefined {
  return selectPermissionOption(raw, ["reject_once", "reject_always", "reject"])
}

function selectPermissionOption(
  raw: unknown,
  kinds: ReadonlyArray<string>
): string | undefined {
  const rawOptions = asRecord(raw).options
  const options: unknown[] = Array.isArray(rawOptions) ? rawOptions : []
  for (const kind of kinds) {
    const option = options.find((entry) => asRecord(entry).kind === kind)
    const optionId = readTrimmed(asRecord(option), "optionId")
    if (optionId) return optionId
  }
  return undefined
}

function readAcpResumeSessionId(raw: unknown): string | null {
  const record = asRecord(raw)
  if (record.schemaVersion === ACP_RESUME_VERSION) {
    const sessionId = readTrimmed(record, "sessionId")
    if (sessionId) return sessionId
  }
  return readTrimmed(record, "providerThreadId") ?? null
}

function waitForApprovalDecision(
  pendingApprovals: Map<string, PendingApproval>,
  requestId: string,
  permissionRequest: AcpPermissionRequest,
  timeoutMs: number
): Promise<ProviderApprovalDecision> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (decision: ProviderApprovalDecision) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      pendingApprovals.delete(requestId)
      resolve(decision)
    }
    timer = setTimeout(
      () => finish({ kind: "tool_approval", decision: "deny" }),
      timeoutMs
    )
    timer.unref?.()
    pendingApprovals.set(requestId, {
      permissionRequest,
      resolve: finish,
    })
  })
}

/**
 * Parks a vendor user-input request until the user answers or the timeout
 * defaults it to "no answers". Exported for profile extension modules.
 */
export function waitForUserInputAnswers(
  pendingUserInputs: Map<string, PendingUserInput>,
  requestId: string,
  questions: UserInputQuestion[],
  timeoutMs: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (answers: Record<string, unknown>) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      pendingUserInputs.delete(requestId)
      resolve(answers)
    }
    timer = setTimeout(() => finish({}), timeoutMs)
    timer.unref?.()
    pendingUserInputs.set(requestId, { questions, resolve: finish })
  })
}

function settlePending(context: SessionContext): void {
  for (const pending of [...context.pendingApprovals.values()]) {
    pending.resolve({ kind: "tool_approval", decision: "deny" })
  }
  for (const pending of [...context.pendingUserInputs.values()]) {
    pending.resolve({})
  }
}

function normalizeCwd(cwd: string | null | undefined): string {
  const trimmed = cwd?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : process.cwd()
}

function normalizeProviderRuntimeMode(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toLowerCase()
  switch (trimmed) {
    case "bypass":
      return "full-access"
    case "full":
    case "allow-edits":
      return "auto-accept-edits"
    case "read":
      return "read-only"
    case "ask":
    case "ask-on-edit":
      return "approval-required"
    default:
      return trimmed.length > 0 ? trimmed : null
  }
}

function runtimeModeForAcpTurn(
  input: Pick<ProviderSendTurnInput, "chatMode" | "permissionLevel">
): string | null {
  switch (input.chatMode?.trim().toLowerCase()) {
    case "plan":
      return "plan"
    case "ask":
      return "read-only"
    case "security":
      return "security"
    default:
      return normalizeProviderRuntimeMode(input.permissionLevel)
  }
}

function environmentArrayToProcessEnv(
  environment: AcpAdapterOptions["environment"]
): NodeJS.ProcessEnv | undefined {
  if (!environment || environment.length === 0) return undefined
  const out: NodeJS.ProcessEnv = {}
  for (const entry of environment) {
    if (!entry.name) continue
    out[entry.name] = entry.value
  }
  return out
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
