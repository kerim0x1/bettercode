export interface DiffLine {
  type: "add" | "remove" | "context" | "header"
  content: string
  oldNum?: number
  newNum?: number
  hunkIndex?: number
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
  /** Exact single-hunk patch, including the file header. */
  patch: string
}

export interface DiffFile {
  name: string
  additions: number
  deletions: number
  lines: DiffLine[]
  hunks: DiffHunk[]
  isBinary: boolean
  isNew: boolean
  isDeleted: boolean
  rawText: string
}

export interface SplitDiffLine {
  left: DiffLine | null
  right: DiffLine | null
}

function withFinalNewline(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/\n+$/g, "")
  return normalized.length > 0 ? `${normalized}\n` : ""
}

/**
 * Split one file patch into independently applicable hunks. Each result keeps
 * the complete file header because `git apply` cannot safely apply a bare
 * `@@` block.
 */
export function extractGitHunkPatches(filePatch: string): string[] {
  const lines = withFinalNewline(filePatch).split("\n")
  if (lines.at(-1) === "") lines.pop()

  const hunkStarts: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("@@ ")) hunkStarts.push(index)
  }
  if (hunkStarts.length === 0) return []

  // A full-file `index old..new` target hash describes every hunk together.
  // Keeping it on a single-hunk patch can make Git reject an otherwise valid
  // partial application because the partial result cannot equal that full
  // target blob.
  const header = lines
    .slice(0, hunkStarts[0])
    .filter((line) => !line.startsWith("index "))
  return hunkStarts.map((start, index) => {
    const end = hunkStarts[index + 1] ?? lines.length
    return withFinalNewline([...header, ...lines.slice(start, end)].join("\n"))
  })
}

export function parseGitDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  if (!text) return files

  const chunks = text
    .replace(/\r\n?/g, "\n")
    .split(/^diff --git /m)
    .filter(Boolean)
  for (const chunk of chunks) {
    const rawText = withFinalNewline(`diff --git ${chunk}`)
    const lines = rawText.split("\n")
    // The patch terminator is not an extra source line. Blank context lines
    // carry a leading space and remain in the diff.
    if (lines.at(-1) === "") lines.pop()
    const headerMatch = lines[0]?.match(/a\/(.+?) b\//)
    const name = headerMatch?.[1] || "unknown"
    const diffLines: DiffLine[] = []
    const hunks: DiffHunk[] = []
    const hunkPatches = extractGitHunkPatches(rawText)
    let additions = 0
    let deletions = 0
    let oldNum = 0
    let newNum = 0
    let currentHunkIdx = -1

    const isBinary = lines.some((line) => line.includes("Binary files"))
    const isNew = lines.some((line) => line.startsWith("new file mode"))
    const isDeleted = lines.some((line) => line.startsWith("deleted file mode"))

    for (const line of lines.slice(1)) {
      if (line.startsWith("@@")) {
        const match = line.match(
          /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/
        )
        oldNum = Number.parseInt(match?.[1] || "0", 10)
        newNum = Number.parseInt(match?.[3] || "0", 10)
        currentHunkIdx += 1
        hunks.push({
          header: line,
          oldStart: oldNum,
          oldCount: Number.parseInt(match?.[2] || "1", 10),
          newStart: newNum,
          newCount: Number.parseInt(match?.[4] || "1", 10),
          lines: [],
          patch: hunkPatches[currentHunkIdx] ?? "",
        })
        diffLines.push({
          type: "header",
          content: line,
          hunkIndex: currentHunkIdx,
        })
      } else if (currentHunkIdx >= 0 && line.startsWith("+")) {
        additions += 1
        const diffLine: DiffLine = {
          type: "add",
          content: line.slice(1),
          newNum: newNum++,
          hunkIndex: currentHunkIdx,
        }
        diffLines.push(diffLine)
        hunks[currentHunkIdx]?.lines.push(diffLine)
      } else if (currentHunkIdx >= 0 && line.startsWith("-")) {
        deletions += 1
        const diffLine: DiffLine = {
          type: "remove",
          content: line.slice(1),
          oldNum: oldNum++,
          hunkIndex: currentHunkIdx,
        }
        diffLines.push(diffLine)
        hunks[currentHunkIdx]?.lines.push(diffLine)
      } else if (
        currentHunkIdx >= 0 &&
        !line.startsWith("\\") &&
        !line.startsWith("+++") &&
        !line.startsWith("---") &&
        !line.startsWith("index")
      ) {
        const diffLine: DiffLine = {
          type: "context",
          content: line.startsWith(" ") ? line.slice(1) : line,
          oldNum: oldNum++,
          newNum: newNum++,
          hunkIndex: currentHunkIdx,
        }
        diffLines.push(diffLine)
        hunks[currentHunkIdx]?.lines.push(diffLine)
      }
    }

    if (diffLines.length > 0 || isBinary) {
      files.push({
        name,
        additions,
        deletions,
        lines: diffLines,
        hunks,
        isBinary,
        isNew,
        isDeleted,
        rawText,
      })
    }
  }
  return files
}

export function buildSplitDiffLines(lines: DiffLine[]): SplitDiffLine[] {
  const result: SplitDiffLine[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.type === "header" || line.type === "context") {
      result.push({ left: line, right: line })
      index += 1
    } else if (line.type === "remove") {
      const removes: DiffLine[] = []
      while (index < lines.length && lines[index]?.type === "remove") {
        removes.push(lines[index]!)
        index += 1
      }
      const adds: DiffLine[] = []
      while (index < lines.length && lines[index]?.type === "add") {
        adds.push(lines[index]!)
        index += 1
      }
      const rowCount = Math.max(removes.length, adds.length)
      for (let row = 0; row < rowCount; row += 1) {
        result.push({
          left: removes[row] ?? null,
          right: adds[row] ?? null,
        })
      }
    } else if (line.type === "add") {
      result.push({ left: null, right: line })
      index += 1
    } else {
      index += 1
    }
  }
  return result
}
