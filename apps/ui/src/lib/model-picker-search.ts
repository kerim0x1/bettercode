import { isNineRouterProviderKind } from "@betterc0de/schema"
import type { UiProvider, UiProviderModel } from "@/lib/provider-types"

/**
 * 9Router routes dozens of accounts and combos, and accepts any id it can
 * route, so its menu gets a filter box that doubles as a model-id field.
 */
export function pickerShowsModelSearch(
  provider: Pick<UiProvider, "providerKind">
): boolean {
  return isNineRouterProviderKind(provider.providerKind)
}

/** Matches the model name, id, or group, ignoring case and separators. */
export function filterPickerModels<
  T extends Pick<UiProviderModel, "id" | "name" | "tier">,
>(models: readonly T[], query: string): T[] {
  const needle = compact(query)
  if (!needle) return [...models]
  return models.filter((model) =>
    [model.id, model.name, model.tier].some((value) =>
      compact(value).includes(needle)
    )
  )
}

/**
 * Groups for providers whose tiers name an upstream account (9Router:
 * "Combos", "Claude Code", …). Other providers stay one flat list.
 */
export function groupPickerModels<T extends Pick<UiProviderModel, "tier">>(
  provider: Pick<UiProvider, "providerKind">,
  models: readonly T[]
): Array<{ label: string | null; models: T[] }> {
  if (!isNineRouterProviderKind(provider.providerKind))
    return [{ label: null, models: [...models] }]
  const groups = new Map<string, T[]>()
  for (const model of models) {
    groups.set(model.tier, [...(groups.get(model.tier) ?? []), model])
  }
  return [...groups.entries()].map(([label, entries]) => ({
    label,
    models: entries,
  }))
}

/** A typed id that 9Router could route but the list does not contain yet. */
export function pickerCustomModelCandidate(
  provider: Pick<UiProvider, "providerKind" | "models">,
  query: string
): string | null {
  if (!isNineRouterProviderKind(provider.providerKind)) return null
  const id = query.trim()
  if (!id || id.length > 256 || /\s/.test(id)) return null
  return provider.models.some((model) => model.id === id) ? null : id
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[\s_./()-]+/g, "")
}
