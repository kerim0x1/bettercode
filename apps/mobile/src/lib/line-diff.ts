/**
 * A line diff of two texts as a unified diff, the way `git diff` prints it:
 * the file header, three lines of context, a changed line's removal before
 * its addition, and changes at most six unchanged lines apart in one hunk.
 * The demo's repositories diff their trees with it, and the editor shows
 * the desktop's version of a file against the phone's with it.
 */

const CONTEXT_LINES = 3

export function linesOf(text: string): string[] {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

type Edit = { kind: "same" | "remove" | "add"; line: string }

/** The shortest edit from `before` to `after`, by longest common subsequence. */
function lineEdits(before: string[], after: string[]): Edit[] {
  const rows = before.length + 1
  const columns = after.length + 1
  const common = new Uint32Array(rows * columns)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      common[i * columns + j] =
        before[i] === after[j]
          ? common[(i + 1) * columns + j + 1]! + 1
          : Math.max(
              common[(i + 1) * columns + j]!,
              common[i * columns + j + 1]!
            )
    }
  }
  const edits: Edit[] = []
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      edits.push({ kind: "same", line: before[i]! })
      i += 1
      j += 1
    } else if (
      j < after.length &&
      (i === before.length ||
        // On a tie the removal goes first, as git prints a replaced line.
        common[i * columns + j + 1]! > common[(i + 1) * columns + j]!)
    ) {
      edits.push({ kind: "add", line: after[j]! })
      j += 1
    } else {
      edits.push({ kind: "remove", line: before[i]! })
      i += 1
    }
  }
  return edits
}

/** One file's unified diff, as `git diff` prints it; "" when nothing changed. */
export function unifiedFileDiff(
  path: string,
  before: string | undefined,
  after: string | undefined
): string {
  if (before === after) return ""
  const edits = lineEdits(linesOf(before ?? ""), linesOf(after ?? ""))
  const header = [`diff --git a/${path} b/${path}`]
  if (before === undefined) header.push("new file mode 100644")
  if (after === undefined) header.push("deleted file mode 100644")
  header.push(before === undefined ? "--- /dev/null" : `--- a/${path}`)
  header.push(after === undefined ? "+++ /dev/null" : `+++ b/${path}`)

  // One hunk while at most twice the context lies between changes, as in git.
  const changed = edits.flatMap((edit, index) =>
    edit.kind === "same" ? [] : [index]
  )
  const groups: Array<[number, number]> = []
  for (const index of changed) {
    const last = groups.at(-1)
    if (last && index - last[1] - 1 <= CONTEXT_LINES * 2) last[1] = index
    else groups.push([index, index])
  }

  const hunks: string[] = []
  for (const [first, last] of groups) {
    const start = Math.max(0, first - CONTEXT_LINES)
    const end = Math.min(edits.length - 1, last + CONTEXT_LINES)
    let oldLine = 1
    let newLine = 1
    for (const edit of edits.slice(0, start)) {
      if (edit.kind !== "add") oldLine += 1
      if (edit.kind !== "remove") newLine += 1
    }
    const body = edits.slice(start, end + 1)
    const oldCount = body.filter((edit) => edit.kind !== "add").length
    const newCount = body.filter((edit) => edit.kind !== "remove").length
    // Git numbers an empty side by the line before it.
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine
    const newStart = newCount === 0 ? newLine - 1 : newLine
    hunks.push(
      `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      ...body.map(
        (edit) =>
          `${edit.kind === "same" ? " " : edit.kind === "add" ? "+" : "-"}${edit.line}`
      )
    )
  }
  return `${[...header, ...hunks].join("\n")}\n`
}
