import { assetUrl } from "@/lib/asset-url"
import type { UiProvider } from "@/lib/provider-types"

/**
 * Built-in provider entries. CLI and direct API models arrive at runtime.
 *
 * Plugin providers are merged in on
 * top of this list via the `useProviders` hook at runtime — this keeps the
 * plugin system decoupled from the core list while still letting the UI
 * show a single unified picker.
 *
 * Model tiers ("Flagship" / "Fast" / "Coding" / "Reasoning" / "Balanced" /
 * "Free") are labels only — they control how models group in the picker,
 * not which features the backend enables.
 */
export const builtinProviders: UiProvider[] = [
  {
    id: "codex",
    name: "Codex (CLI)",
    logo: assetUrl("icons/providers/openai.svg"),
    invertDark: true,
    providerKind: "codex",
    providerInstanceId: "codex",
    models: [],
  },
  // Claude CLI — native backend builtin. Routes via /chat/send → ProviderHub
  // (chat.ts:38) → node-backend/src/provider/runtime/claude/ClaudeAdapter.ts.
  // Uses the Claude Agent SDK to spawn the local `claude` binary; falls back
  // to ANTHROPIC_API_KEY env if no CLI session credentials are configured.
  // No API key is required when the user is logged into `claude` via CLI.
  {
    id: "claude",
    name: "Claude CLI",
    logo: assetUrl("icons/providers/claude.svg"),
    providerKind: "claude",
    providerInstanceId: "claude",
    models: [],
  },
  // Cursor Agent — BetterC0de treats Cursor as a first-party provider driver.
  // Models are discovered through ACP at runtime, so the built-in fallback
  // intentionally starts empty and can be filled by provider-instance metadata.
  {
    id: "cursor",
    name: "Cursor",
    logo: "",
    providerKind: "cursor",
    providerInstanceId: "cursor",
    models: [],
  },
  // Grok CLI — xAI's local `grok` binary (Grok Build) driven over ACP
  // (`grok agent stdio`). providerKind "grok_cli" is distinct from the
  // "grok" xAI API-key provider below. Its inventory comes from ACP and
  // the CLI's own cache.
  {
    id: "grok-cli",
    name: "Grok CLI",
    // Grok's own mark — not the X/Twitter logo and not xAI's company slash.
    // Black-on-transparent plus `invertDark`, because `ProviderIcon` renders
    // logos through an `<img>`: an SVG loaded that way is an isolated
    // document, so a `currentColor` fill cannot inherit the page's text
    // colour and would resolve to black on a dark background.
    logo: assetUrl("icons/providers/grok.svg"),
    invertDark: true,
    providerKind: "grok_cli",
    providerInstanceId: "grok-cli",
    models: [],
  },
  // BetterC0de compatibility inventory is discovered from runtime snapshots
  // or custom models, so the static list stays empty.
  {
    id: "betterc0de",
    name: "BetterC0de",
    logo: "",
    providerKind: "betterc0de",
    providerInstanceId: "betterc0de",
    models: [],
  },
  // OpenCode CLI — the upstream `opencode` binary (BetterC0de's sibling
  // protocol on the same OpenCode-family surface), driven through its
  // headless `opencode serve` server. providerKind "opencode_cli" is kept
  // distinct from the BetterC0de compatibility kind so a thread's provider
  // stays stable across the two. Models are discovered at runtime from the
  // CLI's v1/v2 inventory (slugs in the `opencode/model` format); the
  // curated entry below only wins until the live metadata probe resolves.
  {
    id: "opencode-cli",
    name: "OpenCode CLI",
    // opencode ships no brand asset in this repo yet — the generic terminal
    // glyph is the same fallback ProviderIcon uses for logo-less providers.
    logo: "",
    providerKind: "opencode_cli",
    providerInstanceId: "opencode-cli",
    models: [{ id: "opencode/big-pickle", name: "Big Pickle", context: "400K", tier: "Flagship" }],
  },
  // OpenAI API (direct API key)
  {
    id: "openai-api",
    name: "OpenAI API",
    logo: assetUrl("icons/providers/openai.svg"),
    invertDark: true,
    providerKind: "openai",
    openaiTransport: "api",
    models: [],
  },
  {
    id: "anthropic-api",
    name: "Claude API",
    logo: assetUrl("icons/providers/claude.svg"),
    providerKind: "anthropic",
    models: [],
  },
  // Google oAuth (Gemini) was removed from the builtin picker 2026-07-21 per
  // user request. The generic "google" providerKind heuristics elsewhere
  // (thinking-mode, capabilities, labels) stay — plugin/API instances may
  // still use them.
  // Grok (xAI API)
  {
    id: "grok",
    name: "Grok",
    logo: assetUrl("icons/providers/grok.svg"),
    invertDark: true,
    // The backend lists this API account's language models and capabilities.
    models: [],
  },
  // OpenRouter — its own picker entry: shows exactly the model ids the user
  // entered under Settings → Providers → OpenRouter → Custom models (merged
  // in by useProvidersWithLmStudio; empty until the user adds some).
  {
    id: "openrouter",
    name: "OpenRouter",
    logo: assetUrl("icons/providers/openrouter.svg"),
    // The svg paints with `currentColor`, which resolves to black inside the
    // <img> ProviderIcon uses — invert it on dark like the Grok mark.
    invertDark: true,
    providerKind: "openrouter",
    models: [],
  },
  // OpenRouter family groups — models split by actual vendor (all use
  // providerKind "openrouter" for backend). The static entries below are the
  // curated fallback; when an OpenRouter key is configured the backend's
  // cached live catalog replaces them (see useProvidersWithLmStudio). When a
  // fallback id 404s, re-check https://openrouter.ai/api/v1/models instead
  // of guessing a replacement.
  // Qwen (via OpenRouter)
  {
    id: "or-qwen",
    name: "Qwen",
    logo: assetUrl("icons/providers/qwen.png"),
    providerKind: "openrouter",
    models: [
      {
        id: "qwen/qwen3.8-max",
        name: "Qwen 3.8 Max",
        context: "1M",
        tier: "Flagship",
      },
      {
        id: "qwen/qwen3.8-27b",
        name: "Qwen 3.8 27B",
        context: "1M",
        tier: "Balanced",
      },
      {
        id: "qwen/qwen3.8-flash",
        name: "Qwen 3.8 Flash",
        context: "1M",
        tier: "Fast",
      },
      {
        id: "qwen/qwen3-coder-next",
        name: "Qwen 3 Coder Next",
        context: "256K",
        tier: "Coding",
      },
    ],
  },
  // DeepSeek (via OpenRouter)
  {
    id: "or-deepseek",
    name: "DeepSeek",
    logo: assetUrl("icons/providers/deepseek.png"),
    providerKind: "openrouter",
    models: [
      {
        id: "deepseek/deepseek-v4-pro-0813",
        name: "DeepSeek V4 Pro",
        context: "1M",
        tier: "Flagship",
      },
      {
        id: "deepseek/deepseek-v4-flash-0731",
        name: "DeepSeek V4 Flash",
        context: "1.3M",
        tier: "Fast",
      },
      {
        id: "deepseek/deepseek-v3.2",
        name: "DeepSeek V3.2",
        context: "160K",
        tier: "Balanced",
      },
    ],
  },
  // LM Studio (local)
  {
    id: "lmstudio",
    name: "LM Studio",
    logo: assetUrl("icons/providers/lmstudio.png"),
    models: [] as {
      id: string
      name: string
      context: string
      tier: string
    }[],
  },
]
