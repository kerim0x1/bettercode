import { describe, expect, it } from "vitest"
import { EDITABLE_SELECTOR, isEditingInside } from "./use-canvas-transform"

/**
 * No jsdom in this project, so the two DOM calls the rule makes are stubbed.
 * What is worth pinning down is the rule itself: the caret has to be in a
 * field *and* that field has to be on the canvas.
 */
function element(selectors: string, inside: boolean) {
  return {
    matches: (query: string) =>
      query === EDITABLE_SELECTOR && selectors === "editable",
    _inside: inside,
  } as unknown as Element
}
const viewport = {
  contains: (node: Element | null) =>
    Boolean(node && (node as unknown as { _inside: boolean })._inside),
} as unknown as Element

describe("isEditingInside", () => {
  it("is true for a text field on the canvas", () => {
    expect(isEditingInside(viewport, element("editable", true))).toBe(true)
  })

  it("is false for the canvas itself, so Ctrl still arms the zoom shield", () => {
    expect(isEditingInside(viewport, element("plain", true))).toBe(false)
  })

  it("is false for a text field somewhere else in the app", () => {
    expect(isEditingInside(viewport, element("editable", false))).toBe(false)
  })

  it("is false when there is no viewport or nothing focused", () => {
    expect(isEditingInside(null, element("editable", true))).toBe(false)
    expect(isEditingInside(viewport, null)).toBe(false)
  })
})
