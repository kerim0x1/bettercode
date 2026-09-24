import { afterEach, describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDatabase as openNativeDatabase, type Db } from "./db"
import {
  INDEX_SHAPE_SQL,
  MIGRATIONS,
  POST_MIGRATION_ANALYSIS_LIMIT,
  runMigrations,
} from "./migrations"
import { EventStore } from "./eventStore"
import {
  CheckpointDiffProjectionQuery,
  ThreadActivityProjectionQuery,
  ThreadProjectionQuery,
} from "./projections"
import { CheckpointTurnSlotStore } from "../checkpointing/CheckpointTurnSlotStore"

const databases: Db[] = []
const directories: string[] = []
function openDatabase(dbPath: string): Db {
  const db = openNativeDatabase(dbPath)
  databases.push(db)
  return db
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function tmpDbPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bc0de-mig-${label}-`))
  directories.push(dir)
  return path.join(dir, "test.sqlite")
}

describe("runMigrations", () => {
  it("refuses a newer database before applying any pending migrations", () => {
    const db = openDatabase(tmpDbPath("future-version"))
    runMigrations(db, MIGRATIONS.slice(0, 1))
    db.prepare(
      "INSERT INTO schema_migrations VALUES (?, 'future-version', ?)"
    ).run(
      Math.max(...MIGRATIONS.map((migration) => migration.version)) + 1,
      "2026-09-20T00:00:00.000Z"
    )
    const before = db
      .prepare("SELECT name, sql FROM sqlite_master ORDER BY name")
      .all()
    expect(() => runMigrations(db)).toThrow(/newer database schema/)
    expect(
      db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()
    ).toEqual(before)
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
    ).toEqual({ count: 2 })
  })

  it("creates every expected table on a fresh database", () => {
    const db = openDatabase(tmpDbPath("fresh"))
    runMigrations(db)

    const tableRows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as Array<{ name: string }>
    const names = new Set(tableRows.map((r) => r.name))

    // Every table referenced by the services must be present so queries
    // written against them don't explode on first read.
    for (const expected of [
      "orchestration_events",
      "orchestration_projection_cursors",
      "command_receipts",
      "checkpoint_diffs",
      "checkpoint_revert_quarantine",
      "diff_blobs",
      "provider_sessions",
      "projection_threads",
      "projection_messages",
      "projection_turns",
      "projection_projects",
      "projection_approvals",
      "projection_thread_activities",
      "provider_session_bindings",
      "provider_thread_epochs",
      "provider_runtime_projection_receipts",
      "pending_source_proposed_plan_implementations",
      "chat_dispatches",
      "turn_diffs",
      "worktree_registry",
      "remote_access_metadata",
      "remote_pairing_grants",
      "remote_access_sessions",
      "agent_permission_grants",
      "agent_workspace_trust",
      "schema_migrations",
    ]) {
      expect(names.has(expected), `missing table ${expected}`).toBe(true)
    }

    db.close()
  })

  it("adds durable agent grants and explicit workspace trust on upgrade", () => {
    const db = openDatabase(tmpDbPath("agent-permissions"))
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version < 45)
    )

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_permission_grants'"
        )
        .get()
    ).toBeUndefined()

    runMigrations(db)

    const now = "2026-07-24T00:00:00.000Z"
    db.prepare(
      `
      INSERT INTO agent_permission_grants
        (id, destination, workspace_path, tool_name, path_scope, behavior,
         created_at, updated_at)
      VALUES
        ('grant-user', 'user', '', '*', '.', 'ask', ?, ?),
        ('grant-project', 'workspace', '/workspace', 'bash', 'scripts',
         'deny', ?, ?)
    `
    ).run(now, now, now, now)
    db.prepare(
      `
      INSERT INTO agent_workspace_trust
        (workspace_path, state, created_at, updated_at)
      VALUES ('/workspace', 'untrusted', ?, ?)
    `
    ).run(now, now)

    expect(
      db
        .prepare(
          "SELECT destination, behavior FROM agent_permission_grants ORDER BY id"
        )
        .all()
    ).toEqual([
      { destination: "workspace", behavior: "deny" },
      { destination: "user", behavior: "ask" },
    ])
    expect(
      db
        .prepare(
          "SELECT state FROM agent_workspace_trust WHERE workspace_path = '/workspace'"
        )
        .get()
    ).toEqual({ state: "untrusted" })

    expect(() =>
      db
        .prepare(
          `
        INSERT INTO agent_permission_grants
          (id, destination, workspace_path, tool_name, path_scope, behavior,
           created_at, updated_at)
        VALUES ('invalid', 'user', '/must-be-empty', '*', '.', 'allow', ?, ?)
      `
        )
        .run(now, now)
    ).toThrow()

    db.close()
  })

  it("seeds existing provider audit events as already projected", () => {
    const db = openDatabase(tmpDbPath("provider-projection-seed"))
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version < 25)
    )
    db.prepare(
      `
      INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type,
         occurred_at, command_id, causation_event_id, correlation_id,
         actor_kind, payload_json, metadata_json)
      VALUES
        ('provider-event', 'provider_runtime', 'thread-1', 1,
         'ProviderRuntime:turn_completed', '2026-01-01T00:00:00.000Z',
         NULL, NULL, NULL, 'provider', '{}', '{}'),
        ('thread-event', 'thread', 'thread-1', 1,
         'ThreadCreated', '2026-01-01T00:00:00.000Z',
         NULL, NULL, NULL, 'user', '{}', '{}')
    `
    ).run()

    runMigrations(db)

    const receipts = db
      .prepare(
        `
        SELECT e.event_id, r.status
        FROM provider_runtime_projection_receipts r
        JOIN orchestration_events e ON e.sequence = r.event_sequence
        ORDER BY e.sequence
      `
      )
      .all() as Array<{ event_id: string; status: string }>
    expect(receipts).toEqual([
      { event_id: "provider-event", status: "projected" },
    ])
    expect(
      db
        .prepare(
          `
        SELECT last_sequence
        FROM orchestration_projection_cursors
        WHERE projection_name = 'durable_api'
      `
        )
        .get()
    ).toEqual({ last_sequence: 2 })
    db.close()
  })

  it("removes ambiguous pre-admission plan links when adding accepted turn identity", () => {
    const db = openDatabase(tmpDbPath("accepted-plan-turn"))
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version < 27)
    )
    const now = "2026-07-11T00:00:00.000Z"
    db.prepare(
      `
      INSERT INTO projection_threads
        (thread_id, project_id, created_at, updated_at)
      VALUES
        ('source-thread', 'project-1', ?, ?),
        ('implementation-thread', 'project-1', ?, ?)
    `
    ).run(now, now, now, now)
    db.prepare(
      `
      INSERT INTO pending_source_proposed_plan_implementations
        (implementation_thread_id, source_thread_id, source_plan_id,
         provider_kind, provider_instance_id, created_at, updated_at)
      VALUES ('implementation-thread', 'source-thread', 'plan-1',
              'claude', 'claude-main', ?, ?)
    `
    ).run(now, now)

    runMigrations(db)

    const columns = db
      .prepare(
        "PRAGMA table_info(pending_source_proposed_plan_implementations)"
      )
      .all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain("accepted_turn_id")
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM pending_source_proposed_plan_implementations"
        )
        .get()
    ).toEqual({ count: 0 })
    db.close()
  })

  it("upgrades a version-27 database with the constrained chat dispatch outbox", () => {
    const db = openDatabase(tmpDbPath("chat-dispatch-outbox"))
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version < 28)
    )
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_dispatches'"
        )
        .get()
    ).toBeUndefined()

    runMigrations(db)

    const columns = db
      .prepare("PRAGMA table_info(chat_dispatches)")
      .all() as Array<{
      name: string
    }>
    expect(columns.map((column) => column.name)).toEqual([
      "dispatch_id",
      "thread_id",
      "message_id",
      "provider_kind",
      "provider_instance_id",
      "request_fingerprint",
      "status",
      "provider_turn_id",
      "attempt_count",
      "last_error",
      "created_at",
      "updated_at",
      "accepted_at",
      "completed_at",
      "failed_at",
      "recovery_completed_at",
    ])
    const indexes = db
      .prepare("PRAGMA index_list(chat_dispatches)")
      .all() as Array<{
      name: string
    }>
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_chat_dispatches_thread_status",
        "idx_chat_dispatches_recovery",
      ])
    )
    const foreignKeys = db
      .prepare("PRAGMA foreign_key_list(chat_dispatches)")
      .all() as Array<{
      from: string
      table: string
      on_delete: string
    }>
    expect(foreignKeys).toEqual([
      expect.objectContaining({
        from: "thread_id",
        table: "projection_threads",
        on_delete: "CASCADE",
      }),
    ])

    const now = "2026-07-11T00:00:00.000Z"
    db.prepare(
      `
      INSERT INTO projection_threads
        (thread_id, project_id, created_at, updated_at)
      VALUES ('thread-1', 'project-1', ?, ?)
    `
    ).run(now, now)
    const insert = db.prepare(`
      INSERT INTO chat_dispatches
        (dispatch_id, thread_id, message_id, provider_kind,
         request_fingerprint, status, created_at, updated_at)
      VALUES (?, 'thread-1', ?, 'claude', 'fingerprint', ?, ?, ?)
    `)
    expect(() =>
      insert.run("message-reverted", "message-reverted", "reverted", now, now)
    ).not.toThrow()
    expect(() =>
      insert.run("message-invalid", "message-invalid", "invalid", now, now)
    ).toThrow()
    expect(() =>
      insert.run("message-duplicate", "message-reverted", "pending", now, now)
    ).toThrow()
    db.close()
  })

  it("upgrades an applied version-28 outbox without losing lifecycle rows", () => {
    const db = openDatabase(tmpDbPath("chat-dispatch-terminal-receipts"))
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 28)
    )
    const now = "2026-07-11T00:00:00.000Z"
    db.prepare(
      `
      INSERT INTO projection_threads
        (thread_id, project_id, created_at, updated_at)
      VALUES ('thread-v28', 'project-v28', ?, ?)
    `
    ).run(now, now)
    const insertV28 = db.prepare(`
      INSERT INTO chat_dispatches
        (dispatch_id, thread_id, message_id, provider_kind,
         provider_instance_id, request_fingerprint, status, provider_turn_id,
         created_at, updated_at, accepted_at, failed_at)
      VALUES (?, 'thread-v28', ?, 'codex', 'codex-explicit', 'fingerprint',
              ?, ?, ?, ?, ?, ?)
    `)
    insertV28.run(
      "pending-v28",
      "pending-v28",
      "pending",
      null,
      now,
      now,
      null,
      null
    )
    insertV28.run(
      "accepted-v28",
      "accepted-v28",
      "accepted",
      "turn-accepted",
      now,
      now,
      now,
      null
    )
    insertV28.run(
      "failed-v28",
      "failed-v28",
      "failed",
      "turn-failed",
      now,
      now,
      now,
      now
    )
    insertV28.run(
      "uncertain-v28",
      "uncertain-v28",
      "uncertain",
      null,
      now,
      now,
      null,
      now
    )

    runMigrations(db)

    expect(
      db
        .prepare(
          `
        SELECT dispatch_id, status, provider_turn_id, provider_instance_id
        FROM chat_dispatches
        ORDER BY dispatch_id
      `
        )
        .all()
    ).toEqual([
      {
        dispatch_id: "accepted-v28",
        status: "accepted",
        provider_turn_id: "turn-accepted",
        provider_instance_id: "codex-explicit",
      },
      {
        dispatch_id: "failed-v28",
        status: "failed",
        provider_turn_id: "turn-failed",
        provider_instance_id: "codex-explicit",
      },
      {
        dispatch_id: "pending-v28",
        status: "pending",
        provider_turn_id: null,
        provider_instance_id: "codex-explicit",
      },
      {
        dispatch_id: "uncertain-v28",
        status: "uncertain",
        provider_turn_id: null,
        provider_instance_id: "codex-explicit",
      },
    ])
    expect(
      db.prepare("PRAGMA table_info(chat_dispatches)").all()
    ).toContainEqual(expect.objectContaining({ name: "completed_at" }))
    expect(() =>
      db
        .prepare(
          `
        UPDATE chat_dispatches
        SET status = 'completed', completed_at = ?
        WHERE dispatch_id = 'accepted-v28'
      `
        )
        .run(now)
    ).not.toThrow()
    expect(() =>
      db
        .prepare(
          `
        UPDATE chat_dispatches
        SET status = 'reverted'
        WHERE dispatch_id = 'pending-v28'
      `
        )
        .run()
    ).not.toThrow()
    db.close()
  })

  it("migration 11 adds worktree + PR columns to projection_threads", () => {
    const db = openDatabase(tmpDbPath("worktree-cols"))
    runMigrations(db)

    const cols = db
      .prepare("PRAGMA table_info(projection_threads)")
      .all() as Array<{ name: string }>
    const colNames = new Set(cols.map((c) => c.name))

    for (const expected of [
      "worktree_path",
      "branch",
      "base_branch",
      "worktree_state",
      "pr_number",
      "pr_url",
      "pr_state",
      "pr_mergeable",
      "pr_checked_at",
      "upstream_ahead",
      "upstream_behind",
      "approval_policy",
    ]) {
      expect(colNames.has(expected), `missing column ${expected}`).toBe(true)
    }
    db.close()
  })

  it("migration 15 adds provider instance ids to provider runtime tables", () => {
    const db = openDatabase(tmpDbPath("provider-instance-cols"))
    runMigrations(db)

    for (const table of [
      "provider_sessions",
      "projection_turns",
      "projection_thread_activities",
    ]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string
      }>
      const colNames = new Set(cols.map((c) => c.name))
      expect(
        colNames.has("provider_instance_id"),
        `missing provider_instance_id on ${table}`
      ).toBe(true)
    }
    db.close()
  })

  it("migration 41 backfills activity sequences and adds cleanup indexes", () => {
    const db = openDatabase(tmpDbPath("activity-cursor-indexes"))
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version < 41)
    )
    const insert = db.prepare(`
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, kind, tone, summary,
         payload_json, sequence, created_at, provider_instance_id)
      VALUES (?, ?, NULL, 'test', 'info', ?, '{}', ?, ?, NULL)
    `)
    insert.run(
      "existing",
      "thread-1",
      "existing",
      7,
      "2026-07-23T00:00:00.000Z"
    )
    insert.run(
      "null-old",
      "thread-1",
      "null-old",
      null,
      "2026-07-23T00:00:01.000Z"
    )
    insert.run(
      "null-new",
      "thread-1",
      "null-new",
      null,
      "2026-07-23T00:00:02.000Z"
    )
    insert.run(
      "other-thread",
      "thread-2",
      "other-thread",
      null,
      "2026-07-23T00:00:03.000Z"
    )

    runMigrations(db)

    expect(
      db
        .prepare(
          `
        SELECT activity_id, sequence
        FROM projection_thread_activities
        ORDER BY thread_id, created_at, activity_id
      `
        )
        .all()
    ).toEqual([
      { activity_id: "existing", sequence: 7 },
      { activity_id: "null-old", sequence: 5 },
      { activity_id: "null-new", sequence: 6 },
      { activity_id: "other-thread", sequence: 0 },
    ])

    const indexes = db
      .prepare(
        `
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
    `
      )
      .all() as Array<{ name: string }>
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "idx_thread_activities_page",
        "idx_checkpoint_diffs_checkpoint_ref",
        "idx_threads_retention",
      ])
    )
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE version = 41").get()
    ).toEqual({ name: "activity_pagination_and_cleanup_indexes" })
    db.close()
  })

  it("migration 42 adds cleanup generations, retained baselines, and durable turn slots", () => {
    const db = openDatabase(tmpDbPath("checkpoint-generation-slots"))
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version < 42)
    )
    db.prepare(
      `
      INSERT INTO projection_threads(
        thread_id,
        project_id,
        status,
        created_at,
        updated_at
      )
      VALUES ('thread-1', 'project-1', 'active', ?, ?)
    `
    ).run("2026-07-23T00:00:00.000Z", "2026-07-23T00:00:00.000Z")
    db.prepare(
      `
      INSERT INTO turn_diffs(
        thread_id,
        turn_index,
        diff_text,
        created_at
      )
      VALUES ('thread-1', 3, '', ?)
    `
    ).run("2026-07-23T00:00:03.000Z")
    db.prepare(
      `
      INSERT INTO checkpoint_ref_cleanup_queue(
        cwd,
        checkpoint_ref,
        thread_id,
        attempts,
        created_at,
        updated_at
      )
      VALUES ('/repo', 'refs/checkpoint/old', 'thread-1', 0, ?, ?)
    `
    ).run("2026-07-23T00:00:04.000Z", "2026-07-23T00:00:04.000Z")

    runMigrations(db)

    expect(
      db
        .prepare(
          `
        SELECT intent_id
        FROM checkpoint_ref_cleanup_queue
        WHERE checkpoint_ref = 'refs/checkpoint/old'
      `
        )
        .get()
    ).toEqual({ intent_id: expect.any(String) })
    expect(
      db
        .prepare(
          `
        SELECT next_slot
        FROM checkpoint_turn_slots
        WHERE thread_id = 'thread-1'
      `
        )
        .get()
    ).toEqual({ next_slot: 3 })
    expect(
      db
        .prepare(
          `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'checkpoint_baselines'
      `
        )
        .get()
    ).toEqual({ name: "checkpoint_baselines" })
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE version = 42").get()
    ).toEqual({
      name: "checkpoint_cleanup_generations_and_turn_slots",
    })
    db.close()
  })

  it("migration 43 backfills exact checkpoint message boundaries", () => {
    const db = openDatabase(tmpDbPath("checkpoint-message-boundaries"))
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version < 43)
    )
    const time = (second: number) => `2026-07-23T00:00:0${second}.000Z`
    db.prepare(
      `
      INSERT INTO projection_threads
        (thread_id, project_id, created_at, updated_at)
      VALUES ('thread-boundary', 'project-1', ?, ?)
    `
    ).run(time(0), time(0))
    const insertMessage = db.prepare(`
      INSERT INTO projection_messages
        (message_id, thread_id, turn_id, role, content_json, created_at,
         sequence)
      VALUES (?, 'thread-boundary', ?, ?, '{}', ?, ?)
    `)
    insertMessage.run("user-1", "turn-1", "user", time(0), 0)
    insertMessage.run("assistant-1", "turn-1", "assistant", time(1), 1)
    insertMessage.run("compaction", null, "assistant", time(2), 2)
    insertMessage.run("user-2", null, "user", time(3), 3)
    insertMessage.run("assistant-2", "native-2", "assistant", time(4), 4)
    insertMessage.run("user-failed", null, "user", time(5), 5)
    db.prepare(
      `
      INSERT INTO chat_dispatches
        (dispatch_id, thread_id, message_id, provider_kind,
         request_fingerprint, status, provider_turn_id, created_at,
         updated_at, accepted_at)
      VALUES
        ('dispatch-row-2', 'thread-boundary', 'user-2', 'codex',
         'fingerprint-2', 'completed', 'dispatch-2', ?, ?, ?),
        ('dispatch-row-failed', 'thread-boundary', 'user-failed', 'codex',
         'fingerprint-failed', 'failed', 'dispatch-failed', ?, ?, ?)
    `
    ).run(time(3), time(4), time(3), time(5), time(6), time(5))
    db.prepare(
      `
      INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type,
         occurred_at, payload_json)
      VALUES
        ('terminal-failed', 'provider_runtime', 'thread-boundary', 1,
         'ProviderRuntime:turn_error', ?, ?)
    `
    ).run(
      time(6),
      JSON.stringify({
        event_type: "turn_error",
        thread_id: "thread-boundary",
        payload: {
          turn_id: "native-failed",
          dispatchTurnId: "dispatch-failed",
        },
      })
    )
    db.prepare(
      `
      INSERT INTO checkpoint_diffs
        (thread_id, turn_id, checkpoint_ref, diff_content, created_at)
      VALUES
        ('thread-boundary', 'turn-1', 'refs/turn-1', '', ?),
        ('thread-boundary', 'dispatch-2', 'refs/turn-2', '', ?),
        ('thread-boundary', 'dispatch-failed', 'refs/turn-failed', '', ?)
    `
    ).run(time(1), time(4), time(6))
    db.prepare(
      `
      INSERT INTO turn_diffs
        (thread_id, turn_index, diff_text, created_at)
      VALUES
        ('thread-boundary', 1, '', ?),
        ('thread-boundary', 2, '', ?),
        ('thread-boundary', 3, '', ?)
    `
    ).run(time(1), time(4), time(6))

    runMigrations(db)

    expect(
      db
        .prepare(
          `
          SELECT
            turn_index,
            turn_id,
            dispatch_turn_id,
            boundary_message_id,
            boundary_sequence
          FROM turn_diffs
          WHERE thread_id = 'thread-boundary'
          ORDER BY turn_index
        `
        )
        .all()
    ).toEqual([
      {
        turn_index: 1,
        turn_id: "turn-1",
        dispatch_turn_id: null,
        boundary_message_id: "assistant-1",
        boundary_sequence: 1,
      },
      {
        turn_index: 2,
        turn_id: "native-2",
        dispatch_turn_id: "dispatch-2",
        boundary_message_id: "assistant-2",
        boundary_sequence: 4,
      },
      {
        turn_index: 3,
        turn_id: "native-failed",
        dispatch_turn_id: "dispatch-failed",
        boundary_message_id: "user-failed",
        boundary_sequence: 5,
      },
    ])
    expect(
      db
        .prepare(
          `SELECT turn_count FROM projection_threads
           WHERE thread_id = 'thread-boundary'`
        )
        .get()
    ).toEqual({ turn_count: 3 })
    expect(
      db.prepare(`SELECT name FROM schema_migrations WHERE version = 43`).get()
    ).toEqual({ name: "checkpoint_turn_message_boundaries" })
    expect(
      (
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_turn_diffs_%'`
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    ).toEqual(
      expect.arrayContaining([
        "idx_turn_diffs_turn_id",
        "idx_turn_diffs_dispatch_turn_id",
        "idx_turn_diffs_boundary",
        "idx_turn_diffs_boundary_message",
      ])
    )
    db.close()
  })

  it("adds orchestration identity, dispatch, recovery, and turn-count invariants", () => {
    const db = openDatabase(tmpDbPath("integrity-hardening"))
    runMigrations(db)

    expect(
      db.prepare("PRAGMA table_info(command_receipts)").all()
    ).toContainEqual(expect.objectContaining({ name: "request_hash" }))
    expect(
      db.prepare("PRAGMA table_info(projection_threads)").all()
    ).toContainEqual(expect.objectContaining({ name: "recovery_required" }))
    expect(
      db
        .prepare(
          `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'checkpoint_turn_admissions'
      `
        )
        .get()
    ).toEqual({ name: "checkpoint_turn_admissions" })
    expect(
      db.prepare("PRAGMA table_info(worktree_registry)").all()
    ).toContainEqual(
      expect.objectContaining({ name: "delete_branch_on_remove" })
    )
    expect(
      db
        .prepare(
          `
        SELECT last_sequence
        FROM orchestration_projection_cursors
        WHERE projection_name = 'durable_api'
      `
        )
        .get()
    ).toEqual({ last_sequence: 0 })

    const indexes = db
      .prepare(
        `
      SELECT name FROM sqlite_master
      WHERE type = 'index'
    `
      )
      .all() as Array<{ name: string }>
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "idx_events_unique_stream_version",
        "idx_chat_dispatches_provider_turn_identity",
        "idx_threads_status_page",
        "idx_provider_bindings_thread_updated",
      ])
    )

    const now = "2026-07-23T00:00:00.000Z"
    db.prepare(
      `
      INSERT INTO projection_threads
        (thread_id, project_id, created_at, updated_at)
      VALUES ('turn-count-thread', 'project', ?, ?)
    `
    ).run(now, now)
    db.prepare(
      `
      INSERT INTO projection_turns
        (turn_id, thread_id, status, started_at, completed_at)
      VALUES ('turn-1', 'turn-count-thread', 'completed', ?, ?)
    `
    ).run(now, now)
    expect(
      db
        .prepare(
          "SELECT turn_count FROM projection_threads WHERE thread_id = 'turn-count-thread'"
        )
        .get()
    ).toEqual({ turn_count: 1 })
    db.prepare(
      `
      INSERT INTO projection_messages
        (message_id, thread_id, turn_id, role, content_json, created_at,
         sequence)
      VALUES
        ('assistant-1', 'turn-count-thread', 'turn-1', 'assistant', '{}', ?, 0),
        ('assistant-compaction', 'turn-count-thread', NULL, 'assistant', '{}', ?, 1)
    `
    ).run(now, now)
    expect(
      db
        .prepare(
          "SELECT turn_count FROM projection_threads WHERE thread_id = 'turn-count-thread'"
        )
        .get()
    ).toEqual({ turn_count: 1 })
    db.prepare(
      `
      INSERT INTO projection_messages
        (message_id, thread_id, turn_id, role, content_json, created_at,
         sequence)
      VALUES
        ('assistant-2', 'turn-count-thread', 'turn-2', 'assistant', '{}', ?, 2)
    `
    ).run(now)
    expect(
      db
        .prepare(
          "SELECT turn_count FROM projection_threads WHERE thread_id = 'turn-count-thread'"
        )
        .get()
    ).toEqual({ turn_count: 2 })
    db.prepare(
      `
      INSERT INTO turn_diffs
        (thread_id, turn_index, diff_text, created_at)
      VALUES ('turn-count-thread', 4, '', ?)
    `
    ).run(now)
    expect(
      db
        .prepare(
          "SELECT turn_count FROM projection_threads WHERE thread_id = 'turn-count-thread'"
        )
        .get()
    ).toEqual({ turn_count: 4 })
    db.prepare(
      `
      DELETE FROM turn_diffs
      WHERE thread_id = 'turn-count-thread' AND turn_index = 4
    `
    ).run()
    expect(
      db
        .prepare(
          "SELECT turn_count FROM projection_threads WHERE thread_id = 'turn-count-thread'"
        )
        .get()
    ).toEqual({ turn_count: 2 })
    db.prepare(
      "DELETE FROM projection_messages WHERE message_id = 'assistant-2'"
    ).run()
    expect(
      db
        .prepare(
          "SELECT turn_count FROM projection_threads WHERE thread_id = 'turn-count-thread'"
        )
        .get()
    ).toEqual({ turn_count: 1 })
    db.prepare(
      "DELETE FROM projection_messages WHERE message_id = 'assistant-compaction'"
    ).run()
    expect(
      db
        .prepare(
          "SELECT turn_count FROM projection_threads WHERE thread_id = 'turn-count-thread'"
        )
        .get()
    ).toEqual({ turn_count: 1 })
    db.prepare(
      "DELETE FROM projection_messages WHERE message_id = 'assistant-1'"
    ).run()
    expect(
      db
        .prepare(
          "SELECT turn_count FROM projection_threads WHERE thread_id = 'turn-count-thread'"
        )
        .get()
    ).toEqual({ turn_count: 1 })
    db.prepare("DELETE FROM projection_turns WHERE turn_id = 'turn-1'").run()
    expect(
      db
        .prepare(
          "SELECT turn_count FROM projection_threads WHERE thread_id = 'turn-count-thread'"
        )
        .get()
    ).toEqual({ turn_count: 0 })
    db.close()
  })

  it("migration 16 creates provider session bindings keyed by thread and instance", () => {
    const db = openDatabase(tmpDbPath("provider-session-bindings"))
    runMigrations(db)

    const cols = db
      .prepare("PRAGMA table_info(provider_session_bindings)")
      .all() as Array<{ name: string; pk: number }>
    const colNames = new Set(cols.map((c) => c.name))
    for (const expected of [
      "thread_id",
      "provider_instance_id",
      "provider_kind",
      "provider_thread_id",
      "resume_cursor_json",
      "continuation_key",
      "status",
      "active_turn_id",
      "last_error",
      "runtime_mode",
      "cwd",
      "model_selection_json",
      "generation",
      "created_at",
      "updated_at",
    ]) {
      expect(colNames.has(expected), `missing column ${expected}`).toBe(true)
    }

    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name)
    expect(pkCols).toEqual(["thread_id", "provider_instance_id"])
    db.close()
  })

  it("migration 12 enforces UNIQUE on worktree branch + path", () => {
    const db = openDatabase(tmpDbPath("worktree-unique"))
    runMigrations(db)

    const insert = db.prepare(`
      INSERT INTO worktree_registry
        (worktree_id, thread_id, worktree_path, branch, base_branch, base_repo_path, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertThread = db.prepare(`
      INSERT INTO projection_threads
        (thread_id, project_id, title, status, env_mode, created_at, updated_at)
      VALUES (?, 'project-1', NULL, 'active', 'local', '2026-01-01', '2026-01-01')
    `)
    insertThread.run("t1")
    insertThread.run("t2")
    insertThread.run("thread-3")

    // First row: OK.
    insert.run(
      "w1",
      "t1",
      "/tmp/wt1",
      "agent/t1/foo",
      "main",
      "/proj",
      "ready",
      "2026-01-01",
      "2026-01-01"
    )

    // Second row with same branch must fail.
    expect(() =>
      insert.run(
        "w2",
        "t2",
        "/tmp/wt2",
        "agent/t1/foo",
        "main",
        "/proj",
        "ready",
        "2026-01-01",
        "2026-01-01"
      )
    ).toThrow(/UNIQUE/)

    // Same worktree_path must also fail.
    expect(() =>
      insert.run(
        "w3",
        "thread-3",
        "/tmp/wt1",
        "agent/other/bar",
        "main",
        "/proj",
        "ready",
        "2026-01-01",
        "2026-01-01"
      )
    ).toThrow(/UNIQUE/)

    db.close()
  })

  it("is idempotent — running twice doesn't error or duplicate rows", () => {
    const dbPath = tmpDbPath("idem")
    const db = openDatabase(dbPath)
    runMigrations(db)
    const firstCount = (
      db.prepare("SELECT COUNT(*) as n FROM schema_migrations").get() as {
        n: number
      }
    ).n
    expect(firstCount).toBeGreaterThan(0)

    // Re-run on the same open connection — guarded by `schema_migrations`.
    runMigrations(db)
    const secondCount = (
      db.prepare("SELECT COUNT(*) as n FROM schema_migrations").get() as {
        n: number
      }
    ).n
    expect(secondCount).toBe(firstCount)
    db.close()
  })

  // CR3 regression: a partial migration (CREATE TABLE OK, follow-on statement
  // fails) used to leave the schema half-applied with the version row written
  // against a broken structure. Each migration is now wrapped in a single
  // transaction so the failure case rolls back atomically.
  it("rolls back the entire migration when any statement inside it fails", () => {
    const dbPath = tmpDbPath("rollback")
    const db = openDatabase(dbPath)
    expect(() =>
      runMigrations(db, [
        {
          version: 1,
          name: "broken_migration",
          // CREATE TABLE succeeds, but the follow-on statement targets a
          // non-existent column and aborts. Without the per-migration
          // transaction, `cr3_table` would persist and the version row would
          // be either inserted-against-broken-state or absent.
          sql: `
            CREATE TABLE cr3_table (id INTEGER PRIMARY KEY);
            INSERT INTO cr3_table (does_not_exist) VALUES (1);
          `,
        },
      ])
    ).toThrow()

    const tableExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cr3_table'"
      )
      .get()
    expect(tableExists).toBeUndefined()

    const versionRow = db
      .prepare("SELECT version FROM schema_migrations WHERE version=1")
      .get()
    expect(versionRow).toBeUndefined()
    db.close()
  })
})

function explainPlan(db: Db, sql: string): string {
  const params = Array.from(
    { length: (sql.match(/\?/g) ?? []).length },
    () => "x"
  )
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string
    }>
  )
    .map((row) => row.detail)
    .join("\n")
}

/**
 * The SQL a store actually prepared, read off the better-sqlite3 statement
 * it holds. Explaining this rather than a hand-written lookalike is the
 * point: a test that plans its own SQL proves nothing about the code.
 */
function preparedSql(store: object, statementName: string): string {
  const statement = (store as Record<string, { source?: unknown }>)[
    statementName
  ]
  if (!statement || typeof statement.source !== "string") {
    throw new Error(
      `${store.constructor.name} has no prepared ${statementName}`
    )
  }
  return statement.source
}

describe("migration 49 redundant prefix indexes", () => {
  const droppedIndexes = [
    "idx_events_sequence",
    "idx_thread_activities_thread",
    "idx_messages_thread",
    "idx_turn_diffs_thread",
    "idx_checkpoint_thread",
    "idx_threads_project",
    "idx_threads_status",
    "idx_threads_status_updated",
  ]
  const indexNames = (db: Db) =>
    new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    )

  it("drops every listed index with IF EXISTS and nothing else", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 49)!
    expect(migration.name).toBe("drop_redundant_prefix_indexes")
    const statements = migration.sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
    expect(statements).toEqual(
      droppedIndexes.map((name) => `DROP INDEX IF EXISTS ${name}`)
    )
  })

  it("drops the prefix indexes on upgrade and refreshes planner statistics", () => {
    const db = openDatabase(tmpDbPath("drop-prefix-indexes"))
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version < 49)
    )
    const before = indexNames(db)
    for (const name of droppedIndexes) {
      expect(before.has(name), `${name} should exist before v49`).toBe(true)
    }

    runMigrations(db)
    const after = indexNames(db)
    for (const name of droppedIndexes) {
      expect(after.has(name), `${name} should be dropped by v49`).toBe(false)
    }
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'"
        )
        .get()
    ).toEqual({ name: "sqlite_stat1" })
    // The refresh was the bounded sample, not a full walk of every index.
    expect(db.pragma("analysis_limit", { simple: true })).toBe(
      POST_MIGRATION_ANALYSIS_LIMIT
    )
    db.close()
  })

  it("recognises every statement shape that changes the index set", () => {
    for (const sql of [
      "CREATE INDEX idx_x ON t(a)",
      "CREATE UNIQUE INDEX idx_x ON t(a)",
      "create unique index if not exists idx_x on t(a)",
      "DROP INDEX IF EXISTS idx_x",
    ]) {
      expect(INDEX_SHAPE_SQL.test(sql), sql).toBe(true)
    }
    for (const sql of [
      "CREATE TABLE t (a)",
      "CREATE TRIGGER trg AFTER INSERT ON t BEGIN SELECT 1; END",
      "ALTER TABLE t ADD COLUMN b",
    ]) {
      expect(INDEX_SHAPE_SQL.test(sql), sql).toBe(false)
    }
    // Every shipped migration that creates a unique index counts as a shape change.
    const uniqueIndexMigrations = MIGRATIONS.filter((migration) =>
      /CREATE UNIQUE INDEX/i.test(migration.sql)
    )
    expect(uniqueIndexMigrations.length).toBeGreaterThan(0)
    for (const migration of uniqueIndexMigrations) {
      expect(INDEX_SHAPE_SQL.test(migration.sql), `v${migration.version}`).toBe(
        true
      )
    }
  })

  // The ThreadService statements that hit these tables (message page,
  // delete-by-thread, thread list) are explained the same way in
  // services/threads/service.test.ts; this layer may not import services.
  it("keeps every hot per-thread statement the persistence stores prepare on an index after the drops", () => {
    const db = openDatabase(tmpDbPath("hot-queries-indexed"))
    runMigrations(db)
    const activities = new ThreadActivityProjectionQuery(db)
    const projectThreads = new ThreadProjectionQuery(db)
    const checkpointDiffs = new CheckpointDiffProjectionQuery(db)
    const turnSlots = new CheckpointTurnSlotStore(db)
    const events = new EventStore(db)
    const cases: Array<[object, string, RegExp, { sorts?: true }?]> = [
      [activities, "listNewestByThreadStmt", /idx_thread_activities_page/],
      // `status != 'archived'` is an inequality, so the index bounds the
      // rows to one project but cannot hand them over in updated_at order.
      [
        projectThreads,
        "listByProjectStmt",
        /idx_threads_project_status_updated/,
        { sorts: true },
      ],
      [turnSlots, "maxTurnIndexStmt", /sqlite_autoindex_turn_diffs_1/],
      [
        checkpointDiffs,
        "findCheckpointDiffRefByTurnStmt",
        /idx_checkpoint_thread_turn_latest/,
      ],
      [
        events,
        "readFromStmt",
        /orchestration_events USING INTEGER PRIMARY KEY/,
      ],
    ]
    for (const [store, statementName, expected, options] of cases) {
      const label = `${store.constructor.name}.${statementName}`
      const plan = explainPlan(db, preparedSql(store, statementName))
      expect(plan, label).toMatch(expected)
      expect(plan, label).not.toMatch(
        /^SCAN (projection_|turn_diffs|checkpoint_diffs|orchestration_events)/m
      )
      if (!options?.sorts) expect(plan, label).not.toContain("USE TEMP B-TREE")
    }
    db.close()
  })
})

describe("migration 51 provider runtime journal schema backfill", () => {
  function insertRow(
    db: Db,
    input: {
      readonly eventId: string
      readonly aggregateKind?: string
      readonly metadata: string
      readonly streamVersion: number
    }
  ): void {
    db.prepare(
      `INSERT INTO orchestration_events
         (event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, payload_json, metadata_json)
       VALUES (?, ?, 'thread-backfill', ?, 'ProviderRuntime:turn_completed',
               '2026-01-01T00:00:00.000Z', '{"event_type":"turn_completed","thread_id":"thread-backfill","payload":{}}', ?)`
    ).run(
      input.eventId,
      input.aggregateKind ?? "provider_runtime",
      input.streamVersion,
      input.metadata
    )
  }

  function metadataOf(db: Db, eventId: string): string {
    return (
      db
        .prepare(
          "SELECT metadata_json FROM orchestration_events WHERE event_id = ?"
        )
        .get(eventId) as { metadata_json: string }
    ).metadata_json
  }

  it("stamps schema 1 onto unmarked provider_runtime rows and nothing else", () => {
    const db = openDatabase(tmpDbPath("journal-schema-backfill"))
    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version < 51)
    )
    const markedV2 = JSON.stringify({
      schema: 2,
      contract: "provider-runtime-event",
      durability: "journal-first",
      payloadTruncated: true,
      originalBytes: 2_000_000,
    })
    insertRow(db, {
      eventId: "unmarked-default",
      metadata: "{}",
      streamVersion: 1,
    })
    insertRow(db, {
      eventId: "unmarked-with-keys",
      metadata: JSON.stringify({ contract: "provider-runtime-event" }),
      streamVersion: 2,
    })
    insertRow(db, {
      eventId: "marked-v1",
      metadata: JSON.stringify({ schema: 1 }),
      streamVersion: 3,
    })
    insertRow(db, {
      eventId: "marked-v2",
      metadata: markedV2,
      streamVersion: 4,
    })
    insertRow(db, {
      eventId: "marked-v3",
      metadata: JSON.stringify({ schema: 3 }),
      streamVersion: 5,
    })
    insertRow(db, {
      eventId: "malformed",
      metadata: "{not json",
      streamVersion: 6,
    })
    insertRow(db, {
      eventId: "scalar-json",
      metadata: "null",
      streamVersion: 7,
    })
    insertRow(db, {
      eventId: "other-aggregate",
      aggregateKind: "checkpoint",
      metadata: "{}",
      streamVersion: 8,
    })
    // An explicit JSON `null` marker is a marker: the key is present, so the
    // row is not "unmarked" and must not be stamped (`json_extract` cannot
    // tell it from an absent key; `json_type(..., '$.schema')` can).
    insertRow(db, {
      eventId: "marked-null",
      metadata: JSON.stringify({
        schema: null,
        contract: "provider-runtime-event",
      }),
      streamVersion: 9,
    })

    runMigrations(db)

    expect(JSON.parse(metadataOf(db, "unmarked-default"))).toEqual({
      schema: 1,
    })
    expect(JSON.parse(metadataOf(db, "unmarked-with-keys"))).toEqual({
      contract: "provider-runtime-event",
      schema: 1,
    })
    // Marked rows are byte-identical: the writer's own bytes, not re-encoded.
    expect(metadataOf(db, "marked-v1")).toBe(JSON.stringify({ schema: 1 }))
    expect(metadataOf(db, "marked-v2")).toBe(markedV2)
    expect(metadataOf(db, "marked-v3")).toBe(JSON.stringify({ schema: 3 }))
    // Rows the replayer discards as malformed are left for it to discard.
    expect(metadataOf(db, "malformed")).toBe("{not json")
    expect(metadataOf(db, "scalar-json")).toBe("null")
    expect(metadataOf(db, "other-aggregate")).toBe("{}")
    expect(metadataOf(db, "marked-null")).toBe(
      JSON.stringify({ schema: null, contract: "provider-runtime-event" })
    )
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE version = 51").get()
    ).toEqual({ name: "provider_runtime_journal_schema_backfill" })
    db.close()
  })

  it("changes no index, so it triggers no post-migration ANALYZE", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 51)!
    expect(INDEX_SHAPE_SQL.test(migration.sql)).toBe(false)
    expect(migration.sql).not.toMatch(/payload_json/)
  })
})
