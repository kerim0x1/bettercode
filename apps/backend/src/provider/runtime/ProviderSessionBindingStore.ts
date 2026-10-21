import type { Db } from "../../persistence/db"
import {
  modelSelectionSchema,
  type ModelSelection,
  type ProviderKind,
} from "./contracts"

/**
 * Runtime mode for a session that never stated one. In this vocabulary
 * "full-access" means bypass, so a binding without an explicit mode fails
 * closed to asking for approval instead.
 */
const DEFAULT_RUNTIME_MODE = "approval-required"

export type ProviderSessionLifecycleStatus =
  | "starting"
  | "ready"
  | "running"
  | "closing"
  | "closed"
  | "interrupted"
  | "stopped"
  | "error"

export interface ProviderSessionBinding {
  readonly threadId: string
  readonly providerInstanceId: string
  readonly providerKind: ProviderKind
  readonly providerThreadId: string | null
  readonly resumeCursor: unknown | null
  readonly continuationKey: string | null
  readonly status: ProviderSessionLifecycleStatus
  readonly activeTurnId: string | null
  readonly lastError: string | null
  readonly runtimeMode: string | null
  readonly cwd: string | null
  readonly modelSelection: ModelSelection | null
  readonly generation: number
  readonly createdAt: string
  readonly updatedAt: string
}

export function isProviderSessionContinuationCompatible(
  binding: ProviderSessionBinding | null,
  input: {
    readonly providerKind: ProviderKind
    readonly continuationKey: string | null
  }
): binding is ProviderSessionBinding {
  return (
    binding?.providerKind === input.providerKind &&
    binding.continuationKey === input.continuationKey
  )
}

interface BindingRow {
  readonly thread_id: string
  readonly provider_instance_id: string
  readonly provider_kind: ProviderKind
  readonly provider_thread_id: string | null
  readonly resume_cursor_json: string | null
  readonly continuation_key: string | null
  readonly status: string | null
  readonly active_turn_id: string | null
  readonly last_error: string | null
  readonly runtime_mode: string | null
  readonly cwd: string | null
  readonly model_selection_json: string | null
  readonly generation: number | null
  readonly created_at: string
  readonly updated_at: string
}

export class ProviderSessionBindingStore {
  private readonly getStmt
  private readonly getLatestForThreadProviderStmt
  private readonly getLatestForThreadStmt
  private readonly listStmt
  private readonly upsertStmt
  private readonly rotateGenerationStmt
  private readonly rotateGenerationForProviderSwitchStmt
  private readonly deleteThreadStmt
  private readonly getThreadGenerationStmt
  private readonly upsertThreadGenerationStmt
  private readonly recoverAfterProcessRestartStmt

  constructor(private readonly db: Db) {
    this.getStmt = db.prepare(`
      SELECT
        thread_id,
        provider_instance_id,
        provider_kind,
        provider_thread_id,
        resume_cursor_json,
        continuation_key,
        status,
        active_turn_id,
        last_error,
        runtime_mode,
        cwd,
        model_selection_json,
        generation,
        created_at,
        updated_at
      FROM provider_session_bindings
      WHERE thread_id = ? AND provider_instance_id = ?
      LIMIT 1
    `)
    this.getLatestForThreadProviderStmt = db.prepare(`
      SELECT
        thread_id,
        provider_instance_id,
        provider_kind,
        provider_thread_id,
        resume_cursor_json,
        continuation_key,
        status,
        active_turn_id,
        last_error,
        runtime_mode,
        cwd,
        model_selection_json,
        generation,
        created_at,
        updated_at
      FROM provider_session_bindings
      WHERE thread_id = ? AND provider_kind = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `)
    this.getLatestForThreadStmt = db.prepare(`
      SELECT
        thread_id,
        provider_instance_id,
        provider_kind,
        provider_thread_id,
        resume_cursor_json,
        continuation_key,
        status,
        active_turn_id,
        last_error,
        runtime_mode,
        cwd,
        model_selection_json,
        generation,
        created_at,
        updated_at
      FROM provider_session_bindings
      WHERE thread_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `)
    this.listStmt = db.prepare(`
      SELECT
        thread_id,
        provider_instance_id,
        provider_kind,
        provider_thread_id,
        resume_cursor_json,
        continuation_key,
        status,
        active_turn_id,
        last_error,
        runtime_mode,
        cwd,
        model_selection_json,
        generation,
        created_at,
        updated_at
      FROM provider_session_bindings
      ORDER BY updated_at ASC, created_at ASC
    `)
    this.upsertStmt = db.prepare(`
      INSERT INTO provider_session_bindings
        (
          thread_id,
          provider_instance_id,
          provider_kind,
          provider_thread_id,
          resume_cursor_json,
          continuation_key,
          status,
          active_turn_id,
          last_error,
          runtime_mode,
          cwd,
          model_selection_json,
          generation,
          created_at,
          updated_at
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, provider_instance_id) DO UPDATE SET
        provider_kind = excluded.provider_kind,
        provider_thread_id = excluded.provider_thread_id,
        resume_cursor_json = excluded.resume_cursor_json,
        continuation_key = excluded.continuation_key,
        status = excluded.status,
        active_turn_id = excluded.active_turn_id,
        last_error = excluded.last_error,
        runtime_mode = excluded.runtime_mode,
        cwd = excluded.cwd,
        model_selection_json = excluded.model_selection_json,
        generation = excluded.generation,
        updated_at = excluded.updated_at
    `)
    this.deleteThreadStmt = db.prepare(`
      DELETE FROM provider_session_bindings WHERE thread_id = ?
    `)
    this.rotateGenerationStmt = db.prepare(`
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
    `)
    this.rotateGenerationForProviderSwitchStmt = db.prepare(`
      UPDATE provider_session_bindings
      SET
        provider_thread_id = NULL,
        resume_cursor_json = NULL,
        continuation_key = NULL,
        status = 'stopped',
        active_turn_id = NULL,
        last_error = NULL,
        generation = ?,
        updated_at = ?
      WHERE thread_id = ?
    `)
    this.getThreadGenerationStmt = db.prepare(`
      SELECT generation
      FROM provider_thread_epochs
      WHERE thread_id = ?
      LIMIT 1
    `)
    this.upsertThreadGenerationStmt = db.prepare(`
      INSERT INTO provider_thread_epochs (thread_id, generation, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        generation = excluded.generation,
        updated_at = excluded.updated_at
    `)
    this.recoverAfterProcessRestartStmt = db.prepare(`
      UPDATE provider_session_bindings
      SET
        status = CASE
          WHEN status IN ('closed', 'stopped', 'error') THEN status
          ELSE 'stopped'
        END,
        active_turn_id = NULL,
        last_error = CASE
          WHEN active_turn_id IS NOT NULL
            OR status IN ('starting', 'running', 'closing')
          THEN COALESCE(
            last_error,
            'Backend restarted before the provider session reached a terminal state.'
          )
          ELSE last_error
        END,
        updated_at = ?
      WHERE active_turn_id IS NOT NULL
        OR status IS NULL
        OR status NOT IN ('closed', 'stopped', 'error')
    `)
  }

  get(
    threadId: string,
    providerInstanceId: string
  ): ProviderSessionBinding | null {
    const row = this.getStmt.get(threadId, providerInstanceId) as
      | BindingRow
      | undefined
    return row ? bindingFromRow(row) : null
  }

  getLatestForThreadProvider(
    threadId: string,
    providerKind: ProviderKind
  ): ProviderSessionBinding | null {
    const row = this.getLatestForThreadProviderStmt.get(
      threadId,
      providerKind
    ) as BindingRow | undefined
    return row ? bindingFromRow(row) : null
  }

  getLatestForThread(threadId: string): ProviderSessionBinding | null {
    const row = this.getLatestForThreadStmt.get(threadId) as
      | BindingRow
      | undefined
    return row ? bindingFromRow(row) : null
  }

  list(): ProviderSessionBinding[] {
    const rows = this.listStmt.all() as BindingRow[]
    return rows.map(bindingFromRow)
  }

  upsert(input: {
    readonly threadId: string
    readonly providerInstanceId: string
    readonly providerKind: ProviderKind
    readonly providerThreadId: string | null
    readonly resumeCursor?: unknown | null
    readonly continuationKey?: string | null
    readonly status?: ProviderSessionLifecycleStatus | null
    readonly activeTurnId?: string | null
    readonly lastError?: string | null
    readonly runtimeMode?: string | null
    readonly cwd?: string | null
    readonly modelSelection?: ModelSelection | null
  }): void {
    const now = new Date().toISOString()
    const existing = this.get(input.threadId, input.providerInstanceId)
    const resumeCursor =
      input.resumeCursor !== undefined
        ? input.resumeCursor
        : (existing?.resumeCursor ?? null)
    const cwd =
      input.cwd !== undefined
        ? normalizeCwd(input.cwd)
        : (existing?.cwd ?? null)
    const modelSelection =
      input.modelSelection !== undefined
        ? input.modelSelection
        : (existing?.modelSelection ?? null)
    const continuationKey =
      input.continuationKey !== undefined
        ? input.continuationKey
        : (existing?.continuationKey ?? null)
    const generation =
      existing?.generation ?? this.getThreadGeneration(input.threadId)
    this.upsertStmt.run(
      input.threadId,
      input.providerInstanceId,
      input.providerKind,
      input.providerThreadId,
      resumeCursor == null ? null : JSON.stringify(resumeCursor),
      continuationKey,
      input.status ?? existing?.status ?? "ready",
      input.activeTurnId !== undefined
        ? input.activeTurnId
        : (existing?.activeTurnId ?? null),
      input.lastError !== undefined
        ? input.lastError
        : (existing?.lastError ?? null),
      input.runtimeMode ?? existing?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      cwd,
      modelSelection == null ? null : JSON.stringify(modelSelection),
      generation,
      now,
      now
    )
  }

  getProviderThreadId(
    threadId: string,
    providerInstanceId: string
  ): string | null {
    return this.get(threadId, providerInstanceId)?.providerThreadId ?? null
  }

  getThreadGeneration(threadId: string): number {
    const row = this.getThreadGenerationStmt.get(threadId) as
      | { generation: number }
      | undefined
    return typeof row?.generation === "number" &&
      Number.isFinite(row.generation)
      ? Math.max(0, Math.trunc(row.generation))
      : 0
  }

  recoverAfterProcessRestart(): number {
    const result = this.recoverAfterProcessRestartStmt.run(
      new Date().toISOString()
    )
    return result.changes
  }

  setProviderThreadId(input: {
    readonly threadId: string
    readonly providerInstanceId: string
    readonly providerKind: ProviderKind
    readonly providerThreadId: string | null
    readonly resumeCursor?: unknown | null
    readonly continuationKey?: string | null
  }): void {
    this.upsert({
      ...input,
      resumeCursor:
        input.resumeCursor !== undefined
          ? input.resumeCursor
          : input.providerThreadId
            ? { providerThreadId: input.providerThreadId }
            : null,
    })
  }

  updateSessionLifecycle(input: {
    readonly threadId: string
    readonly providerInstanceId: string
    readonly providerKind: ProviderKind
    readonly status: ProviderSessionLifecycleStatus
    readonly activeTurnId?: string | null
    readonly lastError?: string | null
    readonly runtimeMode?: string | null
  }): void {
    const existing = this.get(input.threadId, input.providerInstanceId)
    this.upsert({
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      providerKind: input.providerKind,
      providerThreadId: existing?.providerThreadId ?? null,
      resumeCursor: existing?.resumeCursor ?? null,
      continuationKey: existing?.continuationKey ?? null,
      status: input.status,
      activeTurnId:
        input.activeTurnId !== undefined
          ? input.activeTurnId
          : (existing?.activeTurnId ?? null),
      lastError:
        input.lastError !== undefined
          ? input.lastError
          : (existing?.lastError ?? null),
      runtimeMode:
        input.runtimeMode ?? existing?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    })
  }

  updateRuntimeContext(input: {
    readonly threadId: string
    readonly providerInstanceId: string
    readonly providerKind: ProviderKind
    readonly cwd?: string | null
    readonly modelSelection?: ModelSelection | null
    readonly runtimeMode?: string | null
  }): void {
    const existing = this.get(input.threadId, input.providerInstanceId)
    this.upsert({
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      providerKind: input.providerKind,
      providerThreadId: existing?.providerThreadId ?? null,
      resumeCursor: existing?.resumeCursor ?? null,
      continuationKey: existing?.continuationKey ?? null,
      status: existing?.status ?? "ready",
      activeTurnId: existing?.activeTurnId ?? null,
      lastError: existing?.lastError ?? null,
      runtimeMode:
        input.runtimeMode ?? existing?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      cwd: input.cwd !== undefined ? input.cwd : (existing?.cwd ?? null),
      modelSelection:
        input.modelSelection !== undefined
          ? input.modelSelection
          : (existing?.modelSelection ?? null),
    })
  }

  rotateGeneration(
    threadId: string,
    providerInstanceId: string
  ): number | null {
    const existing = this.get(threadId, providerInstanceId)
    if (!existing) return null
    const rotate = this.db.transaction(() => {
      const now = new Date().toISOString()
      const generation = this.getThreadGeneration(threadId) + 1
      this.upsertThreadGenerationStmt.run(threadId, generation, now)
      this.rotateGenerationStmt.run(generation, now, threadId)
      return generation
    })
    return rotate()
  }

  rotateGenerationForProviderSwitch(
    threadId: string,
    sourceProviderInstanceId: string
  ): number | null {
    const rotate = this.db.transaction(() => {
      const source = this.get(threadId, sourceProviderInstanceId)
      if (!source) return null
      const now = new Date().toISOString()
      const generation = this.getThreadGeneration(threadId) + 1
      this.upsertThreadGenerationStmt.run(threadId, generation, now)
      this.rotateGenerationForProviderSwitchStmt.run(generation, now, threadId)
      return generation
    })
    return rotate()
  }

  deleteForThread(threadId: string): void {
    this.deleteThreadStmt.run(threadId)
  }
}

function bindingFromRow(row: BindingRow): ProviderSessionBinding {
  return {
    threadId: row.thread_id,
    providerInstanceId: row.provider_instance_id,
    providerKind: row.provider_kind,
    providerThreadId: row.provider_thread_id,
    resumeCursor: parseJson(row.resume_cursor_json),
    continuationKey: row.continuation_key,
    status: parseStatus(row.status),
    activeTurnId: row.active_turn_id,
    lastError: row.last_error,
    runtimeMode: row.runtime_mode ?? DEFAULT_RUNTIME_MODE,
    cwd: normalizeCwd(row.cwd),
    modelSelection: parseModelSelection(row.model_selection_json),
    generation:
      typeof row.generation === "number" && Number.isFinite(row.generation)
        ? Math.max(0, Math.trunc(row.generation))
        : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseStatus(raw: string | null): ProviderSessionLifecycleStatus {
  switch (raw) {
    case "starting":
    case "ready":
    case "running":
    case "closing":
    case "closed":
    case "interrupted":
    case "stopped":
    case "error":
      return raw
    default:
      return "ready"
  }
}

function parseJson(raw: string | null): unknown | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function parseModelSelection(raw: string | null): ModelSelection | null {
  const parsed = modelSelectionSchema.safeParse(parseJson(raw))
  return parsed.success ? parsed.data : null
}

function normalizeCwd(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}
