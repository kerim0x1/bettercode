import { describe, expect, it } from "vitest"
import {
  DEFAULT_MONACO_FONT_FAMILY,
  computeLineDiff,
  resolveMonacoFontFamily,
} from "./editor-helpers"

describe("computeLineDiff", () => {
  it("marks kept, added and removed lines against the new text", () => {
    expect(computeLineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { type: "same", newLine: 1 },
      { type: "remove", beforeNewLine: 2, text: "b" },
      { type: "add", newLine: 2 },
      { type: "same", newLine: 3 },
    ])
  })

  it("falls back to an unchanged diff for pathologically large inputs", () => {
    const text = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join("\n")
    const changed = text.replace("line 0", "changed")
    const ops = computeLineDiff(text, changed)
    expect(ops).toHaveLength(1500)
    expect(ops.every((op) => op.type === "same")).toBe(true)
  })
})

describe("resolveMonacoFontFamily", () => {
  it("puts the chosen font first and keeps the default stack as fallback", () => {
    expect(resolveMonacoFontFamily("  ")).toBe(DEFAULT_MONACO_FONT_FAMILY)
    expect(resolveMonacoFontFamily("Iosevka")).toBe(
      `'Iosevka', ${DEFAULT_MONACO_FONT_FAMILY}`
    )
    expect(resolveMonacoFontFamily("O'Font")).toBe(
      `'O\\'Font', ${DEFAULT_MONACO_FONT_FAMILY}`
    )
  })
})
