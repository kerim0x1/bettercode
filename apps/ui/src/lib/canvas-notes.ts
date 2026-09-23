import type { CanvasPoint, CanvasRect } from "@/lib/project-canvas"

/**
 * Sticky notes on the project canvas.
 *
 * A note is either loose — it keeps its own stage coordinates — or pinned to
 * a project card, in which case it stores an offset from that card's origin
 * and rides along whenever the card moves. A pinned note also draws a
 * connector to its card so the relationship is visible, not just implied.
 */

export const CANVAS_NOTES_STORAGE_KEY = "betterc0de.canvas-notes.v1"

export const NOTE_COLORS = ["amber", "sky", "emerald", "rose", "slate"] as const
export type NoteColor = (typeof NOTE_COLORS)[number]

export const NOTE_DEFAULT_WIDTH = 260
export const NOTE_DEFAULT_HEIGHT = 180
export const NOTE_MIN_WIDTH = 160
export const NOTE_MIN_HEIGHT = 120
export const NOTE_MAX_WIDTH = 720
export const NOTE_MAX_HEIGHT = 720

export interface CanvasNote extends CanvasRect {
  id: string
  text: string
  color: NoteColor
  /** Thread id of the card this note rides along with. */
  pinnedTo?: string
  /** Position relative to that card's origin, kept while pinned. */
  pinOffset?: CanvasPoint
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function createCanvasNote(point: CanvasPoint): CanvasNote {
  return {
    id: crypto.randomUUID(),
    x: Math.round(point.x),
    y: Math.round(point.y),
    width: NOTE_DEFAULT_WIDTH,
    height: NOTE_DEFAULT_HEIGHT,
    text: "",
    color: "amber",
  }
}

/** Tolerant of anything the stored value has grown into across versions. */
export function readCanvasNotes(raw: string | null): CanvasNote[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const notes: CanvasNote[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== "string" || !entry.id) continue
    const color = NOTE_COLORS.includes(entry.color as NoteColor)
      ? (entry.color as NoteColor)
      : "amber"
    const pinnedTo =
      typeof entry.pinnedTo === "string" && entry.pinnedTo
        ? entry.pinnedTo
        : undefined
    const offset = entry.pinOffset as Record<string, unknown> | undefined
    notes.push({
      id: entry.id,
      x: finite(entry.x, 0),
      y: finite(entry.y, 0),
      width: clamp(
        finite(entry.width, NOTE_DEFAULT_WIDTH),
        NOTE_MIN_WIDTH,
        NOTE_MAX_WIDTH
      ),
      height: clamp(
        finite(entry.height, NOTE_DEFAULT_HEIGHT),
        NOTE_MIN_HEIGHT,
        NOTE_MAX_HEIGHT
      ),
      text: typeof entry.text === "string" ? entry.text : "",
      color,
      ...(pinnedTo ? { pinnedTo } : {}),
      ...(pinnedTo && offset
        ? {
            pinOffset: {
              x: finite(offset.x, 0),
              y: finite(offset.y, 0),
            },
          }
        : {}),
    })
  }
  return notes
}

/** Where a note actually sits: a pinned one follows its card. */
export function resolveNotePosition(
  note: CanvasNote,
  cards: ReadonlyMap<string, CanvasPoint>
): CanvasPoint {
  if (!note.pinnedTo || !note.pinOffset) return { x: note.x, y: note.y }
  const card = cards.get(note.pinnedTo)
  if (!card) return { x: note.x, y: note.y }
  return { x: card.x + note.pinOffset.x, y: card.y + note.pinOffset.y }
}

export function noteRect(
  note: CanvasNote,
  cards: ReadonlyMap<string, CanvasPoint>
): CanvasRect {
  const point = resolveNotePosition(note, cards)
  return { ...point, width: note.width, height: note.height }
}

/**
 * Attach a note to a card. The note stays exactly where the user put it —
 * pinning draws the connection, it does not rearrange the board.
 */
export function pinNote(
  note: CanvasNote,
  card: CanvasPoint,
  threadId: string,
  cards: ReadonlyMap<string, CanvasPoint>
): CanvasNote {
  const current = resolveNotePosition(note, cards)
  return {
    ...note,
    x: Math.round(current.x),
    y: Math.round(current.y),
    pinnedTo: threadId,
    pinOffset: {
      x: Math.round(current.x - card.x),
      y: Math.round(current.y - card.y),
    },
  }
}

/** Detach, freezing the note where it currently sits. */
export function unpinNote(
  note: CanvasNote,
  cards: ReadonlyMap<string, CanvasPoint>
): CanvasNote {
  const point = resolveNotePosition(note, cards)
  const next: CanvasNote = { ...note, x: point.x, y: point.y }
  delete next.pinnedTo
  delete next.pinOffset
  return next
}

/** Move a note, keeping its pin by rewriting the offset. */
export function moveNote(
  note: CanvasNote,
  point: CanvasPoint,
  cards: ReadonlyMap<string, CanvasPoint>
): CanvasNote {
  const next: CanvasNote = {
    ...note,
    x: Math.round(point.x),
    y: Math.round(point.y),
  }
  if (!note.pinnedTo) return next
  const card = cards.get(note.pinnedTo)
  if (!card) return next
  next.pinOffset = {
    x: Math.round(point.x - card.x),
    y: Math.round(point.y - card.y),
  }
  return next
}

export function resizeNote(
  note: CanvasNote,
  size: { width: number; height: number }
): CanvasNote {
  return {
    ...note,
    width: Math.round(clamp(size.width, NOTE_MIN_WIDTH, NOTE_MAX_WIDTH)),
    height: Math.round(clamp(size.height, NOTE_MIN_HEIGHT, NOTE_MAX_HEIGHT)),
  }
}

/**
 * Where the connector meets a rectangle: the point on its border along the
 * line to the other rectangle's centre, so the line stops at the edge
 * instead of running underneath the card.
 */
export function borderPoint(
  rect: CanvasRect,
  toward: CanvasPoint
): CanvasPoint {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const halfWidth = rect.width / 2
  const halfHeight = rect.height / 2
  // The smaller scale is the edge the ray leaves through.
  const scaleX = dx === 0 ? Infinity : halfWidth / Math.abs(dx)
  const scaleY = dy === 0 ? Infinity : halfHeight / Math.abs(dy)
  const scale = Math.min(scaleX, scaleY)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

/** Two rectangles that touch need no line drawn between them. */
export function rectsOverlap(a: CanvasRect, b: CanvasRect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

export interface NoteConnector {
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/** One line per pinned note, from its border to the card's border. */
export function noteConnectors(
  notes: readonly CanvasNote[],
  cards: ReadonlyMap<string, CanvasRect>
): NoteConnector[] {
  const points = new Map<string, CanvasPoint>(
    [...cards].map(([id, rect]) => [id, { x: rect.x, y: rect.y }])
  )
  const lines: NoteConnector[] = []
  for (const note of notes) {
    if (!note.pinnedTo) continue
    const card = cards.get(note.pinnedTo)
    if (!card) continue
    const from = noteRect(note, points)
    if (rectsOverlap(from, card)) continue
    const fromCentre = {
      x: from.x + from.width / 2,
      y: from.y + from.height / 2,
    }
    const toCentre = { x: card.x + card.width / 2, y: card.y + card.height / 2 }
    const start = borderPoint(from, toCentre)
    const end = borderPoint(card, fromCentre)
    lines.push({ id: note.id, x1: start.x, y1: start.y, x2: end.x, y2: end.y })
  }
  return lines
}
