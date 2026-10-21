/** Number of timeline entries mounted at the live end of a chat. */
export const TRANSCRIPT_WINDOW_SIZE = 40

export interface TranscriptWindow<T> {
  readonly visible: readonly T[]
  readonly hiddenBefore: number
  readonly startIndex: number
}

/**
 * Mount only a window of the transcript. By default that is the tail; a
 * `startIndex` (from {@link transcriptWindowStart}) extends it toward older
 * history. Entries before the window stay out of the React tree.
 */
export function windowTranscriptEntries<T>(
  entries: readonly T[],
  options: { readonly size?: number; readonly startIndex?: number } = {}
): TranscriptWindow<T> {
  const size = Math.max(1, Math.floor(options.size ?? TRANSCRIPT_WINDOW_SIZE))
  if (entries.length === 0) {
    return { visible: entries, hiddenBefore: 0, startIndex: 0 }
  }
  const maxStart = Math.max(0, entries.length - size)
  const requested =
    options.startIndex === undefined
      ? maxStart
      : Math.min(maxStart, Math.max(0, Math.floor(options.startIndex)))
  return {
    visible: entries.slice(requested),
    hiddenBefore: requested,
    startIndex: requested,
  }
}

/**
 * How far the user has opened the transcript toward older history.
 *
 * Anchored to an entry id rather than an index: new replies append at the
 * end and older pages prepend at the start, and both would shift a plain
 * index. The window starts `extra` entries above the anchor entry.
 */
export interface TranscriptHistoryAnchor {
  readonly threadId: string | null
  readonly entryId: string
  readonly extra: number
}

/** Start index for the window, or undefined for the default tail window. */
export function transcriptWindowStart(
  entries: ReadonlyArray<{ readonly id: string }>,
  anchor: TranscriptHistoryAnchor | null,
  threadId: string | null
): number | undefined {
  if (!anchor || anchor.threadId !== threadId) return undefined
  const index = entries.findIndex((entry) => entry.id === anchor.entryId)
  if (index < 0) return undefined
  return Math.max(0, index - anchor.extra)
}

/**
 * Anchor that shows `step` more entries above the current window. When the
 * window already starts at the first loaded entry, the same anchor shows the
 * next older page as soon as it is prepended.
 */
export function growTranscriptWindow(
  entries: ReadonlyArray<{ readonly id: string }>,
  currentStart: number,
  threadId: string | null,
  step: number = TRANSCRIPT_WINDOW_SIZE
): TranscriptHistoryAnchor | null {
  const first = entries[Math.max(0, Math.min(currentStart, entries.length - 1))]
  return first ? { threadId, entryId: first.id, extra: step } : null
}

/** Anchor that keeps every loaded entry mounted, including later pages. */
export function revealWholeTranscript(
  entries: ReadonlyArray<{ readonly id: string }>,
  threadId: string | null
): TranscriptHistoryAnchor | null {
  const first = entries[0]
  return first
    ? { threadId, entryId: first.id, extra: Number.MAX_SAFE_INTEGER }
    : null
}
