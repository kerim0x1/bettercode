import { assetUrl } from "@/lib/asset-url"

/**
 * Brand marks for the Settings → Providers catalog ids. CLI accounts show
 * the product (Claude, Codex, Cursor, Grok); API keys show the company that
 * bills them (Anthropic, OpenAI, xAI), so the two kinds read apart at a
 * glance even where the product is the same. Black-on-transparent marks
 * carry `invertDark`, because logos render through `<img>`.
 */
export interface ProviderBrand {
  logo: string
  invertDark: boolean
}

const BRANDS: Record<string, ProviderBrand> = {
  claude: { logo: "icons/providers/claude.svg", invertDark: false },
  codex: { logo: "icons/providers/openai.svg", invertDark: true },
  cursor: { logo: "icons/providers/cursor.svg", invertDark: true },
  "grok-cli": { logo: "icons/providers/grok.svg", invertDark: true },
  // The orchestrator and runtime spell the Grok CLI driver this way.
  grok_cli: { logo: "icons/providers/grok.svg", invertDark: true },
  anthropic: { logo: "icons/providers/anthropic.svg", invertDark: true },
  openai: { logo: "icons/providers/openai.svg", invertDark: true },
  grok: { logo: "icons/providers/xai.svg", invertDark: true },
  openrouter: { logo: "icons/providers/openrouter.svg", invertDark: true },
  deepseek: { logo: "icons/providers/deepseek.png", invertDark: false },
  lmstudio: { logo: "icons/providers/lmstudio.png", invertDark: false },
}

export function providerBrand(id: string): ProviderBrand | null {
  const brand = BRANDS[id]
  return brand ? { ...brand, logo: assetUrl(brand.logo) } : null
}

/** How a provider is reached: a signed-in CLI, an API key, or a local server. */
export type ProviderAccess = "cli" | "api" | "local"

export const PROVIDER_ACCESS_LABEL: Record<ProviderAccess, string> = {
  cli: "CLI",
  api: "API key",
  local: "Local",
}
