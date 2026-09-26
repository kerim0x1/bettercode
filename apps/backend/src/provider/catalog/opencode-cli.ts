import type { ProviderDefinition } from "./types";

/**
 * OpenCode CLI — the local `opencode` binary from the opencode project.
 * Uses the user's existing CLI login (`opencode auth login`, or any
 * provider API key stored in the CLI's own `auth.json`); BetterC0de drives
 * the CLI's headless HTTP server (`opencode serve`) and never sees the
 * credential.
 *
 * Backend runtime adapter: `apps/backend/src/provider/runtime/opencode/OpenCodeAdapter.ts`
 * (a profile over the shared OpenCode-protocol adapter core; the CLI
 * supports both the v1 (`/session`, `/event`) and v2 (`/api/session`,
 * `/api/model`, `/api/provider`) HTTP surfaces, and the adapter detects
 * which one the installed binary exposes).
 */
export const opencodeCli: ProviderDefinition = {
  id: "opencode-cli",
  name: "OpenCode CLI",
  description: "The local `opencode` binary — uses your CLI login (v1 and v2 APIs).",
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
      installHint: "curl -fsSL https://opencode.ai/install | bash  (or: npm i -g opencode-ai)",
      loginCommand: "opencode auth login",
    },
  ],
};
