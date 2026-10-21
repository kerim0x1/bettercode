import {
  CHAT_FIND_MATCH_LIMIT,
  chatFindPattern,
  chatFindRanges,
  chatFindSnippet,
  countChatFindMatches,
  isChatFindMessage,
} from "@betterc0de/schema"
import type {
  ThreadMessageSearchHit,
  ThreadMessageSearchResult,
} from "@betterc0de/schema/http-contracts"

/** A stored message as find in chat reads it (`searchMessagesStmt`). */
export interface StoredMessageSearchRow {
  message_id: string
  role: string
  created_at: string
  sequence: number
  /**
   * `[text, extra.internalContext, extra.compactedContext]` of the stored
   * message as a JSON array; null when the stored JSON is malformed.
   */
  search_fields: string | null
}

export interface MessageSearchOptions {
  query: string
  caseSensitive?: boolean
  /** Matches to count at most; 1 to `CHAT_FIND_MATCH_LIMIT`. */
  limit?: number
}

function searchFields(row: StoredMessageSearchRow): {
  content: string
  internalContext: unknown
  compactedContext: boolean
} {
  let fields: unknown = null
  try {
    fields = row.search_fields === null ? null : JSON.parse(row.search_fields)
  } catch {
    // Not expected from SQLite; treated like a malformed row.
  }
  const [text, internalContext, compactedContext] = Array.isArray(fields)
    ? (fields as unknown[])
    : []
  return {
    content: typeof text === "string" ? text : "",
    internalContext,
    compactedContext: compactedContext === true,
  }
}

/**
 * Find in chat over stored messages (`GET /threads/:id/messages/search`).
 * `rows` come newest first; reading stops once `limit` matches are counted
 * and one more is seen, so a long chat is not read to its start for a word
 * it uses everywhere. Each hit counts every match in its message, so the
 * client numbers a message's matches the same way it does for the messages
 * it holds. Hits are returned oldest first, like a transcript page.
 */
export function searchStoredMessages(
  rows: Iterable<StoredMessageSearchRow>,
  options: MessageSearchOptions
): ThreadMessageSearchResult {
  const limit = Math.min(
    CHAT_FIND_MATCH_LIMIT,
    Math.max(1, Math.floor(options.limit ?? CHAT_FIND_MATCH_LIMIT))
  )
  const pattern = chatFindPattern(options.query, {
    caseSensitive: options.caseSensitive === true,
  })
  const hits: ThreadMessageSearchHit[] = []
  let totalMatches = 0
  let truncated = false
  if (!pattern) return { hits, totalMatches, truncated }

  for (const row of rows) {
    const { content, internalContext, compactedContext } = searchFields(row)
    if (
      !isChatFindMessage({
        role: row.role,
        content,
        internalContext,
        compactedContext,
      })
    ) {
      continue
    }
    if (totalMatches >= limit) {
      // The limit is reached: one more match means older ones exist.
      if (countChatFindMatches(content, pattern, 1) > 0) {
        truncated = true
        break
      }
      continue
    }
    const first = chatFindRanges(content, pattern, 1)[0]
    if (!first) continue
    const matchCount = countChatFindMatches(content, pattern)
    hits.push({
      messageId: row.message_id,
      role: row.role,
      sequence: row.sequence,
      createdAt: row.created_at,
      matchCount,
      snippet: chatFindSnippet(content, first[0], first[1]),
    })
    totalMatches += matchCount
    if (totalMatches > limit) {
      truncated = true
      break
    }
  }
  return { hits: hits.reverse(), totalMatches, truncated }
}
