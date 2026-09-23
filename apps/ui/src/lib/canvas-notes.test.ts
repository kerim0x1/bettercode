import { describe, expect, it } from "vitest"
import {
  borderPoint,
  createCanvasNote,
  moveNote,
  noteConnectors,
  NOTE_DEFAULT_HEIGHT,
  NOTE_DEFAULT_WIDTH,
  NOTE_MIN_WIDTH,
  pinNote,
  readCanvasNotes,
  resizeNote,
  resolveNotePosition,
  unpinNote,
  type CanvasNote,
} from "@/lib/canvas-notes"
import type { CanvasPoint, CanvasRect } from "@/lib/project-canvas"

const CARD: CanvasRect = { x: 100, y: 200, width: 500, height: 400 }
const cards = new Map<string, CanvasPoint>([["thread-1", CARD]])
const cardRects = new Map<string, CanvasRect>([["thread-1", CARD]])

function note(partial: Partial<CanvasNote> = {}): CanvasNote {
  return { ...createCanvasNote({ x: 0, y: 0 }), ...partial }
}

describe("readCanvasNotes", () => {
  it("returns nothing for absent or unparseable storage", () => {
    expect(readCanvasNotes(null)).toEqual([])
    expect(readCanvasNotes("not json")).toEqual([])
    expect(readCanvasNotes('{"not":"an array"}')).toEqual([])
  })

  it("fills in defaults and drops entries without an id", () => {
    const [first, ...rest] = readCanvasNotes(
      JSON.stringify([{ id: "a" }, { x: 1 }, null])
    )
    expect(rest).toEqual([])
    expect(first).toMatchObject({
      id: "a",
      x: 0,
      y: 0,
      width: NOTE_DEFAULT_WIDTH,
      height: NOTE_DEFAULT_HEIGHT,
      text: "",
      color: "amber",
    })
  })

  it("clamps a stored size and falls back on an unknown colour", () => {
    const [restored] = readCanvasNotes(
      JSON.stringify([{ id: "a", width: 10, height: 99999, color: "neon" }])
    )
    expect(restored.width).toBe(NOTE_MIN_WIDTH)
    expect(restored.height).toBe(720)
    expect(restored.color).toBe("amber")
  })

  it("keeps a pin only when it has an offset to go with it", () => {
    const [withOffset] = readCanvasNotes(
      JSON.stringify([
        { id: "a", pinnedTo: "thread-1", pinOffset: { x: 5, y: 6 } },
      ])
    )
    expect(withOffset).toMatchObject({
      pinnedTo: "thread-1",
      pinOffset: { x: 5, y: 6 },
    })
    const [without] = readCanvasNotes(
      JSON.stringify([{ id: "b", pinnedTo: "thread-1" }])
    )
    expect(without.pinOffset).toBeUndefined()
  })
})

describe("pinning", () => {
  it("leaves the note where it sits and records the offset", () => {
    const pinned = pinNote(note({ x: 40, y: 60 }), CARD, "thread-1", cards)
    expect(pinned).toMatchObject({ x: 40, y: 60 })
    expect(pinned.pinOffset).toEqual({ x: -60, y: -140 })
  })

  it("follows the card once pinned", () => {
    const pinned = pinNote(note({ x: 40, y: 60 }), CARD, "thread-1", cards)
    const moved = new Map<string, CanvasPoint>([["thread-1", { x: 300, y: 0 }]])
    expect(resolveNotePosition(pinned, moved)).toEqual({ x: 240, y: -140 })
  })

  it("falls back to its own coordinates when the card is gone", () => {
    const pinned = pinNote(note({ x: 40, y: 60 }), CARD, "thread-1", cards)
    expect(resolveNotePosition(pinned, new Map())).toEqual({ x: 40, y: 60 })
  })

  it("freezes the note where it sits when unpinned", () => {
    const pinned = pinNote(note({ x: 40, y: 60 }), CARD, "thread-1", cards)
    const moved = new Map<string, CanvasPoint>([["thread-1", { x: 300, y: 0 }]])
    const loose = unpinNote(pinned, moved)
    expect(loose).toMatchObject({ x: 240, y: -140 })
    expect(loose.pinnedTo).toBeUndefined()
    expect(loose.pinOffset).toBeUndefined()
  })

  it("rewrites the offset when a pinned note is dragged", () => {
    const pinned = pinNote(note({ x: 40, y: 60 }), CARD, "thread-1", cards)
    const dragged = moveNote(pinned, { x: 150, y: 250 }, cards)
    expect(dragged.pinOffset).toEqual({ x: 50, y: 50 })
    expect(dragged.pinnedTo).toBe("thread-1")
  })

  it("keeps a loose note loose when dragged", () => {
    const dragged = moveNote(note({ x: 1, y: 2 }), { x: 9, y: 9 }, cards)
    expect(dragged.pinnedTo).toBeUndefined()
    expect(dragged).toMatchObject({ x: 9, y: 9 })
  })
})

describe("resizeNote", () => {
  it("clamps to the allowed range", () => {
    expect(resizeNote(note(), { width: 10, height: 10 })).toMatchObject({
      width: NOTE_MIN_WIDTH,
      height: 120,
    })
    expect(resizeNote(note(), { width: 9999, height: 9999 })).toMatchObject({
      width: 720,
      height: 720,
    })
  })
})

describe("borderPoint", () => {
  const rect: CanvasRect = { x: 0, y: 0, width: 100, height: 100 }

  it("leaves through the side the target lies on", () => {
    expect(borderPoint(rect, { x: 500, y: 50 })).toEqual({ x: 100, y: 50 })
    expect(borderPoint(rect, { x: -500, y: 50 })).toEqual({ x: 0, y: 50 })
    expect(borderPoint(rect, { x: 50, y: -500 })).toEqual({ x: 50, y: 0 })
  })

  it("returns the centre when the target is the centre", () => {
    expect(borderPoint(rect, { x: 50, y: 50 })).toEqual({ x: 50, y: 50 })
  })
})

describe("noteConnectors", () => {
  it("draws one edge-to-edge line per pinned note", () => {
    const placed = note({ x: 800, y: 300, width: 200, height: 100 })
    const pinned = pinNote(placed, CARD, "thread-1", cards)
    const [line, ...rest] = noteConnectors([pinned, note()], cardRects)
    expect(rest).toEqual([])
    expect(line.id).toBe(pinned.id)
    // The note sits to the right, so the line runs note-left to card-right.
    expect(line.x1).toBe(800)
    expect(line.x2).toBe(600)
  })

  it("draws no line while the note sits on top of its card", () => {
    const over = note({ x: 200, y: 300, width: 200, height: 100 })
    const pinned = pinNote(over, CARD, "thread-1", cards)
    expect(noteConnectors([pinned], cardRects)).toEqual([])
  })

  it("skips a note whose card left the canvas", () => {
    const pinned = pinNote(note(), CARD, "thread-1", cards)
    expect(noteConnectors([pinned], new Map())).toEqual([])
  })
})
