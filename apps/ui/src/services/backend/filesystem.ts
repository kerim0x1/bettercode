import { httpInvoke } from "./runtime"

export interface ListEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number | null
  mtime: number | null
}

export interface ListResult {
  path: string
  parent: string | null
  entries: ListEntry[]
  truncated: boolean
  nextOffset?: number
}

export interface SearchHit {
  path: string
  name: string
  isDir: boolean
  score: number
}

export interface SearchResult {
  entries: SearchHit[]
  truncated: boolean
  tookMs: number
}

export type DriveKind = "drive" | "home" | "volume" | "shortcut" | "root"

export interface DriveEntry {
  path: string
  label: string
  kind: DriveKind
  reachable: boolean
}

export interface DrivesResult {
  platform: "win32" | "darwin" | "linux" | string
  entries: DriveEntry[]
}

export function listDirectoryFs(
  path: string,
  opts: { showHidden?: boolean; offset?: number; signal?: AbortSignal } = {}
): Promise<ListResult> {
  return httpInvoke<ListResult>("/filesystem/list", {
    method: "POST",
    body: { path, showHidden: opts.showHidden ?? false, offset: opts.offset },
    signal: opts.signal,
  })
}

export function searchTreeFs(
  root: string,
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {}
): Promise<SearchResult> {
  return httpInvoke<SearchResult>("/filesystem/search", {
    method: "POST",
    body: { root, query, limit: opts.limit },
    signal: opts.signal,
  })
}

export function enumerateDrivesFs(
  opts: { signal?: AbortSignal } = {}
): Promise<DrivesResult> {
  return httpInvoke<DrivesResult>("/filesystem/drives", {
    method: "GET",
    signal: opts.signal,
  })
}
