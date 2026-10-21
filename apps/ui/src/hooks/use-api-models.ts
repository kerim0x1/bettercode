import type { ApiModel } from "@/services/backend/providersApi"
import { apiModelsResource } from "@/lib/provider-catalog-store"
import { useSharedResource } from "@/lib/shared-resource"

/**
 * Account-scoped API model catalog, shared by every caller. The backend owns
 * credentials, timeouts, account scoping and the cache. `null` means not yet
 * loaded (or hidden while a settings change switches accounts).
 */
export function useApiModels(): ApiModel[] | null {
  return useSharedResource(apiModelsResource)
}
