import type {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
} from "@betterc0de/schema"
import os from "node:os"
import path from "node:path"
import type { Settings } from "../../settings/schema"
import { expandHomePath } from "../../pathExpansion"
import {
  isUnsafeChildEnvironmentKey,
  sanitizedChildEnvironment,
} from "../../security/childEnvironment"
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
import { CodexAdapter } from "./codex/CodexAdapter"
import { ClaudeAdapter } from "./claude/ClaudeAdapter"
import { ClaudeTerminalAdapter } from "./claudeTerminal/ClaudeTerminalAdapter"
import { CursorAcpAdapter } from "./cursor/CursorAcpAdapter"
import type { AcpMcpServerResolver } from "./cursor/AcpMcpServers"
import type { CodeSearchServerResolver } from "../../services/code-search/contracts"
import { probeCursorProviderStatus } from "./cursor/CursorProviderStatus"
import { GrokAcpAdapter } from "./grok-cli/GrokAcpAdapter"
import { probeGrokProviderStatusAsync } from "./grok-cli/GrokProviderStatus"
import { BetterC0deCompatAdapter } from "./betterc0deCompat/BetterC0deCompatAdapter"
import type { ProviderRuntimeInstance } from "./ProviderHub"
import type { EventNdjsonLogger } from "./EventNdjsonLogger"

interface ProviderInstanceManagerOptions {
  readonly clientInfo: {
    readonly name: string
    readonly title: string
    readonly version: string
  }
  readonly nativeEventLogger?: EventNdjsonLogger | null
  readonly resolveAcpMcpServers?: AcpMcpServerResolver
  readonly resolveCodeSearchServer?: CodeSearchServerResolver
  readonly resolveOrchestratorServer?: import("../../services/orchestrator/mcp").OrchestratorServerResolver
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
    const driver = normalizeDriver(config.driver)
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

    if (driver === "codex") {
      const configuredBinaryPath = readConfigString(config.config, "binaryPath")
      const binaryPath = configuredBinaryPath || "codex"
      const effectiveConfig = {
        ...readConfigRecord(config.config),
        binaryPath,
      }
      const continuationKey = codexContinuationKey(
        readConfigString(config.config, "homePath")
      )
      const adapter = new CodexAdapter({
        resolveCodeSearchServer: this.options.resolveCodeSearchServer,
        resolveOrchestratorServer: this.options.resolveOrchestratorServer,
        providerInstanceId: config.instanceId,
        continuationKey,
        binaryPath,
        homePath: readConfigString(config.config, "homePath"),
        shadowHomePath: readConfigString(config.config, "shadowHomePath"),
        environment,
        customModels: readConfigStringArray(config.config, "customModels"),
        clientInfo: this.options.clientInfo,
        nativeEventLogger: this.options.nativeEventLogger,
        getStoredProviderThreadId: (threadId) =>
          this.options.getStoredProviderThreadId({
            threadId,
            providerKind: "codex",
            providerInstanceId: config.instanceId,
            continuationKey,
          }),
        persistProviderThreadId: (threadId, providerThreadId) =>
          this.options.persistProviderThreadId({
            threadId,
            providerKind: "codex",
            providerInstanceId: config.instanceId,
            providerThreadId,
            continuationKey,
          }),
      })
      return {
        ...base,
        config: effectiveConfig,
        provider: "codex",
        continuationKey,
        version: null,
        statusProbe: (input) => adapter.probeStatus(input),
        adapter,
      }
    }

    if (driver === "claude") {
      const binaryPath =
        readConfigString(config.config, "binaryPath") ??
        (process.env.BETTERC0DE_CLAUDE_CODE_PATH?.trim() || "claude")
      const continuationKey = claudeContinuationKey(
        readConfigString(config.config, "homePath")
      )
      const adapter = new ClaudeAdapter({
        resolveCodeSearchServer: this.options.resolveCodeSearchServer,
        resolveOrchestratorServer: this.options.resolveOrchestratorServer,
        providerInstanceId: config.instanceId,
        continuationKey,
        binaryPath,
        homePath: readConfigString(config.config, "homePath"),
        environment,
        customModels: readConfigStringArray(config.config, "customModels"),
        nativeEventLogger: this.options.nativeEventLogger,
        getStoredProviderThreadId: (threadId) =>
          this.options.getStoredProviderThreadId({
            threadId,
            providerKind: "claude",
            providerInstanceId: config.instanceId,
            continuationKey,
          }),
        getStoredProviderResumeCursor: (threadId) =>
          this.options.getStoredProviderResumeCursor?.({
            threadId,
            providerKind: "claude",
            providerInstanceId: config.instanceId,
            continuationKey,
          }) ?? null,
        persistProviderThreadId: (threadId, providerThreadId, resumeCursor) =>
          this.options.persistProviderThreadId({
            threadId,
            providerKind: "claude",
            providerInstanceId: config.instanceId,
            providerThreadId,
            resumeCursor,
            continuationKey,
          }),
      })
      return {
        ...base,
        provider: "claude",
        continuationKey,
        version: null,
        statusProbe: (input) => adapter.probeStatus(input),
        adapter,
      }
    }

    if (driver === "claude-terminal") {
      const binaryPath =
        readConfigString(config.config, "binaryPath") ??
        process.env.BETTERC0DE_CLAUDE_CODE_PATH ??
        "claude"
      const continuationKey = claudeTerminalContinuationKey(
        readConfigString(config.config, "homePath")
      )
      const adapter = new ClaudeTerminalAdapter({
        providerInstanceId: config.instanceId,
        continuationKey,
        binaryPath,
        homePath: readConfigString(config.config, "homePath"),
        environment,
        customModels: readConfigStringArray(config.config, "customModels"),
        getStoredProviderThreadId: (threadId) =>
          this.options.getStoredProviderThreadId({
            threadId,
            providerKind: "claude",
            providerInstanceId: config.instanceId,
            continuationKey,
          }),
        persistProviderThreadId: (threadId, providerThreadId, resumeCursor) =>
          this.options.persistProviderThreadId({
            threadId,
            providerKind: "claude",
            providerInstanceId: config.instanceId,
            providerThreadId,
            resumeCursor,
            continuationKey,
          }),
      })
      return {
        ...base,
        provider: "claude",
        continuationKey,
        config: {
          ...readConfigRecord(config.config),
          binaryPath,
        },
        version: null,
        statusProbe: (input) => adapter.probeStatus(input),
        adapter,
      }
    }

    if (driver === "cursor") {
      // Empty means "let the adapter resolve it on disk". The bare name
      // `agent` is not Cursor-specific and can belong to another vendor's CLI.
      const binaryPath = readConfigString(config.config, "binaryPath") ?? ""
      const continuationKey = instanceContinuationKey(
        "cursor",
        config.instanceId
      )
      const env = providerEnvironmentToProcessEnv(config.environment)
      return {
        ...base,
        provider: "cursor",
        continuationKey,
        version: null,
        statusProbe: () =>
          probeCursorProviderStatus({
            binaryPath,
            env,
          }),
        adapter: new CursorAcpAdapter({
          providerInstanceId: config.instanceId,
          continuationKey,
          binaryPath,
          apiEndpoint: readConfigString(config.config, "apiEndpoint"),
          environment,
          customModels: readConfigStringArray(config.config, "customModels"),
          clientInfo: this.options.clientInfo,
          nativeEventLogger: this.options.nativeEventLogger,
          resolveMcpServers: this.options.resolveAcpMcpServers,
          resolveOrchestratorServer: this.options.resolveOrchestratorServer,
        }),
      }
    }

    if (driver === "grok-cli") {
      // The binary name `grok` is ambiguous on PATH. Verification is deferred
      // to the bounded asynchronous status/runtime path, which accepts only
      // xAI's CLI and never blocks synchronous reconciliation.
      const configuredBinaryPath = readConfigString(config.config, "binaryPath")
      const continuationKey = instanceContinuationKey(
        "grok-cli",
        config.instanceId
      )
      const env = providerEnvironmentToProcessEnv(config.environment)
      return {
        ...base,
        provider: "grok_cli",
        continuationKey,
        version: null,
        statusProbe: () =>
          probeGrokProviderStatusAsync({
            binaryPath: configuredBinaryPath,
            env,
          }),
        adapter: new GrokAcpAdapter({
          providerInstanceId: config.instanceId,
          continuationKey,
          binaryPath: configuredBinaryPath,
          environment,
          customModels: readConfigStringArray(config.config, "customModels"),
          clientInfo: this.options.clientInfo,
          nativeEventLogger: this.options.nativeEventLogger,
          resolveMcpServers: this.options.resolveAcpMcpServers,
          resolveOrchestratorServer: this.options.resolveOrchestratorServer,
        }),
      }
    }

    if (driver === "betterc0de") {
      const binaryPath =
        readConfigString(config.config, "binaryPath") ?? "betterc0de"
      const continuationKey = instanceContinuationKey(
        "betterc0de",
        config.instanceId
      )
      const adapter = new BetterC0deCompatAdapter({
        providerInstanceId: config.instanceId,
        continuationKey,
        binaryPath,
        serverUrl: readConfigString(config.config, "serverUrl"),
        serverUsername: readConfigString(config.config, "serverUsername"),
        serverPassword: readConfigString(config.config, "serverPassword"),
        environment,
        customModels: readConfigStringArray(config.config, "customModels"),
        nativeEventLogger: this.options.nativeEventLogger,
      })
      return {
        ...base,
        provider: "betterc0de",
        continuationKey,
        version: null,
        statusProbe: (input) => adapter.probeStatus(input),
        adapter,
      }
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
  const defaults = defaultProviderInstances(settings)
  const merged: ProviderInstanceConfigMap = { ...defaults, ...explicit }
  return Object.values(merged)
    .filter((config) => config.enabled !== false)
    .sort((a, b) => {
      const rank = defaultRank(a.instanceId) - defaultRank(b.instanceId)
      return rank !== 0 ? rank : a.instanceId.localeCompare(b.instanceId)
    })
}

function defaultProviderInstances(
  settings: Settings
): ProviderInstanceConfigMap {
  const providers = settings.providers as Record<
    string,
    { enabled?: boolean; custom_models?: string[] } | undefined
  >
  const codexProviderBinaryPath = readConfigString(
    providers.codex,
    "binaryPath"
  )
  const hasBetterC0deProviderSettings = hasConfiguredProviderSettings(
    providers.betterc0de
  )
  const hasLegacyBetterC0deProviderSettings = hasConfiguredProviderSettings(
    providers.BetterC0de
  )
  const betterC0deProvider = hasBetterC0deProviderSettings
    ? providers.betterc0de
    : hasLegacyBetterC0deProviderSettings
      ? providers.BetterC0de
      : providers.betterc0de
  const betterC0deEnabled =
    providers.betterc0de?.enabled === true ||
    providers.BetterC0de?.enabled === true
  return {
    codex: {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      enabled: providers.codex?.enabled !== false,
      environment: inheritedProviderEnvironment(["OPENAI_API_KEY"]),
      config: {
        binaryPath: codexProviderBinaryPath || "codex",
        homePath: process.env.CODEX_HOME ?? "",
        shadowHomePath: "",
        customModels: providers.codex?.custom_models ?? [],
      },
    },
    claude: {
      instanceId: "claude",
      driver: "claude",
      displayName: "Claude",
      enabled: providers.claude?.enabled !== false,
      environment: inheritedProviderEnvironment(["ANTHROPIC_API_KEY"]),
      config: {
        binaryPath:
          readConfigString(providers.claude, "binaryPath") ||
          process.env.BETTERC0DE_CLAUDE_CODE_PATH ||
          "claude",
        homePath: process.env.CLAUDE_CONFIG_DIR ?? "",
        customModels: providers.claude?.custom_models ?? [],
      },
    },
    ...(providers["claude-terminal"]?.enabled === true
      ? {
          "claude-terminal": {
            instanceId: "claude-terminal",
            driver: "claude-terminal",
            displayName: "Claude Terminal",
            enabled: true,
            environment: inheritedProviderEnvironment(["ANTHROPIC_API_KEY"]),
            config: {
              binaryPath:
                readConfigString(providers["claude-terminal"], "binaryPath") ||
                readConfigString(providers.claude, "binaryPath") ||
                process.env.BETTERC0DE_CLAUDE_CODE_PATH ||
                "claude",
              homePath: process.env.CLAUDE_CONFIG_DIR ?? "",
              customModels:
                providers["claude-terminal"]?.custom_models ??
                providers.claude?.custom_models ??
                [],
            },
          },
        }
      : {}),
    cursor: {
      instanceId: "cursor",
      driver: "cursor",
      displayName: "Cursor",
      enabled: providers.cursor?.enabled !== false,
      environment: [],
      config: {
        binaryPath: readConfigString(providers.cursor, "binaryPath") || "",
        apiEndpoint: readConfigString(providers.cursor, "apiEndpoint") ?? "",
        customModels: providers.cursor?.custom_models ?? [],
      },
    },
    // Settings key is "grok-cli" — deliberately NOT "grok", which belongs to
    // the legacy xAI API-key provider. binaryPath stays as configured (or
    // empty): resolution to a VERIFIED xAI binary happens inside the adapter
    // and status probe via resolveGrokBinary — never via generic PATH
    // detection (grok-dev incident 2026-07-21).
    "grok-cli": {
      instanceId: "grok-cli",
      driver: "grok-cli",
      displayName: "Grok CLI",
      enabled: providers["grok-cli"]?.enabled !== false,
      environment: inheritedProviderEnvironment(["XAI_API_KEY"]),
      config: {
        binaryPath: readConfigString(providers["grok-cli"], "binaryPath") || "",
        customModels: providers["grok-cli"]?.custom_models ?? [],
      },
    },
    ...(betterC0deEnabled
      ? {
          betterc0de: {
            instanceId: "betterc0de",
            driver: "betterc0de",
            displayName: "BetterC0de",
            enabled: true,
            environment: [],
            config: {
              binaryPath:
                readConfigString(betterC0deProvider, "binaryPath") ||
                "betterc0de",
              serverUrl:
                readConfigString(betterC0deProvider, "serverUrl") ?? "",
              serverUsername:
                readConfigString(betterC0deProvider, "serverUsername") ?? "",
              serverPassword:
                readConfigString(betterC0deProvider, "serverPassword") ?? "",
              customModels: betterC0deProvider?.custom_models ?? [],
            },
          },
        }
      : {}),
  }
}

function hasConfiguredProviderSettings(
  provider: { enabled?: boolean; custom_models?: string[] } | undefined
): boolean {
  if (!provider) return false
  if (provider.enabled === false) return true
  if ((provider.custom_models ?? []).length > 0) return true
  return [
    "binaryPath",
    "apiEndpoint",
    "serverUrl",
    "serverUsername",
    "serverPassword",
  ].some((key) => readConfigString(provider, key))
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
      driver: normalizeDriver(config.driver),
      enabled: config.enabled !== false,
      environment: config.environment ?? [],
      config: config.config ?? {},
    }
  }
  return out
}

function normalizeDriver(driver: string): string {
  const value = driver.trim()
  const key = value.toLowerCase()
  const compactKey = key.replace(/[_-]+/g, "")
  if (compactKey === "codex" || compactKey === "codexcli") return "codex"
  if (
    compactKey === "claude" ||
    compactKey === "claudeagent" ||
    compactKey === "anthropiccli" ||
    compactKey === "claudecli"
  ) {
    return "claude"
  }
  if (
    compactKey === "claudeterminal" ||
    compactKey === "claudepty" ||
    compactKey === "claudeptywrapper"
  ) {
    return "claude-terminal"
  }
  if (
    compactKey === "cursor" ||
    compactKey === "cursorcli" ||
    compactKey === "cursoragent" ||
    compactKey === "cursoracp"
  ) {
    return "cursor"
  }
  // Bare "grok" is NOT aliased here — that name belongs to the legacy xAI
  // API-key provider, not the CLI driver.
  if (
    compactKey === "grokcli" ||
    compactKey === "grokagent" ||
    compactKey === "grokacp" ||
    compactKey === "grokbuild"
  ) {
    return "grok-cli"
  }
  if (
    compactKey === "betterc0de" ||
    compactKey === "bettercode" ||
    compactKey === "betterc0decli" ||
    compactKey === "bettercodecli" ||
    compactKey === "betterc0deagent" ||
    compactKey === "bettercodeagent" ||
    compactKey === "BetterC0de" ||
    compactKey === "BetterC0decli" ||
    compactKey === "BetterC0deagent"
  ) {
    return "betterc0de"
  }
  return value
}

function defaultRank(instanceId: string): number {
  if (instanceId === "codex") return 0
  if (instanceId === "claude") return 1
  if (instanceId === "claude-terminal") return 2
  if (instanceId === "cursor") return 3
  if (instanceId === "betterc0de") return 4
  if (instanceId === "BetterC0de") return 5
  if (instanceId === "grok-cli") return 6
  return 10
}

function codexContinuationKey(homePath: string | null): string {
  const configured =
    homePath ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  return `codex:home:${path.resolve(expandHomePath(configured))}`
}

function claudeContinuationKey(homePath: string | null): string {
  const configured = homePath ?? process.env.CLAUDE_CONFIG_DIR ?? os.homedir()
  const normalized = path.normalize(path.resolve(expandHomePath(configured)))
  const home =
    path.basename(normalized) === ".claude"
      ? path.dirname(normalized)
      : normalized
  return `claude:home:${home}`
}

function claudeTerminalContinuationKey(homePath: string | null): string {
  const configured = homePath ?? process.env.CLAUDE_CONFIG_DIR ?? os.homedir()
  const normalized = path.normalize(path.resolve(expandHomePath(configured)))
  const home =
    path.basename(normalized) === ".claude"
      ? path.dirname(normalized)
      : normalized
  return `claude-terminal:home:${home}`
}

function instanceContinuationKey(driver: string, instanceId: string): string {
  return `${driver}:instance:${instanceId}`
}

function inheritedProviderEnvironment(
  names: readonly string[]
): NonNullable<ProviderInstanceConfig["environment"]> {
  return names.flatMap((name) => {
    const value = process.env[name]
    return value?.trim() ? [{ name, value, sensitive: true }] : []
  })
}

function readConfigString(config: unknown, key: string): string | null {
  const value = readConfigRecord(config)[key]
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readConfigStringArray(config: unknown, key: string): string[] {
  const value = readConfigRecord(config)[key]
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
}

function readConfigRecord(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {}
  return config as Record<string, unknown>
}

function providerEnvironmentToProcessEnv(
  environment: ProviderInstanceConfig["environment"]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = sanitizedChildEnvironment()
  for (const item of environment ?? []) {
    if (!item.name) continue
    if (isUnsafeChildEnvironmentKey(item.name)) {
      throw new Error(
        `Provider environment variable '${item.name}' is not allowed.`
      )
    }
    env[item.name] = item.value
  }
  return env
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
