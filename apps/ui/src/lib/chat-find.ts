import {
  CHAT_FIND_MATCH_LIMIT,
  chatFindRanges,
  countChatFindMatches,
} from "@betterc0de/schema"

/**
 * Find in chat, renderer side: which transcript entries are searched, the
 * numbered list of matches over the loaded entries and the older stored
 * messages the backend reported, and the count the find bar shows. The
 * matching rules are shared with the backend (`@betterc0de/schema`
 * `chatFindPattern`).
 */

/** A transcript entry the renderer holds, with the text find searches. */
export interface ChatFindTarget {
  readonly id: string
  readonly text: string
}

/**
 * The parts of a transcript timeline entry find reads. Messages are
 * searched by their text, recorded plans (`proposed-plan`) by the plan.
 */
export interface ChatFindTimelineEntry {
  readonly kind: string
  readonly id: string
  readonly msg?: { readonly role: string; readonly content: string }
  /** A `proposed-plan` entry shows this message's plan instead. */
  readonly hidePlanCard?: boolean
  readonly content?: string
  /** A plan under review shows in the approval card, not the transcript. */
  readonly awaitingApproval?: boolean
}

/** The searchable entries of a transcript timeline, in transcript order. */
export function chatFindTargets(
  entries: ReadonlyArray<ChatFindTimelineEntry>
): ChatFindTarget[] {
  const targets: ChatFindTarget[] = []
  for (const entry of entries) {
    if (entry.kind === "message" && entry.msg) {
      const { role, content } = entry.msg
      if (role !== "user" && role !== "assistant") continue
      // The plan's own entry is searched; counting it twice would number
      // one plan's matches in two places.
      if (entry.hidePlanCard) continue
      if (content) targets.push({ id: entry.id, text: content })
    } else if (
      entry.kind === "proposed-plan" &&
      entry.content &&
      !entry.awaitingApproval
    ) {
      targets.push({ id: entry.id, text: entry.content })
    }
  }
  return targets
}

/** A stored message the renderer has not loaded, as the backend found it. */
export interface ChatFindRemoteHit {
  readonly messageId: string
  readonly sequence: number
  readonly matchCount: number
}

/** One match: its entry and its place among that entry's matches. */
export interface ChatFindMatch {
  readonly entryId: string
  /** 0-based position of the match in the entry's text. */
  readonly occurrence: number
  /** False for a message the renderer has not loaded yet. */
  readonly loaded: boolean
  /** Storage sequence of a message that is not loaded. */
  readonly sequence?: number
}

export interface ChatFindResult {
  /** Matches in transcript order, oldest first. */
  readonly matches: ReadonlyArray<ChatFindMatch>
  /** More matches exist than `matches` holds. */
  readonly truncated: boolean
}

export const EMPTY_CHAT_FIND_RESULT: ChatFindResult = {
  matches: [],
  truncated: false,
}

/**
 * Counts in one entry's text, remembered while the text and the pattern
 * stay the same. Unchanged messages keep their string, so a streamed reply
 * or a new message recounts only itself.
 */
export class ChatFindCountCache {
  private pattern: RegExp | null = null
  private counts = new Map<string, { text: string; count: number }>()

  count(target: ChatFindTarget, pattern: RegExp): number {
    if (pattern !== this.pattern) {
      this.pattern = pattern
      this.counts.clear()
    }
    const cached = this.counts.get(target.id)
    if (cached && cached.text === target.text) return cached.count
    const count = countChatFindMatches(target.text, pattern)
    this.counts.set(target.id, { text: target.text, count })
    return count
  }
}

/**
 * The numbered matches of a search. Loaded entries are counted here; older
 * stored messages come from the backend (`remoteHits`, searched before the
 * loaded ones). A hit for a message that has been loaded since (it is in
 * `targets` or `loadedIds`) is left to the loaded copy. Beyond `limit` the
 * newest matches are kept: in a chat the recent ones are the likely
 * target, and the oldest are the ones that would need loading.
 */
export function buildChatFindResult(input: {
  readonly targets: ReadonlyArray<ChatFindTarget>
  readonly pattern: RegExp
  readonly remoteHits?: ReadonlyArray<ChatFindRemoteHit>
  readonly remoteTruncated?: boolean
  /** Every message the renderer holds, shown or not. */
  readonly loadedIds?: ReadonlySet<string>
  readonly limit?: number
  readonly cache?: ChatFindCountCache
}): ChatFindResult {
  const limit = Math.max(1, input.limit ?? CHAT_FIND_MATCH_LIMIT)
  const newestFirst: ChatFindMatch[] = []
  const take = (
    entryId: string,
    count: number,
    extra: Pick<ChatFindMatch, "loaded" | "sequence">
  ): boolean => {
    for (let occurrence = count - 1; occurrence >= 0; occurrence -= 1) {
      if (newestFirst.length >= limit) return false
      newestFirst.push({ entryId, occurrence, ...extra })
    }
    return true
  }

  let complete = true
  for (
    let index = input.targets.length - 1;
    index >= 0 && complete;
    index -= 1
  ) {
    const target = input.targets[index]
    if (!target) continue
    const count = input.cache
      ? input.cache.count(target, input.pattern)
      : countChatFindMatches(target.text, input.pattern)
    complete = take(target.id, count, { loaded: true })
  }
  if (complete && input.remoteHits) {
    const targetIds = new Set(input.targets.map((target) => target.id))
    const older = input.remoteHits
      .filter(
        (hit) =>
          !targetIds.has(hit.messageId) &&
          input.loadedIds?.has(hit.messageId) !== true
      )
      .sort((a, b) => b.sequence - a.sequence)
    for (const hit of older) {
      complete = take(hit.messageId, hit.matchCount, {
        loaded: false,
        sequence: hit.sequence,
      })
      if (!complete) break
    }
  }
  return {
    matches: newestFirst.reverse(),
    truncated: !complete || input.remoteTruncated === true,
  }
}

/** Whether two results list the same matches, so one can stand for both. */
export function sameChatFindResult(
  a: ChatFindResult,
  b: ChatFindResult
): boolean {
  if (a === b) return true
  if (a.truncated !== b.truncated || a.matches.length !== b.matches.length) {
    return false
  }
  return a.matches.every((match, index) => {
    const other = b.matches[index]
    return (
      other !== undefined &&
      match.entryId === other.entryId &&
      match.occurrence === other.occurrence &&
      match.loaded === other.loaded &&
      match.sequence === other.sequence
    )
  })
}

/** Where a match sits in a result, by entry and occurrence. */
export function findChatFindMatchIndex(
  matches: ReadonlyArray<ChatFindMatch>,
  match: Pick<ChatFindMatch, "entryId" | "occurrence"> | null
): number {
  if (!match) return -1
  return matches.findIndex(
    (candidate) =>
      candidate.entryId === match.entryId &&
      candidate.occurrence === match.occurrence
  )
}

/**
 * The match a new search starts on: the first one at or after the entry
 * the reader is looking at, else the newest one before it. Without an
 * anchor (nothing mounted), the newest match.
 */
export function initialChatFindIndex(
  matches: ReadonlyArray<ChatFindMatch>,
  targets: ReadonlyArray<ChatFindTarget>,
  anchorEntryId: string | null
): number {
  if (matches.length === 0) return -1
  const order = new Map(
    targets.map((target, index): [string, number] => [target.id, index])
  )
  const anchor = anchorEntryId === null ? undefined : order.get(anchorEntryId)
  if (anchor === undefined) return matches.length - 1
  const index = matches.findIndex(
    (match) => match.loaded && (order.get(match.entryId) ?? -1) >= anchor
  )
  return index >= 0 ? index : matches.length - 1
}

/** The next or previous match, wrapping around at either end. */
export function stepChatFindIndex(
  current: number,
  total: number,
  direction: 1 | -1
): number {
  if (total <= 0) return -1
  if (current < 0) return direction === 1 ? 0 : total - 1
  return (current + direction + total) % total
}

/** "3 of 12", "3 of 1000+" past the limit, or "No results". */
export function formatChatFindCount(
  index: number,
  total: number,
  truncated: boolean
): string {
  if (total === 0) return "No results"
  const position = index >= 0 ? index + 1 : 0
  return `${position} of ${total}${truncated ? "+" : ""}`
}

/** Text the find bar reads aloud for the count. */
export function describeChatFindCount(
  index: number,
  total: number,
  truncated: boolean
): string {
  if (total === 0) return "No results"
  const of = truncated ? `more than ${total}` : String(total)
  return index >= 0
    ? `Result ${index + 1} of ${of}`
    : `${truncated ? "More than " : ""}${total} results`
}

// ── Matching inside the rendered text ───────────────────────────────────

/** A run of rendered text and the block element it sits in. */
export interface ChatFindTextSegment {
  readonly text: string
  /** Segments of different blocks never join into one match. */
  readonly block: number
}

/** A match in rendered text: segment and offset of its start and end. */
export interface ChatFindSegmentRange {
  readonly startSegment: number
  readonly startOffset: number
  readonly endSegment: number
  readonly endOffset: number
}

/**
 * Matches across the text runs of one rendered message. Markdown splits a
 * phrase over several text nodes (`foo **bar**`), so runs of one block are
 * joined; between blocks a line break is assumed, as the source has one.
 */
export function chatFindSegmentRanges(
  segments: ReadonlyArray<ChatFindTextSegment>,
  pattern: RegExp,
  limit: number = CHAT_FIND_MATCH_LIMIT
): ChatFindSegmentRange[] {
  const starts: number[] = []
  let joined = ""
  segments.forEach((segment, index) => {
    const previous = segments[index - 1]
    if (previous && previous.block !== segment.block) joined += "\n"
    starts.push(joined.length)
    joined += segment.text
  })
  const result: ChatFindSegmentRange[] = []
  // Match offsets only grow, so one cursor walks the segments.
  let cursor = 0
  const segmentEnd = (index: number) =>
    (starts[index] ?? 0) + (segments[index]?.text.length ?? 0)
  for (const [start, end] of chatFindRanges(joined, pattern, limit)) {
    while (cursor < segments.length - 1 && start >= segmentEnd(cursor)) {
      cursor += 1
    }
    const startSegment = cursor
    const startOffset = Math.max(0, start - (starts[startSegment] ?? 0))
    let endSegment = startSegment
    while (endSegment < segments.length - 1 && end > segmentEnd(endSegment)) {
      endSegment += 1
    }
    const endOffset = Math.min(
      segments[endSegment]?.text.length ?? 0,
      Math.max(0, end - (starts[endSegment] ?? 0))
    )
    if (endSegment === startSegment && endOffset <= startOffset) continue
    result.push({ startSegment, startOffset, endSegment, endOffset })
  }
  return result
}
