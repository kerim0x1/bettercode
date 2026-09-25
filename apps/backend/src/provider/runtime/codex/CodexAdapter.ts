import { asRecord, readBoolean, readTrimmed } from "@betterc0de/schema"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { CliModelSnapshot, cliAccountIdentity } from "../CliModelSnapshot"
import {
  type ApprovalRequestId,
  type ProviderAdapterShape,
  type ProviderApprovalDecision,
  type ProviderCapabilities,
  getModelSelectionBooleanOptionValue,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderModel,
  type ProviderOptionDescriptor,
  type ProviderSkill,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadId,
  threadId as toThreadId,
} from "../contracts"
import { withDispatchTurnId } from "../dispatchTurnId"
import { logger } from "../../../observability/logger"
import {
  resolveTurnBooleanOption,
  resolveTurnModelId,
  resolveTurnStringOption,
} from "../providerTurnOptions"
import {
  pendingRequestKindFromDecisionKind,
  StalePendingProviderRequestError,
} from "../pendingRequestErrors"
import { normalizeLevel, type PermissionLevel } from "../../permissions"
import {
  CodexSessionRuntime,
  type CodexNativeEvent,
} from "./CodexSessionRuntime"
import { buildCodexHistoryPrefix } from "./CodexHistory"
import {
  buildUnsupportedAttachmentNotice,
  imageAttachments,
  parseBase64DataUrl,
} from "../../attachments"
import { type CodexHomeLayout, resolveCodexHomeLayout } from "./CodexHomeLayout"
import { codexProcessEnvironment } from "./CodexBinaryPath"
import { buildCodexCollaborationMode } from "./CodexDeveloperInstructions"
import { CodexRpcClient } from "./rpc"
import { translateCodexEvent } from "./translator"
import { isCodexCliAuthenticatedAsync } from "../../../cli/detect"
import type { EventNdjsonLogger } from "../EventNdjsonLogger"

export interface CodexAdapterOptions {
  readonly modelCacheDir?: string
  readonly resolveOrchestratorServer?: import("../../../services/orchestrator/mcp").OrchestratorServerResolver
  readonly resolveCodeSearchServer?: import("../../../services/code-search/contracts").CodeSearchServerResolver
  readonly providerInstanceId: string
  readonly continuationKey: string
  readonly binaryPath: string
  readonly homePath?: string | null
  readonly shadowHomePath?: string | null
  readonly environment?: ReadonlyArray<{
    readonly name: string
    readonly value: string
  }>
  readonly customModels?: ReadonlyArray<string>
  readonly clientInfo: { name: string; title: string; version: string }
  readonly nativeEventLogger?: EventNdjsonLogger | null
  readonly getStoredProviderThreadId: (threadId: string) => string | null
  readonly persistProviderThreadId: (
    threadId: string,
    providerThreadId: string | null
  ) => void
}

interface SessionContext {
  readonly orchestrationConfig: string
  readonly runtime: CodexSessionRuntime
  readonly listener: (e: CodexNativeEvent) => void
  session: ProviderSession
  activeDispatchTurnId: string | null
  closePromise: Promise<void> | null
  closeFailure: unknown
  unexpectedExit: boolean
}

interface StartupCleanupContext {
  readonly runtime: CodexSessionRuntime
  readonly listener: (e: CodexNativeEvent) => void
  readonly startFailure: unknown
  closePromise: Promise<void> | null
  closeFailure: unknown
}

interface ProbeCleanupContext {
  readonly client: CodexRpcClient
  readonly source: string
  closePromise: Promise<void> | null
  closeFailure: unknown
}

interface CodexNativePolicies {
  readonly approvalPolicy: string
  readonly threadSandbox: string
  readonly turnSandboxPolicy: { readonly type: string }
}

interface CodexStartSessionInput {
  readonly threadId: ThreadId
  readonly cwd?: string | null
  readonly modelSelection?: ModelSelection | null
  readonly resumeCursor?: unknown | null
  readonly runtimeMode?: string | null
  readonly model?: string | null
  readonly serviceTier?: CodexServiceTier | null
  readonly permissionLevel?: string | null
  readonly chatMode?: string | null
}

interface CodexProviderStatusProbe {
  readonly configured: boolean
  readonly installed: boolean
  readonly version: string | null
  readonly status: "ready" | "warning" | "error"
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated" | "unknown"
    readonly type?: string
    readonly label?: string
    readonly email?: string
  }
  readonly message?: string
}

const CAPABILITIES: ProviderCapabilities = {
  supportsStreaming: true,
  supportsTools: true,
  supportsApprovals: true,
  supportsResume: true,
  managesOwnLifecycle: true,
}

const REASONING_EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
}

function isCollaborationModeObject(
  value: unknown
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Reserved selector value; never sent to the Codex app-server. */
export const CODEX_CLI_DEFAULT_MODEL_ID = "__codex_cli_default__"

const PROVIDER_METADATA_CACHE_TTL_MS = 30_000
const PROVIDER_MODELS_CACHE_TTL_MS = 15 * 60_000
const MAX_CODEX_MODEL_PAGES = 100

export function nativeCodexModelId(
  modelId: string | null | undefined
): string | null {
  const trimmed = modelId?.trim()
  if (!trimmed || trimmed === CODEX_CLI_DEFAULT_MODEL_ID) return null
  return trimmed
}

/**
 * Known reasoning-effort aliases accepted by the UI. The available values
 * for an individual model still come exclusively from `model/list`.
 *
 * Bug history this function used to carry:
 *   - `xhigh` was silently downgraded to `high` so the UI's "Ultra Think"
 *     toggle never reached the wire. It now passes through.
 *   - `none` was rejected entirely; gpt-5.5 explicitly supports it ("explicit
 *     no-reasoning text paths" per OpenAI's `latest-model.md`).
 *   - Live `model/list` values must not be replaced by slug-based guesses.
 *
 * IMPORTANT: "Fast Mode" is NOT a reasoning effort. It is the orthogonal
 * `serviceTier: "fast"` field on the `turn/start` payload (the official
 * `ClientRequest__ServiceTier` schema allows `"fast" | "flex"`). Don't fold it
 * into this function — handle it via `serviceTier` on `CodexTurnStartParams`.
 */
export type CodexEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"

export function normalizeCodexEffort(
  effort: string | null | undefined
): CodexEffort | undefined {
  if (!effort) return undefined
  const normalized = effort
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  switch (normalized) {
    case "none":
    case "noreasoning":
    case "off":
      return "none"
    case "minimal":
      return "minimal"
    case "low":
    case "review": // Maps to Codex's built-in "Review" collaboration preset.
      return "low"
    case "medium":
    case "plan": // Maps to Codex's built-in "Plan" collaboration preset.
      return "medium"
    case "high":
      return "high"
    case "xhigh":
      return "xhigh"
    case "max":
      return "max"
    case "ultra":
    case "ultrathink":
      return "ultra"
    default:
      return undefined
  }
}

/**
 * Codex `serviceTier` enum from the official schema: `"fast" | "flex"`.
 * Per-model availability comes from `additionalSpeedTiers` in the
 * `model/list` response; BetterC0de only renders the toggle when "fast" is
 * present in that array. We accept the boolean here and let the caller
 * decide whether to populate it (the renderer already passes
 * `fastMode: boolean` on the model selection).
 */
export type CodexServiceTier = "fast" | "flex"

export function normalizeCodexServiceTier(
  fastMode: unknown
): CodexServiceTier | undefined {
  if (fastMode === true) return "fast"
  if (typeof fastMode === "string") {
    const v = fastMode.trim().toLowerCase()
    if (v === "fast" || v === "flex") return v
  }
  return undefined
}

export function serviceTierForModel(
  fastMode: unknown,
  capabilities?: ModelCapabilities | null
): CodexServiceTier | undefined {
  const requested = normalizeCodexServiceTier(fastMode)
  if (!requested || !capabilities) return undefined
  return requested === "fast" &&
    capabilities.optionDescriptors?.some(
      (descriptor) =>
        descriptor.type === "boolean" && descriptor.id === "fastMode"
    )
    ? requested
    : undefined
}

/** Resolve an effort only against the model's live capability descriptor. */
export function effortForModel(
  effort: string | undefined,
  _modelId: string,
  capabilities?: ModelCapabilities | null
): string | undefined {
  if (!effort || !capabilities) return undefined
  const descriptor = capabilities.optionDescriptors?.find(
    (entry) => entry.type === "select" && entry.id === "reasoningEffort"
  )
  if (!descriptor || descriptor.type !== "select") return undefined
  if (descriptor.options.some((option) => option.id === effort)) return effort
  const fallback =
    descriptor.currentValue ??
    descriptor.options.find((option) => option.isDefault)?.id
  return fallback && descriptor.options.some((option) => option.id === fallback)
    ? fallback
    : undefined
}

function providerThreadIdFromResumeCursor(cursor: unknown): string | null {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor))
    return null
  const record = cursor as Record<string, unknown>
  for (const key of ["providerThreadId", "threadId", "resume", "sessionId"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

export class CodexAdapter implements ProviderAdapterShape {
  readonly provider = "codex" as const
  readonly displayName = "Codex"
  readonly capabilities = CAPABILITIES

  private readonly sessions = new Map<string, SessionContext>()
  private readonly startupCleanupQuarantines = new Map<
    string,
    Set<StartupCleanupContext>
  >()
  private readonly probeCleanupQuarantines = new Map<
    CodexRpcClient,
    ProbeCleanupContext
  >()
  private startupInProgress = false
  private readonly bus = new EventEmitter()
  private lastKnownModels: ReadonlyArray<ProviderModel> | null = null
  private lastKnownAccount: string | null = null
  private readonly modelSnapshot: CliModelSnapshot
  private modelsCache: {
    readonly checkedAt: number
    readonly models: ReadonlyArray<ProviderModel>
  } | null = null
  private readonly skillsCache = new Map<
    string,
    {
      readonly checkedAt: number
      readonly skills: ReadonlyArray<ProviderSkill>
    }
  >()
  private statusCache: {
    readonly checkedAt: number
    readonly status: CodexProviderStatusProbe
  } | null = null
  // In-flight dedup: each of these probes spawns a codex app-server
  // child. Concurrent cold-cache callers (several listInstances at app
  // start) must share ONE probe instead of spawning one child each.
  private statusInFlight: Promise<CodexProviderStatusProbe> | null = null
  private modelsInFlight: Promise<ReadonlyArray<ProviderModel>> | null = null
  private readonly skillsInFlight = new Map<
    string,
    Promise<ReadonlyArray<ProviderSkill>>
  >()

  constructor(private readonly options: CodexAdapterOptions) {
    this.modelSnapshot = new CliModelSnapshot(options.modelCacheDir)
  }

  isConfigured(): boolean {
    // The bounded async status probe verifies executable and authentication.
    // Turn admission must stay free of filesystem and credential-store I/O.
    return isBinaryRunnable(this.options.binaryPath)
  }

  async probeStatus(
    input: { readonly cwd?: string | null } = {}
  ): Promise<CodexProviderStatusProbe> {
    if (
      this.statusCache &&
      Date.now() - this.statusCache.checkedAt < PROVIDER_METADATA_CACHE_TTL_MS
    ) {
      return this.statusCache.status
    }
    if (this.statusInFlight) return this.statusInFlight
    const probe = this.probeStatusUncached(input).finally(() => {
      if (this.statusInFlight === probe) this.statusInFlight = null
    })
    this.statusInFlight = probe
    return probe
  }

  private async probeStatusUncached(
    input: { readonly cwd?: string | null } = {}
  ): Promise<CodexProviderStatusProbe> {
    if (!(await isBinaryRunnableAsync(this.options.binaryPath))) {
      return this.cacheStatus({
        configured: false,
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Codex CLI (`codex`) is not installed or not on PATH.",
      })
    }

    const client = new CodexRpcClient({
      binaryPath: this.options.binaryPath,
      cwd: normalizeCwd(input.cwd),
      env: this.makeEnvironment(),
      callTimeoutMs: 8_000,
    })
    return this.withTrackedProbeClient(
      "Codex status probe",
      client,
      async (trackedClient) => {
        try {
          await trackedClient.spawnChild()
          const initialize = await trackedClient.call("initialize", {
            clientInfo: this.options.clientInfo,
            capabilities: { experimentalApi: true },
          })
          trackedClient.notify("initialized", {})
          const version = parseCodexInitializeVersion(initialize)
          const accountResponse = await trackedClient.call(
            "account/read",
            { refreshToken: false },
            8_000
          )
          const accountStatus = codexAccountProbeStatus(accountResponse)
          const status: CodexProviderStatusProbe = {
            configured: accountStatus.status !== "error",
            installed: true,
            version,
            status: accountStatus.status,
            auth: accountStatus.auth,
            ...(accountStatus.message
              ? { message: accountStatus.message }
              : {}),
          }
          return this.cacheStatus(status)
        } catch (error) {
          const installed = !isCommandMissingError(error)
          if (
            installed &&
            (await hasCodexAuthAsync(
              this.authHomePath(),
              this.options.environment
            ))
          ) {
            return this.cacheStatus({
              configured: true,
              installed: true,
              version: null,
              status: "warning",
              auth: { status: "authenticated" },
              message:
                "Codex CLI is authenticated, but the app-server metadata probe failed. " +
                "Provider remains selectable; models and skills will use cached or fallback metadata until the probe succeeds.",
            })
          }
          const status: CodexProviderStatusProbe = {
            configured: false,
            installed,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: isCommandMissingError(error)
              ? "Codex CLI (`codex`) is not installed or not on PATH."
              : "Codex app-server provider probe failed.",
          }
          return this.cacheStatus(status)
        }
      }
    )
  }

  async availableModels(
    input: { readonly force?: boolean } = {}
  ): Promise<ReadonlyArray<ProviderModel>> {
    const account = this.modelAccountIdentity()
    if (this.lastKnownAccount !== account) {
      this.lastKnownAccount = account
      this.lastKnownModels = this.modelSnapshot.read(
        "codex",
        this.options.providerInstanceId,
        account
      )
      this.modelsCache = null
      this.modelsInFlight = null
    }
    const now = Date.now()
    if (
      !input.force &&
      this.modelsCache &&
      now - this.modelsCache.checkedAt < PROVIDER_MODELS_CACHE_TTL_MS
    ) {
      return this.modelsCache.models
    }
    if (this.modelsInFlight && !input.force) return this.modelsInFlight
    const probe = this.availableModelsUncached().finally(() => {
      if (this.modelsInFlight === probe) this.modelsInFlight = null
    })
    this.modelsInFlight = probe
    return probe
  }

  private async availableModelsUncached(): Promise<
    ReadonlyArray<ProviderModel>
  > {
    const now = Date.now()
    const accountAtStart = this.modelAccountIdentity()
    const fallbackModels = mergeCustomModels(
      this.lastKnownModels ?? [],
      this.options.customModels ?? []
    )
    if (!this.isConfigured()) {
      this.modelsCache = { checkedAt: now, models: fallbackModels }
      return this.modelsCache.models
    }
    try {
      const liveModels = await this.fetchModels()
      if (this.modelAccountIdentity() !== accountAtStart)
        return this.modelsForCurrentAccount()
      // Refresh invalidates the TTL cache, not the last successful catalog.
      // A failed probe must not discard models or their reasoning options.
      this.lastKnownModels = liveModels
      this.modelSnapshot.write(
        "codex",
        this.options.providerInstanceId,
        this.modelAccountIdentity(),
        liveModels
      )
      const models = mergeCustomModels(
        liveModels,
        this.options.customModels ?? []
      )
      this.modelsCache = { checkedAt: Date.now(), models }
    } catch {
      if (this.modelAccountIdentity() !== accountAtStart)
        return this.modelsForCurrentAccount()
      this.modelsCache = { checkedAt: Date.now(), models: fallbackModels }
    }
    return this.modelsCache.models
  }

  invalidateMetadata(input: { readonly cwd?: string | null } = {}): void {
    this.modelsCache = null
    if (input.cwd === undefined) {
      this.skillsCache.clear()
      return
    }
    this.skillsCache.delete(normalizeCwd(input.cwd))
  }

  private modelAccountIdentity(): string | null {
    const layout = this.resolveHomeLayout()
    return cliAccountIdentity(
      "codex",
      layout.authHome ?? layout.sharedHome,
      this.statusCache?.status.auth.email
    )
  }

  private modelsForCurrentAccount(): ReadonlyArray<ProviderModel> {
    return mergeCustomModels(
      this.modelSnapshot.read(
        "codex",
        this.options.providerInstanceId,
        this.modelAccountIdentity()
      ) ?? [],
      this.options.customModels ?? []
    )
  }

  async availableSkills(
    input: { readonly cwd?: string | null; readonly force?: boolean } = {}
  ): Promise<ReadonlyArray<ProviderSkill>> {
    if (!this.isConfigured()) return []
    const cwd = normalizeCwd(input.cwd)
    const cached = this.skillsCache.get(cwd)
    if (
      !input.force &&
      cached &&
      Date.now() - cached.checkedAt < PROVIDER_METADATA_CACHE_TTL_MS
    ) {
      return cached.skills
    }
    const inFlight = this.skillsInFlight.get(cwd)
    if (inFlight && !input.force) return inFlight
    const probe = (async () => {
      const skills = await this.fetchSkills(cwd)
      this.skillsCache.set(cwd, { checkedAt: Date.now(), skills })
      return skills
    })().finally(() => {
      if (this.skillsInFlight.get(cwd) === probe) {
        this.skillsInFlight.delete(cwd)
      }
    })
    this.skillsInFlight.set(cwd, probe)
    return probe
  }

  private cacheStatus(
    status: CodexProviderStatusProbe
  ): CodexProviderStatusProbe {
    this.statusCache = { checkedAt: Date.now(), status }
    return status
  }

  hasSession(threadId: ThreadId): boolean {
    const ctx = this.sessions.get(threadId)
    return !!ctx && ctx.runtime.isAlive()
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.bus.on("event", listener)
    return () => {
      this.bus.off("event", listener)
    }
  }

  async startSession(input: CodexStartSessionInput): Promise<ProviderSession> {
    if (this.startupInProgress) {
      throw Object.assign(
        new Error(
          "Another Codex runtime startup or startup cleanup is already in progress."
        ),
        {
          code: "CODEX_STARTUP_IN_PROGRESS",
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
    input: CodexStartSessionInput
  ): Promise<ProviderSession> {
    const key = input.threadId as string
    try {
      await this.closeAllCleanupQuarantines()
    } catch (error) {
      throw Object.assign(
        new Error(
          "Codex startup is globally quarantined because a failed runtime could not be cleaned up.",
          { cause: error }
        ),
        {
          code: "CODEX_STARTUP_CLEANUP_QUARANTINED",
          statusCode: 503,
        }
      )
    }
    const existing = this.sessions.get(key)
    if (existing && existing.runtime.isAlive() && !existing.unexpectedExit) {
      return existing.session
    }
    if (existing) {
      try {
        await this.closeSessionContext(key, existing)
      } catch (error) {
        throw Object.assign(
          new Error(
            `Codex session '${key}' is quarantined because its previous runtime cleanup failed.`,
            { cause: error }
          ),
          {
            code: "CODEX_SESSION_CLEANUP_QUARANTINED",
            statusCode: 503,
          }
        )
      }
    }

    const runtime = new CodexSessionRuntime({
      binaryPath: this.options.binaryPath,
      cwd: input.cwd ?? undefined,
      env: this.makeEnvironment(),
    })
    const listener = (e: CodexNativeEvent) => {
      this.writeNativeEvent(key, e, runtime)
      const currentContext = this.sessions.get(key)
      const dispatchTurnId = currentContext?.activeDispatchTurnId ?? null
      const events = translateCodexEvent(key, e).map((event) =>
        withDispatchTurnId(event, dispatchTurnId)
      )
      for (const ev of events) {
        try {
          this.bus.emit("event", ev)
        } catch (error) {
          // A subscriber's failure is its own to record (the hub settles the
          // turn as failed). Skipping the bookkeeping below would leave
          // `activeDispatchTurnId` set and the runtime's exit untracked.
          logger.error(
            { err: error, thread: key, eventType: ev.type },
            "codex runtime event listener failed"
          )
        }
      }
      if (
        events.some(
          (event) =>
            event.type === "turn.completed" || event.type === "turn.aborted"
        ) &&
        currentContext
      ) {
        currentContext.activeDispatchTurnId = null
      }
      if (
        e.kind === "child-exit" ||
        e.kind === "spawn-error" ||
        e.kind === "child-error"
      ) {
        const current = this.sessions.get(key)
        if (current?.runtime === runtime) {
          current.unexpectedExit = true
          this.trackUnexpectedRuntimeClose(key, current)
        }
      }
    }
    runtime.on("event", listener)

    const stored =
      providerThreadIdFromResumeCursor(input.resumeCursor) ??
      this.options.getStoredProviderThreadId(key)
    const policies = codexNativePoliciesForSession(input)
    const selectedModelId = input.model ?? input.modelSelection?.model ?? null
    const model = nativeCodexModelId(selectedModelId)
    const requestedServiceTier =
      input.serviceTier ??
      normalizeCodexServiceTier(
        getModelSelectionBooleanOptionValue(input.modelSelection, "fastMode")
      )
    const modelCapabilities = requestedServiceTier
      ? this.modelsCache?.models.find(
          (candidate) => candidate.slug === selectedModelId
        )?.capabilities
      : undefined
    const serviceTier = serviceTierForModel(
      requestedServiceTier,
      modelCapabilities
    )
    let orchestratorServer:
      | import("../../../services/orchestrator/mcp").OrchestratorServer
      | null
      | undefined
    let providerThreadId: string | null = null
    let orchestrationConfig: string
    try {
      orchestratorServer = input.cwd
        ? await this.options.resolveOrchestratorServer?.(
            input.cwd,
            input.threadId
          )
        : null
      orchestrationConfig = JSON.stringify(orchestratorServer ?? null)
      await runtime.start({
        codeSearchServer: input.cwd
          ? await this.options.resolveCodeSearchServer?.(input.cwd)
          : null,
        orchestratorServer,
        cwd: input.cwd,
        storedProviderThreadId: stored,
        ...(model ? { model } : {}),
        ...(serviceTier ? { serviceTier } : {}),
        approvalPolicy: policies.approvalPolicy,
        sandbox: policies.threadSandbox,
        clientInfo: this.options.clientInfo,
      })
      providerThreadId = runtime.getProviderThreadId()
      if (providerThreadId !== stored || !stored) {
        this.options.persistProviderThreadId(key, providerThreadId)
      }
    } catch (e) {
      runtime.off("event", listener)
      const cleanupContext: StartupCleanupContext = {
        runtime,
        listener,
        startFailure: e,
        closePromise: null,
        closeFailure: null,
      }
      this.addStartupCleanupQuarantine(key, cleanupContext)
      try {
        await this.closeStartupCleanupContext(key, cleanupContext)
      } catch (cleanupError) {
        throw Object.assign(
          new AggregateError(
            [e, cleanupError],
            `Codex session '${key}' failed to start and its runtime cleanup also failed.`
          ),
          {
            code: "CODEX_STARTUP_CLEANUP_FAILED",
            statusCode: 503,
          }
        )
      }
      throw e
    }

    const now = Date.now()
    const session: ProviderSession = {
      threadId: key,
      providerInstanceId: this.options.providerInstanceId,
      providerThreadId,
      resumeCursor: providerThreadId ? { threadId: providerThreadId } : null,
      continuationKey: this.options.continuationKey,
      status: "ready",
      cwd: input.cwd ?? null,
      activeTurnId: null,
      runtimeMode: input.runtimeMode ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(key, {
      orchestrationConfig,
      runtime,
      listener,
      session,
      activeDispatchTurnId: null,
      closePromise: null,
      closeFailure: null,
      unexpectedExit: false,
    })
    return session
  }

  async listSessions(): Promise<ReadonlyArray<ProviderSession>> {
    const sessions: ProviderSession[] = []
    for (const [threadId, ctx] of this.sessions) {
      if (!ctx.runtime.isAlive()) continue
      const activeTurnId = ctx.runtime.getActiveTurnId()
      sessions.push({
        ...ctx.session,
        threadId,
        activeTurnId,
        status: activeTurnId ? "running" : ctx.session.status,
        updatedAt: Date.now(),
      })
    }
    return sessions
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
    const key = input.threadId
    // Let turn/start rejection propagate to ProviderHub. The hub owns the
    // canonical runtime.error event, admission release and dispatch failure.
    const selectedModelId = resolveTurnModelId(input)
    const modelId = nativeCodexModelId(selectedModelId)
    const reasoningEffort = resolveTurnStringOption(
      input,
      ["reasoningEffort", "effort"],
      input.reasoningEffort
    )
    const fastMode = resolveTurnBooleanOption(input, "fastMode", input.fastMode)
    const requestedEffort =
      normalizeCodexEffort(reasoningEffort) ?? reasoningEffort?.trim()
    const knownModels = this.modelsCache?.models ?? []
    const modelCapabilities = knownModels.find(
      (model) => model.slug === selectedModelId
    )?.capabilities
    const effortForThisModel = effortForModel(
      requestedEffort,
      selectedModelId,
      modelCapabilities
    )
    const serviceTier = serviceTierForModel(fastMode, modelCapabilities)
    let ctx = this.sessions.get(key)
    if (!ctx || !ctx.runtime.isAlive()) {
      await this.startSession({
        threadId: toThreadId(key),
        cwd: input.projectPath,
        model: modelId,
        serviceTier,
        permissionLevel: input.permissionLevel ?? null,
        chatMode: input.chatMode ?? null,
      })
      ctx = this.sessions.get(key)
      if (!ctx) throw new Error("failed to start codex session")
    }
    // Fast Mode (priority compute, OpenAI's `serviceTier: "fast"`).
    // Orthogonal to reasoning effort — user can have effort=high AND
    // serviceTier=fast simultaneously. Keep this mapping aligned with the
    // renderer's model-selection `fastMode` flag.
    const policies = codexNativePoliciesForTurn(
      input.permissionLevel ?? null,
      input.chatMode ?? null
    )
    const collaborationMode = isCollaborationModeObject(input.collaborationMode)
      ? input.collaborationMode
      : buildCodexCollaborationMode({
          chatMode: input.chatMode,
          model: modelId ?? "Codex default",
          effort: effortForThisModel,
        })
    const images = imageAttachments(input.attachments).filter((attachment) => {
      const parsed = parseBase64DataUrl(attachment.url)
      if (parsed) return parsed.mediaType.startsWith("image/")
      return /^https?:\/\//i.test(attachment.url.trim())
    })
    const imageSet = new Set(images)
    const unsupportedAttachments = (input.attachments ?? []).filter(
      (attachment) => !imageSet.has(attachment)
    )
    ctx.activeDispatchTurnId = input.dispatchTurnId ?? null
    try {
      await ctx.runtime.sendTurn({
        ...(modelId ? { model: modelId } : {}),
        message:
          (ctx.runtime.requiresHistorySeed()
            ? buildCodexHistoryPrefix(input.history)
            : "") +
          input.message +
          (buildUnsupportedAttachmentNotice(unsupportedAttachments) ?? ""),
        ...(images.length > 0
          ? { images: images.map((attachment) => ({ url: attachment.url })) }
          : {}),
        effort: effortForThisModel,
        approvalPolicy: policies.approvalPolicy,
        sandboxPolicy: policies.turnSandboxPolicy,
        collaborationMode,
        ...(serviceTier ? { serviceTier } : {}),
      })
    } catch (error) {
      if (ctx.activeDispatchTurnId === input.dispatchTurnId) {
        ctx.activeDispatchTurnId = null
      }
      throw error
    }
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const ctx = this.sessions.get(threadId as string)
    if (!ctx) return
    await ctx.runtime.interruptTurn()
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<void> {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1")
    }
    const ctx = this.sessions.get(threadId as string)
    if (!ctx || !ctx.runtime.isAlive()) return
    await ctx.runtime.rollbackThread(numTurns)
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision
  ): Promise<void> {
    const ctx = this.sessions.get(threadId as string)
    if (!ctx) {
      throw new StalePendingProviderRequestError(
        pendingRequestKindFromDecisionKind(decision.kind),
        requestId
      )
    }
    ctx.runtime.respondToRequest(requestId as string, decision)
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const key = threadId as string
    const ctx = this.sessions.get(key)
    if (!ctx) return
    await this.closeSessionContext(key, ctx)
  }

  async stopAll(): Promise<void> {
    const all = Array.from(this.sessions.keys())
    const results = await Promise.allSettled(
      all.map((key) => this.stopSession(toThreadId(key)))
    )
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    try {
      await this.closeAllCleanupQuarantines()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to stop all Codex sessions")
    }
  }

  private trackUnexpectedRuntimeClose(
    key: string,
    context: SessionContext
  ): void {
    const close = this.closeSessionContext(key, context)
    close.catch(() => {
      // The retained context and closeFailure are the authoritative quarantine
      // record. stopSession/stopAll/a later startSession retry this exact close.
    })
  }

  private async closeSessionContext(
    key: string,
    context: SessionContext
  ): Promise<void> {
    if (context.closePromise) return await context.closePromise
    context.runtime.off("event", context.listener)
    const closePromise = context.runtime.close()
    context.closePromise = closePromise
    try {
      await closePromise
      context.closeFailure = null
      if (this.sessions.get(key) === context) {
        this.sessions.delete(key)
      }
    } catch (error) {
      context.closeFailure = error
      throw error
    } finally {
      if (context.closePromise === closePromise) {
        context.closePromise = null
      }
    }
  }

  private addStartupCleanupQuarantine(
    key: string,
    context: StartupCleanupContext
  ): void {
    let contexts = this.startupCleanupQuarantines.get(key)
    if (!contexts) {
      contexts = new Set()
      this.startupCleanupQuarantines.set(key, contexts)
    }
    contexts.add(context)
  }

  private async closeAllCleanupQuarantines(): Promise<void> {
    const startupContexts = Array.from(
      this.startupCleanupQuarantines.entries()
    ).flatMap(([key, entries]) =>
      Array.from(entries, (context) => ({ key, context }))
    )
    const probeContexts = Array.from(this.probeCleanupQuarantines.values())
    if (startupContexts.length === 0 && probeContexts.length === 0) return
    const results = await Promise.allSettled([
      ...startupContexts.map(({ key, context }) =>
        this.closeStartupCleanupContext(key, context)
      ),
      ...probeContexts.map((context) => this.closeProbeCleanupContext(context)),
    ])
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to clean up quarantined Codex runtimes"
      )
    }
  }

  private async withTrackedProbeClient<T>(
    source: string,
    client: CodexRpcClient,
    operation: (client: CodexRpcClient) => Promise<T>
  ): Promise<T> {
    await this.closeAllCleanupQuarantines()
    let outcome:
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly error: unknown }
    try {
      outcome = { ok: true, value: await operation(client) }
    } catch (error) {
      outcome = { ok: false, error }
    }
    try {
      await this.closeTrackedProbeClient(client, source)
    } catch (cleanupError) {
      if (!outcome.ok) {
        throw new AggregateError(
          [outcome.error, cleanupError],
          `${source} failed and its Codex RPC cleanup also failed.`
        )
      }
      throw cleanupError
    }
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }

  private async closeTrackedProbeClient(
    client: CodexRpcClient,
    source: string
  ): Promise<void> {
    let context = this.probeCleanupQuarantines.get(client)
    if (!context) {
      context = {
        client,
        source,
        closePromise: null,
        closeFailure: null,
      }
      this.probeCleanupQuarantines.set(client, context)
    }
    await this.closeProbeCleanupContext(context)
  }

  private async closeProbeCleanupContext(
    context: ProbeCleanupContext
  ): Promise<void> {
    if (context.closePromise) return await context.closePromise
    const closePromise = context.client.close()
    context.closePromise = closePromise
    try {
      await closePromise
      context.closeFailure = null
      this.probeCleanupQuarantines.delete(context.client)
    } catch (error) {
      context.closeFailure = error
      throw error
    } finally {
      if (context.closePromise === closePromise) {
        context.closePromise = null
      }
    }
  }

  private async closeStartupCleanupContext(
    key: string,
    context: StartupCleanupContext
  ): Promise<void> {
    if (context.closePromise) return await context.closePromise
    context.runtime.off("event", context.listener)
    const closePromise = context.runtime.close()
    context.closePromise = closePromise
    try {
      await closePromise
      context.closeFailure = null
      const contexts = this.startupCleanupQuarantines.get(key)
      contexts?.delete(context)
      if (contexts?.size === 0) {
        this.startupCleanupQuarantines.delete(key)
      }
    } catch (error) {
      context.closeFailure = error
      throw error
    } finally {
      if (context.closePromise === closePromise) {
        context.closePromise = null
      }
    }
  }

  private writeNativeEvent(
    threadId: string,
    native: CodexNativeEvent,
    runtime: CodexSessionRuntime
  ): void {
    const nativeEventLogger = this.options.nativeEventLogger
    if (!nativeEventLogger) return

    const observedAt = new Date().toISOString()
    const providerThreadId = runtime.getProviderThreadId()
    try {
      nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: randomUUID(),
            kind: native.kind,
            provider: "codex",
            providerKind: "codex",
            providerInstanceId: this.options.providerInstanceId,
            threadId,
            createdAt: observedAt,
            method: native.method ?? `codex/${native.kind}`,
            ...(providerThreadId ? { providerThreadId } : {}),
            ...(native.requestId ? { requestId: native.requestId } : {}),
            payload: native,
          },
        },
        threadId
      )
    } catch {
      // Native observability must never interrupt provider delivery.
    }
  }

  private makeEnvironment(): NodeJS.ProcessEnv | undefined {
    const env: NodeJS.ProcessEnv = {}
    for (const item of this.options.environment ?? []) {
      if (!item.name) continue
      env[item.name] = item.value
    }
    const runtimeHome = this.resolveHomeLayout().runtimeHome
    if (runtimeHome) env.CODEX_HOME = runtimeHome
    const childEnv = codexProcessEnvironment(this.options.binaryPath, env)
    return Object.keys(childEnv).length > 0 ? childEnv : undefined
  }

  private authHomePath(): string | null {
    return this.resolveHomeLayout().authHome
  }

  private resolveHomeLayout(): CodexHomeLayout {
    return resolveCodexHomeLayout({
      homePath: this.options.homePath,
      shadowHomePath: this.options.shadowHomePath,
    })
  }

  private async fetchSkills(
    cwd: string
  ): Promise<ReadonlyArray<ProviderSkill>> {
    const client = new CodexRpcClient({
      binaryPath: this.options.binaryPath,
      cwd,
      env: this.makeEnvironment(),
      callTimeoutMs: 8_000,
    })
    return this.withTrackedProbeClient(
      "Codex skills probe",
      client,
      async (trackedClient) => {
        await trackedClient.spawnChild()
        await trackedClient.call("initialize", {
          clientInfo: this.options.clientInfo,
          capabilities: { experimentalApi: true },
        })
        trackedClient.notify("initialized", {})

        const response = await trackedClient.call(
          "skills/list",
          { cwds: [cwd] },
          8_000
        )
        return parseCodexSkillsListResponse(response, cwd)
      }
    )
  }

  private async fetchModels(): Promise<ReadonlyArray<ProviderModel>> {
    const client = new CodexRpcClient({
      binaryPath: this.options.binaryPath,
      cwd: process.cwd(),
      env: this.makeEnvironment(),
      callTimeoutMs: 8_000,
    })
    return this.withTrackedProbeClient(
      "Codex models probe",
      client,
      async (trackedClient) => {
        await trackedClient.spawnChild()
        await trackedClient.call("initialize", {
          clientInfo: this.options.clientInfo,
          capabilities: { experimentalApi: true },
        })
        trackedClient.notify("initialized", {})

        const models: ProviderModel[] = []
        const seenCursors = new Set<string>()
        let pages = 0
        let cursor: string | undefined
        do {
          const response = await trackedClient.call(
            "model/list",
            cursor ? { cursor } : {},
            8_000
          )
          models.push(...parseCodexModelListResponse(response))
          const record = asRecord(response)
          cursor = readTrimmed(record, "nextCursor")
          pages += 1
          if (cursor) {
            if (seenCursors.has(cursor) || pages >= MAX_CODEX_MODEL_PAGES) {
              throw new Error(
                "Codex model pagination exceeded its bounded cursor sequence"
              )
            }
            seenCursors.add(cursor)
          }
        } while (cursor)
        return models
      }
    )
  }
}

function codexNativePoliciesForTurn(
  permissionLevel: string | null | undefined,
  chatMode: string | null | undefined
): CodexNativePolicies {
  if (chatMode === "plan") return codexNativePolicies("read-only")
  if (chatMode === "ask") return codexNativePolicies("read-only")
  if (chatMode === "security") return codexNativePolicies("ask-on-edit")
  return codexNativePolicies(normalizeLevel(permissionLevel))
}

function codexNativePoliciesForSession(input: {
  readonly runtimeMode?: string | null
  readonly permissionLevel?: string | null
  readonly chatMode?: string | null
}): CodexNativePolicies {
  if (input.chatMode) {
    return codexNativePoliciesForTurn(input.permissionLevel, input.chatMode)
  }
  switch ((input.runtimeMode ?? "").trim().toLowerCase()) {
    case "plan":
    case "read-only":
    case "ask":
      return codexNativePolicies("read-only")
    case "security":
    case "approval-required":
      return codexNativePolicies("ask-on-edit")
    case "allow-edits":
    case "auto-accept-edits":
      return codexNativePolicies("allow-edits")
    case "bypass":
    case "full":
    case "full-access":
      return codexNativePolicies("bypass")
    default:
      return codexNativePolicies(normalizeLevel(input.permissionLevel))
  }
}

function codexNativePolicies(level: PermissionLevel): CodexNativePolicies {
  switch (level) {
    case "read-only":
    case "ask-on-edit":
      return {
        approvalPolicy: "untrusted",
        threadSandbox: "read-only",
        turnSandboxPolicy: { type: "readOnly" },
      }
    case "allow-edits":
      return {
        approvalPolicy: "on-request",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: { type: "workspaceWrite" },
      }
    case "bypass":
      return {
        approvalPolicy: "never",
        threadSandbox: "danger-full-access",
        turnSandboxPolicy: { type: "dangerFullAccess" },
      }
  }
}

export function parseCodexModelListResponse(
  response: unknown
): ReadonlyArray<ProviderModel> {
  const data = asArray(asRecord(response).data)
  return data.flatMap((rawModel) => {
    const model = asRecord(rawModel)
    const slug = readTrimmed(model, "model") ?? readTrimmed(model, "slug")
    if (!slug) return []
    return [
      {
        slug,
        name: readTrimmed(model, "displayName") ?? toCodexDisplayName(slug),
        isCustom: false,
        capabilities: mapCodexModelCapabilities(model),
      },
    ]
  })
}

function parseCodexInitializeVersion(response: unknown): string | null {
  const userAgent = readTrimmed(asRecord(response), "userAgent")
  return userAgent?.match(/\/([^\s]+)/)?.[1] ?? null
}

function codexAccountProbeStatus(response: unknown): {
  readonly status: "ready" | "error"
  readonly auth: CodexProviderStatusProbe["auth"]
  readonly message?: string
} {
  const record = asRecord(response)
  const account = asRecord(record.account)
  const hasAccount =
    record.account &&
    typeof record.account === "object" &&
    !Array.isArray(record.account)
  if (hasAccount) {
    const type = readTrimmed(account, "type")
    const label = codexAccountAuthLabel(account)
    const email = codexAccountEmail(account)
    return {
      status: "ready",
      auth: {
        status: "authenticated",
        ...(type ? { type } : {}),
        ...(label ? { label } : {}),
        ...(email ? { email } : {}),
      },
    }
  }

  if (record.requiresOpenaiAuth === true) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message:
        "Codex CLI is not authenticated. Run `codex login` and try again.",
    }
  }

  return { status: "ready", auth: { status: "unknown" } }
}

function codexAccountAuthLabel(
  account: Record<string, unknown>
): string | undefined {
  const type = readTrimmed(account, "type")
  if (type === "apiKey") return "OpenAI API Key"
  if (type === "amazonBedrock") return "Amazon Bedrock"
  if (type !== "chatgpt") return undefined

  switch (readTrimmed(account, "planType")) {
    case "free":
      return "ChatGPT Free Subscription"
    case "go":
      return "ChatGPT Go Subscription"
    case "plus":
      return "ChatGPT Plus Subscription"
    case "pro":
      return "ChatGPT Pro 20x Subscription"
    case "prolite":
      return "ChatGPT Pro 5x Subscription"
    case "team":
      return "ChatGPT Team Subscription"
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription"
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription"
    case "edu":
      return "ChatGPT Edu Subscription"
    case "unknown":
      return "ChatGPT Subscription"
    default:
      return undefined
  }
}

function codexAccountEmail(
  account: Record<string, unknown>
): string | undefined {
  if (readTrimmed(account, "type") !== "chatgpt") return undefined
  return readTrimmed(account, "email")
}

function toCodexDisplayName(value: string): string {
  return value
    .replace(/^gpt/i, "GPT")
    .replace(/-([a-z])/g, (_match, char: string) => `-${char.toUpperCase()}`)
}

function mapCodexModelCapabilities(
  model: Record<string, unknown>
): ModelCapabilities {
  const defaultReasoningEffort = readTrimmed(model, "defaultReasoningEffort")
  const reasoningOptions = asArray(model.supportedReasoningEfforts)
    .flatMap((item) => {
      const record = asRecord(item)
      const effort =
        typeof item === "string"
          ? item.trim()
          : readTrimmed(record, "reasoningEffort")
      if (!effort) return []
      const description = readTrimmed(record, "description")
      return [{ effort, description }]
    })
    .map(({ effort, description }) => ({
      id: effort,
      label: Object.hasOwn(REASONING_EFFORT_LABELS, effort)
        ? REASONING_EFFORT_LABELS[effort]
        : toCodexDisplayName(effort),
      ...(description ? { description } : {}),
      ...(effort === defaultReasoningEffort ? { isDefault: true } : {}),
    }))
  const currentValue = reasoningOptions.find((option) => option.isDefault)?.id
  const additionalSpeedTiers = asArray(model.additionalSpeedTiers).filter(
    (tier): tier is string => typeof tier === "string"
  )
  const optionDescriptors: ProviderOptionDescriptor[] = []
  if (reasoningOptions.length > 0) {
    optionDescriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: reasoningOptions,
      ...(currentValue ? { currentValue } : {}),
    })
  }
  if (additionalSpeedTiers.includes("fast")) {
    optionDescriptors.push({
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    })
  }
  return { attachment: true, optionDescriptors }
}

function normalizeCwd(cwd: string | null | undefined): string {
  const trimmed = cwd?.trim()
  return trimmed ? path.resolve(expandTilde(trimmed)) : process.cwd()
}

function parseCodexSkillsListResponse(
  response: unknown,
  cwd: string
): ReadonlyArray<ProviderSkill> {
  const record = asRecord(response)
  const data = Array.isArray(record.data) ? record.data : []
  const matchingEntry = data.find((entry) => asRecord(entry).cwd === cwd)
  const rawSkills = matchingEntry
    ? asArray(asRecord(matchingEntry).skills)
    : data.flatMap((entry) => asArray(asRecord(entry).skills))

  return rawSkills.flatMap((rawSkill) => {
    const skill = asRecord(rawSkill)
    const name = readTrimmed(skill, "name")
    const skillPath = readTrimmed(skill, "path")
    if (!name || !skillPath) return []
    const interfaceRecord = asRecord(skill.interface)
    const parsedSkill: ProviderSkill = {
      name,
      path: skillPath,
      enabled: readBoolean(skill, "enabled", true),
      ...(readTrimmed(skill, "description")
        ? { description: readTrimmed(skill, "description") }
        : {}),
      ...(readTrimmed(skill, "scope")
        ? { scope: readTrimmed(skill, "scope") }
        : {}),
      ...(readTrimmed(interfaceRecord, "displayName")
        ? { displayName: readTrimmed(interfaceRecord, "displayName") }
        : {}),
      ...(readTrimmed(skill, "shortDescription") ||
      readTrimmed(interfaceRecord, "shortDescription")
        ? {
            shortDescription:
              readTrimmed(skill, "shortDescription") ||
              readTrimmed(interfaceRecord, "shortDescription"),
          }
        : {}),
    }
    return [parsedSkill]
  })
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isCommandMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = (error as { code?: unknown }).code
  const message = errorMessage(error).toLowerCase()
  return code === "ENOENT" || message.includes("enoent")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function expandTilde(value: string): string {
  if (value === "~") return process.env.HOME ?? value
  if (value.startsWith("~/"))
    return path.join(process.env.HOME ?? "~", value.slice(2))
  return value
}

function isBinaryRunnable(binaryPath: string): boolean {
  const trimmed = binaryPath.trim()
  if (!trimmed || trimmed.includes("\0")) return false
  if (
    path.isAbsolute(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    // Existence and executability are established by the async app-server
    // probe. This synchronous predicate performs lexical validation only.
    return true
  }
  // The async metadata/status probe establishes real availability. Avoid
  // spawning a CLI from this synchronous configuration predicate.
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(trimmed)
}

async function isBinaryRunnableAsync(binaryPath: string): Promise<boolean> {
  if (!isBinaryRunnable(binaryPath)) return false
  const trimmed = binaryPath.trim()
  if (
    !path.isAbsolute(trimmed) &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  ) {
    return true
  }
  try {
    await fs.promises.access(
      trimmed,
      process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK
    )
    return true
  } catch {
    return false
  }
}

async function hasCodexAuthAsync(
  homePath: string | null,
  environment: ReadonlyArray<{
    readonly name: string
    readonly value: string
  }> = []
): Promise<boolean> {
  if (
    process.env.OPENAI_API_KEY ||
    environmentValue(environment, "OPENAI_API_KEY")
  ) {
    return true
  }
  if (!homePath) return await isCodexCliAuthenticatedAsync()
  for (const name of ["auth.json", "credentials.json", "config.json"]) {
    try {
      await fs.promises.access(path.join(homePath, name))
      return true
    } catch {
      // Ignore unreadable candidates and continue.
    }
  }
  return false
}

function environmentValue(
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  name: string
): string | undefined {
  return (
    environment.find((item) => item.name === name)?.value.trim() || undefined
  )
}

function mergeCustomModels(
  base: ReadonlyArray<ProviderModel>,
  customModels: ReadonlyArray<string>
): ReadonlyArray<ProviderModel> {
  const seen = new Set(base.map((model) => model.slug))
  const out = [...base]
  for (const raw of customModels) {
    const slug = raw.trim()
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    out.push({
      slug,
      name: slug,
      context: "custom",
      tier: "Custom",
      isCustom: true,
      // Custom slugs have no trustworthy static capability metadata. The CLI
      // chooses defaults unless a future `model/list` response describes it.
      capabilities: null,
    })
  }
  return out
}
