// The ACP config-option heuristics (effort/context/fast/thinking matching,
// discovered-model extraction, capability descriptors) are protocol-generic —
// they operate purely on the `configOptions` payload of `session/new` — so we
// import them from the Cursor support module instead of duplicating ~400
// lines. Grok-specific pieces (spawn shape and model cache) live
// here. If Cursor ever needs cursor-only behavior in those helpers, fork them
// into this file at that point.
export {
  buildCursorCapabilitiesFromConfigOptions as buildGrokCapabilitiesFromConfigOptions,
  buildCursorDiscoveredModelsFromConfigOptions as buildGrokDiscoveredModelsFromConfigOptions,
  mergeCursorCustomModels as mergeGrokCustomModels,
  resolveCursorAcpBaseModelId as resolveGrokAcpBaseModelId,
  resolveCursorAcpConfigUpdates as resolveGrokAcpConfigUpdates,
  type CursorAcpSessionConfigOption as GrokAcpSessionConfigOption,
} from "../cursor/CursorAcpSupport"

export interface GrokAcpRuntimeSettings {
  readonly binaryPath?: string | null
}

export interface GrokAcpSpawnInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
}

/**
 * xAI's Grok Build CLI exposes its ACP (Agent Client Protocol) server via
 * `grok agent stdio` — JSON-RPC over stdin/stdout, same protocol family as
 * `cursor-agent acp`. Zed's ACP registry runs the identical invocation.
 */
export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv
): GrokAcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args: ["agent", "stdio"],
    cwd,
    ...(environment ? { env: environment } : {}),
  }
}
