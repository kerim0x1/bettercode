import {
  buildCursorAcpSpawnInput,
  type CursorAcpRuntimeSettings,
} from "./CursorAcpSupport"
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
 * Cursor's `cursor-agent acp` runtime. The protocol machinery lives in
 * `acp/AcpRuntimeBase`; this file only declares what Cursor does differently
 * on the wire.
 */

export type CursorAcpMode = AcpMode
export type CursorAcpModeState = AcpModeState
export type CursorAcpStarted = AcpStarted
export type CursorAcpSessionSetupResult = AcpSessionSetupResult
export type CursorAcpToolCallState = AcpToolCallState
export type CursorAcpPlanUpdate = AcpPlanUpdate
export type CursorAcpPermissionRequest = AcpPermissionRequest
export type CursorAcpExit = AcpExit
export type CursorAcpEvent = AcpEvent
export type CursorAcpRuntime = AcpRuntime
export type CursorAcpRuntimeOptions =
  AcpRuntimeOptions<CursorAcpRuntimeSettings>

// Cursor's ACP server exposes its model picker through a vendor `_meta`
// extension flag; without it `session/new` advertises no `category: "model"`
// config option at all.
const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  session: { configOptions: { boolean: {} } },
  _meta: { parameterizedModelPicker: true },
} as const

export const CURSOR_RUNTIME_PROFILE: AcpRuntimeProfile<CursorAcpRuntimeSettings> =
  {
    label: "Cursor",
    buildSpawnInput: buildCursorAcpSpawnInput,
    clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
    // Cursor requires an unconditional `authenticate` round-trip before it
    // serves any session, even when the CLI is already logged in.
    auth: { strategy: "eager", methodId: "cursor_login" },
  }

export function createCursorAcpRuntime(
  options: CursorAcpRuntimeOptions
): CursorAcpRuntime {
  return createAcpRuntime(CURSOR_RUNTIME_PROFILE, options)
}
