import type { CanvasPoint, CanvasRect } from "@/lib/project-canvas"

/**
 * Which canvas guests (device previews, embedded pages) keep a live
 * `<webview>`. Every guest is its own Chromium renderer process, so the board
 * mounts only those the user can actually see, at a size where the page is
 * readable, up to a fixed number. The rest show a light placeholder and load
 * again when they come back into view.
 */

/** Live guests the board keeps at most, pinned guests included. */
export const MAX_LIVE_CANVAS_GUESTS = 6
/** Screen pixels around the viewport in which a paused guest starts loading. */
export const LIVE_GUEST_ENTER_MARGIN = 160
/** Screen pixels a live guest may drift out of view before it is paused. */
export const LIVE_GUEST_EXIT_MARGIN = 480
/** Below this on-screen extent (longer side, px) a paused guest stays paused. */
export const MIN_LIVE_GUEST_EXTENT = 120
/** A live guest is paused only once it shrinks below this extent. */
export const MIN_KEEP_GUEST_EXTENT = 96

/**
 * - live: the guest is mounted.
 * - offscreen: it is outside the visible part of the board.
 * - small: the board is zoomed out so far the page would be unreadable.
 * - capped: it is visible, but more recently used guests hold every slot.
 */
export type CanvasGuestState = "live" | "offscreen" | "small" | "capped"

export interface CanvasGuestCandidate {
  readonly id: string
  /** Stage coordinates, the space placements and objects live in. */
  readonly rect: CanvasRect
  /** Kept live whatever the camera does: the inspected preview, the selected embed. */
  readonly pinned?: boolean
  /** Ranked ahead of other visible guests when the cap applies (the active chat's card). */
  readonly preferred?: boolean
}

export interface CanvasCamera {
  readonly zoom: number
  readonly pan: CanvasPoint
  /** Size of the canvas viewport in screen pixels. */
  readonly width: number
  readonly height: number
}

export interface DecideCanvasGuestsInput {
  readonly candidates: readonly CanvasGuestCandidate[]
  /** Null while the viewport is unmeasured; every guest is then visible. */
  readonly camera: CanvasCamera | null
  /** Guests that were live after the previous decision (hysteresis). */
  readonly previous: ReadonlySet<string>
  /** Guest ids, most recently used first. */
  readonly recent: readonly string[]
  readonly max?: number
}

function screenRect(rect: CanvasRect, camera: CanvasCamera): CanvasRect {
  return {
    x: camera.pan.x + rect.x * camera.zoom,
    y: camera.pan.y + rect.y * camera.zoom,
    width: rect.width * camera.zoom,
    height: rect.height * camera.zoom,
  }
}

function overlap(rect: CanvasRect, camera: CanvasCamera, margin: number) {
  const width =
    Math.min(rect.x + rect.width, camera.width + margin) -
    Math.max(rect.x, -margin)
  const height =
    Math.min(rect.y + rect.height, camera.height + margin) -
    Math.max(rect.y, -margin)
  return width > 0 && height > 0 ? width * height : 0
}

/** The state of every candidate. Pure, so the board can recompute it freely. */
export function decideCanvasGuests(
  input: DecideCanvasGuestsInput
): Map<string, CanvasGuestState> {
  const max = Math.max(0, input.max ?? MAX_LIVE_CANVAS_GUESTS)
  const camera =
    input.camera &&
    input.camera.width > 0 &&
    input.camera.height > 0 &&
    input.camera.zoom > 0
      ? input.camera
      : null
  const recency = new Map(input.recent.map((id, index) => [id, index]))
  const states = new Map<string, CanvasGuestState>()
  const eligible: Array<{
    candidate: CanvasGuestCandidate
    wasLive: boolean
    visibleArea: number
  }> = []

  for (const candidate of input.candidates) {
    const wasLive = input.previous.has(candidate.id)
    if (!camera) {
      eligible.push({ candidate, wasLive, visibleArea: 0 })
      continue
    }
    const rect = screenRect(candidate.rect, camera)
    const visibleArea = overlap(rect, camera, 0)
    if (!candidate.pinned) {
      const margin = wasLive ? LIVE_GUEST_EXIT_MARGIN : LIVE_GUEST_ENTER_MARGIN
      if (overlap(rect, camera, margin) === 0) {
        states.set(candidate.id, "offscreen")
        continue
      }
      const extent = Math.max(rect.width, rect.height)
      if (extent < (wasLive ? MIN_KEEP_GUEST_EXTENT : MIN_LIVE_GUEST_EXTENT)) {
        states.set(candidate.id, "small")
        continue
      }
    }
    eligible.push({ candidate, wasLive, visibleArea })
  }

  const rank = (item: (typeof eligible)[number]) => [
    item.candidate.pinned ? 0 : 1,
    item.candidate.preferred ? 0 : 1,
    recency.get(item.candidate.id) ?? Number.MAX_SAFE_INTEGER,
    item.wasLive ? 0 : 1,
    -item.visibleArea,
  ]
  eligible.sort((left, right) => {
    const a = rank(left)
    const b = rank(right)
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index]
    }
    return left.candidate.id < right.candidate.id ? -1 : 1
  })

  let live = 0
  for (const { candidate } of eligible) {
    if (candidate.pinned || live < max) {
      states.set(candidate.id, "live")
      live += 1
    } else {
      states.set(candidate.id, "capped")
    }
  }
  return states
}

/** Guest id of an embedded page object (device previews use their viewport key). */
export function canvasObjectGuestId(objectId: string): string {
  return `object:${objectId}`
}

export function liveGuestIds(
  states: ReadonlyMap<string, CanvasGuestState>
): Set<string> {
  const ids = new Set<string>()
  for (const [id, state] of states) if (state === "live") ids.add(id)
  return ids
}

export function sameGuestStates(
  left: ReadonlyMap<string, CanvasGuestState>,
  right: ReadonlyMap<string, CanvasGuestState>
): boolean {
  if (left.size !== right.size) return false
  for (const [id, state] of left) if (right.get(id) !== state) return false
  return true
}

/** Moves `id` to the front of the recency list, keeping at most `limit` ids. */
export function touchRecentGuest(
  recent: readonly string[],
  id: string,
  limit = 32
): string[] {
  return [id, ...recent.filter((item) => item !== id)].slice(0, limit)
}
