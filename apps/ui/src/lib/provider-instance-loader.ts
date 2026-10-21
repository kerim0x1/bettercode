import type { ProviderInstanceSnapshot } from "@betterc0de/schema"
import {
  listProviderInstanceModels,
  listProviderInstances,
} from "@/services/backend/providersApi"
import type { ProviderMetadataChangedDetail } from "@/lib/provider-metadata-events"
import { normalizeProviderDriverKind } from "@/lib/provider-instances"

/**
 * Loads one workspace's provider-instance catalog, filling in the model list
 * of every enabled, configured instance whose snapshot arrived without one.
 *
 * Request ownership (a late response must not replace newer metadata) lives
 * in the shared resource that calls this; `signal` only lets a superseded
 * request skip the per-instance model lookups.
 */
export async function loadProviderInstanceCatalog(
  cwd: string | null | undefined,
  signal?: AbortSignal
): Promise<ProviderInstanceSnapshot[]> {
  const snapshots = await listProviderInstances(cwd)
  if (signal?.aborted) return snapshots
  return Promise.all(
    snapshots.map(async (instance) => {
      if (
        !instance.enabled ||
        !instance.configured ||
        instance.models !== undefined
      )
        return instance
      try {
        const models = await listProviderInstanceModels(
          instance.instanceId,
          cwd
        )
        return {
          ...instance,
          models: models.map((model) => ({
            ...model,
            isCustom: model.isCustom ?? false,
            capabilities: model.capabilities ?? null,
          })),
        }
      } catch {
        return instance
      }
    })
  )
}

function normalizeProviderKey(value: string | null | undefined): string {
  return normalizeProviderDriverKind(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
}

/** Instance ids to refresh after a provider reports changed metadata. */
export function providerMetadataRefreshTargets(
  instances: ReadonlyArray<ProviderInstanceSnapshot>,
  detail: ProviderMetadataChangedDetail | undefined
): string[] {
  const explicitInstanceId = detail?.providerInstanceId?.trim()
  if (explicitInstanceId) return [explicitInstanceId]

  const providerKind = normalizeProviderKey(detail?.providerKind)
  if (!providerKind) return []

  const matching = instances
    .filter(
      (instance) => normalizeProviderKey(instance.driver) === providerKind
    )
    .map((instance) => instance.instanceId)
  if (matching.length > 0) return matching

  return [normalizeProviderDriverKind(detail?.providerKind ?? "")]
}
