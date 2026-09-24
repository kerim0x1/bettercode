/**
 * The line break the editor saves a file with. CodeMirror splits a text at
 * any line break and joins its lines with one; the editor joins them with
 * the file's own, so a CRLF file stays CRLF. A file that mixes them gets its
 * most common one, as in the desktop's editor (Monaco): CRLF when more than
 * half the breaks have a CR.
 */
export type LineBreak = "\n" | "\r\n"

export function lineBreakOf(text: string): LineBreak {
  let breaks = 0
  let withCarriageReturn = 0
  for (const [found] of text.matchAll(/\r\n|\r|\n/g)) {
    breaks += 1
    if (found !== "\n") withCarriageReturn += 1
  }
  return withCarriageReturn > breaks / 2 ? "\r\n" : "\n"
}

/**
 * The length of a document's text joined with `lineBreak`, without joining
 * it: CodeMirror counts every line break as one character.
 */
export function joinedLength(
  doc: { length: number; lines: number },
  lineBreak: LineBreak
): number {
  return doc.length + (lineBreak.length - 1) * (doc.lines - 1)
}
