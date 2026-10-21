import {
  threadImportSourceSchema,
  type ConversationImportProvider,
  type ThreadImportSource,
} from "@betterc0de/schema"
import type { Db } from "../../persistence/db"

/** `claude:<session id>`: one CLI session, whichever chat holds it. */
export function sessionKey(
  provider: ConversationImportProvider,
  sessionId: string
): string {
  return `${provider}:${sessionId}`
}

/**
 * The import's own reads and writes: the source kept with an imported chat
 * (`projection_threads.import_source_json`, migration 56), and the native
 * sessions BetterC0de chats already run on.
 */
export class ConversationImportStore {
  private readonly importedStmt
  private readonly boundStmt
  private readonly setSourceStmt

  constructor(db: Db) {
    this.importedStmt = db.prepare(`
      SELECT thread_id, import_source_json
      FROM projection_threads
      WHERE import_source_json IS NOT NULL
    `)
    // A chat started in BetterC0de runs on a CLI session too; that session
    // is already here and is not offered again.
    this.boundStmt = db.prepare(`
      SELECT thread_id, provider_kind, provider_thread_id
      FROM provider_session_bindings
      WHERE provider_kind IN ('claude', 'codex')
        AND provider_thread_id IS NOT NULL
    `)
    // Like the settings, the source leaves `updated_at` (the sidebar order) alone.
    this.setSourceStmt = db.prepare(`
      UPDATE projection_threads SET import_source_json = ? WHERE thread_id = ?
    `)
  }

  /** Every session that is in a BetterC0de chat, by `sessionKey`, to the chat's id. */
  knownSessions(): Map<string, string> {
    const known = new Map<string, string>()
    for (const row of this.boundStmt.all() as Array<{
      thread_id: string
      provider_kind: string
      provider_thread_id: string
    }>) {
      if (row.provider_kind !== "claude" && row.provider_kind !== "codex")
        continue
      known.set(
        sessionKey(row.provider_kind, row.provider_thread_id),
        row.thread_id
      )
    }
    // An import's own record wins: it names the chat made from the session.
    for (const row of this.importedStmt.all() as Array<{
      thread_id: string
      import_source_json: string
    }>) {
      const source = parseSource(row.import_source_json)
      if (source)
        known.set(sessionKey(source.provider, source.sessionId), row.thread_id)
    }
    return known
  }

  setSource(threadId: string, source: ThreadImportSource): void {
    this.setSourceStmt.run(JSON.stringify(source), threadId)
  }
}

function parseSource(value: string): ThreadImportSource | null {
  try {
    const parsed = threadImportSourceSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
