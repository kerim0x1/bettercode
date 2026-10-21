import type { Db } from "./db"
import { parseTurnDiffFilesFromUnifiedDiff } from "@betterc0de/schema"
import { createHash } from "node:crypto"
import { logger } from "../observability/logger"

/*
 * Renderer-facing thread/project storage tables. These originated as
 * projection-style tables in the Rust backend, but the Node port also uses
 * them as direct UI persistence for chat/thread state.
 */

export interface ThreadProjection {
  thread_id: string
  project_id: string
  title: string | null
  status: string
  env_mode: string
  created_at: string
  updated_at: string
  message_count: number
  turn_count: number
  project_path?: string
  // Per-thread worktree isolation (migration 11). NULL means "uses shared
  // project workspace" — legacy threads created before migration 11 ran.
  worktree_path?: string | null
  branch?: string | null
  base_branch?: string | null
  worktree_state: string // 'none' | 'pending' | 'creating' | 'ready' | 'committing' | 'pushed' | 'pr_open' | 'merged' | 'abandoned'
  pr_number?: number | null
  pr_url?: string | null
  pr_state?: string | null // 'open' | 'closed' | 'merged' | 'draft' | null
  pr_mergeable?: number | null // 1/0/null, SQLite boolean
  pr_checked_at?: string | null
  upstream_ahead: number
  upstream_behind: number
  approval_policy: string // PermissionLevel
}

export interface WorktreeRegistryEntry {
  worktree_id: string
  thread_id: string
  worktree_path: string
  branch: string
  base_branch: string
  base_repo_path: string
  state: string
  delete_branch_on_remove: number
  created_at: string
  updated_at: string
}

export interface MessageProjection {
  message_id: string
  thread_id: string
  turn_id: string | null
  role: string
  content_json: string
  created_at: string
  sequence: number
}

export interface TurnProjection {
  turn_id: string
  thread_id: string
  status: string
  provider_kind: string | null
  provider_instance_id?: string | null
  model_id: string | null
  started_at: string
  completed_at: string | null
}

export interface CheckpointDiffProjection {
  id: number
  thread_id: string
  turn_id: string
  checkpoint_ref: string
  diff_content: string
  created_at: string
}

export interface TurnDiffProjection {
  thread_id: string
  turn_index: number
  diff_text: string
  files_changed: number
  insertions: number
  deletions: number
  created_at: string
}

export interface RuntimeDiffEventLike {
  event_type: string
  thread_id: string
  payload: Record<string, unknown>
  event_id?: string
  eventId?: string
}

export type ThreadActivityTone =
  | "thinking"
  | "tool"
  | "info"
  | "approval"
  | "error"

export interface ThreadActivityProjection {
  activity_id: string
  thread_id: string
  turn_id: string | null
  provider_instance_id?: string | null
  kind: string
  tone: ThreadActivityTone
  summary: string
  payload: unknown
  sequence?: number | null
  created_at: string
}

export interface ThreadActivityCursor {
  sequence: number | null
  createdAt: string
  activityId: string
}

export interface ThreadActivityPage {
  items: ThreadActivityProjection[]
  next: ThreadActivityCursor | null
}

type ThreadActivityRow = {
  activity_id: string
  thread_id: string
  turn_id: string | null
  provider_instance_id: string | null
  kind: string
  tone: ThreadActivityTone
  summary: string
  payload_json: string
  sequence: number | null
  created_at: string
}

export function encodeThreadActivityCursor(
  cursor: ThreadActivityCursor
): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

export function decodeThreadActivityCursor(
  raw: string | null | undefined
): ThreadActivityCursor | null | false {
  if (raw === undefined || raw === null || raw.trim() === "") return null
  if (raw.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return false
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    ) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false
    }
    const value = parsed as Record<string, unknown>
    if (
      !(
        value.sequence === null ||
        (typeof value.sequence === "number" &&
          Number.isSafeInteger(value.sequence))
      ) ||
      typeof value.createdAt !== "string" ||
      value.createdAt.length === 0 ||
      value.createdAt.length > 128 ||
      typeof value.activityId !== "string" ||
      value.activityId.length === 0 ||
      value.activityId.length > 512
    ) {
      return false
    }
    return {
      sequence: value.sequence,
      createdAt: value.createdAt,
      activityId: value.activityId,
    }
  } catch {
    return false
  }
}

export interface ProjectProjection {
  project_id: string
  name: string
  path: string
  created_at: string
  updated_at: string
}

function providerInstanceIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null
  const record = payload as Record<string, unknown>
  const value = record.providerInstanceId ?? record.provider_instance_id
  return typeof value === "string" && value.length > 0 ? value : null
}

function payloadString(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function payloadText(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "string") return value
  }
  return null
}

function payloadNumber(
  payload: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function runtimeDiffTurnIdentity(payload: Record<string, unknown>): {
  nativeTurnId: string | null
  dispatchTurnId: string | null
} {
  const payloadTurnId = payloadString(payload, "turn_id", "turnId")
  const explicitDispatchTurnId = payloadString(
    payload,
    "dispatchTurnId",
    "dispatch_turn_id"
  )
  const explicitNativeTurnId = payloadString(
    payload,
    "nativeTurnId",
    "native_turn_id",
    "providerTurnId",
    "provider_turn_id"
  )
  const checkpointReactor =
    payloadString(payload, "source") === "checkpoint_reactor"
  const dispatchTurnId =
    explicitDispatchTurnId ?? (checkpointReactor ? payloadTurnId : null)
  const nativeTurnId =
    explicitNativeTurnId ??
    (payloadTurnId &&
    (!checkpointReactor ||
      (explicitDispatchTurnId !== null &&
        payloadTurnId !== explicitDispatchTurnId))
      ? payloadTurnId
      : null)
  return { nativeTurnId, dispatchTurnId }
}

function runtimeDiffEventId(
  event: RuntimeDiffEventLike,
  payload: Record<string, unknown>
): string | null {
  return (
    payloadString(payload, "event_id", "eventId") ??
    (typeof event.event_id === "string" && event.event_id.length > 0
      ? event.event_id
      : null) ??
    (typeof event.eventId === "string" && event.eventId.length > 0
      ? event.eventId
      : null)
  )
}

function placeholderCheckpointRefForRuntimeDiff(
  event: RuntimeDiffEventLike,
  payload: Record<string, unknown>,
  turnId: string | null
): string | null {
  if (!turnId) return null
  const eventId = runtimeDiffEventId(event, payload)
  return eventId
    ? `provider-diff:${eventId}`
    : `provider-diff:${event.thread_id}:${turnId}`
}

function diffFilesFromPayload(
  payload: Record<string, unknown>,
  diffText: string
): Array<{ path: string; additions: number; deletions: number }> {
  if (Array.isArray(payload.files)) {
    return payload.files.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
      const file = entry as Record<string, unknown>
      const filePath = payloadString(file, "path")
      if (!filePath) return []
      return [
        {
          path: filePath,
          additions: payloadNumber(file, "additions") ?? 0,
          deletions: payloadNumber(file, "deletions") ?? 0,
        },
      ]
    })
  }
  return [...parseTurnDiffFilesFromUnifiedDiff(diffText)]
}

// Columns selected for every ThreadProjection row. Central constant so the
// three prepared queries below stay aligned when we add a new field.
const THREAD_COLUMNS = `
  thread_id, project_id, title, status, env_mode, created_at, updated_at,
  message_count, turn_count, project_path,
  worktree_path, branch, base_branch, worktree_state,
  pr_number, pr_url, pr_state, pr_mergeable, pr_checked_at,
  upstream_ahead, upstream_behind, approval_policy
`

export class ThreadProjectionQuery {
  private readonly listByProjectStmt
  private readonly listAllStmt
  private readonly findStmt
  constructor(db: Db) {
    this.listByProjectStmt = db.prepare(`
      SELECT ${THREAD_COLUMNS}
      FROM projection_threads
      WHERE project_id = ? AND status != 'archived'
      ORDER BY updated_at DESC
    `)
    this.listAllStmt = db.prepare(`
      SELECT ${THREAD_COLUMNS}
      FROM projection_threads
      WHERE status != 'archived'
      ORDER BY updated_at DESC
    `)
    this.findStmt = db.prepare(`
      SELECT ${THREAD_COLUMNS}
      FROM projection_threads WHERE thread_id = ?
    `)
  }
  listByProject(projectId: string): ThreadProjection[] {
    return this.listByProjectStmt.all(projectId) as ThreadProjection[]
  }
  listAll(): ThreadProjection[] {
    return this.listAllStmt.all() as ThreadProjection[]
  }
  find(threadId: string): ThreadProjection | null {
    return (this.findStmt.get(threadId) as ThreadProjection | undefined) ?? null
  }
}

// ─── Worktree registry queries ───────────────────────────────────────────────
// Thin read layer over the `worktree_registry` table (migration 12). Writes
// happen through WorktreeManager which also appends corresponding events; this
// query class is the read-side projection.
export class WorktreeRegistryQuery {
  private readonly listAllStmt
  private readonly findByBranchStmt
  private readonly findByThreadStmt
  private readonly findByPathStmt
  private readonly insertStmt
  private readonly updateStateStmt
  private readonly markRemovingStmt
  private readonly deleteStmt
  constructor(db: Db) {
    this.listAllStmt = db.prepare(
      `SELECT * FROM worktree_registry ORDER BY created_at DESC`
    )
    this.findByBranchStmt = db.prepare(
      `SELECT * FROM worktree_registry WHERE branch = ?`
    )
    this.findByThreadStmt = db.prepare(
      `SELECT * FROM worktree_registry WHERE thread_id = ?`
    )
    this.findByPathStmt = db.prepare(
      `SELECT * FROM worktree_registry WHERE worktree_path = ?`
    )
    this.insertStmt = db.prepare(`
      INSERT INTO worktree_registry
        (worktree_id, thread_id, worktree_path, branch, base_branch,
         base_repo_path, state, delete_branch_on_remove, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.updateStateStmt = db.prepare(`
      UPDATE worktree_registry SET state = ?, updated_at = ? WHERE worktree_id = ?
    `)
    this.markRemovingStmt = db.prepare(`
      UPDATE worktree_registry
      SET state = 'removing',
          delete_branch_on_remove = MAX(
            delete_branch_on_remove,
            ?
          ),
          updated_at = ?
      WHERE worktree_id = ?
    `)
    this.deleteStmt = db.prepare(
      `DELETE FROM worktree_registry WHERE worktree_id = ?`
    )
  }
  listAll(): WorktreeRegistryEntry[] {
    return this.listAllStmt.all() as WorktreeRegistryEntry[]
  }
  findByBranch(branch: string): WorktreeRegistryEntry | null {
    return (
      (this.findByBranchStmt.get(branch) as
        | WorktreeRegistryEntry
        | undefined) ?? null
    )
  }
  findByThread(threadId: string): WorktreeRegistryEntry | null {
    return (
      (this.findByThreadStmt.get(threadId) as
        | WorktreeRegistryEntry
        | undefined) ?? null
    )
  }
  findByPath(path: string): WorktreeRegistryEntry | null {
    return (
      (this.findByPathStmt.get(path) as WorktreeRegistryEntry | undefined) ??
      null
    )
  }
  insert(entry: WorktreeRegistryEntry): void {
    this.insertStmt.run(
      entry.worktree_id,
      entry.thread_id,
      entry.worktree_path,
      entry.branch,
      entry.base_branch,
      entry.base_repo_path,
      entry.state,
      entry.delete_branch_on_remove,
      entry.created_at,
      entry.updated_at
    )
  }
  updateState(worktreeId: string, state: string, updatedAt: string): void {
    this.updateStateStmt.run(state, updatedAt, worktreeId)
  }
  markRemoving(
    worktreeId: string,
    deleteBranch: boolean,
    updatedAt: string
  ): void {
    this.markRemovingStmt.run(deleteBranch ? 1 : 0, updatedAt, worktreeId)
  }
  delete(worktreeId: string): void {
    this.deleteStmt.run(worktreeId)
  }
}

export class MessageProjectionQuery {
  private readonly listByThreadStmt
  constructor(db: Db) {
    this.listByThreadStmt = db.prepare(`
      SELECT message_id, thread_id, turn_id, role, content_json, created_at, sequence
      FROM projection_messages
      WHERE thread_id = ?
      ORDER BY sequence ASC
    `)
  }
  listByThread(threadId: string): MessageProjection[] {
    return this.listByThreadStmt.all(threadId) as MessageProjection[]
  }
}

export class TurnProjectionQuery {
  private readonly listByThreadStmt
  constructor(db: Db) {
    this.listByThreadStmt = db.prepare(`
      SELECT turn_id, thread_id, status, provider_kind, provider_instance_id, model_id, started_at, completed_at
      FROM projection_turns
      WHERE thread_id = ?
      ORDER BY started_at ASC
    `)
  }
  listByThread(threadId: string): TurnProjection[] {
    return this.listByThreadStmt.all(threadId) as TurnProjection[]
  }
}

export class CheckpointDiffProjectionQuery {
  private readonly deleteCheckpointDiffStmt
  private readonly insertCheckpointDiffStmt
  private readonly insertDiffBlobStmt
  private readonly findCheckpointDiffRefByTurnStmt
  private readonly findLatestMessageBoundaryStmt
  private readonly findMessageBoundaryByTurnStmt
  private readonly findDispatchMessageBoundaryStmt
  private readonly findAssistantBoundaryAfterDispatchStmt
  private readonly findNativeTurnIdByDispatchStmt
  private readonly upsertTurnDiffStmt
  private readonly listCheckpointDiffsByThreadStmt
  private readonly listCheckpointRefsByThreadStmt
  private readonly listTurnDiffsByThreadStmt
  private readonly latestTurnIndexStmt

  constructor(private readonly db: Db) {
    this.deleteCheckpointDiffStmt = db.prepare(`
      DELETE FROM checkpoint_diffs
      WHERE thread_id = ? AND turn_id = ? AND checkpoint_ref = ?
    `)
    this.insertCheckpointDiffStmt = db.prepare(`
      INSERT INTO checkpoint_diffs
        (thread_id, turn_id, checkpoint_ref, diff_content, diff_blob_id, created_at)
      VALUES (?, ?, ?, '', ?, ?)
    `)
    this.insertDiffBlobStmt = db.prepare(`
      INSERT INTO diff_blobs (blob_id, diff_content, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(blob_id) DO NOTHING
    `)
    this.findCheckpointDiffRefByTurnStmt = db.prepare(`
      SELECT checkpoint_ref
      FROM checkpoint_diffs
      WHERE thread_id = ? AND turn_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    this.findLatestMessageBoundaryStmt = db.prepare(`
      SELECT message_id, sequence, turn_id
      FROM projection_messages
      WHERE thread_id = ?
      ORDER BY sequence DESC, message_id DESC
      LIMIT 1
    `)
    this.findMessageBoundaryByTurnStmt = db.prepare(`
      SELECT message_id, sequence, turn_id
      FROM projection_messages
      WHERE thread_id = ? AND turn_id = ?
      ORDER BY sequence DESC, message_id DESC
      LIMIT 1
    `)
    this.findDispatchMessageBoundaryStmt = db.prepare(`
      SELECT
        message.message_id,
        message.sequence,
        message.turn_id,
        (
          SELECT MIN(next_message.sequence)
          FROM chat_dispatches AS next_dispatch
          JOIN projection_messages AS next_message
            ON next_message.thread_id = next_dispatch.thread_id
           AND next_message.message_id = next_dispatch.message_id
          WHERE next_dispatch.thread_id = dispatch.thread_id
            AND next_message.sequence > message.sequence
        ) AS next_dispatch_sequence
      FROM chat_dispatches AS dispatch
      JOIN projection_messages AS message
        ON message.thread_id = dispatch.thread_id
       AND message.message_id = dispatch.message_id
      WHERE dispatch.thread_id = ?
        AND dispatch.provider_turn_id = ?
      ORDER BY
        dispatch.accepted_at DESC,
        dispatch.created_at DESC,
        dispatch.dispatch_id DESC
      LIMIT 1
    `)
    this.findAssistantBoundaryAfterDispatchStmt = db.prepare(`
      SELECT message_id, sequence, turn_id
      FROM projection_messages
      WHERE thread_id = ?
        AND role = 'assistant'
        AND turn_id IS NOT NULL
        AND sequence > ?
        AND (? IS NULL OR sequence < ?)
      ORDER BY sequence DESC, message_id DESC
      LIMIT 1
    `)
    // Journal rows come in two shapes (see ProviderRuntimeJournalReplayer):
    // legacy rows keep the native turn id under `$.payload.turn_id` /
    // `$.payload.turnId`, canonical rows at the event root `$.turnId`. Both
    // carry the hub-injected `$.payload.dispatchTurnId`.
    this.findNativeTurnIdByDispatchStmt = db.prepare(`
      SELECT COALESCE(
        json_extract(payload_json, '$.payload.turn_id'),
        json_extract(payload_json, '$.payload.turnId'),
        json_extract(payload_json, '$.turnId')
      ) AS turn_id
      FROM orchestration_events
      WHERE aggregate_kind = 'provider_runtime'
        AND stream_id = ?
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
        ) = ?
        AND typeof(COALESCE(
          json_extract(payload_json, '$.payload.turn_id'),
          json_extract(payload_json, '$.payload.turnId'),
          json_extract(payload_json, '$.turnId')
        )) = 'text'
      ORDER BY sequence DESC
      LIMIT 1
    `)
    this.upsertTurnDiffStmt = db.prepare(`
      INSERT INTO turn_diffs
        (thread_id, turn_index, turn_id, dispatch_turn_id,
         boundary_message_id, boundary_sequence, diff_text, diff_blob_id,
         files_changed, insertions, deletions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, turn_index) DO UPDATE SET
        turn_id = excluded.turn_id,
        dispatch_turn_id = excluded.dispatch_turn_id,
        boundary_message_id = excluded.boundary_message_id,
        boundary_sequence = excluded.boundary_sequence,
        diff_text = excluded.diff_text,
        diff_blob_id = excluded.diff_blob_id,
        files_changed = excluded.files_changed,
        insertions = excluded.insertions,
        deletions = excluded.deletions,
        created_at = excluded.created_at
    `)
    this.listCheckpointDiffsByThreadStmt = db.prepare(`
      SELECT
        checkpoint.id,
        checkpoint.thread_id,
        checkpoint.turn_id,
        checkpoint.checkpoint_ref,
        COALESCE(blob.diff_content, checkpoint.diff_content) AS diff_content,
        checkpoint.created_at
      FROM checkpoint_diffs AS checkpoint
      LEFT JOIN diff_blobs AS blob
        ON blob.blob_id = checkpoint.diff_blob_id
      WHERE checkpoint.thread_id = ?
        AND (? IS NULL OR checkpoint.id < ?)
      ORDER BY checkpoint.id DESC
      LIMIT ?
    `)
    this.listCheckpointRefsByThreadStmt = db.prepare(`
      SELECT checkpoint_ref
      FROM checkpoint_diffs
      WHERE thread_id = ?
      ORDER BY id ASC
    `)
    this.listTurnDiffsByThreadStmt = db.prepare(`
      SELECT
        turn.thread_id,
        turn.turn_index,
        COALESCE(blob.diff_content, turn.diff_text) AS diff_text,
        turn.files_changed,
        turn.insertions,
        turn.deletions,
        turn.created_at
      FROM turn_diffs AS turn
      LEFT JOIN diff_blobs AS blob
        ON blob.blob_id = turn.diff_blob_id
      WHERE turn.thread_id = ?
        AND (? IS NULL OR turn.turn_index < ?)
      ORDER BY turn.turn_index DESC
      LIMIT ?
    `)
    this.latestTurnIndexStmt = db.prepare(`
      SELECT MAX(turn_index) AS turn_index
      FROM turn_diffs
      WHERE thread_id = ?
    `)
  }

  recordRuntimeEvent(
    event: RuntimeDiffEventLike,
    createdAt = new Date().toISOString()
  ): void {
    if (
      event.event_type !== "turn.diff.updated" &&
      event.event_type !== "turn_diff_updated"
    ) {
      return
    }

    const payload = event.payload ?? {}
    // The journal drops oversized patches whole, retaining the checkpoint refs
    // and summary. Project that summary so admission recovery can acknowledge
    // it; an unmarked missing patch must still be ignored.
    const diffText =
      payloadText(payload, "unifiedDiff", "unified_diff", "diff") ??
      (payload.diffTruncated === true &&
      payload.diffTruncationReason === "journal_limit"
        ? ""
        : null)
    if (diffText === null) return

    const files = diffFilesFromPayload(payload, diffText)
    const totalFiles = validNonnegativeInteger(
      payloadNumber(payload, "diffFileCount", "diff_file_count")
    )
    const turnIndex = payloadNumber(
      payload,
      "turn_index",
      "turnIndex",
      "checkpointTurnCount",
      "checkpoint_turn_count"
    )
    const checkpointRef = payloadString(
      payload,
      "checkpointRef",
      "checkpoint_ref"
    )
    const turnIdentity = runtimeDiffTurnIdentity(payload)
    const checkpointTurnId =
      turnIdentity.dispatchTurnId ??
      turnIdentity.nativeTurnId ??
      (turnIndex !== undefined ? `turn:${turnIndex}` : null)
    const resolvedCheckpointRef =
      checkpointRef ??
      (checkpointTurnId
        ? this.findCheckpointRefForTurn(event.thread_id, checkpointTurnId)
        : null) ??
      placeholderCheckpointRefForRuntimeDiff(event, payload, checkpointTurnId)
    const diffBlobId = createHash("sha256").update(diffText).digest("hex")

    const txn = this.db.transaction(() => {
      // Deleting the old final reference can collect this same blob on a
      // replay. Remove that reference before ensuring the replacement blob.
      if (resolvedCheckpointRef && checkpointTurnId) {
        this.deleteCheckpointDiffStmt.run(
          event.thread_id,
          checkpointTurnId,
          resolvedCheckpointRef
        )
      }
      this.insertDiffBlobStmt.run(diffBlobId, diffText, createdAt)
      if (turnIndex !== undefined) {
        let nativeTurnId = turnIdentity.nativeTurnId
        if (!nativeTurnId && turnIdentity.dispatchTurnId) {
          nativeTurnId = this.findNativeTurnIdForDispatch(
            event.thread_id,
            turnIdentity.dispatchTurnId
          )
        }
        const boundary = this.findMessageBoundary(
          event.thread_id,
          nativeTurnId,
          turnIdentity.dispatchTurnId
        )
        nativeTurnId ??= boundary?.turn_id ?? null
        this.upsertTurnDiffStmt.run(
          event.thread_id,
          turnIndex,
          nativeTurnId,
          turnIdentity.dispatchTurnId,
          boundary?.message_id ?? null,
          boundary?.sequence ?? -1,
          diffBlobId,
          totalFiles ?? files.length,
          files.reduce((sum, file) => sum + file.additions, 0),
          files.reduce((sum, file) => sum + file.deletions, 0),
          createdAt
        )
      }

      if (resolvedCheckpointRef && checkpointTurnId) {
        this.insertCheckpointDiffStmt.run(
          event.thread_id,
          checkpointTurnId,
          resolvedCheckpointRef,
          diffBlobId,
          createdAt
        )
      }
    })
    txn()
  }

  private findNativeTurnIdForDispatch(
    threadId: string,
    dispatchTurnId: string
  ): string | null {
    const row = this.findNativeTurnIdByDispatchStmt.get(
      threadId,
      dispatchTurnId
    ) as { turn_id?: unknown } | undefined
    return typeof row?.turn_id === "string" && row.turn_id.length > 0
      ? row.turn_id
      : null
  }

  private findMessageBoundary(
    threadId: string,
    nativeTurnId: string | null,
    dispatchTurnId: string | null
  ): {
    message_id: string
    sequence: number
    turn_id: string | null
  } | null {
    type BoundaryRow = {
      message_id: string
      sequence: number
      turn_id: string | null
    }
    if (nativeTurnId) {
      const nativeBoundary = this.findMessageBoundaryByTurnStmt.get(
        threadId,
        nativeTurnId
      ) as BoundaryRow | undefined
      if (nativeBoundary) return nativeBoundary
    }
    if (dispatchTurnId) {
      const dispatchBoundary = this.findDispatchMessageBoundaryStmt.get(
        threadId,
        dispatchTurnId
      ) as (BoundaryRow & { next_dispatch_sequence: number | null }) | undefined
      if (dispatchBoundary) {
        const assistantBoundary =
          this.findAssistantBoundaryAfterDispatchStmt.get(
            threadId,
            dispatchBoundary.sequence,
            dispatchBoundary.next_dispatch_sequence,
            dispatchBoundary.next_dispatch_sequence
          ) as BoundaryRow | undefined
        return assistantBoundary ?? dispatchBoundary
      }
    }
    return (
      (this.findLatestMessageBoundaryStmt.get(threadId) as
        | BoundaryRow
        | undefined) ?? null
    )
  }

  private findCheckpointRefForTurn(
    threadId: string,
    turnId: string
  ): string | null {
    const row = this.findCheckpointDiffRefByTurnStmt.get(threadId, turnId) as
      | { checkpoint_ref?: string | null }
      | undefined
    const checkpointRef = row?.checkpoint_ref
    return typeof checkpointRef === "string" && checkpointRef.length > 0
      ? checkpointRef
      : null
  }

  listCheckpointDiffsByThread(
    threadId: string,
    options: { limit?: number; beforeId?: number | null } = {}
  ): CheckpointDiffProjection[] {
    const limit = boundedPageLimit(options.limit, 500)
    const beforeId = validNonnegativeInteger(options.beforeId)
    return (
      this.listCheckpointDiffsByThreadStmt.all(
        threadId,
        beforeId,
        beforeId,
        limit
      ) as CheckpointDiffProjection[]
    ).reverse()
  }

  /**
   * Lightweight, unpaginated ref view for destructive checkpoint
   * maintenance. Revert correctness must not depend on the 500-row API page
   * limit, and it does not need to materialize potentially large diff blobs.
   */
  listCheckpointRefsByThread(threadId: string): string[] {
    return (
      this.listCheckpointRefsByThreadStmt.all(threadId) as Array<{
        checkpoint_ref: string
      }>
    ).map((row) => row.checkpoint_ref)
  }

  listTurnDiffsByThread(
    threadId: string,
    options: { limit?: number; beforeTurnIndex?: number | null } = {}
  ): TurnDiffProjection[] {
    const limit = boundedPageLimit(options.limit, 500)
    const beforeTurnIndex = validNonnegativeInteger(options.beforeTurnIndex)
    return (
      this.listTurnDiffsByThreadStmt.all(
        threadId,
        beforeTurnIndex,
        beforeTurnIndex,
        limit
      ) as TurnDiffProjection[]
    ).reverse()
  }

  latestTurnIndex(threadId: string): number {
    const row = this.latestTurnIndexStmt.get(threadId) as
      | { turn_index: number | null }
      | undefined
    return typeof row?.turn_index === "number" &&
      Number.isFinite(row.turn_index)
      ? Math.max(0, Math.trunc(row.turn_index))
      : 0
  }
}

export class ThreadActivityProjectionQuery {
  private readonly payloadByIdStmt
  private readonly findByIdStmt
  private readonly upsertStmt
  private readonly listNewestByThreadStmt
  private readonly listBeforeSequenceStmt
  private readonly listBeforeNonNullCursorStmt
  private readonly listBeforeNullCursorStmt
  private readonly latestByThreadKindStmt
  private readonly deleteByThreadStmt

  constructor(db: Db) {
    this.payloadByIdStmt = db.prepare(
      "SELECT payload_json FROM projection_thread_activities WHERE thread_id = ? AND activity_id = ?"
    )
    this.findByIdStmt = db.prepare(`
      SELECT
        activity_id,
        thread_id,
        turn_id,
        provider_instance_id,
        kind,
        tone,
        summary,
        payload_json,
        sequence,
        created_at
      FROM projection_thread_activities
      WHERE thread_id = ? AND activity_id = ?
    `)
    this.upsertStmt = db.prepare(`
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, provider_instance_id, kind, tone, summary, payload_json, sequence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        provider_instance_id = excluded.provider_instance_id,
        kind = excluded.kind,
        tone = excluded.tone,
        summary = excluded.summary,
        payload_json = excluded.payload_json,
        sequence = excluded.sequence,
        created_at = excluded.created_at
    `)
    this.listNewestByThreadStmt = db.prepare(`
      SELECT
        activity_id,
        thread_id,
        turn_id,
        provider_instance_id,
        kind,
        tone,
        summary,
        payload_json,
        sequence,
        created_at
      FROM projection_thread_activities
      WHERE thread_id = ?
      ORDER BY
        sequence DESC,
        created_at DESC,
        activity_id DESC
      LIMIT ?
    `)
    this.listBeforeSequenceStmt = db.prepare(`
      SELECT
        activity_id,
        thread_id,
        turn_id,
        provider_instance_id,
        kind,
        tone,
        summary,
        payload_json,
        sequence,
        created_at
      FROM projection_thread_activities
      WHERE thread_id = ?
        AND sequence IS NOT NULL
        AND sequence < ?
      ORDER BY
        sequence DESC,
        created_at DESC,
        activity_id DESC
      LIMIT ?
    `)
    this.listBeforeNonNullCursorStmt = db.prepare(`
      SELECT
        activity_id,
        thread_id,
        turn_id,
        provider_instance_id,
        kind,
        tone,
        summary,
        payload_json,
        sequence,
        created_at
      FROM projection_thread_activities
      WHERE thread_id = ?
        AND (
          sequence IS NULL
          OR sequence < ?
          OR (
            sequence = ?
            AND (
              created_at < ?
              OR (created_at = ? AND activity_id < ?)
            )
          )
        )
      ORDER BY
        sequence DESC,
        created_at DESC,
        activity_id DESC
      LIMIT ?
    `)
    this.listBeforeNullCursorStmt = db.prepare(`
      SELECT
        activity_id,
        thread_id,
        turn_id,
        provider_instance_id,
        kind,
        tone,
        summary,
        payload_json,
        sequence,
        created_at
      FROM projection_thread_activities
      WHERE thread_id = ?
        AND sequence IS NULL
        AND (
          created_at < ?
          OR (created_at = ? AND activity_id < ?)
        )
      ORDER BY
        created_at DESC,
        activity_id DESC
      LIMIT ?
    `)
    // Single most-recent activity of a given kind. Walks idx_thread_activities_page
    // (thread_id, sequence DESC, created_at DESC, activity_id DESC) newest-first
    // and stops at the first match, instead of loading a page of rows into JS
    // to scan. Sequence is the rowid-free ordering key; NULL sequences sort
    // last under DESC without any CASE term, which is what keeps this and the
    // page queries on the index instead of a temp b-tree.
    this.latestByThreadKindStmt = db.prepare(`
      SELECT
        activity_id,
        thread_id,
        turn_id,
        provider_instance_id,
        kind,
        tone,
        summary,
        payload_json,
        sequence,
        created_at
      FROM projection_thread_activities
      WHERE thread_id = ? AND kind = ?
      ORDER BY
        sequence DESC,
        created_at DESC,
        activity_id DESC
      LIMIT 1
    `)
    this.deleteByThreadStmt = db.prepare(`
      DELETE FROM projection_thread_activities WHERE thread_id = ?
    `)
  }

  upsert(activity: ThreadActivityProjection): void {
    this.upsertStmt.run(
      activity.activity_id,
      activity.thread_id,
      activity.turn_id,
      activity.provider_instance_id ??
        providerInstanceIdFromPayload(activity.payload),
      activity.kind,
      activity.tone,
      activity.summary,
      JSON.stringify(activity.payload ?? {}),
      activity.sequence ?? null,
      activity.created_at
    )
  }

  listByThread(
    threadId: string,
    options: {
      limit?: number
      before?: ThreadActivityCursor | null
      beforeSequence?: number | null
    } = {}
  ): ThreadActivityProjection[] {
    return this.listByThreadPage(threadId, options).items
  }

  listByThreadPage(
    threadId: string,
    options: {
      limit?: number
      before?: ThreadActivityCursor | null
      beforeSequence?: number | null
    } = {}
  ): ThreadActivityPage {
    const limit = boundedPageLimit(options.limit, 1_000)
    const queryLimit = limit + 1
    const beforeSequence = validNonnegativeInteger(options.beforeSequence)
    let rows: ThreadActivityRow[]
    if (options.before?.sequence === null) {
      rows = this.listBeforeNullCursorStmt.all(
        threadId,
        options.before.createdAt,
        options.before.createdAt,
        options.before.activityId,
        queryLimit
      ) as ThreadActivityRow[]
    } else if (options.before) {
      rows = this.listBeforeNonNullCursorStmt.all(
        threadId,
        options.before.sequence,
        options.before.sequence,
        options.before.createdAt,
        options.before.createdAt,
        options.before.activityId,
        queryLimit
      ) as ThreadActivityRow[]
    } else if (beforeSequence !== null) {
      rows = this.listBeforeSequenceStmt.all(
        threadId,
        beforeSequence,
        queryLimit
      ) as ThreadActivityRow[]
    } else {
      rows = this.listNewestByThreadStmt.all(
        threadId,
        queryLimit
      ) as ThreadActivityRow[]
    }

    const hasMore = rows.length > limit
    const selectedRows = hasMore ? rows.slice(0, limit) : rows
    const cursorRow = hasMore
      ? selectedRows[selectedRows.length - 1]
      : undefined
    const items = selectedRows.reverse().map((row) => {
      const payload = parseActivityPayload(row)
      return {
        activity_id: row.activity_id,
        thread_id: row.thread_id,
        turn_id: row.turn_id,
        provider_instance_id: row.provider_instance_id,
        kind: row.kind,
        tone: row.tone,
        summary: row.summary,
        payload,
        sequence: row.sequence,
        created_at: row.created_at,
      }
    })
    return {
      items,
      next: cursorRow
        ? {
            sequence: cursorRow.sequence,
            createdAt: cursorRow.created_at,
            activityId: cursorRow.activity_id,
          }
        : null,
    }
  }

  /** Indexed payload lookup; undefined means absent, malformed storage fails closed. */
  payloadById(threadId: string, activityId: string): unknown {
    const row: unknown = this.payloadByIdStmt.get(threadId, activityId)
    if (row === undefined) return undefined
    if (
      typeof row !== "object" ||
      row === null ||
      !("payload_json" in row) ||
      typeof row.payload_json !== "string"
    )
      throw new Error("Invalid persisted activity payload")
    return JSON.parse(row.payload_json)
  }

  /** One activity of this thread, or null (also when the id belongs to another thread). */
  findById(
    threadId: string,
    activityId: string
  ): ThreadActivityProjection | null {
    const row = this.findByIdStmt.get(threadId, activityId) as
      | ThreadActivityRow
      | undefined
    if (!row) return null
    return {
      activity_id: row.activity_id,
      thread_id: row.thread_id,
      turn_id: row.turn_id,
      provider_instance_id: row.provider_instance_id,
      kind: row.kind,
      tone: row.tone,
      summary: row.summary,
      payload: parseActivityPayload(row),
      sequence: row.sequence,
      created_at: row.created_at,
    }
  }

  /**
   * The single most-recent activity of a given kind, or null. A pushdown of
   * "find the latest X" to SQLite — callers that need only the newest row of a
   * kind must use this rather than paging rows and scanning in JS.
   */
  latestByThreadKind(
    threadId: string,
    kind: string
  ): ThreadActivityProjection | null {
    const row = this.latestByThreadKindStmt.get(threadId, kind) as
      | ThreadActivityRow
      | undefined
    if (!row) return null
    const payload = parseActivityPayload(row)
    return {
      activity_id: row.activity_id,
      thread_id: row.thread_id,
      turn_id: row.turn_id,
      provider_instance_id: row.provider_instance_id,
      kind: row.kind,
      tone: row.tone,
      summary: row.summary,
      payload,
      sequence: row.sequence,
      created_at: row.created_at,
    }
  }

  deleteByThread(threadId: string): void {
    this.deleteByThreadStmt.run(threadId)
  }
}

/**
 * A payload that no longer parses is corruption the renderer would otherwise
 * render as an empty activity, so it is logged with its identity instead of
 * being swallowed.
 */
function parseActivityPayload(row: ThreadActivityRow): unknown {
  try {
    return JSON.parse(row.payload_json) as unknown
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        threadId: row.thread_id,
        activityId: row.activity_id,
        kind: row.kind,
        bytes: row.payload_json.length,
      },
      "thread activity payload_json is corrupt; treating it as empty"
    )
    return {}
  }
}

function boundedPageLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(2_000, Math.max(1, Math.floor(value)))
    : fallback
}

function validNonnegativeInteger(
  value: number | null | undefined
): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

export class ProjectProjectionQuery {
  private readonly listAllStmt
  constructor(db: Db) {
    this.listAllStmt = db.prepare(`
      SELECT project_id, name, path, created_at, updated_at
      FROM projection_projects
      ORDER BY updated_at DESC
    `)
  }
  listAll(): ProjectProjection[] {
    return this.listAllStmt.all() as ProjectProjection[]
  }
}
