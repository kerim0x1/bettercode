import { useCallback } from "react"
import type { ProviderInstanceSnapshot } from "@betterc0de/schema"
import {
  providerCatalogKey,
  providerInstancesStore,
} from "@/lib/provider-catalog-store"
import { useSharedResourceKey } from "@/lib/shared-resource"

export { providerMetadataRefreshTargets } from "@/lib/provider-instance-loader"

const NO_INSTANCES: ProviderInstanceSnapshot[] = []

/**
 * Provider-instance catalog for one workspace (`cwd`), with model lists filled
 * in. Every caller for the same workspace shares one snapshot, one 30 s
 * poller and one in-flight request. Settings and provider-metadata events
 * refresh it centrally (see `provider-catalog-store`).
 */
export function useProviderInstances(cwd?: string | null): {
  instances: ProviderInstanceSnapshot[]
  refetch: () => void
} {
  const key = providerCatalogKey(cwd)
  const instances =
    useSharedResourceKey(providerInstancesStore, key) ?? NO_INSTANCES
  const refetch = useCallback(() => {
    void providerInstancesStore.refresh(key, { force: true })
  }, [key])
  return { instances, refetch }
}
