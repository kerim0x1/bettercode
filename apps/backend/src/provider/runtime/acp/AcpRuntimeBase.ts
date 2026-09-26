import { asRecord, readString, readTrimmed } from "@betterc0de/schema"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import {
  findCursorModelConfigOption,
  resolveCursorAcpAdvertisedModelId as resolveAcpAdvertisedModelId,
  type CursorAcpSessionConfigOption as AcpSessionConfigOption,
} from "../cursor/CursorAcpSupport"
import {
  ACP_PROMPT_IDLE_TIMEOUT_MS,
  AcpJsonRpcClient,
} from "../cursor/AcpJsonRpcClient"
import type { AcpMcpServer } from "../cursor/AcpMcpServers"

/**
 * Provider-neutral Agent Client Protocol runtime: one JSON-RPC child that
 * speaks `initialize` → (`authenticate`) → `session/new|load` → `session/prompt`
 * and folds `session/update` notifications into typed events.
 *
 * Everything a concrete CLI does differently on the wire is declared in an
 * {@link AcpRuntimeProfile} and nowhere else — this file must stay free of
 * per-vendor knowledge (a structure test enforces that).
 */

export type { AcpSessionConfigOption }

export interface AcpRuntimeSettings {
  readonly binaryPath?: string | null
}

export interface AcpSpawnInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * How a runtime obtains an authenticated session.
 *
 * - `eager`: one unconditional `authenticate { methodId }` round-trip right
 *   after `initialize`, before any session call.
 * - `lazy`: sessions are requested directly; only when the agent answers with
 *   an auth error does the runtime call `authenticate` with the first method
 *   the agent advertised during `initialize`, then retry once. A still-failing
 *   auth is surfaced through `toAuthError` so the user gets a login hint
 *   instead of a raw JSON-RPC code.
 */
export type AcpAuthStrategy =
  | { readonly strategy: "eager"; readonly methodId: string }
  | {
      readonly strategy: "lazy"
      readonly toAuthError: (cause: unknown) => Error
    }

export interface AcpRuntimeProfile<
  TSettings extends AcpRuntimeSettings = AcpRuntimeSettings,
> {
  /** Human name used in runtime error messages ("<label> ACP …"). */
  readonly label: string
  readonly buildSpawnInput: (
    settings: TSettings,
    cwd: string,
    env?: NodeJS.ProcessEnv
  ) => AcpSpawnInput
  /** Sent verbatim as `clientCapabilities` in `initialize`. */
  readonly clientCapabilities: Record<string, unknown>
  readonly auth: AcpAuthStrategy
}

export interface AcpMode {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface AcpModeState {
  readonly currentModeId: string
  readonly availableModes: ReadonlyArray<AcpMode>
}

export interface AcpStarted {
  readonly sessionId: string
  /**
   * True only when `session/load` succeeded for the requested resume id. A
   * fallback to `session/new` starts an empty agent session, so the adapter
   * must seed history into the first prompt exactly as for a fresh session.
   */
  readonly resumed: boolean
  readonly initializeResult: Record<string, unknown>
  readonly sessionSetupResult: AcpSessionSetupResult
  readonly modeState?: AcpModeState
  readonly configOptions: ReadonlyArray<AcpSessionConfigOption>
  readonly modelConfigId?: string
}

export interface AcpSessionSetupResult {
  readonly sessionId?: string
  readonly modes?: {
    readonly currentModeId?: string
    readonly availableModes?: ReadonlyArray<{
      readonly id?: string
      readonly name?: string
      readonly description?: string
    }>
  }
  /**
   * Some agents advertise their models through this typed field, NOT through
   * a `category: "model"` config option — which is why probing `configOptions`
   * alone can find nothing and leave the picker on a compiled-in list.
   */
  readonly models?: {
    readonly currentModelId?: string
    readonly availableModels?: ReadonlyArray<{
      readonly modelId?: string
      readonly name?: string
      readonly description?: string
      readonly _meta?: Record<string, unknown>
    }>
  }
  readonly configOptions?: ReadonlyArray<AcpSessionConfigOption>
}

export interface AcpToolCallState {
  readonly toolCallId: string
  readonly kind?: string
  readonly title?: string
  readonly status?: "pending" | "inProgress" | "completed" | "failed"
  readonly command?: string
  readonly detail?: string
  readonly data: Record<string, unknown>
}

export interface AcpPlanUpdate {
  readonly explanation?: string | null
  readonly plan: ReadonlyArray<{
    readonly step: string
    readonly status: "pending" | "inProgress" | "completed"
  }>
}

export interface AcpPermissionRequest {
  readonly kind: string | "unknown"
  readonly detail?: string
  readonly toolCall?: AcpToolCallState
  readonly raw: unknown
}

export interface AcpExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export type AcpEvent =
  | {
      readonly type: "mode.changed"
      readonly modeId: string
      readonly raw: unknown
    }
  | { readonly type: "assistant.started"; readonly itemId: string }
  | { readonly type: "assistant.completed"; readonly itemId: string }
  | {
      readonly type: "plan.updated"
      readonly payload: AcpPlanUpdate
      readonly raw: unknown
    }
  | {
      readonly type: "tool.updated"
      readonly toolCall: AcpToolCallState
      readonly raw: unknown
    }
  | {
      readonly type: "content.delta"
      readonly itemId?: string
      readonly text: string
      readonly raw: unknown
    }
  | {
      readonly type: "reasoning.delta"
      readonly text: string
      readonly raw: unknown
    }

export interface AcpRuntime {
  start(): Promise<AcpStarted>
  getConfigOptions(): ReadonlyArray<AcpSessionConfigOption>
  getModeState(): AcpModeState | undefined
  setConfigOption(
    configId: string,
    value: string | boolean
  ): Promise<AcpSessionSetupResult>
  setModel(model: string): Promise<void>
  setMode(modeId: string): Promise<void>
  prompt(input: {
    prompt: ReadonlyArray<Record<string, unknown>>
  }): Promise<Record<string, unknown>>
  cancel(): Promise<void>
  close(): Promise<void>
  onEvent(listener: (event: AcpEvent) => void): () => void
  onExit?(listener: (event: AcpExit) => void): () => void
  onPermissionRequest(
    handler: (request: AcpPermissionRequest) => Promise<unknown>
  ): void
  onExtRequest(
    method: string,
    handler: (params: unknown) => Promise<unknown>
  ): void
  onExtNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>
  ): void
}

export interface AcpRuntimeOptions<
  TSettings extends AcpRuntimeSettings = AcpRuntimeSettings,
> {
  readonly settings: TSettings
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  readonly resumeSessionId?: string | null
  readonly mcpServers?: ReadonlyArray<AcpMcpServer>
  readonly clientInfo: {
    readonly name: string
    readonly title?: string
    readonly version: string
  }
  readonly protocolLogger?: (event: {
    readonly direction: "incoming" | "outgoing"
    readonly payload: unknown
  }) => void
}

export function createAcpRuntime<TSettings extends AcpRuntimeSettings>(
  profile: AcpRuntimeProfile<TSettings>,
  options: AcpRuntimeOptions<TSettings>
): AcpRuntime {
  return new AcpRuntimeImpl(profile, options)
}

interface EstablishedSession {
  readonly sessionId: string
  readonly sessionSetupResult: AcpSessionSetupResult
  readonly resumed: boolean
}

export class AcpRuntimeImpl<
  TSettings extends AcpRuntimeSettings,
> implements AcpRuntime {
  private readonly bus = new EventEmitter()
  private readonly extRequestHandlers = new Map<
    string,
    (params: unknown) => Promise<unknown>
  >()
  private readonly extNotificationHandlers = new Map<
    string,
    (params: unknown) => void | Promise<void>
  >()
  private permissionHandler:
    | ((request: AcpPermissionRequest) => Promise<unknown>)
    | null = null
  private client: AcpJsonRpcClient | null = null
  private started: AcpStarted | null = null
  private closePromise: Promise<void> | null = null
  private configOptions: ReadonlyArray<AcpSessionConfigOption> = []
  private modeState: AcpModeState | undefined
  private activeAssistantItemId: string | null = null
  private nextAssistantSegment = 0
  private readonly toolCalls = new Map<string, AcpToolCallState>()

  constructor(
    private readonly profile: AcpRuntimeProfile<TSettings>,
    private readonly options: AcpRuntimeOptions<TSettings>
  ) {}

  onEvent(listener: (event: AcpEvent) => void): () => void {
    this.bus.on("event", listener)
    return () => this.bus.off("event", listener)
  }

  onExit(listener: (event: AcpExit) => void): () => void {
    this.bus.on("exit", listener)
    return () => this.bus.off("exit", listener)
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

  onExtNotification(
    method: string,
    handler: (params: unknown) => void | Promise<void>
  ): void {
    this.extNotificationHandlers.set(method, handler)
  }

  async start(): Promise<AcpStarted> {
    if (this.started) return this.started
    const spawnInput = this.profile.buildSpawnInput(
      this.options.settings,
      this.options.cwd,
      this.options.env
    )
    const client = new AcpJsonRpcClient({
      command: spawnInput.command,
      args: spawnInput.args,
      cwd: spawnInput.cwd,
      env: spawnInput.env,
      protocolLogger: this.options.protocolLogger,
    })
    this.client = client
    client.once("exit", (event: AcpExit) => {
      if (this.client !== client) return
      const wasStarted = this.started !== null
      this.resetRuntimeState()
      if (wasStarted) this.bus.emit("exit", event)
    })
    try {
      client.onNotification("*", (method, params) => {
        if (method === "session/update") {
          this.handleSessionUpdate(params)
          return
        }
        const handler = this.extNotificationHandlers.get(method)
        if (handler) void Promise.resolve(handler(params)).catch(() => {})
      })
      client.setServerRequestHandler(
        (method, params, respond, respondError) => {
          void this.handleServerRequest(method, params)
            .then(respond)
            .catch((error) =>
              respondError(
                -32000,
                error instanceof Error ? error.message : String(error)
              )
            )
        }
      )
      await client.spawnChild()

      const initializePayload = {
        protocolVersion: 1,
        clientCapabilities: this.profile.clientCapabilities,
        clientInfo: this.options.clientInfo,
      }
      const initializeResult = await client.call<Record<string, unknown>>(
        "initialize",
        initializePayload
      )

      const { sessionId, sessionSetupResult, resumed } =
        this.profile.auth.strategy === "eager"
          ? await this.establishSessionEagerAuth(
              client,
              this.profile.auth.methodId
            )
          : await this.establishSessionLazyAuth(
              client,
              initializeResult,
              this.profile.auth.toAuthError
            )

      this.updateSessionSetup(sessionSetupResult)
      this.started = {
        sessionId,
        resumed,
        initializeResult,
        sessionSetupResult,
        ...(this.modeState ? { modeState: this.modeState } : {}),
        configOptions: this.configOptions,
        ...(extractModelConfigId(sessionSetupResult)
          ? { modelConfigId: extractModelConfigId(sessionSetupResult) }
          : {}),
      }
      return this.started
    } catch (error) {
      this.resetRuntimeState()
      try {
        await client.close()
        if (this.client === client) this.client = null
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${this.profile.label} ACP startup failed and its client cleanup also failed.`
        )
      }
      throw error
    }
  }

  /**
   * `eager` auth: an unconditional `authenticate` round-trip, then the
   * session. A failed `session/load` falls back to `session/new` regardless
   * of why it failed.
   */
  private async establishSessionEagerAuth(
    client: AcpJsonRpcClient,
    methodId: string
  ): Promise<EstablishedSession> {
    await client.call("authenticate", { methodId })

    let sessionId: string
    let sessionSetupResult: AcpSessionSetupResult
    let resumed = false
    const mcpServers = this.options.mcpServers ?? []
    if (this.options.resumeSessionId) {
      try {
        sessionSetupResult = await client.call<AcpSessionSetupResult>(
          "session/load",
          {
            sessionId: this.options.resumeSessionId,
            cwd: this.options.cwd,
            mcpServers,
          }
        )
        sessionId = this.options.resumeSessionId
        resumed = true
      } catch {
        sessionSetupResult = await client.call<AcpSessionSetupResult>(
          "session/new",
          { cwd: this.options.cwd, mcpServers }
        )
        sessionId =
          typeof sessionSetupResult.sessionId === "string" &&
          sessionSetupResult.sessionId.trim()
            ? sessionSetupResult.sessionId
            : randomUUID()
      }
    } else {
      sessionSetupResult = await client.call<AcpSessionSetupResult>(
        "session/new",
        { cwd: this.options.cwd, mcpServers }
      )
      sessionId =
        typeof sessionSetupResult.sessionId === "string" &&
        sessionSetupResult.sessionId.trim()
          ? sessionSetupResult.sessionId
          : randomUUID()
    }
    return { sessionId, sessionSetupResult, resumed }
  }

  /**
   * `lazy` auth: a logged-in agent serves sessions directly. We only fall
   * back to `authenticate` when session setup reports an auth error, using
   * the first method the agent advertised during `initialize`. An auth error
   * that survives that one retry is NOT papered over by `session/new` — it is
   * surfaced as the profile's auth error so the user sees a login hint.
   */
  private async establishSessionLazyAuth(
    client: AcpJsonRpcClient,
    initializeResult: Record<string, unknown>,
    toAuthError: (cause: unknown) => Error
  ): Promise<EstablishedSession> {
    let authAttempted = false
    const callWithAuthRetry = async <T>(
      method: string,
      params: Record<string, unknown>
    ): Promise<T> => {
      try {
        return await client.call<T>(method, params)
      } catch (error) {
        if (!isAcpAuthRequiredError(error) || authAttempted) throw error
        authAttempted = true
        const methodId = firstAdvertisedAuthMethodId(initializeResult)
        if (!methodId) throw toAuthError(error)
        try {
          await client.call("authenticate", { methodId })
        } catch {
          throw toAuthError(error)
        }
        return await client.call<T>(method, params)
      }
    }

    let sessionId: string
    let sessionSetupResult: AcpSessionSetupResult
    let resumed = false
    const mcpServers = this.options.mcpServers ?? []
    if (this.options.resumeSessionId) {
      try {
        sessionSetupResult = await callWithAuthRetry<AcpSessionSetupResult>(
          "session/load",
          {
            sessionId: this.options.resumeSessionId,
            cwd: this.options.cwd,
            mcpServers,
          }
        )
        sessionId = this.options.resumeSessionId
        resumed = true
      } catch (error) {
        if (isAcpAuthRequiredError(error)) throw toAuthError(error)
        sessionSetupResult = await callWithAuthRetry<AcpSessionSetupResult>(
          "session/new",
          {
            cwd: this.options.cwd,
            mcpServers,
          }
        )
        sessionId =
          typeof sessionSetupResult.sessionId === "string" &&
          sessionSetupResult.sessionId.trim()
            ? sessionSetupResult.sessionId
            : randomUUID()
      }
    } else {
      try {
        sessionSetupResult = await callWithAuthRetry<AcpSessionSetupResult>(
          "session/new",
          {
            cwd: this.options.cwd,
            mcpServers,
          }
        )
      } catch (error) {
        if (isAcpAuthRequiredError(error)) throw toAuthError(error)
        throw error
      }
      sessionId =
        typeof sessionSetupResult.sessionId === "string" &&
        sessionSetupResult.sessionId.trim()
          ? sessionSetupResult.sessionId
          : randomUUID()
    }
    return { sessionId, sessionSetupResult, resumed }
  }

  getConfigOptions(): ReadonlyArray<AcpSessionConfigOption> {
    return this.configOptions
  }

  getModeState(): AcpModeState | undefined {
    return this.modeState
  }

  async setConfigOption(
    configId: string,
    value: string | boolean
  ): Promise<AcpSessionSetupResult> {
    const started = await this.start()
    const payload =
      typeof value === "boolean"
        ? { sessionId: started.sessionId, configId, type: "boolean", value }
        : { sessionId: started.sessionId, configId, value: String(value) }
    const response = await this.requireClient().call<AcpSessionSetupResult>(
      "session/set_config_option",
      payload
    )
    this.updateSessionSetup(response)
    this.started = {
      ...started,
      sessionSetupResult: { ...started.sessionSetupResult, ...response },
      ...(this.modeState ? { modeState: this.modeState } : {}),
      configOptions: this.configOptions,
      ...(extractModelConfigId(response)
        ? { modelConfigId: extractModelConfigId(response) }
        : {}),
    }
    return response
  }

  async setModel(model: string): Promise<void> {
    const started = await this.start()
    const selected = resolveAcpAdvertisedModelId(model, this.configOptions)
    const modelOption = findCursorModelConfigOption(this.configOptions)
    if (modelOption?.type === "select") {
      const values = modelOption.options.flatMap((entry) =>
        "value" in entry
          ? [entry.value]
          : entry.options.map((item) => item.value)
      )
      if (!values.includes(selected)) {
        throw new Error(
          `${this.profile.label} did not advertise model ${selected}.`
        )
      }
      const response = await this.setConfigOption(modelOption.id, selected)
      const confirmed = findCursorModelConfigOption(
        response.configOptions ?? []
      )
      if (confirmed?.type !== "select" || confirmed.currentValue !== selected) {
        throw new Error(
          `${this.profile.label} did not confirm model ${selected}.`
        )
      }
      return
    }
    const models = started.sessionSetupResult.models
    if (Array.isArray(models?.availableModels)) {
      if (!models.availableModels.some((item) => item.modelId === selected)) {
        throw new Error(
          `${this.profile.label} did not advertise model ${selected}.`
        )
      }
      await this.requireClient().call("session/set_model", {
        sessionId: started.sessionId,
        modelId: selected,
      })
      if (this.started) {
        this.started = {
          ...this.started,
          sessionSetupResult: {
            ...this.started.sessionSetupResult,
            models: { ...models, currentModelId: selected },
          },
        }
      }
      return
    }
    throw new Error(`${this.profile.label} did not advertise a model picker.`)
  }

  async setMode(modeId: string): Promise<void> {
    if (this.modeState?.currentModeId === modeId) return
    await this.setConfigOption("mode", modeId)
    this.modeState = this.modeState
      ? { ...this.modeState, currentModeId: modeId }
      : undefined
  }

  async prompt(input: {
    prompt: ReadonlyArray<Record<string, unknown>>
  }): Promise<Record<string, unknown>> {
    const started = await this.start()
    const result = await this.requireClient().call<Record<string, unknown>>(
      "session/prompt",
      { sessionId: started.sessionId, prompt: input.prompt },
      ACP_PROMPT_IDLE_TIMEOUT_MS,
      { resetTimeoutOnActivity: true }
    )
    this.closeAssistantSegment()
    return result
  }

  async cancel(): Promise<void> {
    const started = await this.start()
    await this.requireClient().call("session/cancel", {
      sessionId: started.sessionId,
    })
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    const client = this.client
    if (!client) {
      this.resetRuntimeState()
      return
    }
    const operation = (async () => {
      await client.close()
      if (this.client === client) this.client = null
      this.resetRuntimeState()
    })()
    this.closePromise = operation
    try {
      await operation
    } finally {
      if (this.closePromise === operation) this.closePromise = null
    }
  }

  private resetRuntimeState(): void {
    this.started = null
    this.configOptions = []
    this.modeState = undefined
    this.activeAssistantItemId = null
    this.nextAssistantSegment = 0
    this.toolCalls.clear()
  }

  private async handleServerRequest(
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (method === "session/request_permission") {
      const parsed = parsePermissionRequest(params)
      if (!this.permissionHandler) {
        return { outcome: { outcome: "cancelled" } }
      }
      return await this.permissionHandler(parsed)
    }
    const extHandler = this.extRequestHandlers.get(method)
    if (extHandler) return await extHandler(params)
    return {}
  }

  private handleSessionUpdate(params: unknown): void {
    const update = asRecord(asRecord(params).update)
    const sessionUpdate = readTrimmed(update, "sessionUpdate")
    switch (sessionUpdate) {
      case "config_option_update": {
        if (Array.isArray(update.configOptions)) {
          this.configOptions = update.configOptions as AcpSessionConfigOption[]
          if (this.started) {
            this.started = {
              ...this.started,
              configOptions: this.configOptions,
              sessionSetupResult: {
                ...this.started.sessionSetupResult,
                configOptions: this.configOptions,
              },
            }
          }
        }
        break
      }
      case "current_mode_update": {
        const modeId = readTrimmed(update, "currentModeId")
        if (modeId) {
          this.modeState = this.modeState
            ? { ...this.modeState, currentModeId: modeId }
            : undefined
          this.emit({ type: "mode.changed", modeId, raw: params })
        }
        break
      }
      case "plan": {
        const entries = arrayField(update, "entries")
        const plan = entries.flatMap((entry, index) => {
          const record = asRecord(entry)
          const step = readTrimmed(record, "content") || `Step ${index + 1}`
          return [{ step, status: normalizePlanStepStatus(record.status) }]
        })
        if (plan.length > 0) {
          this.emit({ type: "plan.updated", payload: { plan }, raw: params })
        }
        break
      }
      case "tool_call":
      case "tool_call_update": {
        this.closeAssistantSegment()
        const toolCall = parseToolCallState(update, {
          fallbackStatus: sessionUpdate === "tool_call" ? "pending" : undefined,
        })
        if (toolCall) {
          const merged = mergeToolCallState(
            this.toolCalls.get(toolCall.toolCallId),
            toolCall
          )
          this.toolCalls.set(merged.toolCallId, merged)
          this.emit({ type: "tool.updated", toolCall: merged, raw: params })
        }
        break
      }
      // The agent's thinking. Part of the ACP spec but previously unhandled,
      // so ACP agents appeared to do no reasoning at all — their thought
      // stream was dropped rather than shown as a thinking block.
      case "agent_thought_chunk": {
        const content = asRecord(update.content)
        if (content.type === "text") {
          const text = readString(content, "text")
          if (text) this.emit({ type: "reasoning.delta", text, raw: params })
        }
        break
      }
      case "agent_message_chunk": {
        const content = asRecord(update.content)
        if (content.type === "text") {
          const text = readString(content, "text")
          // Whitespace-only chunks are dropped ONLY before the first real
          // token: leading padding would otherwise open an empty assistant
          // bubble. Once a segment is live they must pass through untouched —
          // that is where the word breaks live.
          if (
            text &&
            !(text.trim().length === 0 && !this.activeAssistantItemId)
          ) {
            const itemId = this.ensureAssistantSegment()
            this.emit({ type: "content.delta", itemId, text, raw: params })
          }
        }
        break
      }
      default:
        break
    }
  }

  private updateSessionSetup(response: AcpSessionSetupResult): void {
    this.configOptions = Array.isArray(response.configOptions)
      ? response.configOptions
      : this.configOptions
    const modeState = parseSessionModeState(response)
    if (modeState) this.modeState = modeState
  }

  private ensureAssistantSegment(): string {
    if (this.activeAssistantItemId) return this.activeAssistantItemId
    const itemId = `assistant-${++this.nextAssistantSegment}`
    this.activeAssistantItemId = itemId
    this.emit({ type: "assistant.started", itemId })
    return itemId
  }

  private closeAssistantSegment(): void {
    const itemId = this.activeAssistantItemId
    if (!itemId) return
    this.activeAssistantItemId = null
    this.emit({ type: "assistant.completed", itemId })
  }

  private emit(event: AcpEvent): void {
    this.bus.emit("event", event)
  }

  private requireClient(): AcpJsonRpcClient {
    if (!this.client) {
      throw new Error(`${this.profile.label} ACP runtime is not started`)
    }
    return this.client
  }
}

/**
 * AcpJsonRpcClient surfaces JSON-RPC errors as `Error("acp rpc error <code>:
 * <message>")`, so auth detection is by code + keyword. ACP implementations
 * signal missing auth with code 401 (the spec's auth_required error) or an
 * auth-flavored message.
 */
export function isAcpAuthRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const codeMatch = /acp rpc error (-?\d+)\b/.exec(message)
  const code = codeMatch ? Number(codeMatch[1]) : undefined
  if (code === 401 || code === -32001) return true
  return /auth_required|authrequired|unauthenticated|unauthorized|not (?:logged|signed) in|login required|authentication/i.test(
    message
  )
}

export function firstAdvertisedAuthMethodId(
  initializeResult: Record<string, unknown>
): string | undefined {
  const rawMethods = initializeResult.authMethods
  const methods: unknown[] = Array.isArray(rawMethods) ? rawMethods : []
  for (const entry of methods) {
    const id = readTrimmed(asRecord(entry), "id")
    if (id) return id
  }
  return undefined
}

function extractModelConfigId(
  response: AcpSessionSetupResult
): string | undefined {
  return findCursorModelConfigOption(response.configOptions ?? [])?.id
}

function parseSessionModeState(
  response: AcpSessionSetupResult
): AcpModeState | undefined {
  const modes = response.modes
  if (!modes) return undefined
  const currentModeId = modes.currentModeId?.trim()
  if (!currentModeId) return undefined
  const availableModes = (modes.availableModes ?? []).flatMap((mode) => {
    const id = mode.id?.trim()
    const name = mode.name?.trim()
    if (!id || !name) return []
    const description = mode.description?.trim()
    return [{ id, name, ...(description ? { description } : {}) }]
  })
  if (availableModes.length === 0) return undefined
  return { currentModeId, availableModes }
}

function parsePermissionRequest(params: unknown): AcpPermissionRequest {
  const record = asRecord(params)
  const toolCall = parseToolCallState(asRecord(record.toolCall), {
    fallbackStatus: "pending",
  })
  const kind = toolCall?.kind ?? "unknown"
  const detail =
    toolCall?.command ??
    toolCall?.title ??
    toolCall?.detail ??
    readTrimmed(record, "sessionId")
  return {
    kind,
    ...(detail ? { detail } : {}),
    ...(toolCall ? { toolCall } : {}),
    raw: params,
  }
}

function parseToolCallState(
  input: Record<string, unknown>,
  options: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed"
  } = {}
): AcpToolCallState | undefined {
  const id = readTrimmed(input, "toolCallId")
  if (!id) return
  const title = readTrimmed(input, "title")
  const command = extractToolCallCommand(input.rawInput, title)
  const fields = {
    title,
    command,
    kind: readTrimmed(input, "kind"),
    status: normalizeToolCallStatus(input.status, options.fallbackStatus),
    detail:
      command ?? title ?? extractTextContentFromToolCallContent(input.content),
  }
  const data: Record<string, unknown> = { toolCallId: id }
  if (fields.kind) data.kind = fields.kind
  // `locations` is the ACP-native answer to "which file?"; keep it so the
  // presentation layer can prefer it over guessing from rawInput field names.
  for (const key of ["rawInput", "rawOutput", "content", "locations"]) {
    if (input[key] !== undefined) data[key] = input[key]
  }
  return Object.assign(
    { toolCallId: id, data },
    Object.fromEntries(Object.entries(fields).filter(([, value]) => value))
  )
}

function mergeToolCallState(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState
): AcpToolCallState {
  const merged: AcpToolCallState = {
    toolCallId: next.toolCallId,
    data: { ...previous?.data, ...next.data },
  }
  for (const field of [
    "kind",
    "title",
    "status",
    "command",
    "detail",
  ] as const) {
    const value = next[field] ?? previous?.[field]
    if (value) Object.assign(merged, { [field]: value })
  }
  return merged
}

function normalizePlanStepStatus(
  raw: unknown
): "pending" | "inProgress" | "completed" {
  const status = normalizeToolCallStatus(raw)
  return status === "completed" || status === "inProgress" ? status : "pending"
}

function normalizeToolCallStatus(
  raw: unknown,
  fallback?: "pending" | "inProgress" | "completed" | "failed"
): "pending" | "inProgress" | "completed" | "failed" | undefined {
  if (raw === "in_progress") return "inProgress"
  const states = ["pending", "inProgress", "completed", "failed"] as const
  return states.find((state) => state === raw) ?? fallback
}

function extractToolCallCommand(
  rawInput: unknown,
  title: string | undefined
): string | undefined {
  const record = asRecord(rawInput)
  const command = normalizeCommandValue(record.command)
  if (command) return command
  const executable = readTrimmed(record, "executable")
  const args = normalizeCommandValue(record.args)
  if (executable && args) return `${executable} ${args}`
  if (executable) return executable
  if (!title) return undefined
  return /`([^`]+)`/.exec(title)?.[1]?.trim() || undefined
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (!Array.isArray(value)) return undefined
  const parts = value
    .map((entry) =>
      typeof entry === "string" && entry.trim() ? entry.trim() : null
    )
    .filter((entry): entry is string => entry !== null)
  return parts.length > 0 ? parts.join(" ") : undefined
}

function extractTextContentFromToolCallContent(
  value: unknown
): string | undefined {
  if (!Array.isArray(value)) return undefined
  const chunks = value.flatMap((entry) => {
    const record = asRecord(entry)
    if (record.type !== "content") return []
    const content = asRecord(record.content)
    if (content.type !== "text") return []
    const text = readTrimmed(content, "text")
    return text ? [text] : []
  })
  return chunks.length > 0 ? chunks.join("\n") : undefined
}

function arrayField(
  record: Record<string, unknown>,
  key: string
): ReadonlyArray<unknown> {
  const value = record[key]
  return Array.isArray(value) ? value : []
}
