import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { detectCliAsync } from "../../../cli/detect"
import { resolveOpenCodeBinaryAsync } from "./OpenCodeBinaryResolution"

/**
 * Status probe for the OpenCode CLI.
 *
 * The ACP session itself verifies the login by speaking the protocol; this
 * probe answers the Settings card without spawning a server: binary on disk,
 * `--version`, and whether `opencode auth login` (or a provider key in the
 * environment) has left credentials behind.
 */
export interface OpenCodeProviderAuth {
  readonly status: "authenticated" | "unauthenticated" | "unknown"
  readonly type?: string
  readonly label?: string
}

export interface OpenCodeProviderStatusProbe {
  readonly installed: boolean
  readonly configured: boolean
  readonly binaryPath: string | null
  readonly version: string | null
  readonly status: "ready" | "warning" | "error"
  readonly auth: OpenCodeProviderAuth
  readonly message?: string
}

const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "OPENCODE_API_KEY",
] as const

export async function probeOpenCodeProviderStatusAsync(input: {
  readonly binaryPath?: string | null
  readonly env?: NodeJS.ProcessEnv
  readonly refresh?: boolean
}): Promise<OpenCodeProviderStatusProbe> {
  const resolved = await resolveOpenCodeBinaryAsync(input.binaryPath)
  if (!resolved) {
    return {
      installed: false,
      configured: false,
      binaryPath: null,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message:
        "OpenCode CLI not found. Install it from https://opencode.ai (or `npm i -g opencode-ai`) and run `opencode auth login`.",
    }
  }
  const auth = detectOpenCodeAuth(input.env ?? process.env)
  const status = await detectCliAsync(resolved.binaryPath, {
    refresh: input.refresh,
    isAuthenticated: () => auth.status === "authenticated",
    authType: auth.type ?? "cli",
  })
  if (!status.installed) {
    return {
      installed: false,
      configured: false,
      binaryPath: resolved.binaryPath,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message:
        "OpenCode CLI could not be started. Reinstall it from https://opencode.ai and run `opencode auth login`.",
    }
  }
  if (auth.status === "authenticated") {
    return {
      installed: true,
      configured: true,
      binaryPath: status.binaryPath || resolved.binaryPath,
      version: status.version,
      status: "ready",
      auth,
    }
  }
  return {
    installed: true,
    configured: false,
    binaryPath: status.binaryPath || resolved.binaryPath,
    version: status.version,
    status: "warning",
    auth,
    message:
      "OpenCode is installed but no login was found. Run `opencode auth login` (or configure a provider key in the instance environment).",
  }
}

export function detectOpenCodeAuth(
  env: NodeJS.ProcessEnv = process.env
): OpenCodeProviderAuth {
  for (const candidate of openCodeAuthPaths(env)) {
    try {
      if (fs.statSync(candidate).size > 0) {
        return {
          status: "authenticated",
          type: "cli",
          label: "opencode auth login",
        }
      }
    } catch {
      // Try the next location.
    }
  }
  for (const key of PROVIDER_ENV_KEYS) {
    if (env[key]?.trim()) {
      return { status: "authenticated", type: "api-key", label: key }
    }
  }
  return { status: "unauthenticated" }
}

function openCodeAuthPaths(env: NodeJS.ProcessEnv): string[] {
  const dataHome = env.XDG_DATA_HOME?.trim()
    ? path.join(env.XDG_DATA_HOME.trim(), "opencode")
    : path.join(os.homedir(), ".local", "share", "opencode")
  return [
    path.join(dataHome, "auth.json"),
    path.join(os.homedir(), ".opencode", "auth.json"),
    path.join(os.homedir(), ".config", "opencode", "auth.json"),
  ]
}
