import type { ProviderDefinition } from "./types"

/**
 * Grok CLI — xAI's local `grok` binary ("Grok Build"). Uses the user's
 * existing CLI login (`grok login`, X/xAI account) or the XAI_API_KEY env
 * fallback. BetterC0de drives it over the Agent Client Protocol
 * (`grok agent stdio`); auth never leaves the CLI's own store.
 *
 * Backend runtime adapter: `apps/backend/src/provider/runtime/grok-cli/GrokAcpAdapter.ts`
 * (a profile over the shared `runtime/acp/AcpAdapterBase.ts`; the read-only
 * ceiling and the on-disk model cache are the Grok-specific parts).
 * Distinct from the `grok` provider (xAI API key → api.x.ai) which talks the
 * HTTP API directly without the CLI.
 */
export const grokCli: ProviderDefinition = {
  id: "grok-cli",
  name: "Grok CLI",
  description:
    "xAI's local `grok` binary (Grok Build) — uses your CLI login or XAI_API_KEY.",
  // Used only when the CLI's ACP session doesn't advertise a model picker.
  defaultModels: [],
  enabledByDefault: true,
  docsUrl: "https://x.ai/cli",
  authMethods: [
    {
      type: "cli",
      label: "Grok CLI",
      command: "grok",
      versionArgs: ["--version"],
      installHint:
        "npm i -g @xai-official/grok  (or: irm https://x.ai/cli/install.ps1 | iex)",
      loginCommand: "grok login",
    },
  ],
}
