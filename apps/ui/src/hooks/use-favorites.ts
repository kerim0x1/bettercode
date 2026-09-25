import { useCallback, useEffect, useMemo, useState } from "react"
import { makeFavoriteKey, parseFavoriteKey } from "@/lib/favorites"
import { providerModelKey, sortProviderModelItems } from "@/lib/model-ordering"
import type { UiProvider } from "@/lib/provider-types"

interface FavoriteProviderIndex {
  readonly providersById: ReadonlyMap<string, UiProvider>
  readonly providerModelIdsById: ReadonlyMap<string, ReadonlySet<string>>
  readonly firstProviderIdByModelId: ReadonlyMap<string, string>
}

export function favoriteProvidersSignature(
  providers: ReadonlyArray<UiProvider>
): string {
  return providers
    .map((provider) =>
      [provider.id, ...provider.models.map((model) => model.id)].join("\u001f")
    )
    .join("\u001e")
}

export function buildFavoriteProviderIndex(
  providers: ReadonlyArray<UiProvider>
): FavoriteProviderIndex {
  const providersById = new Map<string, UiProvider>()
  const providerModelIdsById = new Map<string, Set<string>>()
  const firstProviderIdByModelId = new Map<string, string>()

  for (const provider of providers) {
    providersById.set(provider.id, provider)
    const modelIds = new Set<string>()
    for (const model of provider.models) {
      modelIds.add(model.id)
      if (!firstProviderIdByModelId.has(model.id)) {
        firstProviderIdByModelId.set(model.id, provider.id)
      }
    }
    providerModelIdsById.set(provider.id, modelIds)
  }

  return { providersById, providerModelIdsById, firstProviderIdByModelId }
}

export function normalizeFavoriteKeysForProviders(
  rawValues: unknown,
  providerIndex: FavoriteProviderIndex
): string[] {
  const values = Array.isArray(rawValues)
    ? rawValues.filter((v): v is string => typeof v === "string")
    : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    let parsed = parseFavoriteKey(value)
    let cameFromLegacy = false
    if (!parsed) {
      // Backward compatibility: migrate legacy favorite format that stored only modelId.
      const legacyProviderId = providerIndex.firstProviderIdByModelId.get(value)
      if (legacyProviderId) {
        parsed = { providerId: legacyProviderId, modelId: value }
        cameFromLegacy = true
      }
    }
    if (!parsed) continue
    if (
      (parsed.providerId === "anthropic" ||
        parsed.providerId === "claude-api") &&
      !providerIndex.providersById.has(parsed.providerId) &&
      providerIndex.providersById.has("anthropic-api")
    ) {
      parsed = { ...parsed, providerId: "anthropic-api" }
    }
    const provider = providerIndex.providersById.get(parsed.providerId)
    const modelExists = Boolean(
      providerIndex.providerModelIdsById
        .get(parsed.providerId)
        ?.has(parsed.modelId)
    )
    if (!provider) {
      // Keep unknown provider favorites (e.g. disabled plugin) for future restoration.
      if (!cameFromLegacy) {
        const key = makeFavoriteKey(parsed.providerId, parsed.modelId)
        if (!seen.has(key)) {
          seen.add(key)
          out.push(key)
        }
      }
      continue
    }
    // An account may temporarily stop advertising a model. Keep its favorite
    // so it reappears if that model returns to the catalog.
    if (!modelExists) {
      const key = makeFavoriteKey(parsed.providerId, parsed.modelId)
      if (!seen.has(key)) {
        seen.add(key)
        out.push(key)
      }
      continue
    }
    const key = makeFavoriteKey(parsed.providerId, parsed.modelId)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/**
 * Favorite-model management hook.
 *
 * Favorites are persisted to `localStorage` as a JSON array of
 * "<providerId>::<modelId>" keys (see `@/lib/favorites`).
 *
 * Normalization does three jobs on load and whenever `providers` changes:
 *  1. Migrates the legacy format (bare model ids, no provider prefix) by
 *     looking up the provider that owns the model today.
 *  2. Preserves favorites whose provider is currently missing (disabled
 *     plugin, deleted config) so re-enabling the provider restores them
 *     without the user having to re-favorite.
 *  3. Dedupes.
 *
 * Returns:
 *  - `favoriteEntries` — hydrated `{provider, model}` objects, already
 *    filtered to those whose provider+model currently exist. Use this for
 *    rendering.
 *  - `toggle(providerId, modelId)` — add/remove and persist.
 *  - `isFavorite(providerId, modelId)` — boolean lookup by key.
 */
export function useFavorites(providers: UiProvider[]) {
  const providerSignature = favoriteProvidersSignature(providers)
  const providerIndex = useMemo(
    () => buildFavoriteProviderIndex(providers),
    // The providers array is intentionally not the dependency. It can be
    // recreated with identical content during status polling; tying the
    // normalizer to the content signature prevents a pointless effect cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providerSignature]
  )
  const normalizeFavoriteKeys = useCallback(
    (rawValues: unknown): string[] => {
      return normalizeFavoriteKeysForProviders(rawValues, providerIndex)
    },
    [providerIndex]
  )

  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("bc_favorites") || "[]")
      return normalizeFavoriteKeys(raw)
    } catch {
      return []
    }
  })

  useEffect(() => {
    setFavorites((prev) => {
      const normalized = normalizeFavoriteKeys(prev)
      if (
        normalized.length === prev.length &&
        normalized.every((v, i) => v === prev[i])
      )
        return prev
      localStorage.setItem("bc_favorites", JSON.stringify(normalized))
      return normalized
    })
  }, [normalizeFavoriteKeys])

  const toggle = useCallback((providerId: string, modelId: string) => {
    const key = makeFavoriteKey(providerId, modelId)
    setFavorites((prev) => {
      const next = prev.includes(key)
        ? prev.filter((id) => id !== key)
        : [...prev, key]
      localStorage.setItem("bc_favorites", JSON.stringify(next))
      return next
    })
  }, [])

  const isFavorite = useCallback(
    (providerId: string, modelId: string) => {
      const key = makeFavoriteKey(providerId, modelId)
      return favorites.includes(key)
    },
    [favorites]
  )

  const favoriteEntries = useMemo(() => {
    const providerOrder = providers.map((provider) => provider.id)
    const modelOrderByProvider = new Map(
      providers.map(
        (provider) =>
          [provider.id, provider.models.map((model) => model.id)] as const
      )
    )
    const entries = favorites
      .map((key) => {
        const parsed = parseFavoriteKey(key)
        if (!parsed) return null
        const provider = providers.find((p) => p.id === parsed.providerId)
        const model = provider?.models.find((m) => m.id === parsed.modelId)
        if (!provider || !model) return null
        return {
          key,
          provider,
          model,
          providerId: provider.id,
          modelId: model.id,
        }
      })
      .filter(
        (
          entry
        ): entry is {
          key: string
          provider: UiProvider
          model: UiProvider["models"][number]
          providerId: string
          modelId: string
        } => !!entry
      )

    return sortProviderModelItems(entries, {
      favoriteModelKeys: favorites.map((key) => {
        const parsed = parseFavoriteKey(key)
        return parsed
          ? providerModelKey(parsed.providerId, parsed.modelId)
          : key
      }),
      providerOrder,
      modelOrderByProvider,
    }).map(({ key, provider, model }) => ({ key, provider, model }))
  }, [favorites, providers])

  return { favoriteEntries, toggle, isFavorite }
}
