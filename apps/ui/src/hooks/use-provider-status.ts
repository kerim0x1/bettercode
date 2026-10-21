import type { ProviderStatus } from "@/services/backend/providersApi"
import {
  providerStatusResource,
  refreshProviderStatus,
} from "@/lib/provider-catalog-store"
import { useSharedResource } from "@/lib/shared-resource"

/**
 * Live provider-status map keyed by `providerKind` (e.g. `"anthropic"`,
 * `"openai"`, `"lmstudio"`). Returns the snapshot plus a `refetch()`
 * for callers that want to force-update after a known mutation.
 *
 * Data is sourced from `GET /providers/status`; the backend assembles
 * `{provider, name, configured, authType, hint}` per registered adapter.
 *
 * Every caller shares one snapshot and one poller (see
 * `provider-catalog-store`). It refreshes on three signals:
 *   - the first mounted caller, when the cached map is missing or stale,
 *   - every 30 s while the window is visible and any caller is mounted,
 *   - the `betterc0de:settings-updated` DOM event the settings store
 *     dispatches after a successful `updateSettings()`.
 *
 * Last-known state is preserved on fetch failures — the model picker
 * doesn't suddenly disable a provider just because the backend HTTP
 * blip'd; staleness is preferred over false negatives.
 */
export function useProviderStatus(): {
  status: Map<string, ProviderStatus>
  refetch: () => void
} {
  const status = useSharedResource(providerStatusResource)
  return { status, refetch: refreshProviderStatus }
}
