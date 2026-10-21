/**
 * Find in chat: which messages it searches and how a query matches their
 * text. The renderer counts and highlights matches in the messages it holds;
 * the backend counts them in the stored messages the renderer has not loaded
 * (`GET /threads/:id/messages/search`). Both use these rules, so a message
 * has the same number of matches on either side.
 */

/** Matches a search keeps at most; beyond it the find bar shows "1000+". */
export const CHAT_FIND_MATCH_LIMIT = 1_000

/** Longest query, in UTF-16 code units; a longer one is cut to this. */
export const CHAT_FIND_QUERY_MAX_LENGTH = 200

export interface ChatFindOptions {
  readonly caseSensitive?: boolean
}

const REGEXP_SYNTAX = /[.*+?^${}()|[\]\\]/gu

/**
 * The pattern for a query, or null when it has nothing to search for. Text
 * matches literally. A run of whitespace in the query matches any run of
 * whitespace, so a phrase is still found where a message breaks the line.
 */
export function chatFindPattern(
  query: string,
  options: ChatFindOptions = {}
): RegExp | null {
  const text = query.slice(0, CHAT_FIND_QUERY_MAX_LENGTH)
  if (!text.trim()) return null
  const source = text
    .split(/\s+/u)
    .map((part) => part.replace(REGEXP_SYNTAX, "\\$&"))
    .join("\\s+")
  try {
    return new RegExp(source, options.caseSensitive ? "gu" : "giu")
  } catch {
    // Every syntax character is escaped; this only guards the engine.
    return null
  }
}

/**
 * Calls `onMatch` with `[start, end)` of each match of `pattern` in `text`,
 * at most `limit` times, and returns how many there were.
 */
function eachChatFindMatch(
  text: string,
  pattern: RegExp,
  limit: number,
  onMatch?: (start: number, end: number) => void
): number {
  if (!text || limit <= 0) return 0
  // A fresh copy: `lastIndex` of a shared global pattern is state.
  const regex = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  )
  let count = 0
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    const start = match.index
    const end = start + match[0].length
    if (end === start) {
      // Not produced by `chatFindPattern`; guards a hand-made pattern.
      regex.lastIndex = start + 1
      continue
    }
    onMatch?.(start, end)
    count += 1
    if (count >= limit) break
  }
  return count
}

/** `[start, end)` of each match of `pattern` in `text`, at most `limit`. */
export function chatFindRanges(
  text: string,
  pattern: RegExp,
  limit: number = Number.POSITIVE_INFINITY
): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  eachChatFindMatch(text, pattern, limit, (start, end) =>
    ranges.push([start, end])
  )
  return ranges
}

/** How many times `pattern` matches `text`, counting at most `limit`. */
export function countChatFindMatches(
  text: string,
  pattern: RegExp,
  limit: number = Number.POSITIVE_INFINITY
): number {
  return eachChatFindMatch(text, pattern, limit)
}

const LEGACY_HANDOFF_CHECKPOINT = "# Provider Handoff\n\nPrepared by "
const LEGACY_HANDOFF_REQUEST = /^Provider handoff: \S+ → \S+$/u

/**
 * Whether find in chat searches a message: user and assistant messages the
 * transcript shows. Provider handoff checkpoints stay hidden, including the
 * ones written before they were flagged (`providerHandoffMessageIds`, which
 * also pairs a legacy request with its checkpoint; here each is judged on
 * its own).
 */
export function isChatFindMessage(message: {
  readonly role: string
  readonly content: string
  readonly internalContext?: unknown
  readonly compactedContext?: unknown
}): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false
  if (message.internalContext === "provider-handoff") return false
  if (
    message.role === "assistant" &&
    message.compactedContext === true &&
    message.content.startsWith(LEGACY_HANDOFF_CHECKPOINT)
  ) {
    return false
  }
  return !(
    message.role === "user" && LEGACY_HANDOFF_REQUEST.test(message.content)
  )
}

/** Characters of context on each side of a match in a snippet. */
const SNIPPET_CONTEXT = 48

/**
 * One line of text around `[start, end)`, with an ellipsis where the
 * message goes on. Never splits a surrogate pair.
 */
export function chatFindSnippet(
  text: string,
  start: number,
  end: number,
  context: number = SNIPPET_CONTEXT
): string {
  let from = Math.max(0, start - context)
  let to = Math.min(text.length, end + context)
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from -= 1
  if (to < text.length && isLowSurrogate(text.charCodeAt(to))) to += 1
  const body = text.slice(from, to).replace(/\s+/gu, " ").trim()
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
