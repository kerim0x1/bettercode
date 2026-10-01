import { OpenAiCompatAdapter } from "./openaiCompat"
import type { ProviderAdapter } from "../adapter"
import type { ModelDefinition } from "../types"
import { LM_STUDIO_BASE_URL } from "../../constants"
import type { DirectMcpAdapterOptions } from "../agent-loop/direct-mcp-tools"
import { ApiModelCatalog } from "./apiModelCatalog"
import type { ApiKeyPool } from "../../auth/apiKeyPool"
import type { Settings } from "../../settings/schema"
import {
  NINEROUTER_KEYLESS_BEARER,
  listNineRouterConnections,
  nineRouterRequestHeaders,
  pickNineRouterConnection,
} from "../ninerouter/connections"
import { describeNineRouterError } from "../ninerouter/errors"

export function makeOpenAiAdapter(
  apiKey: string | null,
  agentTools: DirectMcpAdapterOptions = {},
  modelCatalog = new ApiModelCatalog(),
  apiKeyPool?: ApiKeyPool
): ProviderAdapter {
  const defaultModels: ModelDefinition[] = []
  return new OpenAiCompatAdapter(
    {
      providerKind: "openai",
      displayName: "OpenAI",
      defaultModels,
    },
    apiKey,
    agentTools,
    modelCatalog,
    apiKeyPool
  )
}

export function makeGrokAdapter(
  apiKey: string | null,
  agentTools: DirectMcpAdapterOptions = {},
  modelCatalog = new ApiModelCatalog(),
  apiKeyPool?: ApiKeyPool
): ProviderAdapter {
  return new OpenAiCompatAdapter(
    {
      providerKind: "grok",
      displayName: "xAI Grok",
      baseUrl: "https://api.x.ai/v1",
      defaultModels: [],
    },
    apiKey,
    agentTools,
    modelCatalog,
    apiKeyPool
  )
}

export function makeOpenRouterAdapter(
  apiKey: string | null,
  agentTools: DirectMcpAdapterOptions = {}
): ProviderAdapter {
  return new OpenAiCompatAdapter(
    {
      providerKind: "openrouter",
      displayName: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModels: [], // OpenRouter model list is fetched dynamically elsewhere.
    },
    apiKey,
    agentTools
  )
}

export function makeLmStudioAdapter(
  agentTools: DirectMcpAdapterOptions = {}
): ProviderAdapter {
  return new OpenAiCompatAdapter(
    {
      providerKind: "lmstudio",
      displayName: "LM Studio (local)",
      baseUrl: LM_STUDIO_BASE_URL,
      defaultModels: [], // Resolved at runtime via /v1/models.
    },
    null,
    agentTools
  ) // OpenAiCompatAdapter handles the no-key case for lmstudio.
}

/**
 * 9Router: one adapter, many named connections. Each turn runs on the
 * connection the renderer selected (`provider_instance_id`), read fresh from
 * settings so edits apply to the next turn without rebuilding the adapter.
 */
export function makeNineRouterAdapter(
  getSettings: () => Settings,
  agentTools: DirectMcpAdapterOptions = {}
): ProviderAdapter {
  return new OpenAiCompatAdapter(
    {
      providerKind: "ninerouter",
      displayName: "9Router",
      defaultModels: [], // Per-connection catalogs live in NineRouterService.
      resolveTurnTarget: (input) => {
        const connection = pickNineRouterConnection(
          getSettings(),
          input.provider_instance_id
        )
        return {
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey ?? NINEROUTER_KEYLESS_BEARER,
          headers: nineRouterRequestHeaders(connection),
          describeError: (error) =>
            describeNineRouterError(error, connection, input.model_id),
        }
      },
      isConfigured: () => listNineRouterConnections(getSettings()).length > 0,
      authMeta: () => ({
        authType: "local-server",
        hint: "Add a 9Router connection in Settings → Providers → 9Router (default http://localhost:20128/v1).",
      }),
    },
    null,
    agentTools
  )
}
