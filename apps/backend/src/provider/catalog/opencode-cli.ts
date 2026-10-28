import type { ProviderDefinition } from "./types"

/**
 * OpenCode CLI — the local `opencode` binary from the opencode project.
 * Uses the user's existing CLI login (`opencode auth login`, or any provider
 * API key stored in the CLI's own `auth.json`); BetterC0de drives the CLI's
 * Agent Client Protocol server (`opencode acp`) and never sees the credential.
 *
 * Backend runtime adapter: `apps/backend/src/provider/runtime/opencode/OpenCodeAcpAdapter.ts`
 * (a profile over the shared ACP adapter core). `opencode acp` exposes the
 * model/effort/mode pickers, tool calls, approvals, commands and token usage
 * that the removed v1 HTTP surface used to provide.
 */
export const opencodeCli: ProviderDefinition = {
  id: "opencode-cli",
  name: "OpenCode CLI",
  description:
    "The local `opencode` binary — uses your CLI login (ACP, v2.1+).",
  // Used only until the CLI's live inventory advertises its model picker.
  defaultModels: [],
  enabledByDefault: true,
  docsUrl: "https://opencode.ai/docs",
  authMethods: [
    {
      type: "cli",
      label: "OpenCode CLI",
      command: "opencode",
      versionArgs: ["--version"],
      installHint:
        "curl -fsSL https://opencode.ai/install | bash  (or: npm i -g opencode-ai)",
      loginCommand: "opencode auth login",
    },
  ],
}
