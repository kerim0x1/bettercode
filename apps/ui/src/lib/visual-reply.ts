/**
 * Visual replies: an agent answers with a ```html-render fence and the chat
 * shows the page live (components/ai-elements/visual-reply.tsx); ```html
 * fences get the same frame behind a Preview toggle. Everything here is pure,
 * so it is tested without a DOM.
 *
 * The page never runs in the app's document or origin. The chat loads
 * `public/visual-reply-frame.html`, a static host page, in
 * `<iframe sandbox="allow-scripts">`: an opaque origin without forms, popups,
 * downloads or top navigation. The host page carries the reply's own policy
 * (VISUAL_REPLY_CSP), refuses to run anywhere but inside such a sandbox, and
 * shows the page in a nested sandboxed `srcdoc` frame that inherits that
 * policy. A `srcdoc` frame directly in the app would inherit the app's
 * policy instead, which runs no inline script; and as the nested frame's
 * container, the host page's `frame-src 'none'` keeps the agent's page from
 * navigating anywhere. The desktop shell also keeps the host frame on its
 * page (`isAllowedFrameNavigation` in apps/shell/shared/urlPolicy.cjs).
 */

/** The fence language that renders as a live page. */
export const VISUAL_REPLY_LANGUAGE = "html-render"

/** Fences whose completeness matters while an answer streams. */
export const PREVIEWABLE_FENCE_LANGUAGES = [
  VISUAL_REPLY_LANGUAGE,
  "html",
  "htm",
] as const

/**
 * The policy of every visual reply: inline script and style, scripts, styles
 * and fonts only from the listed CDNs, images from anywhere over https, and no
 * fetch, XHR, WebSocket, nested frame or form submission. The host page
 * repeats it (visual-reply.test.ts keeps the two equal).
 */
export const VISUAL_REPLY_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob: https:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join("; ")

/** The host page, relative to the renderer's base URL (apps/ui/public). */
export const VISUAL_REPLY_FRAME_PATH = "visual-reply-frame.html"

export const VISUAL_REPLY_MIN_HEIGHT = 120
export const VISUAL_REPLY_MAX_HEIGHT = 900

/** Larger replies show as code; the agent instruction asks for about 200 KB. */
export const VISUAL_REPLY_MAX_CHARS = 1_000_000

/**
 * postMessage types between the chat, the host page and the page. The host
 * page repeats them; it passes only `height` and `escape` from the page on.
 */
export const VISUAL_REPLY_MESSAGE = {
  /** Host → chat: the host page is listening for its document. */
  ready: "betterc0de:visual-reply:ready",
  /** Chat → host: the document to show, `{ type, html, title }`. */
  render: "betterc0de:visual-reply:render",
  /** Page → host → chat: the page's height in CSS pixels, `{ type, height }`. */
  height: "betterc0de:visual-reply:height",
  /** Page → host → chat: Escape was pressed inside the page. */
  escape: "betterc0de:visual-reply:escape",
} as const

export type VisualReplyFrameMessage =
  | { type: "ready" }
  | { type: "height"; height: number }
  | { type: "escape" }

/**
 * A message from a visual reply frame, or null. Callers check that it came
 * from their own frame's window; a sandboxed frame without
 * `allow-same-origin` always reports its origin as "null".
 */
export function parseVisualReplyFrameMessage(
  origin: string,
  data: unknown
): VisualReplyFrameMessage | null {
  if (origin !== "null" || !data || typeof data !== "object") return null
  const { type, height } = data as { type?: unknown; height?: unknown }
  if (type === VISUAL_REPLY_MESSAGE.ready) return { type: "ready" }
  if (type === VISUAL_REPLY_MESSAGE.escape) return { type: "escape" }
  if (
    type === VISUAL_REPLY_MESSAGE.height &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    height >= 0
  ) {
    return { type: "height", height }
  }
  return null
}

/** The frame's height in the chat: its page height, within 120–900 px. */
export function clampVisualReplyHeight(height: number): number {
  if (!Number.isFinite(height)) return VISUAL_REPLY_MIN_HEIGHT
  return Math.min(
    VISUAL_REPLY_MAX_HEIGHT,
    Math.max(VISUAL_REPLY_MIN_HEIGHT, Math.ceil(height))
  )
}

/** Whether a rendered code element's class names the visual reply fence. */
export function isVisualReplyClassName(className: string | undefined): boolean {
  return /(?:^|\s)language-html-render(?:\s|$)/.test(className ?? "")
}

// ── Theme ────────────────────────────────────────────────────────────────

export interface VisualReplyTheme {
  mode: "light" | "dark"
  background: string
  surface: string
  foreground: string
  muted: string
  mutedForeground: string
  border: string
  accent: string
  accentForeground: string
  font: string
  mono: string
  radius: string
}

/** Something that reads computed custom properties, like CSSStyleDeclaration. */
export interface VisualReplyThemeSource {
  getPropertyValue(property: string): string
}

const UI_FONT_FALLBACK = "system-ui, sans-serif"
const MONO_FONT_FALLBACK =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

/**
 * Used only where the app's tokens cannot be read (tests, a value that fails
 * the checks below): the default-dark and white templates of index.css.
 */
export function fallbackVisualReplyTheme(
  mode: VisualReplyTheme["mode"]
): VisualReplyTheme {
  const shared = {
    font: `"Figtree Variable", ${UI_FONT_FALLBACK}`,
    mono: MONO_FONT_FALLBACK,
    radius: "0.625rem",
  }
  return mode === "dark"
    ? {
        mode,
        background: "oklch(0.1684 0 0)",
        surface: "oklch(0.2393 0 0)",
        foreground: "oklch(0.985 0 0)",
        muted: "oklch(0.269 0 0)",
        mutedForeground: "oklch(0.708 0 0)",
        border: "oklch(1 0 0 / 10%)",
        accent: "oklch(0.922 0 0)",
        accentForeground: "oklch(0.205 0 0)",
        ...shared,
      }
    : {
        mode,
        background: "oklch(1 0 0)",
        surface: "oklch(1 0 0)",
        foreground: "oklch(0.145 0 0)",
        muted: "oklch(0.97 0 0)",
        mutedForeground: "oklch(0.556 0 0)",
        border: "oklch(0.922 0 0)",
        accent: "oklch(0.205 0 0)",
        accentForeground: "oklch(0.985 0 0)",
        ...shared,
      }
}

// Values go into the page's stylesheet, so nothing that could end a
// declaration, a rule or the <style> element passes: no ; { } < > : \ or
// quotes in colors, and only balanced quotes in font lists.
const COLOR_VALUE = /^[#\w\s(),.%/+-]{1,96}$/
const FONT_VALUE = /^[\w\s"',.-]{1,240}$/
const LENGTH_VALUE = /^\d+(?:\.\d+)?(?:px|rem|em)$/

function cssColor(raw: string): string | null {
  const value = raw.trim()
  return COLOR_VALUE.test(value) ? value : null
}

function cssFontStack(raw: string, generic: string): string | null {
  const value = raw.trim()
  if (!FONT_VALUE.test(value)) return null
  const quotes = (quote: string) => value.split(quote).length - 1
  if (quotes('"') % 2 !== 0 || quotes("'") % 2 !== 0) return null
  return `${value}, ${generic}`
}

function cssLength(raw: string): string | null {
  const value = raw.trim()
  return LENGTH_VALUE.test(value) ? value : null
}

/**
 * The app's current theme as the page sees it (`--bc-*` variables). Reads the
 * semantic tokens of index.css, appearance-store.ts and imported themes, so
 * light, dark and imported themes all carry over.
 */
export function readVisualReplyTheme(
  source: VisualReplyThemeSource,
  mode: VisualReplyTheme["mode"]
): VisualReplyTheme {
  const fallback = fallbackVisualReplyTheme(mode)
  const color = (property: string, value: string) =>
    cssColor(source.getPropertyValue(property)) ?? value
  return {
    mode,
    background: color("--background", fallback.background),
    surface: color("--card", fallback.surface),
    foreground: color("--foreground", fallback.foreground),
    muted: color("--muted", fallback.muted),
    mutedForeground: color("--muted-foreground", fallback.mutedForeground),
    border: color("--border", fallback.border),
    accent: color("--primary", fallback.accent),
    accentForeground: color("--primary-foreground", fallback.accentForeground),
    font:
      cssFontStack(source.getPropertyValue("--font-sans"), UI_FONT_FALLBACK) ??
      fallback.font,
    mono:
      cssFontStack(
        source.getPropertyValue("--font-mono"),
        MONO_FONT_FALLBACK
      ) ?? fallback.mono,
    radius: cssLength(source.getPropertyValue("--radius")) ?? fallback.radius,
  }
}

/** Equal for equal themes; a frame reloads when it changes. */
export function visualReplyThemeKey(theme: VisualReplyTheme): string {
  return JSON.stringify(theme)
}

function visualReplyBaseStyles(theme: VisualReplyTheme): string {
  return [
    `:root{color-scheme:${theme.mode};--bc-bg:${theme.background};--bc-surface:${theme.surface};--bc-fg:${theme.foreground};--bc-muted:${theme.muted};--bc-muted-fg:${theme.mutedForeground};--bc-border:${theme.border};--bc-accent:${theme.accent};--bc-accent-fg:${theme.accentForeground};--bc-font:${theme.font};--bc-mono:${theme.mono};--bc-radius:${theme.radius}}`,
    "html{background:var(--bc-bg);color:var(--bc-fg);font-family:var(--bc-font);font-size:14px;line-height:1.5}",
    "body{margin:16px}",
    "a{color:var(--bc-accent)}",
    "code,kbd,pre,samp{font-family:var(--bc-mono)}",
    "table{border-collapse:collapse}",
    "th,td{border:1px solid var(--bc-border);padding:6px 10px;text-align:left}",
  ].join("\n")
}

/**
 * Runs first in the page. Through the host page it reports the page's
 * height to the chat and passes Escape on (while focus is in a frame the app
 * never sees the key). It keeps link clicks from trying to navigate the
 * frame, which the policy refuses with an error page.
 */
const VISUAL_REPLY_RUNTIME = `(function () {
  "use strict";
  var host = window.parent;
  if (!host || host === window) return;
  var post = function (message) {
    try { host.postMessage(message, "*"); } catch (error) {}
  };
  var last = -1;
  var queued = false;
  var measure = function () {
    queued = false;
    var root = document.documentElement;
    var body = document.body;
    var height = Math.ceil(Math.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0));
    if (height === last) return;
    last = height;
    post({ type: "${VISUAL_REPLY_MESSAGE.height}", height: height });
  };
  var schedule = function () {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(measure);
  };
  if (typeof ResizeObserver === "function") {
    var resize = new ResizeObserver(schedule);
    resize.observe(document.documentElement);
    document.addEventListener("DOMContentLoaded", function () {
      if (document.body) resize.observe(document.body);
    });
  }
  if (typeof MutationObserver === "function") {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
  window.addEventListener("load", schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule, function () {});
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") post({ type: "${VISUAL_REPLY_MESSAGE.escape}" });
  }, true);
  document.addEventListener("click", function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest("a[href]") : null;
    if (!link) return;
    var href = (link.getAttribute("href") || "").trim();
    if (href.charAt(0) === "#" || /^javascript:/i.test(href)) return;
    event.preventDefault();
  }, true);
  schedule();
})();`

/**
 * The document the host page shows: the policy as its first element, the theme
 * variables and base styles, the runtime above, then the agent's HTML. The
 * page's own styles come later, so they win over the base styles.
 */
export function buildVisualReplyDocument(
  html: string,
  theme: VisualReplyTheme
): string {
  // One doctype, first: a page whose doctype followed the prelude would
  // render in quirks mode.
  const page = html.replace(/^\uFEFF?\s*<!doctype[^>]*>/i, "")
  return [
    "<!DOCTYPE html>",
    `<meta http-equiv="Content-Security-Policy" content="${VISUAL_REPLY_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${visualReplyBaseStyles(theme)}</style>`,
    `<script>${VISUAL_REPLY_RUNTIME}</script>`,
    page,
  ].join("\n")
}

// ── Streaming ────────────────────────────────────────────────────────────

/** A fence body as the chat's renderer and the scanner below both see it. */
export function normalizeFenceBody(code: string): string {
  return code.replace(/\r\n?/g, "\n").replace(/\s+$/, "")
}

function stripIndent(line: string, columns: number): string {
  let index = 0
  while (index < columns && line[index] === " ") index += 1
  return line.slice(index)
}

/**
 * Bodies of the closed fenced code blocks in `markdown` whose language is
 * one of `languages`, normalized. While an answer streams, a page whose body
 * is not among them is still being written and is not rendered yet. Fences
 * inside block quotes are not recognized; such a page renders once the answer
 * is complete.
 */
export function closedFenceBodies(
  markdown: string,
  languages: readonly string[]
): Set<string> {
  const bodies = new Set<string>()
  const wanted = new Set(languages.map((language) => language.toLowerCase()))
  let open: {
    marker: string
    length: number
    indent: number
    language: string
    lines: string[]
  } | null = null
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (open) {
      const close = /^( *)(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (
        close &&
        close[2][0] === open.marker &&
        close[2].length >= open.length &&
        close[1].length <= open.indent + 3
      ) {
        if (wanted.has(open.language)) {
          bodies.add(normalizeFenceBody(open.lines.join("\n")))
        }
        open = null
      } else {
        open.lines.push(stripIndent(line, open.indent))
      }
      continue
    }
    const start = /^( *)(`{3,}|~{3,})(.*)$/.exec(line)
    if (!start) continue
    const [, indent, fence, info] = start
    // A backtick fence's info string has no backticks (that is inline code).
    if (fence[0] === "`" && info.includes("`")) continue
    open = {
      marker: fence[0],
      length: fence.length,
      indent: indent.length,
      language: (info.trim().split(/\s+/)[0] ?? "").toLowerCase(),
      lines: [],
    }
  }
  return bodies
}

// ── Labels, files and keys ───────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
}

/** The page's `<title>`, for the frame's header and file name. */
export function visualReplyTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html.slice(0, 20_000))
  const title = (match?.[1] ?? "")
    .replace(
      /&(amp|lt|gt|quot|#39|apos);/g,
      (_, name: string) => ENTITIES[name]
    )
    .replace(/\s+/g, " ")
    .trim()
  return title ? title.slice(0, 120) : null
}

/** "Quarterly revenue" → "quarterly-revenue.html"; "visual-reply.html" without a title. */
export function visualReplyFileName(html: string): string {
  const slug = (visualReplyTitle(html) ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "")
  return `${slug || "visual-reply"}.html`
}

/** FNV-1a with the length, for React keys and caches. Not for security. */
export function hashVisualReply(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(36)}-${text.length.toString(36)}`
}
