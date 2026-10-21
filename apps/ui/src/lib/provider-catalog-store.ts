import type { ProviderInstanceSnapshot } from "@betterc0de/schema"
import {
  getProviderStatus,
  listModels,
  refreshProviderInstance,
  type ApiModel,
  type ProviderStatus,
} from "@/services/backend/providersApi"
import {
  listProjectProviders,
  type WorkspaceProjectProvidersSummary,
} from "@/services/backend/workspaceApi"
import {
  loadProviderInstanceCatalog,
  providerMetadataRefreshTargets,
} from "@/lib/provider-instance-loader"
import {
  PROVIDER_METADATA_CHANGED_EVENT,
  type ProviderMetadataChangedDetail,
} from "@/lib/provider-metadata-events"
import { SETTINGS_UPDATED_EVENT } from "@/lib/settings-store"
import {
  createSharedResource,
  createSharedResourceFamily,
  jsonEqual,
} from "@/lib/shared-resource"

/**
 * One shared, ref-counted poller per provider resource. Every
 * `useProviders`, `useProviderStatus` and `useProviderInstances` caller (app
 * shell, each chat pane's team status, the sidebar update pill, settings)
 * reads the same snapshot, so the backend sees one request per interval per
 * workspace instead of one per mounted hook.
 */

const PROVIDER_POLL_INTERVAL_MS = 30_000
const API_MODELS_POLL_INTERVAL_MS = 15 * 60_000
const PROJECT_PROVIDERS_STALE_MS = 30_000

export type ProviderStatusMap = Map<string, ProviderStatus>

const NO_STATUS: ProviderStatusMap = new Map()
const NO_INSTANCES: ProviderInstanceSnapshot[] = []

/** Workspace key for the per-cwd caches; no workspace means the global catalog. */
export function providerCatalogKey(cwd: string | null | undefined): string {
  return cwd || ""
}

/**
 * `GET /providers/status`, keyed by `providerKind`. A failed poll keeps the
 * last-known map: a provider is never disabled because the status route
 * blipped during a backend restart.
 */
export const providerStatusResource = createSharedResource<ProviderStatusMap>({
  initial: NO_STATUS,
  intervalMs: PROVIDER_POLL_INTERVAL_MS,
  load: async () => {
    const next: ProviderStatusMap = new Map()
    for (const item of await getProviderStatus()) next.set(item.provider, item)
    return next
  },
  isEqual: jsonEqual,
})

/**
 * `GET /providers/instances?cwd=` plus the model list of each configured
 * instance that arrived without one. A failed poll keeps the last catalog.
 */
export const providerInstancesStore = createSharedResourceFamily<
  ProviderInstanceSnapshot[]
>({
  initial: NO_INSTANCES,
  create: (key) => ({
    intervalMs: PROVIDER_POLL_INTERVAL_MS,
    load: (signal) => loadProviderInstanceCatalog(key || null, signal),
    isEqual: jsonEqual,
  }),
})

/**
 * Account-scoped API model catalog. The backend owns credentials, timeouts
 * and its own cache, so this only polls rarely.
 */
export const apiModelsResource = createSharedResource<ApiModel[] | null>({
  initial: null,
  intervalMs: API_MODELS_POLL_INTERVAL_MS,
  load: () => listModels(),
  isEqual: jsonEqual,
})

/**
 * The workspace's `BetterC0de.json` provider policy. Loaded when a workspace
 * is first shown (or after it went stale); a failure clears the policy.
 */
export const projectProvidersStore =
  createSharedResourceFamily<WorkspaceProjectProvidersSummary | null>({
    initial: null,
    create: (key) => ({
      staleMs: PROJECT_PROVIDERS_STALE_MS,
      load: () => listProjectProviders(key),
      isEqual: jsonEqual,
      onError: () => null,
    }),
  })

export function refreshProviderStatus(): void {
  void providerStatusResource.refresh({ force: true })
}

export function refreshProviderInstances(cwd?: string | null): void {
  void providerInstancesStore.refresh(providerCatalogKey(cwd), { force: true })
}

/**
 * Settings may have changed credentials, enabled instances or switched API
 * accounts. Mounted resources refetch now; idle ones on their next mount.
 */
export function handleProviderSettingsUpdated(): void {
  providerStatusResource.invalidate()
  for (const [, resource] of providerInstancesStore.entries()) {
    resource.invalidate()
  }
  // Hide the previous account's models until the new catalog has loaded.
  apiModelsResource.set(null)
  apiModelsResource.invalidate()
}

/**
 * A provider reported new skills, agents or commands. Each mounted workspace
 * asks the backend to rescan the affected instances once, then refetches its
 * catalog; idle workspaces refetch on their next mount.
 */
export async function handleProviderMetadataChanged(
  detail: ProviderMetadataChangedDetail | undefined
): Promise<void> {
  await Promise.allSettled(
    providerInstancesStore.entries().map(async ([key, resource]) => {
      if (!resource.isActive()) {
        resource.invalidate()
        return
      }
      const targets = providerMetadataRefreshTargets(
        resource.getSnapshot(),
        detail
      )
      if (targets.length > 0) {
        await Promise.allSettled(
          targets.map((instanceId) =>
            refreshProviderInstance(instanceId, key || null)
          )
        )
      }
      await resource.refresh({ force: true })
    })
  )
}

// One listener pair for the whole app, instead of one per mounted hook.
if (typeof window !== "undefined") {
  window.addEventListener(SETTINGS_UPDATED_EVENT, handleProviderSettingsUpdated)
  window.addEventListener(PROVIDER_METADATA_CHANGED_EVENT, (event) => {
    void handleProviderMetadataChanged(
      (event as CustomEvent<ProviderMetadataChangedDetail>).detail
    )
  })
}

/** Test helper: forgets every cached snapshot, subscriber and poller. */
export function resetProviderCatalogStoresForTests(): void {
  providerStatusResource.reset()
  providerInstancesStore.reset()
  apiModelsResource.reset()
  projectProvidersStore.reset()
}
