import type { ConversationImportProvider } from "@betterc0de/schema"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expandHomePath } from "../../pathExpansion"
import { IMPORT_LIMITS } from "./types"

/**
 * Where the CLIs keep their sessions, and which files are there.
 *
 * Claude Code: `<config>/projects/<folder name>/<session id>.jsonl`, with
 * `<config>` from `CLAUDE_CONFIG_DIR` or `~/.claude`. Codex:
 * `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` and
 * `<home>/archived_sessions/`, with `<home>` from `CODEX_HOME` or
 * `~/.codex`. These are the same homes the default provider instances use
 * (`providerDriverInstances.ts`), so an imported session can be resumed by
 * them.
 */

export interface SessionFile {
  provider: ConversationImportProvider
  path: string
  size: number
  mtimeMs: number
  /** Codex `archived_sessions/`. */
  archived: boolean
  /** The session id in the file name. */
  idHint: string | null
}

export interface SessionRoots {
  claude: string
  codex: string
}

export function defaultSessionRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir()
): SessionRoots {
  const claude = env.CLAUDE_CONFIG_DIR?.trim()
  const codex = env.CODEX_HOME?.trim()
  return {
    claude: claude
      ? path.resolve(expandHomePath(claude))
      : path.join(home, ".claude"),
    codex: codex
      ? path.resolve(expandHomePath(codex))
      : path.join(home, ".codex"),
  }
}

/**
 * The continuation key a Claude provider instance has when it uses
 * `configRoot` (`claudeContinuationKey` in providerDriverInstances.ts):
 * the home that holds `.claude`, or the config folder itself.
 */
export function claudeContinuationKeyFor(configRoot: string): string {
  const normalized = path.normalize(path.resolve(configRoot))
  const home =
    path.basename(normalized) === ".claude"
      ? path.dirname(normalized)
      : normalized
  return `claude:home:${home}`
}

/** The continuation key of a Codex instance on `codexHome` (CodexHomeLayout.ts). */
export function codexContinuationKeyFor(codexHome: string): string {
  return `codex:home:${path.resolve(codexHome)}`
}

/**
 * The folder name Claude Code gives a project under `<config>/projects`:
 * every character outside `[a-zA-Z0-9]` becomes `-`, and names over 200
 * characters are cut and suffixed with a hash. A copy of
 * `claudeProjectDirectoryName` (claudeTerminal/ClaudeTerminalAdapter.ts),
 * kept here so the import does not load the terminal adapter.
 */
export function claudeProjectDirectoryName(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  if (sanitized.length <= 200) return sanitized
  let hash = 0
  for (let index = 0; index < cwd.length; index += 1) {
    hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0
  }
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

const UUID_IN_NAME =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

async function directoryEntries(directory: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function statFile(
  provider: ConversationImportProvider,
  file: string,
  archived: boolean,
  idHint: string | null
): Promise<SessionFile | null> {
  try {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile()) return null
    return {
      provider,
      path: file,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      archived,
      idHint,
    }
  } catch {
    return null
  }
}

export interface SessionFileListing {
  /** The CLI's session folder exists. */
  found: boolean
  /** Newest first. */
  files: SessionFile[]
}

/** Claude Code sessions: the `.jsonl` files directly in each project folder. */
export async function listClaudeSessionFiles(
  configRoot: string
): Promise<SessionFileListing> {
  const projects = path.join(configRoot, "projects")
  if (!(await isDirectory(projects))) return { found: false, files: [] }
  const files: SessionFile[] = []
  for (const project of await directoryEntries(projects)) {
    if (!project.isDirectory()) continue
    const folder = path.join(projects, project.name)
    for (const entry of await directoryEntries(folder)) {
      if (files.length >= IMPORT_LIMITS.filesPerProvider) break
      // Sub-agent transcripts live in sub-folders and are not sessions.
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const file = await statFile(
        "claude",
        path.join(folder, entry.name),
        false,
        entry.name.slice(0, -".jsonl".length)
      )
      if (file) files.push(file)
    }
  }
  return { found: true, files: newestFirst(files) }
}

/** Codex rollouts under `sessions/YYYY/MM/DD` and in `archived_sessions`. */
export async function listCodexSessionFiles(
  codexHome: string
): Promise<SessionFileListing> {
  const sessions = path.join(codexHome, "sessions")
  const archive = path.join(codexHome, "archived_sessions")
  const [hasSessions, hasArchive] = await Promise.all([
    isDirectory(sessions),
    isDirectory(archive),
  ])
  if (!hasSessions && !hasArchive) return { found: false, files: [] }
  const files: SessionFile[] = []
  const add = async (file: string, name: string, archived: boolean) => {
    if (files.length >= IMPORT_LIMITS.filesPerProvider) return
    if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) return
    const found = await statFile(
      "codex",
      file,
      archived,
      UUID_IN_NAME.exec(name)?.[1] ?? null
    )
    if (found) files.push(found)
  }
  // Newest folders first, so the file cap keeps the recent sessions.
  const descending = (entries: fs.Dirent[]) =>
    entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name))
  if (hasSessions) {
    for (const year of descending(await directoryEntries(sessions))) {
      const yearPath = path.join(sessions, year.name)
      for (const month of descending(await directoryEntries(yearPath))) {
        const monthPath = path.join(yearPath, month.name)
        for (const day of descending(await directoryEntries(monthPath))) {
          const dayPath = path.join(monthPath, day.name)
          for (const entry of await directoryEntries(dayPath)) {
            if (entry.isFile())
              await add(path.join(dayPath, entry.name), entry.name, false)
          }
        }
      }
    }
  }
  if (hasArchive) {
    for (const entry of await directoryEntries(archive)) {
      if (entry.isFile())
        await add(path.join(archive, entry.name), entry.name, true)
    }
  }
  return { found: true, files: newestFirst(files) }
}

function newestFirst(files: SessionFile[]): SessionFile[] {
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** `child` is `parent` or inside it; paths compare case-insensitively on Windows. */
export function isInsidePath(child: string, parent: string): boolean {
  const relative = path.relative(comparablePath(parent), comparablePath(child))
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

/** A folder as a lookup key: resolved, no trailing separator, case folded on Windows. */
export function comparablePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/**
 * Sessions BetterC0de itself ran: a folderless chat's scratch folder in the
 * data directory, or the temporary folders of its helper calls (commit
 * messages, titles). They are not the user's earlier conversations.
 */
export function isAppOwnedFolder(
  cwd: string,
  dataDir: string | null,
  tmpDir: string = os.tmpdir()
): boolean {
  if (dataDir && isInsidePath(cwd, dataDir)) return true
  if (!isInsidePath(cwd, tmpDir)) return false
  const first = path
    .relative(comparablePath(tmpDir), comparablePath(cwd))
    .split(/[\\/]/)[0]
  return Boolean(first && first.startsWith("betterc0de-"))
}
