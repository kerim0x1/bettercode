import { describe, expect, it } from "vitest"
import { emphasizeListLeadIns } from "./markdown-lead-ins"

describe("emphasizeListLeadIns", () => {
  it("bolds a short line that introduces a list", () => {
    expect(
      emphasizeListLeadIns(
        "Done.\n\nZum Stand der Umgebung:\n- Kein Projekt\n- Kein Repo\n"
      )
    ).toBe(
      "Done.\n\n**Zum Stand der Umgebung:**\n- Kein Projekt\n- Kein Repo\n"
    )
    expect(emphasizeListLeadIns("Steps:\n\n1. Build\n2. Ship")).toBe(
      "**Steps:**\n\n1. Build\n2. Ship"
    )
  })

  it("leaves sentences, other blocks and code alone", () => {
    const unchanged = [
      // Not followed by a list.
      "Note:\nThe app restarted.",
      // A long sentence, not a title.
      "This is a much longer sentence that explains a lot of things before it finally ends:\n- one",
      // Part of a paragraph.
      "First line\nthen this:\n- one",
      // Already bold, a heading, a list item, or inside a fence.
      "**Status:**\n- one",
      "## Status:\n- one",
      "- Parent:\n  - child",
      "```\nconfig:\n- value\n```",
    ]
    for (const markdown of unchanged) {
      expect(emphasizeListLeadIns(markdown)).toBe(markdown)
    }
  })
})
