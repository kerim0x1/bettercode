import { assetUrl } from "@/lib/asset-url"
import type { UiProvider } from "@/lib/provider-types"

/**
 * Model-maker marks for catalogs that mix several makers' models. Cursor
 * lists Claude, GPT, Grok and Gemini next to its own Composer, and an
 * OpenRouter list can hold any of them, so a model row there shows the mark
 * of whoever made the model instead of repeating the provider's.
 *
 * Black-on-transparent marks carry `invertDark` like their provider entries
 * in `builtin-providers.ts`, because logos render through `<img>`.
 */
interface ModelVendor {
  readonly name: string
  readonly logo: string
  readonly invertDark?: boolean
}

const MODEL_VENDORS: ReadonlyArray<{
  readonly pattern: RegExp
  readonly vendor: ModelVendor
}> = [
  {
    pattern: /\b(?:claude|anthropic|opus|sonnet|haiku|fable)\b/,
    vendor: { name: "Claude", logo: assetUrl("icons/providers/claude.svg") },
  },
  {
    pattern: /\b(?:gpt|chatgpt|openai|codex)\b|\bo[1-9]\b/,
    vendor: {
      name: "OpenAI",
      logo: assetUrl("icons/providers/openai.svg"),
      invertDark: true,
    },
  },
  {
    pattern: /\b(?:grok|xai|x-ai)\b/,
    vendor: {
      name: "Grok",
      logo: assetUrl("icons/providers/grok.svg"),
      invertDark: true,
    },
  },
  {
    pattern: /\b(?:gemini|gemma|google)\b/,
    // Google's 2025 Gemini spark, from Wikimedia Commons
    // (`Google_Gemini_icon_2025.svg`, public domain, trademark of Google).
    vendor: { name: "Gemini", logo: assetUrl("icons/providers/gemini.svg") },
  },
  {
    pattern: /deepseek/,
    vendor: {
      name: "DeepSeek",
      logo: assetUrl("icons/providers/deepseek.png"),
    },
  },
  {
    pattern: /qwen|qwq/,
    vendor: { name: "Qwen", logo: assetUrl("icons/providers/qwen.png") },
  },
  {
    pattern:
      /\b(?:mistral|codestral|devstral|magistral|ministral|pixtral|mistralai)\b/,
    vendor: {
      name: "Mistral",
      logo: assetUrl("icons/providers/mistral.svg"),
      invertDark: true,
    },
  },
  {
    pattern: /\b(?:glm|zhipu|z-ai)\b/,
    vendor: { name: "Zhipu", logo: assetUrl("icons/providers/zhipu.png") },
  },
]

/** Providers whose model list spans several makers. */
const MULTI_VENDOR_PROVIDER_KINDS: ReadonlySet<string> = new Set([
  "cursor",
  "openrouter",
])

/** The maker of a model, read from its id and display name. */
export function modelVendor(model: {
  readonly id: string
  readonly name?: string
}): ModelVendor | null {
  const text = `${model.id} ${model.name ?? ""}`.toLowerCase()
  return MODEL_VENDORS.find(({ pattern }) => pattern.test(text))?.vendor ?? null
}

/**
 * What a model row's `ProviderIcon` should draw: the maker's mark in a
 * multi-vendor catalog, otherwise the provider itself. A model with no known
 * maker (Cursor's Auto and Composer) keeps the provider's mark.
 */
export function modelIconProvider(
  provider: UiProvider,
  model: { readonly id: string; readonly name?: string }
): UiProvider {
  if (!MULTI_VENDOR_PROVIDER_KINDS.has(provider.providerKind ?? provider.id)) {
    return provider
  }
  const vendor = modelVendor(model)
  if (!vendor) return provider
  return {
    ...provider,
    name: vendor.name,
    logo: vendor.logo,
    invertDark: vendor.invertDark ?? false,
  }
}
