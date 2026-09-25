import { OpenAiCompatAdapter } from "./openaiCompat"
import type { ProviderAdapter } from "../adapter"
import type { ModelDefinition } from "../types"
import { LM_STUDIO_BASE_URL } from "../../constants"
import type { DirectMcpAdapterOptions } from "../agent-loop/direct-mcp-tools"
import { ApiModelCatalog } from "./apiModelCatalog"

export function makeOpenAiAdapter(
  apiKey: string | null,
  agentTools: DirectMcpAdapterOptions = {},
  modelCatalog = new ApiModelCatalog()
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
    modelCatalog
  )
}

export function makeGrokAdapter(
  apiKey: string | null,
  agentTools: DirectMcpAdapterOptions = {},
  modelCatalog = new ApiModelCatalog()
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
    modelCatalog
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
