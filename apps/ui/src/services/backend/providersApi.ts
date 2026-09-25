import { invoke } from "./runtime"
import type {
  ModelCapabilities,
  ProviderInstanceSnapshot,
  ProviderModel,
} from "@betterc0de/schema"

/**
 * Authoritative provider status surfaced by the backend's
 * `/providers/status` route. Mirrors `ProviderStatus` in
 * `apps/backend/src/provider/service.ts` — fields stay structurally
 * compatible across both processes; the renderer treats `provider` as
 * an opaque string keyed by the backend's `ProviderKind`.
 */
export interface ProviderStatus {
  provider: string
  name: string
  configured: boolean
  /** `"api-key" | "cli" | "local-server" | "oauth" | …` — used by the
   *  renderer to pick a fallback tooltip copy when the adapter's
   *  per-provider `hint` isn't supplied. */
  authType?: string
  /** Human-readable setup instruction from the adapter; renderered on
   *  hover over disabled model-picker items. */
  hint?: string
}

export const listProviders = () => invoke<string[]>("/providers")

export interface ApiModel {
  slug: string
  name: string
  provider: string
  context?: string
  tier?: string
  isCustom?: boolean
  capabilities?: ModelCapabilities | null
}

export const listModels = () => invoke<ApiModel[]>("/models")

export const refreshModels = () =>
  invoke<ApiModel[]>("/providers/refresh-models", {
    method: "POST",
    body: {},
  })

export const getProviderStatus = () =>
  invoke<ProviderStatus[]>("/providers/status")

export const listProviderInstances = (cwd?: string | null) => {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""
  return invoke<ProviderInstanceSnapshot[]>(`/providers/instances${query}`)
}

export const listProviderInstanceModels = (
  instanceId: string,
  cwd?: string | null
) => {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""
  return invoke<ReadonlyArray<ProviderModel>>(
    `/providers/instances/${encodeURIComponent(instanceId)}/models${query}`
  )
}

export const refreshProviderInstance = (
  instanceId: string,
  cwd?: string | null
) => {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""
  return invoke<{
    instance: ProviderInstanceSnapshot | null
    models: ReadonlyArray<ProviderModel>
  }>(`/providers/instances/${encodeURIComponent(instanceId)}/refresh${query}`, {
    method: "POST",
    body: {},
  })
}

export const updateProviderInstance = (
  instanceId: string,
  cwd?: string | null
) => {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""
  return invoke<{
    instance: ProviderInstanceSnapshot | null
    providers: ReadonlyArray<ProviderInstanceSnapshot>
  }>(`/providers/instances/${encodeURIComponent(instanceId)}/update${query}`, {
    method: "POST",
    body: {},
  })
}

export const rollbackProviderConversation = (
  threadId: string,
  numTurns: number,
  input: {
    providerKind?: string | null
    providerInstanceId?: string | null
  } = {}
) =>
  invoke<{ rolledBack: boolean }>("/providers/rollback-conversation", {
    method: "POST",
    body: {
      threadId,
      numTurns,
      ...(input.providerKind ? { providerKind: input.providerKind } : {}),
      ...(input.providerInstanceId !== undefined
        ? { providerInstanceId: input.providerInstanceId }
        : {}),
    },
  })

/** Per-CLI install + auth status. Mirrors `CliStatus` in
 *  `apps/backend/src/provider/catalog/cli-detect.ts`. */
export interface CliStatus {
  installed: boolean
  binaryPath: string | null
  version: string | null
  authenticated: boolean
  authType: string | null
}

/** Shape of `GET /cli/status` once it's been upgraded from stubs to real
 *  detection (PR1 follow-up). The `cli` map keys are provider ids
 *  (`claude`, `codex`, …); legacy callers still get `claude` / `codex` as
 *  top-level shortcuts. */
export interface CliStatusResponse {
  claude: CliStatus
  codex: CliStatus
  cli: Record<string, CliStatus>
  adapters: Record<string, { configured: boolean; name: string }>
}

export const getCliStatus = () => invoke<CliStatusResponse>("/cli/status")

export const listLmStudioModels = () =>
  invoke<{ data?: { id: string }[]; error?: string }>("/lmstudio/models", {
    method: "GET",
  })

export interface OpenRouterLiveModel {
  id: string
  name: string
  contextLength: number | null
}

/** Live OpenRouter catalog subset (backend-cached; `error: "not_configured"`
 *  when no OpenRouter key is set — the picker then keeps its curated list). */
export const listOpenRouterModels = () =>
  invoke<{ data?: OpenRouterLiveModel[]; error?: string }>(
    "/openrouter/models",
    { method: "GET" }
  )

/**
 * Server-side API-key validation. The renderer must NOT call provider
 * APIs (api.anthropic.com / api.openai.com / …) directly: CORS blocks
 * Anthropic + OpenRouter, and any direct call leaks the key into the
 * renderer's network panel. Backend handles the probe and returns just
 * a yes/no.
 */
export const validateProviderKey = (kind: string, apiKey: string) =>
  invoke<{ ok: boolean; valid: boolean; status?: number; error?: string }>(
    "/providers/validate-key",
    { method: "POST", body: { kind, apiKey } }
  )
