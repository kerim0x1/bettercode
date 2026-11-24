/**
 * Figures in a reply (3.6s, 47.4k, 85 %, 23:54, 2026-11-17) carry a little
 * more weight than the words around them, so a skim finds them. A rehype
 * step after Streamdown's own: it wraps each figure in a
 * `span.response-figure` (message-response.css). Only the display changes;
 * copying a message still copies what the agent wrote.
 */

interface HastText {
  type: "text"
  value: string
}

interface HastElement {
  type: "element"
  tagName: string
  properties: Record<string, unknown>
  children: HastNode[]
}

type HastNode = HastText | HastElement | { type: string; children?: HastNode[] }

/**
 * Text that keeps its own look: code, links, what is already bold or a
 * heading, and tables, where every cell would be a figure.
 */
const SKIPPED_TAGS = new Set([
  "a",
  "b",
  "button",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "kbd",
  "math",
  "pre",
  "samp",
  "script",
  "strong",
  "style",
  "svg",
  "table",
])

/**
 * A number standing on its own: digits with `.`, `,`, `:`, `-` or `/`
 * between them, an optional currency sign before and a unit of up to three
 * letters or a percent sign after. Not part of a word, a version (`v1.2`) or
 * a path.
 */
const FIGURE =
  /(?<![\p{L}\p{N}_.\-/\\])[$€£]?\d+(?:[.,:\-/]\d+)*(?:\s?%|[\p{L}µ]{1,3})?(?![\p{L}\p{N}_])/gu

function isElement(node: HastNode): node is HastElement {
  return node.type === "element"
}

function figureSpan(value: string): HastElement {
  return {
    type: "element",
    tagName: "span",
    properties: { className: ["response-figure"] },
    children: [{ type: "text", value }],
  }
}

/** The text split around its figures, or `null` when it holds none. */
export function splitFigures(value: string): HastNode[] | null {
  if (!/\d/.test(value)) return null
  const parts: HastNode[] = []
  let last = 0
  for (const match of value.matchAll(FIGURE)) {
    const start = match.index ?? 0
    if (start > last)
      parts.push({ type: "text", value: value.slice(last, start) })
    parts.push(figureSpan(match[0]))
    last = start + match[0].length
  }
  if (parts.length === 0) return null
  if (last < value.length)
    parts.push({ type: "text", value: value.slice(last) })
  return parts
}

function emphasizeChildren(parent: { children?: HastNode[] }): void {
  const children = parent.children
  if (!children) return
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!
    if (child.type === "text") {
      const parts = splitFigures((child as HastText).value)
      if (!parts) continue
      children.splice(index, 1, ...parts)
      index += parts.length - 1
    } else if (isElement(child)) {
      if (!SKIPPED_TAGS.has(child.tagName)) emphasizeChildren(child)
    } else {
      emphasizeChildren(child)
    }
  }
}

/** The rehype plugin. */
export function rehypeFigures() {
  return (tree: object) => {
    emphasizeChildren(tree as { children?: HastNode[] })
  }
}
