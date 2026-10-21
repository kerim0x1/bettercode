import fs from "node:fs"
import path from "node:path"
import {
  DESKTOP_CONFIG_LIMITS,
  desktopConfigEntryIdSchema,
} from "@betterc0de/schema/http-contracts"
import {
  RUNTIME_HOOK_LIMITS,
  RUNTIME_MCP_LIMITS,
} from "@betterc0de/schema/runtime-records"
import type { ServerConfig } from "../../config"
import { HttpError } from "../../errors"
import {
  ABSENT_REVISION,
  UnsafeConfigFileError,
  backUpUnreadableFile,
  readRegularFile,
  revisionOf,
  withFileLock,
  writeFileAtomic,
} from "./files"
import {
  desktopConfigPaths,
  runtimeHomeOf,
  type DesktopConfigPaths,
} from "./paths"

export { desktopConfigPaths, runtimeHomeOf, type DesktopConfigPaths }

/**
 * The desktop configuration in the runtime home, owned by this backend:
 *
 * - `mcp-servers.json` and `hooks.json`: JSON arrays of entries with a
 *   unique string `id` (records: `@betterc0de/schema/runtime-records`),
 * - `rules.md`: the user's own rules,
 * - `skills/<id>/` (`manifest.json` + `content.md`) and `subagents/<id>/`
 *   (`manifest.json` + `prompt.md`).
 *
 * The desktop's main process reads and writes them only through
 * `/api/v1/config/*` (http/routes/desktopConfig.ts); turn preparation, the
 * MCP resolver and the rules resolution read them from here. Writes replace
 * a file atomically under its lock (files.ts), and an array document can be
 * written against the revision it was computed from, so two writers cannot
 * silently drop each other's change. Entries are stored exactly as given:
 * approval markers, `enc:v1:` secrets and origin fields (`scope`,
 * `projectRoot`) pass through unchanged.
 */

/** An entry of `mcp-servers.json` or `hooks.json` as stored. */
export type StoredEntry = { readonly id: string } & Readonly<
  Record<string, unknown>
>

export interface StoredDocument {
  readonly entries: StoredEntry[]
  readonly revision: string
  /** Why an existing file could not be read as a list of entries. */
  readonly problem?: string
}

export interface StoredText {
  readonly content: string
  readonly revision: string
}

export type DirectoryKind = "skills" | "subagents"

export interface StoredDirectoryEntry {
  readonly id: string
  readonly manifest: Record<string, unknown>
  /** `content.md` of a skill, `prompt.md` of a subagent. */
  readonly text: string
}

type DocumentKind = "mcp" | "hooks"

const DOCUMENTS: Record<
  DocumentKind,
  {
    readonly label: string
    readonly maxEntries: number
    readonly maxBytes: number
  }
> = {
  mcp: {
    label: "mcp-servers.json",
    maxEntries: RUNTIME_MCP_LIMITS.maxServers,
    maxBytes: RUNTIME_MCP_LIMITS.maxStoreBytes,
  },
  hooks: {
    label: "hooks.json",
    maxEntries: RUNTIME_HOOK_LIMITS.maxHooks,
    maxBytes: RUNTIME_HOOK_LIMITS.maxFileBytes,
  },
}

const DIRECTORY_TEXT_FILES: Record<DirectoryKind, string> = {
  skills: "content.md",
  subagents: "prompt.md",
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isJson(bytes: Buffer): boolean {
  try {
    JSON.parse(bytes.toString("utf8"))
    return true
  } catch {
    return false
  }
}

/** The entries of a document's bytes, or the reason they are not usable. */
function parseEntries(
  bytes: Buffer,
  maxEntries: number
): { entries: StoredEntry[] } | { problem: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    return { problem: "it is not valid JSON" }
  }
  return validateEntries(parsed, maxEntries)
}

function validateEntries(
  value: unknown,
  maxEntries: number
): { entries: StoredEntry[] } | { problem: string } {
  if (!Array.isArray(value)) return { problem: "it is not a list of entries" }
  if (value.length > maxEntries) {
    return { problem: `it lists more than ${maxEntries} entries` }
  }
  const ids = new Set<string>()
  for (const entry of value) {
    if (!isPlainRecord(entry)) {
      return { problem: "an entry is not an object" }
    }
    const id = entry.id
    if (typeof id !== "string" || !id.trim() || ids.has(id)) {
      return { problem: "an entry has no unique id" }
    }
    ids.add(id)
  }
  return { entries: value as StoredEntry[] }
}

function conflict(label: string): HttpError {
  return new HttpError(
    409,
    `${label} changed since it was read; read it again and retry.`,
    "desktop_config_conflict"
  )
}

function assertEntryId(id: string): string {
  const parsed = desktopConfigEntryIdSchema.safeParse(id)
  if (!parsed.success) {
    throw new HttpError(400, "Invalid entry id", "desktop_config_invalid_id")
  }
  return parsed.data
}

export class DesktopConfigStore {
  readonly paths: DesktopConfigPaths

  constructor(home: string) {
    if (!path.isAbsolute(home)) {
      throw new Error("The desktop configuration folder must be absolute")
    }
    this.paths = desktopConfigPaths(path.resolve(home))
  }

  // ── mcp-servers.json, hooks.json ──────────────────────────────────────

  readMcp(): StoredDocument {
    return this.readDocument("mcp", this.paths.mcpFile)
  }

  writeMcp(
    entries: ReadonlyArray<StoredEntry>,
    expectedRevision?: string | null
  ): StoredDocument {
    return this.writeDocument(
      "mcp",
      this.paths.mcpFile,
      entries,
      expectedRevision
    )
  }

  readHooks(): StoredDocument {
    return this.readDocument("hooks", this.paths.hooksFile)
  }

  writeHooks(
    entries: ReadonlyArray<StoredEntry>,
    expectedRevision?: string | null
  ): StoredDocument {
    return this.writeDocument(
      "hooks",
      this.paths.hooksFile,
      entries,
      expectedRevision
    )
  }

  private readDocument(kind: DocumentKind, file: string): StoredDocument {
    const { maxEntries, maxBytes } = DOCUMENTS[kind]
    let bytes: Buffer | null
    try {
      bytes = readRegularFile(file, maxBytes)
    } catch (error) {
      return {
        entries: [],
        revision: ABSENT_REVISION,
        problem: error instanceof Error ? error.message : String(error),
      }
    }
    if (bytes === null) return { entries: [], revision: ABSENT_REVISION }
    const parsed = parseEntries(bytes, maxEntries)
    const revision = revisionOf(bytes)
    return "problem" in parsed
      ? {
          entries: [],
          revision,
          problem: `${DOCUMENTS[kind].label}: ${parsed.problem}`,
        }
      : { entries: parsed.entries, revision }
  }

  /**
   * Replace a document. With `expectedRevision` the write happens only if
   * the file is still at that revision (`409 desktop_config_conflict`
   * otherwise). Content that is not JSON is kept as `<file>.corrupt-<uuid>`
   * before it is replaced. JSON that is not a list of entries with unique ids,
   * a symlink and an oversized file are never replaced.
   */
  private writeDocument(
    kind: DocumentKind,
    file: string,
    entries: ReadonlyArray<StoredEntry>,
    expectedRevision: string | null | undefined
  ): StoredDocument {
    const { label, maxEntries, maxBytes } = DOCUMENTS[kind]
    const checked = validateEntries(entries, maxEntries)
    if ("problem" in checked) {
      throw new HttpError(
        400,
        `${label}: ${checked.problem}`,
        "desktop_config_invalid"
      )
    }
    const bytes = Buffer.from(JSON.stringify(checked.entries, null, 2), "utf8")
    if (bytes.length > maxBytes) {
      throw new HttpError(
        413,
        `${label} would exceed ${maxBytes} bytes`,
        "desktop_config_too_large"
      )
    }
    return withFileLock(`${file}.lock`, () => {
      const current = readRegularFile(file, maxBytes)
      if (
        expectedRevision !== undefined &&
        expectedRevision !== null &&
        expectedRevision !== revisionOf(current)
      ) {
        throw conflict(label)
      }
      if (current !== null) {
        const stored = parseEntries(current, maxEntries)
        if ("problem" in stored) {
          // JSON with entries that cannot be told apart is refused, as the
          // desktop always did; text that is not JSON is kept aside first.
          if (isJson(current)) {
            throw new UnsafeConfigFileError(file, stored.problem)
          }
          backUpUnreadableFile(file, current)
        }
      }
      writeFileAtomic(file, bytes)
      return { entries: checked.entries, revision: revisionOf(bytes) }
    })
  }

  // ── rules.md ──────────────────────────────────────────────────────────

  readRules(): StoredText {
    const bytes = readRegularFile(
      this.paths.rulesFile,
      DESKTOP_CONFIG_LIMITS.maxTextBytes
    )
    return {
      content: bytes === null ? "" : bytes.toString("utf8"),
      revision: revisionOf(bytes),
    }
  }

  writeRules(content: string, expectedRevision?: string | null): StoredText {
    const bytes = Buffer.from(content, "utf8")
    if (bytes.length > DESKTOP_CONFIG_LIMITS.maxTextBytes) {
      throw new HttpError(
        413,
        `rules.md would exceed ${DESKTOP_CONFIG_LIMITS.maxTextBytes} bytes`,
        "desktop_config_too_large"
      )
    }
    const file = this.paths.rulesFile
    return withFileLock(`${file}.lock`, () => {
      const current = readRegularFile(file, DESKTOP_CONFIG_LIMITS.maxTextBytes)
      if (
        expectedRevision !== undefined &&
        expectedRevision !== null &&
        expectedRevision !== revisionOf(current)
      ) {
        throw conflict("rules.md")
      }
      writeFileAtomic(file, bytes)
      return { content, revision: revisionOf(bytes) }
    })
  }

  // ── skills/, subagents/ ───────────────────────────────────────────────

  private directoryOf(kind: DirectoryKind): string {
    return kind === "skills" ? this.paths.skillsDir : this.paths.subagentsDir
  }

  /**
   * Every readable entry of `skills/` or `subagents/`, by folder name. A
   * folder whose manifest is missing or not a JSON object is left out, and
   * an unreadable markdown file reads as empty, as the desktop always did.
   * Symlinked folders are not followed.
   */
  listDirectory(kind: DirectoryKind): StoredDirectoryEntry[] {
    const directory = this.directoryOf(kind)
    let names: string[]
    try {
      names = fs
        .readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .slice(0, DESKTOP_CONFIG_LIMITS.maxDirectoryEntries)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === "ENOENT" || code === "ENOTDIR") return []
      throw error
    }
    return names.flatMap((name) => {
      const entry = this.readDirectoryEntry(kind, name)
      return entry ? [entry] : []
    })
  }

  getDirectoryEntry(
    kind: DirectoryKind,
    id: string
  ): StoredDirectoryEntry | null {
    return this.readDirectoryEntry(kind, assertEntryId(id))
  }

  private readDirectoryEntry(
    kind: DirectoryKind,
    name: string
  ): StoredDirectoryEntry | null {
    const entryDir = path.join(this.directoryOf(kind), name)
    try {
      const stat = fs.lstatSync(entryDir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    } catch {
      return null
    }
    let manifest: unknown
    try {
      const bytes = readRegularFile(
        path.join(entryDir, "manifest.json"),
        DESKTOP_CONFIG_LIMITS.maxManifestBytes
      )
      if (bytes === null) return null
      manifest = JSON.parse(bytes.toString("utf8"))
    } catch {
      return null
    }
    if (!isPlainRecord(manifest)) return null
    let text = ""
    try {
      text =
        readRegularFile(
          path.join(entryDir, DIRECTORY_TEXT_FILES[kind]),
          DESKTOP_CONFIG_LIMITS.maxTextBytes
        )?.toString("utf8") ?? ""
    } catch {
      text = ""
    }
    return { id: name, manifest, text }
  }

  /**
   * Write one skill or subagent: `manifest.json`, then its markdown file,
   * each replaced atomically while the entry's lock is held.
   */
  putDirectoryEntry(
    kind: DirectoryKind,
    id: string,
    manifest: Record<string, unknown>,
    text: string
  ): { id: string } {
    const safeId = assertEntryId(id)
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8")
    if (manifestBytes.length > DESKTOP_CONFIG_LIMITS.maxManifestBytes) {
      throw new HttpError(
        413,
        "The manifest is too large",
        "desktop_config_too_large"
      )
    }
    const textBytes = Buffer.from(text, "utf8")
    if (textBytes.length > DESKTOP_CONFIG_LIMITS.maxTextBytes) {
      throw new HttpError(
        413,
        "The content is too large",
        "desktop_config_too_large"
      )
    }
    const directory = this.directoryOf(kind)
    const entryDir = path.join(directory, safeId)
    fs.mkdirSync(directory, { recursive: true })
    return withFileLock(path.join(directory, `.${safeId}.lock`), () => {
      try {
        const stat = fs.lstatSync(entryDir)
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new UnsafeConfigFileError(entryDir, "it is not a folder")
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT")
          throw error
        fs.mkdirSync(entryDir, { recursive: true })
      }
      writeFileAtomic(path.join(entryDir, "manifest.json"), manifestBytes)
      writeFileAtomic(
        path.join(entryDir, DIRECTORY_TEXT_FILES[kind]),
        textBytes
      )
      return { id: safeId }
    })
  }

  /** Remove one skill or subagent folder; `false` when there was none. */
  removeDirectoryEntry(kind: DirectoryKind, id: string): boolean {
    const safeId = assertEntryId(id)
    const directory = this.directoryOf(kind)
    const entryDir = path.join(directory, safeId)
    if (!fs.existsSync(directory)) return false
    return withFileLock(path.join(directory, `.${safeId}.lock`), () => {
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(entryDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT")
          return false
        throw error
      }
      // A symlinked entry loses the link only, never what it points to.
      if (stat.isSymbolicLink()) fs.unlinkSync(entryDir)
      else fs.rmSync(entryDir, { recursive: true, force: true })
      return true
    })
  }
}

const stores = new Map<string, DesktopConfigStore>()

/** The store of `home`; one instance per folder for the whole process. */
export function desktopConfigStore(home: string): DesktopConfigStore {
  const key = path.resolve(home)
  let store = stores.get(key)
  if (!store) {
    store = new DesktopConfigStore(key)
    stores.set(key, store)
  }
  return store
}

/** The store of `config`'s runtime home, or `null` without one. */
export function desktopConfigStoreFor(
  config: Pick<ServerConfig, "dataDir" | "runtimeHome">
): DesktopConfigStore | null {
  const home = runtimeHomeOf(config)
  return home ? desktopConfigStore(home) : null
}
