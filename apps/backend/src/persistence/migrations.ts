import { messageUsageProjectionSql } from "./messageUsage"
import type { Db } from "./db"
import { logger } from "../observability/logger"

interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * Every writer derives the public turn count from the same three durable
 * sources. Provider-created compaction summaries are assistant messages with
 * no turn id and therefore must never advance the checkpoint turn boundary.
 */
function projectionThreadTurnCountSql(threadIdExpression: string): string {
  return `MAX(
    COALESCE((
      SELECT MAX(turn_index)
      FROM turn_diffs
      WHERE turn_diffs.thread_id = ${threadIdExpression}
    ), 0),
    (
      SELECT COUNT(*)
      FROM projection_turns
      WHERE projection_turns.thread_id = ${threadIdExpression}
        AND projection_turns.status IN ('completed', 'interrupted')
    ),
    (
      SELECT COUNT(DISTINCT turn_id)
      FROM projection_messages
      WHERE projection_messages.thread_id = ${threadIdExpression}
        AND projection_messages.role = 'assistant'
        AND projection_messages.turn_id IS NOT NULL
    )
  )`
}

/**
 * Schema migrations — ported verbatim from rust-backend/src/persistence/migrations.rs.
 * SQL strings are identical (just `?1`/`?2` placeholders replaced by `?`), so
 * an existing Rust-populated database is opened without a re-migration.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "orchestration_events",
    sql: `
      CREATE TABLE IF NOT EXISTS orchestration_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        command_id TEXT,
        causation_event_id TEXT,
        correlation_id TEXT,
        actor_kind TEXT NOT NULL DEFAULT 'system',
        payload_json TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_events_stream ON orchestration_events(stream_id, stream_version);
      CREATE INDEX IF NOT EXISTS idx_events_type ON orchestration_events(event_type);
    `,
  },
  {
    version: 2,
    name: "command_receipts",
    sql: `
      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "checkpoint_diffs",
    sql: `
      CREATE TABLE IF NOT EXISTS checkpoint_diffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        checkpoint_ref TEXT NOT NULL,
        diff_content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoint_thread ON checkpoint_diffs(thread_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoint_turn ON checkpoint_diffs(turn_id);
    `,
  },
  {
    version: 4,
    name: "provider_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS provider_sessions (
        session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_thread ON provider_sessions(thread_id);
    `,
  },
  {
    version: 5,
    name: "projections",
    sql: `
      CREATE TABLE IF NOT EXISTS projection_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        env_mode TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        last_message_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_threads_project ON projection_threads(project_id);
      CREATE INDEX IF NOT EXISTS idx_threads_status ON projection_threads(status);

      CREATE TABLE IF NOT EXISTS projection_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON projection_messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_turn ON projection_messages(turn_id);

      CREATE TABLE IF NOT EXISTS projection_turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        provider_kind TEXT,
        model_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_turns_thread ON projection_turns(thread_id);

      CREATE TABLE IF NOT EXISTS projection_projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projection_approvals (
        approval_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        request_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_thread ON projection_approvals(thread_id);
    `,
  },
  {
    version: 6,
    name: "thread_project_path",
    sql: `
      ALTER TABLE projection_threads ADD COLUMN project_path TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 7,
    name: "turn_diffs",
    sql: `
      CREATE TABLE IF NOT EXISTS turn_diffs (
        thread_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        diff_text TEXT NOT NULL,
        files_changed INTEGER NOT NULL DEFAULT 0,
        insertions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, turn_index)
      );
      CREATE INDEX IF NOT EXISTS idx_turn_diffs_thread ON turn_diffs(thread_id);
    `,
  },
  {
    // Records the Codex-side thread id so an Electron reload can `thread/resume`
    // into the same codex-rs conversation instead of starting a fresh one (which
    // would hand the model an empty context while the renderer still shows the
    // old history).
    version: 8,
    name: "thread_codex_id",
    sql: `
      ALTER TABLE projection_threads ADD COLUMN codex_thread_id TEXT;
    `,
  },
  {
    // Without this index, `readFromSequence(afterSeq, PAGE_SIZE)` runs a full
    // table scan with an in-memory sort on every replay — startup time grows
    // linearly with event-store size.  `sequence` is declared PRIMARY KEY on
    // line 21 so SQLite's rowid alias gives us ordered reads for free, but we
    // add an explicit covering index anyway so future queries that filter on
    // sequence alone (analytics, debugging) hit the same fast path.
    version: 9,
    name: "idx_events_sequence",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_events_sequence ON orchestration_events(sequence);
    `,
  },
  {
    // Thread-scoped ordered reads — `projection_messages.listByThread` and
    // `projection_turns.listByThread` both filter by `thread_id` then
    // `ORDER BY sequence/started_at`.  The existing single-column indexes
    // on `thread_id` force a post-filter sort that scales linearly with
    // per-thread history.  Composite indexes let SQLite satisfy both
    // filter and order via the b-tree directly.
    version: 10,
    name: "idx_thread_scoped_ordering",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_messages_thread_seq
        ON projection_messages(thread_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_turns_thread_started
        ON projection_turns(thread_id, started_at);
    `,
  },
  {
    // Per-thread worktree isolation — every agent thread gets
    // its own git worktree + branch so the AI never writes to the main
    // working directory. Columns are NULL-defaulted so pre-worktree threads
    // remain valid: NULL worktree_path means "thread runs in the shared
    // project workspace" (legacy behavior, kept for back-compat).
    version: 11,
    name: "thread_worktree_metadata",
    sql: `
      ALTER TABLE projection_threads ADD COLUMN worktree_path TEXT;
      ALTER TABLE projection_threads ADD COLUMN branch TEXT;
      ALTER TABLE projection_threads ADD COLUMN base_branch TEXT;
      ALTER TABLE projection_threads ADD COLUMN worktree_state TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE projection_threads ADD COLUMN pr_number INTEGER;
      ALTER TABLE projection_threads ADD COLUMN pr_url TEXT;
      ALTER TABLE projection_threads ADD COLUMN pr_state TEXT;
      ALTER TABLE projection_threads ADD COLUMN pr_mergeable INTEGER;
      ALTER TABLE projection_threads ADD COLUMN pr_checked_at TEXT;
      ALTER TABLE projection_threads ADD COLUMN upstream_ahead INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projection_threads ADD COLUMN upstream_behind INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projection_threads ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'ask-on-edit';
      CREATE INDEX IF NOT EXISTS idx_threads_branch ON projection_threads(branch);
      CREATE INDEX IF NOT EXISTS idx_threads_worktree_state ON projection_threads(worktree_state);
    `,
  },
  {
    // Global worktree registry — single source of truth for "which branch
    // is checked out in which worktree". A branch can only be checked out
    // in ONE worktree at a time (git's hard constraint), so we enforce
    // UNIQUE on `branch`. Conflict detection for WorktreeManager.createForThread
    // runs against this table before shelling out to `git worktree add`.
    version: 12,
    name: "worktree_registry",
    sql: `
      CREATE TABLE IF NOT EXISTS worktree_registry (
        worktree_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL UNIQUE,
        base_branch TEXT NOT NULL,
        base_repo_path TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_worktree_thread ON worktree_registry(thread_id);
      CREATE INDEX IF NOT EXISTS idx_worktree_state ON worktree_registry(state);
    `,
  },
  {
    // CR1: idempotent dispatch needs an index on command_id so re-issuing a
    // duplicate command can re-fetch the original events in O(log n) instead
    // of a full table scan. orchestration_events.command_id has been there
    // since v1; the index is the missing piece.
    version: 13,
    name: "events_by_command_id",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_events_command_id ON orchestration_events(command_id);
    `,
  },
  {
    // BetterC0de chat work timeline. Provider/tool events are persisted as
    // thread activities so the renderer can reconstruct visible tool usage
    // after reload instead of relying only on transient streaming state.
    version: 14,
    name: "projection_thread_activities",
    sql: `
      CREATE TABLE IF NOT EXISTS projection_thread_activities (
        activity_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        tone TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        sequence INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_activities_thread
        ON projection_thread_activities(thread_id);
      CREATE INDEX IF NOT EXISTS idx_thread_activities_thread_sequence
        ON projection_thread_activities(thread_id, sequence, created_at);
      CREATE INDEX IF NOT EXISTS idx_thread_activities_turn
        ON projection_thread_activities(turn_id);
    `,
  },
  {
    version: 15,
    name: "provider_instance_ids",
    sql: `
      ALTER TABLE provider_sessions ADD COLUMN provider_instance_id TEXT;
      ALTER TABLE projection_turns ADD COLUMN provider_instance_id TEXT;
      ALTER TABLE projection_thread_activities ADD COLUMN provider_instance_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_sessions_provider_instance
        ON provider_sessions(provider_instance_id);
      CREATE INDEX IF NOT EXISTS idx_turns_provider_instance
        ON projection_turns(provider_instance_id);
      CREATE INDEX IF NOT EXISTS idx_thread_activities_provider_instance
        ON projection_thread_activities(provider_instance_id);
    `,
  },
  {
    version: 16,
    name: "provider_session_bindings",
    sql: `
      CREATE TABLE IF NOT EXISTS provider_session_bindings (
        thread_id TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        provider_thread_id TEXT,
        resume_cursor_json TEXT,
        continuation_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, provider_instance_id)
      );
      CREATE INDEX IF NOT EXISTS idx_provider_session_bindings_instance
        ON provider_session_bindings(provider_instance_id);
      CREATE INDEX IF NOT EXISTS idx_provider_session_bindings_thread_kind
        ON provider_session_bindings(thread_id, provider_kind);
    `,
  },
  {
    // Provider runtime session state. Provider runtime lifecycle events update
    // these fields so thread lists can show running/error/active-turn state
    // after reload instead of relying on transient renderer memory only.
    version: 17,
    name: "provider_session_lifecycle",
    sql: `
      ALTER TABLE provider_session_bindings ADD COLUMN status TEXT DEFAULT 'ready';
      ALTER TABLE provider_session_bindings ADD COLUMN active_turn_id TEXT;
      ALTER TABLE provider_session_bindings ADD COLUMN last_error TEXT;
      ALTER TABLE provider_session_bindings ADD COLUMN runtime_mode TEXT DEFAULT 'full-access';
    `,
  },
  {
    // Provider recovery context. Resume ids alone are not enough after reload:
    // providers need the original workspace cwd and model selection so skills,
    // slash commands, and recovered runtime sessions bind to the same project
    // and model options that started the conversation.
    version: 18,
    name: "provider_session_runtime_context",
    sql: `
      ALTER TABLE provider_session_bindings ADD COLUMN cwd TEXT;
      ALTER TABLE provider_session_bindings ADD COLUMN model_selection_json TEXT;
    `,
  },
  {
    // BetterC0de-compatible fork navigation. A forked chat keeps a direct parent
    // thread id so `/parent` and `/child` can navigate session branches after
    // reload instead of relying on title suffixes.
    version: 19,
    name: "thread_parent_links",
    sql: `
      ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_threads_parent_thread
        ON projection_threads(parent_thread_id);
    `,
  },
  {
    // Compaction starts a fresh native provider conversation while retaining
    // the immutable local transcript. Generation makes that boundary durable
    // and inspectable across backend restarts.
    version: 20,
    name: "provider_session_generations",
    sql: `
      ALTER TABLE provider_session_bindings
        ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // A compaction boundary applies to the whole local thread, not one
    // provider instance. This epoch prevents a later instance switch from
    // reviving a resume cursor that predates the latest durable checkpoint.
    version: 21,
    name: "provider_thread_epochs",
    sql: `
      CREATE TABLE IF NOT EXISTS provider_thread_epochs (
        thread_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id)
          ON DELETE CASCADE
      );
      INSERT INTO provider_thread_epochs (thread_id, generation, updated_at)
      SELECT thread_id, MAX(COALESCE(generation, 0)), MAX(updated_at)
      FROM provider_session_bindings
      GROUP BY thread_id
      ON CONFLICT(thread_id) DO UPDATE SET
        generation = MAX(provider_thread_epochs.generation, excluded.generation),
        updated_at = excluded.updated_at;
    `,
  },
  {
    // Provider audit events share the append-only table, but orchestration
    // rebuilds must not scan and parse that high-volume stream on startup.
    version: 22,
    name: "orchestration_replay_without_provider_audit",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_events_orchestration_replay
        ON orchestration_events(sequence)
        WHERE aggregate_kind <> 'provider_runtime';
    `,
  },
  {
    // Provider audit is deliberately retained for diagnostics, but unlike
    // orchestration history it is bounded by age/count and scrubbed on a
    // thread hard-delete. Partial indexes keep those maintenance operations
    // off the orchestration-event hot set.
    version: 23,
    name: "provider_audit_retention_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_events_provider_retention
        ON orchestration_events(occurred_at, sequence)
        WHERE aggregate_kind = 'provider_runtime';
      CREATE INDEX IF NOT EXISTS idx_events_provider_stream
        ON orchestration_events(stream_id)
        WHERE aggregate_kind = 'provider_runtime';
    `,
  },
  {
    // Git/provider/SQLite cannot share one transaction. This journal makes a
    // checkpoint revert resumable after a process crash at any phase.
    version: 24,
    name: "checkpoint_revert_journal",
    sql: `
      CREATE TABLE IF NOT EXISTS checkpoint_revert_operations (
        thread_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id)
          ON DELETE CASCADE
      );
    `,
  },
  {
    // Provider runtime events are appended before their read-model updates.
    // A per-event receipt lets startup replay only events whose projections
    // may have been interrupted by a process crash. Existing audit rows are
    // seeded as projected so an upgrade does not replay historical traffic.
    version: 25,
    name: "provider_runtime_projection_receipts",
    sql: `
      CREATE TABLE IF NOT EXISTS provider_runtime_projection_receipts (
        event_sequence INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('projected', 'discarded')),
        error TEXT,
        projected_at TEXT NOT NULL,
        FOREIGN KEY (event_sequence) REFERENCES orchestration_events(sequence)
          ON DELETE CASCADE
      );
      INSERT INTO provider_runtime_projection_receipts
        (event_sequence, status, error, projected_at)
      SELECT sequence, 'projected', NULL, CURRENT_TIMESTAMP
      FROM orchestration_events
      WHERE aggregate_kind = 'provider_runtime'
      ON CONFLICT(event_sequence) DO NOTHING;
      CREATE INDEX IF NOT EXISTS idx_provider_runtime_projection_receipts_status
        ON provider_runtime_projection_receipts(status, event_sequence);
    `,
  },
  {
    // The provider turn that implements a proposed plan can arrive after a
    // process restart. Keep the source-plan link durable until its activity
    // projection has been committed and explicitly acknowledged.
    version: 26,
    name: "pending_source_proposed_plan_implementations",
    sql: `
      CREATE TABLE IF NOT EXISTS pending_source_proposed_plan_implementations (
        implementation_thread_id TEXT PRIMARY KEY,
        source_thread_id TEXT NOT NULL,
        source_plan_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        provider_instance_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (implementation_thread_id)
          REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
        FOREIGN KEY (source_thread_id)
          REFERENCES projection_threads(thread_id) ON DELETE CASCADE
      );
    `,
  },
  {
    // Rows created before provider admission could survive a crash and match
    // an unrelated later turn. Bind every accepted link to the stable local
    // turn admission and remove legacy ambiguous rows during the upgrade.
    version: 27,
    name: "pending_source_plan_accepted_turn_identity",
    sql: `
      ALTER TABLE pending_source_proposed_plan_implementations
        ADD COLUMN accepted_turn_id TEXT;
      DELETE FROM pending_source_proposed_plan_implementations
      WHERE accepted_turn_id IS NULL OR accepted_turn_id = '';
    `,
  },
  {
    // A renderer-visible user message and the provider admission it represents
    // must have one durable lifecycle. The dispatch id is the stable user
    // message id, so HTTP retries can be answered without starting a second
    // provider turn. Pending rows are recovered as uncertain after a restart;
    // they are never automatically dispatched again.
    version: 28,
    name: "chat_dispatch_outbox",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        provider_instance_id TEXT,
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'accepted', 'failed', 'uncertain')),
        provider_turn_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1
          CHECK (attempt_count >= 1),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        failed_at TEXT,
        recovery_completed_at TEXT,
        UNIQUE(thread_id, message_id),
        FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chat_dispatches_thread_status
        ON chat_dispatches(thread_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_chat_dispatches_recovery
        ON chat_dispatches(status, recovery_completed_at, created_at);
    `,
  },
  {
    // Migration 28 may already be recorded in user databases. Rebuild the
    // outbox append-only so terminal receipts and revert tombstones are added
    // for both upgraded and freshly-created databases.
    version: 29,
    name: "chat_dispatch_terminal_receipts",
    sql: `
      ALTER TABLE chat_dispatches RENAME TO chat_dispatches_v28;
      CREATE TABLE chat_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        provider_instance_id TEXT,
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'accepted', 'completed', 'failed', 'uncertain', 'reverted')),
        provider_turn_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1
          CHECK (attempt_count >= 1),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        completed_at TEXT,
        failed_at TEXT,
        recovery_completed_at TEXT,
        UNIQUE(thread_id, message_id),
        FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id)
          ON DELETE CASCADE
      );
      INSERT INTO chat_dispatches
        (dispatch_id, thread_id, message_id, provider_kind,
         provider_instance_id, request_fingerprint, status, provider_turn_id,
         attempt_count, last_error, created_at, updated_at, accepted_at,
         completed_at, failed_at, recovery_completed_at)
      SELECT dispatch_id, thread_id, message_id, provider_kind,
             provider_instance_id, request_fingerprint, status, provider_turn_id,
             attempt_count, last_error, created_at, updated_at, accepted_at,
             NULL, failed_at, recovery_completed_at
      FROM chat_dispatches_v28;
      DROP TABLE chat_dispatches_v28;
      CREATE INDEX idx_chat_dispatches_thread_status
        ON chat_dispatches(thread_id, status, created_at);
      CREATE INDEX idx_chat_dispatches_recovery
        ON chat_dispatches(status, recovery_completed_at, created_at);
    `,
  },
  {
    // Remote browser access follows BetterC0de's pairing model: short-lived,
    // one-time pairing grants are exchanged for independently revocable
    // device sessions. Only SHA-256 credential digests are persisted.
    version: 30,
    name: "remote_access_pairing_and_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS remote_access_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_pairing_grants (
        pairing_id TEXT PRIMARY KEY,
        credential_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_remote_pairing_grants_active
        ON remote_pairing_grants(expires_at, consumed_at, revoked_at);
      CREATE TABLE IF NOT EXISTS remote_access_sessions (
        session_id TEXT PRIMARY KEY,
        credential_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_remote_access_sessions_active
        ON remote_access_sessions(expires_at, revoked_at, last_seen_at);
    `,
  },
  {
    // Bind idempotency receipts to the canonical request and make stream
    // versions meaningful for every non-provider aggregate. Provider runtime
    // versions intentionally permit multiple audit events per provider turn.
    version: 31,
    name: "orchestration_request_identity_and_stream_versions",
    sql: `
      ALTER TABLE command_receipts ADD COLUMN request_hash TEXT;
      WITH ranked AS (
        SELECT
          sequence,
          ROW_NUMBER() OVER (
            PARTITION BY aggregate_kind, stream_id
            ORDER BY sequence ASC
          ) AS version
        FROM orchestration_events
        WHERE aggregate_kind <> 'provider_runtime'
      )
      UPDATE orchestration_events
      SET stream_version = (
        SELECT version FROM ranked
        WHERE ranked.sequence = orchestration_events.sequence
      )
      WHERE aggregate_kind <> 'provider_runtime';
      CREATE UNIQUE INDEX idx_events_unique_stream_version
        ON orchestration_events(aggregate_kind, stream_id, stream_version)
        WHERE aggregate_kind <> 'provider_runtime';
    `,
  },
  {
    // Terminal provider receipts are identified by thread, concrete provider
    // instance, and provider turn together. Ambiguous legacy duplicates are
    // detached from the turn id before the new uniqueness invariant lands.
    version: 32,
    name: "dispatch_identity_and_read_path_indexes",
    sql: `
      WITH duplicate_dispatches AS (
        SELECT dispatch_id
        FROM (
          SELECT
            dispatch_id,
            ROW_NUMBER() OVER (
              PARTITION BY
                thread_id,
                COALESCE(provider_instance_id, ''),
                provider_turn_id
              ORDER BY created_at ASC, dispatch_id ASC
            ) AS duplicate_rank
          FROM chat_dispatches
          WHERE provider_turn_id IS NOT NULL
        )
        WHERE duplicate_rank > 1
      )
      UPDATE chat_dispatches
      SET provider_turn_id = NULL,
          status = CASE
            WHEN status IN ('pending', 'accepted') THEN 'uncertain'
            ELSE status
          END,
          last_error = COALESCE(
            last_error,
            'Provider turn identity was ambiguous during migration.'
          ),
          updated_at = CURRENT_TIMESTAMP
      WHERE dispatch_id IN (SELECT dispatch_id FROM duplicate_dispatches);

      CREATE UNIQUE INDEX idx_chat_dispatches_provider_turn_identity
        ON chat_dispatches(
          thread_id,
          COALESCE(provider_instance_id, ''),
          provider_turn_id
        )
        WHERE provider_turn_id IS NOT NULL;
      CREATE INDEX idx_threads_status_updated
        ON projection_threads(status, updated_at DESC);
      CREATE INDEX idx_threads_project_status_updated
        ON projection_threads(project_id, status, updated_at DESC);
      CREATE INDEX idx_provider_bindings_thread_updated
        ON provider_session_bindings(
          thread_id,
          updated_at DESC,
          created_at DESC
        );
      CREATE INDEX idx_checkpoint_thread_turn_latest
        ON checkpoint_diffs(thread_id, turn_id, id DESC);
      CREATE INDEX idx_messages_thread_created
        ON projection_messages(thread_id, created_at);
      CREATE INDEX idx_turns_thread_status
        ON projection_turns(thread_id, status, completed_at);
    `,
  },
  {
    // Invalid recovery rows must not remain in the live journal forever.
    // They are quarantined by the store and visibly fence the affected thread
    // until an operator resolves the durable recovery marker.
    version: 33,
    name: "checkpoint_revert_quarantine",
    sql: `
      ALTER TABLE projection_threads
        ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0
          CHECK (recovery_required IN (0, 1));
      CREATE TABLE checkpoint_revert_quarantine (
        quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        error TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );
      CREATE INDEX idx_checkpoint_revert_quarantine_thread
        ON checkpoint_revert_quarantine(thread_id, quarantined_at DESC);
    `,
  },
  {
    // `turn_count` is the highest durable checkpoint boundary, terminal
    // orchestration count, or distinct provider turn represented by a real
    // assistant response. Synthetic assistant summaries have no turn id.
    version: 34,
    name: "projection_thread_turn_count",
    sql: `
      UPDATE projection_threads
      SET turn_count = ${projectionThreadTurnCountSql(
        "projection_threads.thread_id"
      )};

      CREATE TRIGGER projection_messages_turn_count_insert
      AFTER INSERT ON projection_messages
      WHEN NEW.role = 'assistant'
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER projection_messages_turn_count_delete
      AFTER DELETE ON projection_messages
      WHEN OLD.role = 'assistant'
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
      END;

      CREATE TRIGGER projection_messages_turn_count_role_update
      AFTER UPDATE OF role ON projection_messages
      WHEN OLD.role <> NEW.role
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER projection_turns_turn_count_insert
      AFTER INSERT ON projection_turns
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER projection_turns_turn_count_delete
      AFTER DELETE ON projection_turns
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
      END;

      CREATE TRIGGER projection_turns_turn_count_status_update
      AFTER UPDATE OF status ON projection_turns
      WHEN OLD.status <> NEW.status
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;
    `,
  },
  {
    // Store a unified diff once even though both legacy API projections refer
    // to it. Existing paired turn/checkpoint rows are linked before their
    // duplicate inline payloads are cleared.
    version: 35,
    name: "deduplicated_diff_blobs",
    sql: `
      CREATE TABLE diff_blobs (
        blob_id TEXT PRIMARY KEY,
        diff_content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      ALTER TABLE turn_diffs ADD COLUMN diff_blob_id TEXT;
      ALTER TABLE checkpoint_diffs ADD COLUMN diff_blob_id TEXT;

      INSERT INTO diff_blobs (blob_id, diff_content, created_at)
      SELECT
        'legacy-turn:' || thread_id || ':' || turn_index,
        diff_text,
        created_at
      FROM turn_diffs
      WHERE diff_text <> '';

      UPDATE checkpoint_diffs
      SET diff_blob_id = (
        SELECT 'legacy-turn:' || turn_diffs.thread_id || ':' ||
               turn_diffs.turn_index
        FROM turn_diffs
        WHERE turn_diffs.thread_id = checkpoint_diffs.thread_id
          AND turn_diffs.diff_text = checkpoint_diffs.diff_content
        ORDER BY turn_diffs.turn_index DESC
        LIMIT 1
      )
      WHERE diff_content <> '';

      INSERT INTO diff_blobs (blob_id, diff_content, created_at)
      SELECT
        'legacy-checkpoint:' || id,
        diff_content,
        created_at
      FROM checkpoint_diffs
      WHERE diff_content <> '' AND diff_blob_id IS NULL;

      UPDATE checkpoint_diffs
      SET diff_blob_id = 'legacy-checkpoint:' || id
      WHERE diff_content <> '' AND diff_blob_id IS NULL;

      UPDATE turn_diffs
      SET diff_blob_id = 'legacy-turn:' || thread_id || ':' || turn_index
      WHERE diff_text <> '';

      UPDATE checkpoint_diffs SET diff_content = ''
      WHERE diff_blob_id IS NOT NULL;
      UPDATE turn_diffs SET diff_text = ''
      WHERE diff_blob_id IS NOT NULL;

      CREATE INDEX idx_turn_diffs_blob ON turn_diffs(diff_blob_id);
      CREATE INDEX idx_checkpoint_diffs_blob
        ON checkpoint_diffs(diff_blob_id);

      CREATE TRIGGER cleanup_diff_blob_after_turn_delete
      AFTER DELETE ON turn_diffs
      WHEN OLD.diff_blob_id IS NOT NULL
      BEGIN
        DELETE FROM diff_blobs
        WHERE blob_id = OLD.diff_blob_id
          AND NOT EXISTS (
            SELECT 1 FROM turn_diffs
            WHERE diff_blob_id = OLD.diff_blob_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM checkpoint_diffs
            WHERE diff_blob_id = OLD.diff_blob_id
          );
      END;

      CREATE TRIGGER cleanup_diff_blob_after_checkpoint_delete
      AFTER DELETE ON checkpoint_diffs
      WHEN OLD.diff_blob_id IS NOT NULL
      BEGIN
        DELETE FROM diff_blobs
        WHERE blob_id = OLD.diff_blob_id
          AND NOT EXISTS (
            SELECT 1 FROM turn_diffs
            WHERE diff_blob_id = OLD.diff_blob_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM checkpoint_diffs
            WHERE diff_blob_id = OLD.diff_blob_id
          );
      END;

      CREATE TRIGGER cleanup_diff_blob_after_turn_update
      AFTER UPDATE OF diff_blob_id ON turn_diffs
      WHEN OLD.diff_blob_id IS NOT NULL
       AND OLD.diff_blob_id IS NOT NEW.diff_blob_id
      BEGIN
        DELETE FROM diff_blobs
        WHERE blob_id = OLD.diff_blob_id
          AND NOT EXISTS (
            SELECT 1 FROM turn_diffs
            WHERE diff_blob_id = OLD.diff_blob_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM checkpoint_diffs
            WHERE diff_blob_id = OLD.diff_blob_id
          );
      END;

      CREATE TRIGGER cleanup_diff_blob_after_checkpoint_update
      AFTER UPDATE OF diff_blob_id ON checkpoint_diffs
      WHEN OLD.diff_blob_id IS NOT NULL
       AND OLD.diff_blob_id IS NOT NEW.diff_blob_id
      BEGIN
        DELETE FROM diff_blobs
        WHERE blob_id = OLD.diff_blob_id
          AND NOT EXISTS (
            SELECT 1 FROM turn_diffs
            WHERE diff_blob_id = OLD.diff_blob_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM checkpoint_diffs
            WHERE diff_blob_id = OLD.diff_blob_id
          );
      END;
    `,
  },
  {
    version: 36,
    name: "remote_session_access_level",
    sql: `
      ALTER TABLE remote_access_sessions
        ADD COLUMN access_level TEXT NOT NULL DEFAULT 'full'
        CHECK (access_level IN ('full', 'read_only'));
    `,
  },
  {
    // Public orchestration events and direct API persistence share the same
    // projection tables. Track exactly which events have already been applied
    // so startup can rebuild the in-memory model without replaying historical
    // events over newer direct writes. Existing databases are seeded at their
    // current event-log head to preserve their already-materialized state.
    version: 37,
    name: "orchestration_projection_cursor",
    sql: `
      CREATE TABLE orchestration_projection_cursors (
        projection_name TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (last_sequence >= 0),
        updated_at TEXT NOT NULL
      );
      INSERT INTO orchestration_projection_cursors
        (projection_name, last_sequence, updated_at)
      SELECT
        'durable_api',
        COALESCE(MAX(sequence), 0),
        CURRENT_TIMESTAMP
      FROM orchestration_events
      WHERE aggregate_kind <> 'provider_runtime'
      ON CONFLICT(projection_name) DO NOTHING;
    `,
  },
  {
    // Migration 34's delta triggers could over-count when a terminal turn was
    // projected before its assistant message. Rebuild every affected value
    // from both durable sources so event arrival order cannot change it.
    version: 38,
    name: "projection_thread_turn_count_invariant",
    sql: `
      DROP TRIGGER IF EXISTS projection_messages_turn_count_insert;
      DROP TRIGGER IF EXISTS projection_messages_turn_count_delete;
      DROP TRIGGER IF EXISTS projection_messages_turn_count_role_update;
      DROP TRIGGER IF EXISTS projection_turns_turn_count_insert;
      DROP TRIGGER IF EXISTS projection_turns_turn_count_delete;
      DROP TRIGGER IF EXISTS projection_turns_turn_count_status_update;

      UPDATE projection_threads
      SET turn_count = ${projectionThreadTurnCountSql(
        "projection_threads.thread_id"
      )};

      CREATE TRIGGER projection_messages_turn_count_insert
      AFTER INSERT ON projection_messages
      WHEN NEW.role = 'assistant'
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER projection_messages_turn_count_delete
      AFTER DELETE ON projection_messages
      WHEN OLD.role = 'assistant'
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
      END;

      CREATE TRIGGER projection_messages_turn_count_role_update
      AFTER UPDATE OF role ON projection_messages
      WHEN OLD.role <> NEW.role
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER projection_turns_turn_count_insert
      AFTER INSERT ON projection_turns
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER projection_turns_turn_count_delete
      AFTER DELETE ON projection_turns
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
      END;

      CREATE TRIGGER projection_turns_turn_count_status_update
      AFTER UPDATE OF status ON projection_turns
      WHEN OLD.status <> NEW.status
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;
    `,
  },
  {
    // Worktree removal crosses SQLite, Git metadata and the filesystem. Keep
    // branch-deletion intent durable so a crash after physical removal can be
    // completed safely by startup reconciliation.
    version: 39,
    name: "worktree_removal_intent",
    sql: `
      ALTER TABLE worktree_registry
        ADD COLUMN delete_branch_on_remove INTEGER NOT NULL DEFAULT 0
          CHECK (delete_branch_on_remove IN (0, 1));
    `,
  },
  {
    // Git ref deletion is external to SQLite. Journal every cleanup intent
    // before touching Git so a crash or transient repository failure can be
    // retried safely on the next boot.
    version: 40,
    name: "checkpoint_ref_cleanup_queue",
    sql: `
      CREATE TABLE checkpoint_ref_cleanup_queue (
        cwd TEXT NOT NULL,
        checkpoint_ref TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (cwd, checkpoint_ref)
      );

      CREATE INDEX idx_checkpoint_ref_cleanup_thread
        ON checkpoint_ref_cleanup_queue(thread_id, updated_at);
    `,
  },
  {
    // Make activity keyset pagination deterministic even for legacy rows that
    // predate provider event sequences, and cover the three hot retention /
    // cleanup lookup paths introduced by backend hardening.
    version: 41,
    name: "activity_pagination_and_cleanup_indexes",
    sql: `
      WITH ranked_null_activities AS (
        SELECT
          pending.activity_id,
          COALESCE(
            (
              SELECT MIN(existing.sequence)
              FROM projection_thread_activities AS existing
              WHERE existing.thread_id = pending.thread_id
            ),
            COUNT(*) OVER (PARTITION BY pending.thread_id)
          )
          - COUNT(*) OVER (PARTITION BY pending.thread_id)
          + ROW_NUMBER() OVER (
            PARTITION BY pending.thread_id
            ORDER BY pending.created_at ASC, pending.activity_id ASC
          )
          - 1 AS backfilled_sequence
        FROM projection_thread_activities AS pending
        WHERE pending.sequence IS NULL
      )
      UPDATE projection_thread_activities
      SET sequence = (
        SELECT ranked.backfilled_sequence
        FROM ranked_null_activities AS ranked
        WHERE ranked.activity_id = projection_thread_activities.activity_id
      )
      WHERE sequence IS NULL;

      CREATE INDEX IF NOT EXISTS idx_thread_activities_page
        ON projection_thread_activities(
          thread_id,
          sequence DESC,
          created_at DESC,
          activity_id DESC
        );

      CREATE INDEX IF NOT EXISTS idx_checkpoint_diffs_checkpoint_ref
        ON checkpoint_diffs(checkpoint_ref);

      CREATE INDEX IF NOT EXISTS idx_threads_retention
        ON projection_threads(status, archived_at, thread_id);
    `,
  },
  {
    // Cleanup generations prevent a delayed worker from acknowledging a
    // newer intent for the same deterministic ref. The scan index supports
    // bounded keyset recovery, while durable turn slots prevent checkpoint
    // ref reuse after a backend restart.
    version: 42,
    name: "checkpoint_cleanup_generations_and_turn_slots",
    sql: `
      ALTER TABLE checkpoint_ref_cleanup_queue
        ADD COLUMN intent_id TEXT;

      UPDATE checkpoint_ref_cleanup_queue
      SET intent_id = lower(hex(randomblob(16)))
      WHERE intent_id IS NULL;

      CREATE UNIQUE INDEX idx_checkpoint_ref_cleanup_intent
        ON checkpoint_ref_cleanup_queue(intent_id);

      CREATE INDEX idx_checkpoint_ref_cleanup_scan
        ON checkpoint_ref_cleanup_queue(
          created_at,
          cwd,
          checkpoint_ref
        );

      CREATE TABLE checkpoint_turn_slots (
        thread_id TEXT PRIMARY KEY,
        next_slot INTEGER NOT NULL CHECK(next_slot >= 0),
        updated_at TEXT NOT NULL,
        FOREIGN KEY(thread_id)
          REFERENCES projection_threads(thread_id)
          ON DELETE CASCADE
      );

      INSERT INTO checkpoint_turn_slots(thread_id, next_slot, updated_at)
      SELECT thread_id, MAX(turn_index), datetime('now')
      FROM turn_diffs
      WHERE 1 = 1
      GROUP BY thread_id
      ON CONFLICT(thread_id) DO UPDATE SET
        next_slot = MAX(checkpoint_turn_slots.next_slot, excluded.next_slot),
        updated_at = excluded.updated_at;

      CREATE TABLE checkpoint_baselines (
        thread_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        checkpoint_ref TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        FOREIGN KEY(thread_id)
          REFERENCES projection_threads(thread_id)
          ON DELETE CASCADE
      );
    `,
  },
  {
    // A checkpoint turn is a durable boundary, not an ordinal assistant
    // message. Persist the provider turn and exact message sequence observed
    // when its diff is projected so synthetic compaction messages and failed
    // turns without an assistant response cannot shift a later revert.
    version: 43,
    name: "checkpoint_turn_message_boundaries",
    sql: `
      ALTER TABLE turn_diffs ADD COLUMN turn_id TEXT;
      ALTER TABLE turn_diffs ADD COLUMN dispatch_turn_id TEXT;
      ALTER TABLE turn_diffs ADD COLUMN boundary_message_id TEXT;
      ALTER TABLE turn_diffs
        ADD COLUMN boundary_sequence INTEGER NOT NULL DEFAULT -1;

      UPDATE turn_diffs
      SET dispatch_turn_id = (
        SELECT checkpoint_diffs.turn_id
        FROM checkpoint_diffs
        JOIN chat_dispatches
          ON chat_dispatches.thread_id = checkpoint_diffs.thread_id
         AND chat_dispatches.provider_turn_id =
           checkpoint_diffs.turn_id
        WHERE checkpoint_diffs.thread_id = turn_diffs.thread_id
          AND checkpoint_diffs.checkpoint_ref LIKE
            '%/turn/' || CAST((turn_diffs.turn_index * 2) - 1 AS TEXT)
        ORDER BY checkpoint_diffs.id DESC
        LIMIT 1
      )
      WHERE dispatch_turn_id IS NULL;

      WITH checkpoint_turns AS (
        SELECT
          thread_id,
          turn_id,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY MIN(id) ASC, turn_id ASC
          ) AS turn_index
        FROM checkpoint_diffs
        GROUP BY thread_id, turn_id
      )
      UPDATE turn_diffs
      SET dispatch_turn_id = (
        SELECT checkpoint_turns.turn_id
        FROM checkpoint_turns
        JOIN chat_dispatches
          ON chat_dispatches.thread_id = checkpoint_turns.thread_id
         AND chat_dispatches.provider_turn_id =
           checkpoint_turns.turn_id
        WHERE checkpoint_turns.thread_id = turn_diffs.thread_id
          AND checkpoint_turns.turn_index = turn_diffs.turn_index
        LIMIT 1
      )
      WHERE dispatch_turn_id IS NULL;

      UPDATE turn_diffs
      SET turn_id = (
        SELECT COALESCE(
          json_extract(payload_json, '$.payload.turn_id'),
          json_extract(payload_json, '$.payload.turnId')
        )
        FROM orchestration_events
        WHERE aggregate_kind = 'provider_runtime'
          AND stream_id = turn_diffs.thread_id
          AND event_type IN (
            'ProviderRuntime:turn_completed',
            'ProviderRuntime:turn_interrupted',
            'ProviderRuntime:turn_error',
            'ProviderRuntime:turn.completed',
            'ProviderRuntime:turn.aborted'
          )
          AND COALESCE(
            json_extract(payload_json, '$.payload.dispatchTurnId'),
            json_extract(payload_json, '$.payload.dispatch_turn_id')
          ) = turn_diffs.dispatch_turn_id
        ORDER BY sequence DESC
        LIMIT 1
      )
      WHERE dispatch_turn_id IS NOT NULL AND turn_id IS NULL;

      UPDATE turn_diffs
      SET turn_id = (
        SELECT assistant.turn_id
        FROM chat_dispatches AS dispatch
        JOIN projection_messages AS dispatch_message
          ON dispatch_message.thread_id = dispatch.thread_id
         AND dispatch_message.message_id = dispatch.message_id
        JOIN projection_messages AS assistant
          ON assistant.thread_id = dispatch.thread_id
         AND assistant.role = 'assistant'
         AND assistant.turn_id IS NOT NULL
         AND assistant.sequence > dispatch_message.sequence
        WHERE dispatch.thread_id = turn_diffs.thread_id
          AND dispatch.provider_turn_id = turn_diffs.dispatch_turn_id
          AND NOT EXISTS (
            SELECT 1
            FROM chat_dispatches AS next_dispatch
            JOIN projection_messages AS next_message
              ON next_message.thread_id = next_dispatch.thread_id
             AND next_message.message_id = next_dispatch.message_id
            WHERE next_dispatch.thread_id = dispatch.thread_id
              AND next_message.sequence > dispatch_message.sequence
              AND next_message.sequence <= assistant.sequence
          )
        ORDER BY assistant.sequence DESC, assistant.message_id DESC
        LIMIT 1
      )
      WHERE dispatch_turn_id IS NOT NULL AND turn_id IS NULL;

      UPDATE turn_diffs
      SET turn_id = (
        SELECT checkpoint_diffs.turn_id
        FROM checkpoint_diffs
        WHERE checkpoint_diffs.thread_id = turn_diffs.thread_id
          AND checkpoint_diffs.checkpoint_ref LIKE
            '%/turn/' || CAST((turn_diffs.turn_index * 2) - 1 AS TEXT)
        ORDER BY checkpoint_diffs.id DESC
        LIMIT 1
      )
      WHERE turn_id IS NULL AND dispatch_turn_id IS NULL;

      WITH checkpoint_turns AS (
        SELECT
          thread_id,
          turn_id,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY MIN(id) ASC, turn_id ASC
          ) AS turn_index
        FROM checkpoint_diffs
        GROUP BY thread_id, turn_id
      )
      UPDATE turn_diffs
      SET turn_id = (
        SELECT checkpoint_turns.turn_id
        FROM checkpoint_turns
        WHERE checkpoint_turns.thread_id = turn_diffs.thread_id
          AND checkpoint_turns.turn_index = turn_diffs.turn_index
      )
      WHERE turn_id IS NULL AND dispatch_turn_id IS NULL;

      WITH assistant_turns AS (
        SELECT
          thread_id,
          turn_id,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY MIN(sequence) ASC, turn_id ASC
          ) AS turn_index
        FROM projection_messages
        WHERE role = 'assistant' AND turn_id IS NOT NULL
        GROUP BY thread_id, turn_id
      )
      UPDATE turn_diffs
      SET turn_id = (
        SELECT assistant_turns.turn_id
        FROM assistant_turns
        WHERE assistant_turns.thread_id = turn_diffs.thread_id
          AND assistant_turns.turn_index = turn_diffs.turn_index
      )
      WHERE turn_id IS NULL AND dispatch_turn_id IS NULL;

      UPDATE turn_diffs
      SET boundary_message_id = COALESCE(
        (
          SELECT message_id
          FROM projection_messages
          WHERE projection_messages.thread_id = turn_diffs.thread_id
            AND turn_diffs.turn_id IS NOT NULL
            AND projection_messages.turn_id = turn_diffs.turn_id
          ORDER BY sequence DESC, message_id DESC
          LIMIT 1
        ),
        (
          SELECT message_id
          FROM projection_messages
          WHERE projection_messages.thread_id = turn_diffs.thread_id
            AND projection_messages.created_at <= turn_diffs.created_at
          ORDER BY sequence DESC, message_id DESC
          LIMIT 1
        )
      )
      WHERE boundary_message_id IS NULL;

      UPDATE turn_diffs
      SET boundary_sequence = COALESCE(
        (
          SELECT sequence
          FROM projection_messages
          WHERE projection_messages.thread_id = turn_diffs.thread_id
            AND projection_messages.message_id =
              turn_diffs.boundary_message_id
          LIMIT 1
        ),
        -1
      );

      CREATE INDEX idx_turn_diffs_turn_id
        ON turn_diffs(thread_id, turn_id);
      CREATE INDEX idx_turn_diffs_dispatch_turn_id
        ON turn_diffs(thread_id, dispatch_turn_id);
      CREATE INDEX idx_turn_diffs_boundary
        ON turn_diffs(thread_id, boundary_sequence, turn_index);
      CREATE INDEX idx_turn_diffs_boundary_message
        ON turn_diffs(thread_id, boundary_message_id)
        WHERE boundary_message_id IS NOT NULL;

      DROP TRIGGER IF EXISTS projection_messages_turn_count_insert;
      DROP TRIGGER IF EXISTS projection_messages_turn_count_delete;
      DROP TRIGGER IF EXISTS projection_messages_turn_count_role_update;
      DROP TRIGGER IF EXISTS projection_turns_turn_count_insert;
      DROP TRIGGER IF EXISTS projection_turns_turn_count_delete;
      DROP TRIGGER IF EXISTS projection_turns_turn_count_status_update;

      UPDATE projection_threads
      SET turn_count = ${projectionThreadTurnCountSql(
        "projection_threads.thread_id"
      )};

      CREATE TRIGGER projection_messages_turn_count_insert
      AFTER INSERT ON projection_messages
      WHEN NEW.role = 'assistant' AND NEW.turn_id IS NOT NULL
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER projection_messages_turn_count_delete
      AFTER DELETE ON projection_messages
      WHEN OLD.role = 'assistant' AND OLD.turn_id IS NOT NULL
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
      END;

      CREATE TRIGGER projection_messages_turn_count_role_update
      AFTER UPDATE OF role, turn_id, thread_id ON projection_messages
      WHEN (
        OLD.role = 'assistant' AND OLD.turn_id IS NOT NULL
      ) OR (
        NEW.role = 'assistant' AND NEW.turn_id IS NOT NULL
      )
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER projection_turns_turn_count_insert
      AFTER INSERT ON projection_turns
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER projection_turns_turn_count_delete
      AFTER DELETE ON projection_turns
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
      END;

      CREATE TRIGGER projection_turns_turn_count_status_update
      AFTER UPDATE OF status, thread_id ON projection_turns
      WHEN OLD.status <> NEW.status OR OLD.thread_id <> NEW.thread_id
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER turn_diffs_turn_count_insert
      AFTER INSERT ON turn_diffs
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER turn_diffs_turn_count_delete
      AFTER DELETE ON turn_diffs
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
      END;

      CREATE TRIGGER turn_diffs_turn_count_update
      AFTER UPDATE OF turn_index, thread_id ON turn_diffs
      WHEN OLD.turn_index <> NEW.turn_index OR OLD.thread_id <> NEW.thread_id
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id;
      END;

      CREATE TRIGGER turn_diff_boundary_sequence_update
      AFTER UPDATE OF sequence ON projection_messages
      WHEN OLD.sequence <> NEW.sequence
      BEGIN
        UPDATE turn_diffs
        SET boundary_sequence = NEW.sequence
        WHERE thread_id = NEW.thread_id
          AND boundary_message_id = NEW.message_id;
      END;

      CREATE TRIGGER turn_diff_boundary_message_delete
      AFTER DELETE ON projection_messages
      WHEN EXISTS (
        SELECT 1
        FROM turn_diffs
        WHERE thread_id = OLD.thread_id
          AND boundary_message_id = OLD.message_id
      )
      BEGIN
        UPDATE turn_diffs
        SET boundary_message_id = (
              SELECT message_id
              FROM projection_messages
              WHERE thread_id = OLD.thread_id
                AND sequence <= OLD.sequence
              ORDER BY sequence DESC, message_id DESC
              LIMIT 1
            ),
            boundary_sequence = COALESCE((
              SELECT sequence
              FROM projection_messages
              WHERE thread_id = OLD.thread_id
                AND sequence <= OLD.sequence
              ORDER BY sequence DESC, message_id DESC
              LIMIT 1
            ), -1)
        WHERE thread_id = OLD.thread_id
          AND boundary_message_id = OLD.message_id;
      END;
    `,
  },
  {
    // A provider may mutate the workspace after its pre-turn checkpoint but
    // before the post-turn diff is projected. Persist that admission so a
    // process crash cannot rewind the allocator and silently attribute those
    // mutations to a later turn.
    version: 44,
    name: "durable_checkpoint_turn_admissions",
    sql: `
      CREATE TABLE checkpoint_turn_admissions (
        thread_id TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        turn_id TEXT,
        dispatch_turn_id TEXT,
        turn_index INTEGER NOT NULL CHECK(turn_index > 0),
        cwd TEXT NOT NULL CHECK(length(cwd) > 0),
        base_checkpoint_ref TEXT NOT NULL,
        checkpoint_ref TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'prepared'
          CHECK(status IN ('prepared', 'failed')),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, turn_key),
        UNIQUE(thread_id, turn_index),
        UNIQUE(checkpoint_ref),
        FOREIGN KEY(thread_id)
          REFERENCES projection_threads(thread_id)
          ON DELETE CASCADE
      );

      CREATE INDEX idx_checkpoint_turn_admissions_status
        ON checkpoint_turn_admissions(status, updated_at, thread_id);
      CREATE INDEX idx_checkpoint_turn_admissions_base_ref
        ON checkpoint_turn_admissions(base_checkpoint_ref);
    `,
  },
  {
    // Provider-neutral permission state. User grants apply to every workspace;
    // workspace grants carry one canonical absolute workspace path. Path scopes
    // remain normalized workspace-relative values and are re-confined by the
    // policy service before use. Trust is deliberately independent from grants
    // so an explicit untrusted state always wins without deleting user choices.
    version: 45,
    name: "agent_permission_grants_and_workspace_trust",
    sql: `
      CREATE TABLE agent_permission_grants (
        id TEXT PRIMARY KEY CHECK(length(id) > 0),
        destination TEXT NOT NULL
          CHECK(destination IN ('user', 'workspace')),
        workspace_path TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL CHECK(length(tool_name) > 0),
        path_scope TEXT NOT NULL CHECK(length(path_scope) > 0),
        behavior TEXT NOT NULL CHECK(behavior IN ('allow', 'deny', 'ask')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (destination = 'user' AND workspace_path = '')
          OR
          (destination = 'workspace' AND length(workspace_path) > 0)
        ),
        UNIQUE(destination, workspace_path, tool_name, path_scope)
      );

      CREATE INDEX idx_agent_permission_grants_workspace
        ON agent_permission_grants(workspace_path, destination, tool_name);
      CREATE INDEX idx_agent_permission_grants_behavior
        ON agent_permission_grants(behavior, updated_at);

      CREATE TABLE agent_workspace_trust (
        workspace_path TEXT PRIMARY KEY CHECK(length(workspace_path) > 0),
        state TEXT NOT NULL CHECK(state IN ('trusted', 'untrusted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_agent_workspace_trust_state
        ON agent_workspace_trust(state, updated_at);
    `,
  },
  {
    version: 46,
    name: "bounded_thread_read_and_snapshot_work",
    sql: `
      CREATE INDEX idx_threads_status_page
        ON projection_threads(status, updated_at DESC, thread_id DESC);
      CREATE INDEX idx_assistant_thread_turn
        ON projection_messages(thread_id, turn_id)
        WHERE role = 'assistant' AND turn_id IS NOT NULL;
      DROP TRIGGER projection_messages_turn_count_role_update;
      CREATE TRIGGER projection_messages_turn_count_role_update
      AFTER UPDATE OF role, turn_id, thread_id ON projection_messages
      WHEN (OLD.role IS NOT NEW.role OR OLD.turn_id IS NOT NEW.turn_id OR OLD.thread_id IS NOT NEW.thread_id)
        AND ((OLD.role = 'assistant' AND OLD.turn_id IS NOT NULL)
          OR (NEW.role = 'assistant' AND NEW.turn_id IS NOT NULL))
      BEGIN
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("OLD.thread_id")}
        WHERE thread_id = OLD.thread_id;
        UPDATE projection_threads
        SET turn_count = ${projectionThreadTurnCountSql("NEW.thread_id")}
        WHERE thread_id = NEW.thread_id AND NEW.thread_id <> OLD.thread_id;
      END;
    `,
  },
  {
    version: 47,
    name: "compact_message_usage_projection",
    sql: `
      CREATE TABLE projection_message_usage (
        message_id TEXT PRIMARY KEY REFERENCES projection_messages(message_id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        runtime_sequence INTEGER,
        model_id,
        input_tokens REAL NOT NULL,
        output_tokens REAL NOT NULL,
        reasoning_tokens REAL NOT NULL,
        cache_read_tokens REAL NOT NULL,
        cache_write_tokens REAL NOT NULL,
        cost REAL NOT NULL,
        tools_json TEXT NOT NULL
      );
      CREATE INDEX idx_message_usage_thread_date ON projection_message_usage(thread_id, created_at);
      ${messageUsageProjectionSql()}
      CREATE TRIGGER message_usage_insert AFTER INSERT ON projection_messages BEGIN
        ${messageUsageProjectionSql("WHERE source.message_id = NEW.message_id")}
      END;
      CREATE TRIGGER message_usage_update AFTER UPDATE OF content_json, role, thread_id, created_at ON projection_messages BEGIN
        ${messageUsageProjectionSql("WHERE source.message_id = NEW.message_id")}
      END;
    `,
  },
  {
    version: 48,
    name: "read_model_cache_revisions",
    sql: `
      CREATE TABLE backend_read_revisions (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO backend_read_revisions VALUES ('workspaces', 0), ('stats', 0);
      CREATE TRIGGER revision_workspaces_projection_projects_insert AFTER INSERT ON projection_projects BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'workspaces'; END;
      CREATE TRIGGER revision_workspaces_projection_projects_delete AFTER DELETE ON projection_projects BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'workspaces'; END;
      CREATE TRIGGER revision_workspaces_projection_projects_update AFTER UPDATE OF path ON projection_projects WHEN OLD.path IS NOT NEW.path BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'workspaces'; END;
      CREATE TRIGGER revision_workspaces_projection_threads_insert AFTER INSERT ON projection_threads BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'workspaces'; END;
      CREATE TRIGGER revision_workspaces_projection_threads_delete AFTER DELETE ON projection_threads BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'workspaces'; END;
      CREATE TRIGGER revision_workspaces_projection_threads_update AFTER UPDATE OF status, project_path ON projection_threads WHEN OLD.status IS NOT NEW.status OR OLD.project_path IS NOT NEW.project_path BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'workspaces'; END;
      CREATE TRIGGER revision_workspaces_worktree_registry_insert AFTER INSERT ON worktree_registry BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'workspaces'; END;
      CREATE TRIGGER revision_workspaces_worktree_registry_delete AFTER DELETE ON worktree_registry BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'workspaces'; END;
      CREATE TRIGGER revision_workspaces_worktree_registry_update AFTER UPDATE OF state, worktree_path ON worktree_registry WHEN OLD.state IS NOT NEW.state OR OLD.worktree_path IS NOT NEW.worktree_path BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'workspaces'; END;
      CREATE TRIGGER revision_stats_projection_message_usage_insert AFTER INSERT ON projection_message_usage BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'stats'; END;
      CREATE TRIGGER revision_stats_projection_message_usage_delete AFTER DELETE ON projection_message_usage BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'stats'; END;
      CREATE TRIGGER revision_stats_projection_message_usage_update AFTER UPDATE OF thread_id, role, created_at, model_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost, tools_json ON projection_message_usage WHEN OLD.thread_id IS NOT NEW.thread_id OR OLD.role IS NOT NEW.role OR OLD.created_at IS NOT NEW.created_at OR OLD.model_id IS NOT NEW.model_id OR OLD.input_tokens IS NOT NEW.input_tokens OR OLD.output_tokens IS NOT NEW.output_tokens OR OLD.reasoning_tokens IS NOT NEW.reasoning_tokens OR OLD.cache_read_tokens IS NOT NEW.cache_read_tokens OR OLD.cache_write_tokens IS NOT NEW.cache_write_tokens OR OLD.cost IS NOT NEW.cost OR OLD.tools_json IS NOT NEW.tools_json BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'stats'; END;
      CREATE TRIGGER revision_stats_projection_threads_insert AFTER INSERT ON projection_threads BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'stats'; END;
      CREATE TRIGGER revision_stats_projection_threads_delete AFTER DELETE ON projection_threads BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'stats'; END;
      CREATE TRIGGER revision_stats_projection_threads_update AFTER UPDATE OF project_path, status, created_at, updated_at ON projection_threads WHEN OLD.project_path IS NOT NEW.project_path OR OLD.status IS NOT NEW.status OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at BEGIN UPDATE backend_read_revisions SET version = version + 1 WHERE name = 'stats'; END;
      `,
  },
  {
    // Every index here is a strict prefix of a wider index (or of the rowid
    // itself), so SQLite never needs it to answer a query but pays for it on
    // every write to the busiest tables. Dropped:
    //   idx_events_sequence            — `sequence` is the INTEGER PRIMARY KEY
    //   idx_thread_activities_thread   — prefix of idx_thread_activities_page
    //   idx_messages_thread            — prefix of idx_messages_thread_seq
    //   idx_turn_diffs_thread          — prefix of PRIMARY KEY (thread_id, turn_index)
    //   idx_checkpoint_thread          — prefix of idx_checkpoint_thread_turn_latest
    //   idx_threads_project            — prefix of idx_threads_project_status_updated
    //   idx_threads_status             — prefix of idx_threads_status_page
    //   idx_threads_status_updated     — prefix of idx_threads_status_page
    version: 49,
    name: "drop_redundant_prefix_indexes",
    sql: `
      DROP INDEX IF EXISTS idx_events_sequence;
      DROP INDEX IF EXISTS idx_thread_activities_thread;
      DROP INDEX IF EXISTS idx_messages_thread;
      DROP INDEX IF EXISTS idx_turn_diffs_thread;
      DROP INDEX IF EXISTS idx_checkpoint_thread;
      DROP INDEX IF EXISTS idx_threads_project;
      DROP INDEX IF EXISTS idx_threads_status;
      DROP INDEX IF EXISTS idx_threads_status_updated;
    `,
  },
  {
    // Startup-replay bookkeeping for the provider runtime journal: how many
    // boots have tried and failed to project a journal row. The replayer
    // discards a row after a bounded number of attempts instead of refusing
    // to start forever on one poisoned event. Cascades with the event row.
    version: 50,
    name: "provider_runtime_replay_attempts",
    sql: `
      CREATE TABLE IF NOT EXISTS provider_runtime_replay_attempts (
        event_sequence INTEGER PRIMARY KEY,
        attempts INTEGER NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (event_sequence) REFERENCES orchestration_events(sequence)
          ON DELETE CASCADE
      );
    `,
  },
  {
    // The provider runtime journal now stores two row shapes, told apart by
    // `metadata_json.$.schema`: 1 and 2 are the legacy `{event_type,
    // thread_id, payload}` shape, 3 is the canonical `ProviderRuntimeEvent`.
    // Rows written before the marker existed have no `schema` key at all;
    // stamp them 1 so every provider_runtime row carries an explicit shape.
    // Only unmarked rows are touched — a marked row's metadata must stay
    // byte-identical, and rows that are not valid JSON objects are left for
    // the replayer to discard as malformed. "Unmarked" is an absent key:
    // `json_type(..., '$.schema')` is SQL NULL only when the key is missing,
    // where `json_extract` would also be NULL for a JSON `null` value and
    // stamp a row that carries an explicit (if odd) marker. `payload_json`,
    // receipts and replay attempts are untouched; no index changes, so no
    // ANALYZE.
    version: 51,
    name: "provider_runtime_journal_schema_backfill",
    sql: `
      UPDATE orchestration_events
      SET metadata_json = json_set(metadata_json, '$.schema', 1)
      WHERE aggregate_kind = 'provider_runtime'
        AND json_valid(metadata_json)
        AND json_type(metadata_json) = 'object'
        AND json_type(metadata_json, '$.schema') IS NULL;
    `,
  },
  {
    version: 52,
    name: "provider_goal_projection",
    // SQL NULL means no goal metadata observed; JSON null is an authoritative clear.
    sql: `ALTER TABLE projection_threads ADD COLUMN provider_goal_json TEXT;`,
  },
]

/** Any statement that adds or removes an index, `CREATE UNIQUE INDEX` included. */
export const INDEX_SHAPE_SQL =
  /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX)\b/i

/**
 * Rows ANALYZE samples per index after an index migration. A full ANALYZE
 * walks every row of every index and, on a journal with years of provider
 * events, held startup for seconds; a bounded sample is what SQLite itself
 * uses for `PRAGMA optimize` and is accurate enough for plan selection.
 */
export const POST_MIGRATION_ANALYSIS_LIMIT = 1000

export function runMigrations(
  db: Db,
  migrations: ReadonlyArray<Migration> = MIGRATIONS
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  const applied = new Set<number>(
    (
      db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{
        version: number
      }>
    ).map((r) => r.version)
  )
  const latestSupported = migrations.reduce(
    (latest, migration) => Math.max(latest, migration.version),
    0
  )
  if ([...applied].some((version) => version > latestSupported)) {
    throw Object.assign(
      new Error(
        "Cannot open a newer database schema with this version of BetterC0de. Use the version that upgraded this profile or a newer release."
      ),
      { code: "DATABASE_SCHEMA_TOO_NEW" }
    )
  }

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
  )

  // Each migration is now wrapped in a single SQLite transaction.  Without
  // this, a partial failure (e.g. CREATE TABLE succeeds but a follow-on
  // CREATE INDEX fails) left the schema half-applied while the
  // schema_migrations row was either inserted against a broken schema or
  // never inserted at all — both states require manual recovery.
  // better-sqlite3 transactions are synchronous and roll back on throw.
  const applyMigration = db.transaction((migration: Migration) => {
    db.exec(migration.sql)
    insertMigration.run(
      migration.version,
      migration.name,
      new Date().toISOString()
    )
  })

  let indexShapeChanged = false
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue
    logger.info(
      { version: migration.version, name: migration.name },
      "Running migration"
    )
    try {
      applyMigration(migration)
    } catch (err) {
      logger.fatal(
        { err, version: migration.version, name: migration.name },
        "Migration failed; database left unchanged. Aborting startup."
      )
      throw err
    }
    if (INDEX_SHAPE_SQL.test(migration.sql)) indexShapeChanged = true
  }

  // The planner's stat tables describe the indexes that existed when they
  // were last gathered. Refresh them once whenever a migration changed the
  // index shape, so a new index is chosen (and a dropped one forgotten) on
  // the very next query instead of after some later PRAGMA optimize. The
  // sample is bounded (see POST_MIGRATION_ANALYSIS_LIMIT); the per-session
  // `PRAGMA optimize` that openDatabase runs on close keeps it current
  // afterwards without ever paying for a full scan at startup.
  if (indexShapeChanged) {
    try {
      db.pragma(`analysis_limit = ${POST_MIGRATION_ANALYSIS_LIMIT}`)
      db.exec("ANALYZE")
    } catch (err) {
      logger.warn({ err }, "ANALYZE after index migration failed")
    }
  }
}
