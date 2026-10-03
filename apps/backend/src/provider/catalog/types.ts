/**
 * Per-provider definition shape — one file per provider in this directory
 * exports a `ProviderDefinition` of this shape, and `index.ts` aggregates
 * them into a registry without coupling the provider catalog to a specific
 * runtime implementation.
 *
 * Why this exists:
 *   - The pre-registry layout had `keyResolution.ts` as 5+ near-identical
 *     functions and `providers-section.tsx` as a 305-line hardcoded array.
 *     Adding a new provider meant editing both files and remembering every
 *     duplicated piece. Per-file definitions keep all of a provider's
 *     concerns (env-var name, OAuth flow, model list quirks, base URL
 *     quirks) in one place.
 *   - OAuth-capable providers (ChatGPT/Codex, GitHub Copilot, Azure AD,
 *     etc.) need bespoke flows that do not fit the api-key-only mould.
 *     The `authMethods` array models the compatibility source's per-method shape so a
 *     single provider can offer "API key" AND "OAuth" side by side.
 */

import type { Settings } from "../../settings/schema"

/**
 * Where an API key was discovered for a provider. Mirrors the existing
 * `KeySource` from `auth/keyResolution.ts` so callers don't need to change.
 */
export type KeySource =
  | { kind: "settings" }
  | { kind: "environment" }
  | { kind: "cliConfig"; cli: string }
  | { kind: "oauth" }

export interface ResolvedApiKey {
  key: string
  source: KeySource
}

/** Prompt shown before authorize() runs, modelled on the compatibility source's
 *  `TextPrompt`/`SelectPrompt` schemas in `provider/auth.ts`. */
export type AuthPrompt =
  | {
      type: "text"
      key: string
      message: string
      placeholder?: string
      /** Renderer-side gating: only show this prompt when another prompt's
       *  answer matches. Identical to the compatibility source's `When` clause. */
      when?: { key: string; op: "eq" | "neq"; value: string }
    }
  | {
      type: "select"
      key: string
      message: string
      options: { label: string; value: string; hint?: string }[]
      when?: { key: string; op: "eq" | "neq"; value: string }
    }

/** Method by which a user grants the IDE access to a provider. */
export type AuthMethod =
  | {
      type: "api-key"
      label: string
      placeholder?: string
      /** Optional environment-variable fallbacks. Order matters: the first
       *  set value wins. Used by the registry's resolveKey() helper. */
      envVars?: string[]
      /** Optional CLI config files to scrape (e.g. `~/.claude/auth.json`).
       *  Each entry is `(cliName, fieldName)`. */
      cliConfig?: { cli: string; field: string }[]
      prompts?: AuthPrompt[]
    }
  | {
      type: "oauth"
      label: string
      /** Implementation lives in apps/shell/oauth/<provider>.cjs and is
       *  invoked by the OAuth IPC layer; the registry only carries the
       *  metadata the UI needs to render the button. */
      handler: string
      prompts?: AuthPrompt[]
    }
  | {
      type: "local-server"
      label: string
      /** Default base URL the user can override (LM Studio, Ollama). */
      defaultBaseUrl: string
      /** Documentation hint shown under the input. */
      hint?: string
    }
  | {
      /**
       * CLI-backed provider: the user installs a separate command-line tool
       * (e.g. `claude`, `codex`) which manages its own credentials. The IDE
       * never sees the API key — it shells out to the CLI and the CLI uses
       * whatever auth its parent vendor has set up. Re-auth is "run X in your
       * terminal" — the CLI's own browser/device-code flow stays the source
       * of truth, the IDE only surfaces install/auth status.
       */
      type: "cli"
      label: string
      /** Binary name expected on `PATH`; resolved via `where`/`which` at
       *  runtime so we get the absolute path for the status display. */
      command: string
      /** Args to fetch the CLI version. */
      versionArgs: readonly string[]
      /** Human-readable command the user runs to install the CLI. */
      installHint?: string
      /** Command the user runs in their terminal to log in. */
      loginCommand?: string
    }

export interface ProviderDefinition {
  /** Stable identifier — used as the settings key and in IPC channels. */
  readonly id: string
  /** Display name shown in the Settings UI. */
  readonly name: string
  /** One-line description shown under the provider header. Optional. */
  readonly description?: string
  /** Models the renderer should expose by default. The user can hide them
   *  via `hidden_models` and add others via `custom_models`. */
  readonly defaultModels: readonly string[]
  /** At least one auth method. Multiple are rendered side-by-side. */
  readonly authMethods: readonly AuthMethod[]
  /** Documentation URL surfaced in the UI as a "Get key" link. Optional. */
  readonly docsUrl?: string
  /** Whether the provider is enabled by default. Mirrors the existing
   *  `enabled` flag on `providerConfigSchema`. */
  readonly enabledByDefault: boolean
}

/**
 * Resolve an API key for a provider in the order:
 *   1. first enabled entry in settings.providers.<id>.api_keys, if managed
 *   2. settings.providers.<id>.api_key otherwise
 *   3. each `authMethods[*].envVars[*]` env var
 *   4. each `authMethods[*].cliConfig[*]` JSON file
 * A managed list suppresses external fallback even when empty or disabled.
 *
 * OAuth-stored tokens are NOT resolved here — the OAuth subsystem
 * (apps/backend/src/auth/store.ts) owns those.
 */
export function resolveProviderApiKey(
  def: ProviderDefinition,
  settings: Settings
): ResolvedApiKey | null {
  const pool =
    settings.providers?.[def.id as keyof typeof settings.providers]?.api_keys
  if (pool !== undefined) {
    const primary = pool.find(
      (entry) => entry.enabled && entry.api_key.length > 0
    )
    return primary
      ? { key: primary.api_key, source: { kind: "settings" } }
      : null
  }
  const settingsKey =
    settings.providers?.[def.id as keyof typeof settings.providers]?.api_key
  if (settingsKey && settingsKey.length > 0) {
    return { key: settingsKey, source: { kind: "settings" } }
  }

  for (const method of def.authMethods) {
    if (method.type !== "api-key") continue

    if (method.envVars) {
      for (const envVar of method.envVars) {
        const v = process.env[envVar]
        if (v && v.length > 0) {
          return { key: v, source: { kind: "environment" } }
        }
      }
    }

    if (method.cliConfig) {
      for (const { cli, field } of method.cliConfig) {
        const v = readCliConfigKey(cli, field)
        if (v) return { key: v, source: { kind: "cliConfig", cli } }
      }
    }
  }

  return null
}

// ── CLI config scraper ────────────────────────────────────────────────────
// Identical logic to the legacy `keyResolution.ts:readKeyFromCliConfig` —
// pulled into the registry module so the provider files do not need to
// duplicate it.

import fs from "node:fs"
import path from "node:path"
import os from "node:os"

function readCliConfigKey(cliName: string, field: string): string | null {
  const home = os.homedir()
  const configHome =
    process.platform === "win32"
      ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming"))
      : path.join(home, ".config")
  const candidates = [
    path.join(configHome, cliName, "auth.json"),
    path.join(configHome, cliName, "credentials.json"),
    path.join(home, `.${cliName}`, "auth.json"),
    path.join(home, `.${cliName}`, "credentials.json"),
  ]
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8")
      const parsed = JSON.parse(raw)
      const value = parsed?.[field] ?? parsed?.apiKey
      if (typeof value === "string" && value.length > 0) return value
    } catch {
      // missing or malformed — continue.
    }
  }
  return null
}
