import type { ProviderDefinition } from "./types"

export const anthropic: ProviderDefinition = {
  id: "anthropic",
  name: "Claude API",
  description: "Anthropic's Claude family — Fable, Opus, Sonnet, Haiku.",
  // The configured account's model API provides the selectable inventory.
  defaultModels: [],
  enabledByDefault: true,
  docsUrl: "https://console.anthropic.com/settings/keys",
  authMethods: [
    {
      type: "api-key",
      label: "API Key",
      placeholder: "sk-ant-...",
      envVars: ["ANTHROPIC_API_KEY"],
      // Honour the user's existing `claude` CLI auth so an already-logged-in
      // CLI works in BetterC0de without re-pasting the key.
      cliConfig: [{ cli: "claude", field: "api_key" }],
    },
  ],
}
