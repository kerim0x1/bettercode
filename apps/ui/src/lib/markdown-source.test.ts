import { describe, expect, it } from "vitest"
import {
  hasMarkdownSource,
  MARKDOWN_SOURCE as MD,
  MARKDOWN_SOURCE_LIMIT,
  markdownSourceRuns,
} from "./markdown-source"

/** Each run as `text:flagNames`, so failures read like the source. */
function described(source: string) {
  const names = Object.entries(MD)
  return markdownSourceRuns(source).map((run) => {
    const flags = names
      .filter(([, flag]) => run.flags & flag)
      .map(([name]) => name)
      .join("+")
    return `${source.slice(run.start, run.end)}:${flags || "plain"}`
  })
}

describe("markdownSourceRuns", () => {
  it("covers every character exactly once", () => {
    const source =
      "# Title\n- **bold `code`** and _em_ ~~gone~~\n> quote\n```ts\nconst a = 1\n```\n"
    const runs = markdownSourceRuns(source)
    expect(runs[0].start).toBe(0)
    expect(runs.at(-1)?.end).toBe(source.length)
    for (let index = 1; index < runs.length; index++)
      expect(runs[index].start).toBe(runs[index - 1].end)
    expect(runs.map((run) => source.slice(run.start, run.end)).join("")).toBe(
      source
    )
  })

  it("styles pasted assistant text: bullets, bold and code inside bold", () => {
    expect(
      described("- **`obsidian` and `paper` failed** (ECONNREFUSED)")
    ).toEqual([
      "-:bullet",
      " :plain",
      "**:marker",
      "`:marker+strong+code",
      "obsidian:strong+code",
      "`:marker+strong+code",
      " and :strong",
      "`:marker+strong+code",
      "paper:strong+code",
      "`:marker+strong+code",
      " failed:strong",
      "**:marker",
      " (ECONNREFUSED):plain",
    ])
  })

  it("nests strong and emphasis and keeps snake_case plain", () => {
    expect(described("***both***")).toEqual([
      "**:marker",
      "*:marker+strong",
      "both:strong+em",
      "**:marker+em",
      "*:marker",
    ])
    expect(described("snake_case and _em_")).toEqual([
      "snake_case and :plain",
      "_:marker",
      "em:em",
      "_:marker",
    ])
    expect(hasMarkdownSource(markdownSourceRuns("2 * 3 * 4"))).toBe(false)
  })

  it("keeps escapes, Windows paths and code contents literal", () => {
    expect(
      hasMarkdownSource(markdownSourceRuns(String.raw`C:\_temp\*x* and \*no\*`))
    ).toBe(false)
    expect(described("`" + String.raw`C:\a\*b*` + "`")).toEqual([
      "`:marker+code",
      String.raw`C:\a\*b*:code`,
      "`:marker+code",
    ])
  })

  it("marks links and bare URLs without emphasis inside them", () => {
    expect(
      described("[docs](https://x.dev/a_b_c) or https://x.dev/a_b_c.")
    ).toEqual([
      "[:linkTarget",
      "docs:link",
      "](https://x.dev/a_b_c):linkTarget",
      " or :plain",
      "https://x.dev/a_b_c:link",
      ".:plain",
    ])
  })

  it("flags block syntax line by line", () => {
    expect(
      described(
        "# Title\n> quoted\n1. first\n---\n```ts\nlet a = `x`\n```\nafter"
      )
    ).toEqual([
      "# :marker",
      "Title:heading",
      "\n:plain",
      "> :quoteMark",
      "quoted:quote",
      "\n:plain",
      "1.:listNumber",
      " first\n:plain",
      "---:rule",
      "\n:plain",
      "```ts:fence",
      "\n:plain",
      "let a = `x`:codeBlock",
      "\n:plain",
      "```:fence",
      "\nafter:plain",
    ])
  })

  it("does not carry an unclosed delimiter past its line", () => {
    expect(hasMarkdownSource(markdownSourceRuns("**open\nclosed**"))).toBe(
      false
    )
  })

  it("leaves very long text unstyled", () => {
    const source = "**bold** ".repeat(MARKDOWN_SOURCE_LIMIT)
    expect(markdownSourceRuns(source)).toEqual([
      { start: 0, end: source.length, flags: 0 },
    ])
  })
})
