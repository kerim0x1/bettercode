import { describe, expect, it } from "vitest"
import { rehypeFigures, splitFigures } from "./rehype-figures"

function figuresIn(value: string): string[] {
  return (splitFigures(value) ?? []).flatMap((node) =>
    node.type === "element" && "children" in node
      ? (node.children ?? []).map((child) => (child as { value: string }).value)
      : []
  )
}

describe("splitFigures", () => {
  it("finds numbers with their unit, sign or separators", () => {
    expect(
      figuresIn(
        "Took 3.6s for 47.4k rows, $25.9k, 85 %, 16px at 23:54 on 2026-11-17 (#72)."
      )
    ).toEqual([
      "3.6s",
      "47.4k",
      "$25.9k",
      "85 %",
      "16px",
      "23:54",
      "2026-11-17",
      "72",
    ])
  })

  it("leaves digits inside words, versions, paths and hashes alone", () => {
    for (const text of [
      "x86_64",
      "file2.ts",
      "v1.2.3",
      "src/2024/a",
      "3f9a2c1",
    ]) {
      expect(splitFigures(text)).toBeNull()
    }
    expect(splitFigures("no numbers here")).toBeNull()
  })

  it("keeps the text around a figure", () => {
    expect(splitFigures("in 5 Minuten")).toEqual([
      { type: "text", value: "in " },
      {
        type: "element",
        tagName: "span",
        properties: { className: ["response-figure"] },
        children: [{ type: "text", value: "5" }],
      },
      { type: "text", value: " Minuten" },
    ])
  })
})

describe("rehypeFigures", () => {
  it("skips code, links, bold text and tables", () => {
    const text = (value: string) => ({ type: "text", value })
    const element = (tagName: string, children: unknown[]) => ({
      type: "element",
      tagName,
      properties: {},
      children,
    })
    const tree = {
      type: "root",
      children: [
        element("p", [
          text("Port 3773 "),
          element("code", [text("npm run 2")]),
          element("strong", [text("12 files")]),
          element("a", [text("PR 72")]),
        ]),
        element("table", [element("tr", [element("td", [text("42")])])]),
      ],
    }
    rehypeFigures()(tree)
    const paragraph = tree.children[0]!.children
    expect(paragraph[0]).toEqual(text("Port "))
    expect(paragraph[1]).toMatchObject({
      tagName: "span",
      children: [text("3773")],
    })
    expect(paragraph.slice(3)).toEqual([
      element("code", [text("npm run 2")]),
      element("strong", [text("12 files")]),
      element("a", [text("PR 72")]),
    ])
    expect(tree.children[1]).toEqual(
      element("table", [element("tr", [element("td", [text("42")])])])
    )
  })
})
