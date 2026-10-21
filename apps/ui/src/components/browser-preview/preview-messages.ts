import { z } from "zod"
import type { ConsoleLog, DomNode, SelectedElement } from "./types"

/**
 * The previewed page is arbitrary site content, so everything it posts to the
 * host (bc-* messages, inspector results) is untrusted. These parsers are the
 * only way that data enters app state: they check the shape, coerce what is
 * safe to coerce, cap sizes, and drop the rest.
 */

export const MAX_CONSOLE_ENTRIES_PER_MESSAGE = 200
export const MAX_CONSOLE_MESSAGE_LENGTH = 2_000
const MAX_SELECTOR_LENGTH = 2_000
const MAX_ELEMENT_TEXT_LENGTH = 4_000
const MAX_SHORT_TEXT_LENGTH = 256
const MAX_URL_LENGTH = 4_096
const MAX_STYLE_ENTRIES = 120
const MAX_STYLE_VALUE_LENGTH = 1_000
const MAX_DOM_DEPTH = 12
const MAX_DOM_CHILDREN = 60
const MAX_DOM_NODES = 3_000
const MAX_DOM_CLASSES = 8

const clip = (max: number) => (value: string) =>
  value.length > max ? value.slice(0, max) : value

const text = (max: number) => z.string().catch("").transform(clip(max))
const optionalText = (max: number) =>
  z.string().transform(clip(max)).optional().catch(undefined)

const selectedElementSchema = z.object({
  selector: z.string().min(1).max(MAX_SELECTOR_LENGTH),
  tagName: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
  id: text(MAX_SHORT_TEXT_LENGTH),
  className: text(MAX_SELECTOR_LENGTH),
  text: text(MAX_ELEMENT_TEXT_LENGTH),
  label: optionalText(MAX_SHORT_TEXT_LENGTH),
  url: optionalText(MAX_URL_LENGTH),
  childCount: z.number().int().nonnegative().catch(0),
  styles: z.record(z.string(), z.unknown()).catch({}),
  rect: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
  }),
  viewport: z
    .object({ width: z.number().positive(), height: z.number().positive() })
    .optional(),
})

function styleRecord(raw: Record<string, unknown>): Record<string, string> {
  const styles: Record<string, string> = {}
  let count = 0
  for (const [property, value] of Object.entries(raw)) {
    if (count >= MAX_STYLE_ENTRIES) break
    if (typeof value !== "string" || property.length > MAX_SHORT_TEXT_LENGTH)
      continue
    styles[property] = clip(MAX_STYLE_VALUE_LENGTH)(value)
    count += 1
  }
  return styles
}

/**
 * A page element as the inspector script reports it, or null when the value
 * is not one. Used for both the element picked in the page and the element
 * under the selection overlay's pointer.
 */
export function parseSelectedElement(value: unknown): SelectedElement | null {
  const parsed = selectedElementSchema.safeParse(value)
  if (!parsed.success) return null
  const data = parsed.data
  return {
    selector: data.selector,
    tagName: data.tagName,
    id: data.id,
    className: data.className,
    text: data.text,
    ...(data.label === undefined ? {} : { label: data.label }),
    ...(data.url === undefined ? {} : { url: data.url }),
    childCount: data.childCount,
    styles: styleRecord(data.styles),
    rect: data.rect,
    ...(data.viewport ? { viewport: data.viewport } : {}),
  }
}

function consoleLevel(value: unknown): ConsoleLog["level"] {
  return value === "warn" || value === "error" ? value : "log"
}

function consoleText(value: unknown): string {
  if (typeof value === "string") return clip(MAX_CONSOLE_MESSAGE_LENGTH)(value)
  try {
    return clip(MAX_CONSOLE_MESSAGE_LENGTH)(String(value ?? ""))
  } catch {
    return ""
  }
}

function consoleEntry(value: unknown, timestamp: Date): ConsoleLog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const entry = value as { level?: unknown; message?: unknown }
  return {
    level: consoleLevel(entry.level),
    message: consoleText(entry.message),
    timestamp,
  }
}

/** Console lines from a `console` or `console-batch` message; never throws. */
export function parseConsoleEntries(
  channel: "console" | "console-batch",
  data: unknown,
  timestamp = new Date()
): ConsoleLog[] {
  if (channel === "console") {
    const entry = consoleEntry(data, timestamp)
    return entry ? [entry] : []
  }
  if (!data || typeof data !== "object") return []
  const entries = (data as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return []
  const result: ConsoleLog[] = []
  for (const raw of entries.slice(0, MAX_CONSOLE_ENTRIES_PER_MESSAGE)) {
    const entry = consoleEntry(raw, timestamp)
    if (entry) result.push(entry)
  }
  return result
}

const domNodeSchema = z.object({
  tag: z.string().min(1).max(MAX_SHORT_TEXT_LENGTH),
  id: text(MAX_SHORT_TEXT_LENGTH),
  classes: z
    .array(z.unknown())
    .catch([])
    .transform((classes) =>
      classes
        .filter((item): item is string => typeof item === "string")
        .slice(0, MAX_DOM_CLASSES)
        .map(clip(MAX_SHORT_TEXT_LENGTH))
    ),
  selector: z.string().max(MAX_SELECTOR_LENGTH),
  text: text(MAX_SHORT_TEXT_LENGTH),
  children: z.array(z.unknown()).catch([]),
})

/**
 * The inspector tree from a `dom-tree` message. Malformed nodes are dropped
 * with their subtree; depth, fan-out and total size are capped.
 */
export function parseDomTree(data: unknown): DomNode | null {
  if (!data || typeof data !== "object") return null
  let budget = MAX_DOM_NODES
  const visit = (raw: unknown, depth: number): DomNode | null => {
    if (budget <= 0 || depth > MAX_DOM_DEPTH) return null
    const parsed = domNodeSchema.safeParse(raw)
    if (!parsed.success) return null
    budget -= 1
    const children: DomNode[] = []
    for (const child of parsed.data.children.slice(0, MAX_DOM_CHILDREN)) {
      const node = visit(child, depth + 1)
      if (node) children.push(node)
    }
    return {
      tag: parsed.data.tag,
      id: parsed.data.id,
      classes: parsed.data.classes,
      selector: parsed.data.selector,
      text: parsed.data.text,
      children,
    }
  }
  return visit((data as { tree?: unknown }).tree, 0)
}

const keydownSchema = z.object({
  key: z.string(),
  ctrlKey: z.boolean().catch(false),
  metaKey: z.boolean().catch(false),
  altKey: z.boolean().catch(false),
})

/** The canvas gesture a modifier keydown in the page starts, if any. */
export function parseCanvasKeydown(
  data: unknown
): "canvas-zoom-start" | "canvas-pan-start" | null {
  const parsed = keydownSchema.safeParse(data)
  if (!parsed.success) return null
  const { key, ctrlKey, metaKey, altKey } = parsed.data
  if ((key === "Control" && ctrlKey) || (key === "Meta" && metaKey))
    return "canvas-zoom-start"
  if (key === "Alt" && altKey && !ctrlKey && !metaKey) return "canvas-pan-start"
  return null
}

export type PreviewPageMessage =
  | { readonly kind: "console"; readonly entries: ConsoleLog[] }
  | { readonly kind: "dom-tree"; readonly tree: DomNode | null }
  | { readonly kind: "element-selected"; readonly element: SelectedElement }
  | {
      readonly kind: "shortcut"
      readonly shortcut: "canvas-zoom-start" | "canvas-pan-start"
    }

/**
 * One bc-* message from the page, validated. `type` is the iframe
 * `bc-`-prefixed type or the bare webview channel. Unknown channels and
 * invalid payloads give null and are dropped by the caller.
 */
export function parsePreviewPageMessage(
  type: string,
  data: unknown,
  timestamp = new Date()
): PreviewPageMessage | null {
  const channel = type.startsWith("bc-") ? type.slice(3) : type
  switch (channel) {
    case "console":
    case "console-batch": {
      const entries = parseConsoleEntries(channel, data, timestamp)
      return entries.length ? { kind: "console", entries } : null
    }
    case "dom-tree":
      // A page without a body legitimately reports no tree.
      return data && typeof data === "object"
        ? { kind: "dom-tree", tree: parseDomTree(data) }
        : null
    case "element-selected": {
      const element = parseSelectedElement(data)
      return element ? { kind: "element-selected", element } : null
    }
    case "did-keydown": {
      const shortcut = parseCanvasKeydown(data)
      return shortcut ? { kind: "shortcut", shortcut } : null
    }
    default:
      return null
  }
}

/**
 * The `{ type, data }` envelope an iframe page posts to the host, or null
 * when the message is not a bc-* message.
 */
export function readIframeEnvelope(
  message: unknown
): { type: string; data: unknown } | null {
  if (!message || typeof message !== "object") return null
  const envelope = message as { type?: unknown; data?: unknown }
  if (typeof envelope.type !== "string" || !envelope.type.startsWith("bc-"))
    return null
  return { type: envelope.type, data: envelope.data ?? message }
}
