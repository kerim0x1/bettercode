import { isSensitiveProviderFieldName } from "@betterc0de/schema"
import { getMasterKey } from "../../settings/crypto"
import type {
  ProviderAdapterShape,
  ProviderInstanceMetadata,
  ProviderRuntimeEvent,
} from "./contracts"
import {
  normalizeProviderModels,
  readAdapterModels,
  type ProviderCatalogs,
} from "./ProviderCatalogs"
import { promiseWithDeadline } from "./ProviderHubErrors"
import type {
  ProviderRuntimeInstance,
  ProviderRuntimeInstanceSnapshot,
  ProviderRuntimeInstanceStatusProbe,
} from "./ProviderHubTypes"
import { createProviderVersionAdvisory } from "./ProviderMaintenance"
import {
  recordConfig,
  type ProviderMaintenanceCoordinator,
} from "./ProviderMaintenanceCoordinator"
import {
  ProviderMetadataCache,
  ProviderMetadataCapacityError,
  boundedProviderLimit,
  hydrateAndPersistInstanceSnapshot,
  normalizeProviderMetadataCwd,
  providerMetadataCwdKey,
  toSnapshotMetadata,
} from "./ProviderMetadataCache"
import { filterRuntimeModelsByProjectPolicy } from "./projectProviderPolicy"

/** What the status service needs from the hub that owns the instances. */
export interface ProviderStatusServiceHost {
  /** The registered instances: a live iterator, not a snapshot. */
  instances(): IterableIterator<ProviderRuntimeInstance>
  getInstance(instanceId: string): ProviderRuntimeInstance | undefined
  isQuarantined(adapter: ProviderAdapterShape): boolean
  /** Why this backend failed to retire, or undefined. */
  retirementFailureOf(adapter: ProviderAdapterShape): unknown
  assertAcceptingWork(operation: string): void
}

export interface ProviderStatusServiceOptions {
  readonly statusCacheDir?: string | null
  readonly catalogs: ProviderCatalogs
  readonly maintenance: ProviderMaintenanceCoordinator
  /** The hub's interrupt budget; a status probe gets at least this long. */
  readonly interruptTimeoutMs: number
  readonly metadataConcurrencyLimit?: number
  readonly metadataQueueMaxEntries?: number
  readonly metadataInFlightMaxEntries?: number
  readonly listInstancesInFlightMaxEntries?: number
}

/**
 * The provider status surface: per-instance snapshots (install, auth,
 * version advisory, models, metadata) with coalesced concurrent listings, the
 * metadata cache behind them, and the on-disk status cache. It reads the
 * instances, their quarantine and their retirement failures from the hub
 * through {@link ProviderStatusServiceHost}; it never dispatches anything.
 */
export class ProviderStatusService {
  private static readonly LIST_INSTANCES_IN_FLIGHT_MAX_ENTRIES = 64
  private readonly metadataCache: ProviderMetadataCache
  private readonly listInstancesInFlightMaxEntries: number
  private readonly statusCacheDir: string | null
  private readonly catalogs: ProviderCatalogs
  private readonly maintenance: ProviderMaintenanceCoordinator
  private readonly interruptTimeoutMs: number

  constructor(
    private readonly host: ProviderStatusServiceHost,
    options: ProviderStatusServiceOptions
  ) {
    this.statusCacheDir = options.statusCacheDir ?? null
    this.catalogs = options.catalogs
    this.maintenance = options.maintenance
    this.interruptTimeoutMs = options.interruptTimeoutMs
    this.metadataCache = new ProviderMetadataCache({
      concurrencyLimit: options.metadataConcurrencyLimit,
      queueMaxEntries: options.metadataQueueMaxEntries,
      inFlightMaxEntries: options.metadataInFlightMaxEntries,
      probeTimeoutMs: Math.max(
        this.interruptTimeoutMs,
        ProviderMetadataCache.PROBE_TIMEOUT_MS
      ),
    })
    this.listInstancesInFlightMaxEntries = boundedProviderLimit(
      options.listInstancesInFlightMaxEntries,
      ProviderStatusService.LIST_INSTANCES_IN_FLIGHT_MAX_ENTRIES
    )
  }

  /** Drops cached metadata of instances that are no longer registered. */
  retainInstances(instanceIds: ReadonlySet<string>): void {
    this.metadataCache.retainInstances(instanceIds)
  }

  /** Drops every cached metadata entry of one instance. */
  invalidateInstanceCache(instanceId: string): void {
    this.metadataCache.invalidateInstance(instanceId)
  }

  /** Listings and metadata probes still in flight, for a bounded shutdown wait. */
  pendingOperations(): Promise<unknown>[] {
    return [
      ...this.listInstancesInFlight.values(),
      ...this.metadataCache.inFlightPromises(),
    ]
  }

  // Concurrent listInstances calls with the same cwd share one in-flight
  // promise. The frontend fans out (multiple mounted hooks × 30s poll ×
  // StrictMode) and every uncoalesced call used to trigger its own round
  // of status/model probes — i.e. child-process spawns — per instance.
  private readonly listInstancesInFlight = new Map<
    string,
    Promise<ProviderRuntimeInstanceSnapshot[]>
  >()

  listInstances(
    input: { readonly cwd?: string | null } = {}
  ): Promise<ProviderRuntimeInstanceSnapshot[]> {
    this.host.assertAcceptingWork("list provider instances")
    const cwd = normalizeProviderMetadataCwd(input.cwd)
    const key = providerMetadataCwdKey(cwd)
    const inFlight = this.listInstancesInFlight.get(key)
    if (inFlight) return inFlight
    if (
      this.listInstancesInFlight.size >= this.listInstancesInFlightMaxEntries
    ) {
      return Promise.reject(new ProviderMetadataCapacityError())
    }
    const promise = this.listInstancesUncoalesced({ cwd }).finally(() => {
      if (this.listInstancesInFlight.get(key) === promise) {
        this.listInstancesInFlight.delete(key)
      }
    })
    this.listInstancesInFlight.set(key, promise)
    return promise
  }

  private async listInstancesUncoalesced(
    input: { readonly cwd?: string | null } = {}
  ): Promise<ProviderRuntimeInstanceSnapshot[]> {
    const projectPolicy = await this.catalogs.loadProjectPolicy(
      input.cwd ?? null
    )
    return Promise.all(
      Array.from(this.host.instances()).map(async (instance) => {
        const quarantine = this.host.isQuarantined(instance.adapter)
        const retirementFailure = this.host.retirementFailureOf(
          instance.adapter
        )
        const probe = quarantine
          ? null
          : await readInstanceStatusProbe(
              instance,
              { cwd: input.cwd ?? null },
              Math.max(
                this.interruptTimeoutMs,
                ProviderMetadataCache.PROBE_TIMEOUT_MS
              )
            )
        const effectiveUnavailableReason = quarantine
          ? "Provider instance is temporarily unavailable."
          : instance.unavailableReason
            ? "Provider instance is unavailable."
            : undefined
        const installed =
          probe?.installed ?? instance.installed ?? !instance.unavailableReason
        const configured =
          probe?.configured ??
          (!quarantine &&
            instance.enabled &&
            installed &&
            !instance.unavailableReason &&
            instance.adapter.isConfigured())
        const availability: ProviderRuntimeInstanceSnapshot["availability"] =
          effectiveUnavailableReason ? "unavailable" : "available"
        const cursorProbeUnavailable =
          instance.driver === "cursor" && instance.enabled && !probe
        const authStatus: ProviderRuntimeInstanceSnapshot["auth"]["status"] =
          probe?.auth?.status ??
          (cursorProbeUnavailable
            ? "unknown"
            : configured
              ? "authenticated"
              : "unknown")
        const checkedAt = new Date().toISOString()
        const status = quarantine
          ? "error"
          : cursorProbeUnavailable
            ? "warning"
            : (probe?.status ??
              providerSnapshotStatus({
                enabled: instance.enabled,
                installed,
                configured,
                unavailable: Boolean(instance.unavailableReason),
              }))
        const version = probe?.version ?? instance.version ?? null
        const config = recordConfig(instance.config)
        const environment = redactEnvironment(instance.environment ?? [])
        const maintenanceCapabilities =
          this.maintenance.capabilitiesFor(instance)
        const latestVersion =
          instance.enabled && installed && version
            ? await this.maintenance.latestVersionFor(maintenanceCapabilities)
            : null
        const message = publicProviderStatusMessage({
          enabled: instance.enabled,
          installed,
          configured,
          unavailableReason: effectiveUnavailableReason,
          probe,
        })
        const [metadata, models] = configured
          ? await Promise.all([
              this.metadataCache.read(instance, input.cwd, { force: false }),
              readAdapterModels(instance.adapter),
            ])
          : ([null, []] as const)
        const policyModels = filterRuntimeModelsByProjectPolicy(
          instance,
          models,
          projectPolicy
        )
        const cursorModelMessage =
          instance.driver === "cursor" && configured && models.length === 0
            ? "Cursor Agent did not provide selectable models through ACP. Check the CLI login, then refresh this provider."
            : undefined
        const snapshot = {
          instanceId: instance.instanceId,
          driver: instance.driver,
          displayName: instance.displayName ?? instance.adapter.displayName,
          ...(instance.accentColor
            ? { accentColor: instance.accentColor }
            : {}),
          enabled: instance.enabled,
          configured,
          installed,
          version,
          status: cursorModelMessage ? "warning" : status,
          auth: {
            status: authStatus,
            ...(probe?.auth?.type ? { type: probe.auth.type } : {}),
            ...(probe?.auth?.label ? { label: probe.auth.label } : {}),
            ...(probe?.auth?.email ? { email: probe.auth.email } : {}),
          },
          checkedAt,
          ...(cursorModelMessage || message || cursorProbeUnavailable
            ? {
                message:
                  cursorModelMessage ??
                  message ??
                  "Cursor Agent status could not be verified. Refresh this provider.",
              }
            : {}),
          availability,
          versionAdvisory: createProviderVersionAdvisory({
            driver: instance.driver,
            currentVersion: version,
            latestVersion,
            checkedAt,
            maintenanceCapabilities,
          }),
          ...(effectiveUnavailableReason
            ? { unavailableReason: effectiveUnavailableReason }
            : {}),
          ...(retirementFailure !== undefined
            ? {
                retirementFailure:
                  retirementFailure instanceof Error
                    ? retirementFailure.message
                    : String(retirementFailure),
              }
            : {}),
          ...(instance.continuationKey
            ? {
                continuation: { groupKey: instance.continuationKey },
                continuationKey: instance.continuationKey,
              }
            : {}),
          showInteractionModeToggle: true,
          environment,
          config: redactProviderConfig(config),
          capabilities: instance.adapter.capabilities,
          models: normalizeProviderModels(policyModels),
          providerCatalog: metadata?.providerCatalog ?? [],
          skills: metadata?.skills ?? [],
          agents: metadata?.agents ?? [],
          tools: metadata?.tools ?? [],
          slashCommands: metadata?.slashCommands ?? [],
          ...(this.maintenance.updateStateFor(instance.instanceId)
            ? {
                updateState: this.maintenance.updateStateFor(
                  instance.instanceId
                ),
              }
            : {}),
          ...(metadata ? { metadata: toSnapshotMetadata(metadata) } : {}),
        }
        return await hydrateAndPersistInstanceSnapshot(
          this.statusCacheDir,
          snapshot
        )
      })
    )
  }

  async refreshInstanceMetadata(
    instanceId: string,
    input: { readonly cwd?: string | null } = {}
  ): Promise<ProviderInstanceMetadata | null> {
    this.host.assertAcceptingWork("refresh provider metadata")
    const instance = this.host.getInstance(instanceId)
    if (
      !instance ||
      !instance.enabled ||
      instance.unavailableReason ||
      this.host.isQuarantined(instance.adapter) ||
      !instance.adapter.isConfigured()
    ) {
      return null
    }
    if (instance.statusProbe) {
      await readInstanceStatusProbe(
        instance,
        { cwd: input.cwd, refresh: true },
        Math.max(
          this.interruptTimeoutMs,
          ProviderMetadataCache.PROBE_TIMEOUT_MS
        )
      )
    }
    const metadata = await this.metadataCache.read(instance, input.cwd, {
      force: true,
    })
    await readAdapterModels(instance.adapter, { force: true })
    return toSnapshotMetadata(metadata)
  }

  invalidateInstanceMetadata(instanceId: string, cwd?: string | null): void {
    const normalizedCwd =
      cwd === undefined ? undefined : normalizeProviderMetadataCwd(cwd)
    const instance = this.host.getInstance(instanceId)
    if (instance && !this.host.isQuarantined(instance.adapter)) {
      instance.adapter.invalidateMetadata?.(
        normalizedCwd === undefined ? undefined : { cwd: normalizedCwd }
      )
    }
    this.metadataCache.invalidate(instanceId, normalizedCwd)
  }
}

async function readInstanceStatusProbe(
  instance: ProviderRuntimeInstance,
  input: { readonly cwd?: string | null; readonly refresh?: boolean },
  timeoutMs: number
): Promise<ProviderRuntimeInstanceStatusProbe | null> {
  if (
    !instance.enabled ||
    instance.unavailableReason ||
    !instance.statusProbe
  ) {
    return null
  }
  try {
    return await promiseWithDeadline(
      () => Promise.resolve(instance.statusProbe!(input)),
      timeoutMs,
      `Provider status probe did not complete within ${timeoutMs}ms`
    )
  } catch {
    return null
  }
}

function providerSnapshotStatus(input: {
  readonly enabled: boolean
  readonly installed: boolean
  readonly configured: boolean
  readonly unavailable: boolean
}): "ready" | "warning" | "error" | "disabled" {
  if (!input.enabled) return "disabled"
  if (input.unavailable || !input.installed) return "error"
  return input.configured ? "ready" : "warning"
}

export function isProviderMetadataChangedEvent(
  event: ProviderRuntimeEvent
): boolean {
  if (event.type === "provider.metadata.changed") return true
  if (event.type !== "config.warning" || !("payload" in event)) return false
  const payload = event.payload
  return (
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "metadataKind" in payload
  )
}

export function readProviderMetadataChangedCwd(
  event: ProviderRuntimeEvent
): string | null | undefined {
  if (!("payload" in event)) return undefined
  const payload = event.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return undefined
  const cwd = (payload as Record<string, unknown>).cwd
  return typeof cwd === "string" || cwd === null ? cwd : undefined
}

function redactEnvironment(
  environment: NonNullable<ProviderRuntimeInstance["environment"]>
): NonNullable<ProviderRuntimeInstanceSnapshot["environment"]> {
  return environment.map((envVar) => {
    if (!envVar.sensitive && !isSensitiveProviderFieldName(envVar.name))
      return envVar
    const configured = envVar.value.length > 0
    return {
      ...envVar,
      sensitive: true,
      value: "",
      valueRedacted: configured,
      secretState: {
        configured,
        storage: getMasterKey() ? "encrypted" : "plaintext",
      },
    }
  })
}

function redactProviderConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  const redactValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redactValue)
    if (value !== null && typeof value === "object") {
      return redactProviderConfig(value as Record<string, unknown>)
    }
    return value
  }
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      isSensitiveProviderFieldName(key)
        ? {
            configured: typeof value === "string" && value.length > 0,
            storage: getMasterKey() ? "encrypted" : "plaintext",
          }
        : redactValue(value),
    ])
  )
}

function publicProviderStatusMessage(input: {
  readonly enabled: boolean
  readonly installed: boolean
  readonly configured: boolean
  readonly unavailableReason: string | undefined
  readonly probe: ProviderRuntimeInstanceStatusProbe | null
}): string | undefined {
  if (!input.enabled) return undefined
  if (input.unavailableReason) return input.unavailableReason
  if (!input.installed) return "Provider backend is not installed."
  // Prefer the adapter's own probe message: it is specific and actionable
  // (e.g. "Run `codex login`", or "authenticated, but the app-server metadata
  // probe failed — provider remains selectable"). The generic strings below
  // are last-resort fallbacks for probes that report a bad status without an
  // explanatory message.
  const probeMessage = input.probe?.message?.trim() || undefined
  if (input.probe?.auth?.status === "unauthenticated") {
    return probeMessage ?? "Provider authentication is required."
  }
  if (!input.configured)
    return probeMessage ?? "Provider instance is not configured."
  if (input.probe?.status === "error") {
    return probeMessage ?? "Provider status check failed."
  }
  if (input.probe?.status === "warning") {
    return probeMessage ?? "Provider status requires attention."
  }
  return undefined
}
