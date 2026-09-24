import { beforeAll, describe, expect, it } from "vitest"
import { diffChangedRanges, diffLanguage, highlightDiff } from "./diff-syntax"
import { parseGitDiff } from "./git-diff"

function patch(name: string, lines: string) {
  return parseGitDiff(
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,3 +1,3 @@\n${lines}\n`
  )[0]!
}

const PALETTE_CASES = [
  ["next-env.d.ts", 'import "./.next/dev/types/routes.d.ts";'],
  ["main.js", "const count = 42;"],
  ["data.json", '{ "enabled": true, "count": 42 }'],
  ["index.html", '<main class="page">Hello</main>'],
] as const

describe("diff syntax", () => {
  // Shiki stops colouring a line after 500 ms (`tokenizeTimeLimit`), and the
  // first line in a grammar also pays for compiling that grammar's rules. On
  // a loaded CI runner that can take longer than the limit, and the line
  // comes back in one colour. The app accepts that on a slow first diff; the
  // colour checks below are about the colours, so each grammar is compiled
  // here first.
  beforeAll(async () => {
    for (const [name, code] of PALETTE_CASES) {
      await highlightDiff(patch(name, `-${code}\n+${code}`))
    }
  })

  it.each([
    ["C:\\project\\App.TSX", "tsx"],
    ["src/test.mjs", "javascript"],
    ["settings.json", "json"],
    ["index.html", "html"],
    ["Dockerfile", "dockerfile"],
    ["README.unknown", null],
  ])(
    "recognizes %s without treating an unknown file as code",
    (name, language) => {
      expect(diffLanguage(name)).toBe(language)
    }
  )

  it.each(PALETTE_CASES)(
    "preserves %s source and supplies both theme palettes",
    async (name, code) => {
      const file = patch(name, `-${code}\n+${code}`)
      const syntax = await highlightDiff(file)
      for (const side of ["old", "new"] as const) {
        const tokens = [...syntax[side].values()][0]!
        expect(tokens.map((token) => token.content).join("")).toBe(code)
        expect(
          new Set(tokens.map((token) => token.htmlStyle?.color)).size
        ).toBeGreaterThan(1)
        expect(tokens.every((token) => token.htmlStyle?.["--shiki-dark"])).toBe(
          true
        )
      }
    }
  )

  it("isolates old/new multiline grammar and resets it between disjoint hunks", async () => {
    const file = patch(
      "app.ts",
      "-/* open comment\n+const enabled = true\n const value = 1\n@@ -30 +30 @@\n-const end = false\n+const end = true"
    )
    const syntax = await highlightDiff(file)
    const context = file.hunks[0]!.lines.find(
      (line) => line.type === "context"
    )!
    const colors = (side: "old" | "new", line = context) =>
      new Set(syntax[side].get(line)!.map((token) => token.htmlStyle?.color))
    expect(colors("old").size).toBe(1)
    expect(colors("new").size).toBeGreaterThan(1)
    expect(colors("old", file.hunks[1]!.lines[0]!).size).toBeGreaterThan(1)
  })

  it("leaves unknown, binary, and oversized files readable without loading tokens", async () => {
    const file = patch("app.ts", "-const a = 1\n+const a = 2")
    for (const skipped of [
      { ...file, name: "plain.unknown" },
      { ...file, isBinary: true },
      { ...file, rawText: "x".repeat(100_001) },
      { ...file, lines: Array(2001).fill(file.lines[0]) },
      patch("app.ts", `+${"x".repeat(5001)}`),
    ]) {
      const syntax = await highlightDiff(skipped)
      expect(syntax.old.size + syntax.new.size).toBe(0)
      expect(skipped.rawText).not.toBe("")
    }
  })
})

describe("changed words", () => {
  it("marks just the inserted path segment from next-env.d.ts", () => {
    const file = patch(
      "next-env.d.ts",
      '-import "./.next/types/routes.d.ts";\n+import "./.next/dev/types/routes.d.ts";'
    )
    const [removed, added] = file.hunks[0]!.lines
    const ranges = diffChangedRanges(file.hunks[0]!.lines)
    expect(ranges.get(removed!)).toEqual({ start: 16, end: 16 })
    const range = ranges.get(added!)!
    expect(added!.content.slice(range.start, range.end)).toBe("dev/")
  })

  it("does not split emoji surrogate pairs or mark unchanged context", () => {
    const file = patch(
      "app.ts",
      ' const context = true\n-const icon = "😀";\n+const icon = "😁";'
    )
    const ranges = diffChangedRanges(file.hunks[0]!.lines)
    expect(ranges.size).toBe(2)
    for (const [line, range] of ranges) {
      expect(line.content.slice(range.start, range.end)).toBe(
        line.type === "add" ? "😁" : "😀"
      )
    }
  })

  it("does not invent paired word changes for added-only lines", () => {
    const file = patch("app.ts", "+const added = true")
    expect(diffChangedRanges(file.hunks[0]!.lines).size).toBe(0)
  })
})
