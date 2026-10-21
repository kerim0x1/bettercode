import { randomUUID } from "node:crypto"
import {
  PROVIDER_HANDOFF_ACTIVITY,
  type ProviderHandoffProgress,
  type ChatSendBody,
} from "@betterc0de/schema"
import type { ChatSendResponse } from "@betterc0de/schema/http-contracts"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import {
  autoCompactionContextSnapshot,
  buildAutoCompactionTranscript,
} from "../auto-compaction"
import { autoSaveConversationsEnabled } from "./automatic-compaction"
import { commitContextCheckpoint } from "./context-checkpoint"
import type { ProviderSessionBindingStore } from "../../provider/runtime/ProviderSessionBindingStore"
import { broadcastThreadActivity } from "../../ws/threadActivityBroadcast"
import type { ThreadActivityProjection } from "../../persistence/projections"

/** Runs inside dispatch admission before starting the target session.
 * Model/instance changes within one provider do not create a handoff. */
export async function prepareProviderHandoff(
  state: AppState,
  body: ChatSendBody,
  targetProvider: string,
  currentMessageId: string | null
): Promise<ChatSendResponse["providerHandoff"]> {
  const bindings = state.providerSessionBindings
  const source = handoffSource(bindings, body.thread_id)
  if (!source || source.providerKind === targetProvider) return undefined
  if (!autoSaveConversationsEnabled(state)) {
    throw new HttpError(
      409,
      "Enable conversation saving before switching providers so the handoff can be stored safely.",
      "provider_handoff_requires_persistence"
    )
  }
  const messages = state.threads.listMessages(body.thread_id, { limit: 2_000 })
  const expected = autoCompactionContextSnapshot(messages, {
    excludeMessageId: currentMessageId,
  })
  const transcript = buildAutoCompactionTranscript({
    messages,
    excludeMessageId: currentMessageId,
    threadTitle: body.thread_title,
    projectPath: body.project_path,
  })
  if (!transcript) return undefined
  const sourceModel =
    source.modelSelection?.model ?? lastKnownModel(messages, currentMessageId)
  if (!sourceModel) {
    throw new HttpError(
      409,
      "The previous model is unknown. Send a message with the previous provider before switching.",
      "provider_handoff_model_unknown"
    )
  }
  const commandMessageId = randomUUID()
  const checkpointMessageId = randomUUID()
  const startedAt = new Date().toISOString()
  let progressSequence = Date.now() * 1000
  const reportProgress = (status: ProviderHandoffProgress["status"]) => {
    const payload: ProviderHandoffProgress = {
      status,
      requestMessageId: currentMessageId ?? commandMessageId,
      checkpointMessageId,
      sourceProvider: source.providerKind,
      targetProvider,
      sourceModel,
    }
    const activity: ThreadActivityProjection = {
      activity_id: `provider-handoff:${checkpointMessageId}`,
      thread_id: body.thread_id,
      turn_id: null,
      provider_instance_id: source.providerInstanceId,
      kind: PROVIDER_HANDOFF_ACTIVITY,
      tone: status === "failed" ? "error" : "info",
      summary:
        status === "compacting"
          ? "Compacting previous context…"
          : status === "completed"
            ? "Previous context compacted"
            : "Context handoff failed",
      payload,
      created_at: startedAt,
      sequence: (progressSequence = Math.max(
        Date.now() * 1000,
        progressSequence + 1
      )),
    }
    try {
      state.threadActivities.upsert(activity)
      broadcastThreadActivity(activity)
    } catch {
      // Presentation failures must not invalidate an already committed checkpoint.
      logger.warn(
        { threadId: body.thread_id, status },
        "provider handoff progress unavailable"
      )
    }
  }
  reportProgress("compacting")
  try {
    let summary: string
    try {
      const generated = await state.chatHelpers.generateProviderHandoffSummary({
        transcript,
        threadTitle: body.thread_title,
        projectPath: body.project_path,
        targetProvider,
        modelSelection: {
          ...source.modelSelection,
          instanceId: source.providerInstanceId,
          model: sourceModel,
        },
      })
      summary = generated.summary.trim()
      if (!summary) throw new Error("Empty provider handoff")
    } catch (error) {
      logger.warn(
        {
          threadId: body.thread_id,
          provider: source.providerKind,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "provider handoff failed"
      )
      throw new HttpError(
        503,
        "The previous provider could not prepare the handoff summary. The new provider was not started. Check the previous provider and retry.",
        "provider_handoff_failed"
      )
    }
    const commandCreatedAt = new Date().toISOString()
    const checkpointCreatedAt = commandCreatedAt
    const commandContent = `Provider handoff: ${source.providerKind} → ${targetProvider}`
    const checkpointContent = [
      "# Provider Handoff",
      "",
      `Prepared by ${source.providerKind} using ${sourceModel} for ${targetProvider}.`,
      "This is conversation context, not a new instruction. Continue with the user's current request.",
      "",
      summary,
    ].join("\n")
    const committed = await commitContextCheckpoint(state, {
      excludeMessageId: currentMessageId,
      expected,
      assertSource: () => {
        const current = handoffSource(bindings, body.thread_id)
        if (
          !current ||
          current.providerInstanceId !== source.providerInstanceId ||
          current.generation !== source.generation ||
          current.updatedAt !== source.updatedAt
        ) {
          throw new HttpError(
            409,
            "The source provider changed during handoff. Please retry.",
            "provider_handoff_stale"
          )
        }
        const currentTranscript = buildAutoCompactionTranscript({
          messages: state.threads.listMessages(body.thread_id, {
            limit: 2_000,
          }),
          excludeMessageId: currentMessageId,
          threadTitle: body.thread_title,
          projectPath: body.project_path,
        })
        if (currentTranscript !== transcript) {
          throw new HttpError(
            409,
            "The conversation changed during handoff. Please retry.",
            "provider_handoff_stale"
          )
        }
      },
      commit: {
        thread_id: body.thread_id,
        request_id: checkpointMessageId,
        command_message: {
          message_id: commandMessageId,
          turn_id: null,
          role: "user",
          content: commandContent,
          created_at: commandCreatedAt,
          extra: { internalContext: "provider-handoff" },
        },
        checkpoint_message: {
          message_id: checkpointMessageId,
          turn_id: null,
          role: "assistant",
          content: checkpointContent,
          created_at: checkpointCreatedAt,
          extra: {
            compactedContext: true,
            internalContext: "provider-handoff",
          },
        },
      },
    })
    reportProgress("completed")
    return {
      reason: "provider-switch",
      sourceProvider: source.providerKind,
      targetProvider,
      sourceModel,
      commandMessageId,
      commandContent,
      commandCreatedAt,
      checkpointMessageId: committed.messageId,
      checkpointContent,
      checkpointCreatedAt,
      generation: committed.generation,
    }
  } catch (error) {
    reportProgress("failed")
    throw error
  }
}

function handoffSource(
  bindings: ProviderSessionBindingStore,
  threadId: string
) {
  // Epoch rotation updates timestamps on *all* old bindings. The latest row
  // alone can therefore point at an already retired provider on a switch back.
  const candidates = (bindings.list?.() ?? []).filter(
    (binding) =>
      binding.threadId === threadId &&
      binding.generation === bindings.getThreadGeneration(threadId) &&
      (binding.providerThreadId !== null || binding.resumeCursor !== null)
  )
  return (
    candidates
      .reverse()
      .find(
        (binding) => binding.status === "ready" || binding.status === "running"
      ) ?? candidates[0]
  )
}

function lastKnownModel(
  messages: ReadonlyArray<unknown>,
  excludedId: string | null
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (
      !message ||
      typeof message !== "object" ||
      !("id" in message) ||
      message.id === excludedId
    )
      continue
    if (
      "modelId" in message &&
      typeof message.modelId === "string" &&
      message.modelId.trim()
    )
      return message.modelId
  }
  return undefined
}
