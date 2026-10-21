import { type ChatSendBody } from "@betterc0de/schema"
import { randomUUID } from "node:crypto"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import type { ThreadActivityProjectionQuery } from "../../persistence/projections"
import type { ProviderSessionBindingStore } from "../../provider/runtime/ProviderSessionBindingStore"
import type { ThreadTurnCoordinator } from "../../provider/threadTurnCoordinator"
import type { ThreadService } from "../threads"
import { logger } from "../../observability/logger"
import { commitContextCheckpoint } from "./context-checkpoint"
import {
  autoCompactionContextSnapshot,
  buildAutoCompactionTranscript,
  decideAutoCompaction,
  estimateIncomingTokens,
  resolveAutoCompactionConfig,
  type AutoCompactionDecision,
} from "../auto-compaction"
import { listProjectConfigSettings } from "../workspace"

interface ContextWindowUsageSnapshot {
  readonly usedTokens?: number
  readonly maxTokens?: number
  readonly compactsAutomatically?: boolean
  readonly createdAt: string
}

function contextWindowUsageFromActivity(
  activity: {
    readonly kind: string
    readonly payload: unknown
    readonly created_at: string
  } | null
): ContextWindowUsageSnapshot | null {
  if (!activity || activity.kind !== "context-window.updated") return null
  const payload = recordValue(activity.payload)
  const nestedUsage = recordValue(payload.usage)
  const usage = Object.keys(nestedUsage).length > 0 ? nestedUsage : payload
  return {
    usedTokens: nonnegativePayloadInteger(
      usage,
      "usedTokens",
      "used_tokens",
      "totalTokens",
      "total_tokens"
    ),
    maxTokens: positivePayloadInteger(usage, "maxTokens", "max_tokens"),
    compactsAutomatically:
      typeof usage.compactsAutomatically === "boolean"
        ? usage.compactsAutomatically
        : typeof usage.compacts_automatically === "boolean"
          ? usage.compacts_automatically
          : undefined,
    createdAt: activity.created_at,
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function nonnegativePayloadInteger(
  payload: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      return value
    }
  }
  return undefined
}

function positivePayloadInteger(
  payload: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  const value = nonnegativePayloadInteger(payload, ...keys)
  return value && value > 0 ? value : undefined
}

function maximumDefined(
  ...values: ReadonlyArray<number | null | undefined>
): number | undefined {
  const defined = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  )
  return defined.length > 0 ? Math.max(...defined) : undefined
}

interface AutoCompactionDecisionRequest {
  readonly threadId: string
  readonly cwd: string | null
  readonly incomingContent: string
  readonly usage?: {
    readonly usedTokens?: number
    readonly maxTokens?: number
    readonly compactsAutomatically?: boolean
  } | null
  readonly modelLimits?: {
    readonly contextTokens?: number
    readonly inputTokens?: number
    readonly outputTokens?: number
  } | null
  readonly excludeMessageId?: string | null
  readonly ignoreCoordinatorOwner?: boolean
  readonly trustClientNativeCompactionHint?: boolean
}

interface ServerAutomaticCompaction {
  readonly reason: "threshold-reached"
  readonly commandMessageId: string
  readonly commandContent: string
  readonly commandCreatedAt: string
  readonly checkpointMessageId: string
  readonly checkpointContent: string
  readonly checkpointCreatedAt: string
  readonly generation: number
}

/**
 * What the compaction preflight reads: the durable transcript, the last
 * context-window report, and whether a turn owns the thread.
 */
export interface AutoCompactionDecisionState {
  readonly threads: Pick<ThreadService, "listMessages">
  readonly threadActivities: Pick<
    ThreadActivityProjectionQuery,
    "latestByThreadKind"
  >
  readonly providerSessionBindings: Pick<ProviderSessionBindingStore, "list">
  readonly threadTurnCoordinator: Pick<ThreadTurnCoordinator, "activeOwner">
}

export async function resolveAutoCompactionDecisionForThread(
  state: AutoCompactionDecisionState,
  input: AutoCompactionDecisionRequest
): Promise<{
  readonly decision: AutoCompactionDecision
  readonly messages: ReadonlyArray<unknown>
}> {
  const messages = state.threads.listMessages(input.threadId, {
    limit: 2_000,
  })
  const context = autoCompactionContextSnapshot(messages, {
    excludeMessageId: input.excludeMessageId,
  })
  const latestUsage = contextWindowUsageFromActivity(
    state.threadActivities.latestByThreadKind(
      input.threadId,
      "context-window.updated"
    ) ?? null
  )
  const usageIsAfterBoundary =
    context.boundaryCreatedAt === null ||
    (latestUsage?.createdAt
      ? latestUsage.createdAt > context.boundaryCreatedAt
      : false)
  const clientUsageIsFresh =
    context.boundaryCreatedAt === null || context.completedTurns > 0

  let configAvailable = true
  let projectSettings: Awaited<ReturnType<typeof listProjectConfigSettings>> =
    []
  if (input.cwd) {
    try {
      projectSettings = await listProjectConfigSettings(input.cwd)
    } catch {
      // Invalid or temporarily unavailable project config must never cause a
      // summary under guessed policy.
      configAvailable = false
    }
  }

  const activeBinding = state.providerSessionBindings
    .list()
    .some(
      (binding) =>
        binding.threadId === input.threadId &&
        (Boolean(binding.activeTurnId) ||
          binding.status === "starting" ||
          binding.status === "running" ||
          binding.status === "closing")
    )
  const coordinatorActive =
    !input.ignoreCoordinatorOwner &&
    Boolean(state.threadTurnCoordinator.activeOwner(input.threadId))
  const serverUsedTokens = usageIsAfterBoundary
    ? latestUsage?.usedTokens
    : undefined
  const clientUsedTokens = clientUsageIsFresh
    ? input.usage?.usedTokens
    : undefined
  const usedTokens = maximumDefined(serverUsedTokens, clientUsedTokens)
  const maxTokens =
    latestUsage?.maxTokens ??
    input.usage?.maxTokens ??
    input.modelLimits?.contextTokens ??
    null

  return {
    messages,
    decision: decideAutoCompaction({
      config: resolveAutoCompactionConfig(projectSettings),
      configAvailable,
      turnActive: coordinatorActive || activeBinding,
      compactsAutomatically:
        (usageIsAfterBoundary && latestUsage?.compactsAutomatically === true) ||
        (input.trustClientNativeCompactionHint === true &&
          input.usage?.compactsAutomatically === true),
      usedTokens,
      estimatedTokens: context.estimatedTokens,
      incomingTokens: estimateIncomingTokens(input.incomingContent),
      maxTokens,
      modelInputTokens: input.modelLimits?.inputTokens,
      modelOutputTokens: input.modelLimits?.outputTokens,
      completedTurns: context.completedTurns,
      compactionGeneration: context.compactionGeneration,
      lastMessageId: context.lastMessageId,
    }),
  }
}

export async function compactAutomaticallyBeforeSend(
  state: AppState,
  body: ChatSendBody,
  currentMessageId: string | null
): Promise<ServerAutomaticCompaction | null> {
  // A stale projection can change while the bounded model summary is running.
  // Re-evaluate once; a second race fails explicitly instead of committing a
  // checkpoint for context that was never summarized.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolved = await resolveAutoCompactionDecisionForThread(state, {
      threadId: body.thread_id,
      cwd: body.project_path,
      incomingContent: body.message,
      usage: body.auto_compaction_usage,
      modelLimits: body.auto_compaction_model_limits,
      excludeMessageId: currentMessageId,
      // `/chat/send` already owns the thread coordinator token at this point.
      ignoreCoordinatorOwner: true,
      // Provider-native opt-out is accepted only from server-observed runtime
      // usage, never from a caller-controlled HTTP field.
      trustClientNativeCompactionHint: false,
    })
    if (!resolved.decision.shouldCompact) return null
    if (!autoSaveConversationsEnabled(state)) {
      throw new HttpError(
        409,
        "Automatic compaction requires durable conversation persistence for this thread.",
        "automatic_compaction_requires_persistence"
      )
    }

    const transcript = buildAutoCompactionTranscript({
      threadTitle: body.thread_title,
      projectPath: body.project_path,
      messages: resolved.messages,
      excludeMessageId: currentMessageId,
    })
    if (!transcript) {
      throw new HttpError(
        409,
        "Automatic compaction reached its threshold but no durable active context could be summarized.",
        "automatic_compaction_context_unavailable"
      )
    }

    let summary: string
    try {
      const generated = await state.chatHelpers.generateThreadContextSummary({
        cwd: body.project_path,
        threadTitle: body.thread_title,
        projectPath: body.project_path,
        transcript,
        modelSelection: body.model_selection,
      })
      summary = generated.summary.trim()
    } catch (error) {
      logger.error(
        {
          errorType: errorType(error),
          thread: body.thread_id,
        },
        "automatic pre-turn compaction summary failed"
      )
      throw new HttpError(
        503,
        "The conversation reached its automatic compaction threshold, but the durable summary could not be generated. The provider turn was not started.",
        "automatic_compaction_failed"
      )
    }
    if (!summary) {
      throw new HttpError(
        503,
        "The conversation reached its automatic compaction threshold, but the compacter returned an empty summary. The provider turn was not started.",
        "automatic_compaction_failed"
      )
    }

    const commandMessageId = randomUUID()
    const commandContent = "/compact --automatic"
    const commandCreatedAt = new Date().toISOString()
    const checkpointMessageId = randomUUID()
    const checkpointCreatedAt = new Date().toISOString()
    const checkpointContent = [
      "# Compacted Session Context\n",
      "The current chat was automatically summarized before the next provider turn reached the configured context limit.",
      "Native provider continuity will begin from this durable checkpoint.",
      "",
      "---",
      "",
      summary,
    ].join("\n")

    try {
      const committed = await commitContextCheckpoint(state, {
        excludeMessageId: currentMessageId,
        expected: resolved.decision.precondition,
        commit: {
          thread_id: body.thread_id,
          request_id: checkpointMessageId,
          command_message: {
            message_id: commandMessageId,
            turn_id: null,
            role: "user",
            content: commandContent,
            created_at: commandCreatedAt,
            extra: {},
          },
          checkpoint_message: {
            message_id: checkpointMessageId,
            turn_id: null,
            role: "assistant",
            content: checkpointContent,
            created_at: checkpointCreatedAt,
            extra: { compactedContext: true },
          },
        },
      })
      return {
        reason: "threshold-reached",
        commandMessageId,
        commandContent,
        commandCreatedAt,
        checkpointMessageId: committed.messageId,
        checkpointContent,
        checkpointCreatedAt,
        generation: committed.generation,
      }
    } catch (error) {
      if (
        attempt === 0 &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "compaction_decision_stale"
      ) {
        continue
      }
      throw error
    }
  }
  throw new HttpError(
    409,
    `Automatic compaction for thread '${body.thread_id}' could not obtain a stable durable context snapshot.`,
    "compaction_decision_stale"
  )
}

export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

export function autoSaveConversationsEnabled(
  state: Pick<AppState, "settings">
): boolean {
  try {
    return state.settings.get().auto_save_conversations !== false
  } catch (error) {
    logger.warn(
      { err: error },
      "conversation persistence policy unavailable; suppressing persistence"
    )
    return false
  }
}
