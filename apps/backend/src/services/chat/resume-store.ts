import {
  automaticMessageKindSchema,
  isRecord,
  threadResumeSchema,
  type AutomaticMessageKind,
  type ThreadResume,
} from "@betterc0de/schema"
import type { Db } from "../../persistence/db"
import type { ResumeTemplate, TurnOrigin } from "./resume-policy"

/**
 * Where chat resuming keeps its state, with the chat (migration 57):
 * `projection_threads.resume_json` is the record every client reads
 * (`ChatThread.resume`), `resume_turn_json` the scheduler's own part. Both
 * go away with the chat. Writes never touch `updated_at`, so resuming does
 * not reorder the sidebar.
 */

/** The turn that was running, kept until it ends so a restart can continue it. */
export interface RunningTurnMarker {
  readonly turnId: string | null
  readonly origin: TurnOrigin | null
  readonly startedAt: number
  readonly providerKind: string | null
  readonly providerInstanceId: string | null
  /** An approval or question was open; a restart does not continue such a chat. */
  readonly waitingForApproval: boolean
}

/** The scheduler's own part of a chat's state (`resume_turn_json`). */
export interface ResumeTurnState {
  /** The settings of the chat's last turn that may be resumed. */
  readonly template?: ResumeTemplate
  /** Restart continuations in a row (`MAX_RESTART_CONTINUATIONS`). */
  readonly restartContinuations?: number
  readonly running?: RunningTurnMarker
}

export interface PendingResumeRow {
  readonly threadId: string
  readonly record: ThreadResume | null
  readonly turn: ResumeTurnState | null
}

export interface ChatResumeStore {
  hasThread(threadId: string): boolean
  readRecord(threadId: string): ThreadResume | null
  writeRecord(threadId: string, record: ThreadResume | null): void
  readTurnState(threadId: string): ResumeTurnState | null
  writeTurnState(threadId: string, state: ResumeTurnState | null): void
  /** Every chat with a record or a running turn, for startup recovery. */
  listPending(): PendingResumeRow[]
  /** Marks a user message the scheduler sent (`ChatMessage.automatic`). */
  markAutomatic(
    threadId: string,
    messageId: string,
    kind: AutomaticMessageKind
  ): void
}

/** A stored record, or `null` when there is none or it does not parse. */
export function parseResumeRecord(raw: string | null): ThreadResume | null {
  if (!raw) return null
  try {
    const parsed = threadResumeSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const ORIGINS: ReadonlySet<string> = new Set([
  "user",
  "resume",
  "restart",
  "scheduler",
  "worker",
])

function origin(value: unknown): TurnOrigin | null {
  return typeof value === "string" && ORIGINS.has(value)
    ? (value as TurnOrigin)
    : null
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

/** The stored turn state, keeping only the fields that check out. */
export function parseResumeTurnState(
  raw: string | null
): ResumeTurnState | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const running = isRecord(value.running) ? value.running : null
  const continuations = value.restartContinuations
  return {
    ...(isRecord(value.template) ? { template: value.template } : {}),
    ...(typeof continuations === "number" &&
    Number.isInteger(continuations) &&
    continuations >= 0
      ? { restartContinuations: continuations }
      : {}),
    ...(running &&
    typeof running.startedAt === "number" &&
    Number.isFinite(running.startedAt)
      ? {
          running: {
            turnId: optionalText(running.turnId),
            origin: origin(running.origin),
            startedAt: running.startedAt,
            providerKind: optionalText(running.providerKind),
            providerInstanceId: optionalText(running.providerInstanceId),
            waitingForApproval: running.waitingForApproval === true,
          },
        }
      : {}),
  }
}

function isEmptyTurnState(state: ResumeTurnState): boolean {
  return (
    state.template === undefined &&
    state.running === undefined &&
    !state.restartContinuations
  )
}

export class SqliteChatResumeStore implements ChatResumeStore {
  private readonly hasThreadStmt
  private readonly readStmt
  private readonly writeRecordStmt
  private readonly writeTurnStmt
  private readonly listPendingStmt
  private readonly markAutomaticStmt

  constructor(db: Db) {
    // An archived chat is not resumed until it is restored.
    this.hasThreadStmt = db.prepare(
      "SELECT 1 AS present FROM projection_threads WHERE thread_id = ? AND status = 'active'"
    )
    this.readStmt = db.prepare(
      "SELECT resume_json, resume_turn_json FROM projection_threads WHERE thread_id = ?"
    )
    this.writeRecordStmt = db.prepare(
      "UPDATE projection_threads SET resume_json = ? WHERE thread_id = ?"
    )
    this.writeTurnStmt = db.prepare(
      "UPDATE projection_threads SET resume_turn_json = ? WHERE thread_id = ?"
    )
    // A cheap text test first; the rows are parsed (and checked) in code.
    this.listPendingStmt = db.prepare(`
      SELECT thread_id, resume_json, resume_turn_json
      FROM projection_threads
      WHERE status = 'active'
        AND (resume_json IS NOT NULL
          OR instr(resume_turn_json, '"running"') > 0)
    `)
    // Only a user message whose content is a JSON object can carry the
    // mark; anything else is left as it is.
    this.markAutomaticStmt = db.prepare(`
      UPDATE projection_messages
      SET content_json = json_set(content_json, '$.extra.automatic', ?)
      WHERE thread_id = ? AND message_id = ? AND role = 'user'
        AND json_valid(content_json)
        AND json_type(content_json) = 'object'
        AND json_type(content_json, '$.extra') = 'object'
    `)
  }

  hasThread(threadId: string): boolean {
    return this.hasThreadStmt.get(threadId) !== undefined
  }

  private read(
    threadId: string
  ): { resume_json: string | null; resume_turn_json: string | null } | null {
    return (
      (this.readStmt.get(threadId) as
        | { resume_json: string | null; resume_turn_json: string | null }
        | undefined) ?? null
    )
  }

  readRecord(threadId: string): ThreadResume | null {
    return parseResumeRecord(this.read(threadId)?.resume_json ?? null)
  }

  writeRecord(threadId: string, record: ThreadResume | null): void {
    this.writeRecordStmt.run(record ? JSON.stringify(record) : null, threadId)
  }

  readTurnState(threadId: string): ResumeTurnState | null {
    return parseResumeTurnState(this.read(threadId)?.resume_turn_json ?? null)
  }

  writeTurnState(threadId: string, state: ResumeTurnState | null): void {
    this.writeTurnStmt.run(
      state && !isEmptyTurnState(state) ? JSON.stringify(state) : null,
      threadId
    )
  }

  listPending(): PendingResumeRow[] {
    const rows = this.listPendingStmt.all() as Array<{
      thread_id: string
      resume_json: string | null
      resume_turn_json: string | null
    }>
    return rows.map((row) => ({
      threadId: row.thread_id,
      record: parseResumeRecord(row.resume_json),
      turn: parseResumeTurnState(row.resume_turn_json),
    }))
  }

  markAutomatic(
    threadId: string,
    messageId: string,
    kind: AutomaticMessageKind
  ): void {
    this.markAutomaticStmt.run(
      automaticMessageKindSchema.parse(kind),
      threadId,
      messageId
    )
  }
}
