import type {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
} from "@betterc0de/schema"
import type { Settings } from "../../settings/schema"
import { isUnsafeChildEnvironmentKey } from "../../security/childEnvironment"
import {
  type ProviderAdapterShape,
  type ProviderApprovalDecision,
  type ProviderCapabilities,
  type ModelSelection,
  type ProviderKind,
  type ProviderModel,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadId,
  type ApprovalRequestId,
} from "./contracts"
import type { AcpMcpServerResolver } from "./acp/AcpMcpServers"
import type { CodeSearchServerResolver } from "../../services/code-search/contracts"
import type { ProviderRuntimeInstance } from "./ProviderHub"
import {
  defaultProviderInstances,
  providerDriver,
  type ProviderSettingsRecord,
} from "./providerDriverInstances"
import {
  defaultProviderInstanceRank,
  normalizeProviderDriver,
} from "./providerDrivers"
import type { EventNdjsonLogger } from "./EventNdjsonLogger"

interface ProviderInstanceManagerOptions {
  readonly modelCacheDir?: string
  readonly clientInfo: {
    readonly name: string
    readonly title: string
    readonly version: string
  }
  readonly nativeEventLogger?: EventNdjsonLogger | null
  readonly resolveAcpMcpServers?: AcpMcpServerResolver
  readonly resolveCodeSearchServer?: CodeSearchServerResolver
  readonly resolveOrchestratorServer?: import("../../services/orchestrator/mcp").OrchestratorServerResolver
  /** Configured image-generation model, read each time a Claude query starts. */
  readonly resolveImageGenerationModel?: () => string | null | undefined
  /** The backend's image generations, which the Claude image tool runs in. */
  readonly imageGeneration?: import("../../services/image-generation").ImageGenerationRunner
  readonly getStoredProviderThreadId: (input: {
    readonly threadId: string
    readonly providerKind: ProviderKind
    readonly providerInstanceId: string
    readonly continuationKey: string | null
  }) => string | null
  readonly getStoredProviderResumeCursor?: (input: {
    readonly threadId: string
    readonly providerKind: ProviderKind
    readonly providerInstanceId: string
    readonly continuationKey: string | null
  }) => unknown | null
  readonly persistProviderThreadId: (input: {
    readonly threadId: string
    readonly providerKind: ProviderKind
    readonly providerInstanceId: string
    readonly providerThreadId: string | null
    readonly resumeCursor?: unknown | null
    readonly continuationKey: string | null
  }) => void
}

interface CachedInstance {
  readonly signature: string
  readonly instance: ProviderRuntimeInstance
}

const UNAVAILABLE_CAPABILITIES: ProviderCapabilities = {
  supportsStreaming: false,
  supportsTools: false,
  supportsApprovals: false,
  supportsResume: false,
  managesOwnLifecycle: false,
}

export class ProviderInstanceManager {
  private readonly cache = new Map<string, CachedInstance>()
  private lastCollectionSignature = ""

  constructor(private readonly options: ProviderInstanceManagerOptions) {}

  reconcile(
    settings: Settings,
    options: {
      readonly forceInstanceIds?: ReadonlyArray<string> | ReadonlySet<string>
    } = {}
  ): {
    readonly instances: ReadonlyArray<ProviderRuntimeInstance>
    readonly changed: boolean
  } {
    const desired = deriveProviderInstanceConfigs(settings)
    const forceInstanceIds = new Set(options.forceInstanceIds ?? [])
    const nextCache = new Map<string, CachedInstance>()
    const instances: ProviderRuntimeInstance[] = []

    for (const config of desired) {
      const signature = stableStringify(config)
      const existing = this.cache.get(config.instanceId)
      const entry =
        existing &&
        existing.signature === signature &&
        !forceInstanceIds.has(config.instanceId)
          ? existing
          : { signature, instance: this.buildInstance(config) }
      nextCache.set(config.instanceId, entry)
      instances.push(entry.instance)
    }

    const collectionSignature = stableStringify(
      instances.map((instance) => ({
        instanceId: instance.instanceId,
        signature: nextCache.get(instance.instanceId)?.signature,
      }))
    )
    const changed = collectionSignature !== this.lastCollectionSignature
    this.cache.clear()
    for (const [key, value] of nextCache) this.cache.set(key, value)
    this.lastCollectionSignature = collectionSignature
    return { instances, changed }
  }

  private buildInstance(
    config: ProviderInstanceConfig
  ): ProviderRuntimeInstance {
    const driver = normalizeProviderDriver(config.driver)
    const environment = validatedProviderEnvironment(config.environment)
    const base = {
      instanceId: config.instanceId,
      driver,
      displayName: config.displayName,
      accentColor: config.accentColor,
      enabled: config.enabled,
      environment,
      config: config.config,
    }

    const registered = providerDriver(driver)
    if (registered) {
      return registered.buildInstance({
        config,
        base,
        environment,
        options: this.options,
      })
    }

    return {
      ...base,
      provider: null,
      unavailableReason: `Unsupported provider driver: ${driver}`,
      adapter: new UnavailableProviderAdapter(
        driver,
        config.displayName ?? config.instanceId
      ),
    }
  }
}

export function deriveProviderInstanceConfigs(
  settings: Settings
): ProviderInstanceConfig[] {
  const explicit = providerInstancesFromSettings(settings)
  const defaults = defaultProviderInstances(
    settings.providers as ProviderSettingsRecord
  )
  const merged: ProviderInstanceConfigMap = { ...defaults, ...explicit }
  return Object.values(merged)
    .filter((config) => config.enabled !== false)
    .sort((a, b) => {
      const rank =
        defaultProviderInstanceRank(a.instanceId) -
        defaultProviderInstanceRank(b.instanceId)
      return rank !== 0 ? rank : a.instanceId.localeCompare(b.instanceId)
    })
}

function providerInstancesFromSettings(
  settings: Settings
): ProviderInstanceConfigMap {
  const raw =
    (settings as unknown as { provider_instances?: ProviderInstanceConfigMap })
      .provider_instances ??
    (settings as unknown as { providerInstances?: ProviderInstanceConfigMap })
      .providerInstances ??
    {}
  const out: ProviderInstanceConfigMap = {}
  for (const [instanceId, config] of Object.entries(raw)) {
    out[instanceId] = {
      ...config,
      instanceId: config.instanceId || instanceId,
      driver: normalizeProviderDriver(config.driver),
      enabled: config.enabled !== false,
      environment: config.environment ?? [],
      config: config.config ?? {},
    }
  }
  return out
}

function validatedProviderEnvironment(
  environment: ProviderInstanceConfig["environment"]
): ProviderInstanceConfig["environment"] {
  for (const item of environment ?? []) {
    if (item.name && isUnsafeChildEnvironmentKey(item.name)) {
      throw new Error(
        `Provider environment variable '${item.name}' is not allowed.`
      )
    }
  }
  return environment
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== "object") return value
  const out: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortJson((value as Record<string, unknown>)[key])
  }
  return out
}

class UnavailableProviderAdapter implements ProviderAdapterShape {
  readonly provider = "codex" as const
  readonly capabilities = UNAVAILABLE_CAPABILITIES

  constructor(
    private readonly driver: string,
    readonly displayName: string
  ) {}

  isConfigured(): boolean {
    return false
  }

  async availableModels(): Promise<ReadonlyArray<ProviderModel>> {
    return []
  }

  async startSession(input: {
    threadId: ThreadId
    cwd?: string | null
    modelSelection?: ModelSelection | null
    resumeCursor?: unknown | null
    runtimeMode?: string | null
  }): Promise<ProviderSession> {
    const now = Date.now()
    return {
      threadId: input.threadId as string,
      providerInstanceId: null,
      providerThreadId: null,
      resumeCursor: null,
      continuationKey: null,
      status: "error",
      cwd: input.cwd ?? null,
      activeTurnId: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  async listSessions(): Promise<ReadonlyArray<ProviderSession>> {
    return []
  }

  async sendTurn(_input: ProviderSendTurnInput): Promise<void> {
    throw new Error(`Unsupported provider driver: ${this.driver}`)
  }

  async interruptTurn(_threadId: ThreadId): Promise<void> {}
  async respondToRequest(
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision
  ): Promise<void> {}
  async stopSession(_threadId: ThreadId): Promise<void> {}
  hasSession(_threadId: ThreadId): boolean {
    return false
  }
  subscribe(_listener: (event: ProviderRuntimeEvent) => void): () => void {
    return () => {}
  }
  async stopAll(): Promise<void> {}
}

export type { ProviderInstanceManagerOptions }
