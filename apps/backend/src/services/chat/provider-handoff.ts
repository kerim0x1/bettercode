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
    let preparedBy = `Prepared by ${source.providerKind} using ${sourceModel} for ${targetProvider}.`
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
      // The previous provider may be unable to run at all (a CLI that quits
      // on start, a revoked sign-in). The switch must not depend on it: no
      // other model writes the summary instead, the stored conversation is
      // passed on as recorded and says so.
      logger.warn(
        {
          threadId: body.thread_id,
          provider: source.providerKind,
          errorType: error instanceof Error ? error.name : typeof error,
          err: error instanceof Error ? error.message.slice(0, 300) : undefined,
        },
        "provider handoff summary failed; passing on the recorded conversation"
      )
      summary = transcriptHandoff(transcript, source.providerKind)
      preparedBy = `Prepared by BetterC0de from the stored conversation for ${targetProvider}, because ${source.providerKind} could not summarize it.`
    }
    const commandCreatedAt = new Date().toISOString()
    const checkpointCreatedAt = commandCreatedAt
    const commandContent = `Provider handoff: ${source.providerKind} → ${targetProvider}`
    const checkpointContent = [
      "# Provider Handoff",
      "",
      preparedBy,
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

/** About 6K tokens of the most recent conversation. */
const TRANSCRIPT_HANDOFF_CHARS = 24_000

/**
 * The handoff when the previous provider cannot summarize: the most recent
 * part of the stored conversation, cut at a line, with a note that it is a
 * verbatim excerpt rather than a summary.
 */
export function transcriptHandoff(
  transcript: string,
  sourceProvider: string
): string {
  const trimmed = transcript.trim()
  const cut = trimmed.length > TRANSCRIPT_HANDOFF_CHARS
  let excerpt = cut ? trimmed.slice(-TRANSCRIPT_HANDOFF_CHARS) : trimmed
  if (cut) {
    const lineStart = excerpt.indexOf("\n")
    if (lineStart >= 0) excerpt = excerpt.slice(lineStart + 1)
  }
  return [
    `${sourceProvider} could not summarize the conversation, so the most recent part follows as recorded${cut ? " (earlier messages left out)" : ""}.`,
    "",
    excerpt,
  ].join("\n")
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
