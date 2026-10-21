/**
 * Recovers a file's content from before an agent turn by reversing that
 * file's section of the turn's checkpoint diff (`git diff base after`).
 *
 * The renderer has no copy of a file from before an edit: tool events arrive
 * while or after the provider writes, and its automatic snapshots are read
 * at the end of the turn. The backend's per-turn Git checkpoints do hold the
 * before state, and their diff can be fetched, so "Reject" in the file
 * changes bar reverses that diff against the file as it is now — what
 * `git apply -R` does, limited to one file and without fuzz.
 */

export type PreTurnFileState =
  | { kind: "content"; content: string }
  /** The turn created the file. */
  | { kind: "absent" }

interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  oldLines: string[]
  newLines: string[]
  oldNoEol: boolean
  newNoEol: boolean
}

interface FilePatch {
  /** From the `diff --git` line; the fallback when there are no ---/+++ lines. */
  gitPath: string | null
  oldPath: string | null
  newPath: string | null
  created: boolean
  deleted: boolean
  binary: boolean
  renamed: boolean
  hunks: Hunk[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
}

/** Undoes Git's C-style path quoting (`core.quotePath`). */
function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value
  }
  const encoder = new TextEncoder()
  const bytes: number[] = []
  const body = value.slice(1, -1)
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (char !== "\\") {
      bytes.push(...encoder.encode(char))
      continue
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1))
    const next = body[index + 1] ?? ""
    if (octal) {
      bytes.push(parseInt(octal[0], 8))
      index += 3
    } else if (next in SIMPLE_ESCAPES) {
      bytes.push(SIMPLE_ESCAPES[next]!)
      index += 1
    } else {
      bytes.push(92)
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "")
}

function headerPath(value: string): string | null {
  // A tab may separate the path from a timestamp in non-Git patches.
  const path = unquoteGitPath(value.split("\t")[0]!.trim())
  if (!path || path === "/dev/null") return null
  return stripPrefix(path)
}

function diffGitPath(body: string): string | null {
  if (body.startsWith('"')) {
    const tokens = body.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? []
    const last = tokens.at(-1)
    return last ? stripPrefix(unquoteGitPath(last)) : null
  }
  const samePath = /^a\/(.+) b\/\1$/.exec(body)
  if (samePath) return samePath[1]!
  const boundary = body.lastIndexOf(" b/")
  return boundary >= 0 ? body.slice(boundary + 3) : null
}

function parsePatches(unifiedDiff: string): FilePatch[] {
  const patches: FilePatch[] = []
  let current: FilePatch | null = null
  let hunk: Hunk | null = null
  let lastSide: "old" | "new" | "both" | null = null

  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = {
        gitPath: diffGitPath(line.slice("diff --git ".length)),
        oldPath: null,
        newPath: null,
        created: false,
        deleted: false,
        binary: false,
        renamed: false,
        hunks: [],
      }
      patches.push(current)
      hunk = null
      continue
    }
    if (!current) continue

    const header = HUNK_HEADER.exec(line)
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        oldLines: [],
        newLines: [],
        oldNoEol: false,
        newNoEol: false,
      }
      current.hunks.push(hunk)
      lastSide = null
      continue
    }

    if (hunk) {
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" applies to the line before it.
        if (lastSide === "old" || lastSide === "both") hunk.oldNoEol = true
        if (lastSide === "new" || lastSide === "both") hunk.newNoEol = true
        continue
      }
      const complete =
        hunk.oldLines.length >= hunk.oldCount &&
        hunk.newLines.length >= hunk.newCount
      const marker = line[0]
      if (!complete && (marker === " " || marker === "-" || marker === "+")) {
        const text = line.slice(1)
        if (marker !== "+") hunk.oldLines.push(text)
        if (marker !== "-") hunk.newLines.push(text)
        lastSide = marker === " " ? "both" : marker === "-" ? "old" : "new"
        continue
      }
      hunk = null
    }

    if (line.startsWith("--- ")) {
      current.oldPath = headerPath(line.slice(4))
      if (current.oldPath === null) current.created = true
    } else if (line.startsWith("+++ ")) {
      current.newPath = headerPath(line.slice(4))
      if (current.newPath === null) current.deleted = true
    } else if (line.startsWith("new file mode")) {
      current.created = true
    } else if (line.startsWith("deleted file mode")) {
      current.deleted = true
    } else if (
      line.startsWith("Binary files ") ||
      line === "GIT binary patch"
    ) {
      current.binary = true
    } else if (
      line.startsWith("rename from ") ||
      line.startsWith("copy from ")
    ) {
      current.renamed = true
    }
  }
  return patches
}

function patchPath(patch: FilePatch): string | null {
  return patch.newPath ?? patch.oldPath ?? patch.gitPath
}

/**
 * The section for `relativePath`. Git prints paths relative to the
 * repository root, so a project inside a larger repository matches on a
 * unique path suffix.
 */
function findPatch(
  patches: FilePatch[],
  relativePath: string
): FilePatch | null {
  const wanted = relativePath.replace(/\\/g, "/").replace(/^\.\//, "")
  if (!wanted) return null
  const exact = patches.filter((patch) => patchPath(patch) === wanted)
  if (exact.length > 0) return exact.length === 1 ? exact[0]! : null
  const suffix = patches.filter((patch) =>
    patchPath(patch)?.endsWith(`/${wanted}`)
  )
  return suffix.length === 1 ? suffix[0]! : null
}

function splitLines(content: string): { lines: string[]; eol: boolean } {
  if (content === "") return { lines: [], eol: false }
  const eol = content.endsWith("\n")
  return { lines: (eol ? content.slice(0, -1) : content).split("\n"), eol }
}

function joinLines(lines: readonly string[], eol: boolean): string {
  const body = lines.join("\n")
  return eol && lines.length > 0 ? `${body}\n` : body
}

function sameLines(
  lines: readonly string[],
  start: number,
  expected: readonly string[]
): boolean {
  if (start < 0 || start + expected.length > lines.length) return false
  return expected.every((line, offset) => lines[start + offset] === line)
}

/**
 * The file's state before the turn, given the turn's unified diff and the
 * file's current content (`null` when it does not exist). Returns null when
 * the diff has no usable section for the file (missing, binary, renamed,
 * cut off) or the file no longer matches what the turn left behind.
 */
export function preTurnFileState(
  unifiedDiff: string,
  relativePath: string,
  currentContent: string | null
): PreTurnFileState | null {
  const patch = findPatch(parsePatches(unifiedDiff), relativePath)
  if (!patch || patch.binary || patch.renamed) return null
  // A diff cut off by the backend's size bound leaves a short hunk.
  const truncated = patch.hunks.some(
    (hunk) =>
      hunk.oldLines.length !== hunk.oldCount ||
      hunk.newLines.length !== hunk.newCount
  )
  if (truncated) return null

  if (patch.deleted) {
    if (currentContent !== null || patch.hunks.length > 1) return null
    const hunk = patch.hunks[0]
    return {
      kind: "content",
      content: hunk ? joinLines(hunk.oldLines, !hunk.oldNoEol) : "",
    }
  }

  if (currentContent === null) return null
  const current = splitLines(currentContent)

  if (patch.created) {
    if (patch.hunks.length > 1) return null
    const hunk = patch.hunks[0]
    // An empty new file has no hunk.
    const expected = hunk?.newLines ?? []
    return current.lines.length === expected.length &&
      sameLines(current.lines, 0, expected)
      ? { kind: "absent" }
      : null
  }

  const hunks = [...patch.hunks].sort(
    (left, right) => left.newStart - right.newStart
  )
  const result: string[] = []
  let cursor = 0
  let oldNoEol = false
  let newNoEol = false
  for (const hunk of hunks) {
    // `+N,0` names the line the (empty) new side follows.
    const start = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1
    if (start < cursor || !sameLines(current.lines, start, hunk.newLines))
      return null
    result.push(...current.lines.slice(cursor, start), ...hunk.oldLines)
    cursor = start + hunk.newLines.length
    oldNoEol ||= hunk.oldNoEol
    newNoEol ||= hunk.newNoEol
  }
  result.push(...current.lines.slice(cursor))

  if (newNoEol && current.eol) return null
  // The final newline only changed where a hunk marks it.
  const eol = oldNoEol ? false : newNoEol ? true : current.eol
  return { kind: "content", content: joinLines(result, eol) }
}
