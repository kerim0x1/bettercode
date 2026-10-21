import type { OpenRouterLiveModel } from "@/services/backend/providersApi"
import { prettyModelId } from "@/lib/model-display-name"

/**
 * Pure helpers that turn the backend's live OpenRouter catalog subset into
 * the picker's or-* group model lists. Kept out of the hook so the grouping,
 * naming, and tier rules are testable without React (several bugs in this
 * repo shipped because logic only existed inside a component).
 */

export interface OpenRouterUiModel {
  id: string
  name: string
  context: string
  tier: string
}

/** Which builtin picker group owns which catalog family. Grok deliberately
 *  has no OpenRouter group — the direct xAI provider already covers it. */
const GROUP_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["or-qwen", "qwen/"],
  ["or-deepseek", "deepseek/"],
]

/** The catalog serves newest releases first; four per family keeps the
 *  submenu scannable while still covering flagship/fast/free variants. */
const MAX_MODELS_PER_GROUP = 4

/** "Qwen: Qwen3.8 Max" → "Qwen3.8 Max" — the group already names the vendor. */
export function openRouterDisplayName(name: string, id: string): string {
  const trimmed = name.trim()
  if (!trimmed) return id
  const colon = trimmed.indexOf(": ")
  return colon > 0 ? trimmed.slice(colon + 2) : trimmed
}

export function formatOpenRouterContextLabel(
  contextLength: number | null
): string {
  if (!contextLength || contextLength <= 0) return "—"
  if (contextLength >= 950_000) {
    const rounded = Math.round((contextLength / 1_000_000) * 10) / 10
    return `${rounded}M`
  }
  // Powers of two read conventionally (262144 → 256K); decimal sizes keep
  // their decimal reading (500000 → 500K).
  const kilo =
    contextLength % 1024 === 0
      ? Math.round(contextLength / 1024)
      : Math.round(contextLength / 1000)
  return `${kilo}K`
}

export function openRouterModelTier(id: string, name: string): string {
  const key = `${id} ${name}`.toLowerCase()
  if (id.endsWith(":free")) return "Free"
  if (/coder|code/.test(key)) return "Coding"
  if (/flash|lite|mini|turbo|fast/.test(key)) return "Fast"
  if (/max|pro/.test(key)) return "Flagship"
  return "Balanced"
}

/**
 * The dedicated "OpenRouter" picker entry lists exactly what the user typed
 * under Settings → Providers → OpenRouter → Custom models, each named in
 * readable form ("google/gemini-4-argon" → "Gemini 4 Argon"). The id itself
 * is kept unchanged and stays visible in Settings and the picker's hint, so
 * a typo can still be spotted.
 */
export function openRouterCustomUiModels(
  customModels: ReadonlyArray<string>
): OpenRouterUiModel[] {
  const seen = new Set<string>()
  const out: OpenRouterUiModel[] = []
  for (const raw of customModels) {
    const id = typeof raw === "string" ? raw.trim() : ""
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: prettyModelId(id), context: "custom", tier: "Custom" })
  }
  return out
}

/**
 * Groups the live catalog subset into per-picker-group model lists, capped
 * and in catalog (newest-first) order. Groups with no live models are absent
 * from the map so their curated fallback entries stay visible.
 */
export function buildOpenRouterGroupModels(
  models: ReadonlyArray<OpenRouterLiveModel>
): Map<string, OpenRouterUiModel[]> {
  const groups = new Map<string, OpenRouterUiModel[]>()
  for (const model of models) {
    const lower = model.id.toLowerCase()
    const group = GROUP_PREFIXES.find(([, prefix]) => lower.startsWith(prefix))
    if (!group) continue
    const [groupId] = group
    const list = groups.get(groupId) ?? []
    if (list.length >= MAX_MODELS_PER_GROUP) continue
    list.push({
      id: model.id,
      name: openRouterDisplayName(model.name, model.id),
      context: formatOpenRouterContextLabel(model.contextLength),
      tier: openRouterModelTier(model.id, model.name),
    })
    groups.set(groupId, list)
  }
  return groups
}
