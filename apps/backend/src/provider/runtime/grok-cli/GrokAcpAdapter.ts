import {
  AcpAdapterBase,
  type AcpAdapterOptions,
  type AcpProviderProfile,
} from "../acp/AcpAdapterBase"
import {
  buildGrokDiscoveredModelsFromConfigOptions,
  type GrokAcpRuntimeSettings,
} from "./GrokAcpSupport"
import {
  GROK_RUNTIME_PROFILE,
  type GrokAcpRuntime,
  type GrokAcpRuntimeOptions,
} from "./GrokAcpRuntime"
import { resolveGrokBinaryAsync } from "./GrokBinaryResolution"
import { buildGrokModelsFromSessionModelState } from "./GrokModelCache"
import {
  grokAccountModels,
  grokModelAccountIdentity,
  saveGrokAccountModels,
} from "./GrokAccountModels"

/**
 * xAI Grok Build CLI provider — drives `grok agent stdio` over the Agent
 * Client Protocol. Session lifecycle, turn dispatch, permission routing and
 * cleanup quarantine live in `acp/AcpAdapterBase`; this file declares only
 * what Grok does differently: async binary verification, the on-disk model
 * cache, the per-tool-call read-only ceiling, and that Grok speaks plain ACP
 * (no `cursor/*` extensions, so no user-input requests and no session modes
 * to fail closed on).
 */

export const GROK_ACP_PENDING_REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export interface GrokAcpAdapterOptions extends AcpAdapterOptions<GrokAcpRuntimeSettings> {
  readonly runtimeFactory?: GrokAcpRuntimeFactory
  readonly modelCacheDir?: string
  readonly modelHomeDir?: string
}

export type GrokAcpRuntimeFactory = (
  input: GrokAcpRuntimeOptions
) => GrokAcpRuntime

/**
 * Whether the user asked for a mode in which the agent may look but not touch.
 */
export function isGrokReadOnlyIntent(input: {
  readonly chatMode?: string | null
  readonly runtimeMode?: string | null
}): boolean {
  const values = [input.chatMode, input.runtimeMode].map((value) =>
    value?.trim().toLowerCase()
  )
  return values.some(
    (value) =>
      value === "ask" ||
      value === "plan" ||
      value === "security" ||
      value === "read-only" ||
      value === "approval-required"
  )
}

/**
 * Read-only enforcement for Grok, decided from the ACP permission request's
 * own `kind`.
 *
 * Grok's ACP agent advertises no session modes, and its `--sandbox read-only`
 * profile is a documented no-op on Windows (Landlock/Seatbelt only — verified
 * on this machine: no sandbox event is ever written). What Grok *does* do is
 * ask the client before running a tool, and that request is a boundary we own.
 *
 * A prompt instruction is deliberately NOT the mechanism: asking a model not
 * to edit does not remove the tool, so it would make read-only a claim rather
 * than a guarantee. Denying the call does.
 *
 * Reads stay allowed — searching and reading files is the point of the mode.
 * Anything that can change the workspace is refused, including shell commands
 * (a command is a write in disguise) and unrecognised kinds (fail closed).
 */
export function grokReadOnlyDeniesAcpKind(kind: string | "unknown"): boolean {
  switch (kind) {
    case "read":
    case "fetch":
    case "search":
      return false
    default:
      return true
  }
}

export const GROK_PROFILE: AcpProviderProfile<
  GrokAcpRuntimeSettings,
  GrokAcpAdapterOptions
> = {
  kind: "grok_cli",
  displayName: "Grok CLI",
  label: "Grok",
  defaultInstanceId: "grok-cli",
  continuationPrefix: "grok-cli",
  errorCodePrefix: "GROK_ACP",
  modelProbeThreadId: "_grok-model-probe",
  pendingRequestTimeoutMs: GROK_ACP_PENDING_REQUEST_TIMEOUT_MS,
  // The bounded async status/runtime path performs authoritative xAI binary
  // verification. Synchronous turn admission must remain filesystem-free.
  isConfigured: () => true,
  resolveRuntimeSettings: async (options) => {
    // Test factories bypass binary resolution (they never spawn); the real
    // runtime must only ever receive a verified absolute path.
    const binaryPath = options.runtimeFactory
      ? options.binaryPath?.trim() || "grok"
      : ((await resolveGrokBinaryAsync(options.binaryPath))?.binaryPath ?? null)
    if (!binaryPath) {
      throw new Error(
        "xAI Grok CLI not found. Install it via `irm https://x.ai/cli/install.ps1 | iex` — a `grok` command from another package on PATH is deliberately not used."
      )
    }
    return { binaryPath }
  },
  runtimeProfile: GROK_RUNTIME_PROFILE,
  models: {
    // Restore only this login's last successful ACP snapshot. A CLI cache
    // written after the current login can seed the first snapshot.
    fallback: (options) => grokAccountModels(options),
    cacheIdentity: (options) => grokModelAccountIdentity(options),
    onLiveModels: (options, models) => saveGrokAccountModels(options, models),
    // Grok reports its inventory in the typed `models` field; only fall
    // back to the config-option scan for agents that use that instead.
    fromStarted: (started) => {
      const advertised = buildGrokModelsFromSessionModelState(
        started.sessionSetupResult?.models
      )
      return Array.isArray(started.sessionSetupResult?.models?.availableModels)
        ? advertised
        : buildGrokDiscoveredModelsFromConfigOptions(started.configOptions)
    },
    isEmptyAuthoritative: (started) =>
      Array.isArray(started.sessionSetupResult?.models?.availableModels) &&
      started.sessionSetupResult?.models?.availableModels?.length === 0,
    unconfiguredCheckedAt: "probe-start",
  },
  // Read-only enforcement happens here rather than in the session mode:
  // Grok advertises no read-only mode, so this request is the only place
  // the guarantee can actually be made.
  permissionCeiling: ({ runtimeMode, kind }) =>
    isGrokReadOnlyIntent({ runtimeMode }) && grokReadOnlyDeniesAcpKind(kind)
      ? {
          reason:
            "Read-only mode: Grok may read and search this workspace but not change it.",
        }
      : null,
  // Grok Build exposes no user-input request over ACP (Cursor has its
  // `cursor/ask_question` extension; Grok has nothing equivalent).
  supportsUserInput: false,
  // Grok may not accept a synthetic "model" configId when its session
  // advertises no model picker — a rejected model update is non-fatal.
  setModelFailure: "ignore",
  // Grok advertises no session modes at all, so there is nothing to select.
  // This used to throw and kill the turn. It no longer needs to: the
  // permission ceiling above denies every workspace-changing tool for a
  // read-only intent, which is a stronger guarantee than a mode label anyway
  // — it is enforced per tool call rather than trusted.
  missingSafeMode: { behaviour: "keep-native" },
}

export class GrokAcpAdapter extends AcpAdapterBase<
  GrokAcpRuntimeSettings,
  GrokAcpAdapterOptions
> {
  constructor(options: GrokAcpAdapterOptions = {}) {
    super(GROK_PROFILE, options)
  }
}
