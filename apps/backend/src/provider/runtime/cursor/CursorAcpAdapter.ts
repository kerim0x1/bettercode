import {
  AcpAdapterBase,
  type AcpAdapterOptions,
  type AcpProviderProfile,
} from "../acp/AcpAdapterBase"
import { ProviderChatModeUnsupportedError } from "../providerChatModeErrors"
import {
  buildCursorDiscoveredModelsFromConfigOptions,
  buildCursorDiscoveredModelsFromSessionModels,
  findCursorModelConfigOption,
  type CursorAcpRuntimeSettings,
} from "./CursorAcpSupport"
import {
  cursorAccountModels,
  cursorModelAccountIdentity,
  saveCursorAccountModels,
} from "./CursorAccountModels"
import {
  CURSOR_RUNTIME_PROFILE,
  type CursorAcpRuntime,
  type CursorAcpRuntimeOptions,
} from "./CursorAcpRuntime"
import { registerCursorExtensions } from "./CursorAcpExtensions"
import path from "node:path"
import {
  CURSOR_BINARY_NAME,
  resolveCursorBinary,
} from "./CursorBinaryResolution"

/**
 * Cursor's `cursor-agent acp` provider. Session lifecycle, turn dispatch,
 * permission routing and cleanup quarantine live in `acp/AcpAdapterBase`;
 * this file declares only what Cursor does differently: how its binary is
 * found, where its models come from, its `cursor/*` protocol extensions, and
 * that a missing safe mode is a hard failure.
 */

export const CURSOR_ACP_PENDING_REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export interface CursorAcpAdapterOptions extends AcpAdapterOptions<CursorAcpRuntimeSettings> {
  readonly apiEndpoint?: string | null
  readonly modelCacheDir?: string
  readonly statusEnv?: NodeJS.ProcessEnv
  /** Deterministic account namespace for a runtime-factory test. */
  readonly modelAccountIdentity?: string | null
  readonly runtimeFactory?: CursorAcpRuntimeFactory
}

export type CursorAcpRuntimeFactory = (
  input: CursorAcpRuntimeOptions
) => CursorAcpRuntime

/**
 * Absolute on-disk path, or null when Cursor is not installed.
 * A bare `cursor-agent` is not returned: on Windows `cmd.exe` searches the
 * workspace cwd before PATH, so that name would run a repository shim.
 */
function cursorBinaryPath(options: CursorAcpAdapterOptions): string | null {
  // Test factories bypass binary resolution (they never spawn); the real
  // runtime must only ever receive a verified absolute path.
  if (options.runtimeFactory) {
    return options.binaryPath?.trim() || CURSOR_BINARY_NAME
  }
  const resolved = resolveCursorBinary(options.binaryPath)
  if (!resolved) return null
  const absolute = path.resolve(resolved.binaryPath)
  return path.isAbsolute(absolute) ? absolute : null
}

function unavailableCursorSafeMode(
  intent: string,
  compatibleMode: string
): Error {
  // Cursor normally advertises these modes, so this is the rare build that
  // does not. Fail closed — but with a message the hub forwards verbatim,
  // instead of the generic "Provider turn dispatch failed."
  return new ProviderChatModeUnsupportedError({
    providerLabel: "Cursor Agent",
    chatMode: intent === "ask" ? "Ask / Read-only" : intent,
    detail: `the session did not advertise a compatible ${compatibleMode} mode`,
  })
}

export const CURSOR_PROFILE: AcpProviderProfile<
  CursorAcpRuntimeSettings,
  CursorAcpAdapterOptions
> = {
  kind: "cursor",
  displayName: "Cursor",
  label: "Cursor",
  defaultInstanceId: "cursor",
  continuationPrefix: "cursor",
  errorCodePrefix: "CURSOR_ACP",
  modelProbeThreadId: "_cursor-model-probe",
  pendingRequestTimeoutMs: CURSOR_ACP_PENDING_REQUEST_TIMEOUT_MS,
  // The asynchronous status probe owns executable discovery. Avoid a
  // synchronous PATH/version child process in hot configuration checks.
  isConfigured: (options) => cursorBinaryPath(options) !== null,
  resolveRuntimeSettings: async (options) => {
    const binaryPath = cursorBinaryPath(options)
    if (!binaryPath) {
      throw new Error(
        "Cursor Agent CLI is not installed. Install it from cursor.com/install, or set a full path in Settings → Providers."
      )
    }
    return {
      binaryPath,
      apiEndpoint: options.apiEndpoint,
    }
  },
  runtimeProfile: CURSOR_RUNTIME_PROFILE,
  models: {
    fallback: cursorAccountModels,
    cacheIdentity: cursorModelAccountIdentity,
    onLiveModels: saveCursorAccountModels,
    fromStarted: (started) => {
      const option = findCursorModelConfigOption(started.configOptions)
      if (option) {
        return buildCursorDiscoveredModelsFromConfigOptions(
          started.configOptions
        )
      }
      return buildCursorDiscoveredModelsFromSessionModels(
        started.sessionSetupResult.models
      )
    },
    isEmptyAuthoritative: (started) =>
      Boolean(findCursorModelConfigOption(started.configOptions)) ||
      Array.isArray(started.sessionSetupResult.models?.availableModels),
    unconfiguredCheckedAt: "now",
  },
  registerExtensions: registerCursorExtensions,
  supportsUserInput: true,
  setModelFailure: "throw",
  missingSafeMode: { behaviour: "throw", error: unavailableCursorSafeMode },
}

export class CursorAcpAdapter extends AcpAdapterBase<
  CursorAcpRuntimeSettings,
  CursorAcpAdapterOptions
> {
  constructor(options: CursorAcpAdapterOptions = {}) {
    super(CURSOR_PROFILE, options)
  }
}
