import type {
  FilesystemDrive,
  FilesystemDriveKind,
  FilesystemDrivesResult,
  FilesystemListEntry,
  FilesystemListResult,
  FilesystemSearchHit,
  FilesystemSearchResult,
} from "@betterc0de/schema"
import { invokeContract } from "./contracts"

// The `/filesystem/*` calls go through their shared contracts
// (`@betterc0de/schema/http-contracts`); the records are defined once, in
// `@betterc0de/schema`, for the backend, this renderer and the phone app.

export type ListEntry = FilesystemListEntry
export type ListResult = FilesystemListResult
export type SearchHit = FilesystemSearchHit
export type SearchResult = FilesystemSearchResult
export type DriveKind = FilesystemDriveKind
export type DriveEntry = FilesystemDrive
export type DrivesResult = FilesystemDrivesResult

export function listDirectoryFs(
  path: string,
  opts: { showHidden?: boolean; offset?: number; signal?: AbortSignal } = {}
): Promise<ListResult> {
  return invokeContract("filesystemList", {
    body: { path, showHidden: opts.showHidden ?? false, offset: opts.offset },
    signal: opts.signal,
  })
}

export function searchTreeFs(
  root: string,
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {}
): Promise<SearchResult> {
  return invokeContract("filesystemSearch", {
    body: { root, query, limit: opts.limit },
    signal: opts.signal,
  })
}

export function enumerateDrivesFs(
  opts: { signal?: AbortSignal } = {}
): Promise<DrivesResult> {
  return invokeContract("filesystemDrives", { signal: opts.signal })
}
