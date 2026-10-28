import type { ProviderModel } from "@betterc0de/schema"
import {
  AcpAdapterBase,
  type AcpAdapterOptions,
  type AcpProviderProfile,
} from "../acp/AcpAdapterBase"
import {
  buildAcpCapabilitiesFromConfigOptions,
  buildAcpDiscoveredModelsFromConfigOptions,
  findAcpModelConfigOption,
} from "../acp/AcpSessionConfig"
import { resolveOpenCodeBinaryAsync } from "./OpenCodeBinaryResolution"
import {
  OPENCODE_RUNTIME_PROFILE,
  type OpenCodeAcpRuntime,
  type OpenCodeAcpRuntimeOptions,
  type OpenCodeAcpRuntimeSettings,
} from "./OpenCodeAcpRuntime"

/**
 * OpenCode's `opencode acp` provider.
 *
 * Session lifecycle, turn dispatch, permission routing, tool/part mapping,
 * mode selection and cleanup live in `acp/AcpAdapterBase`. This file declares
 * only what OpenCode does differently: binary verification, its live model
 * picker (config options), the read-only ceiling for non-plan intents, and
 * that its `question` tool has no ACP request (so user input stays local to
 * the agent).
 */

export type OpenCodeAcpRuntimeFactory = (
  input: OpenCodeAcpRuntimeOptions
) => OpenCodeAcpRuntime

export interface OpenCodeAcpAdapterOptions extends AcpAdapterOptions<OpenCodeAcpRuntimeSettings> {
  readonly runtimeFactory?: OpenCodeAcpRuntimeFactory
}

/**
 * The picker's last-resort entry. Live ACP discovery replaces this as soon as
 * a session starts; `big-pickle` is OpenCode's own published free model.
 */
const OPENCODE_FALLBACK_MODELS: ReadonlyArray<ProviderModel> = [
  {
    slug: "opencode/big-pickle",
    name: "Big Pickle",
    shortName: "Big Pickle",
    isCustom: false,
    context: "200K",
    tier: "Fallback",
    capabilities: { optionDescriptors: [] },
  },
]

export function isOpenCodeReadOnlyMode(
  runtimeMode: string | null | undefined
): boolean {
  const normalized = runtimeMode?.trim().toLowerCase()
  return normalized === "read-only" || normalized === "plan"
}

/**
 * Read-only enforcement when the session cannot be switched to its native
 * `plan` mode. Reads, searches and fetches stay allowed; anything that can
 * change the workspace is refused, and unknown kinds fail closed.
 */
export function openCodeReadOnlyDeniesAcpKind(
  kind: string | "unknown"
): boolean {
  switch (kind) {
    case "read":
    case "fetch":
    case "search":
      return false
    default:
      return true
  }
}

export const OPENCODE_PROFILE: AcpProviderProfile<
  OpenCodeAcpRuntimeSettings,
  OpenCodeAcpAdapterOptions
> = {
  kind: "opencode_cli",
  displayName: "OpenCode",
  label: "OpenCode",
  defaultInstanceId: "opencode-cli",
  continuationPrefix: "opencode-cli",
  errorCodePrefix: "OPENCODE_ACP",
  modelProbeThreadId: "_opencode-model-probe",
  // Turn admission must stay filesystem-free; the async status probe and the
  // runtime resolve/verify the binary.
  isConfigured: () => true,
  resolveRuntimeSettings: async (options) => {
    if (options.runtimeFactory) {
      return { binaryPath: options.binaryPath?.trim() || "opencode" }
    }
    const resolved = await resolveOpenCodeBinaryAsync(options.binaryPath)
    if (!resolved) {
      throw new Error(
        "OpenCode CLI not found. Install it from https://opencode.ai (or `npm i -g opencode-ai`) and run `opencode auth login`."
      )
    }
    return { binaryPath: resolved.binaryPath }
  },
  runtimeProfile: OPENCODE_RUNTIME_PROFILE,
  models: {
    fallback: () => OPENCODE_FALLBACK_MODELS,
    fromStarted: (started) => {
      const models = buildAcpDiscoveredModelsFromConfigOptions(
        started.configOptions
      )
      if (models.length === 0) return []
      // Every OpenCode model shares the session's effort/mode picker; the
      // generic builder attaches capabilities only to the current model.
      const capabilities = buildAcpCapabilitiesFromConfigOptions(
        started.configOptions
      )
      return models.map((model) => ({ ...model, capabilities }))
    },
    isEmptyAuthoritative: (started) =>
      findAcpModelConfigOption(started.configOptions) !== undefined,
    unconfiguredCheckedAt: "probe-start",
  },
  permissionCeiling: ({ runtimeMode, kind }) =>
    isOpenCodeReadOnlyMode(runtimeMode) && openCodeReadOnlyDeniesAcpKind(kind)
      ? {
          reason:
            "Read-only mode: OpenCode may read and search this workspace but not change it.",
        }
      : null,
  // The child is started with permission `ask` for every mutating kind, so
  // "allow edits" would otherwise pop an approval per edit.
  autoApprovePermission: ({ runtimeMode, kind }) =>
    runtimeMode === "auto-accept-edits" &&
    ["edit", "delete", "move"].includes(kind)
      ? "once"
      : null,
  // OpenCode's `question` tool runs inside the agent; it does not issue an ACP
  // user-input request, so answering one is not supported.
  supportsUserInput: false,
  // A rejected model update is a real error: the model picker is authoritative.
  setModelFailure: "throw",
  // OpenCode advertises a native `plan` mode; when a plan/ask/security intent
  // has no matching mode, the permission ceiling and always-ask rules keep the
  // boundary instead of killing the turn.
  missingSafeMode: { behaviour: "keep-native" },
}

export class OpenCodeAcpAdapter extends AcpAdapterBase<
  OpenCodeAcpRuntimeSettings,
  OpenCodeAcpAdapterOptions
> {
  constructor(options: OpenCodeAcpAdapterOptions = {}) {
    super(OPENCODE_PROFILE, options)
  }
}
