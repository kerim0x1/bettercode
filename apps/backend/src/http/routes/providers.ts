import { isRecord } from "@betterc0de/schema"
import type { Hono } from "hono"
import { z } from "zod"
import type { AppState } from "../../appState"
import { LM_STUDIO_BASE_CANDIDATES } from "../../constants"
import { parseProviderKind, type ModelDefinition } from "../../provider/types"
import { providerRollbackConversationSchema } from "../validation"
import { parseAndHandle } from "../routeHelpers"
import type { ThreadId } from "../../provider/runtime/contracts"
import type { ProviderRuntimeInstanceSnapshot } from "../../provider/runtime"
import { recordCheckpointRevertFailed } from "../checkpointRevert"
import { isRuntimeProviderAllowedByProjectPolicy } from "../../provider/runtime/projectProviderPolicy"
import { listProjectProviders } from "../../services/workspace"
import { isValidCredential } from "../../auth/store"
import { resolveOpenRouterKey } from "../../auth/keyResolution"
import { getOpenRouterCatalogModels } from "../../provider/adapters/openRouterModelDiscovery"
import { HttpError, sanitizeError } from "../errors"
import {
  recoveryWorkspacesForThread,
  withCheckpointRecoveryMutation,
} from "../checkpointRecoveryFence"
import { resolveApprovedWorkspaceRoot } from "./workspace"

const LM_STUDIO_PROBE_TIMEOUT_MS = 1_500
const LM_STUDIO_MODELS_MAX_BYTES = 512 * 1024
const LM_STUDIO_MODELS_MAX_ITEMS = 2_048
const LM_STUDIO_MODEL_ID_MAX_CHARS = 512

/**
 * Provider ids a credential may be stored under: the shell/backend catalog
 * ids (`provider/catalog/*.ts`, `apps/shell/provider-ipc.cjs`) plus the two
 * legacy `ProviderKind` spellings the key resolver still reads. The auth
 * store is a flat map keyed by this string, so an arbitrary id would create
 * an orphan entry nothing can ever read or clear.
 */
const CREDENTIAL_PROVIDER_IDS = [
  "anthropic",
  "anthropic_cli",
  "claude",
  "codex",
  "cursor",
  "deepseek",
  "google",
  "grok",
  "grok-cli",
  "lmstudio",
  "openai",
  "openrouter",
] as const
const credentialProviderIdSchema = z.enum(CREDENTIAL_PROVIDER_IDS)
const providerInstanceIdParamSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:@-]+$/, "Invalid provider instance id")
const providerCwdQuerySchema = z.string().max(4_096).optional()
const refreshModelsSchema = z.object({
  kind: z.string().trim().max(64).optional(),
})
const validateKeySchema = z.object({
  kind: z.string().trim().min(1, "kind required").max(64),
  apiKey: z.string().max(4_096).default(""),
})

export function registerProvidersRoutes(api: Hono, state: AppState): void {
  api.get("/providers", (c) => c.json(state.providers.listProviders()))
  api.get("/models", async (c) =>
    c.json(withCustomApiModels(await state.providers.listModelsLive(), state))
  )
  api.get("/providers/status", (c) => c.json(state.providers.getStatus()))
  api.get("/providers/instances", async (c) => {
    const cwd = await resolveProviderRequestCwd(state, c.req.query("cwd"))
    return c.json(await listProjectScopedProviderInstances(state, cwd))
  })
  api.get("/providers/sessions", async (c) =>
    c.json(await state.providerHub.listSessions(state.providerSessionBindings))
  )
  api.get("/providers/instances/:id/models", async (c) => {
    const instance = state.providerHub.getInstance(c.req.param("id"))
    if (!instance) return c.json({ error: "provider instance not found" }, 404)
    if (!instance.enabled)
      return c.json({ error: "provider instance disabled" }, 409)
    const cwd = await resolveProviderRequestCwd(state, c.req.query("cwd"))
    return c.json(
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
    return c.json({
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
      return c.json({
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
    parseAndHandle(
      c,
      providerRollbackConversationSchema,
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

  // ── Catalog + credential routes (PR1–PR4) ───────────────────────────
  // Returns which providers currently have a stored credential, keyed by
  // provider id, value = credential type ("oauth"|"api"|"wellknown") or
  // null. The renderer uses this to render "Signed in" badges next to
  // each provider in Settings.
  api.get("/providers/auth-status", (c) => {
    if (!state.authStore) return c.json({})
    const all = state.authStore.all()
    const status: Record<string, string> = {}
    for (const [id, cred] of Object.entries(all)) status[id] = cred.type
    return c.json(status)
  })

  // Persist a credential (called by the OAuth IPC after a successful flow).
  // `isValidCredential` bounds the shape and sizes; the id must be a known
  // provider. Desktop-only at the router: a paired device never writes
  // credentials.
  api.post("/providers/:id/credential", async (c) => {
    if (!state.authStore)
      return c.json({ error: "auth store not available" }, 503)
    const id = credentialProviderIdSchema.safeParse(c.req.param("id"))
    if (!id.success) return c.json({ error: "unknown provider id" }, 400)
    const body = await c.req.json().catch(() => null)
    if (!isValidCredential(body)) {
      return c.json({ error: "invalid credential" }, 400)
    }
    state.authStore.set(id.data, body)
    return c.json({ ok: true })
  })

  // Drop the stored credential for a provider.
  api.delete("/providers/:id/credential", (c) => {
    if (!state.authStore)
      return c.json({ error: "auth store not available" }, 503)
    const id = credentialProviderIdSchema.safeParse(c.req.param("id"))
    if (!id.success) return c.json({ error: "unknown provider id" }, 400)
    state.authStore.remove(id.data)
    return c.json({ ok: true })
  })

  // Invalidate cached model list for a single provider (or all providers when
  // no `kind` is given) and return the freshly-fetched list.
  api.post("/providers/refresh-models", async (c) => {
    const parsed = refreshModelsSchema.safeParse(
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
    return c.json(models)
  })

  // LM Studio's model list comes from probing its local HTTP endpoint; if it
  // isn't running we return the `not_running` sentinel the renderer expects.
  // Probes both 1234 and 1111 (default + alt) on localhost and 127.0.0.1.
  api.get("/lmstudio/models", async (c) => {
    try {
      const models = await fetchLmStudioModels()
      if (!models) return c.json({ error: "not_running" })
      return c.json({ data: models })
    } catch {
      return c.json({ error: "not_running" })
    }
  })

  // Live OpenRouter catalog for the picker's or-* groups. Gated on a
  // configured OpenRouter key so a user who never set OpenRouter up never
  // causes traffic to openrouter.ai (the endpoint itself is public — the
  // gate is the local-first consent signal, not auth). Returns the trimmed,
  // 6h-cached family subset; on failure the renderer keeps its curated
  // fallback entries.
  api.get("/openrouter/models", async (c) => {
    if (!resolveOpenRouterKey(state.settings.get())?.key) {
      return c.json({ error: "not_configured" })
    }
    try {
      return c.json({ data: await getOpenRouterCatalogModels() })
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
  })

  // Server-side API-key validation. The renderer used to call provider
  // endpoints directly with `fetch()` from `localhost:5173` / the Electron
  // renderer origin, which (a) was blocked by CORS for Anthropic /
  // OpenRouter and (b) leaked the user's API key into the renderer's
  // network panel + JS heap. Doing the probe here keeps the key inside
  // the Node process and dodges CORS entirely (Node fetch ignores it).
  api.post("/providers/validate-key", async (c) => {
    const parsed = validateKeySchema.safeParse(
      await c.req.json().catch(() => ({}))
    )
    if (!parsed.success) {
      return c.json(
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
      return c.json(
        { ok: false, valid: false, error: `Unknown provider kind: ${kind}` },
        400
      )
    }
    if (!probe) return c.json({ ok: true, valid: false, status: 0 })

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
      // Only a successful authenticated endpoint confirms the key. Invalid
      // keys can also return 400; rate limits/outages do not prove validity.
      const valid = res.ok
      return c.json({ ok: true, valid, status: res.status })
    } catch (err) {
      const sanitized = sanitizeError(err, "provider credential validation", {
        kind,
      })
      return c.json({
        ok: true,
        valid: false,
        status: 0,
        error: sanitized.message,
      })
    }
  })
}

function withCustomApiModels(
  models: ModelDefinition[],
  state: AppState
): ModelDefinition[] {
  const providers = state.settings?.get().providers
  if (!providers) return models
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
  return result
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
