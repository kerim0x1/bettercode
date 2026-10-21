import { isRecord } from "@betterc0de/schema"
import {
  providerRefreshModelsSchema,
  providerValidateKeySchema,
} from "@betterc0de/schema/http-contracts"
import type { Hono } from "hono"
import { z } from "zod"
import type { AppState } from "../../appState"
import { LM_STUDIO_BASE_CANDIDATES } from "../../constants"
import { parseProviderKind, type ModelDefinition } from "../../provider/types"
import { contractResult, handleHttpContract } from "../contracts"
import type { ThreadId } from "../../provider/runtime/contracts"
import type { ProviderRuntimeInstanceSnapshot } from "../../provider/runtime"
import { recordCheckpointRevertFailed } from "../checkpointRevert"
import { isRuntimeProviderAllowedByProjectPolicy } from "../../provider/runtime/projectProviderPolicy"
import { listProjectProviders } from "../../services/workspace"
import { resolveOpenRouterKey } from "../../auth/keyResolution"
import { getOpenRouterCatalogModels } from "../../provider/openRouterModelDiscovery"
import { HttpError, sanitizeError } from "../errors"
import {
  recoveryWorkspacesForThread,
  withCheckpointRecoveryMutation,
} from "../checkpointRecoveryFence"
import { resolveApprovedWorkspaceRoot } from "./workspace"
import { registerApiKeyRoutes } from "./apiKeys"
import { listProviders as listProviderCatalog } from "../../provider/catalog"

const LM_STUDIO_PROBE_TIMEOUT_MS = 1_500
const LM_STUDIO_MODELS_MAX_BYTES = 512 * 1024
const LM_STUDIO_MODELS_MAX_ITEMS = 2_048
const LM_STUDIO_MODEL_ID_MAX_CHARS = 512

const providerInstanceIdParamSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:@-]+$/, "Invalid provider instance id")
const providerCwdQuerySchema = z.string().max(4_096).optional()

/**
 * Every answer here is checked against its shared contract
 * (`@betterc0de/schema/http-contracts`, `provider-contracts.ts`) before it
 * is sent. Requests keep their own parsing where a route answers a bad one
 * with its own body (`/providers/validate-key`) or reads no body at all.
 */
export function registerProvidersRoutes(api: Hono, state: AppState): void {
  registerApiKeyRoutes(api, state)
  api.get("/providers/catalog", (c) =>
    contractResult(c, "providerCatalog", listProviderCatalog())
  )
  api.get("/providers", (c) =>
    contractResult(c, "providerKinds", state.providers.listProviders())
  )
  api.get("/models", async (c) =>
    contractResult(
      c,
      "listModels",
      withCustomApiModels(
        await state.providers.listModelsLive(),
        state,
        c.req.query("includeHidden") === "1"
      )
    )
  )
  api.get("/providers/status", (c) =>
    contractResult(c, "providerStatus", state.providers.getStatus())
  )
  api.get("/providers/instances", async (c) => {
    const cwd = await resolveProviderRequestCwd(state, c.req.query("cwd"))
    return contractResult(
      c,
      "providerInstances",
      await listProjectScopedProviderInstances(state, cwd)
    )
  })
  api.get("/providers/sessions", async (c) =>
    contractResult(
      c,
      "providerSessions",
      await state.providerHub.listSessions(state.providerSessionBindings)
    )
  )
  api.get("/providers/instances/:id/models", async (c) => {
    const instance = state.providerHub.getInstance(c.req.param("id"))
    if (!instance) return c.json({ error: "provider instance not found" }, 404)
    if (!instance.enabled)
      return c.json({ error: "provider instance disabled" }, 409)
    const cwd = await resolveProviderRequestCwd(state, c.req.query("cwd"))
    return contractResult(
      c,
      "providerInstanceModels",
      await state.providerHub.modelsForInstance(instance.instanceId, { cwd })
    )
  })
  api.post("/providers/instances/:id/refresh", async (c) => {
    const params = parseInstanceRouteParams(
      c.req.param("id"),
      c.req.query("cwd")
    )
    if (!params.ok) return c.json({ error: params.error }, 400)
    const instance = state.providerHub.getInstance(params.id)
    if (!instance) return c.json({ error: "provider instance not found" }, 404)
    const cwd = await resolveProviderRequestCwd(state, params.cwd)
    await state.providerHub.refreshInstanceMetadata(instance.instanceId, {
      cwd,
    })
    const providers = await listProjectScopedProviderInstances(state, cwd)
    const [snapshot] = providers.filter(
      (item) => item.instanceId === instance.instanceId
    )
    return contractResult(c, "providerInstanceRefresh", {
      instance: snapshot ?? null,
      models: instance.enabled
        ? await state.providerHub.modelsForInstance(instance.instanceId, {
            cwd,
          })
        : [],
    })
  })
  api.post("/providers/instances/:id/update", async (c) => {
    const params = parseInstanceRouteParams(
      c.req.param("id"),
      c.req.query("cwd")
    )
    if (!params.ok) return c.json({ error: params.error }, 400)
    const instance = state.providerHub.getInstance(params.id)
    if (!instance) return c.json({ error: "provider instance not found" }, 404)
    const cwd = await resolveProviderRequestCwd(state, params.cwd)
    try {
      const result = await state.providerHub.updateProviderInstance(
        instance.instanceId,
        {
          cwd,
        }
      )
      const providers = await applyProjectProviderPolicyToInstances(
        result.providers,
        cwd
      )
      return contractResult(c, "providerInstanceUpdate", {
        ...result,
        providers,
        instance:
          providers.find((item) => item.instanceId === instance.instanceId) ??
          null,
      })
    } catch (error) {
      const sanitized = sanitizeError(error, "provider update", {
        instanceId: instance.instanceId,
      })
      const body =
        sanitized.code === undefined
          ? { error: sanitized.message }
          : { error: sanitized.message, code: sanitized.code }
      return c.json(body, sanitized.statusCode as 400 | 404 | 409 | 500 | 503)
    }
  })
  api.post("/providers/rollback-conversation", (c) =>
    handleHttpContract(
      c,
      "providerRollbackConversation",
      async (body) => {
        if (body.numTurns === 0) return { rolledBack: false }
        const latestBinding = state.providerSessionBindings.getLatestForThread(
          body.threadId
        )
        return withCheckpointRecoveryMutation(
          state,
          {
            threadIds: [body.threadId],
            workspaces: [
              ...recoveryWorkspacesForThread(
                state,
                body.threadId,
                latestBinding?.cwd ?? null
              ),
            ],
          },
          async () => {
            const binding = body.providerKind ? null : latestBinding
            const providerKind =
              body.providerKind ?? binding?.providerKind ?? null
            if (!providerKind) {
              recordCheckpointRevertFailed(state, {
                threadId: body.threadId,
                numTurns: body.numTurns,
                detail: "No active provider session for checkpoint revert.",
              })
              return { rolledBack: false }
            }
            const providerInstanceId =
              body.providerInstanceId ?? binding?.providerInstanceId ?? null
            const rolledBack = await state.providerHub.rollbackConversation(
              providerKind,
              body.threadId as ThreadId,
              body.numTurns,
              providerInstanceId,
              state.providerSessionBindings
            )
            if (!rolledBack) {
              recordCheckpointRevertFailed(state, {
                threadId: body.threadId,
                numTurns: body.numTurns,
                providerKind,
                providerInstanceId,
                detail: "No active provider session for checkpoint revert.",
              })
            }
            return { rolledBack }
          }
        )
      },
      { operation: "provider rollback conversation" }
    )
  )

  // Invalidate cached model list for a single provider (or all providers when
  // no `kind` is given) and return the freshly-fetched list.
  // A body that is not JSON reads as `{}` (refresh every provider), as it
  // always has; only the answer goes through the contract.
  api.post("/providers/refresh-models", async (c) => {
    const parsed = providerRefreshModelsSchema.safeParse(
      await c.req.json().catch(() => ({}))
    )
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const rawKind = parsed.data.kind
    if (rawKind) {
      const kind = parseProviderKind(rawKind)
      if (!kind)
        return c.json({ error: `Unknown provider kind: ${rawKind}` }, 400)
      state.providers.refreshModels(kind)
    }
    // `force` when no specific kind — ensures every adapter is re-queried.
    const models = withCustomApiModels(
      await state.providers.listModelsLive(true),
      state
    )
    return contractResult(c, "providerRefreshModels", models)
  })

  // LM Studio's model list comes from probing its local HTTP endpoint; if it
  // isn't running we return the `not_running` sentinel the renderer expects.
  // Probes both 1234 and 1111 (default + alt) on localhost and 127.0.0.1.
  api.get("/lmstudio/models", async (c) => {
    let models: Array<{ id: string }> | null = null
    try {
      models = await fetchLmStudioModels()
    } catch {
      models = null
    }
    return contractResult(
      c,
      "lmStudioModels",
      models ? { data: models } : { error: "not_running" }
    )
  })

  // Live OpenRouter catalog for the picker's or-* groups. Gated on a
  // configured OpenRouter key so a user who never set OpenRouter up never
  // causes traffic to openrouter.ai (the endpoint itself is public — the
  // gate is the local-first consent signal, not auth). Returns the trimmed,
  // 6h-cached family subset; on failure the renderer keeps its curated
  // fallback entries.
  api.get("/openrouter/models", async (c) => {
    if (!resolveOpenRouterKey(state.settings.get())?.key) {
      return contractResult(c, "openRouterModels", { error: "not_configured" })
    }
    let data: Awaited<ReturnType<typeof getOpenRouterCatalogModels>>
    try {
      data = await getOpenRouterCatalogModels()
    } catch (error) {
      // An upstream failure (401 from a revoked key, network) used to come
      // back as an empty 200 catalog, indistinguishable from "no models".
      // The renderer keeps its curated fallback on any error response.
      const { message, statusCode, code } = sanitizeError(
        error,
        "openrouter catalog",
        { path: "/openrouter/models" }
      )
      return c.json(
        {
          error: message,
          code: code ?? "openrouter_unavailable",
        },
        (statusCode >= 400 && statusCode < 500 ? statusCode : 502) as
          | 400
          | 401
          | 403
          | 404
          | 429
          | 502
      )
    }
    return contractResult(c, "openRouterModels", { data })
  })

  // Server-side API-key validation. The renderer used to call provider
  // endpoints directly with `fetch()` from `localhost:5173` / the Electron
  // renderer origin, which (a) was blocked by CORS for Anthropic /
  // OpenRouter and (b) leaked the user's API key into the renderer's
  // network panel + JS heap. Doing the probe here keeps the key inside
  // the Node process and dodges CORS entirely (Node fetch ignores it).
  // A bad request is answered in the contract's own shape (`ok: false`).
  api.post("/providers/validate-key", async (c) => {
    const parsed = providerValidateKeySchema.safeParse(
      await c.req.json().catch(() => ({}))
    )
    if (!parsed.success) {
      return contractResult(
        c,
        "providerValidateKey",
        {
          ok: false,
          valid: false,
          error: parsed.error.issues[0]?.message ?? "invalid request",
        },
        400
      )
    }
    const { kind, apiKey } = parsed.data
    const probe = apiKey ? buildKeyProbeRequest(kind, apiKey) : null
    if (apiKey && !probe) {
      // A kind we cannot probe is not a kind we can vouch for. This used to
      // answer `{valid:true}`, which turned a typo into a green badge.
      return contractResult(
        c,
        "providerValidateKey",
        { ok: false, valid: false, error: `Unknown provider kind: ${kind}` },
        400
      )
    }
    if (!probe) {
      return contractResult(c, "providerValidateKey", {
        ok: true,
        valid: false,
        status: 0,
      })
    }

    let status: number
    try {
      const ac = new AbortController()
      const timeout = setTimeout(() => ac.abort(), 8000)
      let res: Response
      try {
        res = await fetch(probe.url, {
          method: probe.method,
          headers: probe.headers,
          body: probe.body,
          signal: ac.signal,
        })
        // Only headers are needed; release the upstream stream while the
        // deadline still bounds the request.
        await res.body?.cancel().catch(() => undefined)
      } finally {
        clearTimeout(timeout)
      }
      status = res.status
    } catch (err) {
      const sanitized = sanitizeError(err, "provider credential validation", {
        kind,
      })
      return contractResult(c, "providerValidateKey", {
        ok: true,
        valid: false,
        status: 0,
        error: sanitized.message,
      })
    }
    // Only a successful authenticated endpoint confirms the key. Invalid
    // keys can also return 400; rate limits/outages do not prove validity.
    return contractResult(c, "providerValidateKey", {
      ok: true,
      valid: status >= 200 && status < 300,
      status,
    })
  })
}

function withCustomApiModels(
  models: ModelDefinition[],
  state: AppState,
  includeHidden = false
): ModelDefinition[] {
  const providers = state.settings.get().providers
  const result = [...models]
  for (const kind of ["anthropic", "openai", "grok"] as const) {
    const seen = new Set(
      result
        .filter((model) => model.provider === kind)
        .map((model) => model.slug)
    )
    for (const raw of providers[kind]?.custom_models ?? []) {
      const slug = raw.trim()
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      result.push({ slug, name: slug, provider: kind, isCustom: true })
    }
  }
  if (includeHidden) return result
  return result.filter((model) => {
    if (
      model.provider !== "anthropic" &&
      model.provider !== "openai" &&
      model.provider !== "grok"
    )
      return true
    const config = providers[model.provider]
    return (
      config?.enabled !== false &&
      !(config?.hidden_models ?? []).includes(model.slug)
    )
  })
}

function parseInstanceRouteParams(
  rawId: string | undefined,
  rawCwd: string | undefined
):
  | { ok: true; id: string; cwd: string | undefined }
  | { ok: false; error: string } {
  const id = providerInstanceIdParamSchema.safeParse(rawId)
  if (!id.success) return { ok: false, error: "invalid provider instance id" }
  const cwd = providerCwdQuerySchema.safeParse(rawCwd)
  if (!cwd.success) return { ok: false, error: "invalid cwd" }
  return { ok: true, id: id.data, cwd: cwd.data }
}

export async function resolveProviderRequestCwd(
  state: AppState,
  cwd: string | null | undefined
): Promise<string | null> {
  const requested = cwd?.trim()
  if (!requested) return null
  return resolveApprovedWorkspaceRoot(state, requested)
}

async function fetchLmStudioModels(): Promise<Array<{ id: string }> | null> {
  for (const base of LM_STUDIO_BASE_CANDIDATES) {
    try {
      const response = await fetch(`${base}/models`, {
        signal: AbortSignal.timeout(LM_STUDIO_PROBE_TIMEOUT_MS),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        continue
      }
      const raw = await readBoundedResponseText(
        response,
        LM_STUDIO_MODELS_MAX_BYTES
      )
      const parsed = JSON.parse(raw) as unknown
      if (!isRecord(parsed) || !Array.isArray(parsed.data)) continue
      const models: Array<{ id: string }> = []
      for (const item of parsed.data) {
        if (models.length >= LM_STUDIO_MODELS_MAX_ITEMS) break
        if (!isRecord(item) || typeof item.id !== "string") continue
        const id = item.id.trim()
        if (!id || id.length > LM_STUDIO_MODEL_ID_MAX_CHARS) continue
        models.push({ id })
      }
      return models
    } catch {
      // Try the next loopback candidate. The fetch deadline remains active
      // while the bounded response stream is consumed.
    }
  }
  return null
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("LM Studio response exceeds the byte limit")
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      totalBytes += result.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error("LM Studio response exceeds the byte limit")
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

async function listProjectScopedProviderInstances(
  state: AppState,
  cwd: string | null | undefined
): Promise<ProviderRuntimeInstanceSnapshot[]> {
  const instances = await state.providerHub.listInstances({ cwd: cwd ?? null })
  return applyProjectProviderPolicyToInstances(instances, cwd)
}

async function applyProjectProviderPolicyToInstances(
  instances: ReadonlyArray<ProviderRuntimeInstanceSnapshot>,
  cwd: string | null | undefined
): Promise<ProviderRuntimeInstanceSnapshot[]> {
  const workspace = cwd?.trim()
  if (!workspace) return [...instances]
  try {
    const policy = await listProjectProviders(workspace)
    if (
      policy.enabledProviders.length === 0 &&
      policy.disabledProviders.length === 0
    ) {
      return [...instances]
    }
    return instances.filter((instance) =>
      isRuntimeProviderAllowedByProjectPolicy(instance, policy)
    )
  } catch {
    throw new HttpError(
      503,
      "Project provider policy could not be loaded.",
      "PROJECT_POLICY_INVALID"
    )
  }
}

interface KeyProbeRequest {
  url: string
  method: "GET" | "POST"
  headers: Record<string, string>
  body?: string
}

/**
 * Per-provider lightweight probe to test whether an API key is accepted.
 * Mirrors what the renderer was doing pre-CORS-fix; centralising it here
 * means new providers just add a single case here instead of duplicating
 * the URL/headers in every settings UI.
 */
function buildKeyProbeRequest(
  kind: string,
  apiKey: string
): KeyProbeRequest | null {
  switch (kind) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models?limit=1",
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      }
    case "openai":
      return {
        url: "https://api.openai.com/v1/models",
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        method: "GET",
        headers: {},
      }
    case "grok":
      return {
        url: "https://api.x.ai/v1/models",
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    case "openrouter":
      return {
        url: "https://openrouter.ai/api/v1/key",
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    case "deepseek":
      return {
        url: "https://api.deepseek.com/v1/models",
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    default:
      return null
  }
}
