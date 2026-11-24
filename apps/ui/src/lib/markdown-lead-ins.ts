/**
 * A short line that ends with a colon and introduces a list ("Zum Stand der
 * Umgebung:") is shown in bold, so it reads as the title of that list rather
 * than as one more sentence. Only the display changes: copying a message
 * still copies what the agent wrote.
 */

/** Longer than this, a line is a sentence, not a title. */
const MAX_LEAD_IN_LENGTH = 80
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
/** Lines that are already something else in Markdown. */
const NOT_A_PARAGRAPH = /^(?:#|>|\||[-*+][ \t]|\d{1,9}[.)][ \t]|<)/

function isLeadIn(line: string): boolean {
  return (
    line.length > 1 &&
    line.length <= MAX_LEAD_IN_LENGTH &&
    line.endsWith(":") &&
    !/^\s/.test(line) &&
    !NOT_A_PARAGRAPH.test(line) &&
    // Bold inside the line would end the added bold early.
    !line.includes("**") &&
    !line.includes("__")
  )
}

export function emphasizeListLeadIns(markdown: string): string {
  if (!markdown.includes(":")) return markdown
  const lines = markdown.split("\n")
  let fence: string | null = null
  let changed = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const fenceMark = FENCE.exec(line)?.[1]
    if (fenceMark) {
      if (fence === null) fence = fenceMark
      else if (fenceMark[0] === fence[0] && fenceMark.length >= fence.length)
        fence = null
      continue
    }
    if (fence !== null) continue
    const text = line.trimEnd()
    if (!isLeadIn(text)) continue
    // A paragraph of its own: the line before it is blank.
    if (index > 0 && lines[index - 1]!.trim() !== "") continue
    let next = index + 1
    if (next < lines.length && lines[next]!.trim() === "") next += 1
    if (next >= lines.length || !LIST_ITEM.test(lines[next]!)) continue
    lines[index] = `**${text}**`
    changed = true
  }
  return changed ? lines.join("\n") : markdown
}
