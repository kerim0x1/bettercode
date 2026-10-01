import { z } from "zod"
import { secretPatchSchema, secretStateSchema } from "./secret"

/**
 * 9Router (https://github.com/decolua/9router) is a local OpenAI-compatible
 * router in front of many AI subscriptions and API accounts. BetterC0de talks
 * to its `/v1/chat/completions` and `/v1/models` endpoints through one or
 * more named connections (a local router, a VPS, a tunnel).
 *
 * The provider kind starts with a letter because provider and instance slugs
 * must; "9router" is accepted as an alias wherever a kind is parsed.
 */
export const NINEROUTER_PROVIDER_KIND = "ninerouter"
export const NINEROUTER_DISPLAY_NAME = "9Router"
export const NINEROUTER_DEFAULT_BASE_URL = "http://localhost:20128/v1"
export const NINEROUTER_DOCS_URL = "https://github.com/decolua/9router"
export const NINEROUTER_MAX_CONNECTIONS = 12
export const NINEROUTER_MAX_MODEL_IDS = 200

const MAX_MODEL_ID_CHARS = 256

export const nineRouterConnectionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "connection id must start with a letter and contain only lowercase letters, digits, or dashes"
  )

const modelIdListSchema = z
  .array(z.string().trim().min(1).max(MAX_MODEL_ID_CHARS))
  .max(NINEROUTER_MAX_MODEL_IDS)
  .default([])

/** On-disk shape. `api_key` is ciphertext on disk and plaintext only inside the backend. */
export const nineRouterConnectionSchema = z.object({
  id: nineRouterConnectionIdSchema,
  name: z.string().trim().min(1).max(60),
  base_url: z.string().trim().min(1).max(2_048),
  api_key: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.string().optional()
  ),
  enabled: z.boolean().default(true),
  /** `false` sends `X-9Router-Token-Saver: off`, keeping tool output uncompressed. */
  token_saver: z.boolean().default(true),
  custom_models: modelIdListSchema,
  hidden_models: modelIdListSchema,
})
export type NineRouterConnection = z.infer<typeof nineRouterConnectionSchema>

export const nineRouterConnectionsSchema = z
  .array(nineRouterConnectionSchema)
  .max(NINEROUTER_MAX_CONNECTIONS)
  .refine(
    (connections) =>
      new Set(connections.map((connection) => connection.id)).size ===
      connections.length,
    "9Router connection IDs must be unique"
  )
  .default([])

export const nineRouterConnectionStatusSchema = z.object({
  state: z.enum(["unknown", "online", "auth_required", "offline", "error"]),
  message: z.string().nullable(),
  version: z.string().nullable(),
  latestVersion: z.string().nullable(),
  latencyMs: z.number().nullable(),
  modelCount: z.number().int().nonnegative().nullable(),
  checkedAt: z.number().nullable(),
})
export type NineRouterConnectionStatus = z.infer<
  typeof nineRouterConnectionStatusSchema
>

export const nineRouterModelSchema = z.object({
  slug: z.string(),
  name: z.string(),
  /** Picker group: "Combos", "Claude Code", "Codex", … */
  tier: z.string(),
  context: z.string().optional(),
  isCustom: z.boolean(),
  hidden: z.boolean(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
})
export type NineRouterModel = z.infer<typeof nineRouterModelSchema>

/** Renderer-safe connection view. The stored key is never present. */
export const nineRouterConnectionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  dashboardUrl: z.string(),
  enabled: z.boolean(),
  tokenSaver: z.boolean(),
  secret: secretStateSchema,
  customModels: z.array(z.string()),
  hiddenModels: z.array(z.string()),
  status: nineRouterConnectionStatusSchema,
  models: z.array(nineRouterModelSchema),
})
export type NineRouterConnectionView = z.infer<
  typeof nineRouterConnectionViewSchema
>

export const nineRouterProviderViewSchema = z.object({
  enabled: z.boolean(),
  connections: z.array(nineRouterConnectionViewSchema),
})
export type NineRouterProviderView = z.infer<
  typeof nineRouterProviderViewSchema
>

export const nineRouterDetectResultSchema = z.object({
  found: z.boolean(),
  baseUrl: z.string().nullable(),
  version: z.string().nullable(),
  alreadyConnected: z.boolean(),
})
export type NineRouterDetectResult = z.infer<
  typeof nineRouterDetectResultSchema
>

export const createNineRouterConnectionSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    baseUrl: z.string().trim().min(1).max(2_048),
    apiKey: z.string().trim().max(4_096).optional(),
    tokenSaver: z.boolean().optional(),
  })
  .strict()
export type CreateNineRouterConnection = z.infer<
  typeof createNineRouterConnectionSchema
>

export const updateNineRouterConnectionSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    baseUrl: z.string().trim().min(1).max(2_048).optional(),
    apiKey: secretPatchSchema.optional(),
    enabled: z.boolean().optional(),
    tokenSaver: z.boolean().optional(),
    customModels: z
      .array(z.string().trim().min(1).max(MAX_MODEL_ID_CHARS))
      .max(NINEROUTER_MAX_MODEL_IDS)
      .optional(),
    hiddenModels: z
      .array(z.string().trim().min(1).max(MAX_MODEL_ID_CHARS))
      .max(NINEROUTER_MAX_MODEL_IDS)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Empty connection update")
export type UpdateNineRouterConnection = z.infer<
  typeof updateNineRouterConnectionSchema
>

export function isNineRouterProviderKind(
  kind: string | null | undefined
): boolean {
  const key = (kind ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  return key === "ninerouter" || key === "9router"
}

/**
 * Picker and phone selections carry `ninerouter:<connection id>` as their
 * provider instance id, so a connection named like a CLI instance ("codex")
 * can never be mistaken for it.
 */
export function nineRouterInstanceId(connectionId: string): string {
  return `${NINEROUTER_PROVIDER_KIND}:${connectionId}`
}

/** Connection id from an instance id; plain ids are accepted for older callers. */
export function nineRouterConnectionIdFromInstanceId(
  instanceId: string | null | undefined
): string | null {
  const value = instanceId?.trim()
  if (!value) return null
  const match = /^(?:ninerouter|9router):(.+)$/i.exec(value)
  return match?.[1] ?? value
}

/**
 * Accepts what people paste: `localhost:20128`, `http://host:20128`, the
 * dashboard URL, or a tunnel URL with or without `/v1`. Returns the API base
 * ending in `/v1`, or `null` when the value is not an http(s) URL.
 */
export function normalizeNineRouterBaseUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.username || url.password) return null
  url.search = ""
  url.hash = ""
  let path = url.pathname.replace(/\/+$/, "")
  path = path.replace(/\/dashboard(?:\/.*)?$/i, "")
  path = path.replace(/\/(?:chat\/completions|models)$/i, "")
  path = path.replace(/(?:\/v1)+$/i, "")
  return `${url.origin}${path}/v1`
}

/** Server root (no `/v1`), used for `/api/health`, `/api/version` and the dashboard. */
export function nineRouterServerRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")
}

export function nineRouterDashboardUrl(baseUrl: string): string {
  return `${nineRouterServerRoot(baseUrl)}/dashboard`
}

/** Loopback routers accept `/v1/models` without a key; remote ones never do. */
export function isLoopbackNineRouterUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return (
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]" ||
      /^127\./.test(host)
    )
  } catch {
    return false
  }
}

// Prefixes from 9Router's provider registry (open-sse/providers/registry).
const PREFIX_GROUPS: Readonly<Record<string, string>> = {
  cc: "Claude Code",
  cx: "Codex",
  gh: "GitHub Copilot",
  cu: "Cursor",
  kr: "Kiro",
  ag: "Antigravity",
  gc: "Gemini CLI",
  if: "iFlow",
  oc: "OpenCode Free",
  ocg: "OpenCode Go",
  ocz: "OpenCode Zen",
  glm: "Z.ai GLM",
  "glm-cn": "Z.ai GLM (China)",
  kimi: "Kimi",
  "kimi-coding": "Kimi",
  kmc: "Kimi",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax (China)",
  vx: "Vertex AI",
  vertex: "Vertex AI",
  vxp: "Vertex AI Partners",
  "vertex-partner": "Vertex AI Partners",
  cl: "Cline",
  clinepass: "ClinePass",
  kc: "Kilo Code",
  kgw: "Kilo Gateway",
  qd: "Qoder",
  qdcn: "Qoder (China)",
  cbcn: "CodeBuddy (China)",
  cbai: "CodeBuddy",
  zd: "Zed",
  gcli: "Grok CLI",
  "grok-build": "Grok CLI",
  gb: "Grok CLI",
  gw: "Grok Web",
  pw: "Perplexity Web",
  mimo: "Xiaomi MiMo",
  xmtp: "MiMo Token Plan",
  ds: "DeepSeek",
  pplx: "Perplexity",
  pa: "Perplexity Agent",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
  xai: "xAI",
  nvidia: "NVIDIA",
  together: "Together AI",
  fireworks: "Fireworks",
  cerebras: "Cerebras",
  cohere: "Cohere",
  azure: "Azure OpenAI",
  ollama: "Ollama",
  "ollama-local": "Ollama (local)",
  vercel: "Vercel AI Gateway",
}

export const NINEROUTER_COMBO_GROUP = "Combos"
export const NINEROUTER_CUSTOM_GROUP = "Custom"

/** `cc/claude-opus-5-5` → `cc`; a bare combo name has no prefix. */
export function nineRouterModelPrefix(modelId: string): string | null {
  const slash = modelId.indexOf("/")
  return slash > 0 ? modelId.slice(0, slash) : null
}

/** Picker group for a model: combos first, then the upstream account. */
export function nineRouterModelGroup(
  modelId: string,
  ownedBy?: string | null
): string {
  if (ownedBy === "combo") return NINEROUTER_COMBO_GROUP
  const prefix = nineRouterModelPrefix(modelId)
  if (!prefix) return ownedBy ? groupLabel(ownedBy) : NINEROUTER_COMBO_GROUP
  return groupLabel(prefix)
}

function groupLabel(prefix: string): string {
  const key = prefix.toLowerCase()
  const known = PREFIX_GROUPS[key]
  if (known) return known
  if (key.startsWith("openai-compatible-")) return "OpenAI-compatible"
  if (key.startsWith("anthropic-compatible-")) return "Anthropic-compatible"
  return key.length <= 4
    ? key.toUpperCase()
    : `${key.charAt(0).toUpperCase()}${key.slice(1)}`
}

/** Subset of 9Router's `/v1/models` capability block used for thinking options. */
export interface NineRouterModelCapabilities {
  readonly reasoning?: boolean
  readonly thinkingFormat?: string | null
  readonly thinkingCanDisable?: boolean
}

const LEVELS = {
  base: ["none", "low", "medium", "high"],
  onOff: ["none", "high"],
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],
  levelMax: ["none", "low", "medium", "high", "max"],
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],
  gemini: ["minimal", "low", "medium", "high"],
  hiMax: ["none", "high", "max"],
} as const

// Mirrors 9Router's open-sse/providers/thinkingLevels.js (FORMAT_LEVELS).
// 9Router clamps anything a model does not support, so a slightly stale table
// costs an ignored step, never a failed request.
const FORMAT_LEVELS: Readonly<Record<string, readonly string[]>> = {
  openai: LEVELS.openai,
  "claude-adaptive": LEVELS.budgetX,
  "claude-budget": LEVELS.budgetX,
  "gemini-level": LEVELS.gemini,
  "gemini-budget": LEVELS.base,
  zai: LEVELS.onOff,
  qwen: LEVELS.base,
  kimi: LEVELS.levelMax,
  deepseek: LEVELS.hiMax,
  commandcode: LEVELS.budgetX,
  minimax: LEVELS.onOff,
  hunyuan: LEVELS.base,
  step: LEVELS.base,
}

/** Formats where 9Router turns `auto` into adaptive or dynamic thinking. */
const ADAPTIVE_FORMATS: ReadonlySet<string> = new Set([
  "claude-adaptive",
  "claude-budget",
  "gemini-budget",
  "gemini-level",
])

const CODEX_EXTENDED = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

function patternLevels(model: string): readonly string[] | null {
  if (/claude.*4[.-]6/.test(model)) return LEVELS.levelMax
  if (/gpt-6|gpt-5\.6/.test(model)) return CODEX_EXTENDED
  if (model.includes("codex")) return ["low", "medium", "high", "xhigh"]
  if (/deepseek-v4\./.test(model)) return LEVELS.budgetX
  return null
}

/** Ladder for models whose capabilities are unknown (custom ids, partial live data). */
export const NINEROUTER_GENERIC_LEVELS: readonly string[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

/**
 * Reasoning levels BetterC0de offers for a 9Router model, lowest first.
 * `auto` leads the list for adaptive formats (Claude adaptive thinking,
 * Gemini dynamic budgets). Returns `null` when 9Router reports that the
 * model does not reason, and the generic ladder when nothing is known.
 */
export function nineRouterThinkingLevels(
  modelId: string,
  capabilities: NineRouterModelCapabilities | null | undefined
): readonly string[] | null {
  if (capabilities?.reasoning === false) return null
  if (capabilities?.reasoning !== true) return NINEROUTER_GENERIC_LEVELS
  const model = modelId
    .toLowerCase()
    .replace(/\([^()]+\)\s*$/, "")
    .split("/")
    .pop()!
  const format = capabilities.thinkingFormat ?? "openai"
  let levels: readonly string[] =
    patternLevels(model) ?? FORMAT_LEVELS[format] ?? LEVELS.base
  if (capabilities.thinkingCanDisable === false)
    levels = levels.filter((level) => level !== "none")
  return ADAPTIVE_FORMATS.has(format) ? ["auto", ...levels] : levels
}

export function nineRouterThinkingLabel(level: string, format?: string | null) {
  switch (level) {
    case "auto":
      return "Auto (adaptive)"
    case "none":
      return "Off"
    case "minimal":
      return "Minimal"
    case "xhigh":
      return "Extra High"
    case "high":
      return format === "zai" || format === "minimax" ? "On" : "High"
    default:
      return `${level.charAt(0).toUpperCase()}${level.slice(1)}`
  }
}

/** Default selection: adaptive where available, otherwise medium (or the closest level). */
export function nineRouterDefaultThinkingLevel(
  levels: readonly string[]
): string | null {
  if (levels.includes("auto")) return "auto"
  if (levels.includes("medium")) return "medium"
  return levels.find((level) => level !== "none") ?? levels[0] ?? null
}
