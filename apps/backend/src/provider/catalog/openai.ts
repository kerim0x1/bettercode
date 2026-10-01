import type { ProviderDefinition } from "./types"

/** Direct API credentials. Subscription login stays with the Codex CLI provider. */
export const openai: ProviderDefinition = {
  id: "openai",
  name: "OpenAI API",
  description:
    "OpenAI models through your API keys. Manage subscription accounts under Codex CLI.",
  defaultModels: [],
  enabledByDefault: true,
  docsUrl: "https://platform.openai.com/api-keys",
  authMethods: [
    {
      type: "api-key",
      label: "API Key",
      placeholder: "sk-...",
      envVars: ["OPENAI_API_KEY"],
    },
  ],
}
