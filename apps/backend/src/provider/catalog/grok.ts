import type { ProviderDefinition } from "./types"

export const grok: ProviderDefinition = {
  id: "grok",
  name: "Grok (xAI)",
  description: "xAI's Grok models.",
  // Mirrors xAI's own model metadata (see ~/.grok/models_cache.json — both
  // ship `supported_in_api: true` with a low…xhigh reasoning ladder on 4.6).
  defaultModels: [],
  enabledByDefault: true,
  docsUrl: "https://console.x.ai/api-keys",
  authMethods: [
    {
      type: "api-key",
      label: "API Key",
      placeholder: "xai-...",
      envVars: ["XAI_API_KEY"],
    },
  ],
}
