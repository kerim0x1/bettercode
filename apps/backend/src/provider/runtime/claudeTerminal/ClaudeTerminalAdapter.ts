import { asRecord, readNumber, readString } from "@betterc0de/schema"
import { toolNameCategory } from "../tool-name-category"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
  ApprovalRequestId,
  ModelSelection,
  ProviderAdapterShape,
  ProviderApprovalDecision,
  ProviderCapabilities,
  ProviderModel,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSkill,
  ProviderSlashCommand,
  ProviderThreadSnapshot,
  ThreadId,
} from "../contracts"
import { applyClaudePromptEffortPrefix } from "../contracts"
import {
  resolveTurnModelId,
  resolveTurnStringOption,
} from "../providerTurnOptions"
import { buildUnsupportedAttachmentNotice } from "../../attachments"
import {
  detectCliAsync,
  isClaudeCliAuthenticatedAsync,
} from "../../../cli/detect"
import { expandHomePath } from "../../../pathExpansion"
import { sanitizedChildEnvironment } from "../../../security/childEnvironment"
import {
  ClaudeAdapter,
  resolveClaudeRuntimeModelId,
} from "../claude/ClaudeAdapter"
import {
  probeNativePtySupport,
  spawnNativePtyAsync,
  type NativePtyHandle,
} from "./NativePty"
import {
  classifyToolPermission,
  getToolsForMode,
} from "../../shared/chat-mode-tools"
import {
  filterToolsForBetterC0deProjectPolicy,
  type ProjectToolFlag,
} from "../../project-tool-policy"
import type { ProjectPermissionRule } from "../../project-permission-rules"
import {
  listProjectPermissions,
  listProjectTools,
} from "../../../services/workspace"
import { prependProviderHistoryForFreshSession } from "../ProviderHistoryPrompt"
import { withDispatchTurnId } from "../dispatchTurnId"
import {
  evaluateConfiguredAgentToolPermission,
  listConfiguredAgentPermissionGrants,
} from "../../agent-permission-runtime"
import { normalizeAgentPermissionToolName } from "../../agent-permission-policy"

export interface ClaudeTerminalAdapterOptions {
  readonly modelCacheDir?: string
  readonly providerInstanceId?: string
  readonly continuationKey?: string
  readonly binaryPath?: string | null
  readonly homePath?: string | null
  readonly environment?: ReadonlyArray<{
    readonly name: string
    readonly value: string
  }>
  readonly customModels?: ReadonlyArray<string>
  readonly getStoredProviderThreadId?: (threadId: string) => string | null
  readonly persistProviderThreadId?: (
    threadId: string,
    providerThreadId: string | null,
    resumeCursor?: unknown | null
  ) => void
}

interface TerminalTurnAdmission {
  readonly cancellation: AbortController
  readonly prepared: Promise<void>
  readonly finishPreparation: () => void
  readonly done: Promise<void>
  readonly finish: () => void
}

interface SessionContext {
  pendingTurn: TerminalTurnAdmission | null
  interruption: Promise<void> | null
  stopping: boolean
  child: NativePtyHandle | null
  session: ProviderSession
  turns: Array<{ id: string; items: unknown[] }>
  activeTurnId: string | null
  activeDispatchTurnId: string | null
  assistantTextByKey: Map<string, string>
  toolsById: Map<string, ActiveClaudeTerminalTool>
  emittedPlanText: string
}

interface ActiveClaudeTerminalTool {
  id: string
  name: string
  input: Record<string, unknown>
  started: boolean
}

interface ClaudeTerminalResumeCursor {
  sessionId?: string
  turnCount?: number
}

interface ClaudeTerminalStatusProbe {
  readonly configured: boolean
  readonly installed: boolean
  readonly version: string | null
  readonly status: "ready" | "warning" | "error"
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated" | "unknown"
    readonly type?: string
    readonly label?: string
  }
  readonly message?: string
}

const CAPABILITIES: ProviderCapabilities = {
  supportsStreaming: true,
  supportsTools: true,
  supportsApprovals: false,
  supportsResume: true,
  managesOwnLifecycle: true,
}

const CLAUDE_SKILL_FILE_CANDIDATES = [
  "SKILL.md",
  "skill.md",
  "README.md",
  "content.md",
]

export class ClaudeTerminalAdapter implements ProviderAdapterShape {
  readonly provider = "claude" as const
  readonly displayName = "Claude Terminal"
  readonly capabilities = CAPABILITIES
  private readonly sessions = new Map<string, SessionContext>()
  private readonly bus = new EventEmitter()
  private readonly modelCatalog: ClaudeAdapter
  private stoppingAll = false

  constructor(readonly options: ClaudeTerminalAdapterOptions = {}) {
    this.modelCatalog = new ClaudeAdapter({
      modelCacheDir: options.modelCacheDir,
      providerInstanceId: options.providerInstanceId,
      binaryPath: options.binaryPath,
      homePath: options.homePath,
      environment: options.environment,
      customModels: options.customModels,
    })
  }

  isConfigured(): boolean {
    // PTY support, executable discovery, and authentication are all checked by
    // probeStatus. Turn admission must not load modules or touch the filesystem.
    const binaryPath = this.claudeBinaryPath().trim()
    return binaryPath.length > 0 && !binaryPath.includes("\0")
  }

  async probeStatus(
    input: { readonly cwd?: string | null } = {}
  ): Promise<ClaudeTerminalStatusProbe> {
    const [pty, claude] = await Promise.all([
      probeNativePtySupport(),
      detectCliAsync(this.claudeBinaryPath(), {
        isAuthenticated: () =>
          hasClaudeAuthAsync(
            this.claudeConfigDir(),
            this.options.environment ?? []
          ),
        authType: "cli",
      }),
    ])
    const status = { pty, claude }
    const auth = status.claude.authenticated
    const claudeLabel = this.claudeBinaryPath()

    if (!status.pty.available) {
      return {
        configured: false,
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Terminal needs the native node-pty backend dependency. Rebuild or install backend dependencies and try again.",
      }
    }
    if (!status.claude.installed) {
      return {
        configured: false,
        installed: true,
        version: status.claude.version,
        status: "error",
        auth: { status: "unknown" },
        message: `Claude Terminal can open a native PTY, but \`${claudeLabel}\` is not runnable.`,
      }
    }
    if (!auth) {
      return {
        configured: false,
        installed: true,
        version: status.claude.version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          "Claude Terminal found Claude, but no Claude CLI credentials were detected.",
      }
    }
    const cwd = await normalizeCwd(input.cwd)
    return {
      configured: true,
      installed: true,
      version: status.claude.version,
      status: "ready",
      auth: {
        status: "authenticated",
        type: "cli",
        label: "Claude CLI",
      },
      message: `Terminal chat will spawn in ${cwd}.`,
    }
  }

  async availableModels(): Promise<ReadonlyArray<ProviderModel>> {
    return this.modelCatalog.availableModels()
  }

  async availableSkills(): Promise<ReadonlyArray<ProviderSkill>> {
    const skillsDir = path.join(this.claudeConfigDir(), "skills")
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
    } catch {
      return []
    }

    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => readClaudeSkill(skillsDir, entry.name))
    )
    return dedupeProviderSkills(
      skills.filter((skill): skill is ProviderSkill => Boolean(skill))
    )
  }

  async availableSlashCommands(): Promise<ReadonlyArray<ProviderSlashCommand>> {
    return []
  }

  async startSession(input: {
    threadId: ThreadId
    cwd?: string | null
    modelSelection?: ModelSelection | null
    resumeCursor?: unknown | null
    runtimeMode?: string | null
  }): Promise<ProviderSession> {
    if (this.stoppingAll) throw new Error("Claude Terminal is stopping")
    const key = input.threadId as string
    const existing = this.sessions.get(key)
    if (existing?.stopping)
      throw new Error("Claude Terminal session is stopping")
    if (existing) return existing.session

    const now = Date.now()
    const resumeCursor = readResumeCursor(input.resumeCursor)
    const storedProviderThreadId =
      resumeCursor?.sessionId ??
      this.options.getStoredProviderThreadId?.(key) ??
      null
    const providerThreadId =
      storedProviderThreadId && isUuid(storedProviderThreadId)
        ? storedProviderThreadId
        : null
    const session: ProviderSession = {
      threadId: key,
      providerInstanceId: this.options.providerInstanceId ?? null,
      providerThreadId,
      resumeCursor: providerThreadId
        ? makeResumeCursor(providerThreadId, resumeCursor?.turnCount ?? 0)
        : null,
      continuationKey: this.options.continuationKey ?? null,
      runtimeMode: input.runtimeMode ?? null,
      status: "ready",
      cwd: input.cwd ?? null,
      activeTurnId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(key, {
      pendingTurn: null,
      interruption: null,
      stopping: false,
      child: null,
      session,
      turns: [],
      activeTurnId: null,
      activeDispatchTurnId: null,
      assistantTextByKey: new Map(),
      toolsById: new Map(),
      emittedPlanText: "",
    })
    return session
  }

  async listSessions(): Promise<ReadonlyArray<ProviderSession>> {
    return Array.from(this.sessions.values()).map((ctx) => ({
      ...ctx.session,
      activeTurnId: ctx.activeTurnId,
      status: ctx.activeTurnId ? "running" : ctx.session.status,
      updatedAt: Date.now(),
    }))
  }

  async sendTurn(input: ProviderSendTurnInput): Promise<void> {
    const threadId = input.threadId
    let ctx = this.sessions.get(threadId)
    if (!ctx) {
      await this.startSession({
        threadId: threadId as ThreadId,
        cwd: input.projectPath,
      })
      ctx = this.sessions.get(threadId)
    }

    if (!ctx || ctx.stopping || this.stoppingAll) {
      throw new Error("Claude Terminal session is stopping")
    }
    if (ctx.pendingTurn || ctx.child || ctx.interruption) {
      await this.interruptTurn(threadId as ThreadId)
    }
    if (
      this.sessions.get(threadId) !== ctx ||
      ctx.stopping ||
      this.stoppingAll
    ) {
      throw new Error("Claude Terminal session is stopping")
    }
    if (ctx.pendingTurn || ctx.child) {
      throw new Error("Claude Terminal turn is already pending")
    }
    let finishPreparation!: () => void
    let finish!: () => void
    const admission: TerminalTurnAdmission = {
      cancellation: new AbortController(),
      prepared: new Promise<void>((resolve) => {
        finishPreparation = resolve
      }),
      finishPreparation: () => finishPreparation(),
      done: new Promise<void>((resolve) => {
        finish = resolve
      }),
      finish: () => finish(),
    }
    ctx.pendingTurn = admission
    try {
      await this.runTurn(ctx, input, admission)
    } finally {
      admission.finishPreparation()
      if (ctx.pendingTurn === admission) ctx.pendingTurn = null
      if (!admission.cancellation.signal.aborted && !ctx.child) {
        ctx.activeDispatchTurnId = null
        this.setSessionRuntime(ctx, { status: "ready", activeTurnId: null })
      }
      admission.finish()
    }
  }

  private async runTurn(
    ctx: SessionContext,
    input: ProviderSendTurnInput,
    admission: TerminalTurnAdmission
  ): Promise<void> {
    const threadId = input.threadId
    const turnId = randomUUID()
    ctx.activeTurnId = turnId
    ctx.activeDispatchTurnId = input.dispatchTurnId ?? null
    ctx.assistantTextByKey.clear()
    ctx.toolsById.clear()
    ctx.emittedPlanText = ""
    const rawModelId = resolveTurnModelId(input)
    const modelId = resolveClaudeRuntimeModelId(rawModelId)
    const rawEffort = resolveTurnStringOption(
      input,
      ["effort", "reasoningEffort"],
      input.reasoningEffort
    )
    const effort = normalizeTerminalEffort(rawEffort)
    const promptEffort = normalizePromptInjectedEffort(rawEffort)
    const cwd = await normalizeCwd(input.projectPath ?? ctx.session.cwd)
    if (admission.cancellation.signal.aborted) return
    const chatMode = input.chatMode ?? null
    const isPlanMode = chatMode === "plan"
    const projectToolPolicy = await loadBetterC0deProjectToolPolicy(cwd)
    if (admission.cancellation.signal.aborted) return
    const tools = filterToolsForBetterC0deProjectPolicy(
      applyClaudeTerminalPermissionCeiling(
        getToolsForMode(chatMode),
        input.permissionLevel,
        chatMode
      ),
      {
        toolFlags: projectToolPolicy.toolFlags,
        permissionRules: projectToolPolicy.permissionRules,
      }
    )
    const projectPermissionArgs = claudeTerminalPermissionArgs(
      projectToolPolicy.permissionRules,
      new Set(tools)
    )
    const durablePermissionArgs = claudeTerminalDurablePermissionArgs(
      listConfiguredAgentPermissionGrants(threadId),
      new Set(tools)
    )
    const projectPolicyRequiresPermissionGate =
      projectToolPolicy.toolFlags.some((flag) => !flag.enabled) ||
      projectToolPolicy.permissionRules.some(
        (rule) => rule.action === "ask" || rule.action === "deny"
      ) ||
      durablePermissionArgs.requiresPermissionGate
    const providerMessage = applyClaudePromptEffortPrefix(
      input.message +
        (buildUnsupportedAttachmentNotice(input.attachments) ?? ""),
      promptEffort
    )
    const { sessionId, resume } = await resolveTurnSession(
      ctx,
      cwd,
      this.claudeConfigDir()
    )
    if (admission.cancellation.signal.aborted) return
    const prompt = prependProviderHistoryForFreshSession({
      history: input.history,
      currentPrompt: isPlanMode
        ? buildPlanModePrompt(providerMessage)
        : providerMessage,
      resumed: resume,
    })
    this.setSessionRuntime(ctx, {
      providerThreadId: sessionId,
      status: "running",
      cwd,
      activeTurnId: turnId,
    })
    this.persistSession(threadId, ctx)

    this.emitEvent({
      ...eventBase(threadId, this.options.providerInstanceId),
      type: "turn.started",
      turnId,
      payload: {
        model: modelId,
        ...(effort ? { effort } : {}),
        ...(input.dispatchTurnId
          ? { dispatchTurnId: input.dispatchTurnId }
          : {}),
      },
    })

    const sessionPath = claudeSessionFilePath({
      cwd,
      sessionId,
      configDir: this.claudeConfigDir(),
    })
    const startOffset = await fileSizeOrZero(sessionPath)
    if (admission.cancellation.signal.aborted) return
    const args = this.buildClaudeArgs({
      cwd,
      prompt,
      modelId,
      effort,
      sessionId,
      resume,
      tools,
      allowedTools: uniqueSorted(
        [
          ...projectPermissionArgs.allowedTools,
          ...durablePermissionArgs.allowedTools,
        ].filter(
          (spec) =>
            !durablePermissionArgs.gatedToolNames.has(
              normalizeAgentPermissionToolName(toolNameFromSpec(spec))
            )
        )
      ),
      disallowedTools: uniqueSorted([
        ...projectPermissionArgs.disallowedTools,
        ...durablePermissionArgs.disallowedTools,
      ]),
      dangerouslySkipPermissions:
        shouldSkipPermissions(input.permissionLevel, chatMode) &&
        !projectPolicyRequiresPermissionGate,
    })
    const abortTail = new AbortController()
    const stopTail = () => abortTail.abort()
    admission.cancellation.signal.addEventListener("abort", stopTail, {
      once: true,
    })
    let tailError: unknown = null
    const tailPromise = tailClaudeSessionJsonl({
      path: sessionPath,
      startOffset,
      signal: abortTail.signal,
      onRecord: (message) => {
        if (
          admission.cancellation.signal.aborted ||
          ctx.activeTurnId !== turnId
        )
          return
        this.handleClaudeSessionRecord(ctx, {
          threadId,
          turnId,
          message,
          isPlanMode,
        })
      },
    }).catch((error) => {
      tailError = error
    })

    let child: NativePtyHandle | null = null
    let exitConfirmed = false

    try {
      child = await spawnNativePtyAsync({
        command: this.claudeBinaryPath(),
        args,
        cwd,
        env: this.makeEnvironment(),
      })
      ctx.child = child
      admission.finishPreparation()
      const exit = await child.waitForExit()
      exitConfirmed = true
      if (ctx.child === child) ctx.child = null
      await delay(250)
      abortTail.abort()
      await tailPromise
      if (tailError) throw tailError
      if (
        !admission.cancellation.signal.aborted &&
        ctx.activeTurnId === turnId
      ) {
        if (exit.exitCode === 0) {
          if (isPlanMode && ctx.emittedPlanText.trim()) {
            this.emitEvent({
              ...eventBase(threadId, this.options.providerInstanceId),
              type: "turn.proposed.completed",
              turnId,
              payload: {
                planMarkdown: normalizePlanMarkdown(ctx.emittedPlanText),
              },
            })
          }
          this.emitEvent({
            ...eventBase(threadId, this.options.providerInstanceId),
            type: "turn.completed",
            turnId,
            status: "completed",
            payload: {
              state: "completed",
              ...(input.dispatchTurnId
                ? { dispatchTurnId: input.dispatchTurnId }
                : {}),
            },
          })
          ctx.turns.push({
            id: turnId,
            items: [{ type: "user", text: input.message }],
          })
          this.setSessionRuntime(ctx, {
            status: "ready",
            activeTurnId: null,
          })
          this.persistSession(threadId, ctx)
        } else {
          this.emitRuntimeError(threadId, turnId, input.dispatchTurnId)
        }
      }
    } catch {
      abortTail.abort()
      await tailPromise
      if (!admission.cancellation.signal.aborted) {
        this.emitRuntimeError(threadId, turnId, input.dispatchTurnId)
        ctx.activeDispatchTurnId = null
        this.setSessionRuntime(ctx, { status: "error", activeTurnId: null })
      }
    } finally {
      abortTail.abort()
      admission.cancellation.signal.removeEventListener("abort", stopTail)
      await tailPromise
      if (exitConfirmed && child && ctx.child === child) ctx.child = null
    }
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const ctx = this.sessions.get(threadId as string)
    if (!ctx) return
    if (ctx.interruption) return ctx.interruption
    const pending = ctx.pendingTurn
    pending?.cancellation.abort()
    const interruption = this.interruptSession(ctx, pending)
    ctx.interruption = interruption
    try {
      await interruption
    } finally {
      if (ctx.interruption === interruption) ctx.interruption = null
    }
  }

  private async interruptSession(
    ctx: SessionContext,
    pending: TerminalTurnAdmission | null
  ): Promise<void> {
    // Preparation may already be inside the asynchronous native spawn. Retain
    // its session until the returned child is owned and has been terminated.
    if (pending) await pending.prepared
    let failure: unknown
    try {
      if (ctx.child) await this.interruptChild(ctx)
    } catch (error) {
      failure = error
    }
    if (!ctx.child) {
      if (pending) await pending.done
      if (ctx.activeTurnId) {
        this.emitEvent({
          ...eventBase(ctx.session.threadId, this.options.providerInstanceId),
          type: "turn.completed",
          turnId: ctx.activeTurnId,
          status: "interrupted",
          payload: {
            state: "interrupted",
            ...(ctx.activeDispatchTurnId
              ? { dispatchTurnId: ctx.activeDispatchTurnId }
              : {}),
          },
        })
      }
      ctx.activeDispatchTurnId = null
      this.setSessionRuntime(ctx, { status: "ready", activeTurnId: null })
    }
    if (failure !== undefined) throw failure
  }

  private async interruptChild(ctx: SessionContext): Promise<void> {
    const child = ctx.child
    if (!child) return
    const failures: unknown[] = []
    const exitPromise = child.waitForExit()

    try {
      await Promise.resolve(child.kill("SIGTERM"))
    } catch (error) {
      failures.push(error)
    }

    type ExitWaitResult =
      | { readonly status: "exited" }
      | { readonly status: "failed"; readonly error: unknown }
      | { readonly status: "timed_out" }
    const waitForExit = (timeoutMs: number): Promise<ExitWaitResult> =>
      Promise.race([
        exitPromise.then<ExitWaitResult, ExitWaitResult>(
          () => ({ status: "exited" }),
          (error: unknown) => ({ status: "failed", error })
        ),
        delay(timeoutMs).then<ExitWaitResult>(() => ({ status: "timed_out" })),
      ])

    let exit = await waitForExit(500)
    if (exit.status !== "exited") {
      if (exit.status === "failed") failures.push(exit.error)
      try {
        await Promise.resolve(child.kill("SIGKILL"))
      } catch (error) {
        failures.push(error)
      }
      if (exit.status === "timed_out") {
        exit = await waitForExit(2_000)
        if (exit.status === "failed") failures.push(exit.error)
      }
    }

    const exitConfirmed = exit.status === "exited"
    if (!exitConfirmed && exit.status === "timed_out") {
      failures.push(
        new Error(
          `Claude Terminal process tree ${child.pid} did not exit after SIGKILL`
        )
      )
    }

    if (exitConfirmed && ctx.child === child) ctx.child = null

    if (failures.length === 1) {
      throw failures[0]
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Claude Terminal process-tree interruption failed"
      )
    }
  }

  async readThread(threadId: ThreadId): Promise<ProviderThreadSnapshot> {
    const ctx = this.sessions.get(threadId as string)
    return {
      threadId,
      turns: (ctx?.turns ?? []).map((turn) => ({
        id: turn.id as never,
        items: [...turn.items],
      })),
    }
  }

  async respondToRequest(
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision
  ): Promise<void> {
    throw new Error(
      "Claude Terminal does not support BetterC0de approval UI yet."
    )
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const ctx = this.sessions.get(threadId as string)
    if (!ctx) return
    ctx.stopping = true
    await this.interruptTurn(threadId)
    if (this.sessions.get(threadId as string) === ctx) {
      this.sessions.delete(threadId as string)
    }
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId as string)
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.bus.on("event", listener)
    return () => {
      this.bus.off("event", listener)
    }
  }

  async stopAll(): Promise<void> {
    this.stoppingAll = true
    const keys = Array.from(this.sessions.keys())
    const results = await Promise.allSettled(
      keys.map((key) => this.stopSession(key as ThreadId))
    )
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to stop all Claude Terminal sessions"
      )
    }
    this.stoppingAll = false
  }

  private handleClaudeSessionRecord(
    ctx: SessionContext,
    input: {
      readonly threadId: string
      readonly turnId: string
      readonly message: Record<string, unknown>
      readonly isPlanMode: boolean
    }
  ): void {
    const sessionId = readString(input.message, "session_id", "sessionId")
    if (
      sessionId &&
      isUuid(sessionId) &&
      sessionId !== ctx.session.providerThreadId
    ) {
      this.setSessionRuntime(ctx, { providerThreadId: sessionId })
      this.persistSession(input.threadId, ctx)
    }

    for (const event of translateClaudeTerminalMessage({
      providerInstanceId: this.options.providerInstanceId,
      threadId: input.threadId,
      turnId: input.turnId,
      message: input.message,
      isPlanMode: input.isPlanMode,
      ctx,
    })) {
      this.emitEvent(withDispatchTurnId(event, ctx.activeDispatchTurnId))
    }
  }

  private emitRuntimeError(
    threadId: string,
    turnId: string,
    dispatchTurnId?: string | null
  ): void {
    const message = "Claude Terminal provider failed."
    this.emitEvent({
      ...eventBase(threadId, this.options.providerInstanceId),
      type: "runtime.error",
      message,
      class: "provider_error",
    })
    this.emitEvent({
      ...eventBase(threadId, this.options.providerInstanceId),
      type: "turn.completed",
      turnId,
      status: "failed",
      error: message,
      payload: {
        state: "failed",
        errorMessage: message,
        ...(dispatchTurnId ? { dispatchTurnId } : {}),
      },
    })
  }

  private buildClaudeArgs(input: {
    readonly cwd: string
    readonly prompt: string
    readonly modelId: string
    readonly effort?: string
    readonly sessionId: string
    readonly resume: boolean
    readonly tools: readonly string[]
    readonly allowedTools: readonly string[]
    readonly disallowedTools: readonly string[]
    readonly dangerouslySkipPermissions: boolean
  }): string[] {
    const args = ["--name", "BetterC0de Terminal"]
    if (input.resume) {
      args.push("--resume", input.sessionId)
    } else {
      args.push("--session-id", input.sessionId)
    }
    if (input.modelId) args.push("--model", input.modelId)
    if (input.effort) args.push("--effort", input.effort)
    const allowedTools = input.allowedTools.filter(claudeCliToolSpecIsAtomic)
    const disallowedTools = input.disallowedTools.filter(
      claudeCliToolSpecIsAtomic
    )
    // A deny whose pattern contains a comma or an early ")" cannot be passed
    // through the CLI's comma splitter without becoming a different rule.
    // Drop the whole tool instead of shipping a deny the CLI will not enforce.
    const unsayableDenies = new Set(
      input.disallowedTools
        .filter((spec) => !claudeCliToolSpecIsAtomic(spec))
        .map(toolNameFromSpec)
    )
    const tools = input.tools.filter((tool) => !unsayableDenies.has(tool))
    args.push("--tools", tools.join(","))
    if (allowedTools.length > 0) {
      args.push("--allowedTools", allowedTools.join(","))
    }
    if (disallowedTools.length > 0) {
      args.push("--disallowedTools", disallowedTools.join(","))
    }
    if (input.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions")
    }
    args.push(input.prompt)
    return args
  }

  private claudeBinaryPath(): string {
    return (
      this.options.binaryPath?.trim() ||
      process.env.BETTERC0DE_CLAUDE_CODE_PATH?.trim() ||
      "claude"
    )
  }

  private homePath(): string | null {
    return this.options.homePath?.trim() || null
  }

  private claudeConfigDir(): string {
    const home = this.homePath()
    if (home) return claudeConfigDir(home)
    const configured =
      [...(this.options.environment ?? [])]
        .reverse()
        .find((item) => item.name === "CLAUDE_CONFIG_DIR")
        ?.value.trim() ?? process.env.CLAUDE_CONFIG_DIR?.trim()
    return configured
      ? normalizeExactClaudeConfigDir(configured)
      : claudeConfigDir(os.homedir())
  }

  private makeEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = sanitizedChildEnvironment()
    const home = this.homePath()
    if (home) env.HOME = normalizeClaudeHome(home)
    for (const item of this.options.environment ?? []) {
      if (!item.name) continue
      env[item.name] = item.value
    }
    if (
      home ||
      env.CLAUDE_CONFIG_DIR?.trim() ||
      process.env.CLAUDE_CONFIG_DIR?.trim()
    ) {
      env.CLAUDE_CONFIG_DIR = this.claudeConfigDir()
    }
    return env
  }

  private setSessionRuntime(
    ctx: SessionContext,
    patch: Partial<
      Pick<
        ProviderSession,
        "providerThreadId" | "status" | "cwd" | "activeTurnId"
      >
    >
  ): void {
    ctx.session = {
      ...ctx.session,
      ...patch,
      resumeCursor: makeResumeCursor(
        patch.providerThreadId ?? ctx.session.providerThreadId,
        ctx.turns.length
      ),
      updatedAt: Date.now(),
    }
    ctx.activeTurnId = ctx.session.activeTurnId ?? null
  }

  private persistSession(threadId: string, ctx: SessionContext): void {
    this.options.persistProviderThreadId?.(
      threadId,
      ctx.session.providerThreadId,
      ctx.session.resumeCursor
    )
  }

  private emitEvent(event: ProviderRuntimeEvent): void {
    this.bus.emit("event", event)
  }
}

function translateClaudeTerminalMessage(input: {
  readonly providerInstanceId?: string
  readonly threadId: string
  readonly turnId: string
  readonly message: Record<string, unknown>
  readonly isPlanMode: boolean
  readonly ctx: SessionContext
}): ProviderRuntimeEvent[] {
  const messageType = readString(input.message, "type")
  const out: ProviderRuntimeEvent[] = []

  if (messageType === "assistant") {
    const message = asRecord(input.message.message)
    const blocks = Array.isArray(message.content) ? message.content : []
    const assistantKey =
      readString(input.message, "uuid") ??
      readString(message, "id") ??
      `assistant:${input.turnId}`
    for (const blockValue of blocks) {
      const block = asRecord(blockValue)
      const type = readString(block, "type")
      if (type === "text") {
        const text = readString(block, "text") ?? ""
        if (!text) continue
        const previous = input.ctx.assistantTextByKey.get(assistantKey) ?? ""
        const delta = text.startsWith(previous)
          ? text.slice(previous.length)
          : text
        input.ctx.assistantTextByKey.set(assistantKey, text)
        if (!delta) continue
        if (input.isPlanMode) {
          input.ctx.emittedPlanText += delta
          out.push({
            ...eventBase(input.threadId, input.providerInstanceId),
            type: "turn.proposed.delta",
            turnId: input.turnId,
            payload: { delta },
          })
        } else {
          out.push({
            ...eventBase(input.threadId, input.providerInstanceId),
            type: "content.delta",
            streamKind: "assistant_text",
            delta,
            turnId: input.turnId,
          })
        }
        continue
      }
      if (type === "thinking") {
        const text = readString(block, "thinking") ?? ""
        if (text) {
          out.push({
            ...eventBase(input.threadId, input.providerInstanceId),
            type: "reasoning.delta",
            streamKind: "reasoning_text",
            delta: text,
            turnId: input.turnId,
          })
        }
        continue
      }
      if (isClaudeToolBlockType(type)) {
        const toolId = readString(block, "id") ?? randomUUID()
        const toolName = readString(block, "name") ?? "unknown"
        const tool: ActiveClaudeTerminalTool = input.ctx.toolsById.get(
          toolId
        ) ?? {
          id: toolId,
          name: toolName,
          input: asRecord(block.input),
          started: false,
        }
        tool.input = asRecord(block.input)
        input.ctx.toolsById.set(toolId, tool)
        if (!tool.started) {
          tool.started = true
          out.push(
            makeToolStartedEvent(
              input.threadId,
              input.turnId,
              tool,
              input.providerInstanceId
            )
          )
        } else {
          out.push(
            makeToolUpdatedEvent(
              input.threadId,
              input.turnId,
              tool,
              input.providerInstanceId
            )
          )
        }
        const plan = isTodoTool(tool.name)
          ? extractPlanStepsFromTodoInput(tool.input)
          : []
        if (plan.length > 0) {
          out.push({
            ...eventBase(input.threadId, input.providerInstanceId),
            type: "turn.plan.updated",
            turnId: input.turnId,
            payload: { plan },
          })
        }
      }
    }
    return out
  }

  if (messageType === "user") {
    const message = asRecord(input.message.message)
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const blockValue of blocks) {
      const block = asRecord(blockValue)
      if (readString(block, "type") !== "tool_result") continue
      const toolId =
        readString(block, "tool_use_id", "toolUseId") ?? randomUUID()
      const knownTool = input.ctx.toolsById.get(toolId)
      const toolName =
        readString(block, "name", "tool_name", "toolName") ??
        knownTool?.name ??
        "unknown"
      const error = readClaudeToolError(block)
      if (error) {
        const durable = evaluateConfiguredAgentToolPermission({
          threadId: input.threadId,
          toolName,
          toolInput: knownTool?.input,
        })
        if (
          durable &&
          durable.source !== "default" &&
          durable.decision === "deny"
        ) {
          out.push({
            ...eventBase(input.threadId, input.providerInstanceId),
            type: "tool.denied",
            turnId: input.turnId,
            payload: {
              toolUseId: toolId,
              toolName,
              reason: durable.reason,
            },
          })
        }
        out.push({
          ...eventBase(input.threadId, input.providerInstanceId),
          type: "tool.failed",
          toolId,
          toolName,
          turnId: input.turnId,
          error,
          output: readClaudeToolResult(block),
        })
      } else {
        out.push({
          ...eventBase(input.threadId, input.providerInstanceId),
          type: "tool.completed",
          toolId,
          toolName,
          turnId: input.turnId,
          output: readClaudeToolResult(block),
        })
      }
    }
    return out
  }

  if (messageType === "system") {
    const subtype = readString(input.message, "subtype")
    if (subtype === "init") {
      out.push({
        ...eventBase(input.threadId, input.providerInstanceId),
        type: "session.started",
        turnId: input.turnId,
        message: "Claude Terminal session started",
        resume: readString(input.message, "session_id", "sessionId") ?? null,
        payload: {
          resume: readString(input.message, "session_id", "sessionId") ?? null,
        },
      })
    }
    return out
  }

  if (messageType === "result") {
    const resultText = readString(input.message, "result")
    if (resultText && !input.isPlanMode) {
      const assistantKey = `result:${input.turnId}`
      const previous = input.ctx.assistantTextByKey.get(assistantKey) ?? ""
      const delta = resultText.startsWith(previous)
        ? resultText.slice(previous.length)
        : resultText
      input.ctx.assistantTextByKey.set(assistantKey, resultText)
      if (delta) {
        out.push({
          ...eventBase(input.threadId, input.providerInstanceId),
          type: "content.delta",
          streamKind: "assistant_text",
          delta,
          turnId: input.turnId,
        })
      }
    }
    const usage = asRecord(input.message.usage)
    const inputTokens = readNumber(usage, "input_tokens", "inputTokens") ?? 0
    const outputTokens = readNumber(usage, "output_tokens", "outputTokens") ?? 0
    if (inputTokens + outputTokens > 0) {
      out.push({
        ...eventBase(input.threadId, input.providerInstanceId),
        type: "token.usage",
        turnId: input.turnId,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      })
    }
  }
  return out
}

function eventBase(threadId: string, providerInstanceId?: string) {
  return {
    threadId,
    providerKind: "claude" as const,
    ...(providerInstanceId ? { providerInstanceId } : {}),
    eventId: randomUUID(),
    at: Date.now(),
  }
}

function makeToolStartedEvent(
  threadId: string,
  turnId: string,
  tool: ActiveClaudeTerminalTool,
  providerInstanceId?: string
): ProviderRuntimeEvent {
  return {
    ...eventBase(threadId, providerInstanceId),
    type: "tool.started",
    toolId: tool.id,
    toolName: tool.name,
    turnId,
    input: tool.input,
    title: claudeToolTitle(tool.name),
  }
}

function makeToolUpdatedEvent(
  threadId: string,
  turnId: string,
  tool: ActiveClaudeTerminalTool,
  providerInstanceId?: string
): ProviderRuntimeEvent {
  return {
    ...eventBase(threadId, providerInstanceId),
    type: "item.updated",
    itemId: tool.id,
    kind: `tool:${tool.name}`,
    turnId,
    payload: {
      itemType: claudeToolItemType(tool.name),
      status: "inProgress",
      title: claudeToolTitle(tool.name),
      input: tool.input,
      data: {
        toolName: tool.name,
        input: tool.input,
      },
    },
  }
}

async function resolveTurnSession(
  ctx: SessionContext,
  cwd: string,
  configDir: string
): Promise<{ readonly sessionId: string; readonly resume: boolean }> {
  const existing = ctx.session.providerThreadId
  const resume = Boolean(
    existing &&
    isUuid(existing) &&
    (await claudeSessionFileExists({
      cwd,
      sessionId: existing,
      configDir,
    }))
  )
  return {
    sessionId:
      resume && existing
        ? existing
        : existing && isUuid(existing)
          ? existing
          : randomUUID(),
    resume,
  }
}

function readResumeCursor(cursor: unknown): ClaudeTerminalResumeCursor | null {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor))
    return null
  const record = cursor as Record<string, unknown>
  const sessionId =
    typeof record.sessionId === "string"
      ? record.sessionId
      : typeof record.resume === "string"
        ? record.resume
        : undefined
  return {
    ...(sessionId && isUuid(sessionId) ? { sessionId } : {}),
    ...(typeof record.turnCount === "number" &&
    Number.isSafeInteger(record.turnCount) &&
    record.turnCount >= 0
      ? { turnCount: record.turnCount }
      : {}),
  }
}

function makeResumeCursor(
  providerThreadId: string | null | undefined,
  turnCount: number
): ClaudeTerminalResumeCursor | null {
  if (!providerThreadId) return null
  return { sessionId: providerThreadId, turnCount }
}

function normalizeTerminalEffort(
  raw: string | null | undefined
): string | undefined {
  if (!raw) return undefined
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "")
  if (key === "low" || key === "medium" || key === "high") return key
  if (
    key === "xhigh" ||
    key === "extrahigh" ||
    key === "max" ||
    key === "ultra" ||
    key === "ultrathink"
  ) {
    return "max"
  }
  return undefined
}

function normalizePromptInjectedEffort(
  raw: string | null | undefined
): "ultrathink" | undefined {
  if (!raw) return undefined
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "")
  return key === "ultrathink" || key === "ultra" ? "ultrathink" : undefined
}

function shouldSkipPermissions(
  permissionLevel: string | null | undefined,
  chatMode: string | null | undefined
): boolean {
  if (chatMode === "plan" || chatMode === "ask" || chatMode === "security") {
    return false
  }
  return permissionLevel === "bypass" || permissionLevel === "full-access"
}

async function loadBetterC0deProjectToolPolicy(
  cwd: string | undefined
): Promise<{
  readonly toolFlags: readonly ProjectToolFlag[]
  readonly permissionRules: readonly ProjectPermissionRule[]
}> {
  if (!cwd?.trim()) return { toolFlags: [], permissionRules: [] }
  const [toolFlags, permissionRules] = await Promise.all([
    listProjectTools(cwd),
    listProjectPermissions(cwd),
  ])
  return { toolFlags, permissionRules }
}

function claudeTerminalPermissionArgs(
  rules: readonly ProjectPermissionRule[],
  availableTools: ReadonlySet<string>
): {
  readonly allowedTools: readonly string[]
  readonly disallowedTools: readonly string[]
} {
  const allowedTools: string[] = []
  const disallowedTools: string[] = []
  for (const rule of rules) {
    if (rule.action !== "allow" && rule.action !== "deny") continue
    const target = rule.action === "allow" ? allowedTools : disallowedTools
    const specs = claudeTerminalToolSpecs(rule.permission, rule.pattern)
    target.push(
      ...(rule.action === "allow"
        ? specs.filter((spec) => availableTools.has(toolNameFromSpec(spec)))
        : specs)
    )
  }
  return {
    allowedTools: uniqueSorted(allowedTools),
    disallowedTools: uniqueSorted(disallowedTools),
  }
}

function claudeTerminalDurablePermissionArgs(
  grants: ReturnType<typeof listConfiguredAgentPermissionGrants>,
  availableTools: ReadonlySet<string>
): {
  readonly allowedTools: readonly string[]
  readonly disallowedTools: readonly string[]
  readonly requiresPermissionGate: boolean
  readonly gatedToolNames: ReadonlySet<string>
} {
  const allowedTools: string[] = []
  const disallowedTools: string[] = []
  const gatedToolNames = new Set<string>()
  let requiresPermissionGate = false
  for (const grant of grants) {
    const toolNames =
      grant.toolName === "*"
        ? [...availableTools]
        : [...availableTools].filter(
            (toolName) =>
              normalizeAgentPermissionToolName(toolName) === grant.toolName
          )
    if (grant.behavior === "ask" || grant.behavior === "deny") {
      requiresPermissionGate = true
      for (const toolName of toolNames) {
        gatedToolNames.add(normalizeAgentPermissionToolName(toolName))
      }
    }
    if (grant.behavior === "ask") continue
    const specs = toolNames.flatMap((toolName) =>
      grant.pathScope === "."
        ? [toolName]
        : [
            `${toolName}(${grant.pathScope})`,
            `${toolName}(${grant.pathScope}/**)`,
          ]
    )
    if (grant.behavior === "allow") allowedTools.push(...specs)
    else disallowedTools.push(...specs)
  }
  return {
    allowedTools: uniqueSorted(allowedTools),
    disallowedTools: uniqueSorted(disallowedTools),
    requiresPermissionGate,
    gatedToolNames,
  }
}

function toolNameFromSpec(spec: string): string {
  const patternStart = spec.indexOf("(")
  return patternStart < 0 ? spec : spec.slice(0, patternStart)
}

/**
 * Claude's CLI splits `--allowedTools` and `--disallowedTools` on commas.
 * A pattern may be `Tool(pattern)` with one closing paren at the end, and
 * nothing inside it may introduce another rule.
 */
function claudeCliToolSpecIsAtomic(spec: string): boolean {
  if (spec.includes(",")) return false
  const open = spec.indexOf("(")
  if (open < 0) return spec.length > 0 && !spec.includes(")")
  if (spec.lastIndexOf("(") !== open || !spec.endsWith(")")) return false
  const name = spec.slice(0, open)
  const pattern = spec.slice(open + 1, -1)
  return name.length > 0 && !name.includes(")") && !pattern.includes(")")
}

function applyClaudeTerminalPermissionCeiling(
  tools: readonly string[],
  permissionLevel: string | null | undefined,
  chatMode: string | null | undefined
): string[] {
  const level = permissionLevel?.trim().toLowerCase()
  if (
    chatMode === "plan" ||
    chatMode === "ask" ||
    chatMode === "security" ||
    level === "read-only" ||
    level === "ask-on-edit" ||
    !level
  ) {
    return tools.filter((tool) => classifyToolPermission(tool) === "read")
  }
  if (level === "allow-edits" || level === "auto-accept-edits") {
    return tools.filter((tool) => {
      const permission = claudeTerminalToolNamesForPermission("edit")
      return (
        classifyToolPermission(tool) === "read" || permission.includes(tool)
      )
    })
  }
  if (level === "bypass" || level === "full-access") return [...tools]
  return tools.filter((tool) => classifyToolPermission(tool) === "read")
}

function claudeTerminalToolSpecs(
  permission: string,
  pattern: string
): string[] {
  return claudeTerminalToolNamesForPermission(permission).map((toolName) =>
    pattern === "*" ? toolName : `${toolName}(${pattern})`
  )
}

function claudeTerminalToolNamesForPermission(permission: string): string[] {
  const key = permission
    .trim()
    .toLowerCase()
    .replace(/[\s_.-]+/g, "")
  switch (key) {
    case "bash":
      return ["Bash"]
    case "edit":
      return ["Edit", "Write", "NotebookEdit"]
    case "read":
      return ["Read"]
    case "glob":
      return ["Glob"]
    case "grep":
      return ["Grep"]
    case "list":
      return ["LS"]
    case "webfetch":
      return ["WebFetch"]
    case "websearch":
      return ["WebSearch"]
    case "task":
      return ["Agent", "Task"]
    case "todowrite":
      return ["TodoWrite"]
    case "question":
      return ["AskUserQuestion"]
    case "planexit":
      return ["ExitPlanMode"]
    default:
      return [permission]
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" })
  )
}

function buildPlanModePrompt(message: string): string {
  return [
    "<betterc0de_plan_mode_request>",
    "The BetterC0de Plan toggle is active for this turn.",
    "",
    "Hard requirements:",
    "- Do not implement the request.",
    "- Do not create, edit, delete, move, or write files.",
    "- Do not output implementation code blocks as the answer.",
    "- Return only an actionable implementation plan.",
    "- Prefer wrapping the plan in <proposed_plan>...</proposed_plan>.",
    "",
    "User request:",
    message,
    "</betterc0de_plan_mode_request>",
  ].join("\n")
}

function extractProposedPlanBlock(text: string): string | null {
  const match = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i)
  return match?.[1]?.trim() || null
}

function normalizePlanMarkdown(text: string): string {
  return extractProposedPlanBlock(text) ?? text.trim()
}

async function normalizeCwd(cwd: string | null | undefined): Promise<string> {
  const trimmed = cwd?.trim()
  const resolved = trimmed
    ? path.resolve(expandHomePath(trimmed))
    : process.cwd()
  try {
    return await fs.promises.realpath(resolved)
  } catch {
    return resolved
  }
}

async function claudeSessionFileExists(input: {
  readonly cwd: string
  readonly sessionId: string
  readonly configDir: string
}): Promise<boolean> {
  try {
    await fs.promises.access(claudeSessionFilePath(input), fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

function claudeSessionFilePath(input: {
  readonly cwd: string
  readonly sessionId: string
  readonly configDir: string
}): string {
  if (!isUuid(input.sessionId))
    throw new Error("Invalid Claude Terminal session ID")
  const projectDir = path.join(
    input.configDir,
    "projects",
    path.resolve(input.cwd).replace(/[/.]/g, "-")
  )
  return path.resolve(projectDir, `${input.sessionId}.jsonl`)
}

async function fileSizeOrZero(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).size
  } catch {
    return 0
  }
}

async function tailClaudeSessionJsonl(input: {
  readonly path: string
  readonly startOffset: number
  readonly signal: AbortSignal
  readonly onRecord: (record: Record<string, unknown>) => void
}): Promise<void> {
  let offset = input.startOffset
  let buffer = ""
  while (!input.signal.aborted) {
    const size = await fileSizeOrNull(input.path)
    if (size === null || size <= offset) {
      await delayWithSignal(50, input.signal)
      continue
    }

    buffer += await readUtf8Range(input.path, offset, size)
    offset = size

    let newlineIndex = buffer.indexOf("\n")
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      const trimmed = line.trim()
      if (trimmed) {
        const parsed = JSON.parse(trimmed) as unknown
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          input.onRecord(parsed as Record<string, unknown>)
        }
      }
      newlineIndex = buffer.indexOf("\n")
    }
  }
}

async function fileSizeOrNull(filePath: string): Promise<number | null> {
  try {
    return (await fs.promises.stat(filePath)).size
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null
    throw error
  }
}

async function readUtf8Range(
  filePath: string,
  start: number,
  endExclusive: number
): Promise<string> {
  const chunks: string[] = []
  const stream = fs.createReadStream(filePath, {
    encoding: "utf8",
    start,
    end: endExclusive - 1,
  })
  for await (const chunk of stream) chunks.push(String(chunk))
  return chunks.join("")
}

export async function delayWithSignal(
  ms: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    const onAbort = () => finish()
    const timeout = setTimeout(finish, ms)
    timeout.unref()
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    timeout.unref()
  })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error
}

function readClaudeToolResult(block: Record<string, unknown>): unknown {
  const content = block.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") return entry
        const text = asRecord(entry).text
        return typeof text === "string" ? text : ""
      })
      .filter(Boolean)
      .join("\n")
  }
  return block
}

function readClaudeToolError(block: Record<string, unknown>): string | null {
  if (block.is_error === true || block.isError === true) {
    const result = readClaudeToolResult(block)
    return typeof result === "string" && result ? result : "Tool failed"
  }
  const error = block.error
  if (typeof error === "string" && error) return error
  const message = asRecord(error).message
  return typeof message === "string" && message ? message : null
}

function isClaudeToolBlockType(type: string | undefined): boolean {
  return (
    type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use"
  )
}

function claudeToolItemType(toolName: string): string {
  return toolNameCategory(toolName, "claude-terminal")
}

function claudeToolTitle(toolName: string): string {
  switch (claudeToolItemType(toolName)) {
    case "collab_agent_tool_call":
      return "Subagent task"
    case "command_execution":
      return "Terminal command"
    case "file_change":
      return "File change"
    case "mcp_tool_call":
      return "MCP tool call"
    case "web_search":
      return "Search"
    default:
      return "Tool call"
  }
}

function isTodoTool(toolName: string | undefined): boolean {
  return (toolName ?? "").toLowerCase() === "todowrite"
}

function extractPlanStepsFromTodoInput(
  input: unknown
): Array<{ step: string; status: string }> {
  const todos = asRecord(input).todos
  if (!Array.isArray(todos)) return []
  return todos
    .map((todo) => {
      const record = asRecord(todo)
      const step =
        readString(record, "content", "text", "task") ??
        readString(record, "description")
      if (!step) return null
      const status = readString(record, "status") ?? "pending"
      return {
        step,
        status:
          status === "in_progress" || status === "inProgress"
            ? "in_progress"
            : status === "completed"
              ? "completed"
              : "pending",
      }
    })
    .filter(
      (entry): entry is { step: string; status: string } => entry !== null
    )
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  )
}

async function readClaudeSkill(
  skillsDir: string,
  directoryName: string
): Promise<ProviderSkill | null> {
  const skillDir = path.join(skillsDir, directoryName)
  let skillPath: string | null = null
  let content = ""
  for (const fileName of CLAUDE_SKILL_FILE_CANDIDATES) {
    const candidate = path.join(skillDir, fileName)
    try {
      const stat = await fs.promises.stat(candidate)
      if (!stat.isFile()) continue
      content = await fs.promises.readFile(candidate, "utf8")
      skillPath = candidate
      break
    } catch {
      // Try next candidate.
    }
  }
  if (!skillPath) return null
  const metadata = parseSkillMarkdownMetadata(content)
  const displayName =
    metadata.displayName ?? metadata.name ?? titleizeSkillName(directoryName)
  const description = metadata.description ?? firstMarkdownParagraph(content)
  return {
    name: directoryName,
    path: skillPath,
    enabled: true,
    scope: "user",
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(metadata.shortDescription
      ? { shortDescription: metadata.shortDescription }
      : {}),
  }
}

function parseSkillMarkdownMetadata(content: string): {
  name?: string
  displayName?: string
  description?: string
  shortDescription?: string
} {
  const match = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const metadata: {
    name?: string
    displayName?: string
    description?: string
    shortDescription?: string
  } = {}
  for (const line of match[1]?.split(/\r?\n/) ?? []) {
    const entry = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/)
    if (!entry) continue
    const key = entry[1]?.toLowerCase().replace(/[-_]/g, "")
    const value = stripYamlScalar(entry[2] ?? "")
    if (!value) continue
    if (key === "name") metadata.name = value
    else if (key === "displayname" || key === "title")
      metadata.displayName = value
    else if (key === "description") metadata.description = value
    else if (key === "shortdescription" || key === "summary") {
      metadata.shortDescription = value
    }
  }
  return metadata
}

function stripYamlScalar(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim() || undefined
  }
  return trimmed.replace(/\s+#.*$/, "").trim() || undefined
}

function firstMarkdownParagraph(content: string): string | undefined {
  const withoutFrontmatter = content.replace(/^\s*---\r?\n[\s\S]*?\r?\n---/, "")
  for (const line of withoutFrontmatter.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (
      !trimmed ||
      trimmed.startsWith("#") ||
      trimmed.startsWith(">") ||
      trimmed.startsWith("```") ||
      trimmed === "---"
    ) {
      continue
    }
    return trimmed.slice(0, 240)
  }
  return undefined
}

function titleizeSkillName(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function dedupeProviderSkills(
  skills: ReadonlyArray<ProviderSkill>
): ReadonlyArray<ProviderSkill> {
  const byName = new Map<string, ProviderSkill>()
  for (const skill of skills) {
    const name = skill.name.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (!byName.has(key)) byName.set(key, { ...skill, name })
  }
  return [...byName.values()]
}

function claudeConfigDir(homePath: string): string {
  const normalized = path.normalize(path.resolve(expandHomePath(homePath)))
  return path.basename(normalized) === ".claude"
    ? normalized
    : path.join(normalized, ".claude")
}

function normalizeExactClaudeConfigDir(configDir: string): string {
  return path.normalize(path.resolve(expandHomePath(configDir)))
}

function normalizeClaudeHome(homePath: string): string {
  const normalized = path.normalize(path.resolve(expandHomePath(homePath)))
  return path.basename(normalized) === ".claude"
    ? path.dirname(normalized)
    : normalized
}

async function hasClaudeAuthAsync(
  configDir: string,
  environment: ReadonlyArray<{
    readonly name: string
    readonly value: string
  }> = []
): Promise<boolean> {
  const hasEnvironmentAuth = Boolean(
    process.env.ANTHROPIC_API_KEY?.trim() ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
    environment
      .find(
        (item) =>
          item.name === "ANTHROPIC_API_KEY" ||
          item.name === "CLAUDE_CODE_OAUTH_TOKEN"
      )
      ?.value.trim()
  )
  for (const name of ["credentials.json", "auth.json", ".credentials.json"]) {
    try {
      await fs.promises.access(path.join(configDir, name))
      return true
    } catch {
      // Try the next candidate.
    }
  }
  if (hasEnvironmentAuth) return true
  return configDir === claudeConfigDir(os.homedir())
    ? await isClaudeCliAuthenticatedAsync()
    : false
}
