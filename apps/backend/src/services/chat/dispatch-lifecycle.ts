import { type ChatSendBody } from "@betterc0de/schema"
import { randomUUID } from "node:crypto"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import {
  chatDispatchFingerprint,
  type ChatDispatchRecord,
  type ChatDispatchReservationResult,
} from "../chat-dispatch-store"
import { autoSaveConversationsEnabled } from "./automatic-compaction"

export function persistDispatchUserMessage(
  state: AppState,
  body: ChatSendBody,
  stableMessageId?: string
): string | null {
  if (!autoSaveConversationsEnabled(state)) return null
  const userMessageCreatedAt =
    body.user_message_created_at ?? new Date().toISOString()
  const userMessageId = stableMessageId ?? body.user_message_id ?? randomUUID()
  state.threads.persistUserMessageForTurn({
    thread_id: body.thread_id,
    title: body.thread_title ?? "New Chat",
    project_name: body.thread_project_name ?? "BetterC0de",
    project_path: body.project_path ?? "",
    created_at: body.thread_created_at ?? userMessageCreatedAt,
    message: {
      message_id: userMessageId,
      turn_id: null,
      role: "user",
      content: body.user_message_content ?? body.message,
      created_at: userMessageCreatedAt,
      extra: {
        modelId: body.model_id,
        providerKind: body.provider_kind,
        ...(body.system_instruction
          ? { systemInstructionCharacters: body.system_instruction.length }
          : {}),
        ...(body.attachments.length > 0
          ? { attachments: body.attachments }
          : {}),
      },
    },
  })
  return userMessageId
}

/**
 * The identity of a send request for retry purposes: everything the client
 * asked for except renderer-side history and usage hints, which change
 * between an original and its retry without changing what is dispatched.
 */
export function dispatchRequestFingerprint(
  body: ChatSendBody,
  messageId: string,
  providerKind: string,
  providerInstanceId: string | null
): string {
  const {
    history: _rendererHistory,
    auto_compaction_usage: _autoCompactionUsage,
    auto_compaction_model_limits: _autoCompactionModelLimits,
    ...requestWithoutRendererHistory
  } = body
  return chatDispatchFingerprint({
    ...requestWithoutRendererHistory,
    user_message_id: messageId,
    provider_kind: providerKind,
    provider_instance_id: providerInstanceId,
  })
}

export function reserveDurableChatDispatch(
  state: AppState,
  body: ChatSendBody,
  providerKind: string,
  providerInstanceId: string | null
): {
  readonly messageId: string
  readonly reservation: ChatDispatchReservationResult
} | null {
  if (!autoSaveConversationsEnabled(state)) return null
  const messageId = body.user_message_id ?? randomUUID()
  const requestFingerprint = dispatchRequestFingerprint(
    body,
    messageId,
    providerKind,
    providerInstanceId
  )
  const reservation = state.chatDispatches.reserve(
    {
      dispatchId: messageId,
      threadId: body.thread_id,
      messageId,
      providerKind,
      providerInstanceId,
      requestFingerprint,
    },
    () => {
      const persisted = persistDispatchUserMessage(state, body, messageId)
      if (persisted !== messageId) {
        throw new Error(
          "Durable dispatch message persistence was disabled mid-transaction."
        )
      }
    }
  )
  return { messageId, reservation }
}

export function existingDurableChatDispatch(
  state: AppState,
  body: ChatSendBody,
  providerKind: string,
  providerInstanceId: string | null
): ChatDispatchRecord | null {
  if (!autoSaveConversationsEnabled(state) || !body.user_message_id) {
    return null
  }
  const existing = state.chatDispatches.get(body.user_message_id)
  if (!existing) return null
  const requestFingerprint = dispatchRequestFingerprint(
    body,
    body.user_message_id,
    providerKind,
    providerInstanceId
  )
  if (
    existing.threadId !== body.thread_id ||
    existing.messageId !== body.user_message_id ||
    existing.providerKind !== providerKind ||
    existing.requestFingerprint !== requestFingerprint
  ) {
    throw new HttpError(
      409,
      `Dispatch id '${body.user_message_id}' is already bound to a different request.`,
      "dispatch_id_conflict"
    )
  }
  return existing
}

export function existingDispatchResponse(record: ChatDispatchRecord): {
  readonly status: "streaming" | "completed"
  readonly turnId: string
  readonly replayed: true
} {
  if (record.status === "accepted" && record.providerTurnId) {
    return {
      status: "streaming",
      turnId: record.providerTurnId,
      replayed: true,
    }
  }
  if (record.status === "completed" && record.providerTurnId) {
    return {
      status: "completed",
      turnId: record.providerTurnId,
      replayed: true,
    }
  }
  if (record.status === "pending" && record.providerTurnId) {
    return {
      status: "streaming",
      turnId: record.providerTurnId,
      replayed: true,
    }
  }
  if (record.status === "pending") {
    throw new HttpError(
      409,
      "This message is already being admitted by the provider.",
      "dispatch_in_progress"
    )
  }
  if (record.status === "uncertain") {
    throw new HttpError(
      409,
      "The previous provider admission outcome is unknown after backend recovery. Send a new message instead of retrying this id.",
      "dispatch_outcome_unknown"
    )
  }
  if (record.status === "reverted") {
    throw new HttpError(
      409,
      "This message was removed by an explicit thread revert and cannot be dispatched again.",
      "dispatch_reverted"
    )
  }
  throw new HttpError(
    409,
    "This message was already rejected by the provider. Send a new message instead of retrying this id.",
    "dispatch_failed"
  )
}

function taintDispatchDurability(
  state: AppState,
  error: unknown,
  origin: string
): void {
  const normalized = error instanceof Error ? error : new Error(String(error))
  state.taintBackend(normalized, origin)
}

export function markAcceptedDispatchMessage(
  state: AppState,
  input: {
    readonly messageId: string | null
    readonly providerTurnId: string
    readonly providerInstanceId: string | null
  }
): void {
  if (!input.messageId || !state.chatDispatches.get(input.messageId)) return
  try {
    state.chatDispatches.markAccepted({
      dispatchId: input.messageId,
      providerTurnId: input.providerTurnId,
      providerInstanceId: input.providerInstanceId,
    })
  } catch (error) {
    taintDispatchDurability(state, error, "chat_dispatch_accept")
    throw error
  }
}

export function bindDispatchProviderTurn(
  state: AppState,
  input: {
    readonly messageId: string | null
    readonly providerTurnId: string
    readonly providerInstanceId: string | null
  }
): void {
  if (!input.messageId || !state.chatDispatches.get(input.messageId)) return
  try {
    state.chatDispatches.bindProviderTurn({
      dispatchId: input.messageId,
      providerTurnId: input.providerTurnId,
      providerInstanceId: input.providerInstanceId,
    })
  } catch (error) {
    taintDispatchDurability(state, error, "chat_dispatch_bind_provider_turn")
    throw error
  }
}

export function markRejectedDispatchMessage(
  state: AppState,
  input: {
    readonly threadId: string
    readonly messageId: string
    readonly phase: "synchronous" | "asynchronous"
    readonly error?: unknown
  }
): void {
  try {
    if (state.chatDispatches.get(input.messageId)) {
      state.chatDispatches.markFailed(
        input.messageId,
        input.error ?? `Provider dispatch failed ${input.phase}ly.`
      )
    } else {
      state.threads.markDispatchMessageFailed?.(input.threadId, input.messageId)
    }
  } catch (error) {
    taintDispatchDurability(state, error, "chat_dispatch_fail")
    logger.error(
      {
        err: error,
        thread: input.threadId,
        messageId: input.messageId,
      },
      `failed to mark an ${input.phase} rejected dispatch message`
    )
  }
}

export function markActiveDispatchInterrupted(
  state: AppState,
  threadId: string
): void {
  const active = state.chatDispatches.getActiveForThread(threadId)
  if (!active) return
  try {
    state.chatDispatches.markFailed(
      active.dispatchId,
      "Provider turn was interrupted by the user."
    )
  } catch (error) {
    taintDispatchDurability(state, error, "chat_dispatch_interrupt")
    throw error
  }
}
