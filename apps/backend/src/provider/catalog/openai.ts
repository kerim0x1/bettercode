import type { ProviderDefinition } from "./types"

/**
 * OpenAI / ChatGPT.  Two auth surfaces:
 *   1. Plain API key (sk-...)
 *   2. OAuth via ChatGPT Pro/Plus account (handler `codex-oauth`). Routes
 *      through the Codex endpoint (chatgpt.com/backend-api/codex/responses)
 *      when the auth is OAuth. The handler implementation is in
 *      apps/shell/oauth/codex.cjs.
 */
export const openai: ProviderDefinition = {
  id: "openai",
  name: "OpenAI / ChatGPT",
  description: "GPT-5 family via API key OR ChatGPT Pro/Plus OAuth.",
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
    {
      type: "oauth",
      label: "Sign in with ChatGPT (Pro/Plus)",
      handler: "codex-oauth",
    },
  ],
}
