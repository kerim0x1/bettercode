import type { Db } from "../../persistence/db"

// The page is a derived table (a co-routine in the plan), never a
// materialised CTE: the LIMIT bounds it to one page and the latest
// binding is looked up per page row through
// idx_provider_bindings_thread_updated, so nothing scales with the
// number of bindings or threads outside the page.
/**
 * Thread summaries (list rows) with their latest provider session binding:
 * the newest page, the page before a cursor, or one thread by id.
 */
const threadPageSql = (filter: "newest" | "before" | "id") => `
  SELECT
    thread.thread_id,
    thread.project_id,
    thread.title,
    thread.created_at,
    thread.updated_at,
    thread.project_path,
    thread.env_mode,
    thread.branch,
    thread.worktree_path,
    thread.base_branch,
    thread.worktree_state,
    thread.parent_thread_id,
    thread.codex_thread_id,
    thread.provider_goal_json,
    thread.message_count,
    thread.turn_count,
    (SELECT usage.model_id FROM projection_messages AS message
     JOIN projection_message_usage AS usage ON usage.message_id = message.message_id
     WHERE message.thread_id = thread.thread_id AND message.role = 'assistant'
       AND usage.model_id IS NOT NULL AND usage.model_id <> ''
     ORDER BY message.sequence DESC
     LIMIT 1) AS last_model_id,
    binding.provider_kind,
    binding.provider_instance_id,
    binding.provider_thread_id,
    binding.resume_cursor_json,
    binding.continuation_key,
    binding.status AS session_status,
    binding.active_turn_id,
    binding.last_error,
    binding.runtime_mode,
    binding.cwd AS session_cwd,
    binding.model_selection_json,
    binding.updated_at AS session_updated_at
  FROM (
    SELECT * FROM projection_threads
    WHERE status = 'active'
      ${filter === "before" ? "AND (updated_at, thread_id) < (?, ?)" : ""}
      ${filter === "id" ? "AND thread_id = ?" : ""}
    ORDER BY updated_at DESC, thread_id DESC
    LIMIT ?
  ) AS thread
  LEFT JOIN provider_session_bindings AS binding ON binding.rowid = (
    SELECT rowid FROM provider_session_bindings
    WHERE thread_id = thread.thread_id
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  )
  ORDER BY thread.updated_at DESC, thread.thread_id DESC
`

/**
 * Every prepared statement the thread service runs, compiled once per
 * service instance. Keeping the SQL in one place separates *what the store
 * looks like* from *how the service sequences writes*; the service reads
 * these through `this.stmts`.
 */
export function prepareThreadStatements(db: Db) {
  return {
    statsRevisionStmt: db.prepare(
      "SELECT version FROM backend_read_revisions WHERE name = 'stats'"
    ),
    upsertThreadStmt: db.prepare(`
      INSERT INTO projection_threads
        (thread_id, project_id, title, status, env_mode, created_at, updated_at, message_count, turn_count, project_path, codex_thread_id)
      VALUES (?, ?, ?, 'active', 'local', ?, ?, 0, 0, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        updated_at = excluded.updated_at,
        project_path = excluded.project_path,
        codex_thread_id = COALESCE(excluded.codex_thread_id, projection_threads.codex_thread_id)
    `),
    ensureThreadForTurnStmt: db.prepare(`
      INSERT INTO projection_threads
        (thread_id, project_id, title, status, env_mode, created_at, updated_at, message_count, turn_count, project_path, codex_thread_id)
      VALUES (?, ?, ?, 'active', 'local', ?, ?, 0, 0, ?, NULL)
      ON CONFLICT(thread_id) DO NOTHING
    `),
    deleteMessagesStmt: db.prepare(`
      DELETE FROM projection_messages WHERE thread_id = ?
    `),
    deleteActivitiesStmt: db.prepare(`
      DELETE FROM projection_thread_activities WHERE thread_id = ?
    `),
    deleteTurnsStmt: db.prepare(`
      DELETE FROM projection_turns WHERE thread_id = ?
    `),
    deleteApprovalsStmt: db.prepare(`
      DELETE FROM projection_approvals WHERE thread_id = ?
    `),
    deleteCheckpointDiffsStmt: db.prepare(`
      DELETE FROM checkpoint_diffs WHERE thread_id = ?
    `),
    deleteTurnDiffsStmt: db.prepare(`
      DELETE FROM turn_diffs WHERE thread_id = ?
    `),
    deleteProviderSessionsStmt: db.prepare(`
      DELETE FROM provider_sessions WHERE thread_id = ?
    `),
    deleteProviderSessionBindingsStmt: db.prepare(`
      DELETE FROM provider_session_bindings WHERE thread_id = ?
    `),
    deleteProviderRuntimeEventsStmt: db.prepare(`
      DELETE FROM orchestration_events
      WHERE aggregate_kind = 'provider_runtime' AND stream_id = ?
    `),
    deleteThreadCommandReceiptsStmt: db.prepare(`
      DELETE FROM command_receipts
      WHERE command_id IN (
        SELECT DISTINCT command_id
        FROM orchestration_events
        WHERE stream_id = ?
          AND aggregate_kind IN ('thread', 'worktree')
          AND command_id IS NOT NULL
      )
    `),
    deleteThreadOrchestrationEventsStmt: db.prepare(`
      DELETE FROM orchestration_events
      WHERE stream_id = ?
        AND aggregate_kind IN ('thread', 'worktree')
    `),
    deleteCheckpointRevertQuarantineStmt: db.prepare(`
      DELETE FROM checkpoint_revert_quarantine WHERE thread_id = ?
    `),
    deleteWorktreeRegistryStmt: db.prepare(`
      DELETE FROM worktree_registry WHERE thread_id = ?
    `),
    clearChildThreadParentsStmt: db.prepare(`
      UPDATE projection_threads SET parent_thread_id = NULL WHERE parent_thread_id = ?
    `),
    insertMessageStmt: db.prepare(`
      INSERT INTO projection_messages
        (message_id, thread_id, turn_id, role, content_json, created_at, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updateMessageStmt: db.prepare(`
      UPDATE projection_messages
      SET turn_id = ?, role = ?, content_json = ?, created_at = ?
      WHERE thread_id = ? AND message_id = ?
    `),
    updateSavedMessageStmt: db.prepare(`
      UPDATE projection_messages
      SET turn_id = ?, role = ?, content_json = ?, created_at = ?, sequence = ?
      WHERE thread_id = ? AND message_id = ?
    `),
    // `runtime_sequence` is the trigger-maintained projection of
    // `extra.providerRuntimeSequence` (persistence/messageUsage.ts); reading
    // it here spares a JSON parse per row and matches the reader
    // isStaleProviderRuntimeMessage already relies on.
    listPersistedMessagesStmt: db.prepare(`
      SELECT message.message_id, message.turn_id, message.role,
             message.content_json, message.created_at, message.sequence,
             usage.runtime_sequence
      FROM projection_messages AS message
      LEFT JOIN projection_message_usage AS usage
        ON usage.message_id = message.message_id
      WHERE message.thread_id = ?
    `),
    findPersistedMessageStmt: db.prepare(`
      SELECT message.message_id, message.turn_id, message.role,
             message.content_json, message.created_at, message.sequence,
             usage.runtime_sequence
      FROM projection_messages AS message
      LEFT JOIN projection_message_usage AS usage
        ON usage.message_id = message.message_id
      WHERE message.thread_id = ? AND message.message_id = ?
    `),
    deleteMessageByIdStmt: db.prepare(`
      DELETE FROM projection_messages
      WHERE thread_id = ? AND message_id = ?
    `),
    findMessageSequenceStmt: db.prepare(`
      SELECT sequence, created_at, role, turn_id
      FROM projection_messages
      WHERE thread_id = ? AND message_id = ?
    `),
    findRuntimeSequenceStmt: db.prepare(`
      SELECT thread_id, role, runtime_sequence FROM projection_message_usage WHERE message_id = ?
    `),
    touchThreadStmt: db.prepare(
      "UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?"
    ),
    findDispatchMessageStmt: db.prepare(`
      SELECT thread_id, turn_id, role, content_json, created_at
      FROM projection_messages
      WHERE message_id = ?
    `),
    findChatDispatchStatusStmt: db.prepare(`
      SELECT status
      FROM chat_dispatches
      WHERE thread_id = ? AND message_id = ?
      LIMIT 1
    `),
    listChatDispatchStatusesStmt: db.prepare(`
      SELECT message_id, status
      FROM chat_dispatches
      WHERE thread_id = ?
    `),
    listServerOwnedDispatchMessagesStmt: db.prepare(`
      SELECT
        message.message_id,
        message.turn_id,
        message.role,
        message.content_json,
        message.created_at,
        dispatch.status
      FROM projection_messages AS message
      JOIN chat_dispatches AS dispatch
        ON dispatch.thread_id = message.thread_id
       AND dispatch.message_id = message.message_id
      WHERE message.thread_id = ?
    `),
    updateMessageSequenceStmt: db.prepare(`
      UPDATE projection_messages
      SET sequence = ?
      WHERE thread_id = ? AND message_id = ?
    `),
    findRecoveryInsertSequenceStmt: db.prepare(`
      SELECT MIN(sequence) AS sequence
      FROM projection_messages
      WHERE thread_id = ? AND created_at > ?
    `),
    shiftMessageSequencesStmt: db.prepare(`
      UPDATE projection_messages
      SET sequence = sequence + 1
      WHERE thread_id = ? AND sequence >= ?
    `),
    latestMessageCreatedAtStmt: db.prepare(`
      SELECT created_at
      FROM projection_messages
      WHERE thread_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `),
    findMessageBoundaryStmt: db.prepare(`
      SELECT sequence, created_at
      FROM projection_messages
      WHERE thread_id = ? AND message_id = ?
    `),
    findCheckpointBoundaryByTurnCountStmt: db.prepare(`
      SELECT
        diff.boundary_message_id AS message_id,
        diff.boundary_sequence AS sequence,
        COALESCE(message.created_at, diff.created_at) AS created_at
      FROM turn_diffs AS diff
      LEFT JOIN projection_messages AS message
        ON message.thread_id = diff.thread_id
       AND message.message_id = diff.boundary_message_id
      WHERE diff.thread_id = ? AND diff.turn_index = ?
      LIMIT 1
    `),
    nextMessageSequenceStmt: db.prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
      FROM projection_messages
      WHERE thread_id = ?
    `),
    deleteActivitiesAfterMessageSequenceStmt: db.prepare(`
      DELETE FROM projection_thread_activities
      WHERE thread_id = ?
        AND (
          turn_id IN (
            SELECT DISTINCT turn_id
            FROM projection_messages
            WHERE thread_id = ?
              AND sequence > ?
              AND turn_id IS NOT NULL
          )
          OR (turn_id IS NULL AND created_at > ?)
        )
    `),
    deleteActivitiesAfterTurnCountStmt: db.prepare(`
      DELETE FROM projection_thread_activities
      WHERE thread_id = ?
        AND (
          turn_id IN (
            SELECT turn_id
            FROM turn_diffs
            WHERE thread_id = ?
              AND turn_index > ?
              AND turn_id IS NOT NULL
            UNION
            SELECT dispatch_turn_id
            FROM turn_diffs
            WHERE thread_id = ?
              AND turn_index > ?
              AND dispatch_turn_id IS NOT NULL
          )
          OR (turn_id IS NULL AND created_at > ?)
        )
    `),
    deleteApprovalsAfterMessageSequenceStmt: db.prepare(`
      DELETE FROM projection_approvals
      WHERE thread_id = ?
        AND turn_id IN (
          SELECT DISTINCT turn_id
          FROM projection_messages
          WHERE thread_id = ?
            AND sequence > ?
            AND turn_id IS NOT NULL
        )
    `),
    deleteApprovalsAfterTurnCountStmt: db.prepare(`
      DELETE FROM projection_approvals
      WHERE thread_id = ?
        AND turn_id IN (
          SELECT turn_id
          FROM turn_diffs
          WHERE thread_id = ?
            AND turn_index > ?
            AND turn_id IS NOT NULL
          UNION
          SELECT dispatch_turn_id
          FROM turn_diffs
          WHERE thread_id = ?
            AND turn_index > ?
            AND dispatch_turn_id IS NOT NULL
        )
    `),
    deleteCheckpointDiffsAfterMessageSequenceStmt: db.prepare(`
      DELETE FROM checkpoint_diffs
      WHERE thread_id = ?
        AND turn_id IN (
          SELECT DISTINCT turn_id
          FROM projection_messages
          WHERE thread_id = ?
            AND sequence > ?
            AND turn_id IS NOT NULL
        )
    `),
    deleteCheckpointDiffsAfterTurnCountStmt: db.prepare(`
      DELETE FROM checkpoint_diffs
      WHERE thread_id = ?
        AND turn_id IN (
          SELECT turn_id
          FROM turn_diffs
          WHERE thread_id = ?
            AND turn_index > ?
            AND turn_id IS NOT NULL
          UNION
          SELECT dispatch_turn_id
          FROM turn_diffs
          WHERE thread_id = ?
            AND turn_index > ?
            AND dispatch_turn_id IS NOT NULL
        )
    `),
    deleteCheckpointDiffByRefStmt: db.prepare(`
      DELETE FROM checkpoint_diffs
      WHERE thread_id = ? AND checkpoint_ref = ?
    `),
    deleteTurnDiffsAfterBoundarySequenceStmt: db.prepare(`
      DELETE FROM turn_diffs
      WHERE thread_id = ?
        AND turn_index > COALESCE((
          SELECT MAX(turn_index)
          FROM turn_diffs
          WHERE thread_id = ?
            AND boundary_sequence <= ?
        ), 0)
    `),
    deleteTurnDiffsAfterTurnCountStmt: db.prepare(`
      DELETE FROM turn_diffs
      WHERE thread_id = ? AND turn_index > ?
    `),
    deleteTurnsAfterMessageSequenceStmt: db.prepare(`
      DELETE FROM projection_turns
      WHERE thread_id = ?
        AND turn_id IN (
          SELECT DISTINCT turn_id
          FROM projection_messages
          WHERE thread_id = ?
            AND sequence > ?
            AND turn_id IS NOT NULL
        )
    `),
    deleteTurnsAfterTurnCountStmt: db.prepare(`
      DELETE FROM projection_turns
      WHERE thread_id = ?
        AND turn_id IN (
          SELECT turn_id
          FROM turn_diffs
          WHERE thread_id = ?
            AND turn_index > ?
            AND turn_id IS NOT NULL
          UNION
          SELECT dispatch_turn_id
          FROM turn_diffs
          WHERE thread_id = ?
            AND turn_index > ?
            AND dispatch_turn_id IS NOT NULL
        )
    `),
    revertChatDispatchesAfterMessageSequenceStmt: db.prepare(`
      UPDATE chat_dispatches
      SET status = 'reverted',
          last_error = 'Message was removed by an explicit thread revert.',
          updated_at = ?,
          recovery_completed_at = NULL
      WHERE thread_id = ?
        AND status <> 'reverted'
        AND message_id IN (
          SELECT message_id
          FROM projection_messages
          WHERE thread_id = ? AND sequence > ?
        )
    `),
    deleteMessagesAfterSequenceStmt: db.prepare(`
      DELETE FROM projection_messages
      WHERE thread_id = ? AND sequence > ?
    `),
    ensureThreadExistsStmt: db.prepare(`
      SELECT 1
      FROM projection_threads
      WHERE thread_id = ?
      LIMIT 1
    `),
    syncThreadFromMessagesStmt: db.prepare(`
      UPDATE projection_threads
      SET updated_at = ?,
          last_message_at = (
            SELECT MAX(created_at)
            FROM projection_messages
            WHERE thread_id = ?
          ),
          message_count = (
            SELECT COUNT(*)
            FROM projection_messages
            WHERE thread_id = ?
          )
      WHERE thread_id = ?
    `),
    syncRecoveredThreadFromMessagesStmt: db.prepare(`
      UPDATE projection_threads
      SET updated_at = MAX(updated_at, ?),
          last_message_at = (
            SELECT MAX(created_at)
            FROM projection_messages
            WHERE thread_id = ?
          ),
          message_count = (
            SELECT COUNT(*)
            FROM projection_messages
            WHERE thread_id = ?
          )
      WHERE thread_id = ?
    `),
    listThreadsStmt: db.prepare(threadPageSql("newest")),
    listThreadsBeforeStmt: db.prepare(threadPageSql("before")),
    getThreadSummaryStmt: db.prepare(threadPageSql("id")),
    listStatsThreadsStmt: db.prepare(`
      SELECT thread_id, project_path, created_at, updated_at
      FROM projection_threads
      WHERE status = 'active'
        AND (? IS NULL OR updated_at >= ?)
        AND (? IS NULL OR project_path = ?)
      ORDER BY updated_at DESC, thread_id DESC
    `),
    setCodexThreadIdStmt: db.prepare(`
      UPDATE projection_threads SET codex_thread_id = ? WHERE thread_id = ?
    `),
    getCodexThreadIdStmt: db.prepare(`
      SELECT codex_thread_id FROM projection_threads WHERE thread_id = ?
    `),
    getThreadProjectPathStmt: db.prepare(`
      SELECT project_path FROM projection_threads WHERE thread_id = ?
    `),
    updateThreadTitleStmt: db.prepare(`
      UPDATE projection_threads
      SET title = ?, updated_at = ?
      WHERE thread_id = ?
    `),
    getThreadGoalStmt: db.prepare(`
      SELECT provider_goal_json, updated_at FROM projection_threads WHERE thread_id = ?
    `),
    updateThreadGoalStmt: db.prepare(`
      UPDATE projection_threads SET provider_goal_json = ? WHERE thread_id = ?
    `),
    updateThreadWorkspaceStmt: db.prepare(`
      UPDATE projection_threads
      SET
        env_mode = CASE WHEN ? THEN COALESCE(?, 'local') ELSE env_mode END,
        branch = CASE WHEN ? THEN ? ELSE branch END,
        worktree_path = CASE WHEN ? THEN ? ELSE worktree_path END,
        base_branch = CASE WHEN ? THEN ? ELSE base_branch END,
        worktree_state = CASE WHEN ? THEN COALESCE(?, 'none') ELSE worktree_state END,
        updated_at = ?
      WHERE thread_id = ?
    `),
    updateThreadParentStmt: db.prepare(`
      UPDATE projection_threads
      SET parent_thread_id = ?, updated_at = ?
      WHERE thread_id = ?
    `),
    findCompactionMessageStmt: db.prepare(`
      SELECT thread_id, role, content_json
      FROM projection_messages
      WHERE message_id = ?
      LIMIT 1
    `),
    currentThreadEpochStmt: db.prepare(`
      SELECT MAX(generation) AS generation
      FROM (
        SELECT generation
        FROM provider_thread_epochs
        WHERE thread_id = ?
        UNION ALL
        SELECT COALESCE(generation, 0) AS generation
        FROM provider_session_bindings
        WHERE thread_id = ?
      )
    `),
    upsertThreadEpochStmt: db.prepare(`
      INSERT INTO provider_thread_epochs (thread_id, generation, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        generation = excluded.generation,
        updated_at = excluded.updated_at
    `),
    rotateThreadBindingsStmt: db.prepare(`
      UPDATE provider_session_bindings
      SET
        provider_thread_id = NULL,
        resume_cursor_json = NULL,
        continuation_key = NULL,
        status = 'ready',
        active_turn_id = NULL,
        last_error = NULL,
        generation = ?,
        updated_at = ?
      WHERE thread_id = ?
    `),
    listMessagesStmt: db.prepare(`
      SELECT message_id, turn_id, role, content_json, created_at, sequence
      FROM projection_messages
      WHERE thread_id = ?
        AND (? IS NULL OR sequence < ?)
      ORDER BY sequence DESC
      LIMIT ?
    `),
    providerHistoryMessagesStmt: db.prepare(`
      SELECT message.message_id, message.role, message.content_json,
             dispatch.status AS dispatch_status
      FROM projection_messages AS message
      LEFT JOIN chat_dispatches AS dispatch
        ON dispatch.thread_id = message.thread_id
       AND dispatch.message_id = message.message_id
      WHERE message.thread_id = ?
        AND (? IS NULL OR message.message_id <> ?)
        AND (
          message.role <> 'user'
          OR dispatch.status IS NULL
          OR dispatch.status IN ('accepted', 'completed')
        )
      ORDER BY message.sequence DESC
      LIMIT ?
    `),
    deleteThreadStmt: db.prepare(`
      DELETE FROM projection_threads WHERE thread_id = ?
    `),
    listProjectsStmt: db.prepare(`
      SELECT DISTINCT project_id, project_path
      FROM projection_threads
      WHERE status = 'active'
    `),
    loadHistoryStmt: db.prepare(`
      SELECT role, content_json
      FROM projection_messages
      WHERE thread_id = ?
      ORDER BY sequence ASC
    `),
  }
}

export type ThreadStatements = ReturnType<typeof prepareThreadStatements>
