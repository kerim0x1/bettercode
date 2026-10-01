import fs from "node:fs"
import path from "node:path"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import {
  defaultSettings,
  isSensitiveProviderFieldName,
  secretPatchSchema,
  secretStateSchema,
  settingsSchema,
  type SecretState,
  type Settings,
} from "./schema"
import {
  decryptSecret,
  encryptSecret,
  getMasterKey,
  isEncrypted,
} from "./crypto"
import { isUnsafeChildEnvironmentKey } from "../security/childEnvironment"
import { HttpError } from "../errors"

const PROVIDER_SECRET_KEYS = ["api_key", "serverPassword"] as const
const PROVIDER_DESTINATION_KEYS = [
  "base_url",
  "binaryPath",
  "apiEndpoint",
  "serverUrl",
  "serverUsername",
  "homePath",
  "shadowHomePath",
] as const
const PROVIDER_INSTANCE_CONFIG_SECRET_KEYS = new Set([
  "apiKey",
  "api_key",
  "accessToken",
  "refreshToken",
  "serverPassword",
  "clientSecret",
  "secret",
  "token",
])
const TOP_LEVEL_SECRET_KEYS = ["deepgram_api_key", "jev_api_key"] as const

type UnknownRecord = Record<string, unknown>

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}
type ConfigPathSegment = string | number
type SecretLoadResult = "none" | "plaintext" | "decrypted" | "undecryptable"

interface SettingsSecretLoadState {
  readonly sawPlaintext: boolean
  readonly undecryptableSecretPaths: string[]
}

interface SettingsLoadResult extends SettingsSecretLoadState {
  readonly settings: Settings
  readonly writeBlockedReason: string | null
  /** Identity of the file that produced this result; null when absent. */
  readonly fileStamp: SettingsFileStamp | null
}

/** Enough of `fs.Stats` to notice an external edit without re-parsing. */
interface SettingsFileStamp {
  readonly mtimeMs: number
  readonly size: number
  readonly ino: number
}

function readSettingsFileStamp(filePath: string): SettingsFileStamp | null {
  try {
    const stat = fs.statSync(filePath)
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw error
  }
}

function sameSettingsFileStamp(
  left: SettingsFileStamp | null,
  right: SettingsFileStamp | null
): boolean {
  if (left === null || right === null) return left === right
  return (
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size &&
    left.ino === right.ino
  )
}

function isProviderInstanceConfigSecretKey(key: string): boolean {
  return (
    PROVIDER_INSTANCE_CONFIG_SECRET_KEYS.has(key) ||
    isSensitiveProviderFieldName(key)
  )
}

function visitProviderInstanceConfigSecrets(
  value: unknown,
  visitor: (
    record: UnknownRecord,
    key: string,
    path: readonly ConfigPathSegment[]
  ) => void,
  path: readonly ConfigPathSegment[] = []
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitProviderInstanceConfigSecrets(entry, visitor, [...path, index])
    )
    return
  }
  if (!isUnknownRecord(value)) return
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = [...path, key]
    if (isProviderInstanceConfigSecretKey(key)) {
      visitor(value, key, nestedPath)
    } else {
      visitProviderInstanceConfigSecrets(nested, visitor, nestedPath)
    }
  }
}

function visitSensitiveNamedSettingsFields(
  value: unknown,
  visitor: (
    record: UnknownRecord,
    key: string,
    path: readonly ConfigPathSegment[]
  ) => void,
  path: readonly ConfigPathSegment[] = []
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitSensitiveNamedSettingsFields(entry, visitor, [...path, index])
    )
    return
  }
  if (!isUnknownRecord(value)) return
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = [...path, key]
    // These are public metadata produced by redaction, never credentials.
    if (key === "secretState" || key === "secret_state") continue
    if (isSensitiveProviderFieldName(key)) {
      visitor(value, key, nestedPath)
    } else {
      visitSensitiveNamedSettingsFields(nested, visitor, nestedPath)
    }
  }
}

function settingsPathLabel(path: readonly ConfigPathSegment[]): string {
  return path.map(String).join(".")
}

function configValueAtPath(
  value: unknown,
  path: readonly ConfigPathSegment[]
): unknown {
  let current = value
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
      continue
    }
    if (!isUnknownRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function configPathLabel(
  instanceId: string,
  path: readonly ConfigPathSegment[]
): string {
  return `provider_instances.${instanceId}.config${path
    .map((segment) => `.${segment}`)
    .join("")}`
}

function normalizeProviderInstanceConfigPatch(
  raw: unknown,
  current: unknown,
  instanceId: string,
  path: readonly ConfigPathSegment[] = []
): unknown {
  if (Array.isArray(raw)) {
    const currentArray = Array.isArray(current) ? current : []
    return raw.map((entry, index) =>
      normalizeProviderInstanceConfigPatch(
        entry,
        currentArray[index],
        instanceId,
        [...path, index]
      )
    )
  }
  if (!isUnknownRecord(raw)) return structuredClone(raw)
  const currentRecord = isUnknownRecord(current) ? current : {}
  const normalized = structuredClone(raw) as UnknownRecord
  for (const [key, value] of Object.entries(raw)) {
    const nestedPath = [...path, key]
    normalized[key] = isProviderInstanceConfigSecretKey(key)
      ? resolveSecretUpdate(
          value,
          currentRecord[key],
          configPathLabel(instanceId, nestedPath)
        )
      : normalizeProviderInstanceConfigPatch(
          value,
          currentRecord[key],
          instanceId,
          nestedPath
        )
  }
  return normalized
}

export class InvalidSettingsPatchError extends HttpError {
  constructor(message: string) {
    super(400, message, "invalid_settings_patch")
    this.name = "InvalidSettingsPatchError"
  }
}

/**
 * Mutates every at-rest secret in `settings` from the encrypted on-disk form
 * to plaintext for in-memory use.  Covers:
 *   - `providers.*.api_key`
 *   - `mcp_servers[*].envVars` (free-form KEY=value strings commonly used to
 *     inject provider tokens into spawned MCP subprocesses)
 * Values that fail to decrypt (wrong key, corrupt ciphertext) are cleared so
 * the UI shows "no key configured" instead of an undecryptable blob — safer
 * than retaining unusable data.  Returns true if any legacy plaintext was
 * observed; the caller uses that to trigger a re-persist that encrypts the
 * value on disk.
 */
function decryptSettingsSecrets(settings: Settings): SettingsSecretLoadState {
  let sawPlaintext = false
  const undecryptableSecretPaths: string[] = []
  const recordSecret = (result: SecretLoadResult, secretPath: string): void => {
    if (result === "plaintext") sawPlaintext = true
    if (result === "undecryptable") undecryptableSecretPaths.push(secretPath)
  }
  const mcpServers = (
    settings as unknown as { mcp_servers?: Array<UnknownRecord> }
  ).mcp_servers
  for (const [index, server] of (mcpServers ?? []).entries()) {
    recordSecret(
      decryptSecretProperty(server, "envVars"),
      `mcp_servers.${index}.envVars`
    )
  }

  const providerInstances = (
    settings as unknown as {
      provider_instances?: Record<
        string,
        {
          environment?: Array<UnknownRecord>
          config?: UnknownRecord
        }
      >
    }
  ).provider_instances
  for (const [instanceId, instance] of Object.entries(
    providerInstances ?? {}
  )) {
    for (const [index, envVar] of (instance.environment ?? []).entries()) {
      if (envVar.sensitive === true) {
        recordSecret(
          decryptSecretProperty(envVar, "value"),
          `provider_instances.${instanceId}.environment.${index}.value`
        )
      }
    }
  }

  visitSensitiveNamedSettingsFields(settings, (record, key, secretPath) => {
    recordSecret(
      decryptSecretProperty(record, key),
      settingsPathLabel(secretPath)
    )
  })
  return { sawPlaintext, undecryptableSecretPaths }
}

function decryptSecretProperty(
  record: UnknownRecord,
  key: string
): SecretLoadResult {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) return "none"
  if (!isEncrypted(value)) return "plaintext"
  const decrypted = decryptSecret(value)
  if (decrypted === null) {
    // Never pass ciphertext through as a live provider credential. The
    // SettingsService records this locked path and rejects every write, so
    // the original encrypted value remains intact on disk for key recovery.
    record[key] = ""
    return "undecryptable"
  }
  record[key] = decrypted
  return "decrypted"
}

/**
 * Produces a deep clone of `settings` with every secret replaced by its
 * encrypted form. Used immediately before writing to disk so the in-memory
 * object keeps plaintext for fast reads. `structuredClone` is ~5× faster
 * than `JSON.parse(JSON.stringify(...))` on non-trivial objects and
 * preserves types JSON can't (Date, Map, Set, ArrayBuffer) if the schema
 * ever adopts them.
 */
function encryptSettingsForDisk(settings: Settings): Settings {
  const clone = structuredClone(settings) as Settings

  const mcpServers = (
    clone as unknown as { mcp_servers?: Array<UnknownRecord> }
  ).mcp_servers
  for (const server of mcpServers ?? []) {
    encryptSecretProperty(server, "envVars")
  }

  const providerInstances = (
    clone as unknown as {
      provider_instances?: Record<
        string,
        {
          environment?: Array<UnknownRecord>
          config?: UnknownRecord
        }
      >
    }
  ).provider_instances
  for (const instance of Object.values(providerInstances ?? {})) {
    for (const envVar of instance.environment ?? []) {
      if (envVar.sensitive === true) encryptSecretProperty(envVar, "value")
    }
  }

  visitSensitiveNamedSettingsFields(clone, (record, key) =>
    encryptSecretProperty(record, key)
  )

  return clone
}

function encryptSecretProperty(record: UnknownRecord, key: string): void {
  const value = record[key]
  if (typeof value === "string" && value.length > 0)
    record[key] = encryptSecret(value)
}

function hasConfiguredSecrets(settings: Settings): boolean {
  const root = settings as unknown as UnknownRecord
  const mcpServers = root.mcp_servers as Array<UnknownRecord> | undefined
  if (
    (mcpServers ?? []).some(
      (server) =>
        typeof server.envVars === "string" && server.envVars.length > 0
    )
  ) {
    return true
  }
  const instances = root.provider_instances as
    | Record<
        string,
        { environment?: Array<UnknownRecord>; config?: UnknownRecord }
      >
    | undefined
  for (const instance of Object.values(instances ?? {})) {
    if (
      (instance.environment ?? []).some(
        (envVar) =>
          envVar.sensitive === true &&
          typeof envVar.value === "string" &&
          envVar.value.length > 0
      )
    ) {
      return true
    }
  }
  let configured = false
  visitSensitiveNamedSettingsFields(settings, (record, key) => {
    if (configuredSecret(record[key])) configured = true
  })
  return configured
}

function secretState(value: unknown): SecretState {
  return {
    configured: typeof value === "string" && value.length > 0,
    storage: getMasterKey() ? "encrypted" : "plaintext",
  }
}

function redactSettings(settings: Settings): UnknownRecord {
  const view = structuredClone(settings) as unknown as UnknownRecord
  const mcpServers = view.mcp_servers as Array<UnknownRecord> | undefined
  for (const server of mcpServers ?? [])
    server.envVars = secretState(server.envVars)

  const providerInstances = view.provider_instances as
    | Record<
        string,
        {
          environment?: Array<UnknownRecord>
          config?: UnknownRecord
        }
      >
    | undefined
  for (const instance of Object.values(providerInstances ?? {})) {
    for (const envVar of instance.environment ?? []) {
      if (envVar.sensitive !== true) continue
      const state = secretState(envVar.value)
      envVar.value = ""
      envVar.valueRedacted = state.configured
      envVar.secretState = state
    }
  }

  visitSensitiveNamedSettingsFields(view, (record, key) => {
    record[key] = secretState(record[key])
  })
  return view
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolveSecretUpdate(
  value: unknown,
  current: unknown,
  path: string
): string {
  const patch = secretPatchSchema.safeParse(value)
  if (patch.success) return "set" in patch.data ? patch.data.set : ""
  if (secretStateSchema.safeParse(value).success || value === undefined) {
    return typeof current === "string" ? current : ""
  }
  // Legacy renderers sent plaintext or null. Continue accepting them while
  // never returning plaintext from the current API.
  if (value === null) return ""
  if (typeof value === "string") return value
  throw new InvalidSettingsPatchError(
    `${path} must be { set: string } or { clear: true }`
  )
}

function explicitlyClearsSecret(value: unknown): boolean {
  const patch = secretPatchSchema.safeParse(value)
  return patch.success && "clear" in patch.data && patch.data.clear === true
}

function explicitlyMutatesSecret(value: unknown): boolean {
  return secretPatchSchema.safeParse(value).success
}

function configuredSecret(value: unknown): boolean {
  return typeof value === "string" && value.length > 0
}

/**
 * 9Router connections carry their own key. Keys are matched by connection id,
 * a redacted `secretState` keeps the stored key, and a URL change must clear
 * or re-enter the key so a stored credential never follows a new destination.
 */
function normalizeNineRouterConnectionsPatch(
  raw: unknown,
  current: unknown
): unknown {
  if (!Array.isArray(raw)) return raw
  const currentList = Array.isArray(current) ? current : []
  return raw.map((entry, index) => {
    if (!isUnknownRecord(entry)) return entry
    const previous = currentList.find(
      (candidate) => isUnknownRecord(candidate) && candidate.id === entry.id
    )
    const previousRecord = isUnknownRecord(previous) ? previous : {}
    if (
      configuredSecret(previousRecord.api_key) &&
      changesAnyField(entry, previousRecord, ["base_url"]) &&
      !explicitlyMutatesSecret(entry.api_key)
    ) {
      throw new InvalidSettingsPatchError(
        `providers.ninerouter.connections.${index} URL cannot change while preserving its stored API key; clear or re-enter the key first`
      )
    }
    return {
      ...entry,
      api_key: resolveSecretUpdate(
        entry.api_key,
        previousRecord.api_key,
        `providers.ninerouter.connections.${index}.api_key`
      ),
    }
  })
}

function changesAnyField(
  patch: UnknownRecord,
  current: UnknownRecord,
  keys: readonly string[]
): boolean {
  return keys.some(
    (key) => key in patch && !Object.is(patch[key], current[key])
  )
}

function instanceHasConfiguredSecrets(instance: UnknownRecord): boolean {
  const environment = Array.isArray(instance.environment)
    ? instance.environment
    : []
  if (
    environment.some(
      (entry) =>
        isUnknownRecord(entry) &&
        entry.sensitive === true &&
        configuredSecret(entry.value)
    )
  ) {
    return true
  }
  const config = isUnknownRecord(instance.config) ? instance.config : {}
  let configured = false
  visitProviderInstanceConfigSecrets(config, (record, key) => {
    if (configuredSecret(record[key])) configured = true
  })
  return configured
}

function instanceSecretsExplicitlyMutated(
  currentInstance: UnknownRecord,
  rawInstance: UnknownRecord
): boolean {
  const currentConfig = isUnknownRecord(currentInstance.config)
    ? currentInstance.config
    : {}
  const rawConfig = isUnknownRecord(rawInstance.config)
    ? rawInstance.config
    : {}
  let configSecretsMutated = true
  visitProviderInstanceConfigSecrets(
    currentConfig,
    (record, key, configPath) => {
      if (
        configuredSecret(record[key]) &&
        !explicitlyMutatesSecret(configValueAtPath(rawConfig, configPath))
      ) {
        configSecretsMutated = false
      }
    }
  )
  if (!configSecretsMutated) return false

  const currentEnvironment = Array.isArray(currentInstance.environment)
    ? currentInstance.environment
    : []
  const rawEnvironment = Array.isArray(rawInstance.environment)
    ? rawInstance.environment
    : []
  for (const currentEntry of currentEnvironment) {
    if (
      !isUnknownRecord(currentEntry) ||
      currentEntry.sensitive !== true ||
      !configuredSecret(currentEntry.value)
    ) {
      continue
    }
    const rawEntry = rawEnvironment.find(
      (entry) => isUnknownRecord(entry) && entry.name === currentEntry.name
    )
    if (
      !isUnknownRecord(rawEntry) ||
      (!explicitlyMutatesSecret(rawEntry.value) &&
        !explicitlyMutatesSecret(rawEntry.secretState))
    ) {
      return false
    }
  }
  return true
}

function environmentChanges(
  currentEnvironment: unknown[],
  rawEnvironment: unknown[]
): boolean {
  if (currentEnvironment.length !== rawEnvironment.length) return true
  return rawEnvironment.some((rawEntry) => {
    if (!isUnknownRecord(rawEntry) || typeof rawEntry.name !== "string")
      return true
    const currentEntry = currentEnvironment.find(
      (entry) => isUnknownRecord(entry) && entry.name === rawEntry.name
    )
    if (!isUnknownRecord(currentEntry)) return true
    if (
      "sensitive" in rawEntry &&
      !Object.is(rawEntry.sensitive, currentEntry.sensitive)
    ) {
      return true
    }
    const redactedSecret =
      currentEntry.sensitive === true &&
      configuredSecret(currentEntry.value) &&
      (rawEntry.valueRedacted === true ||
        secretStateSchema.safeParse(rawEntry.secretState).success) &&
      !explicitlyMutatesSecret(rawEntry.value) &&
      !explicitlyMutatesSecret(rawEntry.secretState)
    return (
      !redactedSecret &&
      "value" in rawEntry &&
      !Object.is(rawEntry.value, currentEntry.value)
    )
  })
}

function normalizeSettingsPatch(
  settings: Settings,
  patch: UnknownRecord
): UnknownRecord {
  const normalized = structuredClone(patch) as UnknownRecord
  const current = settings as unknown as UnknownRecord
  const removedProviderInstanceIds = readRemovedProviderInstanceIds(
    patch.remove_provider_instance_ids
  )
  delete normalized.remove_provider_instance_ids

  if (isUnknownRecord(patch.providers)) {
    const currentProviders = isUnknownRecord(current.providers)
      ? current.providers
      : {}
    const nextProviders = structuredClone(currentProviders) as UnknownRecord
    for (const [providerId, rawConfig] of Object.entries(patch.providers)) {
      if (!isUnknownRecord(rawConfig)) {
        nextProviders[providerId] = rawConfig
        continue
      }
      const currentConfig = isUnknownRecord(currentProviders[providerId])
        ? (currentProviders[providerId] as UnknownRecord)
        : {}
      const currentApiKeys = Array.isArray(currentConfig.api_keys)
        ? currentConfig.api_keys
        : []
      if (
        changesAnyField(rawConfig, currentConfig, PROVIDER_DESTINATION_KEYS) &&
        currentApiKeys.some(
          (entry) => isUnknownRecord(entry) && configuredSecret(entry.api_key)
        )
      ) {
        throw new InvalidSettingsPatchError(
          `providers.${providerId} destination cannot change while API keys are stored; remove the keys first`
        )
      }
      if (
        changesAnyField(rawConfig, currentConfig, PROVIDER_DESTINATION_KEYS) &&
        PROVIDER_SECRET_KEYS.some(
          (key) =>
            configuredSecret(currentConfig[key]) &&
            !explicitlyMutatesSecret(rawConfig[key])
        )
      ) {
        throw new InvalidSettingsPatchError(
          `providers.${providerId} destination cannot change while preserving stored credentials; clear or re-enter the secret first`
        )
      }
      const nextConfig = { ...currentConfig, ...structuredClone(rawConfig) }
      if ("api_keys" in rawConfig) {
        if (
          !["anthropic", "openai", "grok"].includes(providerId) ||
          (rawConfig.api_keys !== null && !Array.isArray(rawConfig.api_keys))
        )
          throw new InvalidSettingsPatchError(
            `providers.${providerId}.api_keys must be a supported provider's key list`
          )
        nextConfig.api_keys =
          rawConfig.api_keys === null
            ? undefined
            : rawConfig.api_keys.map((entry, index) => {
                if (!isUnknownRecord(entry)) return entry
                const previous = currentApiKeys.find(
                  (key) => isUnknownRecord(key) && key.id === entry.id
                )
                return {
                  ...entry,
                  api_key: resolveSecretUpdate(
                    entry.api_key,
                    isUnknownRecord(previous) ? previous.api_key : undefined,
                    `providers.${providerId}.api_keys.${index}.api_key`
                  ),
                }
              })
      }
      if (providerId === "ninerouter" && "connections" in rawConfig) {
        nextConfig.connections = normalizeNineRouterConnectionsPatch(
          rawConfig.connections,
          currentConfig.connections
        )
      }
      for (const key of PROVIDER_SECRET_KEYS) {
        if (key in rawConfig) {
          nextConfig[key] = resolveSecretUpdate(
            rawConfig[key],
            currentConfig[key],
            `providers.${providerId}.${key}`
          )
        }
      }
      nextProviders[providerId] = nextConfig
    }
    normalized.providers = nextProviders
  }

  if (Array.isArray(patch.mcp_servers)) {
    const currentServers = Array.isArray(current.mcp_servers)
      ? current.mcp_servers
      : []
    normalized.mcp_servers = patch.mcp_servers.map((rawServer, index) => {
      if (!isUnknownRecord(rawServer)) return rawServer
      const currentServer = currentServers.find(
        (item) => isUnknownRecord(item) && item.id === rawServer.id
      )
      const currentRecord = isUnknownRecord(currentServer) ? currentServer : {}
      if (
        configuredSecret(currentRecord.envVars) &&
        changesAnyField(rawServer, currentRecord, ["command", "args"]) &&
        !explicitlyMutatesSecret(rawServer.envVars)
      ) {
        throw new InvalidSettingsPatchError(
          `mcp_servers.${index} command cannot change while preserving stored environment secrets; clear or re-enter envVars first`
        )
      }
      return {
        ...rawServer,
        envVars: resolveSecretUpdate(
          rawServer.envVars,
          currentRecord.envVars,
          `mcp_servers.${index}.envVars`
        ),
      }
    })
  }

  if (
    isUnknownRecord(patch.provider_instances) ||
    removedProviderInstanceIds.length > 0
  ) {
    const currentInstances = isUnknownRecord(current.provider_instances)
      ? current.provider_instances
      : {}
    const nextInstances = structuredClone(currentInstances) as UnknownRecord
    const patchedInstances = isUnknownRecord(patch.provider_instances)
      ? patch.provider_instances
      : {}
    for (const [instanceId, rawInstance] of Object.entries(patchedInstances)) {
      if (!isUnknownRecord(rawInstance)) {
        nextInstances[instanceId] = rawInstance
        continue
      }
      const currentInstance = isUnknownRecord(currentInstances[instanceId])
        ? (currentInstances[instanceId] as UnknownRecord)
        : {}
      const currentInstanceConfig = isUnknownRecord(currentInstance.config)
        ? currentInstance.config
        : {}
      const rawInstanceConfig = isUnknownRecord(rawInstance.config)
        ? rawInstance.config
        : {}
      const currentEnvironment = Array.isArray(currentInstance.environment)
        ? currentInstance.environment
        : []
      const rawEnvironment = Array.isArray(rawInstance.environment)
        ? rawInstance.environment
        : []
      if (
        Array.isArray(rawInstance.environment) &&
        instanceHasConfiguredSecrets(currentInstance) &&
        environmentChanges(currentEnvironment, rawEnvironment) &&
        !instanceSecretsExplicitlyMutated(currentInstance, rawInstance)
      ) {
        throw new InvalidSettingsPatchError(
          `provider_instances.${instanceId}.environment cannot change while preserving stored credentials; clear or re-enter every secret first`
        )
      }
      if (
        instanceHasConfiguredSecrets(currentInstance) &&
        (("driver" in rawInstance &&
          !Object.is(rawInstance.driver, currentInstance.driver)) ||
          changesAnyField(
            rawInstanceConfig,
            currentInstanceConfig,
            PROVIDER_DESTINATION_KEYS
          ))
      ) {
        throw new InvalidSettingsPatchError(
          `provider_instances.${instanceId} destination cannot change while stored credentials exist; clear them before changing the driver or endpoint`
        )
      }
      const nextInstance = {
        ...structuredClone(currentInstance),
        ...structuredClone(rawInstance),
      } as UnknownRecord
      if (isUnknownRecord(rawInstance.config)) {
        const currentConfig = isUnknownRecord(currentInstance.config)
          ? currentInstance.config
          : {}
        const normalizedConfig = normalizeProviderInstanceConfigPatch(
          rawInstance.config,
          currentConfig,
          instanceId
        ) as UnknownRecord
        const nextConfig = { ...currentConfig, ...normalizedConfig }
        nextInstance.config = nextConfig
      }
      if (Array.isArray(rawInstance.environment)) {
        nextInstance.environment = rawInstance.environment.map(
          (rawEnv, index) => {
            if (!isUnknownRecord(rawEnv)) return rawEnv
            if (
              typeof rawEnv.name === "string" &&
              isUnsafeChildEnvironmentKey(rawEnv.name)
            ) {
              throw new InvalidSettingsPatchError(
                `provider_instances.${instanceId}.environment.${index}.name is not allowed`
              )
            }
            const currentEnv = currentEnvironment.find(
              (item) => isUnknownRecord(item) && item.name === rawEnv.name
            )
            const currentRecord = isUnknownRecord(currentEnv) ? currentEnv : {}
            const currentIsConfiguredSecret =
              currentRecord.sensitive === true &&
              typeof currentRecord.value === "string" &&
              currentRecord.value.length > 0
            const clearsSecret =
              explicitlyClearsSecret(rawEnv.value) ||
              explicitlyClearsSecret(rawEnv.secretState)
            if (
              currentIsConfiguredSecret &&
              rawEnv.sensitive === false &&
              !clearsSecret
            ) {
              throw new InvalidSettingsPatchError(
                `provider_instances.${instanceId}.environment.${index}.sensitive cannot be disabled until the stored secret is cleared`
              )
            }
            const isRedacted =
              rawEnv.valueRedacted === true ||
              secretStateSchema.safeParse(rawEnv.secretState).success
            const value = isRedacted
              ? resolveSecretUpdate(
                  rawEnv.secretState,
                  currentRecord.value,
                  `provider_instances.${instanceId}.environment.${index}.value`
                )
              : resolveSecretUpdate(
                  rawEnv.value,
                  currentRecord.value,
                  `provider_instances.${instanceId}.environment.${index}.value`
                )
            const {
              valueRedacted: _valueRedacted,
              secretState: _secretState,
              ...cleanEnv
            } = rawEnv
            return {
              ...cleanEnv,
              ...(currentIsConfiguredSecret && !clearsSecret
                ? { sensitive: true }
                : {}),
              value,
            }
          }
        )
      }
      nextInstances[instanceId] = nextInstance
    }
    for (const instanceId of removedProviderInstanceIds) {
      delete nextInstances[instanceId]
    }
    normalized.provider_instances = nextInstances
  }

  for (const key of TOP_LEVEL_SECRET_KEYS) {
    if (key in patch)
      normalized[key] = resolveSecretUpdate(patch[key], current[key], key)
  }
  return normalized
}

function readRemovedProviderInstanceIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new InvalidSettingsPatchError(
      "remove_provider_instance_ids must be an array of provider instance IDs"
    )
  }
  const ids = new Set<string>()
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(item)
    ) {
      throw new InvalidSettingsPatchError(
        "remove_provider_instance_ids contains an invalid provider instance ID"
      )
    }
    ids.add(item)
  }
  return [...ids]
}

/**
 * Port of rust-backend/src/settings/service.rs. Loads settings.json at
 * construction, exposes get/update, and emits a `change` event for subscribers
 * (e.g. runtime-config re-injection on the WebSocket). File-system watching
 * is deferred to Phase 11 (chokidar) — the Rust implementation also doesn't
 * live-watch, callers mutate through this service and it writes-then-emits.
 *
 * All reads and writes are validated through the Zod schema via safeParse().
 * On validation failure the service falls back to defaults (reads) or rejects
 * the patch (writes) — it never crashes.
 *
 * Provider `api_key` values are encrypted at rest via AES-256-GCM when a
 * master key is available (supplied by the Electron host through
 * `BETTERC0DE_SETTINGS_KEY`); see `./crypto.ts`.  Existing plaintext keys
 * are decrypted transparently on load and re-encrypted on the first write.
 */
export class SettingsService extends EventEmitter {
  private settings: Settings
  private undecryptableSecretPaths: readonly string[]
  private writeBlockedReason: string | null
  /** Stamp of the on-disk file the in-memory state was loaded from or wrote. */
  private fileStamp: SettingsFileStamp | null
  /** Redacted view, rebuilt lazily after every change (see getPublic). */
  private publicView: UnknownRecord | null = null

  constructor(private readonly filePath: string) {
    super()
    const {
      settings,
      sawPlaintext,
      undecryptableSecretPaths,
      writeBlockedReason,
      fileStamp,
    } = SettingsService.loadFromFile(filePath)
    this.settings = deepFreeze(settingsSchema.parse(settings))
    this.undecryptableSecretPaths = undecryptableSecretPaths
    this.writeBlockedReason = writeBlockedReason
    this.fileStamp = fileStamp
    // Lazy-migrate legacy plaintext keys to encrypted form on disk.  Only
    // runs when a master key is configured — without one we can't improve
    // the on-disk state, so we leave the file untouched.
    if (
      sawPlaintext &&
      undecryptableSecretPaths.length === 0 &&
      writeBlockedReason === null &&
      getMasterKey()
    ) {
      try {
        this.persist()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(
          `[SettingsService] failed to upgrade plaintext secrets: ${message}`
        )
      }
    }
  }

  /**
   * Load and validate settings from disk.  Returns defaults when the file is
   * missing, unreadable, or fails validation. Distinguishes missing vs corrupt
   * — missing is silent, any other failure (bad JSON, permission, etc.) warns.
   *
   * Also decrypts provider `api_key` values in place so the rest of the
   * service operates on plaintext.  Returns `sawPlaintext: true` when at
   * least one provider key was not encrypted, letting the constructor
   * opportunistically upgrade legacy settings files on the next write.
   */
  /**
   * Defaults for a file that exists but cannot be applied. A missing file
   * keeps the product default, including auto-trust. A present file that
   * we refuse to parse must not turn auto-trust back on.
   */
  private static settingsForUnusableFile(): Settings {
    return { ...defaultSettings(), auto_trust_workspaces: false }
  }

  private static loadFromFile(filePath: string): SettingsLoadResult {
    let fileStamp: SettingsFileStamp | null
    try {
      fileStamp = readSettingsFileStamp(filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        settings: this.settingsForUnusableFile(),
        sawPlaintext: false,
        undecryptableSecretPaths: [],
        writeBlockedReason: `settings.json metadata could not be read: ${message}`,
        fileStamp: null,
      }
    }
    if (fileStamp === null) {
      return {
        settings: defaultSettings(),
        sawPlaintext: false,
        undecryptableSecretPaths: [],
        writeBlockedReason: null,
        fileStamp: null,
      }
    }
    let raw: string
    try {
      raw = fs.readFileSync(filePath, "utf8")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(
        `[SettingsService] failed to read settings.json at ${filePath}: ${message} — using defaults`
      )
      return {
        settings: this.settingsForUnusableFile(),
        sawPlaintext: false,
        undecryptableSecretPaths: [],
        writeBlockedReason: `settings.json could not be read: ${message}`,
        fileStamp,
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(
        `[SettingsService] settings.json is not valid JSON (${message}) — using defaults. File left on disk at ${filePath} for manual inspection.`
      )
      return {
        settings: this.settingsForUnusableFile(),
        sawPlaintext: false,
        undecryptableSecretPaths: [],
        writeBlockedReason: `settings.json is not valid JSON: ${message}`,
        fileStamp,
      }
    }
    const result = settingsSchema.safeParse(parsed)
    if (!result.success) {
      console.warn(
        "[SettingsService] settings.json failed validation, using defaults:",
        result.error.message
      )
      return {
        settings: this.settingsForUnusableFile(),
        sawPlaintext: false,
        undecryptableSecretPaths: [],
        writeBlockedReason: `settings.json failed validation: ${result.error.message}`,
        fileStamp,
      }
    }
    const secretState = decryptSettingsSecrets(result.data)
    return {
      settings: result.data,
      ...secretState,
      writeBlockedReason: null,
      fileStamp,
    }
  }

  /** Return the immutable snapshot validated at load/update time. */
  get(): Settings {
    return this.settings
  }

  /**
   * Return renderer-safe settings metadata without exposing secret values.
   *
   * The redacted view is computed once per settings version and frozen: the
   * renderer polls GET /settings, and a fresh `structuredClone` of the whole
   * object per request showed up in backend profiles. Callers must treat the
   * result as read-only — that was already the contract, now it is enforced.
   */
  getPublic(): UnknownRecord {
    if (!this.publicView) {
      this.publicView = deepFreeze(redactSettings(this.get()))
    }
    return this.publicView
  }

  private replaceSettings(next: Settings): void {
    this.settings = next
    this.publicView = null
  }

  /**
   * Pick up an edit made to settings.json by something other than this
   * service (a text editor, another BetterC0de instance). The file is only
   * re-read and re-parsed when its stamp moved; before this, every `update()`
   * paid for a full read + parse + decrypt even when nothing had changed.
   */
  private reloadIfFileChanged(): void {
    const currentStamp = readSettingsFileStamp(this.filePath)
    if (
      sameSettingsFileStamp(currentStamp, this.fileStamp) &&
      this.writeBlockedReason === null
    )
      return
    const latest = SettingsService.loadFromFile(this.filePath)
    this.writeBlockedReason = latest.writeBlockedReason
    this.undecryptableSecretPaths = latest.undecryptableSecretPaths
    this.fileStamp = latest.fileStamp
    if (latest.writeBlockedReason === null) {
      this.replaceSettings(deepFreeze(settingsSchema.parse(latest.settings)))
    }
  }

  /**
   * Merge `patch` into the current settings.  The merged object is validated
   * before it is persisted — if it fails validation the patch is rejected and
   * the previous settings are returned unchanged.
   *
   * Change listeners run after the write lock is released: a listener that
   * itself reads or writes settings must not observe the lock as held.
   */
  update(patch: Record<string, unknown>): Settings {
    const next = this.withWriteLock(() => {
      this.reloadIfFileChanged()
      if (this.writeBlockedReason) {
        throw new InvalidSettingsPatchError(
          `${this.writeBlockedReason}. Writes are disabled until the file is repaired or removed.`
        )
      }
      if (this.undecryptableSecretPaths.length > 0) {
        throw new InvalidSettingsPatchError(
          `Settings contain encrypted secrets that cannot be decrypted (${this.undecryptableSecretPaths.join(", ")}). Writes are disabled until the original encryption key is restored.`
        )
      }

      const previous = this.settings
      const normalizedPatch = normalizeSettingsPatch(previous, patch)
      const merged = {
        ...(previous as unknown as Record<string, unknown>),
        ...normalizedPatch,
      }
      const result = settingsSchema.safeParse(merged)
      if (!result.success) {
        console.warn(
          "[SettingsService] update rejected — patch failed validation:",
          result.error.message
        )
        const fields = [
          ...new Set(
            result.error.issues.flatMap((issue) =>
              issue.code === "unrecognized_keys"
                ? issue.keys.map((key) => [...issue.path, key].join("."))
                : [issue.path.join(".") || "settings"]
            )
          ),
        ]
        throw new InvalidSettingsPatchError(
          `Invalid settings fields: ${fields.join(", ")}. Check the values and try again.`
        )
      }
      this.replaceSettings(deepFreeze(result.data))
      try {
        this.persist()
      } catch (error) {
        this.replaceSettings(previous)
        throw error
      }
      return this.settings
    })
    this.emitChangeSafely()
    return next
  }

  private emitChangeSafely(): void {
    for (const listener of this.rawListeners("change")) {
      try {
        Reflect.apply(listener, this, [this.settings])
      } catch (error) {
        const message =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        console.error(
          `[SettingsService] change listener failed after settings were persisted: ${message}`
        )
      }
    }
  }

  /** Persist an update and return only the redacted renderer contract. */
  updatePublic(patch: Record<string, unknown>): UnknownRecord {
    this.update(patch)
    return this.getPublic()
  }

  private withWriteLock<T>(operation: () => T): T {
    const lockPath = `${this.filePath}.lock`
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    let fd: number
    try {
      fd = fs.openSync(lockPath, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let stale = false
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > 30_000
      } catch {
        // The lock disappeared between open and stat; retry once below.
        stale = true
      }
      if (!stale) {
        throw new InvalidSettingsPatchError(
          "Another settings write is already in progress; retry shortly."
        )
      }
      try {
        fs.unlinkSync(lockPath)
        fd = fs.openSync(lockPath, "wx", 0o600)
      } catch {
        throw new InvalidSettingsPatchError(
          "Could not recover a stale settings write lock; retry shortly."
        )
      }
    }
    try {
      return operation()
    } finally {
      try {
        fs.closeSync(fd)
      } finally {
        try {
          fs.unlinkSync(lockPath)
        } catch {
          // A stale lock can be removed safely on the next write attempt.
        }
      }
    }
  }

  private persist(): void {
    if (
      !getMasterKey() &&
      hasConfiguredSecrets(this.settings) &&
      process.env.BETTERC0DE_ALLOW_PLAINTEXT_SECRETS !== "1"
    ) {
      throw new InvalidSettingsPatchError(
        "Secret persistence requires encrypted storage. Set BETTERC0DE_ALLOW_PLAINTEXT_SECRETS=1 only for an explicitly accepted local fallback."
      )
    }
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    // Atomic write: write-to-tmp + fsync + rename. Protects against truncating
    // the real file on power loss or crash mid-write; before this change a
    // partial write would corrupt settings.json and the loader would silently
    // return defaults on next boot.
    // Secrets (provider api_keys) are encrypted via AES-256-GCM before the
    // JSON payload is written; the in-memory `this.settings` keeps plaintext
    // so `get()` callers don't have to decrypt on every read.
    const tmpPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    const forDisk = encryptSettingsForDisk(this.settings)
    const payload = JSON.stringify(forDisk, null, 2)
    let fd: number | null = null
    let wroteOk = false
    try {
      fd = fs.openSync(tmpPath, "wx", 0o600)
      fs.fchmodSync(fd, 0o600)
      fs.writeFileSync(fd, payload, "utf8")
      fs.fsyncSync(fd)
      wroteOk = true
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* closing a failed fd is best-effort */
        }
      }
      if (!wroteOk && fd !== null) {
        try {
          fs.unlinkSync(tmpPath)
        } catch {
          /* tmp cleanup is best-effort */
        }
      }
    }
    try {
      fs.renameSync(tmpPath, this.filePath)
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        /* tmp cleanup is best-effort */
      }
      throw err
    }
    // Rename committed the new settings. A metadata cache failure must not
    // make update() roll memory back while disk already contains the patch.
    try {
      this.fileStamp = readSettingsFileStamp(this.filePath)
    } catch {
      this.fileStamp = null
    }
  }
}
