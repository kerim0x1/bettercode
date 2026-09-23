import { describe, expect, it } from "vitest"
import {
  addConnection,
  anchorKey,
  connectionGeometries,
  connectionGeometry,
  cubicAt,
  itemAt,
  pairKey,
  readCanvasConnections,
  removeAnchor,
  removeConnection,
  sidePoint,
  type CanvasConnection,
  type CanvasItemRect,
} from "@/lib/canvas-connections"
import type { CanvasRect } from "@/lib/project-canvas"

const NOTE_A = { kind: "note", id: "a" } as const
const NOTE_B = { kind: "note", id: "b" } as const
const CARD_A = { kind: "card", id: "a" } as const

const LEFT: CanvasRect = { x: 0, y: 0, width: 100, height: 100 }
const RIGHT: CanvasRect = { x: 400, y: 0, width: 100, height: 100 }
const BELOW: CanvasRect = { x: 0, y: 400, width: 100, height: 100 }

function edge(partial: Partial<CanvasConnection> = {}): CanvasConnection {
  return { id: "e1", from: NOTE_A, to: NOTE_B, ...partial }
}

describe("anchorKey", () => {
  it("keeps the two kinds apart for the same id", () => {
    expect(anchorKey(NOTE_A)).not.toBe(anchorKey(CARD_A))
  })
})

describe("pairKey", () => {
  it("is the same in either direction", () => {
    expect(pairKey(NOTE_A, NOTE_B)).toBe(pairKey(NOTE_B, NOTE_A))
  })
})

describe("readCanvasConnections", () => {
  it("returns nothing for absent or unparseable storage", () => {
    expect(readCanvasConnections(null)).toEqual([])
    expect(readCanvasConnections("nope")).toEqual([])
    expect(readCanvasConnections('{"not":"an array"}')).toEqual([])
  })

  it("drops entries missing an id or a usable endpoint", () => {
    expect(
      readCanvasConnections(
        JSON.stringify([
          { from: NOTE_A, to: NOTE_B },
          { id: "e", from: { kind: "ghost", id: "x" }, to: NOTE_B },
          { id: "e", from: NOTE_A, to: { id: "b" } },
          null,
        ])
      )
    ).toEqual([])
  })

  it("drops self links and duplicates in either direction", () => {
    const restored = readCanvasConnections(
      JSON.stringify([
        edge(),
        edge({ id: "e2", from: NOTE_B, to: NOTE_A }),
        edge({ id: "e3", from: NOTE_A, to: NOTE_A }),
      ])
    )
    expect(restored).toEqual([edge()])
  })
})

describe("addConnection", () => {
  it("appends an edge between two different items", () => {
    expect(addConnection([], NOTE_A, CARD_A, "e1")).toEqual([
      { id: "e1", from: NOTE_A, to: CARD_A },
    ])
  })

  it("refuses a self link", () => {
    expect(addConnection([], NOTE_A, { kind: "note", id: "a" }, "e1")).toEqual(
      []
    )
  })

  it("refuses a pair that is already joined, whichever way round", () => {
    const existing = [edge()]
    expect(addConnection(existing, NOTE_B, NOTE_A, "e2")).toEqual(existing)
  })
})

describe("removeConnection", () => {
  it("drops the edge with that id", () => {
    expect(removeConnection([edge(), edge({ id: "e2" })], "e1")).toEqual([
      edge({ id: "e2" }),
    ])
  })
})

describe("removeAnchor", () => {
  it("drops every edge touching the item, from either end", () => {
    const edges = [
      edge(),
      edge({ id: "e2", from: CARD_A, to: NOTE_A }),
      edge({ id: "e3", from: NOTE_B, to: CARD_A }),
    ]
    expect(removeAnchor(edges, NOTE_A)).toEqual([
      edge({ id: "e3", from: NOTE_B, to: CARD_A }),
    ])
  })

  it("tells the two kinds apart, so a card leaves a note's edges alone", () => {
    const edges = [edge({ id: "e2", from: NOTE_A, to: NOTE_B })]
    expect(removeAnchor(edges, CARD_A)).toEqual(edges)
  })
})

describe("itemAt", () => {
  const card: CanvasItemRect = { ...LEFT, kind: "card", id: "c" }
  const note: CanvasItemRect = {
    x: 20,
    y: 20,
    width: 40,
    height: 40,
    kind: "note",
    id: "n",
  }

  it("finds nothing in empty canvas", () => {
    expect(itemAt([card], { x: 300, y: 300 })).toBeNull()
  })

  it("counts the border as inside", () => {
    expect(itemAt([card], { x: 100, y: 100 })).toBe(card)
  })

  it("prefers the note where a note sits over a card", () => {
    expect(itemAt([card, note], { x: 30, y: 30 })).toBe(note)
    expect(itemAt([note, card], { x: 30, y: 30 })).toBe(note)
    expect(itemAt([card, note], { x: 90, y: 90 })).toBe(card)
  })
})

describe("sidePoint", () => {
  it("leaves through the side that faces the target", () => {
    expect(sidePoint(LEFT, { x: 900, y: 50 })).toMatchObject({
      point: { x: 100, y: 50 },
      axis: "x",
      sign: 1,
    })
    expect(sidePoint(LEFT, { x: 50, y: 900 })).toMatchObject({
      point: { x: 50, y: 100 },
      axis: "y",
      sign: 1,
    })
    expect(sidePoint(LEFT, { x: -900, y: 50 })).toMatchObject({
      point: { x: 0, y: 50 },
      sign: -1,
    })
  })

  it("weighs the sides by the shape, not by the angle alone", () => {
    // The same direction leaves a square sideways but a wide, flat box
    // through its long edge, which is the side the ray truly crosses first.
    const square: CanvasRect = { x: 0, y: 0, width: 100, height: 100 }
    const wide: CanvasRect = { x: 0, y: 0, width: 600, height: 60 }
    expect(sidePoint(square, { x: 150, y: 110 }).axis).toBe("x")
    expect(sidePoint(wide, { x: 400, y: 90 }).axis).toBe("y")
  })
})

describe("connectionGeometry", () => {
  it("runs from one facing side to the other", () => {
    const geometry = connectionGeometry("e1", LEFT, RIGHT)
    expect(geometry.path.startsWith("M 100 50 C")).toBe(true)
    expect(geometry.path.endsWith("400 50")).toBe(true)
    expect(geometry.head).toEqual({ x: 400, y: 50 })
  })

  it("points the arrow head along the curve", () => {
    expect(connectionGeometry("e1", LEFT, RIGHT).headAngle).toBeCloseTo(0, 5)
    // The target sits below, so the curve arrives travelling upward.
    expect(connectionGeometry("e1", LEFT, BELOW).headAngle).toBeCloseTo(90, 5)
  })

  it("puts the midpoint halfway between two level items", () => {
    const geometry = connectionGeometry("e1", LEFT, RIGHT)
    expect(geometry.mid.x).toBeCloseTo(250, 5)
    expect(geometry.mid.y).toBeCloseTo(50, 5)
  })
})

describe("cubicAt", () => {
  it("returns the ends at t 0 and 1", () => {
    const p = { x: 0, y: 0 }
    const q = { x: 10, y: 10 }
    expect(cubicAt(p, p, q, q, 0)).toEqual(p)
    expect(cubicAt(p, p, q, q, 1)).toEqual(q)
  })
})

describe("connectionGeometries", () => {
  const items = new Map<string, CanvasItemRect>([
    [anchorKey(NOTE_A), { ...LEFT, ...NOTE_A }],
    [anchorKey(NOTE_B), { ...RIGHT, ...NOTE_B }],
  ])

  it("skips an edge whose item has left the board", () => {
    const edges = [edge(), edge({ id: "e2", from: NOTE_A, to: CARD_A })]
    expect(connectionGeometries(edges, items).map((one) => one.id)).toEqual([
      "e1",
    ])
  })
})
