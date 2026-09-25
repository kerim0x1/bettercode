/**
 * Provider kinds — identical serde encoding to the Rust enum (snake_case).
 * The renderer sends any of these strings in chat/send requests.
 */
export type ProviderKind =
  | "openai"
  | "anthropic"
  | "anthropic_cli"
  | "google"
  | "grok"
  | "openrouter"
  | "lmstudio"

const PROVIDER_KIND_ALIASES: Record<string, ProviderKind> = {
  openai: "openai",
  "openai-api": "openai",
  openai_api: "openai",
  openaiapi: "openai",
  "openai-oauth": "openai",
  openai_oauth: "openai",
  openaioauth: "openai",
  anthropic: "anthropic",
  anthropic_cli: "anthropic_cli",
  anthropiccli: "anthropic_cli",
  google: "google",
  grok: "grok",
  openrouter: "openrouter",
  lmstudio: "lmstudio",
}

export function parseProviderKind(raw: string): ProviderKind | null {
  const normalized = raw.trim().toLowerCase()
  return Object.hasOwn(PROVIDER_KIND_ALIASES, normalized)
    ? (PROVIDER_KIND_ALIASES[normalized] ?? null)
    : null
}

export function inferOpenAiTransport(raw: string): "api" | "oauth" | null {
  const normalized = raw.trim().toLowerCase()
  if (["openai-api", "openai_api", "openaiapi"].includes(normalized))
    return "api"
  if (["openai-oauth", "openai_oauth", "openaioauth"].includes(normalized))
    return "oauth"
  return null
}

/**
 * A single message in the rolling conversation history (sent at every turn).
 *
 * `tool_calls` (on an `assistant` message) and `tool_call_id` (on a
 * `role:"tool"` message) carry the durable tool-call history so the in-house
 * agent loop can replay prior tool I/O across user turns. Both are optional so
 * older threads and non-tool turns keep parsing unchanged.
 */
export interface HistoryMessage {
  role: string
  content: string
  tool_calls?: Array<{ id: string; name: string; input: unknown }>
  tool_call_id?: string
}

export interface ProviderAttachment {
  type: string
  filename?: string | null
  mediaType?: string | null
  url: string
}

/** Input to ProviderAdapter.sendMessage — sent over HTTP/WS from the renderer. */
export interface ProviderSendTurnInput {
  thread_id: string
  message: string
  model_id: string
  reasoning_effort?: string | null
  chat_mode?: string | null
  app_mode?: "agent" | "editor" | "design" | null
  design_context?: unknown
  project_path?: string | null
  history: HistoryMessage[]
  attachments?: ProviderAttachment[]
  system_instruction?: string | null
  permission_level?: string | null
  openai_transport?: string | null
  sandbox?:
    | "never"
    | "workspaceRead"
    | "workspaceWrite"
    | "dangerFullAccess"
    | null
  approvalPolicy?: "never" | "onRequest" | "always" | null
  personality?: "friendly" | "pragmatic" | "none" | null
  serviceTier?: "auto" | "pro" | "business" | null
  effort?: "balanced" | "deep" | null
  collaborationMode?: unknown
  sourceProposedPlan?: {
    threadId: string
    planId: string
  } | null
}

/** Runtime events emitted by adapters during a turn. Identical shape to Rust,
 *  so the renderer's switch on `event_type` continues to work. */
export interface ProviderRuntimeEvent {
  event_type: string
  thread_id: string
  payload: Record<string, unknown>
}

export interface ModelDefinition {
  slug: string
  name: string
  provider: ProviderKind
  context?: string
  tier?: string
  isCustom?: boolean
  // Mirrored but not strictly used by the initial renderer wiring; kept for
  // future parity with rust-backend/src/provider/models.rs.
  capabilities?: Record<string, unknown>
}
