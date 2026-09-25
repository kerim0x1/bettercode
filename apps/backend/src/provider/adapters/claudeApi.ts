import Anthropic from "@anthropic-ai/sdk"
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages"
import type {
  ModelDefinition,
  ProviderKind,
  ProviderSendTurnInput,
} from "../types"
import { logger } from "../../observability/logger"
import { cancelPendingApprovals, normalizeLevel } from "../permissions"
import { normalizeAnthropicModelId } from "./anthropicModelIds"
import { ApiModelCatalog } from "./apiModelCatalog"
import {
  anthropicRequiresExplicitThinkingDisplay,
  parseAnthropicModelId,
} from "@betterc0de/schema"
import { BaseProviderAdapter } from "./baseAdapter"
import {
  buildUnsupportedAttachmentNotice,
  imageAttachments,
  parseBase64DataUrl,
} from "../attachments"
import {
  getMaxTurnsForMode,
  getToolsForMode,
  maxTurnsExhaustedMessage,
} from "../shared/chat-mode-tools"
import {
  DIRECT_TOOL_TIMEOUT_MS,
  toAnthropicTools,
} from "../agent-loop/tool-catalog"
import {
  executeTool,
  type ToolMutationArtifact,
} from "../agent-loop/tool-executor"
import { gateToolCall } from "../agent-loop/tool-gate"
import { filterToolsForBetterC0deProjectPolicy } from "../project-tool-policy"
import {
  getProjectToolOutputLimits,
  listProjectPermissions,
  listProjectTools,
} from "../../services/workspace"
import {
  DirectMcpToolSession,
  directMcpEnabledForTurn,
  directMcpToolsForAnthropic,
  type DirectMcpAdapterOptions,
} from "../agent-loop/direct-mcp-tools"

async function loadDirectProjectToolPolicy(cwd: string): Promise<{
  readonly toolFlags: Awaited<ReturnType<typeof listProjectTools>>
  readonly permissionRules: Awaited<ReturnType<typeof listProjectPermissions>>
}> {
  if (!cwd.trim()) return { toolFlags: [], permissionRules: [] }
  const [toolFlags, permissionRules] = await Promise.all([
    listProjectTools(cwd),
    listProjectPermissions(cwd),
  ])
  return { toolFlags, permissionRules }
}

/** A content block that carries an optional prompt-cache breakpoint. */
type CacheableContentBlock = { cache_control?: { type: "ephemeral" } | null }

type ClaudeImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"

function normalizeClaudeImageMediaType(
  value: string
): ClaudeImageMediaType | null {
  if (value === "image/jpg") return "image/jpeg"
  if (
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/gif" ||
    value === "image/webp"
  ) {
    return value
  }
  return null
}

/**
 * Direct-HTTP Claude adapter via the Anthropic Node SDK, with an in-house
 * agentic tool loop. Each `sendMessage` streams one or more model turns: the
 * model answers (no `tool_use` blocks → done) or requests tools, which we gate
 * (shared `gateToolCall`), execute (`executeTool`), and feed back as
 * `tool_result` blocks in a user message before looping again. Tool I/O is
 * surfaced to the renderer as `tool_call` → `tool_result` events and persisted
 * on the assistant message so it replays across user turns (see
 * `buildThreadHistory` + `decodeHistory`).
 */
function buildClaudeUserContent(
  input: ProviderSendTurnInput
): ContentBlockParam[] {
  const images = imageAttachments(input.attachments)
  const validImageUrls = new Set<string>()
  const imageBlocks = images.flatMap((attachment) => {
    const parsed = parseBase64DataUrl(attachment.url)
    if (!parsed) return []
    const mediaType = normalizeClaudeImageMediaType(parsed.mediaType)
    if (!mediaType) return []
    validImageUrls.add(attachment.url)
    return [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mediaType,
          data: parsed.base64,
        },
      },
    ]
  })
  const unsupported = (input.attachments ?? []).filter(
    (attachment) => !validImageUrls.has(attachment.url)
  )
  const notice = buildUnsupportedAttachmentNotice(unsupported)
  return [
    {
      type: "text",
      text: notice ? `${input.message}${notice}` : input.message,
      cache_control: { type: "ephemeral" as const },
    },
    ...imageBlocks,
  ]
}

export class ClaudeApiAdapter extends BaseProviderAdapter {
  private client: Anthropic | null = null
  private apiKey: string | null = null
  private abortControllers = new Map<string, AbortController>()
  private forceCatalogRefresh = false

  constructor(
    apiKey: string | null,
    private readonly agentTools: DirectMcpAdapterOptions = {},
    private readonly modelCatalog = new ApiModelCatalog()
  ) {
    super()
    this.setApiKey(apiKey)
  }

  protected _activeSessionIds(): string[] {
    return Array.from(this.abortControllers.keys())
  }

  /**
   * Rebuild the Anthropic client when the user adds/changes/clears the API
   * key in settings. The previous (or null) client reference is dropped;
   * any in-flight stream still holds its own reference and continues
   * unaffected — only NEW `sendMessage` calls see the swap.
   */
  setApiKey(apiKey: string | null): void {
    if (this.apiKey !== (apiKey?.trim() || null))
      this.forceCatalogRefresh = true
    this.client = apiKey ? new Anthropic({ apiKey }) : null
    this.apiKey = apiKey?.trim() || null
  }

  providerKind(): ProviderKind {
    return "anthropic"
  }
  displayName(): string {
    return "Claude (API)"
  }
  availableModels(): ModelDefinition[] {
    return []
  }
  async discoverModels(force = false): Promise<ModelDefinition[]> {
    const refresh = force || this.forceCatalogRefresh
    this.forceCatalogRefresh = false
    return this.modelCatalog.list("anthropic", this.apiKey, refresh)
  }
  isConfigured(): boolean {
    return this.client !== null
  }
  authMeta(): { authType: string; hint?: string } {
    return {
      authType: "api-key",
      hint: "Not set up — add a Claude API key in Settings (anthropic.com/settings/keys).",
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const controller = this.abortControllers.get(threadId)
    controller?.abort()
    cancelPendingApprovals(threadId)
  }

  async sendMessage(input: ProviderSendTurnInput): Promise<void> {
    const client = this.client
    if (!client) {
      throw new Error("Anthropic API key not configured")
    }
    const controller = new AbortController()
    this.abortControllers.set(input.thread_id, controller)
    let mcpSession: DirectMcpToolSession | null = null

    try {
      const level = normalizeLevel(input.permission_level)
      const mode = input.chat_mode ?? null
      const cwd = input.project_path ?? ""
      const projectToolPolicy = await loadDirectProjectToolPolicy(cwd)
      if (controller.signal.aborted) return
      if (cwd.trim()) {
        mcpSession = await DirectMcpToolSession.open({
          cwd,
          signal: controller.signal,
          resolver: directMcpEnabledForTurn(mode, input.permission_level)
            ? this.agentTools.mcpServerResolver
            : undefined,
          clientFactory: this.agentTools.mcpClientFactory,
        })
      }
      const tools = [
        ...toAnthropicTools(
          filterToolsForBetterC0deProjectPolicy(getToolsForMode(mode), {
            toolFlags: projectToolPolicy.toolFlags,
            permissionRules: projectToolPolicy.permissionRules,
          })
        ),
        ...(mcpSession ? directMcpToolsForAnthropic(mcpSession) : []),
      ] as Tool[]
      const limits = cwd.trim()
        ? await getProjectToolOutputLimits(cwd).catch(() => ({
            maxLines: 2000,
            maxBytes: 50 * 1024,
          }))
        : { maxLines: 2000, maxBytes: 50 * 1024 }

      // Prompt caching: mark the system prompt (stable across turns) and the
      // current user text (via buildClaudeUserContent) with an ephemeral cache
      // breakpoint so subsequent turns read the prefix from cache.
      const systemBlocks = input.system_instruction
        ? [
            {
              type: "text" as const,
              text: input.system_instruction,
              cache_control: { type: "ephemeral" as const },
            },
          ]
        : undefined

      // Extended thinking: enable when the renderer asks for elevated reasoning
      // and the model supports it (Claude Opus/Sonnet 4+, Fable 5).
      const model = normalizeAnthropicModelId(input.model_id) ?? input.model_id
      const modelCapabilities = anthropicModelCapabilities(model)
      const requestedThinkingBudget = mapReasoningToThinkingBudget(
        input.reasoning_effort
      )
      const thinkingBudget = Math.min(
        requestedThinkingBudget,
        Math.max(0, modelCapabilities.maxOutputTokens - 4_096)
      )
      // Adaptive-era models (4.7+, Fable): `budget_tokens` returns a 400.
      // Thinking is requested as `{type:"adaptive"}` — mandatory on Opus
      // 4.7/4.8 where omitting the param disables thinking entirely — with
      // `display:"summarized"` because these generations default to "omitted"
      // (empty thinking blocks, so the UI would show no reasoning at all).
      // Depth comes from `output_config.effort` instead of a token budget.
      const alwaysOnThinking = model === "claude-opus-5-5"
      const adaptiveEffort = modelCapabilities.adaptiveThinking
        ? (mapReasoningToAdaptiveEffort(input.reasoning_effort) ??
          (alwaysOnThinking ? "medium" : null))
        : null
      const thinking =
        modelCapabilities.adaptiveThinking &&
        (adaptiveEffort || alwaysOnThinking)
          ? { type: "adaptive" as const, display: "summarized" as const }
          : thinkingBudget >= 1_024 && modelCapabilities.manualThinking
            ? { type: "enabled" as const, budget_tokens: thinkingBudget }
            : undefined
      // Anthropic requires the total output allowance to be strictly greater
      // than the thinking budget. Keep a useful response reserve after the
      // hidden reasoning tokens instead of sending an invalid combination.
      // Adaptive models get a flat streaming-safe allowance: on Fable/Opus 5
      // thinking runs even without an effort selection, so a 4k cap would
      // starve the visible answer.
      const maxTokens = modelCapabilities.adaptiveThinking
        ? Math.min(modelCapabilities.maxOutputTokens, 64_000)
        : thinking?.type === "enabled"
          ? Math.min(
              modelCapabilities.maxOutputTokens,
              thinking.budget_tokens + 4_096
            )
          : Math.min(4_096, modelCapabilities.maxOutputTokens)
      // Normalize UI short IDs (`opus-4-7`) to canonical API slugs before the
      // SDK call — Anthropic rejects the short form server-side.

      const messages: MessageParam[] = [
        ...this.decodeHistory(input.history),
        { role: "user", content: buildClaudeUserContent(input) },
      ]

      const maxTurns = getMaxTurnsForMode(mode)
      let cumInput = 0
      let cumOutput = 0
      let cumCacheCreate = 0
      let cumCacheRead = 0
      let receivedFinalAnswer = false
      // Rolling prompt-cache breakpoint for the agentic loop (see below). Typed
      // structurally because only tool_result blocks (which accept
      // cache_control) are ever marked.
      let cachedToolResultBlock: CacheableContentBlock | null = null

      // Agentic loop: stream a turn, then either finish (no tool_use blocks) or
      // gate + execute the tools and feed `tool_result` blocks back as a user
      // message before looping again.
      for (let turn = 0; turn < maxTurns; turn++) {
        if (controller.signal.aborted) break

        const stream = await client.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            ...(systemBlocks ? { system: systemBlocks } : {}),
            messages,
            ...(tools.length > 0 ? { tools } : {}),
            ...(thinking ? { thinking } : {}),
            ...(adaptiveEffort
              ? { output_config: { effort: adaptiveEffort } }
              : {}),
          },
          { signal: controller.signal }
        )

        stream.on("text", (delta: string) => {
          if (delta) {
            this.emit({
              event_type: "content_delta",
              thread_id: input.thread_id,
              payload: { delta },
            })
          }
        })
        stream.on("contentBlock", (block) => {
          if (block.type === "thinking") {
            this.emit({
              event_type: "reasoning_replace",
              thread_id: input.thread_id,
              payload: { text: block.thinking ?? "" },
            })
          }
        })
        stream.on("streamEvent", (event) => {
          if (event.type !== "content_block_delta") return
          const delta =
            (event.delta as unknown as Record<string, unknown>) ?? {}
          if (
            delta.type === "thinking_delta" &&
            typeof delta.thinking === "string" &&
            delta.thinking
          ) {
            this.emit({
              event_type: "reasoning_delta",
              thread_id: input.thread_id,
              payload: { delta: delta.thinking },
            })
          }
        })

        const final = await stream.finalMessage()

        if (final.usage) {
          const u = final.usage as unknown as {
            input_tokens?: number
            output_tokens?: number
            cache_creation_input_tokens?: number | null
            cache_read_input_tokens?: number | null
          }
          cumInput += u.input_tokens ?? 0
          cumOutput += u.output_tokens ?? 0
          cumCacheCreate += u.cache_creation_input_tokens ?? 0
          cumCacheRead += u.cache_read_input_tokens ?? 0
          this.emit({
            event_type: "token_usage",
            thread_id: input.thread_id,
            payload: {
              usage: {
                inputTokens: cumInput,
                outputTokens: cumOutput,
                usedTokens:
                  cumInput + cumOutput + cumCacheCreate + cumCacheRead,
                cacheCreationTokens: cumCacheCreate,
                cacheReadTokens: cumCacheRead,
              },
            },
          })
        }

        if (controller.signal.aborted) break

        // Echo the model's content blocks verbatim back into the conversation
        // (text + tool_use + thinking, preserving signatures) and collect the
        // tool_use blocks to execute.
        const assistantContent: ContentBlockParam[] = []
        const toolUses: Array<{ id: string; name: string; input: unknown }> = []
        for (const block of final.content ?? []) {
          if (block.type === "text") {
            assistantContent.push({ type: "text", text: block.text })
          } else if (block.type === "thinking") {
            assistantContent.push({
              type: "thinking",
              thinking: block.thinking,
              signature: block.signature,
            })
          } else if (block.type === "redacted_thinking") {
            assistantContent.push({
              type: "redacted_thinking",
              data: block.data,
            })
          } else if (block.type === "tool_use") {
            assistantContent.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            })
            toolUses.push({
              id: block.id,
              name: block.name,
              input: block.input ?? {},
            })
          }
        }

        if (toolUses.length === 0) {
          receivedFinalAnswer = true
          break
        }

        messages.push({ role: "assistant", content: assistantContent })

        const toolResults: ContentBlockParam[] = []
        for (const tu of toolUses) {
          if (controller.signal.aborted) break
          this.emit({
            event_type: "tool_call",
            thread_id: input.thread_id,
            payload: { tool_id: tu.id, tool_name: tu.name, input: tu.input },
          })

          const gate = await gateToolCall({
            emit: (event) => this.emit(event),
            providerKind: "anthropic",
            threadId: input.thread_id,
            level,
            mode,
            toolName: tu.name,
            input: tu.input,
            projectPermissionRules: projectToolPolicy.permissionRules,
          })

          let output: string
          let toolError: string | undefined
          let toolStatus: "cancelled" | "timed_out" | undefined
          let mutation: ToolMutationArtifact | undefined
          if (!gate.allow) {
            toolError = gate.reason ?? "Permission denied."
            output = `Tool call blocked: ${toolError}`
            this.emit({
              event_type: "tool.denied",
              thread_id: input.thread_id,
              payload: {
                toolUseId: tu.id,
                toolName: tu.name,
                reason: toolError,
              },
            })
          } else {
            const res = mcpSession?.has(tu.name)
              ? await mcpSession.execute(tu.name, tu.input, {
                  signal: controller.signal,
                  limits,
                })
              : await executeTool(tu.name, tu.input, {
                  cwd,
                  toolId: tu.id,
                  limits,
                  signal: controller.signal,
                  timeoutMs: DIRECT_TOOL_TIMEOUT_MS,
                })
            output = res.output
            toolError = res.error
            toolStatus = res.status
            mutation = res.mutation
          }

          if (mutation) {
            this.emit({
              event_type: "turn.diff.updated",
              thread_id: input.thread_id,
              payload: {
                unifiedDiff: mutation.unifiedDiff,
                files: [
                  {
                    path: mutation.path,
                    additions: mutation.additions,
                    deletions: mutation.deletions,
                  },
                ],
                edits: [
                  {
                    path: mutation.path,
                    operation: mutation.operation,
                    preimageHash: mutation.preimageHash,
                    resultHash: mutation.resultHash,
                    patchComplete: mutation.patchComplete,
                  },
                ],
              },
            })
          }

          this.emit({
            event_type: "tool_result",
            thread_id: input.thread_id,
            payload: {
              tool_id: tu.id,
              tool_name: tu.name,
              output,
              ...(toolError ? { error: toolError } : {}),
              ...(toolStatus ? { status: toolStatus } : {}),
            },
          })
          toolResults.push(
            toolError
              ? {
                  type: "tool_result",
                  tool_use_id: tu.id,
                  content: output,
                  is_error: true,
                }
              : { type: "tool_result", tool_use_id: tu.id, content: output }
          )
        }
        messages.push({ role: "user", content: toolResults })

        // Advance the ephemeral cache breakpoint onto the newest tool_result so
        // the next iteration reads the growing assistant+tool_result prefix from
        // cache instead of re-billing it as fresh input (otherwise an N-tool
        // turn costs O(N^2) input tokens). Anthropic allows at most 4
        // breakpoints, so roll the single marker forward — clear it from the
        // previous tool_result before marking the current one.
        const lastToolResult = toolResults[toolResults.length - 1] as
          | CacheableContentBlock
          | undefined
        if (lastToolResult) {
          if (
            cachedToolResultBlock &&
            cachedToolResultBlock !== lastToolResult
          ) {
            delete cachedToolResultBlock.cache_control
          }
          lastToolResult.cache_control = { type: "ephemeral" }
          cachedToolResultBlock = lastToolResult
        }
      }
      if (!controller.signal.aborted && !receivedFinalAnswer) {
        throw new Error(maxTurnsExhaustedMessage(maxTurns))
      }
    } catch (err) {
      if (controller.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        { err: message, thread: input.thread_id },
        "Claude API stream failed"
      )
      throw err
    } finally {
      await mcpSession?.close()
      if (this.abortControllers.get(input.thread_id) === controller) {
        this.abortControllers.delete(input.thread_id)
      }
    }
  }

  /** Translate the wire history into Anthropic-native messages, preserving the
   *  durable tool-call history: an assistant turn with `tool_calls` becomes an
   *  assistant message whose content carries `tool_use` blocks, and consecutive
   *  `role:"tool"` entries are batched into a single user message of
   *  `tool_result` blocks (Anthropic requires tool results in a user turn). */
  private decodeHistory(
    history: ProviderSendTurnInput["history"]
  ): MessageParam[] {
    const out: MessageParam[] = []
    let pendingToolResults: ContentBlockParam[] = []
    const flush = () => {
      if (pendingToolResults.length > 0) {
        out.push({ role: "user", content: pendingToolResults })
        pendingToolResults = []
      }
    }

    for (const h of history) {
      if (h.role === "tool" && h.tool_call_id) {
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: h.tool_call_id,
          content: h.content,
        })
        continue
      }
      flush()
      if (h.role === "assistant" && h.tool_calls?.length) {
        const blocks: ContentBlockParam[] = []
        if (h.content) blocks.push({ type: "text", text: h.content })
        for (const tc of h.tool_calls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: (tc.input ?? {}) as Record<string, unknown>,
          })
        }
        out.push({ role: "assistant", content: blocks })
      } else if (h.role === "assistant") {
        out.push({ role: "assistant", content: h.content })
      } else {
        out.push({ role: "user", content: h.content })
      }
    }
    flush()
    return out
  }
}

/**
 * Claude's `thinking.budget_tokens` controls how many tokens the model can
 * spend reasoning internally. The renderer passes the same abstract effort
 * knob it uses for OpenAI o-series models (`low`/`medium`/`high`/`ultrathink`);
 * we map it to concrete budgets calibrated so `high` is the default useful
 * ceiling and `ultrathink` unlocks a roughly 3x budget.
 */
function mapReasoningToThinkingBudget(
  effort: string | null | undefined
): number {
  if (!effort) return 0
  switch (effort.toLowerCase()) {
    case "low":
      return 2_000
    case "medium":
      return 8_000
    case "high":
      return 16_000
    case "xhigh":
      return 32_000
    case "max":
    case "ultrathink":
    case "ultra think":
      return 48_000
    default:
      return 0
  }
}

interface AnthropicModelCapabilities {
  readonly maxOutputTokens: number
  readonly manualThinking: boolean
  /** 4.7+ generation incl. Fable/Mythos: thinking is adaptive-only — depth is
   *  steered with `output_config.effort`, and `budget_tokens` returns a 400. */
  readonly adaptiveThinking: boolean
}

function anthropicModelCapabilities(
  modelId: string
): AnthropicModelCapabilities {
  const model = modelId.trim().toLowerCase()
  const identity = parseAnthropicModelId(model)

  // Genuinely unknown/custom ids stay usable but get a safe baseline: no
  // manual-thinking payload the endpoint might reject, and a modest output
  // allowance. Recognised Anthropic models never fall through to this.
  if (!identity)
    return {
      maxOutputTokens: 4_096,
      manualThinking: false,
      adaptiveThinking: false,
    }

  // The 4.7 generation onward is adaptive-thinking only and rejects a manual
  // budget_tokens. Derived from the generation so a new release is covered
  // the day it appears rather than falling into the baseline above.
  if (anthropicRequiresExplicitThinkingDisplay(model)) {
    return {
      maxOutputTokens: 128_000,
      manualThinking: false,
      adaptiveThinking: true,
    }
  }
  if (
    identity.family === "opus" &&
    identity.version !== null &&
    identity.version >= 4.6
  ) {
    return {
      maxOutputTokens: 128_000,
      manualThinking: true,
      adaptiveThinking: false,
    }
  }
  return {
    maxOutputTokens: 64_000,
    manualThinking: true,
    adaptiveThinking: false,
  }
}

/** Maps the renderer's abstract reasoning knob to the adaptive-era
 *  `output_config.effort` ladder. `null` means the user chose no reasoning —
 *  on Opus 4.7/4.8 omitting `thinking` really is off; on Fable/Opus 5/Sonnet 5
 *  the model then runs its adaptive default (it cannot be disabled). */
function mapReasoningToAdaptiveEffort(
  effort: string | null | undefined
): "low" | "medium" | "high" | "xhigh" | "max" | null {
  if (!effort) return null
  switch (effort.toLowerCase().replace(/[\s_-]+/g, "")) {
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
      return "high"
    case "xhigh":
    case "extrahigh":
      return "xhigh"
    case "max":
    case "ultra":
    case "ultrathink":
      return "max"
    default:
      return null
  }
}
