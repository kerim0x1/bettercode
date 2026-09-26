import type { ProviderDefinition } from "./types"

/**
 * Cursor CLI — Cursor's local `cursor-agent` binary. Uses the user's
 * existing CLI login (`agent login`, Cursor account); BetterC0de
 * drives it over the Agent Client Protocol (`cursor-agent acp`) and never
 * sees the credential.
 *
 * Backend runtime adapter: `apps/backend/src/provider/runtime/cursor/CursorAcpAdapter.ts`
 * (a profile over the shared `runtime/acp/AcpAdapterBase.ts`; Cursor's
 * `cursor/*` protocol extensions live in `cursor/CursorAcpExtensions.ts`).
 * The binary is resolved through `runtime/cursor/CursorBinaryResolution.ts` —
 * the bare command `agent` is deliberately NOT used, it belongs to another
 * vendor's CLI on some machines.
 */
export const cursorCli: ProviderDefinition = {
  id: "cursor",
  name: "Cursor",
  description:
    "Cursor's local `cursor-agent` binary — uses your Cursor CLI login.",
  defaultModels: [],
  enabledByDefault: true,
  docsUrl: "https://cursor.com/cli",
  authMethods: [
    {
      type: "cli",
      label: "Cursor CLI",
      command: "cursor-agent",
      versionArgs: ["--version"],
      installHint:
        process.platform === "win32"
          ? "irm 'https://cursor.com/install?win32=true' | iex"
          : "curl https://cursor.com/install -fsS | bash",
      loginCommand: "agent login",
    },
  ],
}
