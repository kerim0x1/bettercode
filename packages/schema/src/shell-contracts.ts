import { z } from "zod"
import { endpoint, noBody, type RecordSchema } from "./http-endpoint"
import {
  shellAbortSchema,
  shellCapabilityRequestSchema,
  shellRunSchema,
  terminalOpenSchema,
  terminalReadSchema,
  terminalResizeSchema,
  terminalWriteSchema,
} from "./shell"

/**
 * The shell and terminal routes (`apps/backend/src/http/routes/shell.ts`).
 * The routes parse their own requests, with these schemas, because the
 * order of their checks (identity, rate limit, workspace, capability) is
 * part of their security; their answers are validated with the responses
 * below. `GET /shell/output/:archiveId` streams plain text and has no
 * contract.
 */

const text = z.string()
const bool = z.boolean()
const num = z.number()

/** A shell the terminal can open (`GET /shell/detect`). */
export interface ShellInfo {
  id: string
  name: string
  /** Not sent by current desktops; the backend resolves the binary itself. */
  path?: string
  default?: boolean
}

const shellInfoSchema: RecordSchema<ShellInfo> = z
  .object({
    id: text,
    name: text,
    path: text.optional(),
    default: bool.optional(),
  })
  .passthrough()

/**
 * One finished `POST /shell/run`. Output beyond the workspace's limits is
 * cut (`*Truncated`) and kept whole in an archive the caller may download
 * once (`outputDownloadUrl`).
 */
export interface ShellCommandResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  combined: string
  sessionId?: string
  aborted?: boolean
  timedOut?: boolean
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  combinedTruncated?: boolean
  outputArchiveId?: string
  outputDownloadUrl?: string
  outputArchiveTruncated?: boolean
  /** The command exited while something it started kept its output open. */
  detachedDescendants?: boolean
}

const shellCommandResultSchema: RecordSchema<ShellCommandResult> = z
  .object({
    success: bool,
    stdout: text,
    stderr: text,
    exitCode: num.nullable(),
    combined: text,
    sessionId: text.optional(),
    aborted: bool.optional(),
    timedOut: bool.optional(),
    stdoutTruncated: bool.optional(),
    stderrTruncated: bool.optional(),
    combinedTruncated: bool.optional(),
    outputArchiveId: text.optional(),
    outputDownloadUrl: text.optional(),
    outputArchiveTruncated: bool.optional(),
    detachedDescendants: bool.optional(),
  })
  .passthrough()

/** One event of a terminal session, in `seq` order. */
export interface TerminalPtyEvent {
  seq: number
  type: "data" | "exit" | "system"
  data?: string
  exitCode?: number | null
  signal?: number | string | null
  at: number
}

/**
 * A terminal session and the events after the cursor the caller read from.
 * `cleanup_failed`: the shell exited but part of its process tree could not
 * be ended.
 */
export interface TerminalPtySnapshot {
  sessionId: string
  pid: number
  cwd: string
  shell: string
  command: string
  args: string[]
  status: "running" | "exited" | "cleanup_failed"
  events: TerminalPtyEvent[]
  nextCursor: number
  /** The newest event's `seq`; events before the first one listed were dropped. */
  lastSeq?: number
}

const terminalPtyEventSchema: RecordSchema<TerminalPtyEvent> = z
  .object({
    seq: num,
    type: z.enum(["data", "exit", "system"]),
    data: text.optional(),
    exitCode: num.nullable().optional(),
    signal: z.union([num, text]).nullable().optional(),
    at: num,
  })
  .passthrough()

const terminalPtySnapshotSchema: RecordSchema<TerminalPtySnapshot> = z
  .object({
    sessionId: text,
    pid: num,
    cwd: text,
    shell: text,
    command: text,
    args: z.array(text),
    status: z.enum(["running", "exited", "cleanup_failed"]),
    events: z.array(terminalPtyEventSchema),
    nextCursor: num,
    lastSeq: num.optional(),
  })
  .passthrough()

/** `{ ok: false }` comes with a 404: no such session for this caller. */
const terminalOkSchema = z.object({ ok: bool }).passthrough()

/** `POST /shell/client/release`: what a gone renderer instance had started. */
export const shellClientReleaseSchema = z
  .object({ clientInstanceId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) })
  .passthrough()

export const shellHttpContracts = {
  // Desktop: only the main process may ask. A paired device: only with the
  // owner's terminal grant.
  shellCapability: endpoint(
    "POST",
    "/shell/capability",
    shellCapabilityRequestSchema,
    z.object({ capability: text }).passthrough()
  ),
  shellRun: endpoint(
    "POST",
    "/shell/run",
    shellRunSchema,
    shellCommandResultSchema
  ),
  // `{ aborted: false }` comes with a 404: the run had already finished.
  shellAbort: endpoint(
    "POST",
    "/shell/abort",
    shellAbortSchema,
    z.object({ aborted: bool }).passthrough()
  ),
  shellDetect: endpoint(
    "GET",
    "/shell/detect",
    noBody,
    z.array(shellInfoSchema)
  ),
  terminalOpen: endpoint(
    "POST",
    "/shell/pty/open",
    terminalOpenSchema,
    terminalPtySnapshotSchema
  ),
  terminalRead: endpoint(
    "POST",
    "/shell/pty/read",
    terminalReadSchema,
    terminalPtySnapshotSchema
  ),
  terminalWrite: endpoint(
    "POST",
    "/shell/pty/write",
    terminalWriteSchema,
    terminalOkSchema
  ),
  terminalResize: endpoint(
    "POST",
    "/shell/pty/resize",
    terminalResizeSchema,
    terminalOkSchema
  ),
  terminalClose: endpoint(
    "POST",
    "/shell/pty/close",
    shellAbortSchema,
    terminalOkSchema
  ),
  shellClientRelease: endpoint(
    "POST",
    "/shell/client/release",
    shellClientReleaseSchema,
    z.object({ terminals: num, runs: num, complete: bool }).passthrough()
  ),
} as const
