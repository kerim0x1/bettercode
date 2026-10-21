import { invokeContract } from "./contracts"
import type { ApiKeyProvider, ApiKeyPoolView } from "@betterc0de/schema"
import type {
  CliStatus,
  CliStatusResponse,
  HttpContractResponse,
  OpenRouterLiveModel,
  ProviderStatus,
} from "@betterc0de/schema/http-contracts"
import type {
  ProviderAuthMethod,
  ProviderCatalogEntry,
} from "@/types/electron-api"
import type {
  ModelCapabilities,
  ProviderInstanceSnapshot,
  ProviderModel,
} from "@betterc0de/schema"

// Every call goes through its shared contract
// (`@betterc0de/schema/http-contracts`, `provider-contracts.ts`): the
// request is checked before it is sent and the response validated before a
// caller sees it.

/**
 * `ProviderStatus` is the backend's `/providers/status` row; the renderer
 * treats `provider` as an opaque string keyed by the backend's
 * `ProviderKind`. `CliStatusResponse` is `GET /cli/status`.
 */
export type {
  CliStatus,
  CliStatusResponse,
  OpenRouterLiveModel,
  ProviderStatus,
}

const cwdQuery = (cwd?: string | null) =>
  cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""

export const listProviders = (): Promise<string[]> =>
  invokeContract("providerKinds")

type CatalogAuthMethod =
  HttpContractResponse<"providerCatalog">[number]["authMethods"][number]

/** Settings has no OAuth sign-in; a provider keeps its other methods. */
function settingsAuthMethods(
  methods: readonly CatalogAuthMethod[]
): ProviderAuthMethod[] {
  const shown: ProviderAuthMethod[] = []
  for (const method of methods) {
    if (method.type !== "oauth") shown.push(method)
  }
  return shown
}

export const listProviderCatalog = (): Promise<ProviderCatalogEntry[]> =>
  invokeContract("providerCatalog").then((entries) =>
    entries.map((entry) => ({
      ...entry,
      authMethods: settingsAuthMethods(entry.authMethods),
    }))
  )

// The API-key calls go through their shared contracts
// (`@betterc0de/schema/http-contracts`); each answers with the provider's
// whole key list.
const forProvider = (provider: ApiKeyProvider) => ({ params: { provider } })
export const listApiKeys = (
  provider: ApiKeyProvider,
  signal?: AbortSignal
): Promise<ApiKeyPoolView> =>
  invokeContract("apiKeysList", { ...forProvider(provider), signal })
export const addApiKey = (
  provider: ApiKeyProvider,
  label: string,
  apiKey: string
): Promise<ApiKeyPoolView> =>
  invokeContract("apiKeysAdd", {
    ...forProvider(provider),
    body: { label, apiKey },
  })
export const editApiKey = (
  provider: ApiKeyProvider,
  id: string,
  patch: { label?: string; enabled?: boolean; apiKey?: string }
): Promise<ApiKeyPoolView> =>
  invokeContract("apiKeysUpdate", { ...forProvider(provider), id, body: patch })
export const removeApiKey = (
  provider: ApiKeyProvider,
  id: string
): Promise<ApiKeyPoolView> =>
  invokeContract("apiKeysRemove", { ...forProvider(provider), id })
export const restoreExternalApiKeySource = (
  provider: ApiKeyProvider
): Promise<ApiKeyPoolView> =>
  invokeContract("apiKeysUseExternal", forProvider(provider))
export const reorderApiKeys = (
  provider: ApiKeyProvider,
  ids: string[]
): Promise<ApiKeyPoolView> =>
  invokeContract("apiKeysReorder", { ...forProvider(provider), body: { ids } })
export const testApiKey = (
  provider: ApiKeyProvider,
  id: string
): Promise<ApiKeyPoolView> =>
  invokeContract("apiKeysTest", { ...forProvider(provider), id })
export const retryApiKey = (
  provider: ApiKeyProvider,
  id: string
): Promise<ApiKeyPoolView> =>
  invokeContract("apiKeysRetry", { ...forProvider(provider), id })

export interface ApiModel {
  slug: string
  name: string
  provider: string
  context?: string
  tier?: string
  isCustom?: boolean
  capabilities?: ModelCapabilities | null
}

export const listModels = (): Promise<ApiModel[]> =>
  invokeContract("listModels")
export const listProviderSettingsModels = (): Promise<ApiModel[]> =>
  invokeContract("listModels", { query: "?includeHidden=1" })

export const refreshModels = (): Promise<ApiModel[]> =>
  invokeContract("providerRefreshModels", { body: {} })

export const getProviderStatus = (): Promise<ProviderStatus[]> =>
  invokeContract("providerStatus")

export const listProviderInstances = (
  cwd?: string | null
): Promise<ProviderInstanceSnapshot[]> =>
  invokeContract("providerInstances", { query: cwdQuery(cwd) })

export const listProviderInstanceModels = (
  instanceId: string,
  cwd?: string | null
): Promise<ReadonlyArray<ProviderModel>> =>
  invokeContract("providerInstanceModels", {
    id: instanceId,
    query: cwdQuery(cwd),
  })

export const refreshProviderInstance = (
  instanceId: string,
  cwd?: string | null
): Promise<{
  instance: ProviderInstanceSnapshot | null
  models: ReadonlyArray<ProviderModel>
}> =>
  invokeContract("providerInstanceRefresh", {
    id: instanceId,
    query: cwdQuery(cwd),
    body: {},
  })

export const updateProviderInstance = (
  instanceId: string,
  cwd?: string | null
): Promise<{
  instance: ProviderInstanceSnapshot | null
  providers: ReadonlyArray<ProviderInstanceSnapshot>
}> =>
  invokeContract("providerInstanceUpdate", {
    id: instanceId,
    query: cwdQuery(cwd),
    body: {},
  })

export const rollbackProviderConversation = (
  threadId: string,
  numTurns: number,
  input: {
    providerKind?: string | null
    providerInstanceId?: string | null
  } = {}
): Promise<{ rolledBack: boolean }> =>
  invokeContract("providerRollbackConversation", {
    body: {
      threadId,
      numTurns,
      ...(input.providerKind ? { providerKind: input.providerKind } : {}),
      ...(input.providerInstanceId !== undefined
        ? { providerInstanceId: input.providerInstanceId }
        : {}),
    },
  })

/** `refresh` probes the CLIs again instead of reading the 30 s cache. */
export const getCliStatus = (
  options: { refresh?: boolean } = {}
): Promise<CliStatusResponse> =>
  invokeContract(
    "cliStatus",
    options.refresh ? { query: "?refresh=true" } : undefined
  )

export const listLmStudioModels = (): Promise<{
  data?: { id: string }[]
  error?: string
}> => invokeContract("lmStudioModels")

/** Live OpenRouter catalog subset (backend-cached; `error: "not_configured"`
 *  when no OpenRouter key is set — the picker then keeps its curated list). */
export const listOpenRouterModels = (): Promise<{
  data?: OpenRouterLiveModel[]
  error?: string
}> => invokeContract("openRouterModels")

/**
 * Server-side API-key validation. The renderer must NOT call provider
 * APIs (api.anthropic.com / api.openai.com / …) directly: CORS blocks
 * Anthropic + OpenRouter, and any direct call leaks the key into the
 * renderer's network panel. Backend handles the probe and returns just
 * a yes/no.
 */
export const validateProviderKey = (
  kind: string,
  apiKey: string
): Promise<{ ok: boolean; valid: boolean; status?: number; error?: string }> =>
  invokeContract("providerValidateKey", { body: { kind, apiKey } })
