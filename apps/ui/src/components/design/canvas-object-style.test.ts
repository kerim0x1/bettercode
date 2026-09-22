import { describe, expect, it } from "vitest"
import {
  ALIGN_CLASS,
  FILL_SURFACE,
  KEEPS_SELECTION,
  SOLID,
  TEXT_COLOR,
  TEXT_SIZE_CLASS,
} from "./canvas-object-style"
import { OBJECT_COLORS, TEXT_ALIGNS, TEXT_SIZES } from "@/lib/canvas-objects"

describe("KEEPS_SELECTION", () => {
  it("covers the board's own furniture", () => {
    for (const hook of [
      "[data-canvas-object]",
      "[data-canvas-format-bar]",
      "[data-connect-handle]",
    ])
      expect(KEEPS_SELECTION).toContain(hook)
  })

  it("covers the format bar's portalled menus", () => {
    // Radix renders these under <body>, out of reach of `closest`. Without
    // them a press on "Center" or a colour deselects the object and the bar
    // unmounts before the choice lands.
    expect(KEEPS_SELECTION).toContain("[data-radix-popper-content-wrapper]")
    expect(KEEPS_SELECTION).toContain("[role=menu]")
  })
})

describe("style tables", () => {
  it("has a class for every value the model allows", () => {
    for (const color of OBJECT_COLORS) {
      expect(TEXT_COLOR[color], color).toBeTruthy()
      expect(FILL_SURFACE[color], color).toBeTruthy()
      expect(SOLID[color], color).toBeTruthy()
    }
    for (const size of TEXT_SIZES)
      expect(TEXT_SIZE_CLASS[size], size).toBeTruthy()
    for (const align of TEXT_ALIGNS)
      expect(ALIGN_CLASS[align], align).toBeTruthy()
  })

  it("writes each class out in full, so Tailwind can see it", () => {
    // A template like `text-${color}-300` produces no stylesheet at all.
    for (const value of [...Object.values(TEXT_COLOR), ...Object.values(SOLID)])
      expect(value).not.toContain("${")
  })
})
