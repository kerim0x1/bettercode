import { getSettings } from "@/services/backend"
import type { OpenAiTransport } from "@/lib/provider-types"

/**
 * Resolve the backend provider + transport to actually use for a send.
 *
 * The UI lets users pick a provider conceptually (e.g. "Claude"), but the
 * actual wire call may need to go somewhere else — e.g. if the user hasn't
 * configured an API key for the direct provider but has OpenRouter set up
 * with a compatible model ID, we transparently reroute through OpenRouter.
 *
 * Returns `{ providerKind, openaiTransport }`. `openaiTransport` is only
 * meaningful for OpenAI-family providers (`api` / `oauth` / `cli`).
 */
export async function resolveProviderTarget(
  provider:
    | {
        id: string
        providerKind?: string
        openaiTransport?: OpenAiTransport
        providerInstanceId?: string
      }
    | undefined,
  modelId: string
): Promise<{
  providerKind: string
  openaiTransport: OpenAiTransport | null
  providerInstanceId: string | null
}> {
  const providerKind = provider?.providerKind ?? provider?.id ?? "openai"
  const openaiTransport = provider?.openaiTransport ?? null
  const providerInstanceId = provider?.providerInstanceId ?? null

  // Explicit OpenAI transport selected in UI: do not auto-reroute.
  if (providerKind === "openai" && openaiTransport) {
    return { providerKind, openaiTransport, providerInstanceId }
  }

  type ProviderKeys = Record<string, { api_key?: string } | undefined>
  let keys: Record<string, string | null> = {}
  try {
    const s = await getSettings()
    const providers = (s?.providers ?? {}) as ProviderKeys
    keys = {
      anthropic: providers.anthropic?.api_key || null,
      openai: providers.openai?.api_key || null,
      google: providers.google?.api_key || null,
      grok: providers.grok?.api_key || null,
      openrouter: providers.openrouter?.api_key || null,
      deepseek: providers.deepseek?.api_key || null,
    }
  } catch { console.warn("Failed to load provider settings for key resolution") }

  // If direct provider has a key, use it
  if (keys[providerKind]) return { providerKind, openaiTransport, providerInstanceId }

  // CLI providers always work (no key needed) — but only the CLI-based ones.
  // "claude" is the native builtin (replaces the retired anthropic-claude
  // plugin), "anthropic_cli" is a legacy alias. "grok_cli" is the xAI Grok
  // Build CLI (never reroute it to OpenRouter — the API-key "grok" kind is
  // a different provider). "opencode_cli" is the upstream `opencode` binary,
  // likewise driven by its own login rather than an API key.
  if (
    providerKind === "claude" ||
    providerKind === "anthropic_cli" ||
    providerKind === "grok_cli" ||
    providerKind === "grok-cli" ||
    providerKind === "opencode_cli" ||
    providerKind === "opencode-cli"
  )
    return { providerKind, openaiTransport, providerInstanceId }

  // LM Studio is local, no key needed
  if (providerKind === "lmstudio")
    return { providerKind: "lmstudio", openaiTransport, providerInstanceId }

  // Already OpenRouter, keep it
  if (providerKind === "openrouter")
    return { providerKind: "openrouter", openaiTransport, providerInstanceId }

  // Fallback: if OpenRouter has a key and model has a slash ID, reroute
  if (keys.openrouter && modelId.includes("/"))
    return { providerKind: "openrouter", openaiTransport: null, providerInstanceId: null }

  // No key available — send anyway, backend will error with helpful message
  return { providerKind, openaiTransport, providerInstanceId }
}
