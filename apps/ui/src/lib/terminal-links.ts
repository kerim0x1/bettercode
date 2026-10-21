/**
 * Web addresses in terminal output, for the terminal's clickable links.
 * Only http(s) is matched; anything else a program prints stays text.
 */

export interface TerminalUrlMatch {
  /** UTF-16 offsets into the searched text, `end` exclusive. */
  readonly start: number
  readonly end: number
  readonly url: string
}

// Control characters end an address: escape sequences follow it directly.
// eslint-disable-next-line no-control-regex
const URL_PATTERN = /https?:\/\/[^\s"'<>`\\^{|}\u0000-\u001f\u007f]+/gi
/** Punctuation that ends a sentence rather than the address. */
const TRAILING = /[.,;:!?'"*_~]+$/
const MAX_URL_CHARS = 2_048

/** Drops a closing bracket the address did not open (`(see https://x.y)`). */
function trimUnbalanced(candidate: string): string {
  let text = candidate.replace(TRAILING, "")
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["(", ")"],
    ["[", "]"],
  ]
  for (;;) {
    const last = text.at(-1)
    const pair = pairs.find(([, close]) => close === last)
    if (!pair) return text
    const opened = text.split(pair[0]).length - 1
    const closed = text.split(pair[1]).length - 1
    if (closed <= opened) return text
    text = text.slice(0, -1).replace(TRAILING, "")
  }
}

export function findTerminalUrls(text: string): TerminalUrlMatch[] {
  const matches: TerminalUrlMatch[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const url = trimUnbalanced(match[0])
    if (url.length > MAX_URL_CHARS) continue
    try {
      const parsed = new URL(url)
      if (!parsed.hostname) continue
    } catch {
      continue
    }
    matches.push({ start, end: start + url.length, url })
  }
  return matches
}
