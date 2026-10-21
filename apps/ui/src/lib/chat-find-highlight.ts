import {
  chatFindSegmentRanges,
  type ChatFindTextSegment,
} from "@/lib/chat-find"

/**
 * Painting find-in-chat matches in the rendered transcript. Matches are
 * drawn with the CSS Custom Highlight API: ranges over the existing text
 * nodes, so the markdown DOM React owns is never split or wrapped. Where
 * the API is missing, or an entry's text has no rendered match (a collapsed
 * plan, concealed code), the whole entry is marked with an attribute React
 * does not manage; those styles live in `index.css`.
 */

/** On the element of a searchable transcript entry, with the entry's id. */
export const CHAT_FIND_ENTRY_ATTRIBUTE = "data-chat-find-entry"
/** On the parts of an entry whose rendered text is searched. */
export const CHAT_FIND_TEXT_ATTRIBUTE = "data-chat-find-text"
/** Set on an entry highlighted as a whole: "match" or "current". */
export const CHAT_FIND_HIT_ATTRIBUTE = "data-chat-find-hit"

const MATCH_HIGHLIGHT = "betterc0de-chat-find"
const CURRENT_HIGHLIGHT = "betterc0de-chat-find-current"

const HIGHLIGHT_STYLE_ID = "betterc0de-chat-find-highlights"

/**
 * The `::highlight()` rules, added once at run time: the CSS optimizer of
 * the build does not know the pseudo-element and would warn on every build.
 * Matches take the warning hue at 30%, the usual find colour, scoped to
 * light and dark mode only, so built-in and imported themes keep it. The
 * current match is solid with near-black text (`--foreground` in light
 * mode, `--background` in dark mode). Forced colours use the system's.
 */
const HIGHLIGHT_CSS = `
::highlight(${MATCH_HIGHLIGHT}) {
  background-color: color-mix(in oklab, var(--warning) 30%, transparent);
}
::highlight(${CURRENT_HIGHLIGHT}) {
  background-color: var(--warning);
  color: var(--foreground);
}
.dark ::highlight(${CURRENT_HIGHLIGHT}) {
  color: var(--background);
}
@media (forced-colors: active) {
  ::highlight(${MATCH_HIGHLIGHT}) {
    background-color: Mark;
    color: MarkText;
  }
  ::highlight(${CURRENT_HIGHLIGHT}) {
    background-color: Highlight;
    color: HighlightText;
  }
}
`

function ensureHighlightStyles(): void {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = HIGHLIGHT_STYLE_ID
  style.textContent = HIGHLIGHT_CSS
  document.head.appendChild(style)
}

/** Text inside these is chrome, not message text. */
const SKIPPED_TEXT = [
  "button",
  "[aria-hidden='true']",
  ".sr-only",
  "svg",
  "script",
  "style",
  "textarea",
  "input",
  "select",
].join(", ")

/** Elements whose text never joins the text of a neighbouring one. */
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
])

export function supportsChatFindHighlights(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight === "function"
  )
}

/** The element of one transcript entry inside a transcript. */
export function chatFindEntryElement(
  scope: ParentNode,
  entryId: string
): HTMLElement | null {
  return scope.querySelector<HTMLElement>(
    `[${CHAT_FIND_ENTRY_ATTRIBUTE}="${CSS.escape(entryId)}"]`
  )
}

function isSkipped(node: Text, root: Element): boolean {
  for (
    let element = node.parentElement;
    element && element !== root;
    element = element.parentElement
  ) {
    if (element.matches(SKIPPED_TEXT)) return true
  }
  return false
}

function blockId(node: Text, root: Element, ids: Map<Element, number>): number {
  let element = node.parentElement
  while (element && element !== root && !BLOCK_TAGS.has(element.tagName)) {
    element = element.parentElement
  }
  const block = element ?? root
  let id = ids.get(block)
  if (id === undefined) {
    id = ids.size
    ids.set(block, id)
  }
  return id
}

/**
 * Ranges of the matches in one rendered entry, in text order. Only the
 * entry's text parts are read; an entry without one (a plan card) has no
 * ranges and is highlighted as a whole.
 */
export function chatFindEntryRanges(entry: Element, pattern: RegExp): Range[] {
  const parts = Array.from(
    entry.querySelectorAll(`[${CHAT_FIND_TEXT_ATTRIBUTE}]`)
  )
  const roots = parts.filter(
    (part) => !parts.some((other) => other !== part && other.contains(part))
  )
  const nodes: Text[] = []
  const segments: ChatFindTextSegment[] = []
  const blocks = new Map<Element, number>()
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof Text) || !node.data) continue
      if (isSkipped(node, root)) continue
      nodes.push(node)
      segments.push({ text: node.data, block: blockId(node, root, blocks) })
    }
  }
  if (segments.length === 0) return []
  return chatFindSegmentRanges(segments, pattern).flatMap((match) => {
    const start = nodes[match.startSegment]
    const end = nodes[match.endSegment]
    if (!start || !end) return []
    const range = document.createRange()
    range.setStart(start, match.startOffset)
    range.setEnd(end, match.endOffset)
    return [range]
  })
}

/** Highlights per transcript; the registry draws all of them at once. */
const paintedScopes = new Map<
  string,
  { matches: ReadonlyArray<Range>; current: Range | null }
>()

/**
 * Draws one transcript's matches and its current match, replacing what it
 * drew before. Highlight names are global to the document, so the ranges of
 * every open find bar are merged into one highlight per kind.
 */
export function paintChatFindHighlights(
  scopeId: string,
  matches: ReadonlyArray<Range>,
  current: Range | null
): void {
  if (!supportsChatFindHighlights()) return
  if (matches.length === 0 && !current) {
    paintedScopes.delete(scopeId)
  } else {
    ensureHighlightStyles()
    paintedScopes.set(scopeId, { matches, current })
  }
  const all: Range[] = []
  const currents: Range[] = []
  for (const painted of paintedScopes.values()) {
    all.push(...painted.matches)
    if (painted.current) currents.push(painted.current)
  }
  if (all.length > 0) CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...all))
  else CSS.highlights.delete(MATCH_HIGHLIGHT)
  if (currents.length > 0) {
    const highlight = new Highlight(...currents)
    highlight.priority = 1
    CSS.highlights.set(CURRENT_HIGHLIGHT, highlight)
  } else {
    CSS.highlights.delete(CURRENT_HIGHLIGHT)
  }
}

/** Marks entries highlighted as a whole, clearing the previous marks. */
export function markChatFindEntries(
  scope: ParentNode,
  marks: ReadonlyMap<HTMLElement, "match" | "current">
): void {
  for (const element of scope.querySelectorAll<HTMLElement>(
    `[${CHAT_FIND_HIT_ATTRIBUTE}]`
  )) {
    if (!marks.has(element)) element.removeAttribute(CHAT_FIND_HIT_ATTRIBUTE)
  }
  for (const [element, mark] of marks) {
    if (element.getAttribute(CHAT_FIND_HIT_ATTRIBUTE) !== mark) {
      element.setAttribute(CHAT_FIND_HIT_ATTRIBUTE, mark)
    }
  }
}

/** Removes everything one transcript's find bar drew. */
export function clearChatFindHighlights(
  scopeId: string,
  scope: ParentNode | null
): void {
  paintChatFindHighlights(scopeId, [], null)
  if (scope) markChatFindEntries(scope, new Map())
}

/** Whether the user or the Animations setting asks for still scrolling. */
export function prefersInstantChatFindScroll(): boolean {
  if (typeof window === "undefined") return true
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true ||
    document.documentElement.classList.contains("animations-disabled")
  )
}

/**
 * Scrolls `scroller` so `target` sits a third of the way down, clear of the
 * find bar; `beforeScroll` runs first, only when it has to move. A target
 * already in view is left alone. Returns false when the target has no box
 * to scroll to (hidden text), so the caller can scroll to its entry.
 */
export function scrollChatFindTargetIntoView(
  scroller: HTMLElement,
  target: Range | HTMLElement,
  beforeScroll?: () => void
): boolean {
  const rect = target.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const view = scroller.getBoundingClientRect()
  // Room for the find bar over the top of the transcript.
  const topInset = 56
  const inView =
    rect.top >= view.top + topInset && rect.bottom <= view.bottom - 16
  if (inView) return true
  const offset =
    rect.height > view.height - topInset
      ? rect.top - view.top - topInset
      : rect.top - view.top - (view.height - rect.height) / 3
  beforeScroll?.()
  scroller.scrollTo({
    top: scroller.scrollTop + offset,
    behavior: prefersInstantChatFindScroll() ? "auto" : "smooth",
  })
  return true
}
