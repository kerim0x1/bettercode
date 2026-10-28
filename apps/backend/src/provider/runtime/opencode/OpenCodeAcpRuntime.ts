import {
  createAcpRuntime,
  type AcpEvent,
  type AcpExit,
  type AcpMode,
  type AcpModeState,
  type AcpPermissionRequest,
  type AcpPlanUpdate,
  type AcpRuntime,
  type AcpRuntimeOptions,
  type AcpRuntimeProfile,
  type AcpSessionSetupResult,
  type AcpStarted,
  type AcpToolCallState,
} from "../acp/AcpRuntimeBase"

/**
 * OpenCode's `opencode acp` runtime.
 *
 * The upstream `opencode` binary speaks the Agent Client Protocol over stdio
 * (JSON-RPC), the same protocol family as `cursor-agent acp` and
 * `grok agent stdio`. The protocol machinery lives in `acp/AcpRuntimeBase`;
 * this file only declares what OpenCode does differently on the wire: the
 * spawn shape and the permission config that makes it ask before changing the
 * workspace.
 */

/**
 * `ask`: the chat path, where the client owns approvals.
 * `deny`: unattended helpers (native text generation) that must never see an
 * approval request at all.
 */
export type OpenCodePermissionPolicy = "ask" | "deny"

export interface OpenCodeAcpRuntimeSettings {
  readonly binaryPath?: string | null
  readonly permissionPolicy?: OpenCodePermissionPolicy
}

export type OpenCodeAcpMode = AcpMode
export type OpenCodeAcpModeState = AcpModeState
export type OpenCodeAcpStarted = AcpStarted
export type OpenCodeAcpSessionSetupResult = AcpSessionSetupResult
export type OpenCodeAcpToolCallState = AcpToolCallState
export type OpenCodeAcpPlanUpdate = AcpPlanUpdate
export type OpenCodeAcpPermissionRequest = AcpPermissionRequest
export type OpenCodeAcpExit = AcpExit
export type OpenCodeAcpEvent = AcpEvent
export type OpenCodeAcpRuntime = AcpRuntime
export type OpenCodeAcpRuntimeOptions =
  AcpRuntimeOptions<OpenCodeAcpRuntimeSettings>

/**
 * OpenCode's own tools run `read`/`glob`/`grep` without asking, but `write`
 * and `edit` land as soon as the agent decides to call them unless the child
 * is started with a permission rule of `ask`. BetterC0de owns the approval
 * decision (grants, plan mode, read-only), so every mutating category asks and
 * the adapter answers through `session/request_permission`.
 *
 * Shell commands are included: running a command is a write in disguise, and
 * the app's permission ceiling cannot see inside it otherwise.
 */
export function openCodePermissionConfigEnv(
  env: NodeJS.ProcessEnv | undefined,
  policy: OpenCodePermissionPolicy = "ask"
): NodeJS.ProcessEnv {
  const decision = policy === "deny" ? "deny" : "ask"
  const permissions = {
    edit: decision,
    bash: decision,
    webfetch: decision,
  } as const
  const existingRaw = env?.OPENCODE_CONFIG_CONTENT?.trim()
  let merged: Record<string, unknown> = { permission: permissions }
  if (existingRaw) {
    try {
      const parsed: unknown = JSON.parse(existingRaw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        merged = {
          ...record,
          permission: {
            ...(record.permission &&
            typeof record.permission === "object" &&
            !Array.isArray(record.permission)
              ? (record.permission as Record<string, unknown>)
              : {}),
            ...permissions,
          },
        }
      }
    } catch {
      // A malformed override is replaced rather than passed through, so the
      // permission boundary never depends on the user's JSON being valid.
    }
  }
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(merged),
  }
}

export function buildOpenCodeAcpSpawnInput(
  settings: OpenCodeAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv
) {
  return {
    // AcpJsonRpcClient wraps a non-.exe command in cmd.exe on Windows; the
    // verified absolute path (or bare PATH name for tests) is enough here.
    command: settings?.binaryPath?.trim() || "opencode",
    args: ["acp"],
    cwd,
    env: openCodePermissionConfigEnv(
      environment ?? process.env,
      settings?.permissionPolicy ?? "ask"
    ),
  }
}

/** `opencode acp` requires a CLI login (`opencode auth login`). */
export function openCodeAuthError(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(
    `OpenCode is not authenticated. Run \`opencode auth login\` in a terminal and try again. (${detail})`
  )
}

// Plain ACP client capabilities. OpenCode runs its own fs/shell tools, so the
// client does not need to expose either; permission requests are the boundary.
const OPENCODE_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const

export const OPENCODE_RUNTIME_PROFILE: AcpRuntimeProfile<OpenCodeAcpRuntimeSettings> =
  {
    label: "OpenCode",
    buildSpawnInput: buildOpenCodeAcpSpawnInput,
    clientCapabilities: OPENCODE_CLIENT_CAPABILITIES,
    // A logged-in `opencode` serves sessions directly. Only a real auth error
    // triggers the one authenticate round-trip, then the login hint.
    auth: { strategy: "lazy", toAuthError: openCodeAuthError },
  }

export function createOpenCodeAcpRuntime(
  options: OpenCodeAcpRuntimeOptions
): OpenCodeAcpRuntime {
  return createAcpRuntime(OPENCODE_RUNTIME_PROFILE, options)
}
