import { isNineRouterProviderKind } from "@betterc0de/schema"

/**
 * Model id as the provider expects it on the wire. Routers address models as
 * `vendor/model` (OpenRouter) or `account/model` (9Router), so they keep the
 * prefix; other providers receive the bare id.
 */
export function wireModelIdForProvider(
  providerKind: string,
  modelId: string
): string {
  if (
    providerKind === "openrouter" ||
    isNineRouterProviderKind(providerKind) ||
    !modelId.includes("/")
  )
    return modelId
  return modelId.split("/").pop()!
}
