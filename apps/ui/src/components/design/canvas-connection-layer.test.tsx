import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import {
  anchorKey,
  connectionGeometries,
  type CanvasConnection,
  type CanvasItemRect,
} from "@/lib/canvas-connections"
import type { ConnectDraft } from "@/hooks/use-canvas-connect-drag"
import { CanvasConnectionLayer } from "./canvas-connection-layer"

const NOTE: CanvasItemRect = {
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  kind: "note",
  id: "n1",
}
const CARD: CanvasItemRect = {
  x: 400,
  y: 0,
  width: 200,
  height: 200,
  kind: "card",
  id: "t1",
}
const items = new Map([
  [anchorKey(NOTE), NOTE],
  [anchorKey(CARD), CARD],
])
const EDGE: CanvasConnection = {
  id: "e1",
  from: { kind: "note", id: "n1" },
  to: { kind: "card", id: "t1" },
}

function render(
  overrides: Partial<Parameters<typeof CanvasConnectionLayer>[0]> = {}
) {
  return renderToStaticMarkup(
    <CanvasConnectionLayer
      geometries={connectionGeometries([EDGE], items)}
      tethers={[]}
      items={items}
      hovered={null}
      selected={null}
      draft={null}
      onBeginConnect={vi.fn()}
      onRemove={vi.fn()}
      {...overrides}
    />
  )
}

describe("CanvasConnectionLayer", () => {
  it("draws a curve and an arrow head per edge", () => {
    const html = render()
    // Out of the note's right side, into the card's left side.
    expect(html).toContain("M 100 50 C")
    expect(html).toContain("translate(400 100) rotate(")
  })

  it("offers a way to cut each edge", () => {
    expect(render()).toContain('aria-label="Remove connection"')
  })

  it("keeps the handles hidden until an item is hovered", () => {
    expect(render()).not.toContain("data-connect-handle")
    const hovered = render({ hovered: anchorKey(NOTE) })
    expect([...hovered.matchAll(/data-connect-handle="note:n1"/g)].length).toBe(
      4
    )
    expect(hovered).not.toContain('data-connect-handle="card:t1"')
  })

  it("keeps the handles out on the selected item, hover or not", () => {
    // An embedded page is mostly guest, and a guest's pointer events never
    // reach this window, so selection has to work as well as hover.
    const html = render({ selected: anchorKey(CARD) })
    expect(html).toContain('data-connect-handle="card:t1"')
    expect(html).not.toContain('data-connect-handle="note:n1"')
  })

  it("shows every other item's handles while a wire is in flight", () => {
    const draft: ConnectDraft = {
      from: { kind: "note", id: "n1" },
      point: { x: 250, y: 60 },
      over: null,
    }
    const html = render({ draft })
    expect(html).toContain('data-connect-handle="card:t1"')
    expect(html).not.toContain('data-connect-handle="note:n1"')
    // The cut buttons stand down so they cannot steal the drop.
    expect(html).not.toContain('aria-label="Remove connection"')
  })

  it("rings the item the wire would land on", () => {
    const draft: ConnectDraft = {
      from: { kind: "note", id: "n1" },
      point: { x: 450, y: 60 },
      over: { kind: "card", id: "t1" },
    }
    expect(render({ draft })).toContain("ring-primary/70")
  })

  it("draws a pin tether dashed, apart from the drawn edges", () => {
    const html = render({
      geometries: [],
      tethers: [{ id: "n1", x1: 0, y1: 0, x2: 10, y2: 10 }],
    })
    expect(html).toContain('stroke-dasharray="6 7"')
  })
})
