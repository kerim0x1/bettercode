import type { CanvasPoint, CanvasRect } from "@/lib/project-canvas"

/**
 * Workflow edges on the project canvas.
 *
 * An edge is drawn by dragging from one item's anchor onto another; it joins
 * any two items — notes, project cards, or one of each — and is purely
 * visual. Pinning a note to a card is the other relationship: that one moves
 * the note with the card, and draws its own dashed tether.
 */

export const CANVAS_CONNECTIONS_STORAGE_KEY = "betterc0de.canvas-connections.v1"

export type CanvasItemKind = "note" | "card" | "object"
const ITEM_KINDS: readonly CanvasItemKind[] = ["note", "card", "object"]

export interface CanvasAnchorRef {
  kind: CanvasItemKind
  id: string
}

export interface CanvasConnection {
  id: string
  from: CanvasAnchorRef
  to: CanvasAnchorRef
}

/** A rectangle plus what it is, so edges can address either kind. */
export type CanvasItemRect = CanvasRect & CanvasAnchorRef

export function anchorKey(anchor: CanvasAnchorRef): string {
  return `${anchor.kind}:${anchor.id}`
}

function readAnchor(value: unknown): CanvasAnchorRef | null {
  if (!value || typeof value !== "object") return null
  const entry = value as Record<string, unknown>
  const kind = entry.kind as CanvasItemKind
  if (!ITEM_KINDS.includes(kind)) return null
  if (typeof entry.id !== "string" || !entry.id) return null
  return { kind, id: entry.id }
}

export function readCanvasConnections(raw: string | null): CanvasConnection[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  const connections: CanvasConnection[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const entry = item as Record<string, unknown>
    const from = readAnchor(entry.from)
    const to = readAnchor(entry.to)
    if (!from || !to) continue
    if (typeof entry.id !== "string" || !entry.id) continue
    const key = pairKey(from, to)
    if (anchorKey(from) === anchorKey(to) || seen.has(key)) continue
    seen.add(key)
    connections.push({ id: entry.id, from, to })
  }
  return connections
}

/** Direction-independent, so A→B and B→A are the same edge. */
export function pairKey(a: CanvasAnchorRef, b: CanvasAnchorRef): string {
  return [anchorKey(a), anchorKey(b)].sort().join("|")
}

/**
 * Add an edge unless it would loop back on itself or duplicate one that is
 * already there — dragging onto an already-connected item is a no-op, not a
 * second line on top of the first.
 */
export function addConnection(
  connections: readonly CanvasConnection[],
  from: CanvasAnchorRef,
  to: CanvasAnchorRef,
  id: string
): CanvasConnection[] {
  if (anchorKey(from) === anchorKey(to)) return [...connections]
  const key = pairKey(from, to)
  if (connections.some((edge) => pairKey(edge.from, edge.to) === key)) {
    return [...connections]
  }
  return [...connections, { id, from, to }]
}

export function removeConnection(
  connections: readonly CanvasConnection[],
  id: string
): CanvasConnection[] {
  return connections.filter((edge) => edge.id !== id)
}

/**
 * Drop every edge touching an item that is being removed. Edges are not
 * pruned against the board at large: cards arrive with the thread list, and
 * an edge must survive the moment before its card is back.
 */
export function removeAnchor(
  connections: readonly CanvasConnection[],
  anchor: CanvasAnchorRef
): CanvasConnection[] {
  const key = anchorKey(anchor)
  return connections.filter(
    (edge) => anchorKey(edge.from) !== key && anchorKey(edge.to) !== key
  )
}

/** Painting order on the board, so the topmost item wins a hit test. */
const STACK: Record<CanvasItemKind, number> = { card: 0, object: 1, note: 2 }

/**
 * The item under a canvas point, the one drawn last winning. Hit testing
 * happens on the rectangles rather than in the DOM: a card is mostly iframe,
 * and an iframe swallows the events a DOM test would need.
 */
export function itemAt(
  items: Iterable<CanvasItemRect>,
  point: CanvasPoint
): CanvasItemRect | null {
  let found: CanvasItemRect | null = null
  for (const item of items) {
    if (
      point.x < item.x ||
      point.y < item.y ||
      point.x > item.x + item.width ||
      point.y > item.y + item.height
    )
      continue
    if (!found || STACK[item.kind] >= STACK[found.kind]) found = item
  }
  return found
}

function centre(rect: CanvasRect): CanvasPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/**
 * Where an edge leaves a rectangle: the middle of whichever side faces the
 * other item. Sides, not corners, keep the curve reading as a flow.
 */
export function sidePoint(
  rect: CanvasRect,
  toward: CanvasPoint
): { point: CanvasPoint; axis: "x" | "y"; sign: 1 | -1 } {
  const from = centre(rect)
  const dx = toward.x - from.x
  const dy = toward.y - from.y
  const horizontal =
    Math.abs(dx) * Math.max(rect.height, 1) >=
    Math.abs(dy) * Math.max(rect.width, 1)
  if (horizontal) {
    const sign = dx >= 0 ? 1 : -1
    return {
      point: { x: from.x + (sign * rect.width) / 2, y: from.y },
      axis: "x",
      sign,
    }
  }
  const sign = dy >= 0 ? 1 : -1
  return {
    point: { x: from.x, y: from.y + (sign * rect.height) / 2 },
    axis: "y",
    sign,
  }
}

export interface ConnectionGeometry {
  id: string
  path: string
  /** Midpoint of the curve, where the delete affordance sits. */
  mid: CanvasPoint
  /** Arrow head position and rotation, in degrees. */
  head: CanvasPoint
  headAngle: number
}

const MIN_CURVE = 40
const MAX_CURVE = 160

/** A cubic whose handles leave each side straight out, like a flow chart. */
export function connectionGeometry(
  id: string,
  from: CanvasRect,
  to: CanvasRect
): ConnectionGeometry {
  const start = sidePoint(from, centre(to))
  const end = sidePoint(to, centre(from))
  const span = Math.hypot(
    end.point.x - start.point.x,
    end.point.y - start.point.y
  )
  const pull = Math.min(MAX_CURVE, Math.max(MIN_CURVE, span / 2))
  const c1 =
    start.axis === "x"
      ? { x: start.point.x + start.sign * pull, y: start.point.y }
      : { x: start.point.x, y: start.point.y + start.sign * pull }
  const c2 =
    end.axis === "x"
      ? { x: end.point.x + end.sign * pull, y: end.point.y }
      : { x: end.point.x, y: end.point.y + end.sign * pull }
  const mid = cubicAt(start.point, c1, c2, end.point, 0.5)
  const beforeEnd = cubicAt(start.point, c1, c2, end.point, 0.92)
  return {
    id,
    path: `M ${round(start.point.x)} ${round(start.point.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(end.point.x)} ${round(end.point.y)}`,
    mid,
    head: end.point,
    headAngle:
      (Math.atan2(end.point.y - beforeEnd.y, end.point.x - beforeEnd.x) * 180) /
      Math.PI,
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

export function cubicAt(
  p0: CanvasPoint,
  p1: CanvasPoint,
  p2: CanvasPoint,
  p3: CanvasPoint,
  t: number
): CanvasPoint {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

/** Geometry for every edge whose two items are both on the board. */
export function connectionGeometries(
  connections: readonly CanvasConnection[],
  items: ReadonlyMap<string, CanvasItemRect>
): ConnectionGeometry[] {
  const result: ConnectionGeometry[] = []
  for (const edge of connections) {
    const from = items.get(anchorKey(edge.from))
    const to = items.get(anchorKey(edge.to))
    if (!from || !to) continue
    result.push(connectionGeometry(edge.id, from, to))
  }
  return result
}
