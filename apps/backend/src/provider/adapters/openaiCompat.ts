import OpenAI from "openai"
import { ApiModelCatalog } from "./apiModelCatalog"
import { randomUUID } from "node:crypto"
import type {
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions"
import type {
  ModelDefinition,
  ProviderKind,
  ProviderSendTurnInput,
} from "../types"
import { logger } from "../../observability/logger"
import { cancelPendingApprovals, normalizeLevel } from "../permissions"
import { probeLmStudioBaseUrl } from "../../constants"
import { BaseProviderAdapter } from "./baseAdapter"
import {
  buildUnsupportedAttachmentNotice,
  imageAttachments,
} from "../attachments"
import {
  getMaxTurnsForMode,
  getToolsForMode,
  maxTurnsExhaustedMessage,
} from "../shared/chat-mode-tools"
import {
  DIRECT_TOOL_TIMEOUT_MS,
  toOpenAiTools,
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
  directMcpToolsForOpenAi,
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

export interface OpenAiCompatConfig {
  providerKind: ProviderKind
  displayName: string
  baseUrl?: string
  defaultModels: ModelDefinition[]
}

function buildOpenAiUserContent(
  input: ProviderSendTurnInput
): string | ChatCompletionContentPart[] {
  const images = imageAttachments(input.attachments)
  const imageUrls = new Set(images.map((attachment) => attachment.url))
  const unsupported = (input.attachments ?? []).filter(
    (attachment) => !imageUrls.has(attachment.url)
  )
  const notice = buildUnsupportedAttachmentNotice(unsupported)
  const text = notice ? `${input.message}${notice}` : input.message
  if (images.length === 0) return text
  return [
    { type: "text", text },
    ...images.map((attachment) => ({
      type: "image_url" as const,
      image_url: { url: attachment.url },
    })),
  ]
}

/**
 * Shared adapter for any OpenAI-Chat-Completions-compatible endpoint:
 *   - OpenAI proper
 *   - xAI Grok (baseURL = https://api.x.ai/v1)
 *   - OpenRouter (baseURL = https://openrouter.ai/api/v1)
 *   - LM Studio (baseURL = http://localhost:1234/v1, no auth)
 *
 * Replaces the per-provider SSE-parsing loops in the Rust adapters with one
 * code path. Tool calls are accumulated across `delta.tool_calls` chunks and
 * flushed on finish_reason === "tool_calls".
 */
/**
 * Maps the renderer's abstract reasoning knob to the OpenAI-compatible
 * `reasoning_effort` param. xAI's Grok ladder includes "xhigh" (grok-4.6);
 * OpenAI and xAI accept extended levels on models that advertise them.
 * `null` means the user chose no reasoning — the param is omitted entirely.
 */
function mapCompatReasoningEffort(
  effort: string | null | undefined,
  providerKind: string
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null {
  if (!effort) return null
  const key = effort.toLowerCase().replace(/[\s_-]+/g, "")
  if (key === "none" || key === "noreasoning")
    return providerKind === "openai" ? "none" : null
  if (key === "off") return null
  if (key === "minimal") return "minimal"
  if (key === "low" || key === "medium" || key === "high") return key
  if (key === "xhigh" || key === "extrahigh")
    return providerKind === "openai" || providerKind === "grok"
      ? "xhigh"
      : "high"
  if (key === "max" || key === "ultra" || key === "ultrathink")
    return providerKind === "openai"
      ? "max"
      : providerKind === "grok"
        ? "xhigh"
        : "high"
  return null
}

/** Heuristic sibling of {@link isToolsUnsupportedError}: the endpoint rejected
 *  `reasoning_effort` (non-reasoning model, older server). Falls back to a
 *  request without the param instead of failing the turn. */
function isReasoningUnsupportedError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  if (
    typeof status === "number" &&
    status !== 400 &&
    status !== 404 &&
    status !== 422 &&
    status !== 500
  ) {
    return false
  }
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase()
  return message.includes("reasoning")
}

/** Heuristic: did an OpenAI-compatible endpoint reject the request because it
 *  doesn't support the `tools` param? Used to fall back to plain chat. */
function isToolsUnsupportedError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  if (
    typeof status === "number" &&
    status !== 400 &&
    status !== 404 &&
    status !== 422 &&
    status !== 500
  ) {
    return false
  }
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase()
  return (
    message.includes("tool") ||
    message.includes("function call") ||
    message.includes("does not support") ||
    message.includes("not supported")
  )
}

export class OpenAiCompatAdapter extends BaseProviderAdapter {
  private client: OpenAI | null = null
  private apiKey: string | null = null
  private forceCatalogRefresh = false
  private readonly abortControllers = new Map<string, AbortController>()
  // Tracks the baseURL currently bound to `this.client`. For LM Studio this
  // can differ from `config.baseUrl` after the per-request probe finds the
  // server on an alternate port (1111 vs 1234, 127.0.0.1 vs localhost).
  private activeBaseUrl: string | undefined

  constructor(
    private readonly config: OpenAiCompatConfig,
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
   * Rebuild the OpenAI-compatible client when the user adds/changes/clears
   * the API key in settings. Without this swap the live adapter would
   * keep the constructor-time client (typically `null` on a fresh install)
   * and `isConfigured()` would keep lying until the app restarted.
   *
   * The lmstudio kind is special-cased: it has no auth, so a `null` key
   * still produces a working client pointed at the local server.
   */
  setApiKey(apiKey: string | null): void {
    if (this.apiKey !== apiKey) this.forceCatalogRefresh = true
    this.apiKey = apiKey
    if (apiKey || this.config.providerKind === "lmstudio") {
      this.client = new OpenAI({
        apiKey: apiKey ?? "lm-studio",
        baseURL: this.config.baseUrl,
      })
      this.activeBaseUrl = this.config.baseUrl
    } else {
      this.client = null
      this.activeBaseUrl = undefined
    }
  }

  providerKind(): ProviderKind {
    return this.config.providerKind
  }
  displayName(): string {
    return this.config.displayName
  }
  availableModels(): ModelDefinition[] {
    return this.config.defaultModels
  }
  async discoverModels(force = false): Promise<ModelDefinition[]> {
    const kind = this.config.providerKind
    if (kind !== "openai" && kind !== "grok") return this.availableModels()
    const refresh = force || this.forceCatalogRefresh
    this.forceCatalogRefresh = false
    return this.modelCatalog.list(kind, this.apiKey, refresh)
  }
  isConfigured(): boolean {
    return this.client !== null
  }
  authMeta(): { authType: string; hint?: string } {
    if (this.config.providerKind === "lmstudio") {
      return {
        authType: "local-server",
        hint: "LM Studio not reachable — start the local server (port 1234 or 1111).",
      }
    }
    return {
      authType: "api-key",
      hint: `Not set up — add a ${this.config.displayName} API key in Settings.`,
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const controller = this.abortControllers.get(threadId)
    controller?.abort()
    cancelPendingApprovals(threadId)
  }

  async sendMessage(input: ProviderSendTurnInput): Promise<void> {
    // A settings change applies to subsequent turns, preserving this turn's account.
    let client = this.client
    if (!client) {
      throw new Error(`${this.config.displayName} not configured`)
    }
    const controller = new AbortController()
    this.abortControllers.set(input.thread_id, controller)
    let mcpSession: DirectMcpToolSession | null = null

    try {
      // Register cancellation before probing, so Stop during a slow probe cannot
      // start a model turn after the probe completes.
      if (this.config.providerKind === "lmstudio") {
        const probed = await probeLmStudioBaseUrl()
        if (controller.signal.aborted) return
        if (probed && probed !== this.activeBaseUrl) {
          this.activeBaseUrl = probed
          client = new OpenAI({ apiKey: "lm-studio", baseURL: probed })
          this.client = client
        }
      }
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
        ...toOpenAiTools(
          filterToolsForBetterC0deProjectPolicy(getToolsForMode(mode), {
            toolFlags: projectToolPolicy.toolFlags,
            permissionRules: projectToolPolicy.permissionRules,
          })
        ),
        ...(mcpSession ? directMcpToolsForOpenAi(mcpSession) : []),
      ] as ChatCompletionTool[]
      const limits = cwd.trim()
        ? await getProjectToolOutputLimits(cwd).catch(() => ({
            maxLines: 2000,
            maxBytes: 50 * 1024,
          }))
        : { maxLines: 2000, maxBytes: 50 * 1024 }

      const messages: ChatCompletionMessageParam[] = [
        ...(input.system_instruction
          ? [{ role: "system" as const, content: input.system_instruction }]
          : []),
        ...this.decodeHistory(input.history),
        { role: "user", content: buildOpenAiUserContent(input) },
      ]

      const maxTurns = getMaxTurnsForMode(mode)
      let cumInput = 0
      let cumOutput = 0
      let receivedFinalAnswer = false
      // Some OpenAI-compatible endpoints (notably small local LM Studio models)
      // reject the `tools` param outright. If that happens on the first turn we
      // disable tools and retry as plain chat instead of failing the turn.
      let toolsEnabled = tools.length > 0
      // Same fallback shape for `reasoning_effort`: pass the user's selection
      // through (Grok 4.x, GPT-5.x reasoning models honour it), and drop it on
      // a first-turn rejection from endpoints that don't know the param.
      const reasoningEffort = mapCompatReasoningEffort(
        input.reasoning_effort,
        this.config.providerKind
      )
      let reasoningEnabled = reasoningEffort !== null

      const requestParams = () => ({
        model: input.model_id,
        stream: true as const,
        stream_options: { include_usage: true },
        messages,
        ...(toolsEnabled ? { tools, tool_choice: "auto" as const } : {}),
        ...(reasoningEnabled && reasoningEffort
          ? { reasoning_effort: reasoningEffort }
          : {}),
      })

      // Agentic loop: each iteration is one model turn. The model may answer
      // (no tool calls → done) or request tools, which we gate, execute, and
      // feed back as `role:"tool"` messages before looping again.
      for (let turn = 0; turn < maxTurns; turn++) {
        if (controller.signal.aborted) break

        let stream: AsyncIterable<ChatCompletionChunk>
        try {
          stream = await client.chat.completions.create(requestParams(), {
            signal: controller.signal,
          })
        } catch (err) {
          if (
            turn === 0 &&
            reasoningEnabled &&
            isReasoningUnsupportedError(err)
          ) {
            logger.warn(
              { provider: this.config.providerKind },
              "Model rejected reasoning_effort; retrying without it"
            )
            reasoningEnabled = false
            stream = await client.chat.completions.create(requestParams(), {
              signal: controller.signal,
            })
          } else if (
            turn === 0 &&
            toolsEnabled &&
            isToolsUnsupportedError(err)
          ) {
            logger.warn(
              { provider: this.config.providerKind },
              "Model rejected the tools param; retrying as plain chat"
            )
            toolsEnabled = false
            stream = await client.chat.completions.create(requestParams(), {
              signal: controller.signal,
            })
          } else {
            throw err
          }
        }

        const { text, toolCalls, usage } = await this.consumeStream(
          stream,
          input.thread_id,
          controller
        )

        if (usage && usage.inputTokens + usage.outputTokens > 0) {
          cumInput += usage.inputTokens
          cumOutput += usage.outputTokens
          this.emit({
            event_type: "token_usage",
            thread_id: input.thread_id,
            payload: {
              usage: {
                inputTokens: cumInput,
                outputTokens: cumOutput,
                usedTokens: cumInput + cumOutput,
              },
            },
          })
        }

        if (controller.signal.aborted) break
        if (toolCalls.length === 0) {
          receivedFinalAnswer = true
          break
        }

        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.argsRaw || "{}" },
          })),
        })

        for (const call of toolCalls) {
          if (controller.signal.aborted) break
          let parsedInput: unknown = {}
          try {
            parsedInput = call.argsRaw ? JSON.parse(call.argsRaw) : {}
          } catch {
            logger.warn(
              { tool: call.name },
              "Malformed tool arguments JSON; falling back to {}"
            )
          }

          this.emit({
            event_type: "tool_call",
            thread_id: input.thread_id,
            payload: {
              tool_id: call.id,
              tool_name: call.name,
              input: parsedInput,
            },
          })

          const gate = await gateToolCall({
            emit: (event) => this.emit(event),
            providerKind: this.config.providerKind,
            threadId: input.thread_id,
            level,
            mode,
            toolName: call.name,
            input: parsedInput,
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
                toolUseId: call.id,
                toolName: call.name,
                reason: toolError,
              },
            })
          } else {
            const res = mcpSession?.has(call.name)
              ? await mcpSession.execute(call.name, parsedInput, {
                  signal: controller.signal,
                  limits,
                })
              : await executeTool(call.name, parsedInput, {
                  cwd,
                  toolId: call.id,
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
              tool_id: call.id,
              tool_name: call.name,
              output,
              ...(toolError ? { error: toolError } : {}),
              ...(toolStatus ? { status: toolStatus } : {}),
            },
          })
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: output,
          })
        }
      }
      if (!controller.signal.aborted && !receivedFinalAnswer) {
        throw new Error(maxTurnsExhaustedMessage(maxTurns))
      }
    } catch (err) {
      if (controller.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        {
          err: message,
          thread: input.thread_id,
          provider: this.config.providerKind,
        },
        "OpenAI-compat stream failed"
      )
      throw err
    } finally {
      await mcpSession?.close()
      if (this.abortControllers.get(input.thread_id) === controller) {
        this.abortControllers.delete(input.thread_id)
      }
    }
  }

  /** Translate the wire history into OpenAI-native messages, preserving the
   *  durable tool-call history: an assistant turn with `tool_calls` becomes an
   *  assistant message carrying those calls, and each `role:"tool"` entry
   *  becomes a `tool` message keyed by `tool_call_id`. */
  private decodeHistory(
    history: ProviderSendTurnInput["history"]
  ): ChatCompletionMessageParam[] {
    const out: ChatCompletionMessageParam[] = []
    for (const h of history) {
      if (h.role === "tool" && h.tool_call_id) {
        out.push({
          role: "tool",
          tool_call_id: h.tool_call_id,
          content: h.content,
        })
      } else if (h.role === "assistant" && h.tool_calls?.length) {
        out.push({
          role: "assistant",
          content: h.content || null,
          tool_calls: h.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input ?? {}),
            },
          })),
        })
      } else if (h.role === "assistant") {
        out.push({ role: "assistant", content: h.content })
      } else {
        out.push({ role: "user", content: h.content })
      }
    }
    return out
  }

  /** Consume one streamed completion: emit content/reasoning deltas, accumulate
   *  the assistant text + any tool calls, and return the per-turn usage. Does
   *  not emit `token_usage` — the loop emits cumulative totals. */
  private async consumeStream(
    stream: AsyncIterable<ChatCompletionChunk>,
    threadId: string,
    controller: AbortController
  ): Promise<{
    text: string
    toolCalls: Array<{ id: string; name: string; argsRaw: string }>
    usage: { inputTokens: number; outputTokens: number } | null
  }> {
    let text = ""
    let usage: { inputTokens: number; outputTokens: number } | null = null
    const pending = new Map<
      number,
      { id: string; name: string; args: string }
    >()

    for await (const chunk of stream) {
      if (controller.signal.aborted) break
      const choice = chunk.choices?.[0]
      const delta = choice?.delta

      if (delta?.content) {
        text += delta.content
        this.emit({
          event_type: "content_delta",
          thread_id: threadId,
          payload: { delta: delta.content },
        })
      }

      const reasoning =
        (delta as unknown as { reasoning?: string; reasoning_content?: string })
          ?.reasoning ??
        (delta as unknown as { reasoning?: string; reasoning_content?: string })
          ?.reasoning_content
      if (reasoning) {
        this.emit({
          event_type: "reasoning_delta",
          thread_id: threadId,
          payload: { delta: reasoning },
        })
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (idx === undefined) continue
          const entry = pending.get(idx) ?? { id: "", name: "", args: "" }
          if (tc.id) entry.id = tc.id
          if (tc.function?.name) entry.name = tc.function.name
          if (tc.function?.arguments) entry.args += tc.function.arguments
          pending.set(idx, entry)
        }
      }

      const u = (
        chunk as unknown as {
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
      ).usage
      if (u) {
        usage = {
          inputTokens: u.prompt_tokens ?? 0,
          outputTokens: u.completion_tokens ?? 0,
        }
      }
    }

    const toolCalls = [...pending.values()]
      .filter((e) => e.name)
      .map((e) => ({
        id: e.id || `call_${randomUUID()}`,
        name: e.name,
        argsRaw: e.args,
      }))
    return { text, toolCalls, usage }
  }
}
