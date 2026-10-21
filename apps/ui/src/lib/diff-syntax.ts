import type { BundledLanguage, ThemedToken } from "shiki"
import { buildSplitDiffLines, type DiffFile, type DiffLine } from "./git-diff"
import { getHighlighter } from "./shiki-highlighter"

const languages: Record<string, BundledLanguage> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  md: "markdown",
  mdx: "mdx",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  svg: "xml",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  sh: "shellscript",
  bash: "shellscript",
  ps1: "powershell",
  psm1: "powershell",
  sql: "sql",
  php: "php",
  rb: "ruby",
  lua: "lua",
  swift: "swift",
  kt: "kotlin",
  dart: "dart",
  graphql: "graphql",
  gql: "graphql",
  ini: "ini",
}
export function diffLanguage(path: string): BundledLanguage | null {
  const name = path.split(/[/\\]/).pop()?.toLowerCase() ?? ""
  if (name === "dockerfile") return "dockerfile"
  if (name === "makefile") return "makefile"
  return languages[name.split(".").pop() ?? ""] ?? null
}

export interface DiffSyntax {
  old: Map<DiffLine, ThemedToken[]>
  new: Map<DiffLine, ThemedToken[]>
}

export async function highlightDiff(file: DiffFile): Promise<DiffSyntax> {
  const result: DiffSyntax = { old: new Map(), new: new Map() }
  const language = diffLanguage(file.name)
  // Large/generated patches stay fully readable without blocking the UI on a
  // grammar pass. Only the selected file loads the existing Shiki dependency.
  if (
    !language ||
    file.isBinary ||
    file.rawText.length > 100_000 ||
    file.lines.length > 2000 ||
    file.lines.some((line) => line.content.length > 5000)
  )
    return result
  // Shares the renderer-wide highlighter with chat code blocks (PERF-08).
  const { highlighter, language: lang } = await getHighlighter({
    language,
    themes: ["light-plus", "dark-plus"],
  })
  if (lang === "text") return result
  for (const hunk of file.hunks) {
    // Tokenize each revision separately so removed comments/strings cannot
    // leak grammar state into the new code. Disjoint hunks reset that state.
    for (const side of ["old", "new"] as const) {
      const lines = hunk.lines.filter(
        (line) =>
          line.type === "context" ||
          line.type === (side === "old" ? "remove" : "add")
      )
      if (!lines.length) continue
      const { tokens } = highlighter.codeToTokens(
        lines.map((line) => line.content).join("\n"),
        {
          lang,
          themes: { light: "light-plus", dark: "dark-plus" },
        }
      )
      lines.forEach((line, index) =>
        result[side].set(line, tokens[index] ?? [])
      )
    }
  }
  return result
}

export interface ChangedRange {
  start: number
  end: number
}

/** Mark the changed middle of paired lines, keeping Unicode characters intact. */
export function diffChangedRanges(
  lines: DiffLine[]
): Map<DiffLine, ChangedRange> {
  const ranges = new Map<DiffLine, ChangedRange>()
  for (const { left, right } of buildSplitDiffLines(lines)) {
    if (
      left?.type !== "remove" ||
      right?.type !== "add" ||
      left.content === right.content
    )
      continue
    if (left.content.length > 5000 || right.content.length > 5000) continue
    const a = Array.from(left.content),
      b = Array.from(right.content)
    let start = 0,
      tail = 0
    while (start < a.length && start < b.length && a[start] === b[start])
      start++
    while (
      tail < a.length - start &&
      tail < b.length - start &&
      a[a.length - 1 - tail] === b[b.length - 1 - tail]
    )
      tail++
    const offset = a.slice(0, start).join("").length
    ranges.set(left, {
      start: offset,
      end: left.content.length - a.slice(a.length - tail).join("").length,
    })
    ranges.set(right, {
      start: offset,
      end: right.content.length - b.slice(b.length - tail).join("").length,
    })
  }
  return ranges
}
