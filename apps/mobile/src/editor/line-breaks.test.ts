import { EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"
import { joinedLength, lineBreakOf } from "./line-breaks"

/** A text as the editor's page hands it back after loading it. */
function throughTheEditor(text: string): string {
  const doc = EditorState.create({ doc: text }).doc
  return doc.sliceString(0, doc.length, lineBreakOf(text))
}

describe("line breaks in the editor", () => {
  it("are the file's own, so an untouched file comes back byte for byte", () => {
    for (const text of [
      "",
      "one line",
      "a\nb\n",
      "a\n\n\nb",
      "a\r\nb\r\n",
      "a\r\n\r\nb\r\n",
      "﻿first\r\nsecond",
      "trailing space \r\n\tand a tab\r\n",
    ]) {
      expect(throughTheEditor(text), JSON.stringify(text)).toBe(text)
    }
  })

  it("become the most common one in a file that mixes them, as on the desktop", () => {
    expect(lineBreakOf("a\r\nb\r\nc\nd")).toBe("\r\n")
    expect(throughTheEditor("a\r\nb\r\nc\nd")).toBe("a\r\nb\r\nc\r\nd")
    expect(lineBreakOf("a\r\nb\nc\nd")).toBe("\n")
    expect(throughTheEditor("a\r\nb\nc\nd")).toBe("a\nb\nc\nd")
    // Half is not more than half.
    expect(lineBreakOf("a\r\nb\n")).toBe("\n")
    // A lone CR counts as one with a CR, as Monaco counts it.
    expect(throughTheEditor("a\rb\rc\nd")).toBe("a\r\nb\r\nc\r\nd")
  })

  it("are counted in the text's length without joining it", () => {
    for (const text of ["", "x", "a\nb\n", "a\r\nb\r\nc", "a\r\n\r\n"]) {
      const doc = EditorState.create({ doc: text }).doc
      expect(joinedLength(doc, lineBreakOf(text)), JSON.stringify(text)).toBe(
        text.length
      )
    }
  })
})
