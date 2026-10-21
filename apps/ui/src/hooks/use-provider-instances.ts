import { createProviderInstanceLoader } from "@/lib/provider-instance-loader"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ProviderInstanceSnapshot } from "@betterc0de/schema"
import { refreshProviderInstance } from "@/services/backend/providersApi"
import { SETTINGS_UPDATED_EVENT } from "@/lib/settings-store"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import {
  PROVIDER_METADATA_CHANGED_EVENT,
  type ProviderMetadataChangedDetail,
} from "@/lib/provider-metadata-events"
import { normalizeProviderDriverKind } from "@/lib/provider-instances"

const POLL_INTERVAL_MS = 30_000

function normalizeProviderKey(value: string | null | undefined): string {
  return normalizeProviderDriverKind(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
}

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

const NO_INSTANCES: ProviderInstanceSnapshot[] = []

export function useProviderInstances(cwd?: string | null): {
  instances: ProviderInstanceSnapshot[]
  refetch: () => void
} {
  const [catalog, setCatalog] = useState<{
    cwd: typeof cwd
    instances: ProviderInstanceSnapshot[]
  }>({ cwd, instances: [] })
  const instances = catalog.cwd === cwd ? catalog.instances : NO_INSTANCES
  // The metadata listener below reads the latest snapshot without
  // re-subscribing on every refresh.
  const instancesRef = useRef(instances)
  instancesRef.current = instances
  const loaderRef = useRef<ReturnType<
    typeof createProviderInstanceLoader
  > | null>(null)
  const refetch = useCallback(() => loaderRef.current?.refresh(), [])

  useEffect(() => {
    const loader = createProviderInstanceLoader(cwd, (next) =>
      setCatalog({ cwd, instances: next })
    )
    loaderRef.current = loader
    void loader.refresh()
    return () => {
      loader.dispose()
      if (loaderRef.current === loader) loaderRef.current = null
    }
  }, [cwd])

  useVisibilityInterval(() => {
    void refetch()
  }, POLL_INTERVAL_MS)

  useEffect(() => {
    const handler = () => {
      void refetch()
    }
    window.addEventListener(SETTINGS_UPDATED_EVENT, handler)
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, handler)
  }, [refetch])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ProviderMetadataChangedDetail>)
        .detail
      const targets = providerMetadataRefreshTargets(
        instancesRef.current,
        detail
      )
      void (async () => {
        if (targets.length > 0) {
          await Promise.allSettled(
            targets.map((instanceId) =>
              refreshProviderInstance(instanceId, cwd)
            )
          )
        }
        await refetch()
      })()
    }
    window.addEventListener(PROVIDER_METADATA_CHANGED_EVENT, handler)
    return () =>
      window.removeEventListener(PROVIDER_METADATA_CHANGED_EVENT, handler)
  }, [cwd, refetch])

  return { instances, refetch: () => void refetch() }
}
