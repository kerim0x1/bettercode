import { describe, expect, it } from "vitest"
import {
  buildDebugRgSearchOutput,
  withSearchTruncationNote,
} from "@/lib/chat-commands/runtime-commands"
import { buildFindTextOutput } from "@/lib/chat-commands/vcs-commands"
import type { WorkspaceContentSearchResult } from "@/services/backend/workspaceApi"

const hit: WorkspaceContentSearchResult = {
  path: "src/app.ts",
  name: "app.ts",
  matches: [
    {
      line: 10,
      column: 3,
      length: 7,
      previewColumn: 3,
      previewLength: 7,
      preview: "const useChat = true",
    },
  ],
}

// Slash-command search output is markdown the user reads in the transcript.
// A capped `/find` or `/debug-rg` that lists 80 rows and stops looks exactly
// like a complete one unless the builder says otherwise.
describe("slash-command search output truncation", () => {
  it("appends nothing for a complete search", () => {
    expect(withSearchTruncationNote("body", undefined, "hint")).toBe("body")
    expect(withSearchTruncationNote("body", { truncated: false }, "hint")).toBe(
      "body"
    )
    expect(buildFindTextOutput("/repo", "useChat", [hit])).not.toContain(
      "cut short"
    )
    expect(
      buildDebugRgSearchOutput("/repo", "useChat", [hit], [], {
        truncated: false,
        truncatedReason: "limit",
      })
    ).not.toContain("cut short")
  })

  it("ends a cut-short search with a blockquote after a blank line", () => {
    // The blank line keeps the note out of the preceding markdown table.
    expect(
      withSearchTruncationNote(
        "| a |",
        { truncated: true, truncatedReason: "limit" },
        "narrow the query"
      )
    ).toBe("| a |\n\n> Results cut short (match cap) — narrow the query")
  })

  it("tells the user in both find.text and debug-rg output", () => {
    const find = buildFindTextOutput("/repo", "useChat", [hit], {
      truncated: true,
      truncatedReason: "deadline",
    })
    expect(find).toContain("src/app.ts:10:3")
    expect(find.trimEnd().split("\n").at(-1)).toBe(
      "> Results cut short (time limit) — narrow the query to see the rest"
    )

    const rg = buildDebugRgSearchOutput("/repo", "useChat", [hit], ["*.ts"], {
      truncated: true,
      truncatedReason: "bytes",
    })
    expect(rg).toContain("src/app.ts:10:3")
    expect(rg.trimEnd().split("\n").at(-1)).toBe(
      "> Results cut short (size cap) — narrow the pattern or add a glob to see the rest"
    )
  })

  // A deadline can fire before the first match. "No matches" from such a
  // scan is not an answer, and the note has to make that visible.
  it("qualifies an empty result that came from a cut-short scan", () => {
    const output = buildFindTextOutput("/repo", "useChat", [], {
      truncated: true,
      truncatedReason: "deadline",
    })
    expect(output).toContain("> No text matches found.")
    expect(output).toContain("> Results cut short (time limit)")
  })
})
