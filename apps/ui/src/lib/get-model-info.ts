import { anthropicModelDisplayName } from "@betterc0de/schema"
import { builtinProviders } from "@/lib/builtin-providers"
import { usePluginStore } from "@/lib/plugin-store"

/**
 * Look up a model's display name + provider logo by model id, across both
 * builtin providers and enabled plugin providers.
 *
 * Returns `null` when `modelId` is falsy. Recognized model families retain a
 * readable name and provider mark even when their catalog entry is withdrawn;
 * this metadata does not add them to the selectable model list. Reads the plugin store
 * imperatively via `getState()` because this function is also called from
 * non-reactive contexts (title generation, logging).
 */
export function getModelInfo(
  modelId?: string
): { name: string; logo: string } | null {
  if (!modelId) return null
  // Check all builtin providers
  for (const p of builtinProviders) {
    const model = p.models.find((m) => m.id === modelId)
    if (model) return { name: model.name, logo: p.logo || "" }
  }
  // Check plugin models
  const plugins = usePluginStore.getState().plugins
  for (const p of plugins) {
    if (!p.enabled) continue
    const model = p.manifest.models.find((m) => m.id === modelId)
    if (model) return { name: model.name, logo: p.manifest.icon || "" }
  }
  const claudeName = anthropicModelDisplayName(modelId)
  if (claudeName) return { name: claudeName, logo: providerLogo("claude") }

  const grok = /^grok-(\d+(?:[.-]\d+)?)(?:-(.+))?$/i.exec(modelId)
  if (grok)
    return {
      name: `Grok ${grok[1].replace("-", ".")}${grok[2] ? ` ${titleWords(grok[2])}` : ""}`,
      logo: providerLogo("grok"),
    }

  const openAiId = modelId.replace(/^openai\//i, "")
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(openAiId)
  if (gpt)
    return {
      name: `GPT-${gpt[1]}${gpt[2] ? `-${titleWords(gpt[2]).replaceAll(" ", "-")}` : ""}`,
      logo: providerLogo("openai-api"),
    }
  if (/^o\d+(?:-|$)/i.test(openAiId))
    return { name: openAiId, logo: providerLogo("openai-api") }
  return { name: modelId, logo: "" }
}

function providerLogo(providerId: string): string {
  return (
    builtinProviders.find((provider) => provider.id === providerId)?.logo ?? ""
  )
}

function titleWords(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ")
}
