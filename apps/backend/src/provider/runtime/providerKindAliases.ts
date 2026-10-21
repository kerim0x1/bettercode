/**
 * One place for "what provider kind does this string mean". The table lives
 * in `@betterc0de/schema/provider-kind` so the renderer and the backend
 * cannot drift; this module keeps the existing backend import path.
 */
export {
  canonicalProviderKindAlias,
  compactProviderAlias,
  providerKindFromDriver,
  type CanonicalProviderKindAlias,
} from "@betterc0de/schema/provider-kind"
