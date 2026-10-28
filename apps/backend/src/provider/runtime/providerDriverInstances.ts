import type {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
} from "@betterc0de/schema"
import os from "node:os"
import path from "node:path"
import { expandHomePath } from "../../pathExpansion"
import {
  isUnsafeChildEnvironmentKey,
  sanitizedChildEnvironment,
} from "../../security/childEnvironment"
import { CodexAdapter } from "./codex/CodexAdapter"
import { codexBinaryPath } from "./codex/CodexBinaryPath"
import { ClaudeAdapter } from "./claude/ClaudeAdapter"
import { ClaudeTerminalAdapter } from "./claudeTerminal/ClaudeTerminalAdapter"
import { CursorAcpAdapter } from "./cursor/CursorAcpAdapter"
import { probeCursorProviderStatus } from "./cursor/CursorProviderStatus"
import { GrokAcpAdapter } from "./grok-cli/GrokAcpAdapter"
import { probeGrokProviderStatusAsync } from "./grok-cli/GrokProviderStatus"
import { BetterC0deCompatAdapter } from "./betterc0deCompat/BetterC0deCompatAdapter"
import { OpenCodeAcpAdapter } from "./opencode/OpenCodeAcpAdapter"
import { probeOpenCodeProviderStatusAsync } from "./opencode/OpenCodeProviderStatus"
import type { ProviderRuntimeInstance } from "./ProviderHubTypes"
import type { ProviderInstanceManagerOptions } from "./ProviderInstanceManager"
import {
  PROVIDER_DRIVERS,
  type ProviderDriverDescriptor,
  type ProviderDriverName,
} from "./providerDrivers"

/** `settings.providers`, as the default-instance builders read it. */
export type ProviderSettingsRecord = Record<
  string,
  { enabled?: boolean; custom_models?: string[] } | undefined
>

/** The fields every instance shares, already validated by the manager. */
export type ProviderRuntimeInstanceBase = Pick<
  ProviderRuntimeInstance,
  | "instanceId"
  | "driver"
  | "displayName"
  | "accentColor"
  | "enabled"
  | "environment"
  | "config"
>

export interface ProviderDriverBuildInput {
  readonly config: ProviderInstanceConfig
  readonly base: ProviderRuntimeInstanceBase
  readonly environment: ProviderInstanceConfig["environment"]
  readonly options: ProviderInstanceManagerOptions
}

/** The code half of a driver: its runtime instance and its defaults. */
export interface ProviderDriverInstanceFactory {
  readonly buildInstance: (
    input: ProviderDriverBuildInput
  ) => ProviderRuntimeInstance
  /** The driver's default instance(s) for these settings; may be empty. */
  readonly defaultInstances: (
    providers: ProviderSettingsRecord
  ) => ProviderInstanceConfigMap
}

/** A complete driver: its registry row plus the code that builds it. */
export type ProviderDriver = ProviderDriverDescriptor &
  ProviderDriverInstanceFactory

// Keyed by the registry's driver names: a driver added to PROVIDER_DRIVERS
// without a factory here (or the reverse) fails to type-check.
const FACTORIES: {
  readonly [D in ProviderDriverName]: ProviderDriverInstanceFactory
} = {
  codex: {
    buildInstance: ({ config, base, environment, options }) => {
      const configuredBinaryPath = readConfigString(config.config, "binaryPath")
      const binaryPath = codexBinaryPath(configuredBinaryPath)
      const effectiveConfig = {
        ...readConfigRecord(config.config),
        binaryPath,
      }
      const continuationKey = codexContinuationKey(
        readConfigString(config.config, "homePath")
      )
      const adapter = new CodexAdapter({
        modelCacheDir: options.modelCacheDir,
        resolveCodeSearchServer: options.resolveCodeSearchServer,
        resolveOrchestratorServer: options.resolveOrchestratorServer,
        providerInstanceId: config.instanceId,
        continuationKey,
        binaryPath,
        homePath: readConfigString(config.config, "homePath"),
        shadowHomePath: readConfigString(config.config, "shadowHomePath"),
        environment,
        customModels: readConfigStringArray(config.config, "customModels"),
        clientInfo: options.clientInfo,
        nativeEventLogger: options.nativeEventLogger,
        getStoredProviderThreadId: (threadId) =>
          options.getStoredProviderThreadId({
            threadId,
            providerKind: "codex",
            providerInstanceId: config.instanceId,
            continuationKey,
          }),
        persistProviderThreadId: (threadId, providerThreadId) =>
          options.persistProviderThreadId({
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
    },
    defaultInstances: (providers) => {
      const codexProviderBinaryPath = readConfigString(
        providers.codex,
        "binaryPath"
      )
      return {
        codex: {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: providers.codex?.enabled !== false,
          environment: inheritedProviderEnvironment(["OPENAI_API_KEY"]),
          config: {
            binaryPath: codexBinaryPath(codexProviderBinaryPath),
            homePath: process.env.CODEX_HOME ?? "",
            shadowHomePath: "",
            customModels: providers.codex?.custom_models ?? [],
          },
        },
      }
    },
  },
  claude: {
    buildInstance: ({ config, base, environment, options }) => {
      const binaryPath =
        readConfigString(config.config, "binaryPath") ??
        (process.env.BETTERC0DE_CLAUDE_CODE_PATH?.trim() || "claude")
      const continuationKey = claudeContinuationKey(
        readConfigString(config.config, "homePath")
      )
      const adapter = new ClaudeAdapter({
        modelCacheDir: options.modelCacheDir,
        resolveCodeSearchServer: options.resolveCodeSearchServer,
        resolveOrchestratorServer: options.resolveOrchestratorServer,
        resolveImageGenerationModel: options.resolveImageGenerationModel,
        imageGeneration: options.imageGeneration,
        providerInstanceId: config.instanceId,
        continuationKey,
        binaryPath,
        homePath: readConfigString(config.config, "homePath"),
        environment,
        customModels: readConfigStringArray(config.config, "customModels"),
        nativeEventLogger: options.nativeEventLogger,
        getStoredProviderThreadId: (threadId) =>
          options.getStoredProviderThreadId({
            threadId,
            providerKind: "claude",
            providerInstanceId: config.instanceId,
            continuationKey,
          }),
        getStoredProviderResumeCursor: (threadId) =>
          options.getStoredProviderResumeCursor?.({
            threadId,
            providerKind: "claude",
            providerInstanceId: config.instanceId,
            continuationKey,
          }) ?? null,
        persistProviderThreadId: (threadId, providerThreadId, resumeCursor) =>
          options.persistProviderThreadId({
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
    },
    defaultInstances: (providers) => ({
      claude: {
        instanceId: "claude",
        driver: "claude",
        displayName: "Claude",
        enabled: providers.claude?.enabled !== false,
        environment: inheritedProviderEnvironment(
          CLAUDE_INHERITED_CREDENTIAL_KEYS
        ),
        config: {
          binaryPath:
            readConfigString(providers.claude, "binaryPath") ||
            process.env.BETTERC0DE_CLAUDE_CODE_PATH ||
            "claude",
          homePath: process.env.CLAUDE_CONFIG_DIR ?? "",
          customModels: providers.claude?.custom_models ?? [],
        },
      },
    }),
  },
  "claude-terminal": {
    buildInstance: ({ config, base, environment, options }) => {
      const binaryPath =
        readConfigString(config.config, "binaryPath") ??
        process.env.BETTERC0DE_CLAUDE_CODE_PATH ??
        "claude"
      const continuationKey = claudeTerminalContinuationKey(
        readConfigString(config.config, "homePath")
      )
      const adapter = new ClaudeTerminalAdapter({
        modelCacheDir: options.modelCacheDir,
        providerInstanceId: config.instanceId,
        continuationKey,
        binaryPath,
        homePath: readConfigString(config.config, "homePath"),
        environment,
        customModels: readConfigStringArray(config.config, "customModels"),
        getStoredProviderThreadId: (threadId) =>
          options.getStoredProviderThreadId({
            threadId,
            providerKind: "claude",
            providerInstanceId: config.instanceId,
            continuationKey,
          }),
        persistProviderThreadId: (threadId, providerThreadId, resumeCursor) =>
          options.persistProviderThreadId({
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
    },
    defaultInstances: (providers) => ({
      ...(providers["claude-terminal"]?.enabled === true
        ? {
            "claude-terminal": {
              instanceId: "claude-terminal",
              driver: "claude-terminal",
              displayName: "Claude Terminal",
              enabled: true,
              environment: inheritedProviderEnvironment(
                CLAUDE_INHERITED_CREDENTIAL_KEYS
              ),
              config: {
                binaryPath:
                  readConfigString(
                    providers["claude-terminal"],
                    "binaryPath"
                  ) ||
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
    }),
  },
  cursor: {
    buildInstance: ({ config, base, environment, options }) => {
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
        statusProbe: (input) =>
          probeCursorProviderStatus({
            binaryPath,
            env,
            refresh: input.refresh,
          }),
        adapter: new CursorAcpAdapter({
          providerInstanceId: config.instanceId,
          continuationKey,
          binaryPath,
          apiEndpoint: readConfigString(config.config, "apiEndpoint"),
          modelCacheDir: options.modelCacheDir,
          statusEnv: env,
          environment,
          customModels: readConfigStringArray(config.config, "customModels"),
          clientInfo: options.clientInfo,
          nativeEventLogger: options.nativeEventLogger,
          resolveMcpServers: options.resolveAcpMcpServers,
          resolveOrchestratorServer: options.resolveOrchestratorServer,
        }),
      }
    },
    defaultInstances: (providers) => ({
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
    }),
  },
  betterc0de: {
    buildInstance: ({ config, base, environment, options }) => {
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
        nativeEventLogger: options.nativeEventLogger,
      })
      return {
        ...base,
        provider: "betterc0de",
        continuationKey,
        version: null,
        statusProbe: (input) => adapter.probeStatus(input),
        adapter,
      }
    },
    defaultInstances: (providers) => {
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
                    readConfigString(betterC0deProvider, "serverUsername") ??
                    "",
                  serverPassword:
                    readConfigString(betterC0deProvider, "serverPassword") ??
                    "",
                  customModels: betterC0deProvider?.custom_models ?? [],
                },
              },
            }
          : {}),
      }
    },
  },
  "grok-cli": {
    buildInstance: ({ config, base, environment, options }) => {
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
          modelCacheDir: options.modelCacheDir,
          providerInstanceId: config.instanceId,
          continuationKey,
          binaryPath: configuredBinaryPath,
          environment,
          customModels: readConfigStringArray(config.config, "customModels"),
          clientInfo: options.clientInfo,
          nativeEventLogger: options.nativeEventLogger,
          resolveMcpServers: options.resolveAcpMcpServers,
          resolveOrchestratorServer: options.resolveOrchestratorServer,
        }),
      }
    },
    defaultInstances: (providers) => ({
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
          binaryPath:
            readConfigString(providers["grok-cli"], "binaryPath") || "",
          customModels: providers["grok-cli"]?.custom_models ?? [],
        },
      },
    }),
  },
  "opencode-cli": {
    buildInstance: ({ config, base, environment, options }) => {
      const binaryPath =
        readConfigString(config.config, "binaryPath") ?? "opencode"
      const continuationKey = instanceContinuationKey(
        "opencode-cli",
        config.instanceId
      )
      const env = providerEnvironmentToProcessEnv(config.environment)
      const adapter = new OpenCodeAcpAdapter({
        providerInstanceId: config.instanceId,
        continuationKey,
        binaryPath,
        environment,
        customModels: readConfigStringArray(config.config, "customModels"),
        clientInfo: options.clientInfo,
        nativeEventLogger: options.nativeEventLogger,
        resolveMcpServers: options.resolveAcpMcpServers,
        resolveOrchestratorServer: options.resolveOrchestratorServer,
      })
      return {
        ...base,
        provider: "opencode_cli",
        continuationKey,
        version: null,
        statusProbe: (input) =>
          probeOpenCodeProviderStatusAsync({
            binaryPath,
            env,
            refresh: input.refresh,
          }),
        adapter,
      }
    },
    defaultInstances: (providers) => ({
      // `opencode acp` runs the CLI locally; there is no compatibility
      // server URL to configure. The settings slot stays separate from the
      // BetterC0de compatibility provider so both can be enabled side by side.
      "opencode-cli": {
        instanceId: "opencode-cli",
        driver: "opencode-cli",
        displayName: "OpenCode CLI",
        enabled: providers["opencode-cli"]?.enabled !== false,
        environment: inheritedProviderEnvironment(OPENCODE_ENV_KEYS),
        config: {
          binaryPath:
            readConfigString(providers["opencode-cli"], "binaryPath") ||
            "opencode",
          customModels: providers["opencode-cli"]?.custom_models ?? [],
        },
      },
    }),
  },
}

/** The provider-hub drivers in registry order, each with its factory. */
export const PROVIDER_DRIVER_REGISTRY: ReadonlyArray<ProviderDriver> =
  PROVIDER_DRIVERS.map((descriptor) => ({
    ...descriptor,
    ...FACTORIES[descriptor.driver],
  }))

const REGISTRY_BY_DRIVER: ReadonlyMap<string, ProviderDriver> = new Map(
  PROVIDER_DRIVER_REGISTRY.map((driver) => [driver.driver, driver])
)

/** The registered driver for a canonical driver name, or null. */
export function providerDriver(driver: string): ProviderDriver | null {
  return REGISTRY_BY_DRIVER.get(driver) ?? null
}

/** Every driver's default instances for these settings, keyed by instance id. */
export function defaultProviderInstances(
  providers: ProviderSettingsRecord
): ProviderInstanceConfigMap {
  return Object.assign(
    {},
    ...PROVIDER_DRIVER_REGISTRY.map((driver) =>
      driver.defaultInstances(providers)
    )
  ) as ProviderInstanceConfigMap
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

/**
 * Credentials Claude Code reads from its environment: an API key, or the
 * bearer token gateways and proxies use instead. Passed explicitly because
 * the child environment withholds secrets by default.
 */
const CLAUDE_INHERITED_CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const

/**
 * Provider keys OpenCode itself reads from the environment. The app's child
 * environment withholds credentials by default, so a user who runs
 * `opencode` from shell keys (without `opencode auth login`) needs these
 * passed explicitly or the provider looks signed out.
 */
const OPENCODE_ENV_KEYS = [
  "OPENCODE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
] as const

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
