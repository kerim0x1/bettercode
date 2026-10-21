/**
 * Markdown styling that keeps every source character at its own offset.
 *
 * The composer paints these flags in a mirror over its textarea, where a
 * dropped or added character would push the caret away from the visible
 * text. Sent user messages render the same flags with the syntax hidden.
 * Nothing is parsed into a tree, so no text the user typed can disappear,
 * and an unclosed `**` while typing only affects its own line.
 */
export const MARKDOWN_SOURCE = {
  /** Syntax a renderer may hide: emphasis delimiters, backticks and `#`. */
  marker: 1 << 0,
  strong: 1 << 1,
  em: 1 << 2,
  code: 1 << 3,
  strike: 1 << 4,
  /** Link text and bare URLs. */
  link: 1 << 5,
  /** The `[`, `](target)` and `)` around link text; kept visible. */
  linkTarget: 1 << 6,
  heading: 1 << 7,
  quote: 1 << 8,
  /** The `>` prefix of a quoted line, with its following space. */
  quoteMark: 1 << 9,
  /** The `-`, `*` or `+` that starts a list item. */
  bullet: 1 << 10,
  /** The `1.` or `1)` that starts an ordered list item. */
  listNumber: 1 << 11,
  /** A ``` or ~~~ fence line. */
  fence: 1 << 12,
  /** A line inside a fenced code block. */
  codeBlock: 1 << 13,
  /** A thematic break such as `---`. */
  rule: 1 << 14,
} as const

export interface MarkdownSourceRun {
  start: number
  end: number
  flags: number
}

/** Longer text is shown unstyled so typing in a huge paste stays responsive. */
export const MARKDOWN_SOURCE_LIMIT = 20_000

const F = MARKDOWN_SOURCE
const MASK = "\u0000"
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}(?:>[ \t]?)+/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/
const BULLET = /^([ \t]*)([-*+])[ \t]+/
const ORDERED = /^([ \t]*)(\d{1,9}[.)])[ \t]+/
const ESCAPE = /\\[!-/:-@[-`{-~]/g
const CODE_SPAN = /(?<![`\\])(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g
const LINK = /\[([^\]\n]+)\]\(([^()\s]+)(?:[ \t]+"[^"\n]*")?\)/g
const BARE_URL = /\bhttps?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/g
const STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g
const STRIKE = /~~(?=[^\s~])([\s\S]*?[^\s~])~~/g
const EM = /(\*|_)(?=[^\s*_])([\s\S]*?[^\s\\])\1/g
const WORD = /[\p{L}\p{N}_]/u

/** Splits `source` into contiguous runs; flags of 0 are plain text. */
export function markdownSourceRuns(source: string): MarkdownSourceRun[] {
  if (!source) return []
  if (source.length > MARKDOWN_SOURCE_LIMIT)
    return [{ start: 0, end: source.length, flags: 0 }]
  const flags = new Uint16Array(source.length)
  let fence: { char: string; length: number } | null = null
  for (let lineStart = 0; lineStart <= source.length; ) {
    const newline = source.indexOf("\n", lineStart)
    const lineEnd = newline === -1 ? source.length : newline
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, "")
    const end = lineStart + line.length
    const fenceMatch = FENCE.exec(line)
    if (fence) {
      const closes =
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        !fenceMatch[2].trim()
      mark(flags, lineStart, end, closes ? F.fence : F.codeBlock)
      if (closes) fence = null
    } else if (
      fenceMatch &&
      !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))
    ) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
      mark(flags, lineStart, end, F.fence)
    } else if (RULE.test(line)) {
      mark(flags, lineStart, end, F.rule)
    } else {
      markLine(source, flags, lineStart, end)
    }
    lineStart = lineEnd + 1
  }
  const runs: MarkdownSourceRun[] = []
  for (let index = 0; index < flags.length; index++) {
    const last = runs.at(-1)
    if (last && last.flags === flags[index]) last.end = index + 1
    else runs.push({ start: index, end: index + 1, flags: flags[index] })
  }
  return runs
}

export function hasMarkdownSource(runs: readonly MarkdownSourceRun[]): boolean {
  return runs.some((run) => run.flags !== 0)
}

function markLine(
  source: string,
  flags: Uint16Array,
  lineStart: number,
  end: number
) {
  let start = lineStart
  let base = 0
  const quote = QUOTE.exec(source.slice(start, end))
  if (quote) {
    mark(flags, start, start + quote[0].length, F.quoteMark)
    start += quote[0].length
    base |= F.quote
  }
  const rest = source.slice(start, end)
  const heading = HEADING.exec(rest)
  const bullet = heading ? null : BULLET.exec(rest)
  const ordered = heading || bullet ? null : ORDERED.exec(rest)
  if (heading) {
    mark(flags, start, start + heading[0].length, F.marker)
    start += heading[0].length
    base |= F.heading
  } else if (bullet) {
    const at = start + bullet[1].length
    mark(flags, at, at + 1, F.bullet)
    start += bullet[0].length
  } else if (ordered) {
    const at = start + ordered[1].length
    mark(flags, at, at + ordered[2].length, F.listNumber)
    start += ordered[0].length
  }
  mark(flags, start, end, base)
  markInline(source.slice(start, end), start, flags)
}

/** Inline syntax within one line; `text` starts at `offset` in the source. */
function markInline(text: string, offset: number, flags: Uint16Array) {
  // Consumed characters are masked so later passes cannot reuse them as
  // delimiters: a `_` inside code or a URL, or an escaped `*`. Escapes stay
  // visible text, so a Windows path such as C:\_temp keeps its backslash.
  const work = text.split("")
  const consume = (start: number, end: number) => work.fill(MASK, start, end)
  const at = (start: number, end: number, flag: number) =>
    mark(flags, offset + start, offset + end, flag)
  const pass = (
    pattern: RegExp,
    apply: (match: RegExpExecArray) => boolean | void
  ) => {
    pattern.lastIndex = 0
    const subject = work.join("")
    for (
      let match = pattern.exec(subject);
      match;
      match = pattern.exec(subject)
    ) {
      // A rejected match may hide a valid one that starts inside it.
      if (apply(match) === false) pattern.lastIndex = match.index + 1
    }
  }

  pass(CODE_SPAN, (match) => {
    const open = match[1].length
    const end = match.index + match[0].length
    at(match.index, end, F.code)
    at(match.index, match.index + open, F.marker)
    at(end - open, end, F.marker)
    consume(match.index, end)
  })
  pass(ESCAPE, (match) => consume(match.index + 1, match.index + 2))
  pass(LINK, (match) => {
    const textEnd = match.index + 1 + match[1].length
    at(match.index, match.index + 1, F.linkTarget)
    at(match.index + 1, textEnd, F.link)
    at(textEnd, match.index + match[0].length, F.linkTarget)
    consume(match.index, match.index + 1)
    consume(textEnd, match.index + match[0].length)
  })
  pass(BARE_URL, (match) => {
    at(match.index, match.index + match[0].length, F.link)
    consume(match.index, match.index + match[0].length)
  })
  pass(STRONG, (match) => delimited(match, 2, F.strong))
  pass(STRIKE, (match) => {
    const end = match.index + match[0].length
    at(match.index, end, F.strike)
    at(match.index, match.index + 2, F.marker)
    at(end - 2, end, F.marker)
    consume(match.index, match.index + 2)
    consume(end - 2, end)
  })
  pass(EM, (match) => delimited(match, 1, F.em))

  function delimited(match: RegExpExecArray, width: number, flag: number) {
    const end = match.index + match[0].length
    // `_` only delimits at word edges, so snake_case stays plain text.
    if (
      match[1][0] === "_" &&
      (WORD.test(text[match.index - 1] ?? "") || WORD.test(text[end] ?? ""))
    )
      return false
    at(match.index + width, end - width, flag)
    at(match.index, match.index + width, F.marker)
    at(end - width, end, F.marker)
    consume(match.index, match.index + width)
    consume(end - width, end)
  }
}

function mark(flags: Uint16Array, start: number, end: number, flag: number) {
  if (!flag) return
  for (let index = start; index < end; index++) flags[index] |= flag
}
