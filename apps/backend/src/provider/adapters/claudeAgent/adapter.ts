import type {
  ModelDefinition,
  ProviderKind,
  ProviderSendTurnInput,
} from "../../types"
import { logger } from "../../../observability/logger"
import { cancelPendingApprovals, normalizeLevel } from "../../permissions"
import { getThinkingOptions, type SdkQuery } from "./sdk-types"
import { loadClaudeSdk } from "./session-manager"
import { buildCanUseTool } from "./tool-approval-handler"
import { processClaudeSdkMessage } from "./message-translator"
import { normalizeAnthropicModelId } from "../anthropicModelIds"
import { BaseProviderAdapter } from "../baseAdapter"
import {
  createClaudePreToolUseApprovalHook,
  getToolsForMode,
  getMaxTurnsForMode,
} from "../../shared/chat-mode-tools"
import {
  filterToolsForBetterC0deProjectPolicy,
  type ProjectToolFlag,
} from "../../project-tool-policy"
import type { ProjectPermissionRule } from "../../project-permission-rules"
import {
  listProjectPermissions,
  listProjectTools,
} from "../../../services/workspace"

/**
 * Claude provider backed by `@anthropic-ai/claude-agent-sdk`. Mirrors the
 * pattern already used in `electron/claude-provider.cjs`: dynamic import of
 * the SDK (so the hot-path start-up cost is paid lazily on first use), a
 * `Map<threadId, Query>` for per-thread runtimes, and translation of every
 * SDK message into the event_type strings the renderer already handles.
 *
 * This adapter registers as `ProviderKind = "anthropic_cli"` — distinct from
 * `ClaudeApiAdapter` which uses a raw API key. Auth is sourced from the user's
 * `~/.claude` login, so users without an API key can still chat if they've run
 * `claude auth login`.
 */
export class ClaudeAgentAdapter extends BaseProviderAdapter {
  private sessions = new Map<string, SdkQuery>()
  private abortFlags = new Map<string, boolean>()

  protected _activeSessionIds(): string[] {
    return Array.from(
      new Set([...this.sessions.keys(), ...this.abortFlags.keys()])
    )
  }

  providerKind(): ProviderKind {
    return "anthropic_cli"
  }
  displayName(): string {
    return "Claude (CLI)"
  }

  // CLI inventories are exposed by the runtime provider snapshots.
  availableModels(): ModelDefinition[] {
    return []
  }
  isConfigured(): boolean {
    // Installation and authentication are established by the bounded async
    // provider-status pipeline. Turn admission must stay process- and I/O-free;
    // SDK initialization remains the final authoritative check.
    return true
  }
  authMeta(): { authType: string; hint?: string } {
    return {
      authType: "cli",
      hint: "Claude CLI not installed or not signed in — run `claude auth login` in a terminal.",
    }
  }

  async interrupt(threadId: string): Promise<void> {
    if (this.abortFlags.has(threadId)) this.abortFlags.set(threadId, true)
    const session = this.sessions.get(threadId)
    if (!session) return
    this.abortFlags.set(threadId, true)
    try {
      if (typeof session.interrupt === "function") {
        await session.interrupt()
      } else if (typeof session.close === "function") {
        await session.close()
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, thread: threadId },
        "Claude Agent interrupt failed"
      )
      throw err
    }
    this.sessions.delete(threadId)
    // Release any awaiting permission gates so the SDK promise doesn't hang
    // after the user stops the turn.
    cancelPendingApprovals(threadId)
  }

  async sendMessage(input: ProviderSendTurnInput): Promise<void> {
    if (this.abortFlags.has(input.thread_id))
      throw new Error("Claude Agent turn is already active")
    this.abortFlags.set(input.thread_id, false)
    try {
      const sdk = await loadClaudeSdk()
      if (this.abortFlags.get(input.thread_id)) return
      if (!sdk) {
        throw new Error(
          "@anthropic-ai/claude-agent-sdk is not installed or not resolvable from node-backend"
        )
      }

      // Close any existing session for this thread first — the SDK session
      // represents one logical conversation; sending a new message on top of
      // a still-running one would interleave stream events.
      const existing = this.sessions.get(input.thread_id)
      if (existing?.close) {
        await existing.close()
      }
      if (this.abortFlags.get(input.thread_id)) return

      const level = normalizeLevel(input.permission_level)
      const chatMode = input.chat_mode ?? null
      const projectToolPolicy = await loadBetterC0deProjectToolPolicy(
        input.project_path
      )
      if (this.abortFlags.get(input.thread_id)) return
      const canUseTool = buildCanUseTool(
        input.thread_id,
        level,
        (e) => this.emit(e),
        chatMode,
        {
          projectPermissionRules: projectToolPolicy.permissionRules,
        }
      )
      const tools = filterToolsForBetterC0deProjectPolicy(
        getToolsForMode(chatMode),
        {
          toolFlags: projectToolPolicy.toolFlags,
          permissionRules: projectToolPolicy.permissionRules,
        }
      )

      // Normalize UI short IDs (`opus-4-7`) to the canonical API slug
      // (`claude-opus-4-7`) before handing to the SDK — without this the
      // SDK's validate_model step throws "opus-4-7 may not exist" on pick.
      const apiModelId = normalizeAnthropicModelId(input.model_id)

      // The shell process resolves the Claude Code native binary against
      // `process.resourcesPath/app.asar.unpacked/...` (see
      // `apps/shell/shared/claude-binary-path.cjs`) and forwards the path here
      // via env. The SDK's own resolver returns a path inside `app.asar`,
      // which `child_process.spawn` cannot exec.
      const claudeCodeBinaryPath = process.env.BETTERC0DE_CLAUDE_CODE_PATH
      const runtime = sdk.query({
        prompt: input.message,
        options: {
          ...(apiModelId ? { model: apiModelId } : {}),
          ...(input.project_path ? { cwd: input.project_path } : {}),
          ...(claudeCodeBinaryPath
            ? { pathToClaudeCodeExecutable: claudeCodeBinaryPath }
            : {}),
          ...getThinkingOptions(input.reasoning_effort, input.model_id ?? ""),
          includePartialMessages: true,
          maxTurns: getMaxTurnsForMode(chatMode),
          tools,
          hooks: {
            PreToolUse: [{ hooks: [createClaudePreToolUseApprovalHook()] }],
          },
          canUseTool,
        },
      })
      this.sessions.set(input.thread_id, runtime)

      try {
        for await (const rawMsg of runtime) {
          if (this.abortFlags.get(input.thread_id)) break
          if (process.env.BETTERC0DE_TRACE_PROVIDER_EVENTS === "1") {
            // [REASON-TRACE:CLAUDE-SDK-IN]
            const _r = rawMsg as {
              type?: string
              subtype?: string
              event?: { delta?: { type?: string } }
            }
            console.log(
              `[REASON-TRACE:CLAUDE-SDK-IN] type=${_r?.type ?? "-"} subtype=${_r?.subtype ?? "-"} hasEvent=${!!_r?.event} eventDeltaType=${_r?.event?.delta?.type ?? "-"} keys=${rawMsg && typeof rawMsg === "object" ? Object.keys(rawMsg).join(",") : "-"}`
            )
          }
          const terminalFailure = processClaudeSdkMessage(
            input.thread_id,
            rawMsg,
            (e) => this.emit(e)
          )
          if (terminalFailure) throw new Error(terminalFailure)
        }
      } finally {
        this.sessions.delete(input.thread_id)
        this.abortFlags.delete(input.thread_id)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        { err: message, thread: input.thread_id },
        "Claude Agent stream failed"
      )
      throw err
    } finally {
      this.abortFlags.delete(input.thread_id)
    }
  }
}

async function loadBetterC0deProjectToolPolicy(
  cwd: string | null | undefined
): Promise<{
  readonly toolFlags: readonly ProjectToolFlag[]
  readonly permissionRules: readonly ProjectPermissionRule[]
}> {
  if (!cwd?.trim()) return { toolFlags: [], permissionRules: [] }
  const [toolFlags, permissionRules] = await Promise.all([
    listProjectTools(cwd),
    listProjectPermissions(cwd),
  ])
  return { toolFlags, permissionRules }
}
