/**
 * Provider catalog + OAuth IPC handlers.
 *
 * Renderer-facing surface:
 *   - `provider:list`         → returns the static catalog from
 *                               `apps/backend/src/provider/catalog/`
 *                               (delivered as a JSON-serialisable copy of
 *                               the `ProviderDefinition` array).
 *   - `provider:auth-status`  → which providers currently have a stored
 *                               credential (used by Settings to render
 *                               "Signed in" badges).
 *   - `provider:oauth-start`  → kicks off a provider's OAuth flow, opens
 *                               the authorise URL in the user's browser,
 *                               awaits the callback, and POSTs the
 *                               resulting credential to the backend.
 *   - `provider:auth-clear`   → drops the stored credential.
 *
 * The OAuth flows themselves live in `apps/shell/oauth/<handler>.cjs`.
 * Each file exports `{ id, handler, start }` and is registered below in
 * the `OAUTH_HANDLERS` map. Adding a new flow = a new file + one entry.
 */

const { shell } = require("electron")
const { IpcChannel } = require("./shared/ipc-contract.cjs")
const { safeHandle, rawHandle } = require("./shared/ipc-handlers-factory.cjs")
const { fetchJson } = require("./shared/fetch-json.cjs")
const { getBackendConnection } = require("./shared/backend-endpoint.cjs")
const { isAllowedExternalUrl } = require("./shared/urlPolicy.cjs")

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
    // CLI-backed: spawns OpenAI's `codex` binary, distinct from the openai
    // OAuth flow which talks chatgpt.com directly without the CLI.
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
    // CLI-backed: spawns the upstream `opencode` binary's headless server and
    // drives its v1/v2 HTTP surface. Kept distinct from the BetterC0de
    // compatibility entry so both can show side by side.
    // Backend runtime adapter: provider/runtime/opencode/OpenCodeAdapter.ts.
    id: "opencode-cli",
    name: "OpenCode CLI",
    description: "The local `opencode` binary — uses your CLI login (v1 and v2 APIs).",
    docsUrl: "https://opencode.ai/docs",
    // Used only until the CLI's live inventory advertises its model picker.
    defaultModels: ["opencode/big-pickle"],
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
    name: "OpenAI / ChatGPT",
    description: "GPT-5 family via API key OR ChatGPT Pro/Plus OAuth.",
    docsUrl: "https://platform.openai.com/api-keys",
    defaultModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
    authMethods: [
      { type: "api-key", label: "API Key", placeholder: "sk-...", envVars: ["OPENAI_API_KEY"] },
      { type: "oauth", label: "Sign in with ChatGPT (Pro/Plus)", handler: "codex-oauth" },
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

// ── OAuth handlers ───────────────────────────────────────────────────────
const OAUTH_HANDLERS = {
  "codex-oauth": require("./oauth/codex.cjs"),
}

// ── Backend HTTP helper ──────────────────────────────────────────────────
// Auth.set/clear travel through the backend so credentials live in the
// authoritative store (`apps/backend/src/auth/store.ts`). The main process
// installs the reader in `backend-endpoint.cjs` once the backend publishes
// its port and bearer token. The renderer never sees that token.
const AUTH_STATUS_TYPES = new Set(["oauth", "api", "wellknown"])

function getBackendInfo() {
  const cfg = getBackendConnection()
  if (!cfg) {
    throw new Error("Backend not ready — provider IPC called before bootstrap")
  }
  return cfg
}

function sanitizeAuthStatus(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Backend returned an invalid auth status")
  }
  const status = {}
  for (const [id, type] of Object.entries(payload)) {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) continue
    if (!AUTH_STATUS_TYPES.has(type)) continue
    status[id] = type
  }
  return status
}

async function postBackend(path, body) {
  const { port, token } = getBackendInfo()
  return fetchJson(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function deleteBackend(path) {
  const { port, token } = getBackendInfo()
  return fetchJson(`http://127.0.0.1:${port}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function getBackend(path) {
  const { port, token } = getBackendInfo()
  return fetchJson(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

// ── Handler registration ─────────────────────────────────────────────────
let registered = false

function registerProviderHandlers() {
  if (registered) return
  registered = true

  rawHandle(IpcChannel.ProviderList, async () => PROVIDER_CATALOG, {
    fallback: [],
    warnTag: "provider-ipc",
  })

  rawHandle(IpcChannel.ProviderAuthStatus, async () => {
    // The Settings UI indexes this map by provider id. An `{ok:true}` envelope
    // would pollute that map, so the handler returns the record itself.
    return sanitizeAuthStatus(await getBackend("/api/v1/providers/auth-status"))
  }, { fallback: null, warnTag: "provider-ipc" })

  safeHandle(IpcChannel.ProviderAuthClear, async (_event, { providerId } = {}) => {
    if (typeof providerId !== "string" || providerId.length === 0) {
      throw new Error("providerId is required")
    }
    return deleteBackend(`/api/v1/providers/${encodeURIComponent(providerId)}/credential`)
  })

  safeHandle(IpcChannel.ProviderOauthStart, async (_event, { providerId, handler } = {}) => {
    if (typeof providerId !== "string" || providerId.length === 0) {
      throw new Error("providerId is required")
    }
    if (typeof handler !== "string" || !Object.hasOwn(OAUTH_HANDLERS, handler)) {
      throw new Error(`Unknown OAuth handler: ${handler}`)
    }
    const impl = OAUTH_HANDLERS[handler]
    if (impl.id !== providerId) {
      // The renderer claimed providerId X but the handler is registered for
      // provider Y — that's a contract violation, refuse rather than write
      // a credential under the wrong key.
      throw new Error(`Handler ${handler} is registered for ${impl.id}, not ${providerId}`)
    }

    const { url, instructions, wait, close } = await impl.start()
    // Opening externally puts the URL in the user's default browser. The
    // local callback server accepts the redirect; we do not need to spawn
    // a BrowserWindow. Packaged and dev both refuse non-HTTPS authorize URLs.
    let credential
    try {
      if (typeof url !== "string" || !isAllowedExternalUrl(url, true)) {
        throw new Error("Refusing to open a non-HTTPS OAuth URL")
      }
      await shell.openExternal(url)
      credential = await wait()
    } finally {
      close?.()
    }
    await postBackend(
      `/api/v1/providers/${encodeURIComponent(providerId)}/credential`,
      credential,
    )
    return { ok: true, provider: providerId, instructions }
  })

  console.log("[provider-ipc] Handlers registered")
}

module.exports = {
  registerProviderHandlers,
  PROVIDER_CATALOG,
  OAUTH_HANDLERS,
}
