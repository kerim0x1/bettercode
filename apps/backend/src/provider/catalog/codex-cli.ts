import type { ProviderDefinition } from "./types"

/**
 * Codex CLI — OpenAI's local `codex` binary. Uses the user's existing
 * Codex login (ChatGPT subscription via `codex login`, or API key via
 * `codex auth api`). BetterC0de spawns the binary and translates RPC
 * frames; auth never leaves the CLI's own keychain.
 *
 * Backend runtime adapter: `apps/backend/src/provider/runtime/codex/CodexAdapter.ts`.
 * Distinct from the `openai` provider's OAuth flow (PR4) which talks to
 * `chatgpt.com/backend-api/codex/responses` directly without the CLI.
 */
export const codexCli: ProviderDefinition = {
  id: "codex",
  name: "Codex CLI",
  description:
    "OpenAI's local `codex` binary — uses your CLI login (ChatGPT or API key).",
  // Used only when the local app-server cannot provide `model/list` metadata.
  // A successful live probe remains authoritative.
  // Only 5.5+ — older models removed 2026-07-21 per user request.
  defaultModels: [],
  enabledByDefault: true,
  docsUrl: "https://github.com/openai/codex",
  authMethods: [
    {
      type: "cli",
      label: "Codex CLI",
      command: "codex",
      versionArgs: ["--version"],
      installHint: "npm i -g @openai/codex",
      loginCommand: "codex login",
    },
  ],
}
