import { z } from "zod"
import {
  endpoint,
  ignoredBody,
  noBody,
  readAs,
  unchecked,
  type RecordSchema,
} from "./http-endpoint"
import type { ModelCapabilities } from "./model-selection"
import type {
  ProviderInstanceSnapshot,
  ProviderModelCatalog,
} from "./provider-instance"
import {
  providerRollbackConversationSchema,
  type ProviderModel,
} from "./provider-runtime"

/**
 * The provider routes (`apps/backend/src/http/routes/providers.ts` and
 * `GET /cli/status`): what the backend answers, validated before it is sent
 * and again before the renderer reads it. Objects are `passthrough`, so a
 * field a newer desktop adds reaches the client instead of being dropped.
 */

const text = z.string()
const bool = z.boolean()
const num = z.number()

// ── Catalog ─────────────────────────────────────────────────────────────

/** How a user grants access to a provider (`provider/catalog/types.ts`). */
const providerAuthMethodSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("api-key"),
      label: text,
      placeholder: text.optional(),
      envVars: z.array(text).optional(),
    })
    .passthrough(),
  z
    .object({ type: z.literal("oauth"), label: text, handler: text })
    .passthrough(),
  z
    .object({
      type: z.literal("local-server"),
      label: text,
      defaultBaseUrl: text,
      hint: text.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("cli"),
      label: text,
      command: text,
      versionArgs: z.array(text),
      installHint: text.optional(),
      loginCommand: text.optional(),
    })
    .passthrough(),
])

/** One provider the Settings page can set up (`GET /providers/catalog`). */
const providerCatalogEntrySchema = z
  .object({
    id: text,
    name: text,
    description: text.optional(),
    docsUrl: text.optional(),
    defaultModels: z.array(text),
    authMethods: z.array(providerAuthMethodSchema),
    enabledByDefault: bool.optional(),
  })
  .passthrough()

// ── Models ──────────────────────────────────────────────────────────────

/** A model of the direct-API providers (`GET /models`). */
const providerApiModelSchema = z
  .object({
    slug: text,
    name: text,
    provider: text,
    context: text.optional(),
    tier: text.optional(),
    isCustom: bool.optional(),
    capabilities: unchecked<ModelCapabilities>().nullable().optional(),
  })
  .passthrough()

/** A model a provider instance offers (`ProviderModel`). */
const providerModelSchema: RecordSchema<ProviderModel> = z
  .object({
    slug: text,
    name: text,
    shortName: text.optional(),
    subProvider: text.optional(),
    isCustom: bool.optional(),
    capabilities: unchecked<ModelCapabilities>().nullable().optional(),
    context: text.optional(),
    tier: text.optional(),
    catalog: unchecked<ProviderModelCatalog>().optional(),
  })
  .passthrough()

// ── Status ──────────────────────────────────────────────────────────────

/** Whether a direct-API provider is set up (`GET /providers/status`). */
export interface ProviderStatus {
  provider: string
  name: string
  configured: boolean
  /** `"api-key" | "cli" | "local-server" | "oauth" | …`, for fallback copy. */
  authType?: string
  /** The adapter's setup instruction, shown on disabled picker items. */
  hint?: string
}

const providerStatusSchema: RecordSchema<ProviderStatus> = z
  .object({
    provider: text,
    name: text,
    configured: bool,
    authType: text.optional(),
    hint: text.optional(),
  })
  .passthrough()

// ── Instances ───────────────────────────────────────────────────────────

/**
 * The fields of a provider instance snapshot every client branches on. The
 * rest (catalog, skills, agents, tools, slash commands, metadata, update
 * state) is provider-specific and passes through as the desktop built it;
 * the renderer fills what an older desktop leaves out
 * (`provider-instance-loader.ts`).
 */
export interface ProviderInstanceSnapshotFields {
  instanceId: string
  driver: string
  displayName: string
  enabled: boolean
  configured: boolean
  installed: boolean
  version: string | null
  status: "ready" | "warning" | "error" | "disabled"
  auth: { status: "authenticated" | "unauthenticated" | "unknown" }
  checkedAt: string
  availability: "available" | "unavailable"
  models?: ProviderModel[]
}

const providerInstanceSnapshotSchema = readAs<
  ProviderInstanceSnapshot,
  ProviderInstanceSnapshotFields
>(
  z
    .object({
      instanceId: text,
      driver: text,
      displayName: text,
      enabled: bool,
      configured: bool,
      installed: bool,
      version: text.nullable(),
      status: z.enum(["ready", "warning", "error", "disabled"]),
      auth: z
        .object({
          status: z.enum(["authenticated", "unauthenticated", "unknown"]),
        })
        .passthrough(),
      checkedAt: text,
      availability: z.enum(["available", "unavailable"]),
      models: z.array(providerModelSchema).optional(),
    })
    .passthrough()
)

/** A provider session the hub knows (`GET /providers/sessions`). */
const providerSessionSnapshotSchema = z
  .object({
    threadId: text,
    providerKind: text,
    instanceId: text,
    driver: text,
    displayName: text,
    status: text,
    generation: num.optional(),
    active: bool,
    persisted: bool,
  })
  .passthrough()

// ── Local and aggregator catalogs ───────────────────────────────────────

/** `{ data }`, or `{ error: "not_running" }` while LM Studio is not running. */
const lmStudioModelsResponseSchema = z
  .object({
    data: z.array(z.object({ id: text }).passthrough()).optional(),
    error: text.optional(),
  })
  .passthrough()

/** One model of the live OpenRouter catalog subset. */
export interface OpenRouterLiveModel {
  id: string
  name: string
  contextLength: number | null
}

const openRouterLiveModelSchema: RecordSchema<OpenRouterLiveModel> = z
  .object({ id: text, name: text, contextLength: num.nullable() })
  .passthrough()

/** `{ data }`, or `{ error: "not_configured" }` without an OpenRouter key. */
const openRouterModelsResponseSchema = z
  .object({
    data: z.array(openRouterLiveModelSchema).optional(),
    error: text.optional(),
  })
  .passthrough()

// ── Requests ────────────────────────────────────────────────────────────

/** `POST /providers/refresh-models`: one provider kind, or all without one. */
export const providerRefreshModelsSchema = z.object({
  kind: z.string().trim().max(64).optional(),
})

/** `POST /providers/validate-key`: the backend probes the provider with it. */
export const providerValidateKeySchema = z.object({
  kind: z.string().trim().min(1, "kind required").max(64),
  apiKey: z.string().max(4_096).default(""),
})

// ── CLI status ──────────────────────────────────────────────────────────

/** Install and sign-in state of one provider CLI. */
export interface CliStatus {
  installed: boolean
  binaryPath: string | null
  version: string | null
  authenticated: boolean
  authType: string | null
}

/**
 * `GET /cli/status`. `cli` is keyed by provider id (`claude`, `codex`,
 * `grok-cli`, `cursor`); `claude` and `codex` are also at the top level for
 * older readers.
 */
export interface CliStatusResponse {
  claude: CliStatus
  codex: CliStatus
  cli: Record<string, CliStatus>
  adapters: Record<string, { configured: boolean; name: string }>
}

const cliStatusSchema: RecordSchema<CliStatus> = z
  .object({
    installed: bool,
    binaryPath: text.nullable(),
    version: text.nullable(),
    authenticated: bool,
    authType: text.nullable(),
  })
  .passthrough()

const cliStatusResponseSchema: RecordSchema<CliStatusResponse> = z
  .object({
    claude: cliStatusSchema,
    codex: cliStatusSchema,
    cli: z.record(text, cliStatusSchema),
    adapters: z.record(
      text,
      z.object({ configured: bool, name: text }).passthrough()
    ),
  })
  .passthrough()

// ── Contracts ───────────────────────────────────────────────────────────

export const providerHttpContracts = {
  providerCatalog: endpoint(
    "GET",
    "/providers/catalog",
    noBody,
    z.array(providerCatalogEntrySchema)
  ),
  // The direct-API provider kinds the backend has adapters for.
  providerKinds: endpoint("GET", "/providers", noBody, z.array(text)),
  // `?includeHidden=1` also lists models hidden in Settings.
  listModels: endpoint(
    "GET",
    "/models",
    noBody,
    z.array(providerApiModelSchema)
  ),
  providerStatus: endpoint(
    "GET",
    "/providers/status",
    noBody,
    z.array(providerStatusSchema)
  ),
  // `?cwd=` applies that workspace's provider policy.
  providerInstances: endpoint(
    "GET",
    "/providers/instances",
    noBody,
    z.array(providerInstanceSnapshotSchema)
  ),
  providerSessions: endpoint(
    "GET",
    "/providers/sessions",
    noBody,
    z.array(providerSessionSnapshotSchema)
  ),
  providerInstanceModels: endpoint(
    "GET",
    "/providers/instances/:id/models",
    noBody,
    z.array(providerModelSchema)
  ),
  providerInstanceRefresh: endpoint(
    "POST",
    "/providers/instances/:id/refresh",
    ignoredBody,
    z
      .object({
        instance: providerInstanceSnapshotSchema.nullable(),
        models: z.array(providerModelSchema),
      })
      .passthrough()
  ),
  providerInstanceUpdate: endpoint(
    "POST",
    "/providers/instances/:id/update",
    ignoredBody,
    z
      .object({
        instance: providerInstanceSnapshotSchema.nullable(),
        providers: z.array(providerInstanceSnapshotSchema),
      })
      .passthrough()
  ),
  providerRollbackConversation: endpoint(
    "POST",
    "/providers/rollback-conversation",
    providerRollbackConversationSchema,
    z.object({ rolledBack: bool }).passthrough()
  ),
  providerRefreshModels: endpoint(
    "POST",
    "/providers/refresh-models",
    providerRefreshModelsSchema,
    z.array(providerApiModelSchema)
  ),
  lmStudioModels: endpoint(
    "GET",
    "/lmstudio/models",
    noBody,
    lmStudioModelsResponseSchema
  ),
  openRouterModels: endpoint(
    "GET",
    "/openrouter/models",
    noBody,
    openRouterModelsResponseSchema
  ),
  providerValidateKey: endpoint(
    "POST",
    "/providers/validate-key",
    providerValidateKeySchema,
    z
      .object({
        ok: bool,
        valid: bool,
        status: num.optional(),
        error: text.optional(),
      })
      .passthrough()
  ),
  // `?refresh=true` probes again instead of answering from the cache.
  cliStatus: endpoint("GET", "/cli/status", noBody, cliStatusResponseSchema),
} as const
