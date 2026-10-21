/**
 * Pure request shaping for a chat turn: the model selection and option ids a
 * provider expects, the provider prompt, the rule target path and the wire
 * history. No store access, no network — the orchestrator in
 * `./send-message` feeds these from the stores and hands the result to the
 * transport in `@/services/backend/chatApi`.
 */
import { isClaudeOpusOrSonnet } from "@/lib/anthropic-model"
import {
  withBrowserElementContext,
  modelReasoningDescriptor,
  normalizeThinkingModeValue,
} from "@betterc0de/schema"
import { activeContextMessages } from "@/lib/chat-context"
import { thinkingModeToEffort } from "@/lib/thinking-mode"
import type {
  ChatAttachment,
  ModelCapabilities,
  ModelSelection,
  ProviderOptionSelection,
} from "@betterc0de/schema"
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
  normalizeModelSlug,
  resolvePromptInjectedEffort,
} from "@betterc0de/schema/model-selection"
import { skillScopeProviderKey } from "@betterc0de/schema/prompt-context"

function defaultModelSelectionInstanceId(providerKind: string): string {
  return skillScopeProviderKey(providerKind) || "codex"
}

function effortOptionIdForProvider(providerKind: string): string {
  const provider = skillScopeProviderKey(providerKind)
  if (provider === "codex") {
    return "reasoningEffort"
  }
  if (provider === "cursor") return "reasoning"
  return "effort"
}

function thinkingModeToProviderEffort(
  providerKind: string,
  reasoningEffort: string | null | undefined
): string | null {
  if (!reasoningEffort) return null
  const normalizedProvider = skillScopeProviderKey(providerKind)
  const normalizedEffort = reasoningEffort
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  if (
    normalizedProvider === "claude" ||
    normalizedProvider === "anthropic" ||
    normalizedProvider === "anthropic_cli" ||
    normalizedProvider === "anthropic-cli" ||
    normalizedProvider === "claude_cli" ||
    normalizedProvider === "claude-cli"
  ) {
    if (normalizedEffort === "ultrathink") return "ultrathink"
    if (normalizedEffort === "max") return "max"
    if (normalizedEffort === "xhigh" || normalizedEffort === "extrahigh") {
      return "max"
    }
  }
  if (normalizedEffort === "extrahigh") return "xhigh"
  return thinkingModeToEffort(reasoningEffort)
}

function supportsFastModeProvider(providerKind: string): boolean {
  return ["codex", "claude", "cursor"].includes(
    skillScopeProviderKey(providerKind)
  )
}

function supportsContextWindowProvider(providerKind: string): boolean {
  return ["claude", "anthropic", "cursor"].includes(
    skillScopeProviderKey(providerKind)
  )
}

export function buildModelSelection(input: {
  modelId: string
  providerKind: string
  providerInstanceId?: string | null
  reasoningEffort?: string | null
  fastMode?: boolean | null
  contextWindow?: string | null
  capabilities?: ModelCapabilities | null
  optionSelections?: ReadonlyArray<ProviderOptionSelection> | null
}): ModelSelection {
  const modelId =
    normalizeModelSlug(input.modelId, input.providerKind) ?? input.modelId
  const options: ProviderOptionSelection[] = []
  const descriptor = modelReasoningDescriptor(input.capabilities)
  const thinkingToggle =
    !descriptor &&
    input.capabilities?.optionDescriptors?.some(
      (option) => option.id === "thinking" && option.type === "boolean"
    )
  const requestedEffort = input.reasoningEffort
    ? normalizeThinkingModeValue(input.reasoningEffort)
    : undefined
  const advertisedEffort = requestedEffort
    ? descriptor?.options.find(
        (option) => normalizeThinkingModeValue(option.id) === requestedEffort
      )?.id
    : undefined
  const effort =
    advertisedEffort ??
    thinkingModeToProviderEffort(input.providerKind, input.reasoningEffort)
  if (thinkingToggle && input.reasoningEffort !== undefined) {
    options.push({
      id: "thinking",
      value:
        Boolean(input.reasoningEffort) &&
        !["none", "off"].includes(
          normalizeThinkingModeValue(input.reasoningEffort ?? "")
        ),
    })
  } else if (effort) {
    options.push({
      id: descriptor?.id ?? effortOptionIdForProvider(input.providerKind),
      value: effort,
    })
  }
  if (
    typeof input.fastMode === "boolean" &&
    supportsFastModeProvider(input.providerKind)
  ) {
    options.push({ id: "fastMode", value: input.fastMode })
  }
  if (
    supportsContextWindowProvider(input.providerKind) &&
    (skillScopeProviderKey(input.providerKind) === "cursor" ||
      isClaudeOpusOrSonnet(modelId)) &&
    (input.contextWindow === "200k" || input.contextWindow === "1m")
  ) {
    options.push({ id: "contextWindow", value: input.contextWindow })
  }
  const selectedOptions = mergeProviderOptionSelections(
    options,
    input.optionSelections
  )
  const descriptorOptions = input.capabilities
    ? buildProviderOptionSelectionsFromDescriptors(
        getProviderOptionDescriptors({
          caps: input.capabilities,
          selections: selectedOptions,
        })
      )
    : undefined
  const modelOptions =
    descriptorOptions ??
    (selectedOptions.length > 0 ? selectedOptions : undefined)
  return {
    instanceId:
      input.providerInstanceId ??
      defaultModelSelectionInstanceId(input.providerKind),
    model: modelId,
    ...(modelOptions ? { options: modelOptions } : {}),
  }
}

function mergeProviderOptionSelections(
  primary: ReadonlyArray<ProviderOptionSelection>,
  override: ReadonlyArray<ProviderOptionSelection> | null | undefined
): ProviderOptionSelection[] {
  if (!override || override.length === 0) return [...primary]
  const byId = new Map<string, ProviderOptionSelection>()
  for (const option of primary) byId.set(option.id, option)
  for (const option of override) byId.set(option.id, option)
  return Array.from(byId.values())
}

export function buildProviderPrompt(input: {
  message: string
  providerKind: string
  reasoningEffort?: string | null
  capabilities?: ModelCapabilities | null
}): string {
  const effort = thinkingModeToProviderEffort(
    input.providerKind,
    input.reasoningEffort
  )
  const promptInjectedEffort = resolvePromptInjectedEffort(
    input.capabilities,
    effort
  )
  return applyClaudePromptEffortPrefix(input.message, promptInjectedEffort)
}

/**
 * Legacy alias normalization for kebab/snake variants of OpenAI provider
 * IDs. Pre-codex_cli-adapter, the renderer routed every OpenAI flavor —
 * direct API, OAuth, and CLI — through the same `openai` provider kind
 * with a transport hint. The CLI flavor now lives on its own backend
 * adapter (`codex_cli`), so we MUST NOT map back to `openai` for it —
 * doing so dispatches to OpenAiCompatAdapter which has no API key and
 * throws "OpenAI is not configured". The `codex_cli` family stays
 * untouched and flows directly to the dedicated CLI adapter.
 */
export function normalizeOpenAiTarget(
  providerKind: string,
  openaiTransport?: string | null
): { providerKind: string; openaiTransport: string | null } {
  const normalizedKind = providerKind.trim().toLowerCase()
  const explicitTransport = openaiTransport?.trim().toLowerCase() || null
  if (explicitTransport) {
    return { providerKind, openaiTransport: explicitTransport }
  }

  if (["openai-api", "openai_api", "openaiapi"].includes(normalizedKind)) {
    return { providerKind: "openai", openaiTransport: "api" }
  }
  if (
    ["openai-oauth", "openai_oauth", "openaioauth"].includes(normalizedKind)
  ) {
    return { providerKind: "openai", openaiTransport: "oauth" }
  }
  return { providerKind, openaiTransport: explicitTransport }
}

export function workspaceRuleTargetPath(
  workspaceRoot: string,
  filePath: string
): string | null {
  const normalizedRoot = workspaceRoot.trim().replace(/\\/g, "/")
  const normalizedFile = filePath.trim().replace(/\\/g, "/")
  if (!normalizedRoot || !normalizedFile) return null

  const fileIsAbsolute =
    normalizedFile.startsWith("/") ||
    normalizedFile.startsWith("//") ||
    /^[A-Za-z]:\//.test(normalizedFile)
  if (!fileIsAbsolute) {
    const relative = normalizedFile.replace(/^\.\/+/, "")
    return relative &&
      relative !== ".." &&
      !relative.startsWith("../") &&
      !relative.includes("/../")
      ? relative
      : null
  }

  const root =
    normalizedRoot === "/" ? normalizedRoot : normalizedRoot.replace(/\/+$/, "")
  const prefix = root.endsWith("/") ? root : `${root}/`
  const caseInsensitive =
    /^[A-Za-z]:/.test(root) || normalizedRoot.startsWith("//")
  const rootKey = caseInsensitive ? root.toLowerCase() : root
  const prefixKey = caseInsensitive ? prefix.toLowerCase() : prefix
  const fileKey = caseInsensitive
    ? normalizedFile.toLowerCase()
    : normalizedFile
  if (fileKey === rootKey) return "."
  return fileKey.startsWith(prefixKey)
    ? normalizedFile.slice(prefix.length)
    : null
}

export function automaticCompactionUsage(
  usage:
    | {
        usedTokens?: number
        totalTokens?: number
        inputTokens?: number
        maxTokens?: number
        compactsAutomatically?: boolean
      }
    | null
    | undefined
): {
  usedTokens?: number
  maxTokens?: number
  compactsAutomatically?: boolean
} | null {
  if (!usage) return null
  const usedTokens = [usage.usedTokens, usage.totalTokens, usage.inputTokens]
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    )
    .reduce<
      number | undefined
    >((largest, value) => (largest === undefined ? value : Math.max(largest, value)), undefined)
  const maxTokens =
    typeof usage.maxTokens === "number" &&
    Number.isSafeInteger(usage.maxTokens) &&
    usage.maxTokens > 0
      ? usage.maxTokens
      : undefined
  const compactsAutomatically =
    typeof usage.compactsAutomatically === "boolean"
      ? usage.compactsAutomatically
      : undefined
  if (
    usedTokens === undefined &&
    maxTokens === undefined &&
    compactsAutomatically === undefined
  ) {
    return null
  }
  return {
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(compactsAutomatically !== undefined ? { compactsAutomatically } : {}),
  }
}

export function automaticCompactionModelLimits(
  contextWindow: string | null | undefined
): { contextTokens: number } | null {
  const normalized = (contextWindow ?? "")
    .trim()
    .replaceAll(",", "")
    .replaceAll("_", "")
    .toUpperCase()
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KMG])?$/)
  if (!match) return null
  const amount = Number(match[1])
  const multiplier =
    match[2] === "G"
      ? 1_000_000_000
      : match[2] === "M"
        ? 1_000_000
        : match[2] === "K"
          ? 1_000
          : 1
  const contextTokens = Math.floor(amount * multiplier)
  return Number.isSafeInteger(contextTokens) &&
    contextTokens > 0 &&
    contextTokens <= 16_000_000
    ? { contextTokens }
    : null
}

/**
 * Build the conversation history to send alongside the current turn.
 *
 * The optimistic-UI pattern used by every caller (see `use-chat-submit`,
 * `multi-agent-store`, etc.) adds the new user
 * message to the thread BEFORE calling `sendChatMessage`. The provider
 * prompt can then be transformed (for example Claude "Ultrathink:" prefix
 * or hidden plan implementation prompts), so we strip either the provider
 * prompt or the visible optimistic text. Sending both would make the latest
 * user turn appear twice to the provider.
 *
 * Cap: keep the newest complete suffix of up to 80 messages with a per-message
 * 10k-char ceiling and a 512 KiB serialized UTF-8 ceiling. Anthropic prompt
 * caching in the backend (see
 * `claudeApi.ts`) reuses this prefix across turns so a full 80-message
 * window is cheap after the first call; the cap exists to bound the
 * worst case (brand-new cache, pasted 500k-char file or large tool payload)
 * and leave room below Node/Electron's default 1 MB request body parse limit.
 */
export function stripOptimisticUserEcho<
  T extends { role: string; content: string },
>(
  messages: T[],
  currentMessage: string,
  optimisticMessageContent?: string | null
): T[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "user") return messages
  const echoContents = new Set(
    [currentMessage, optimisticMessageContent]
      .filter((value): value is string => typeof value === "string")
      .filter((value) => value.length > 0)
  )
  return echoContents.has(last.content) ? messages.slice(0, -1) : messages
}

export type WireHistoryMessage = {
  role: string
  content: string
  tool_calls?: Array<{ id: string; name: string; input: unknown }>
  tool_call_id?: string
}

type HistorySourceMessage = {
  role: string
  content: string
  attachments?: ChatAttachment[]
  compactedContext?: boolean
  toolCalls?: ReadonlyArray<{
    id: string
    name: string
    input: unknown
    output?: unknown
    outputPreview?: string
    error?: string
    startedAt?: string
  }>
}

export type ThreadHistoryOptions = {
  maxMessages?: number
  maxContentChars?: number
  maxBytes?: number
}

const DEFAULT_HISTORY_MAX_BYTES = 512 * 1024
const utf8Encoder = new TextEncoder()

/** The text fed back to the model for a tool result — prefer the raw output,
 *  fall back to the stored preview / a JSON stringification / the error. */
function toolResultText(tc: {
  output?: unknown
  outputPreview?: string
  error?: string
}): string {
  if (typeof tc.output === "string") return tc.output
  if (typeof tc.outputPreview === "string") return tc.outputPreview
  if (tc.output != null) {
    try {
      return JSON.stringify(tc.output)
    } catch {
      return String(tc.output)
    }
  }
  return tc.error ?? ""
}

export function buildWireHistory(
  messages: ReadonlyArray<HistorySourceMessage>,
  currentMessage: string,
  optimisticMessageContent?: string | null,
  options?: ThreadHistoryOptions
): WireHistoryMessage[] {
  const maxMessages = Math.max(0, Math.floor(options?.maxMessages ?? 80))
  const maxContentChars = Math.max(
    0,
    Math.floor(options?.maxContentChars ?? 10_000)
  )
  const maxBytes = Math.max(
    2,
    Math.floor(options?.maxBytes ?? DEFAULT_HISTORY_MAX_BYTES)
  )

  const slice = stripOptimisticUserEcho(
    activeContextMessages(messages).messages,
    currentMessage,
    optimisticMessageContent
  )

  const clip = (text: string): string =>
    text.length > maxContentChars
      ? `${text.slice(0, maxContentChars)}\n\n[…truncated for transport…]`
      : text

  const groups: WireHistoryMessage[][] = []
  const recentMessages = maxMessages === 0 ? [] : slice.slice(-maxMessages)
  for (const m of recentMessages) {
    if (m.role === "user") {
      if (typeof m.content === "string" && m.content.length > 0) {
        groups.push([
          {
            role: "user",
            content: clip(withBrowserElementContext(m.content, m.attachments)),
          },
        ])
      }
      continue
    }
    if (m.role !== "assistant") continue

    const toolCalls = m.toolCalls ?? []
    if (toolCalls.length === 0) {
      if (typeof m.content === "string" && m.content.length > 0) {
        groups.push([{ role: "assistant", content: clip(m.content) }])
      }
      continue
    }

    // Assistant turn that called tools: emit the assistant message carrying the
    // tool_calls, then one tool-result message per call (ordered as issued) so
    // the in-house agent loop can replay the exact tool I/O. Tool-only turns
    // (empty content) are kept — they were previously dropped by the length
    // filter, which broke cross-turn tool continuity.
    const ordered = [...toolCalls].sort((a, b) =>
      (a.startedAt ?? "").localeCompare(b.startedAt ?? "")
    )
    const group: WireHistoryMessage[] = [
      {
        role: "assistant",
        content: clip(m.content ?? ""),
        tool_calls: ordered.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: serializableToolInput(tc.input, maxContentChars),
        })),
      },
    ]
    for (const tc of ordered) {
      group.push({
        role: "tool",
        tool_call_id: tc.id,
        content: clip(toolResultText(tc)),
      })
    }
    groups.push(group)
  }

  return newestGroupsWithinByteBudget(groups, maxBytes)
}

function serializableToolInput(
  input: unknown,
  maxContentChars: number
): unknown {
  try {
    const serialized = JSON.stringify(input)
    if (serialized === undefined) return null
    return serialized.length > maxContentChars
      ? `${serialized.slice(0, maxContentChars)}\n\n[…truncated tool input for transport…]`
      : JSON.parse(serialized)
  } catch {
    try {
      const fallback = String(input)
      return fallback.length > maxContentChars
        ? `${fallback.slice(0, maxContentChars)}\n\n[…truncated tool input for transport…]`
        : fallback
    } catch {
      return "[unserializable tool input]"
    }
  }
}

function newestGroupsWithinByteBudget(
  groups: ReadonlyArray<ReadonlyArray<WireHistoryMessage>>,
  maxBytes: number
): WireHistoryMessage[] {
  const selected: WireHistoryMessage[][] = []
  let selectedMessages = 0
  let serializedBytes = 2 // JSON array brackets

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    if (!group || group.length === 0) continue
    const groupBytes = group.reduce(
      (total, message, messageIndex) =>
        total +
        (messageIndex > 0 ? 1 : 0) +
        utf8Encoder.encode(JSON.stringify(message)).byteLength,
      0
    )
    const separatorBytes = selectedMessages > 0 ? 1 : 0
    if (serializedBytes + separatorBytes + groupBytes > maxBytes) break

    selected.unshift([...group])
    selectedMessages += group.length
    serializedBytes += separatorBytes + groupBytes
  }

  return selected.flat()
}
