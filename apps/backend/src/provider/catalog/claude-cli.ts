import type { ProviderDefinition } from "./types"

/**
 * Claude CLI — uses the locally-installed `claude` binary (Anthropic's
 * Claude Agent SDK). Auth is delegated entirely to the CLI: the user runs
 * `claude login` once, and BetterC0de just spawns the binary. No API key
 * lives in BetterC0de's settings for this provider; the binary reads its
 * own `~/.claude/credentials.json`.
 *
 * Backend runtime adapter: `apps/backend/src/provider/runtime/claude/ClaudeAdapter.ts`.
 * Distinct from the `anthropic` provider which talks REST API directly.
 */
export const claudeCli: ProviderDefinition = {
  id: "claude",
  name: "Claude CLI",
  description:
    "Anthropic's local `claude` binary — uses your CLI login (no API key in BetterC0de).",
  defaultModels: [],
  enabledByDefault: true,
  docsUrl: "https://docs.anthropic.com/en/docs/claude-code/cli-reference",
  authMethods: [
    {
      type: "cli",
      label: "Claude CLI",
      command: "claude",
      versionArgs: ["--version"],
      installHint: "npm i -g @anthropic-ai/claude-code",
      loginCommand: "claude login",
    },
  ],
}
