import { parseTurnDiffFilesFromUnifiedDiff } from "@betterc0de/schema"
import {
  THREAD_REWIND_MAX_LISTED_FILES,
  type ThreadRewindFileRevertBlocker,
  type ThreadRewindPlan,
  type ThreadRewindResult,
} from "@betterc0de/schema/http-contracts"
import type { AppState } from "../appState"
import { HttpError } from "../errors"
import { logger } from "../observability/logger"
import type { Db } from "../persistence/db"
import type { ProviderSessionBinding } from "../provider/runtime/ProviderSessionBindingStore"
import type { ThreadId } from "../provider/runtime/contracts"
import {
  latestCheckpointTurnCount,
  resolveTargetCheckpointRef,
  revertThreadCheckpoint,
  withCheckpointMaintenance,
} from "./checkpoint-revert-saga"
import {
  recoveryWorkspacesForThread,
  withCheckpointRecoveryMutation,
} from "./checkpoint-recovery-fence"
import * as git from "./git"

/**
 * Edit and resend: the chat goes back to just before one of the user's
 * messages, which the client then sends again with new text.
 *
 * Two ways back, both built on the existing revert machinery:
 * - Keep file changes: the agent's session forgets the removed turns (rolled
 *   back in place, or reset so the next turn starts from the stored chat)
 *   and the stored chat is cut before the message.
 * - Revert files too: the checkpoint revert saga restores the folder to the
 *   last checkpoint before the message, rolls the session back and cuts the
 *   chat in one journaled operation.
 */

/** A turn's checkpoint row: where its last message sits in the chat. */
export interface RewindTurnRow {
  readonly turnIndex: number
  /** Sequence of the turn's last message; -1 when it is unknown (older data). */
  readonly boundarySequence: number
}

/** The edited message and what removing it with everything after it means. */
export interface ThreadRewindAnchor {
  readonly sequence: number
  readonly role: string
  readonly createdAt: string
  /** Messages from the anchor on, the anchor included. */
  readonly removedMessages: number
  /** Agent turns that answered in the removed range. */
  readonly assistantTurns: number
  /** Provider dispatches started for messages in the removed range. */
  readonly dispatchedTurns: number
  /** A compaction or provider handoff in the range began a new session. */
  readonly crossesSessionBoundary: boolean
}

export type ProviderRewindAction =
  | { readonly kind: "none" }
  | { readonly kind: "rollback"; readonly turns: number }
  | { readonly kind: "reset" }

/**
 * The checkpoint turn the files go back to: the last turn that ended before
 * the message. The walk stops at the first turn that ended at or after the
 * message; a turn whose end is unknown before that point makes the answer
 * unknown (`null`), since restoring past it could undo work the kept
 * messages describe. Turn 0 is the folder before the chat's first turn.
 */
export function checkpointTurnBeforeMessage(
  messageSequence: number,
  turns: readonly RewindTurnRow[]
): number | null {
  let target = 0
  const ordered = [...turns].sort((a, b) => a.turnIndex - b.turnIndex)
  for (const turn of ordered) {
    if (turn.boundarySequence < 0) return null
    if (turn.boundarySequence >= messageSequence) break
    target = turn.turnIndex
  }
  return target
}

/** Unique file paths named by unified diffs, in first-seen order. */
export function changedFilesFromDiffs(
  diffs: readonly string[],
  limit: number = THREAD_REWIND_MAX_LISTED_FILES
): { files: string[]; truncated: boolean } {
  const seen = new Set<string>()
  for (const diff of diffs) {
    for (const file of parseTurnDiffFilesFromUnifiedDiff(diff)) {
      if (file.path) seen.add(file.path)
    }
  }
  const files = [...seen]
  return { files: files.slice(0, limit), truncated: files.length > limit }
}

/**
 * How the agent's session forgets the removed turns. A rollback needs an
 * exact count of turns in the live session; whenever that count is in doubt
 * (a compaction or provider switch began a new session inside the range,
 * or the dispatches and the answers disagree) the session is reset instead
 * and the next turn starts from the stored chat.
 */
export function providerRewindAction(
  anchor: Pick<
    ThreadRewindAnchor,
    "assistantTurns" | "dispatchedTurns" | "crossesSessionBoundary"
  >
): ProviderRewindAction {
  const { assistantTurns, dispatchedTurns, crossesSessionBoundary } = anchor
  if (crossesSessionBoundary) return { kind: "reset" }
  if (assistantTurns === 0 && dispatchedTurns === 0) return { kind: "none" }
  if (dispatchedTurns > 0 && dispatchedTurns !== assistantTurns) {
    return { kind: "reset" }
  }
  return { kind: "rollback", turns: assistantTurns }
}

/** Reads the edited message and the range a rewind would remove. */
export function readThreadRewindAnchor(
  db: Db,
  threadId: string,
  messageId: string
): ThreadRewindAnchor | null {
  const message = db
    .prepare(
      `SELECT sequence, role, created_at
       FROM projection_messages
       WHERE thread_id = ? AND message_id = ?`
    )
    .get(threadId, messageId) as
    | { sequence: number; role: string; created_at: string }
    | undefined
  if (!message) return null
  const range = db
    .prepare(
      `SELECT
         COUNT(*) AS removed_messages,
         COUNT(DISTINCT CASE WHEN role = 'assistant' THEN turn_id END)
           AS assistant_turns,
         COALESCE(SUM(
           CASE
             WHEN NOT json_valid(content_json) THEN 0
             WHEN json_extract(content_json, '$.extra.compactedContext') = 1
               THEN 1
             WHEN json_extract(content_json, '$.extra.internalContext')
               = 'provider-handoff'
               THEN 1
             ELSE 0
           END
         ), 0) AS session_boundaries
       FROM projection_messages
       WHERE thread_id = ? AND sequence >= ?`
    )
    .get(threadId, message.sequence) as {
    removed_messages: number
    assistant_turns: number
    session_boundaries: number
  }
  const dispatches = db
    .prepare(
      `SELECT COUNT(*) AS dispatched
       FROM chat_dispatches
       WHERE thread_id = ?
         AND status IN ('accepted', 'completed', 'uncertain')
         AND message_id IN (
           SELECT message_id
           FROM projection_messages
           WHERE thread_id = ? AND sequence >= ?
         )`
    )
    .get(threadId, threadId, message.sequence) as { dispatched: number }
  return {
    sequence: message.sequence,
    role: message.role,
    createdAt: message.created_at,
    removedMessages: range.removed_messages,
    assistantTurns: range.assistant_turns,
    dispatchedTurns: dispatches.dispatched,
    crossesSessionBoundary: range.session_boundaries > 0,
  }
}

/** Every checkpoint turn of the thread, without diff bodies. */
export function readRewindTurns(db: Db, threadId: string): RewindTurnRow[] {
  const rows = db
    .prepare(
      `SELECT turn_index, boundary_sequence
       FROM turn_diffs
       WHERE thread_id = ?
       ORDER BY turn_index ASC`
    )
    .all(threadId) as Array<{ turn_index: number; boundary_sequence: number }>
  return rows.map((row) => ({
    turnIndex: row.turn_index,
    boundarySequence: row.boundary_sequence,
  }))
}

/** Diff bodies read for a plan; older turns past this are not listed. */
const MAX_PLAN_DIFF_TURNS = 50

/**
 * Files the turns after the anchor changed. With a known checkpoint turn
 * that is every later turn; without one, the turns known to have ended at
 * or after the message.
 */
function readChangedFiles(
  db: Db,
  threadId: string,
  anchorSequence: number,
  checkpointTurn: number | null
): { files: string[]; truncated: boolean } {
  const condition =
    checkpointTurn === null
      ? "turn.boundary_sequence >= ?"
      : "turn.turn_index > ?"
  const rows = db
    .prepare(
      `SELECT COALESCE(blob.diff_content, turn.diff_text) AS diff_text
       FROM turn_diffs AS turn
       LEFT JOIN diff_blobs AS blob
         ON blob.blob_id = turn.diff_blob_id
       WHERE turn.thread_id = ? AND ${condition}
       ORDER BY turn.turn_index ASC
       LIMIT ?`
    )
    .all(
      threadId,
      checkpointTurn === null ? anchorSequence : checkpointTurn,
      MAX_PLAN_DIFF_TURNS + 1
    ) as Array<{ diff_text: string | null }>
  const changed = changedFilesFromDiffs(
    rows.slice(0, MAX_PLAN_DIFF_TURNS).map((row) => row.diff_text ?? "")
  )
  return {
    files: changed.files,
    truncated: changed.truncated || rows.length > MAX_PLAN_DIFF_TURNS,
  }
}

function conversationsSaved(state: Pick<AppState, "settings">): boolean {
  try {
    return state.settings.get().auto_save_conversations !== false
  } catch {
    return false
  }
}

function requireUserAnchor(
  anchor: ThreadRewindAnchor | null,
  messageId: string
): ThreadRewindAnchor {
  if (!anchor) {
    throw new HttpError(
      404,
      `message ${messageId} not found`,
      "message_not_found"
    )
  }
  if (anchor.role !== "user") {
    throw new HttpError(
      400,
      "Only your own messages can be edited and resent.",
      "rewind_not_user_message"
    )
  }
  return anchor
}

async function fileRevertBlocker(
  state: AppState,
  threadId: string,
  checkpointTurn: number | null
): Promise<ThreadRewindFileRevertBlocker | null> {
  // The saga restores the folder the agent's session runs in.
  const cwd = state.providerSessionBindings.getLatestForThread(threadId)?.cwd
  if (!cwd) return "no_session"
  if (!(await git.isRepo(cwd)).is_repo) return "not_git"
  if (checkpointTurn === null) return "no_checkpoint"
  if (checkpointTurn >= latestCheckpointTurnCount(state, threadId)) {
    return "no_changes"
  }
  const checkpointRef = resolveTargetCheckpointRef(
    threadId,
    checkpointTurn,
    state.checkpointDiffs.listCheckpointRefsByThread(threadId)
  )
  if (!checkpointRef) return "no_checkpoint"
  const exists = await git
    .hasCheckpointRef({ cwd, checkpointRef })
    .catch(() => false)
  return exists ? null : "no_checkpoint"
}

/** What rewinding to just before `messageId` would remove and allow. */
export async function readThreadRewindPlan(
  state: AppState,
  threadId: string,
  messageId: string
): Promise<ThreadRewindPlan> {
  const stored = readThreadRewindAnchor(state.db, threadId, messageId)
  if (!stored && !conversationsSaved(state)) {
    // Saving is off: nothing is stored, so there is nothing to restore.
    return {
      messageId,
      removedMessages: 0,
      changedFiles: [],
      changedFilesTruncated: false,
      fileRevert: {
        available: false,
        blocker: "unsaved",
        checkpointTurn: null,
      },
    }
  }
  const anchor = requireUserAnchor(stored, messageId)
  const checkpointTurn = checkpointTurnBeforeMessage(
    anchor.sequence,
    readRewindTurns(state.db, threadId)
  )
  const changed = readChangedFiles(
    state.db,
    threadId,
    anchor.sequence,
    checkpointTurn
  )
  const blocker = await fileRevertBlocker(state, threadId, checkpointTurn)
  return {
    messageId,
    removedMessages: anchor.removedMessages,
    changedFiles: changed.files,
    changedFilesTruncated: changed.truncated,
    fileRevert: { available: blocker === null, blocker, checkpointTurn },
  }
}

function refused(reason: string): ThreadRewindResult {
  return {
    rewound: false,
    revertedFiles: false,
    deletedMessages: 0,
    rolledBackTurns: 0,
    providerSession: "unchanged",
    reason,
  }
}

/** Ends the session and starts a new generation: the next turn replays the stored chat. */
async function resetProviderSession(
  state: AppState,
  binding: ProviderSessionBinding
): Promise<void> {
  await state.providerHub.stopSession(
    binding.providerKind,
    binding.threadId as ThreadId,
    binding.providerInstanceId
  )
  state.providerSessionBindings.rotateGeneration(
    binding.threadId,
    binding.providerInstanceId
  )
}

async function forgetProviderTurns(
  state: AppState,
  threadId: string,
  action: ProviderRewindAction
): Promise<Pick<ThreadRewindResult, "providerSession" | "rolledBackTurns">> {
  const unchanged = {
    providerSession: "unchanged",
    rolledBackTurns: 0,
  } as const
  if (action.kind === "none") return unchanged
  const binding = state.providerSessionBindings.getLatestForThread(threadId)
  // Without a session nothing holds those turns; the next one starts from
  // the stored chat.
  if (!binding) return unchanged
  if (action.kind === "rollback") {
    try {
      const rolledBack = await state.providerHub.rollbackConversation(
        binding.providerKind,
        threadId as ThreadId,
        action.turns,
        binding.providerInstanceId,
        state.providerSessionBindings
      )
      if (rolledBack) {
        return { providerSession: "rolled_back", rolledBackTurns: action.turns }
      }
    } catch (error) {
      logger.warn(
        {
          err: error,
          threadId,
          providerKind: binding.providerKind,
          providerInstanceId: binding.providerInstanceId,
        },
        "provider rollback failed during rewind; resetting the session instead"
      )
    }
  }
  await resetProviderSession(state, binding)
  return { providerSession: "reset", rolledBackTurns: 0 }
}

async function rewindKeepingFiles(
  state: AppState,
  input: { threadId: string; messageId: string; updatedAt: string }
): Promise<ThreadRewindResult> {
  const { threadId, messageId, updatedAt } = input
  return withCheckpointRecoveryMutation<ThreadRewindResult>(
    state,
    {
      threadIds: [threadId],
      workspaces: recoveryWorkspacesForThread(state, threadId),
    },
    () =>
      withCheckpointMaintenance<ThreadRewindResult>(
        state,
        threadId,
        async () => {
          const anchor = requireUserAnchor(
            readThreadRewindAnchor(state.db, threadId, messageId),
            messageId
          )
          // The session forgets first: if that fails, the chat is untouched.
          const session = await forgetProviderTurns(
            state,
            threadId,
            providerRewindAction(anchor)
          )
          const { deletedMessages } = state.threads.truncateFromMessage({
            thread_id: threadId,
            message_id: messageId,
            updated_at: updatedAt,
          })
          // The next turn takes the slot after the last kept checkpoint. The
          // chat is already cut, so a failure here is logged, not returned.
          try {
            state.checkpointTurnSlots.reconcileThread(threadId)
          } catch (error) {
            logger.error(
              { err: error, threadId },
              "checkpoint turn slots could not be reconciled after a rewind"
            )
          }
          return {
            rewound: true,
            revertedFiles: false,
            deletedMessages,
            ...session,
          }
        }
      )
  )
}

async function rewindRevertingFiles(
  state: AppState,
  input: { threadId: string; messageId: string; updatedAt: string }
): Promise<ThreadRewindResult> {
  const { threadId, messageId, updatedAt } = input
  return withCheckpointMaintenance<ThreadRewindResult>(
    state,
    threadId,
    async () => {
      const anchor = requireUserAnchor(
        readThreadRewindAnchor(state.db, threadId, messageId),
        messageId
      )
      const checkpointTurn = checkpointTurnBeforeMessage(
        anchor.sequence,
        readRewindTurns(state.db, threadId)
      )
      if (checkpointTurn === null) {
        return refused("There is no checkpoint for this point in the chat.")
      }
      if (checkpointTurn >= latestCheckpointTurnCount(state, threadId)) {
        return refused(
          "No agent turn after this point has a checkpoint to undo."
        )
      }
      const reverted = await revertThreadCheckpoint({
        state,
        threadId,
        turnCount: checkpointTurn,
        updatedAt,
      })
      if (!reverted.reverted) {
        return refused(
          reverted.reason ?? "The checkpoint could not be restored."
        )
      }
      // The saga cut the chat after the checkpoint turn's last message, which
      // ends before the edited one; this only runs if a later row survived.
      let deletedMessages = reverted.deletedMessages
      if (readThreadRewindAnchor(state.db, threadId, messageId)) {
        deletedMessages += state.threads.truncateFromMessage({
          thread_id: threadId,
          message_id: messageId,
          updated_at: updatedAt,
        }).deletedMessages
      }
      return {
        rewound: true,
        revertedFiles: true,
        deletedMessages,
        rolledBackTurns: reverted.rolledBackTurns,
        providerSession:
          reverted.rolledBackTurns > 0 ? "rolled_back" : "unchanged",
      }
    }
  )
}

/**
 * Rewinds the chat to just before `messageId`, a message of the user's.
 * Refuses (409 `turn_active`) while a turn runs.
 */
export async function rewindThreadToMessage(
  state: AppState,
  input: {
    readonly threadId: string
    readonly messageId: string
    readonly revertFiles: boolean
    readonly updatedAt: string
  }
): Promise<ThreadRewindResult> {
  const { threadId, messageId } = input
  const stored = readThreadRewindAnchor(state.db, threadId, messageId)
  if (!stored && !conversationsSaved(state)) {
    if (input.revertFiles) {
      return refused("This chat isn't saved, so it has no checkpoints.")
    }
    // Nothing is stored to cut; only the agent's session has to forget,
    // and without stored turns to count it is reset.
    return withCheckpointMaintenance<ThreadRewindResult>(
      state,
      threadId,
      async () => {
        const session = await forgetProviderTurns(state, threadId, {
          kind: "reset",
        })
        return {
          rewound: true,
          revertedFiles: false,
          deletedMessages: 0,
          ...session,
        }
      }
    )
  }
  requireUserAnchor(stored, messageId)
  return input.revertFiles
    ? rewindRevertingFiles(state, input)
    : rewindKeepingFiles(state, input)
}
