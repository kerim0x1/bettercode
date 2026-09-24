import type { Db } from "../../persistence/db"
import { prepareThreadStatements, type ThreadStatements } from "./statements"
import type { HistoryMessage } from "../../provider/types"
import {
  normalizeProviderGoal,
  threadGoalSchema,
  type ThreadGoal,
} from "@betterc0de/schema"
import {
  CHAT_HISTORY_MAX_BYTES,
  withBrowserElementContext,
} from "@betterc0de/schema"
import { HttpError } from "../../http/errors"
import type {
  ThreadSaveRequest,
  ThreadSaveMessage,
  ThreadMetaUpsertRequest,
  ThreadMessageUpsertRequest,
  ThreadCheckpointRevertRequest,
  ThreadTruncateRequest,
  ThreadCompactionCommitRequest,
  ThreadCompactionCommitResult,
  ThreadUserMessageDispatchRequest,
} from "./types"
import { serializeMessage, hydrateMessageRow } from "./thread-codec"
import { logger } from "../../observability/logger"
import {
  mergeChatDispatchMetadata,
  type ChatDispatchStatus,
} from "../chat-dispatch-store"

export interface ThreadStatsOptions {
  days?: number
  projectPath?: string | null
}

export interface ProviderHistoryOptions {
  excludeMessageId?: string | null
  maxMessages?: number
  maxContentChars?: number
  maxBytes?: number
}

const PROVIDER_HISTORY_MAX_MESSAGES = 80
const PROVIDER_HISTORY_MAX_WIRE_MESSAGES = 320
const PROVIDER_HISTORY_MAX_TOOL_CALLS = 128
const PROVIDER_HISTORY_MAX_TOOL_CALL_SCAN = 512
const PROVIDER_HISTORY_MAX_CONTENT_CHARS = 10_000
const PROVIDER_HISTORY_SCAN_MULTIPLIER = 4
const COMPACTED_CONTEXT_HEADING = "# Compacted Session Context"
const utf8Encoder = new TextEncoder()

export interface ThreadStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        reasoning: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  providerUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        reasoning: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  dailyUsage: Array<{
    date: string
    provider: string
    tokens: number
    cost: number
  }>
  dateRange: {
    earliest: string | null
    latest: string | null
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

/** One row of the thread summary queries (see `threadPageSql`). */
interface ThreadSummaryRow {
  thread_id: string
  project_id: string
  title: string | null
  created_at: string
  updated_at: string
  project_path: string | null
  env_mode: string | null
  branch: string | null
  worktree_path: string | null
  base_branch: string | null
  worktree_state: string | null
  parent_thread_id: string | null
  codex_thread_id: string | null
  provider_goal_json: string | null
  message_count: number | null
  last_model_id: string | null
  turn_count: number | null
  provider_kind: string | null
  provider_instance_id: string | null
  provider_thread_id: string | null
  resume_cursor_json: string | null
  continuation_key: string | null
  session_status: string | null
  active_turn_id: string | null
  last_error: string | null
  runtime_mode: string | null
  session_cwd: string | null
  model_selection_json: string | null
  session_updated_at: string | null
}

export class ThreadService {
  private readonly statsCache = new Map<
    string,
    { revision: number; expires: number; value: ThreadStats }
  >()
  private readonly stmts: ThreadStatements

  constructor(private readonly db: Db) {
    this.stmts = prepareThreadStatements(db)
  }

  private assertThreadExists(threadId: string): void {
    const exists = this.stmts.ensureThreadExistsStmt.get(threadId) as
      | { 1: number }
      | undefined
    if (!exists) throw new HttpError(404, `thread ${threadId} not found`)
  }

  // `turn_count` is deliberately not recomputed here: the v43/v46 triggers
  // on projection_messages, projection_turns and turn_diffs maintain it on
  // every row change, so the writer statements only own the message-derived
  // columns.
  private syncThreadFromMessages(threadId: string, updatedAt: string): void {
    this.stmts.syncThreadFromMessagesStmt.run(
      updatedAt,
      threadId,
      threadId,
      threadId
    )
  }

  private threadSessionFromRow(row: {
    thread_id?: string | null
    provider_kind: string | null
    provider_instance_id: string | null
    provider_thread_id: string | null
    resume_cursor_json: string | null
    continuation_key: string | null
    session_status: string | null
    active_turn_id: string | null
    last_error: string | null
    runtime_mode: string | null
    session_cwd: string | null
    model_selection_json: string | null
    session_updated_at: string | null
  }): Record<string, unknown> | null {
    if (!row.provider_kind || !row.provider_instance_id) return null
    const context = {
      threadId: row.thread_id ?? null,
      column: "resume_cursor_json",
    }
    const resumeCursor = parseJsonOrNull(row.resume_cursor_json, context)
    return {
      providerKind: row.provider_kind,
      providerInstanceId: row.provider_instance_id,
      providerThreadId: row.provider_thread_id,
      resumeCursor,
      continuationKey: row.continuation_key,
      status: row.session_status ?? "ready",
      activeTurnId: row.active_turn_id,
      lastError: row.last_error ? "Provider session failed." : null,
      runtimeMode: row.runtime_mode ?? "full-access",
      cwd: normalizeOptionalString(row.session_cwd),
      modelSelection: parseJsonOrNull(row.model_selection_json, {
        ...context,
        column: "model_selection_json",
      }),
      updatedAt: row.session_updated_at,
    }
  }

  upsertThreadMeta(thread: ThreadMetaUpsertRequest): void {
    this.stmts.upsertThreadStmt.run(
      thread.thread_id,
      thread.project_name,
      thread.title,
      thread.created_at,
      thread.updated_at,
      thread.project_path,
      thread.codex_thread_id
    )
    this.updateThreadWorkspaceMetadata(thread)
    this.updateThreadParentMetadata(thread)
  }

  updateThreadTitle(
    threadId: string,
    title: string,
    updatedAt = new Date().toISOString()
  ): void {
    this.stmts.updateThreadTitleStmt.run(title, updatedAt, threadId)
  }

  getThreadGoal(threadId: string) {
    const row = this.stmts.getThreadGoalStmt.get(threadId) as
      | { provider_goal_json: string | null }
      | undefined
    return row ? parsePersistedThreadGoal(row.provider_goal_json) : undefined
  }

  hasThread(threadId: string): boolean {
    return Boolean(this.stmts.getThreadGoalStmt.get(threadId))
  }

  /** Called only by runtime ingestion, after the provider event is journaled. */
  updateThreadGoal(
    threadId: string,
    value: unknown,
    providerKind?: string,
    updatedAt?: string
  ): void {
    const row = this.stmts.getThreadGoalStmt.get(threadId) as
      | { provider_goal_json: string | null; updated_at: string }
      | undefined
    // A late provider notification must never recreate a deleted thread.
    if (!row) return
    const previous = parsePersistedThreadGoal(row.provider_goal_json)
    const timestamp = Date.parse(updatedAt ?? row.updated_at)
    const goal = normalizeProviderGoal(
      value,
      previous,
      providerKind,
      Number.isFinite(timestamp) ? timestamp : 0
    )
    if (goal === undefined) return
    // Goal accounting must not reorder the sidebar on every token update.
    this.stmts.updateThreadGoalStmt.run(JSON.stringify(goal), threadId)
  }

  save(thread: ThreadSaveRequest): void {
    // A full save is allowed while a turn is active: every row the runtime
    // owns (dispatch user messages, streamed/recovered assistant rows) is
    // merged from the database below rather than from the request, so the
    // renderer cannot clobber the provider transcript even mid-turn.
    const txn = this.db.transaction((req: ThreadSaveRequest) => {
      this.upsertThreadMeta(req)
      const serverOwnedMessages = new Map(
        (
          this.stmts.listServerOwnedDispatchMessagesStmt.all(
            req.thread_id
          ) as Array<{
            message_id: string
            turn_id: string | null
            role: string
            content_json: string
            created_at: string
            status: ChatDispatchStatus
          }>
        ).map((row) => [row.message_id, row] as const)
      )
      const requestedMessageIds = new Set(
        req.messages.map((message) => message.message_id)
      )
      const dispatchStatuses = new Map(
        (
          this.stmts.listChatDispatchStatusesStmt.all(req.thread_id) as Array<{
            message_id: string
            status: ChatDispatchStatus
          }>
        ).map((row) => [row.message_id, row.status] as const)
      )
      const omittedDispatchMessage = [...serverOwnedMessages.keys()].find(
        (messageId) => !requestedMessageIds.has(messageId)
      )
      if (omittedDispatchMessage) {
        throw new HttpError(
          409,
          `Full thread save omitted durable dispatch message ${omittedDispatchMessage}.`,
          "dispatch_message_omitted"
        )
      }
      const persistedMessages = new Map(
        (
          this.stmts.listPersistedMessagesStmt.all(
            req.thread_id
          ) as PersistedMessageRow[]
        ).map((row) => [row.message_id, row] as const)
      )
      // Rows the provider runtime wrote (streamed or recovered assistant
      // transcript) are not the renderer's to delete or rewrite: its copy
      // is at best a stale snapshot of what the journal already projected.
      // A save that drops or alters one is refused outright rather than
      // silently repaired, so the caller learns its snapshot is stale
      // instead of believing the write went through.
      for (const row of persistedMessages.values()) {
        if (
          !requestedMessageIds.has(row.message_id) &&
          isRuntimeAuthoredMessageRow(row)
        ) {
          throw new HttpError(
            409,
            `Full thread save omitted runtime-authored message ${row.message_id}.`,
            "runtime_message_protected"
          )
        }
      }

      req.messages.forEach((message, index) => {
        const serverOwned = serverOwnedMessages.get(message.message_id)
        const dispatchStatus = dispatchStatuses.get(message.message_id)
        if (dispatchStatus === "reverted") {
          throw new HttpError(
            409,
            `message ${message.message_id} was removed by an explicit thread revert`,
            "dispatch_message_reverted"
          )
        }
        const persisted = persistedMessages.get(message.message_id)
        if (persisted && isRuntimeAuthoredMessageRow(persisted)) {
          // The renderer's copy went through the save parser, which drops
          // the runtime marker and reshapes `extra`, so bytes can never
          // match; compare the transcript itself (role, turn, text) and
          // only ever accept a move to a new position.
          if (
            persisted.role !== message.role ||
            persisted.turn_id !== message.turn_id ||
            parseStoredMessage(persisted.content_json, {
              threadId: req.thread_id,
              messageId: persisted.message_id,
            }).text !== message.content
          ) {
            throw new HttpError(
              409,
              `Full thread save tried to rewrite runtime-authored message ${message.message_id}.`,
              "runtime_message_protected"
            )
          }
          if (persisted.sequence !== index) {
            this.stmts.updateMessageSequenceStmt.run(
              index,
              req.thread_id,
              persisted.message_id
            )
          }
          return
        }
        const durableMessage = serverOwned
          ? this.messageFromServerOwnedDispatch(serverOwned)
          : dispatchStatus
            ? {
                ...message,
                extra: mergeChatDispatchMetadata(message.extra, dispatchStatus),
              }
            : message
        const serialized = serializeMessage(durableMessage)
        if (!persisted) {
          this.stmts.insertMessageStmt.run(
            durableMessage.message_id,
            req.thread_id,
            durableMessage.turn_id,
            durableMessage.role,
            serialized,
            durableMessage.created_at,
            index
          )
          return
        }
        if (
          persisted.turn_id === durableMessage.turn_id &&
          persisted.role === durableMessage.role &&
          persisted.content_json === serialized &&
          persisted.created_at === durableMessage.created_at &&
          persisted.sequence === index
        ) {
          return
        }
        this.stmts.updateSavedMessageStmt.run(
          durableMessage.turn_id,
          durableMessage.role,
          serialized,
          durableMessage.created_at,
          index,
          req.thread_id,
          durableMessage.message_id
        )
      })
      for (const messageId of persistedMessages.keys()) {
        if (!requestedMessageIds.has(messageId)) {
          this.stmts.deleteMessageByIdStmt.run(req.thread_id, messageId)
        }
      }
      this.syncThreadFromMessages(req.thread_id, req.updated_at)
    })
    txn(thread)
  }

  upsertMessage(req: ThreadMessageUpsertRequest): void {
    const txn = this.db.transaction((input: ThreadMessageUpsertRequest) => {
      this.assertThreadExists(input.thread_id)
      if (this.isStaleProviderRuntimeMessage(input)) return
      const runtimeSequence = input.message.extra.providerRuntimeSequence
      // The HTTP parser never forwards the runtime sequence. An unsequenced
      // snapshot may acknowledge an owned row, but cannot replace its content,
      // metadata or timestamps. Provider snapshots retain their sequence guard.
      if (
        typeof runtimeSequence !== "number" ||
        !Number.isSafeInteger(runtimeSequence)
      ) {
        const persisted = this.stmts.findPersistedMessageStmt.get(
          input.thread_id,
          input.message.message_id
        ) as PersistedMessageRow | undefined
        if (persisted && isRuntimeAuthoredMessageRow(persisted)) {
          if (
            persisted.role !== input.message.role ||
            persisted.turn_id !== input.message.turn_id ||
            parseStoredMessage(persisted.content_json, {
              threadId: input.thread_id,
              messageId: persisted.message_id,
            }).text !== input.message.content
          ) {
            throw new HttpError(
              409,
              `Message save tried to rewrite runtime-authored message ${input.message.message_id}.`,
              "runtime_message_protected"
            )
          }
          return
        }
      }
      this.upsertMessageRow(input)
    })
    txn(req)
  }

  upsertRecoveredAssistantMessage(req: ThreadMessageUpsertRequest): void {
    if (req.message.role !== "assistant") {
      throw new HttpError(
        400,
        "Recovered transcript message must be assistant-owned."
      )
    }
    const txn = this.db.transaction((input: ThreadMessageUpsertRequest) => {
      this.assertThreadExists(input.thread_id)
      if (this.isStaleProviderRuntimeMessage(input)) return
      const existing = this.stmts.findMessageSequenceStmt.get(
        input.thread_id,
        input.message.message_id
      ) as { sequence: number } | undefined
      if (existing) {
        this.stmts.updateMessageStmt.run(
          input.message.turn_id,
          input.message.role,
          serializeMessage(input.message),
          input.message.created_at,
          input.thread_id,
          input.message.message_id
        )
      } else {
        const boundary = this.stmts.findRecoveryInsertSequenceStmt.get(
          input.thread_id,
          input.message.created_at
        ) as { sequence: number | null }
        const sequence =
          typeof boundary.sequence === "number"
            ? boundary.sequence
            : (
                this.stmts.nextMessageSequenceStmt.get(input.thread_id) as {
                  next_sequence: number
                }
              ).next_sequence
        if (typeof boundary.sequence === "number") {
          this.stmts.shiftMessageSequencesStmt.run(input.thread_id, sequence)
        }
        this.stmts.insertMessageStmt.run(
          input.message.message_id,
          input.thread_id,
          input.message.turn_id,
          input.message.role,
          serializeMessage(input.message),
          input.message.created_at,
          sequence
        )
      }
      this.stmts.syncRecoveredThreadFromMessagesStmt.run(
        input.message.created_at,
        input.thread_id,
        input.thread_id,
        input.thread_id
      )
    })
    txn(req)
  }

  private isStaleProviderRuntimeMessage(
    input: ThreadMessageUpsertRequest
  ): boolean {
    const incomingSequence = input.message.extra.providerRuntimeSequence
    if (
      typeof incomingSequence !== "number" ||
      !Number.isSafeInteger(incomingSequence)
    ) {
      return false
    }
    const existing = this.stmts.findRuntimeSequenceStmt.get(
      input.message.message_id
    ) as
      | { thread_id: string; role: string; runtime_sequence: number | null }
      | undefined
    if (
      !existing ||
      existing.thread_id !== input.thread_id ||
      existing.role !== "assistant"
    ) {
      return false
    }
    const storedSequence = existing.runtime_sequence
    return (
      typeof storedSequence === "number" &&
      Number.isSafeInteger(storedSequence) &&
      storedSequence >= incomingSequence
    )
  }

  persistUserMessageForTurn(req: ThreadUserMessageDispatchRequest): void {
    const txn = this.db.transaction(
      (input: ThreadUserMessageDispatchRequest) => {
        this.stmts.ensureThreadForTurnStmt.run(
          input.thread_id,
          input.project_name,
          input.title,
          input.created_at,
          input.created_at,
          input.project_path
        )
        this.assertDispatchMessageWritable(
          input.thread_id,
          input.message.message_id
        )
        const durableDispatch = this.stmts.findChatDispatchStatusStmt.get(
          input.thread_id,
          input.message.message_id
        ) as { status: ChatDispatchStatus } | undefined
        const existing = this.stmts.findDispatchMessageStmt.get(
          input.message.message_id
        ) as
          | {
              thread_id: string
              turn_id: string | null
              role: string
              content_json: string
              created_at: string
            }
          | undefined
        const serializedMessage = serializeMessage(input.message)
        if (existing) {
          const storedMessage = parseStoredMessage(existing.content_json, {
            threadId: existing.thread_id,
            messageId: input.message.message_id,
          })
          const samePayload =
            existing.thread_id === input.thread_id &&
            existing.turn_id === input.message.turn_id &&
            existing.role === "user" &&
            input.message.role === "user" &&
            storedMessage.text === input.message.content
          if (!samePayload) {
            throw new HttpError(
              409,
              `message ${input.message.message_id} conflicts with an existing durable message`,
              "dispatch_message_conflict"
            )
          }
          if (!durableDispatch && storedMessage.extra.dispatchFailed === true) {
            this.stmts.updateMessageStmt.run(
              input.message.turn_id,
              input.message.role,
              serializedMessage,
              existing.created_at,
              input.thread_id,
              input.message.message_id
            )
          }
          return
        }
        if (input.message.role !== "user") {
          throw new HttpError(
            409,
            `message ${input.message.message_id} is not a user dispatch message`,
            "dispatch_message_conflict"
          )
        }
        const next = this.stmts.nextMessageSequenceStmt.get(
          input.thread_id
        ) as {
          next_sequence: number
        }
        const effectiveCreatedAt = this.monotonicUserMessageCreatedAt(
          input.thread_id,
          input.message.created_at
        )
        this.stmts.insertMessageStmt.run(
          input.message.message_id,
          input.thread_id,
          input.message.turn_id,
          input.message.role,
          serializedMessage,
          effectiveCreatedAt,
          next.next_sequence
        )
        this.syncThreadFromMessages(input.thread_id, effectiveCreatedAt)
      }
    )
    txn(req)
  }

  markDispatchMessageFailed(threadId: string, messageId: string): void {
    const txn = this.db.transaction(() => {
      const existing = this.stmts.findDispatchMessageStmt.get(messageId) as
        | {
            thread_id: string
            turn_id: string | null
            role: string
            content_json: string
            created_at: string
          }
        | undefined
      if (
        !existing ||
        existing.thread_id !== threadId ||
        existing.role !== "user"
      ) {
        return
      }
      const stored = parseStoredMessage(existing.content_json, {
        threadId,
        messageId,
      })
      this.stmts.updateMessageStmt.run(
        existing.turn_id,
        existing.role,
        serializeMessage({
          message_id: messageId,
          turn_id: existing.turn_id,
          role: existing.role,
          content: stored.text,
          created_at: existing.created_at,
          extra: { ...stored.extra, dispatchFailed: true },
        }),
        existing.created_at,
        threadId,
        messageId
      )
    })
    txn()
  }

  private upsertMessageRow(input: ThreadMessageUpsertRequest): void {
    this.assertDispatchMessageWritable(
      input.thread_id,
      input.message.message_id
    )
    const existing = this.stmts.findMessageSequenceStmt.get(
      input.thread_id,
      input.message.message_id
    ) as
      | {
          sequence: number
          created_at: string
          role: string
          turn_id: string | null
        }
      | undefined

    const durableMessage = this.serverOwnedDispatchMessage(
      input.thread_id,
      input.message.message_id
    )
    const message =
      durableMessage ??
      this.withServerDispatchMetadata(input.thread_id, input.message)

    if (existing) {
      this.stmts.updateMessageStmt.run(
        message.turn_id,
        message.role,
        serializeMessage(message),
        message.role === "user" ? existing.created_at : message.created_at,
        input.thread_id,
        message.message_id
      )
    } else {
      const next = this.stmts.nextMessageSequenceStmt.get(input.thread_id) as {
        next_sequence: number
      }
      const effectiveCreatedAt =
        message.role === "user"
          ? this.monotonicUserMessageCreatedAt(
              input.thread_id,
              message.created_at
            )
          : message.created_at
      this.stmts.insertMessageStmt.run(
        message.message_id,
        input.thread_id,
        message.turn_id,
        message.role,
        serializeMessage(message),
        effectiveCreatedAt,
        next.next_sequence
      )
      this.syncThreadFromMessages(input.thread_id, effectiveCreatedAt)
      return
    }

    if (
      existing.role === message.role &&
      existing.turn_id === message.turn_id &&
      existing.created_at === message.created_at
    ) {
      // Content snapshots cannot change membership, timestamps, or turn count.
      // Keep the sidebar current without scanning the conversation again.
      this.stmts.touchThreadStmt.run(message.created_at, input.thread_id)
    } else {
      this.syncThreadFromMessages(
        input.thread_id,
        message.role === "user" ? existing.created_at : message.created_at
      )
    }
  }

  private monotonicUserMessageCreatedAt(
    threadId: string,
    requestedCreatedAt: string
  ): string {
    const latest = this.stmts.latestMessageCreatedAtStmt.get(threadId) as
      | { created_at: string }
      | undefined
    if (!latest) return requestedCreatedAt
    const requestedMs = Date.parse(requestedCreatedAt)
    const latestMs = Date.parse(latest.created_at)
    if (
      !Number.isFinite(requestedMs) ||
      !Number.isFinite(latestMs) ||
      requestedMs > latestMs
    ) {
      return requestedCreatedAt
    }
    return new Date(latestMs + 1).toISOString()
  }

  findCompactionCommit(
    threadId: string,
    requestId: string,
    expected?: {
      checkpointContent: string
      commandMessageId: string
      commandContent: string
    }
  ): ThreadCompactionCommitResult | null {
    const row = this.stmts.findCompactionMessageStmt.get(requestId) as
      | { thread_id: string; role: string; content_json: string }
      | undefined
    if (!row) return null
    if (row.thread_id !== threadId || row.role !== "assistant") {
      throw new HttpError(
        409,
        `Compaction request '${requestId}' conflicts with an existing message.`,
        "compaction_request_conflict"
      )
    }
    const parsed = parseStoredMessage(row.content_json, {
      threadId,
      messageId: requestId,
    })
    if (
      parsed.extra.compactedContext !== true ||
      parsed.extra.compactionRequestId !== requestId
    ) {
      throw new HttpError(
        409,
        `Compaction request '${requestId}' conflicts with an existing message.`,
        "compaction_request_conflict"
      )
    }
    if (
      expected &&
      (parsed.text !== expected.checkpointContent ||
        parsed.extra.compactionCommandMessageId !== expected.commandMessageId)
    ) {
      throw new HttpError(
        409,
        `Compaction request '${requestId}' was retried with different content.`,
        "compaction_request_conflict"
      )
    }
    if (expected) {
      const commandRow = this.stmts.findCompactionMessageStmt.get(
        expected.commandMessageId
      ) as { thread_id: string; role: string; content_json: string } | undefined
      if (
        !commandRow ||
        commandRow.thread_id !== threadId ||
        commandRow.role !== "user" ||
        parseStoredMessage(commandRow.content_json, {
          threadId,
          messageId: expected.commandMessageId,
        }).text !== expected.commandContent
      ) {
        throw new HttpError(
          409,
          `Compaction request '${requestId}' was retried with a different command.`,
          "compaction_request_conflict"
        )
      }
    }

    const generation = parsed.extra.compactionGeneration
    if (
      typeof generation !== "number" ||
      !Number.isInteger(generation) ||
      generation < 0
    ) {
      throw new HttpError(
        409,
        `Compaction request '${requestId}' has invalid persisted metadata.`,
        "compaction_request_conflict"
      )
    }
    return {
      alreadyCommitted: true,
      generation,
      messageId: requestId,
    }
  }

  private withServerDispatchMetadata(
    threadId: string,
    message: ThreadSaveMessage
  ): ThreadSaveMessage {
    const row = this.stmts.findChatDispatchStatusStmt.get(
      threadId,
      message.message_id
    ) as { status: ChatDispatchStatus } | undefined
    if (!row) return message
    return {
      ...message,
      extra: mergeChatDispatchMetadata(message.extra, row.status),
    }
  }

  private assertDispatchMessageWritable(
    threadId: string,
    messageId: string
  ): void {
    const row = this.stmts.findChatDispatchStatusStmt.get(
      threadId,
      messageId
    ) as { status: ChatDispatchStatus } | undefined
    if (row?.status !== "reverted") return
    throw new HttpError(
      409,
      `message ${messageId} was removed by an explicit thread revert`,
      "dispatch_message_reverted"
    )
  }

  private serverOwnedDispatchMessage(
    threadId: string,
    messageId: string
  ): ThreadSaveMessage | null {
    const status = this.stmts.findChatDispatchStatusStmt.get(
      threadId,
      messageId
    ) as { status: ChatDispatchStatus } | undefined
    if (!status) return null
    const row = this.stmts.findDispatchMessageStmt.get(messageId) as
      | {
          thread_id: string
          turn_id: string | null
          role: string
          content_json: string
          created_at: string
        }
      | undefined
    if (!row || row.thread_id !== threadId || row.role !== "user") return null
    return this.messageFromServerOwnedDispatch({
      message_id: messageId,
      turn_id: row.turn_id,
      role: row.role,
      content_json: row.content_json,
      created_at: row.created_at,
      status: status.status,
    })
  }

  private messageFromServerOwnedDispatch(row: {
    message_id: string
    turn_id: string | null
    role: string
    content_json: string
    created_at: string
    status: ChatDispatchStatus
  }): ThreadSaveMessage {
    const stored = parseStoredMessage(row.content_json, {
      messageId: row.message_id,
    })
    return {
      message_id: row.message_id,
      turn_id: row.turn_id,
      role: row.role,
      content: stored.text,
      created_at: row.created_at,
      extra: mergeChatDispatchMetadata(stored.extra, row.status),
    }
  }

  commitCompaction(
    req: ThreadCompactionCommitRequest
  ): ThreadCompactionCommitResult {
    const txn = this.db.transaction(
      (input: ThreadCompactionCommitRequest): ThreadCompactionCommitResult => {
        this.assertThreadExists(input.thread_id)
        if (input.request_id !== input.checkpoint_message.message_id) {
          throw new HttpError(
            400,
            "Compaction request id must match the checkpoint message id.",
            "invalid_compaction_request"
          )
        }
        const existing = this.findCompactionCommit(
          input.thread_id,
          input.request_id,
          {
            checkpointContent: input.checkpoint_message.content,
            commandMessageId: input.command_message.message_id,
            commandContent: input.command_message.content,
          }
        )
        if (existing) {
          return existing
        }

        const commandConflict = this.stmts.findMessageSequenceStmt.get(
          input.thread_id,
          input.command_message.message_id
        ) as { sequence: number } | undefined
        if (commandConflict) {
          throw new HttpError(
            409,
            `Compaction command message '${input.command_message.message_id}' already exists.`,
            "compaction_request_conflict"
          )
        }

        const epochRow = this.stmts.currentThreadEpochStmt.get(
          input.thread_id,
          input.thread_id
        ) as { generation: number | null }
        const generation = Math.max(0, epochRow.generation ?? 0) + 1
        const updatedAt = input.checkpoint_message.created_at
        this.stmts.upsertThreadEpochStmt.run(
          input.thread_id,
          generation,
          updatedAt
        )
        this.stmts.rotateThreadBindingsStmt.run(
          generation,
          updatedAt,
          input.thread_id
        )

        const next = this.stmts.nextMessageSequenceStmt.get(
          input.thread_id
        ) as {
          next_sequence: number
        }
        this.stmts.insertMessageStmt.run(
          input.command_message.message_id,
          input.thread_id,
          input.command_message.turn_id,
          input.command_message.role,
          serializeMessage(input.command_message),
          input.command_message.created_at,
          next.next_sequence
        )
        this.stmts.insertMessageStmt.run(
          input.checkpoint_message.message_id,
          input.thread_id,
          input.checkpoint_message.turn_id,
          input.checkpoint_message.role,
          serializeMessage({
            ...input.checkpoint_message,
            extra: {
              ...input.checkpoint_message.extra,
              compactedContext: true,
              compactionGeneration: generation,
              compactionRequestId: input.request_id,
              compactionCommandMessageId: input.command_message.message_id,
            },
          }),
          input.checkpoint_message.created_at,
          next.next_sequence + 1
        )
        this.syncThreadFromMessages(input.thread_id, updatedAt)
        return {
          alreadyCommitted: false,
          generation,
          messageId: input.checkpoint_message.message_id,
        }
      }
    )
    return txn(req)
  }

  truncateAfterMessage(req: ThreadTruncateRequest): {
    deletedMessages: number
  } {
    const txn = this.db.transaction((input: ThreadTruncateRequest) => {
      this.assertThreadExists(input.thread_id)
      const boundary = this.stmts.findMessageBoundaryStmt.get(
        input.thread_id,
        input.message_id
      ) as
        | {
            sequence: number
            created_at: string
            role: string
            turn_id: string | null
          }
        | undefined
      if (!boundary) {
        throw new HttpError(404, `message ${input.message_id} not found`)
      }

      this.stmts.deleteActivitiesAfterMessageSequenceStmt.run(
        input.thread_id,
        input.thread_id,
        boundary.sequence,
        boundary.created_at
      )
      this.stmts.deleteApprovalsAfterMessageSequenceStmt.run(
        input.thread_id,
        input.thread_id,
        boundary.sequence
      )
      this.stmts.deleteCheckpointDiffsAfterMessageSequenceStmt.run(
        input.thread_id,
        input.thread_id,
        boundary.sequence
      )
      this.stmts.deleteTurnDiffsAfterBoundarySequenceStmt.run(
        input.thread_id,
        input.thread_id,
        boundary.sequence
      )
      this.stmts.deleteTurnsAfterMessageSequenceStmt.run(
        input.thread_id,
        input.thread_id,
        boundary.sequence
      )
      this.stmts.revertChatDispatchesAfterMessageSequenceStmt.run(
        input.updated_at,
        input.thread_id,
        input.thread_id,
        boundary.sequence
      )
      const result = this.stmts.deleteMessagesAfterSequenceStmt.run(
        input.thread_id,
        boundary.sequence
      ) as { changes: number }
      this.syncThreadFromMessages(input.thread_id, input.updated_at)
      return { deletedMessages: result.changes }
    })
    return txn(req)
  }

  truncateAfterTurnCount(req: ThreadCheckpointRevertRequest): {
    deletedMessages: number
    boundaryMessageId: string | null
  } {
    const txn = this.db.transaction((input: ThreadCheckpointRevertRequest) => {
      this.assertThreadExists(input.thread_id)
      const boundary =
        input.turn_count === 0
          ? {
              message_id: null,
              sequence: -1,
              created_at: "",
            }
          : ((this.stmts.findCheckpointBoundaryByTurnCountStmt.get(
              input.thread_id,
              input.turn_count
            ) as
              | {
                  message_id: string | null
                  sequence: number
                  created_at: string
                }
              | undefined) ?? null)
      if (!boundary) {
        throw new HttpError(
          404,
          `checkpoint turn ${input.turn_count} not found`
        )
      }

      this.stmts.deleteActivitiesAfterTurnCountStmt.run(
        input.thread_id,
        input.thread_id,
        input.turn_count,
        input.thread_id,
        input.turn_count,
        boundary.created_at
      )
      this.stmts.deleteApprovalsAfterTurnCountStmt.run(
        input.thread_id,
        input.thread_id,
        input.turn_count,
        input.thread_id,
        input.turn_count
      )
      this.stmts.deleteCheckpointDiffsAfterTurnCountStmt.run(
        input.thread_id,
        input.thread_id,
        input.turn_count,
        input.thread_id,
        input.turn_count
      )
      for (const checkpointRef of input.stale_checkpoint_refs) {
        this.stmts.deleteCheckpointDiffByRefStmt.run(
          input.thread_id,
          checkpointRef
        )
      }
      this.stmts.deleteTurnsAfterTurnCountStmt.run(
        input.thread_id,
        input.thread_id,
        input.turn_count,
        input.thread_id,
        input.turn_count
      )
      this.stmts.deleteTurnDiffsAfterTurnCountStmt.run(
        input.thread_id,
        input.turn_count
      )
      this.stmts.revertChatDispatchesAfterMessageSequenceStmt.run(
        input.updated_at,
        input.thread_id,
        input.thread_id,
        boundary.sequence
      )
      const result = this.stmts.deleteMessagesAfterSequenceStmt.run(
        input.thread_id,
        boundary.sequence
      ) as { changes: number }
      this.syncThreadFromMessages(input.thread_id, input.updated_at)
      return {
        deletedMessages: result.changes,
        boundaryMessageId: boundary.message_id,
      }
    })
    return txn(req)
  }

  /** Set the Codex-side thread id for a given renderer thread. Called by
   *  the CodexCliAdapter after a successful `thread/start` so a later
   *  reload can resume instead of starting fresh. */
  setCodexThreadId(threadId: string, codexThreadId: string | null): void {
    this.stmts.setCodexThreadIdStmt.run(codexThreadId, threadId)
  }

  getCodexThreadId(threadId: string): string | null {
    const row = this.stmts.getCodexThreadIdStmt.get(threadId) as
      | { codex_thread_id: string | null }
      | undefined
    return row?.codex_thread_id ?? null
  }

  getThreadProjectPath(threadId: string): string | null {
    const row = this.stmts.getThreadProjectPathStmt.get(threadId) as
      | { project_path: string | null }
      | undefined
    return row?.project_path || null
  }

  listThreads(): unknown[] {
    return this.listThreadsPage().items
  }

  listThreadsPage(
    options: {
      limit?: number
      beforeUpdatedAt?: string | null
      beforeThreadId?: string | null
    } = {}
  ): {
    items: unknown[]
    next: { updatedAt: string; threadId: string } | null
  } {
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100)))
    const beforeUpdatedAt =
      typeof options.beforeUpdatedAt === "string" &&
      options.beforeUpdatedAt.length > 0
        ? options.beforeUpdatedAt
        : null
    const beforeThreadId =
      beforeUpdatedAt &&
      typeof options.beforeThreadId === "string" &&
      options.beforeThreadId.length > 0
        ? options.beforeThreadId
        : null
    const rows = (
      beforeThreadId
        ? this.stmts.listThreadsBeforeStmt.all(
            beforeUpdatedAt,
            beforeThreadId,
            limit + 1
          )
        : this.stmts.listThreadsStmt.all(limit + 1)
    ) as Array<ThreadSummaryRow>

    const pageRows = rows.slice(0, limit)
    const items = pageRows.map((row) => this.threadSummaryFromRow(row))
    const last = pageRows.at(-1)
    return {
      items,
      next:
        rows.length > limit && last
          ? { updatedAt: last.updated_at, threadId: last.thread_id }
          : null,
    }
  }

  /** One thread as `listThreadsPage` returns it; `null` when it does not exist or is archived. */
  getThreadSummary(threadId: string): unknown | null {
    const row = this.stmts.getThreadSummaryStmt.get(threadId, 1) as
      | ThreadSummaryRow
      | undefined
    return row ? this.threadSummaryFromRow(row) : null
  }

  private threadSummaryFromRow(row: ThreadSummaryRow) {
    return {
      id: row.thread_id,
      projectName: row.project_id,
      title: row.title ?? "New Chat",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      projectPath: row.project_path ?? "",
      envMode: normalizeOptionalString(row.env_mode) ?? "local",
      branch: normalizeOptionalString(row.branch),
      worktreePath: normalizeOptionalString(row.worktree_path),
      baseBranch: normalizeOptionalString(row.base_branch),
      worktreeState: normalizeOptionalString(row.worktree_state) ?? "none",
      parentThreadId: normalizeOptionalString(row.parent_thread_id),
      codexThreadId: row.codex_thread_id ?? null,
      ...(row.provider_goal_json !== null
        ? { goal: parsePersistedThreadGoal(row.provider_goal_json) }
        : {}),
      // Surface `message_count` so the sidebar can distinguish "real chat
      // not hydrated yet" from "empty + button placeholder" after reload.
      // `messages: []` is unavoidable here (they're lazily fetched via
      // listMessages), and by itself tells the renderer nothing.
      messageCount: row.message_count ?? 0,
      lastModelId: row.last_model_id ?? null,
      turnCount: row.turn_count ?? 0,
      session: this.threadSessionFromRow(row),
      messages: [],
    }
  }

  private updateThreadWorkspaceMetadata(thread: ThreadMetaUpsertRequest): void {
    const hasEnvMode = thread.env_mode !== undefined
    const hasBranch = thread.branch !== undefined
    const hasWorktreePath = thread.worktree_path !== undefined
    const hasBaseBranch = thread.base_branch !== undefined
    const hasWorktreeState = thread.worktree_state !== undefined
    if (
      !hasEnvMode &&
      !hasBranch &&
      !hasWorktreePath &&
      !hasBaseBranch &&
      !hasWorktreeState
    ) {
      return
    }
    this.stmts.updateThreadWorkspaceStmt.run(
      hasEnvMode ? 1 : 0,
      thread.env_mode ?? null,
      hasBranch ? 1 : 0,
      thread.branch ?? null,
      hasWorktreePath ? 1 : 0,
      thread.worktree_path ?? null,
      hasBaseBranch ? 1 : 0,
      thread.base_branch ?? null,
      hasWorktreeState ? 1 : 0,
      thread.worktree_state ?? null,
      thread.updated_at,
      thread.thread_id
    )
  }

  private updateThreadParentMetadata(thread: ThreadMetaUpsertRequest): void {
    if (thread.parent_thread_id === undefined) return
    this.stmts.updateThreadParentStmt.run(
      thread.parent_thread_id ?? null,
      thread.updated_at,
      thread.thread_id
    )
  }

  listMessages(
    threadId: string,
    options: { limit?: number; beforeSequence?: number | null } = {}
  ): unknown[] {
    const limit = Math.min(
      2_000,
      Math.max(1, Math.floor(options.limit ?? 1_000))
    )
    const beforeSequence =
      typeof options.beforeSequence === "number" &&
      Number.isSafeInteger(options.beforeSequence) &&
      options.beforeSequence >= 0
        ? options.beforeSequence
        : null
    const rows = this.stmts.listMessagesStmt.all(
      threadId,
      beforeSequence,
      beforeSequence,
      limit
    ) as Array<{
      message_id: string
      turn_id: string | null
      role: string
      content_json: string
      created_at: string
      sequence: number
    }>
    const exposeCursor =
      options.limit !== undefined || options.beforeSequence !== undefined
    return rows.reverse().map((row) => ({
      ...hydrateMessageRow(row),
      ...(exposeCursor ? { sequence: row.sequence } : {}),
    }))
  }

  getMessage(threadId: string, messageId: string): ThreadSaveMessage | null {
    const row = this.stmts.findDispatchMessageStmt.get(messageId) as
      | {
          thread_id: string
          turn_id: string | null
          role: string
          content_json: string
          created_at: string
        }
      | undefined
    if (!row || row.thread_id !== threadId) return null
    const stored = parseStoredMessage(row.content_json, {
      threadId,
      messageId,
    })
    return {
      message_id: messageId,
      turn_id: row.turn_id,
      role: row.role,
      content: stored.text,
      created_at: row.created_at,
      extra: stored.extra,
    }
  }

  buildProviderHistory(
    threadId: string,
    options: ProviderHistoryOptions = {}
  ): HistoryMessage[] {
    const maxMessages = Math.min(
      PROVIDER_HISTORY_MAX_MESSAGES,
      normalizedIntegerLimit(
        options.maxMessages,
        PROVIDER_HISTORY_MAX_MESSAGES,
        0
      )
    )
    const maxContentChars = Math.min(
      PROVIDER_HISTORY_MAX_CONTENT_CHARS,
      normalizedIntegerLimit(
        options.maxContentChars,
        PROVIDER_HISTORY_MAX_CONTENT_CHARS,
        0
      )
    )
    const maxBytes = Math.min(
      CHAT_HISTORY_MAX_BYTES,
      normalizedIntegerLimit(options.maxBytes, CHAT_HISTORY_MAX_BYTES, 2)
    )
    if (maxMessages === 0) return []
    const excludedMessageId = options.excludeMessageId ?? null
    const rows = this.stmts.providerHistoryMessagesStmt.all(
      threadId,
      excludedMessageId,
      excludedMessageId,
      maxMessages * PROVIDER_HISTORY_SCAN_MULTIPLIER + 1
    ) as Array<{
      message_id: string
      role: string
      content_json: string
      dispatch_status: ChatDispatchStatus | null
    }>
    const durableMessages = rows
      .reverse()
      .map((row): DurableProviderMessage => {
        const parsed = parseStoredMessage(row.content_json, {
          threadId,
          messageId: row.message_id,
        })
        return {
          messageId: row.message_id,
          role: row.role,
          content: parsed.text,
          extra: row.dispatch_status
            ? mergeChatDispatchMetadata(parsed.extra, row.dispatch_status)
            : parsed.extra,
        }
      })
    const activeMessages = activeProviderContext(durableMessages).filter(
      isProviderHistoryCandidate
    )
    const recentMessages =
      maxMessages === 0 ? [] : activeMessages.slice(-maxMessages)
    const groups: HistoryMessage[][] = []

    for (const message of recentMessages) {
      if (message.role === "user") {
        if (message.content.length > 0) {
          groups.push([
            {
              role: "user",
              content: clipProviderHistoryText(
                withBrowserElementContext(
                  message.content,
                  message.extra.attachments
                ),
                maxContentChars
              ),
            },
          ])
        }
        continue
      }
      if (message.role !== "assistant") continue

      const toolCalls = validatedProviderToolCalls(
        message.extra.toolCalls,
        maxContentChars
      )
      if (toolCalls.length === 0) {
        if (message.content.length > 0) {
          groups.push([
            {
              role: "assistant",
              content: clipProviderHistoryText(
                message.content,
                maxContentChars
              ),
            },
          ])
        }
        continue
      }

      const group: HistoryMessage[] = [
        {
          role: "assistant",
          content: clipProviderHistoryText(message.content, maxContentChars),
          tool_calls: toolCalls.map((toolCall) => toolCall.call),
        },
      ]
      for (const toolCall of toolCalls) {
        group.push({
          role: "tool",
          tool_call_id: toolCall.call.id,
          content: toolCall.result,
        })
      }
      groups.push(group)
    }

    return newestProviderHistoryGroups(groups, maxBytes)
  }

  stats(options: ThreadStatsOptions = {}): ThreadStats {
    const revision = (this.stmts.statsRevisionStmt.get() as { version: number })
      .version
    const key = JSON.stringify([
      options.days ?? null,
      options.projectPath ?? null,
    ])
    const cached = this.statsCache.get(key)
    if (cached?.revision === revision && cached.expires > Date.now())
      return structuredClone(cached.value)
    const value = this.computeStats(options)
    if (this.statsCache.size >= 32) this.statsCache.clear()
    // Time windows move even when storage is unchanged.
    this.statsCache.set(key, {
      revision,
      expires: Date.now() + 1_000,
      value: structuredClone(value),
    })
    return value
  }

  private computeStats(options: ThreadStatsOptions): ThreadStats {
    const cutoff = statsCutoffTime(options.days)
    const cutoffIso = Number.isFinite(cutoff)
      ? new Date(cutoff).toISOString()
      : null
    const projectPath = normalizeOptionalString(options.projectPath ?? null)
    const filteredThreads = (
      this.stmts.listStatsThreadsStmt.all(
        cutoffIso,
        cutoffIso,
        projectPath,
        projectPath
      ) as Array<{
        thread_id: string
        project_path: string | null
        created_at: string
        updated_at: string
      }>
    ).map((thread) => ({
      id: thread.thread_id,
      projectPath: thread.project_path,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
    }))

    const stats: ThreadStats = {
      totalSessions: filteredThreads.length,
      totalMessages: 0,
      totalCost: 0,
      totalTokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      toolUsage: {},
      modelUsage: {},
      providerUsage: {},
      dailyUsage: [],
      dateRange: {
        earliest: null,
        latest: null,
      },
      days: 0,
      costPerDay: 0,
      tokensPerSession: 0,
      medianTokensPerSession: 0,
    }

    if (filteredThreads.length === 0) {
      stats.days = statsWindowDays(options.days)
      return stats
    }

    let earliest = Number.POSITIVE_INFINITY
    let latest = 0
    const sessionTotals: number[] = []
    const aggregate = this.aggregateStatsForThreads(
      filteredThreads.map((thread) => thread.id),
      cutoffIso
    )

    for (const thread of filteredThreads) {
      const session = aggregate.sessions.get(thread.id) ?? {
        messages: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      }
      stats.totalMessages += session.messages
      const usage: MessageUsageStats = {
        input: session.input,
        output: session.output,
        reasoning: session.reasoning,
        cache: {
          read: session.cacheRead,
          write: session.cacheWrite,
        },
        cost: session.cost,
      }
      addTokens(stats.totalTokens, usage)
      stats.totalCost += session.cost
      sessionTotals.push(tokenTotal(usage))

      const created = Date.parse(thread.createdAt)
      const updated = Date.parse(thread.updatedAt)
      if (Number.isFinite(created)) earliest = Math.min(earliest, created)
      if (Number.isFinite(updated)) latest = Math.max(latest, updated)
    }

    stats.modelUsage = aggregate.models
    stats.providerUsage = aggregate.providers
    stats.dailyUsage = aggregate.daily
    stats.toolUsage = aggregate.tools

    const effectiveEarliest = Number.isFinite(earliest) ? earliest : Date.now()
    const effectiveLatest = latest > 0 ? latest : effectiveEarliest
    const rangeDays = Math.max(
      1,
      Math.ceil((effectiveLatest - effectiveEarliest) / (24 * 60 * 60 * 1000))
    )
    stats.dateRange = {
      earliest: new Date(effectiveEarliest).toISOString(),
      latest: new Date(effectiveLatest).toISOString(),
    }
    stats.days = statsWindowDays(options.days) || rangeDays
    stats.costPerDay = stats.totalCost / Math.max(1, stats.days)
    stats.tokensPerSession =
      filteredThreads.length > 0
        ? tokenTotal(stats.totalTokens) / filteredThreads.length
        : 0
    stats.medianTokensPerSession = median(sessionTotals)
    return stats
  }

  private aggregateStatsForThreads(
    threadIds: readonly string[],
    cutoffIso: string | null
  ): {
    sessions: Map<
      string,
      {
        messages: number
        input: number
        output: number
        reasoning: number
        cacheRead: number
        cacheWrite: number
        cost: number
      }
    >
    models: ThreadStats["modelUsage"]
    providers: ThreadStats["providerUsage"]
    daily: ThreadStats["dailyUsage"]
    tools: Record<string, number>
  } {
    const sessions = new Map<
      string,
      {
        messages: number
        input: number
        output: number
        reasoning: number
        cacheRead: number
        cacheWrite: number
        cost: number
      }
    >()
    const models: ThreadStats["modelUsage"] = Object.create(null)
    const providers: ThreadStats["providerUsage"] = Object.create(null)
    const daily: ThreadStats["dailyUsage"] = []
    const tools: Record<string, number> = Object.create(null)
    const chunkSize = 400
    for (let offset = 0; offset < threadIds.length; offset += chunkSize) {
      const chunk = threadIds.slice(offset, offset + chunkSize)
      const placeholders = chunk.map(() => "?").join(", ")
      const timePredicate = "(? IS NULL OR created_at >= ?)"
      const bindings = [...chunk, cutoffIso, cutoffIso]
      const sessionRows = this.db
        .prepare(
          `
        SELECT
          thread_id,
          COUNT(*) AS messages,
          SUM(input_tokens) AS input,
          SUM(output_tokens) AS output,
          SUM(reasoning_tokens) AS reasoning,
          SUM(cache_read_tokens) AS cache_read,
          SUM(cache_write_tokens) AS cache_write,
          SUM(cost) AS cost
        FROM projection_message_usage
        WHERE thread_id IN (${placeholders})
          AND ${timePredicate}
        GROUP BY thread_id
      `
        )
        .all(...bindings) as Array<{
        thread_id: string
        messages: number
        input: number
        output: number
        reasoning: number
        cache_read: number
        cache_write: number
        cost: number
      }>
      for (const row of sessionRows) {
        sessions.set(row.thread_id, {
          messages: finiteNumber(row.messages),
          input: finiteNumber(row.input),
          output: finiteNumber(row.output),
          reasoning: finiteNumber(row.reasoning),
          cacheRead: finiteNumber(row.cache_read),
          cacheWrite: finiteNumber(row.cache_write),
          cost: finiteNumber(row.cost),
        })
      }

      const modelRows = this.db
        .prepare(
          `
        SELECT
          model_id,
          COUNT(*) AS messages,
          SUM(input_tokens) AS input,
          SUM(output_tokens) AS output,
          SUM(reasoning_tokens) AS reasoning,
          SUM(cache_read_tokens) AS cache_read,
          SUM(cache_write_tokens) AS cache_write,
          SUM(cost) AS cost
        FROM projection_message_usage
        WHERE thread_id IN (${placeholders})
          AND ${timePredicate}
          AND role = 'assistant'
          AND typeof(model_id) = 'text'
        GROUP BY model_id
      `
        )
        .all(...bindings) as Array<{
        model_id: string
        messages: number
        input: number
        output: number
        reasoning: number
        cache_read: number
        cache_write: number
        cost: number
      }>
      for (const row of modelRows) {
        const current = models[row.model_id] ?? {
          messages: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
        }
        current.messages += finiteNumber(row.messages)
        current.tokens.input += finiteNumber(row.input)
        current.tokens.output += finiteNumber(row.output)
        current.tokens.reasoning += finiteNumber(row.reasoning)
        current.tokens.cache.read += finiteNumber(row.cache_read)
        current.tokens.cache.write += finiteNumber(row.cache_write)
        current.cost += finiteNumber(row.cost)
        models[row.model_id] = current
      }

      const providerRows = this.db
        .prepare(
          `
        SELECT
          COALESCE(turn.provider_kind, binding.provider_kind, 'unknown') AS provider_kind,
          COUNT(*) AS messages,
          SUM(usage.input_tokens) AS input,
          SUM(usage.output_tokens) AS output,
          SUM(usage.reasoning_tokens) AS reasoning,
          SUM(usage.cache_read_tokens) AS cache_read,
          SUM(usage.cache_write_tokens) AS cache_write,
          SUM(usage.cost) AS cost
        FROM projection_message_usage AS usage
        JOIN projection_messages AS message ON message.message_id = usage.message_id
        LEFT JOIN projection_turns AS turn ON turn.turn_id = message.turn_id
        LEFT JOIN provider_session_bindings AS binding ON binding.rowid = (
          SELECT rowid FROM provider_session_bindings AS latest_binding
          WHERE latest_binding.thread_id = usage.thread_id
          ORDER BY latest_binding.updated_at DESC, latest_binding.created_at DESC
          LIMIT 1
        )
        WHERE usage.thread_id IN (${placeholders})
          AND (? IS NULL OR usage.created_at >= ?)
          AND usage.role = 'assistant'
        GROUP BY COALESCE(turn.provider_kind, binding.provider_kind, 'unknown')
      `
        )
        .all(...bindings) as Array<{
        provider_kind: string
        messages: number
        input: number
        output: number
        reasoning: number
        cache_read: number
        cache_write: number
        cost: number
      }>
      for (const row of providerRows) {
        const current = providers[row.provider_kind] ?? {
          messages: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
        }
        current.messages += finiteNumber(row.messages)
        current.tokens.input += finiteNumber(row.input)
        current.tokens.output += finiteNumber(row.output)
        current.tokens.reasoning += finiteNumber(row.reasoning)
        current.tokens.cache.read += finiteNumber(row.cache_read)
        current.tokens.cache.write += finiteNumber(row.cache_write)
        current.cost += finiteNumber(row.cost)
        providers[row.provider_kind] = current
      }

      const dailyRows = this.db
        .prepare(
          `
        SELECT
          substr(usage.created_at, 1, 10) AS date,
          COALESCE(turn.provider_kind, binding.provider_kind, 'unknown') AS provider,
          SUM(usage.input_tokens + usage.output_tokens + usage.reasoning_tokens + usage.cache_read_tokens + usage.cache_write_tokens) AS tokens,
          SUM(usage.cost) AS cost
        FROM projection_message_usage AS usage
        JOIN projection_messages AS message ON message.message_id = usage.message_id
        LEFT JOIN projection_turns AS turn ON turn.turn_id = message.turn_id
        LEFT JOIN provider_session_bindings AS binding ON binding.rowid = (
          SELECT rowid FROM provider_session_bindings AS latest_binding
          WHERE latest_binding.thread_id = usage.thread_id
          ORDER BY latest_binding.updated_at DESC, latest_binding.created_at DESC
          LIMIT 1
        )
        WHERE usage.thread_id IN (${placeholders})
          AND (? IS NULL OR usage.created_at >= ?)
          AND usage.role = 'assistant'
        GROUP BY date, COALESCE(turn.provider_kind, binding.provider_kind, 'unknown')
        ORDER BY date ASC
      `
        )
        .all(...bindings) as Array<{
        date: string
        provider: string
        tokens: number
        cost: number
      }>
      daily.push(
        ...dailyRows.map((row) => ({
          date: row.date,
          provider: row.provider,
          tokens: finiteNumber(row.tokens),
          cost: finiteNumber(row.cost),
        }))
      )

      const toolRows = this.db
        .prepare(
          `
        SELECT
          tool.value AS tool_name,
          COUNT(*) AS uses
        FROM projection_message_usage AS message
        JOIN json_each(message.tools_json) AS tool
        WHERE message.thread_id IN (${placeholders})
          AND (? IS NULL OR message.created_at >= ?)
          AND typeof(tool.value) = 'text'
        GROUP BY tool_name
      `
        )
        .all(...bindings) as Array<{ tool_name: string; uses: number }>
      for (const row of toolRows) {
        tools[row.tool_name] =
          (tools[row.tool_name] ?? 0) + finiteNumber(row.uses)
      }
    }
    return { sessions, models, providers, daily, tools }
  }

  delete(threadId: string): void {
    const txn = this.db.transaction((id: string) => {
      this.deleteThreadGraph(id)
    })
    txn(threadId)
  }

  private deleteThreadGraph(threadId: string): void {
    this.stmts.deleteMessagesStmt.run(threadId)
    this.stmts.deleteActivitiesStmt.run(threadId)
    this.stmts.deleteApprovalsStmt.run(threadId)
    this.stmts.deleteCheckpointDiffsStmt.run(threadId)
    this.stmts.deleteTurnDiffsStmt.run(threadId)
    this.stmts.deleteProviderSessionsStmt.run(threadId)
    this.stmts.deleteProviderSessionBindingsStmt.run(threadId)
    this.stmts.deleteThreadCommandReceiptsStmt.run(threadId)
    this.stmts.deleteProviderRuntimeEventsStmt.run(threadId)
    this.stmts.deleteThreadOrchestrationEventsStmt.run(threadId)
    this.stmts.deleteCheckpointRevertQuarantineStmt.run(threadId)
    this.stmts.deleteTurnsStmt.run(threadId)
    this.stmts.deleteWorktreeRegistryStmt.run(threadId)
    this.stmts.clearChildThreadParentsStmt.run(threadId)
    this.stmts.deleteThreadStmt.run(threadId)
  }

  listProjects(): unknown[] {
    const rows = this.stmts.listProjectsStmt.all() as Array<{
      project_id: string
      project_path: string | null
    }>
    return rows.map((row) => ({
      name: row.project_id,
      path: row.project_path ?? "",
    }))
  }

  loadHistory(threadId: string): HistoryMessage[] {
    const rows = this.stmts.loadHistoryStmt.all(threadId) as Array<{
      role: string
      content_json: string
    }>
    return rows.map((row) => {
      let parsed: { text?: string } = {}
      try {
        parsed = JSON.parse(row.content_json)
      } catch {
        // ignore and fall through to empty content
      }
      return { role: row.role, content: parsed.text ?? "" }
    })
  }

  /**
   * Retention: mark every 'active' thread whose `updated_at` is older than
   * `olderThanDays` as `'archived'` and stamp `archived_at`.  Does not delete
   * anything — purge runs as a second step via {@link purgeArchivedOlderThan}.
   * Returns the number of threads that transitioned.
   */
  archiveOldThreads(olderThanDays: number): number {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) return 0
    const now = new Date()
    const cutoffIso = new Date(
      now.getTime() - olderThanDays * 86_400_000
    ).toISOString()
    const res = this.db
      .prepare(
        `UPDATE projection_threads
           SET status = 'archived', archived_at = ?
         WHERE status = 'active'
           AND COALESCE(recovery_required, 0) = 0
           AND NOT EXISTS (
             SELECT 1
             FROM checkpoint_revert_operations
             WHERE checkpoint_revert_operations.thread_id =
               projection_threads.thread_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM checkpoint_revert_quarantine
             WHERE checkpoint_revert_quarantine.thread_id =
               projection_threads.thread_id
           )
           AND updated_at < ?`
      )
      .run(now.toISOString(), cutoffIso)
    return res.changes as number
  }

  /**
   * Returns retention candidates without mutating their graph. Physical
   * worktrees and provider sessions live outside this SQLite transaction, so
   * callers must run the normal lifecycle teardown before invoking delete().
   */
  purgeArchivedOlderThan(olderThanDays: number, limit = 50): string[] {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) return []
    const boundedLimit = Math.min(
      500,
      Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50)
    )
    const cutoffIso = new Date(
      Date.now() - olderThanDays * 86_400_000
    ).toISOString()

    const selectStmt = this.db.prepare(
      `SELECT thread_id FROM projection_threads
         WHERE status = 'archived'
           AND COALESCE(recovery_required, 0) = 0
           AND NOT EXISTS (
             SELECT 1
             FROM checkpoint_revert_operations
             WHERE checkpoint_revert_operations.thread_id =
               projection_threads.thread_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM checkpoint_revert_quarantine
             WHERE checkpoint_revert_quarantine.thread_id =
               projection_threads.thread_id
           )
           AND archived_at IS NOT NULL
           AND archived_at < ?
         ORDER BY archived_at ASC, thread_id ASC
         LIMIT ?`
    )
    return (
      selectStmt.all(cutoffIso, boundedLimit) as Array<{ thread_id: string }>
    ).map((row) => row.thread_id)
  }
}

interface DurableProviderMessage {
  messageId: string
  role: string
  content: string
  extra: Record<string, unknown>
}

interface ValidatedProviderToolCall {
  call: { id: string; name: string; input: unknown }
  result: string
  startedAt: string
}

function activeProviderContext(
  messages: ReadonlyArray<DurableProviderMessage>
): DurableProviderMessage[] {
  let compactionIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const previous = messages[index - 1]
    if (
      message?.role === "assistant" &&
      (message.extra.compactedContext === true ||
        (message.content.startsWith(COMPACTED_CONTEXT_HEADING) &&
          previous?.role === "user" &&
          /^\/compact(?:\s|$)/iu.test(previous.content.trim())))
    ) {
      compactionIndex = index
      break
    }
  }
  return compactionIndex < 0 ? [...messages] : messages.slice(compactionIndex)
}

function validatedProviderToolCalls(
  raw: unknown,
  maxContentChars: number
): ValidatedProviderToolCall[] {
  if (!Array.isArray(raw)) return []
  const validated: ValidatedProviderToolCall[] = []
  const seenIds = new Set<string>()
  for (const value of raw.slice(0, PROVIDER_HISTORY_MAX_TOOL_CALL_SCAN)) {
    if (validated.length >= PROVIDER_HISTORY_MAX_TOOL_CALLS) break
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const toolCall = value as Record<string, unknown>
    if (
      typeof toolCall.id !== "string" ||
      toolCall.id.trim().length === 0 ||
      typeof toolCall.name !== "string" ||
      toolCall.name.trim().length === 0
    ) {
      continue
    }
    if (seenIds.has(toolCall.id)) continue
    seenIds.add(toolCall.id)
    validated.push({
      call: {
        id: toolCall.id,
        name: toolCall.name,
        input: serializableProviderToolInput(toolCall.input, maxContentChars),
      },
      result: clipProviderHistoryText(
        providerToolResultText(toolCall),
        maxContentChars
      ),
      startedAt:
        typeof toolCall.startedAt === "string" ? toolCall.startedAt : "",
    })
  }
  return validated.sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt)
  )
}

function isProviderHistoryCandidate(message: DurableProviderMessage): boolean {
  if (message.role === "user") {
    return message.extra.dispatchFailed !== true && message.content.length > 0
  }
  if (message.role !== "assistant") return false
  return message.content.length > 0 || Array.isArray(message.extra.toolCalls)
}

function providerToolResultText(toolCall: Record<string, unknown>): string {
  if (typeof toolCall.output === "string") return toolCall.output
  if (typeof toolCall.outputPreview === "string") return toolCall.outputPreview
  if (toolCall.output != null) {
    try {
      return JSON.stringify(toolCall.output)
    } catch {
      return safeString(toolCall.output)
    }
  }
  return typeof toolCall.error === "string" ? toolCall.error : ""
}

function serializableProviderToolInput(
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
    const fallback = safeString(input)
    return fallback.length > maxContentChars
      ? `${fallback.slice(0, maxContentChars)}\n\n[…truncated tool input for transport…]`
      : fallback
  }
}

function safeString(value: unknown): string {
  try {
    return String(value)
  } catch {
    return "[unserializable value]"
  }
}

function clipProviderHistoryText(
  text: string,
  maxContentChars: number
): string {
  return text.length > maxContentChars
    ? `${text.slice(0, maxContentChars)}\n\n[…truncated for transport…]`
    : text
}

function newestProviderHistoryGroups(
  groups: ReadonlyArray<ReadonlyArray<HistoryMessage>>,
  maxBytes: number
): HistoryMessage[] {
  const selected: HistoryMessage[][] = []
  let selectedMessages = 0
  let serializedBytes = 2

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    if (!group || group.length === 0) continue
    if (selectedMessages + group.length > PROVIDER_HISTORY_MAX_WIRE_MESSAGES) {
      break
    }
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

function normalizedIntegerLimit(
  value: number | undefined,
  fallback: number,
  minimum: number
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback
}

interface PersistedMessageRow {
  message_id: string
  turn_id: string | null
  role: string
  content_json: string
  created_at: string
  sequence: number
  runtime_sequence: number | null
}

/**
 * Rows the backend wrote on its own authority, which a renderer full save
 * may move but never drop or rewrite. Two kinds:
 *
 * - Provider runtime rows. The runtime projection and transcript recovery
 *   stamp every row they write with `extra.providerRuntimeSequence`,
 *   projected into `projection_message_usage.runtime_sequence`; that marker
 *   — not the role — is what makes a row runtime-owned.
 * - Compaction checkpoints (`extra.compactedContext === true`), written by
 *   `commitCompaction` for `/compact` and automatic compaction. They carry
 *   no runtime sequence and are not dispatch rows, so nothing else guards
 *   them — yet dropping one collapses the compaction window:
 *   `activeProviderContext` would fall back to the full transcript and the
 *   next turn would resend everything the compaction had summarised away.
 *
 * The renderer writes assistant rows of its own (slash-command output, fork
 * copies) and those stay its to edit and delete.
 */
function isRuntimeAuthoredMessageRow(row: PersistedMessageRow): boolean {
  if (
    typeof row.runtime_sequence === "number" &&
    Number.isFinite(row.runtime_sequence)
  ) {
    return true
  }
  return isCompactionCheckpointRow(row)
}

function isCompactionCheckpointRow(row: PersistedMessageRow): boolean {
  if (row.role !== "assistant") return false
  // Cheap pre-check: the save loop runs this over every persisted row.
  if (!row.content_json.includes("compactedContext")) return false
  const parsed = parseJsonOrNull(row.content_json, {
    threadId: null,
    messageId: row.message_id,
  }) as { extra?: { compactedContext?: unknown } } | null
  return parsed?.extra?.compactedContext === true
}

interface StoredJsonContext {
  readonly threadId?: string | null
  readonly messageId?: string | null
  readonly column?: string
}

/**
 * A stored column that fails to parse is data loss the user cannot see from
 * the transcript, so it is logged instead of silently becoming `null`.
 */
function parseJsonOrNull(
  raw: string | null,
  context: StoredJsonContext = {}
): unknown | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        threadId: context.threadId ?? null,
        messageId: context.messageId ?? null,
        column: context.column ?? "content_json",
        bytes: raw.length,
      },
      "stored JSON column is corrupt; treating it as empty"
    )
    return null
  }
}

function parseStoredMessage(
  raw: string,
  context: StoredJsonContext = {}
): {
  text: string
  extra: Record<string, unknown>
} {
  const value = parseJsonOrNull(raw, context)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { text: "", extra: {} }
  }
  const record = value as Record<string, unknown>
  return {
    text: typeof record.text === "string" ? record.text : "",
    extra:
      record.extra &&
      typeof record.extra === "object" &&
      !Array.isArray(record.extra)
        ? (record.extra as Record<string, unknown>)
        : {},
  }
}

function normalizeOptionalString(
  raw: string | null | undefined
): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

type ThreadTokenTotals = ThreadStats["totalTokens"]

type MessageUsageStats = {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
  cost: number
}

function statsCutoffTime(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return 0
  if (days <= 0) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return today.getTime()
  }
  return Date.now() - days * 24 * 60 * 60 * 1000
}

function statsWindowDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return 0
  return days <= 0 ? 1 : Math.ceil(days)
}

function finiteNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function addTokens(target: ThreadTokenTotals, usage: MessageUsageStats): void {
  target.input += usage.input
  target.output += usage.output
  target.reasoning += usage.reasoning
  target.cache.read += usage.cache.read
  target.cache.write += usage.cache.write
}

function tokenTotal(value: ThreadTokenTotals | MessageUsageStats): number {
  return (
    value.input +
    value.output +
    value.reasoning +
    value.cache.read +
    value.cache.write
  )
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

function parsePersistedThreadGoal(
  value: string | null
): ThreadGoal | null | undefined {
  if (value === null) return undefined
  try {
    const parsed = threadGoalSchema.nullable().safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
