import { describe, expect, it } from "vitest"
import {
  MAX_CONSOLE_ENTRIES_PER_MESSAGE,
  MAX_CONSOLE_MESSAGE_LENGTH,
  parseCanvasKeydown,
  parseConsoleEntries,
  parseDomTree,
  parsePreviewPageMessage,
  parseSelectedElement,
  readIframeEnvelope,
} from "./preview-messages"

const at = new Date(0)

const element = {
  selector: "#buy",
  tagName: "button",
  id: "buy",
  className: "primary",
  text: "Buy",
  label: "Buy now",
  url: "http://localhost:5173/",
  childCount: 0,
  styles: { color: "red", "font-size": "12px" },
  rect: { x: 1, y: 2, w: 60, h: 24 },
  viewport: { width: 1440, height: 900 },
}

describe("preview page messages", () => {
  it("accepts an element snapshot from the inspector script", () => {
    expect(parseSelectedElement(element)).toEqual(element)
  })

  it("rejects elements without a selector, tag or finite geometry", () => {
    expect(parseSelectedElement(null)).toBeNull()
    expect(parseSelectedElement("button")).toBeNull()
    expect(parseSelectedElement({ ...element, selector: 5 })).toBeNull()
    expect(parseSelectedElement({ ...element, tagName: "" })).toBeNull()
    expect(
      parseSelectedElement({ ...element, rect: { x: 0, y: 0, w: "1", h: 2 } })
    ).toBeNull()
    expect(
      parseSelectedElement({
        ...element,
        rect: { ...element.rect, x: Infinity },
      })
    ).toBeNull()
    expect(
      parseSelectedElement({ ...element, viewport: { width: 0, height: 10 } })
    ).toBeNull()
  })

  it("fills safe defaults and drops non-string styles", () => {
    const parsed = parseSelectedElement({
      selector: "div",
      tagName: "div",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      label: 42,
      styles: { color: "blue", width: 10, nested: { a: 1 } },
      childCount: -3,
    })
    expect(parsed).toEqual({
      selector: "div",
      tagName: "div",
      id: "",
      className: "",
      text: "",
      childCount: 0,
      styles: { color: "blue" },
      rect: { x: 0, y: 0, w: 1, h: 1 },
    })
    expect(
      parseSelectedElement({ ...element, styles: ["color"] })?.styles
    ).toEqual({})
    expect(
      parseSelectedElement({ ...element, text: "x".repeat(10_000) })?.text
    ).toHaveLength(4_000)
  })

  it("coerces console lines to strings and caps a batch", () => {
    expect(
      parseConsoleEntries("console", { level: "warn", message: 42 }, at)
    ).toEqual([{ level: "warn", message: "42", timestamp: at }])
    expect(
      parseConsoleEntries("console", { level: "debug", message: "x" }, at)[0]
        .level
    ).toBe("log")
    expect(parseConsoleEntries("console", "boom", at)).toEqual([])

    expect(
      parseConsoleEntries("console-batch", { entries: "nope" }, at)
    ).toEqual([])
    expect(parseConsoleEntries("console-batch", { entries: {} }, at)).toEqual(
      []
    )
    expect(parseConsoleEntries("console-batch", null, at)).toEqual([])

    const batch = parseConsoleEntries(
      "console-batch",
      {
        entries: [
          { level: "error", message: "y".repeat(10_000) },
          null,
          ...Array.from({ length: 500 }, () => ({
            level: "log",
            message: "z",
          })),
        ],
      },
      at
    )
    expect(batch).toHaveLength(MAX_CONSOLE_ENTRIES_PER_MESSAGE - 1)
    expect(batch[0].message).toHaveLength(MAX_CONSOLE_MESSAGE_LENGTH)
    expect(batch[0].level).toBe("error")
  })

  it("keeps valid DOM tree nodes and drops malformed subtrees", () => {
    const tree = parseDomTree({
      tree: {
        tag: "body",
        id: "",
        classes: ["a", 3, "b"],
        selector: "body",
        text: "",
        children: [
          {
            tag: "main",
            id: "m",
            classes: [],
            selector: "#m",
            text: "Hi",
            children: [],
          },
          { tag: 7, selector: "bad", children: [] },
          "text",
        ],
      },
    })
    expect(tree).toEqual({
      tag: "body",
      id: "",
      classes: ["a", "b"],
      selector: "body",
      text: "",
      children: [
        {
          tag: "main",
          id: "m",
          classes: [],
          selector: "#m",
          text: "Hi",
          children: [],
        },
      ],
    })
    expect(parseDomTree({ tree: null })).toBeNull()
    expect(parseDomTree({ tree: { tag: "body" } })).toBeNull()
    expect(parseDomTree("tree")).toBeNull()
  })

  it("caps how deep a DOM tree may go", () => {
    let node: Record<string, unknown> = {
      tag: "span",
      selector: "span",
      children: [],
    }
    for (let depth = 0; depth < 100; depth += 1)
      node = { tag: "div", selector: "div", children: [node] }
    let tree = parseDomTree({ tree: node })
    let depth = 0
    while (tree?.children[0]) {
      tree = tree.children[0]
      depth += 1
    }
    expect(depth).toBeLessThan(20)
  })

  it("maps modifier keydowns to canvas gestures only when the flags agree", () => {
    expect(parseCanvasKeydown({ key: "Control", ctrlKey: true })).toBe(
      "canvas-zoom-start"
    )
    expect(parseCanvasKeydown({ key: "Meta", metaKey: true })).toBe(
      "canvas-zoom-start"
    )
    expect(parseCanvasKeydown({ key: "Alt", altKey: true })).toBe(
      "canvas-pan-start"
    )
    expect(
      parseCanvasKeydown({ key: "Alt", altKey: true, ctrlKey: true })
    ).toBeNull()
    expect(parseCanvasKeydown({ key: "Control", ctrlKey: "yes" })).toBeNull()
    expect(parseCanvasKeydown(undefined)).toBeNull()
  })

  it("dispatches by channel and drops what does not parse", () => {
    expect(parsePreviewPageMessage("bc-element-selected", element, at)).toEqual(
      {
        kind: "element-selected",
        element,
      }
    )
    expect(
      parsePreviewPageMessage("element-selected", { selector: 1 }, at)
    ).toBeNull()
    expect(
      parsePreviewPageMessage("console-batch", { entries: [] }, at)
    ).toBeNull()
    expect(parsePreviewPageMessage("dom-tree", { tree: null }, at)).toEqual({
      kind: "dom-tree",
      tree: null,
    })
    expect(parsePreviewPageMessage("dom-tree", 5, at)).toBeNull()
    expect(
      parsePreviewPageMessage("did-keydown", { key: "Alt", altKey: true }, at)
    ).toEqual({ kind: "shortcut", shortcut: "canvas-pan-start" })
    expect(parsePreviewPageMessage("bc-unknown", {}, at)).toBeNull()
  })

  it("reads only bc-* envelopes posted by an iframe page", () => {
    expect(readIframeEnvelope({ type: "bc-console", data: { a: 1 } })).toEqual({
      type: "bc-console",
      data: { a: 1 },
    })
    const bare = { type: "bc-console", level: "log", message: "x" }
    expect(readIframeEnvelope(bare)).toEqual({ type: "bc-console", data: bare })
    expect(readIframeEnvelope({ type: 5 })).toBeNull()
    expect(readIframeEnvelope({ type: "other" })).toBeNull()
    expect(readIframeEnvelope("bc-console")).toBeNull()
    expect(readIframeEnvelope(null)).toBeNull()
  })
})
