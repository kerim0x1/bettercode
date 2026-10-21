import { z } from "zod"

const MAX_PATH_LEN = 2048
const MAX_QUERY_LEN = 256
const SEARCH_ABSOLUTE_MAX = 5000

export const filesystemListSchema = z.object({
  path: z.string().min(1).max(MAX_PATH_LEN),
  showHidden: z.boolean().default(false),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
})
export type FilesystemListBody = z.infer<typeof filesystemListSchema>

export const filesystemSearchSchema = z.object({
  root: z.string().min(1).max(MAX_PATH_LEN),
  query: z.string().max(MAX_QUERY_LEN).default(""),
  limit: z.number().int().positive().max(SEARCH_ABSOLUTE_MAX).optional(),
})
export type FilesystemSearchBody = z.infer<typeof filesystemSearchSchema>

// ── Responses ───────────────────────────────────────────────────────────
//
// What `/filesystem/*` answers (`apps/backend/src/services/filesystem-browser.ts`):
// the desktop's System Browser and the phone's file list read these. Every
// object passes unknown fields through, so a newer desktop can add one.

/** A schema whose parsed value and accepted input are both `T`. */
type RecordSchema<T> = z.ZodType<T, T>

/** One child of a listed folder. `size` and `mtime` are null when unreadable. */
export interface FilesystemListEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number | null
  mtime: number | null
}

/**
 * `POST /filesystem/list`: a folder's children, sorted. `truncated` with a
 * `nextOffset` when a page cap cut the list; desktops before paging send
 * neither offset.
 */
export interface FilesystemListResult {
  path: string
  parent: string | null
  entries: FilesystemListEntry[]
  truncated: boolean
  nextOffset?: number
}

/** One match of a name search below a folder. */
export interface FilesystemSearchHit {
  path: string
  name: string
  isDir: boolean
  score: number
}

/** `POST /filesystem/search`: the best matches; `truncated` when a cap stopped the walk. */
export interface FilesystemSearchResult {
  entries: FilesystemSearchHit[]
  truncated: boolean
  tookMs: number
}

export type FilesystemDriveKind =
  | "drive"
  | "home"
  | "volume"
  | "shortcut"
  | "root"

/** A place the System Browser offers as a starting point. */
export interface FilesystemDrive {
  path: string
  label: string
  kind: FilesystemDriveKind
  reachable: boolean
}

/** `GET /filesystem/drives` (desktop only): the starting points on this machine. */
export interface FilesystemDrivesResult {
  /** `process.platform` of the desktop: `win32`, `darwin`, `linux`, … */
  platform: string
  entries: FilesystemDrive[]
}

const filesystemListEntrySchema: RecordSchema<FilesystemListEntry> = z
  .object({
    name: z.string(),
    path: z.string(),
    isDir: z.boolean(),
    isSymlink: z.boolean(),
    size: z.number().nullable(),
    mtime: z.number().nullable(),
  })
  .passthrough()

export const filesystemListResultSchema: RecordSchema<FilesystemListResult> = z
  .object({
    path: z.string(),
    parent: z.string().nullable(),
    entries: z.array(filesystemListEntrySchema),
    truncated: z.boolean(),
    nextOffset: z.number().optional(),
  })
  .passthrough()

export const filesystemSearchResultSchema: RecordSchema<FilesystemSearchResult> =
  z
    .object({
      entries: z.array(
        z
          .object({
            path: z.string(),
            name: z.string(),
            isDir: z.boolean(),
            score: z.number(),
          })
          .passthrough()
      ),
      truncated: z.boolean(),
      tookMs: z.number(),
    })
    .passthrough()

export const filesystemDrivesResultSchema: RecordSchema<FilesystemDrivesResult> =
  z
    .object({
      platform: z.string(),
      entries: z.array(
        z
          .object({
            path: z.string(),
            label: z.string(),
            kind: z.enum(["drive", "home", "volume", "shortcut", "root"]),
            reachable: z.boolean(),
          })
          .passthrough()
      ),
    })
    .passthrough()
