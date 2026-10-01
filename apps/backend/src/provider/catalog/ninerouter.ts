import type { ProviderDefinition } from "./types"

/**
 * 9Router (https://github.com/decolua/9router) is a local OpenAI-compatible
 * router in front of many subscriptions and API accounts. Connections (URL,
 * optional key, models) are managed by the dedicated 9Router settings panel
 * and `/providers/ninerouter` routes, so this entry only carries metadata.
 */
export const ninerouter: ProviderDefinition = {
  id: "ninerouter",
  name: "9Router",
  description:
    "Route Claude Code, Codex, Copilot, Kiro and API accounts through one or more 9Router connections.",
  defaultModels: [],
  enabledByDefault: true,
  docsUrl: "https://github.com/decolua/9router",
  authMethods: [
    {
      type: "local-server",
      label: "Router URL",
      defaultBaseUrl: "http://localhost:20128/v1",
      hint: "Start 9Router with `npx 9router`; remote routers need an API key from the 9Router dashboard.",
    },
  ],
}
