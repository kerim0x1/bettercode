import type {
  DirectoryEntry,
  DirectoryResult,
  FileSearchResult,
} from "@/types/remote"
import { RemoteApiError } from "../live/http"
import type {
  ContentSearchOptions,
  ContentSearchResult,
  FileContent,
} from "../types"
import type { DemoGit } from "./git"
import { sha256Hex } from "./sha256"

/**
 * The demo projects' files: each project's git working tree (DemoGit) and
 * the folders in it, so the file browser, the editor and source control see
 * the same files. Paths inside a project use "/". Refusals come as the
 * desktop sends them to a phone: a status, its code, and the route's
 * generic words.
 */

const MATCHES_PER_FILE = 8

function parentOf(relative: string): string {
  const slash = relative.lastIndexOf("/")
  return slash === -1 ? "" : relative.slice(0, slash)
}

function nameOf(relative: string): string {
  return relative.slice(relative.lastIndexOf("/") + 1)
}

/** The desktop refuses paths that leave the project or name nothing. */
function checkedPath(relative: string, operation: string): string {
  const parts = relative.replace(/\\/g, "/").split("/")
  if (
    !relative.trim() ||
    relative.startsWith("/") ||
    /^[a-z]:/i.test(relative) ||
    parts.some((part) => part === ".." || part === "")
  ) {
    throw new RemoteApiError(`${operation} failed`, 400)
  }
  return parts.join("/")
}

/** A comma-separated glob list as the desktop's search takes it. */
function globMatcher(patterns: string): ((path: string) => boolean) | null {
  const globs = patterns
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean)
  if (globs.length === 0) return null
  const expressions = globs.map((glob) => {
    let source = ""
    for (let index = 0; index < glob.length; index += 1) {
      const character = glob[index]!
      if (character === "*" && glob[index + 1] === "*") {
        // "**/" is any folders, or none; "**" elsewhere is anything.
        const folders = glob[index + 2] === "/"
        index += folders ? 2 : 1
        source += folders ? "(?:.*/)?" : ".*"
      } else if (character === "*") {
        source += "[^/]*"
      } else if (character === "?") {
        source += "[^/]"
      } else {
        source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      }
    }
    // A pattern without a folder matches a file's name anywhere.
    return glob.includes("/")
      ? new RegExp(`^${source}$`)
      : new RegExp(`(?:^|/)${source}$`)
  })
  return (path) => expressions.some((expression) => expression.test(path))
}

const isWordChar = (character: string | undefined) =>
  character !== undefined && /[A-Za-z0-9_]/.test(character)

/** The desktop's preview: the line with tabs widened, trimmed, cut when long. */
function preview(line: string, index: number, length: number) {
  const normalized = line.replace(/\t/g, "  ").trimEnd()
  const column = line.slice(0, index).replace(/\t/g, "  ").length
  const matchLength = Math.max(
    1,
    line.slice(index, index + length).replace(/\t/g, "  ").length
  )
  if (normalized.length <= 220) {
    const text = normalized.trimStart()
    const trimmed = normalized.length - text.length
    return {
      text,
      previewColumn: Math.max(1, column - trimmed + 1),
      previewLength: matchLength,
    }
  }
  const start = Math.max(0, column - 80)
  const end = Math.min(normalized.length, column + matchLength + 120)
  const prefix = start > 0 ? "..." : ""
  return {
    text: `${prefix}${normalized.slice(start, end)}${end < normalized.length ? "..." : ""}`,
    previewColumn: column - start + prefix.length + 1,
    previewLength: matchLength,
  }
}

export class DemoFiles {
  /** Folders a project has besides those its files imply (empty ones). */
  private readonly folders = new Map<string, Set<string>>()

  constructor(
    private readonly git: DemoGit,
    seed: Record<string, Record<string, string | null>>,
    private readonly now: () => Date
  ) {
    for (const [root, entries] of Object.entries(seed)) {
      this.folders.set(
        root,
        new Set(
          Object.entries(entries)
            .filter(([, content]) => content === null)
            .map(([path]) => path)
        )
      )
    }
  }

  private rootOf(path: string): string | undefined {
    return this.git
      .roots()
      .find((root) => path === root || path.startsWith(`${root}/`))
  }

  private tree(root: string): Map<string, string> {
    const tree = this.git.worktreeOf(root)
    if (!tree) throw new Error("Folder not found.")
    return tree
  }

  private foldersOf(root: string): Set<string> {
    let folders = this.folders.get(root)
    if (!folders) {
      folders = new Set()
      this.folders.set(root, folders)
    }
    return folders
  }

  /** Every folder: the empty ones and those holding files. */
  private allFolders(root: string): Set<string> {
    const all = new Set<string>()
    const addWithParents = (folder: string) => {
      for (let current = folder; current; current = parentOf(current)) {
        all.add(current)
      }
    }
    for (const folder of this.foldersOf(root)) addWithParents(folder)
    for (const file of this.tree(root).keys()) addWithParents(parentOf(file))
    return all
  }

  private isFolder(root: string, relative: string): boolean {
    return this.allFolders(root).has(relative)
  }

  list(path: string): DirectoryResult {
    const root = this.rootOf(path)
    if (!root) throw new Error("Folder not found.")
    const folder = path === root ? "" : path.slice(root.length + 1)
    if (folder && !this.isFolder(root, folder)) {
      throw new Error("Folder not found.")
    }
    const modified = this.now().getTime()
    const folders = [...this.allFolders(root)].filter(
      (candidate) => parentOf(candidate) === folder
    )
    const files = [...this.tree(root).entries()].filter(
      ([file]) => parentOf(file) === folder
    )
    const entries: DirectoryEntry[] = [
      ...folders.map((relative) => ({
        name: nameOf(relative),
        path: `${root}/${relative}`,
        isDir: true,
        isSymlink: false,
        size: null,
        mtime: modified,
      })),
      ...files.map(([relative, content]) => ({
        name: nameOf(relative),
        path: `${root}/${relative}`,
        isDir: false,
        isSymlink: false,
        size: new TextEncoder().encode(content).length,
        mtime: modified,
      })),
    ].sort(
      (a, b) =>
        Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)
    )
    return {
      path,
      parent:
        path === root
          ? null
          : `${root}${folder.includes("/") ? `/${parentOf(folder)}` : ""}`,
      entries,
      truncated: false,
    }
  }

  searchNames(root: string, needle: string, limit: number): FileSearchResult {
    const lower = needle.toLowerCase()
    const candidates = [
      ...[...this.allFolders(root)].map((relative) => ({
        relative,
        isDir: true,
      })),
      ...[...this.tree(root).keys()].map((relative) => ({
        relative,
        isDir: false,
      })),
    ].sort((a, b) => a.relative.localeCompare(b.relative))
    const entries = candidates
      .filter(({ relative }) => relative.toLowerCase().includes(lower))
      .slice(0, limit)
      .map(({ relative, isDir }, index) => ({
        path: `${root}/${relative}`,
        name: nameOf(relative),
        isDir,
        score: 1_000 - index,
      }))
    return { entries, truncated: false, tookMs: 1 }
  }

  read(root: string, absolutePath: string): FileContent {
    const relative = absolutePath.slice(root.length + 1)
    const content = this.git.worktreeOf(root)?.get(relative)
    if (content === undefined) throw new Error("File not found.")
    return {
      content,
      path: absolutePath,
      sha256: sha256Hex(content),
      size: new TextEncoder().encode(content).length,
      isUtf8: true,
    }
  }

  write(
    root: string,
    relativePath: string,
    contents: string,
    expectedSha256?: string | null
  ): void {
    const relative = checkedPath(relativePath, "workspace write")
    const tree = this.tree(root)
    if (this.isFolder(root, relative)) {
      throw new RemoteApiError(
        "workspace write failed",
        409,
        "WORKSPACE_PATH_CHANGED"
      )
    }
    const current = tree.get(relative)
    if (expectedSha256 !== undefined) {
      const matches =
        expectedSha256 === null
          ? current === undefined
          : current !== undefined && sha256Hex(current) === expectedSha256
      if (!matches) {
        throw new RemoteApiError(
          "workspace write failed",
          409,
          "WORKSPACE_PATH_CHANGED"
        )
      }
    }
    tree.set(relative, contents)
  }

  createFolder(root: string, relativePath: string): void {
    const relative = checkedPath(relativePath, "workspace mkdir")
    if (this.tree(root).has(relative)) {
      throw new RemoteApiError("workspace mkdir failed", 409, "EEXIST")
    }
    this.foldersOf(root).add(relative)
  }

  move(root: string, fromRelativePath: string, toRelativePath: string): void {
    const from = checkedPath(fromRelativePath, "workspace move")
    const to = checkedPath(toRelativePath, "workspace move")
    const tree = this.tree(root)
    const folder = this.isFolder(root, from)
    if (!folder && !tree.has(from)) {
      throw new RemoteApiError("workspace move failed", 404)
    }
    if (from === to) return
    if (tree.has(to) || this.isFolder(root, to)) {
      throw new RemoteApiError("workspace move failed", 409, "EEXIST")
    }
    if (!folder) {
      tree.set(to, tree.get(from)!)
      tree.delete(from)
      return
    }
    if (to.startsWith(`${from}/`)) {
      throw new RemoteApiError("workspace move failed", 400)
    }
    const moved = (path: string) => `${to}${path.slice(from.length)}`
    for (const [file, content] of [...tree.entries()]) {
      if (file.startsWith(`${from}/`)) {
        tree.set(moved(file), content)
        tree.delete(file)
      }
    }
    const folders = this.foldersOf(root)
    for (const candidate of [...folders]) {
      if (candidate === from || candidate.startsWith(`${from}/`)) {
        folders.delete(candidate)
        folders.add(moved(candidate))
      }
    }
  }

  delete(root: string, relativePath: string, recursive: boolean): void {
    const relative = checkedPath(relativePath, "workspace delete")
    const tree = this.tree(root)
    if (tree.delete(relative)) return
    if (!this.isFolder(root, relative)) {
      throw new RemoteApiError("workspace delete failed", 404)
    }
    const inside = (path: string) => path.startsWith(`${relative}/`)
    const files = [...tree.keys()].filter(inside)
    const folders = this.foldersOf(root)
    const subfolders = [...folders].filter(inside)
    if (!recursive && (files.length > 0 || subfolders.length > 0)) {
      throw new RemoteApiError("workspace delete failed", 500)
    }
    for (const file of files) tree.delete(file)
    for (const folder of subfolders) folders.delete(folder)
    folders.delete(relative)
  }

  /** The desktop's content search: literal or regex, case, whole word, globs. */
  searchContent(
    root: string,
    query: string,
    options: ContentSearchOptions = {}
  ): ContentSearchResult {
    const needle = query.trim()
    if (!needle)
      throw new RemoteApiError("workspace content search failed", 400)
    let expression: RegExp
    try {
      expression = new RegExp(
        options.regex ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        options.caseSensitive ? "g" : "gi"
      )
    } catch {
      throw new RemoteApiError("workspace content search failed", 400)
    }
    const include = globMatcher(options.include ?? "")
    const exclude = globMatcher(options.exclude ?? "")
    let remaining = options.limit ?? 200
    const results: ContentSearchResult["results"] = []
    const files = [...this.tree(root).entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )
    for (const [path, content] of files) {
      if (remaining <= 0) break
      if (include && !include(path)) continue
      if (exclude?.(path)) continue
      const matches: ContentSearchResult["results"][number]["matches"] = []
      const lines = content.split(/\r\n|\r|\n/g)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ""
        expression.lastIndex = 0
        for (
          let match = expression.exec(line);
          match;
          match = expression.exec(line)
        ) {
          const text = match[0] ?? ""
          const whole =
            !options.wholeWord ||
            (!isWordChar(line[match.index - 1]) &&
              !isWordChar(line[match.index + text.length]))
          if (whole) {
            const shown = preview(line, match.index, text.length)
            matches.push({
              line: index + 1,
              column: match.index + 1,
              length: Math.max(text.length, 1),
              previewColumn: shown.previewColumn,
              previewLength: shown.previewLength,
              preview: shown.text,
            })
          }
          if (text.length === 0) expression.lastIndex = match.index + 1
          if (matches.length >= Math.min(MATCHES_PER_FILE, remaining)) {
            break
          }
        }
        if (matches.length >= Math.min(MATCHES_PER_FILE, remaining)) break
      }
      if (matches.length > 0) {
        results.push({ path, name: nameOf(path), matches })
        remaining -= matches.length
      }
    }
    return { results, truncated: remaining <= 0 }
  }
}
