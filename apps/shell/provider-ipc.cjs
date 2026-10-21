/**
 * Provider catalog IPC handlers.
 *
 * Renderer-facing surface:
 *   - `provider:list`         → returns the static catalog from
 *                               `apps/backend/src/provider/catalog/`
 *                               (delivered as a JSON-serialisable copy of
 *                               the `ProviderDefinition` array).
 *   - `provider:auth-status`  → always empty: BetterC0de stores no provider
 *                               sign-in credentials (API keys live in
 *                               settings, CLI providers use their own login).
 *   - `provider:auth-clear`   → nothing to clear; kept for bridge stability.
 *
 * There is no sign-in channel: the ChatGPT sign-in flow stored refresh tokens
 * that nothing used and was removed (the backend deletes the old `auth.json`
 * on startup), and its channel went with it.
 */

const { IpcChannel } = require("./shared/ipc-contract.cjs")
const { safeHandle, rawHandle } = require("./shared/ipc-handlers-factory.cjs")

// ── Provider catalog (mirror of apps/backend/src/provider/catalog/) ──────
//
// We keep a renderer-facing copy here rather than reaching into the
// backend's TS source from the .cjs main process. The backend's catalog
// is the *runtime* source of truth (used by adapters, key resolution,
// auth.json); this list mirrors it for the Settings UI. A vitest-style
// parity check belongs in a follow-up so drift is caught at build time.
const PROVIDER_CATALOG = [
  {
    // CLI-backed: user runs `claude login` once; IDE never sees the API key.
    // Backend runtime adapter: provider/runtime/claude/ClaudeAdapter.ts.
    id: "claude",
    name: "Claude CLI",
    description: "Anthropic's local `claude` binary — uses your CLI login (no API key in BetterC0de).",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/cli-reference",
    defaultModels: [
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ],
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
  },
  {
    // CLI-backed: spawns OpenAI's `codex` binary; a ChatGPT subscription
    // login stays with the Codex CLI.
    // Backend runtime adapter: provider/runtime/codex/CodexAdapter.ts.
    id: "codex",
    name: "Codex CLI",
    description: "OpenAI's local `codex` binary — uses your CLI login (ChatGPT or API key).",
    docsUrl: "https://github.com/openai/codex",
    // Only 5.5+ — older models removed 2026-07-21 per user request.
    defaultModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
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
  },
  {
    // CLI-backed: spawns xAI's `grok` binary (Grok Build) over ACP.
    // Distinct from the "grok" API-key entry below.
    // Backend runtime adapter: provider/runtime/grok-cli/GrokAcpAdapter.ts.
    id: "grok-cli",
    name: "Grok CLI",
    description: "xAI's local `grok` binary (Grok Build) — uses your CLI login or XAI_API_KEY.",
    docsUrl: "https://x.ai/cli",
    defaultModels: ["grok-4.6", "grok-4.5"],
    authMethods: [
      {
        type: "cli",
        label: "Grok CLI",
        command: "grok",
        versionArgs: ["--version"],
        installHint: "npm i -g @xai-official/grok",
        loginCommand: "grok login",
      },
    ],
  },
  {
    // CLI-backed: spawns Cursor's `cursor-agent` binary over ACP. The bare
    // command `agent` is never used — it belongs to another vendor's CLI on
    // some machines (see runtime/cursor/CursorBinaryResolution.ts).
    // Backend runtime adapter: provider/runtime/cursor/CursorAcpAdapter.ts.
    id: "cursor",
    name: "Cursor",
    description: "Cursor's local `cursor-agent` binary — uses your Cursor CLI login.",
    docsUrl: "https://cursor.com/cli",
    defaultModels: [],
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
  },
  {
    id: "anthropic",
    name: "Claude API",
    description: "Anthropic's Claude family — Opus, Sonnet, Haiku.",
    docsUrl: "https://console.anthropic.com/settings/keys",
    defaultModels: ["opus", "sonnet", "haiku"],
    authMethods: [
      { type: "api-key", label: "API Key", placeholder: "sk-ant-...", envVars: ["ANTHROPIC_API_KEY"] },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT-5 family via API key. Use the Codex CLI for a ChatGPT subscription.",
    docsUrl: "https://platform.openai.com/api-keys",
    defaultModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
    authMethods: [
      { type: "api-key", label: "API Key", placeholder: "sk-...", envVars: ["OPENAI_API_KEY"] },
    ],
  },
  {
    id: "grok",
    name: "Grok (xAI)",
    description: "xAI's Grok models.",
    docsUrl: "https://console.x.ai/api-keys",
    defaultModels: ["grok-4.6", "grok-4.5"],
    authMethods: [
      { type: "api-key", label: "API Key", placeholder: "xai-...", envVars: ["XAI_API_KEY"] },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "Router across many providers — bring your own OR key.",
    docsUrl: "https://openrouter.ai/keys",
    defaultModels: [],
    authMethods: [
      { type: "api-key", label: "API Key", placeholder: "sk-or-...", envVars: ["OPENROUTER_API_KEY"] },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek-V3 / -R1 via DeepSeek's official API.",
    docsUrl: "https://platform.deepseek.com/api_keys",
    defaultModels: [],
    authMethods: [
      { type: "api-key", label: "API Key", placeholder: "sk-...", envVars: ["DEEPSEEK_API_KEY"] },
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    description: "Local model server (OpenAI-compatible). No key required.",
    docsUrl: "https://lmstudio.ai/docs/local-server",
    defaultModels: [],
    authMethods: [
      { type: "local-server", label: "Server URL", defaultBaseUrl: "http://localhost:1234", hint: "Override only if LM Studio is running on a non-default host/port." },
    ],
  },
]

// ── Handler registration ─────────────────────────────────────────────────
let registered = false

function registerProviderHandlers() {
  if (registered) return
  registered = true

  rawHandle(IpcChannel.ProviderList, async () => PROVIDER_CATALOG, {
    fallback: [],
    warnTag: "provider-ipc",
  })

  // The Settings UI indexes this map by provider id. No provider credential
  // is stored by BetterC0de any more, so it is always empty.
  rawHandle(IpcChannel.ProviderAuthStatus, async () => ({}), {
    fallback: null,
    warnTag: "provider-ipc",
  })

  safeHandle(IpcChannel.ProviderAuthClear, async (_event, { providerId } = {}) => {
    if (typeof providerId !== "string" || providerId.length === 0) {
      throw new Error("providerId is required")
    }
    return { ok: true }
  })

  console.log("[provider-ipc] Handlers registered")
}

module.exports = {
  registerProviderHandlers,
  PROVIDER_CATALOG,
}
