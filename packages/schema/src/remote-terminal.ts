import { z } from "zod"

/**
 * A terminal on the desktop, used from a paired device (the phone app) over
 * the desktop's WebSocket (`/ws`): JSON-RPC calls from the device, pushed
 * frames from the desktop.
 *
 * Only a paired device with a full session gets one, and only while the
 * desktop allows terminals from paired devices
 * (`remote_access_allow_terminal`); only in a workspace the desktop knows.
 * The desktop's own terminals are never shown here.
 *
 * Output is numbered (`seq`, per terminal, counting every event the
 * terminal had). A device acknowledges what it has shown (`terminal.ack`);
 * the desktop sends at most `TERMINAL_LIMITS.unackedBytes` ahead of that,
 * and keeps what was not sent yet in the terminal's buffer. Output the
 * buffer had to drop is announced as a gap (`terminal.gap`), never skipped
 * silently. A device that lost its connection attaches again after the
 * last `seq` it has (`terminal.attach`).
 *
 * Input is numbered too (`inputSeq`, per terminal, from 1). The desktop
 * applies each number once and in order: a repeated one (a write resent
 * after a lost connection) is ignored, a missing one refuses the write.
 */

export const TERMINAL_METHODS = {
  open: "terminal.open",
  attach: "terminal.attach",
  write: "terminal.write",
  resize: "terminal.resize",
  ack: "terminal.ack",
  close: "terminal.close",
  list: "terminal.list",
} as const
export type TerminalMethod =
  (typeof TERMINAL_METHODS)[keyof typeof TERMINAL_METHODS]

export const TERMINAL_CHANNELS = {
  output: "terminal.output",
  exit: "terminal.exit",
  gap: "terminal.gap",
  closed: "terminal.closed",
} as const

export const TERMINAL_LIMITS = {
  minCols: 10,
  maxCols: 500,
  minRows: 4,
  maxRows: 200,
  /** Largest input one write carries, in UTF-8 bytes. */
  maxWriteBytes: 16 * 1024,
  /** Output the desktop sends ahead of the device's last acknowledgement. */
  unackedBytes: 256 * 1024,
  /** How long a terminal no device is attached to keeps running. */
  detachedMs: 15 * 60 * 1000,
} as const

const terminalId = z.string().min(1).max(128)
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const cols = z
  .number()
  .int()
  .min(TERMINAL_LIMITS.minCols)
  .max(TERMINAL_LIMITS.maxCols)
const rows = z
  .number()
  .int()
  .min(TERMINAL_LIMITS.minRows)
  .max(TERMINAL_LIMITS.maxRows)

export const terminalOpenParamsSchema = z
  .object({
    /** A workspace the desktop knows: a project's folder or a worktree. */
    cwd: z.string().min(1).max(4096),
    cols,
    rows,
  })
  .strict()

export const terminalAttachParamsSchema = z
  .object({
    terminalId,
    /** The last `seq` the device has; 0 for everything still kept. */
    afterSeq: seq,
  })
  .strict()

export const terminalWriteParamsSchema = z
  .object({
    terminalId,
    inputSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    data: z.string().min(1).max(TERMINAL_LIMITS.maxWriteBytes),
  })
  .strict()

export const terminalResizeParamsSchema = z
  .object({ terminalId, cols, rows })
  .strict()

export const terminalAckParamsSchema = z.object({ terminalId, seq }).strict()

export const terminalCloseParamsSchema = z.object({ terminalId }).strict()

export const terminalStatusSchema = z.enum(["running", "exited"])

export const terminalSummarySchema = z
  .object({
    terminalId,
    cwd: z.string(),
    /** The shell's name (`zsh`, `bash`, `powershell` …). */
    shell: z.string(),
    status: terminalStatusSchema,
    /** When it was opened, ISO 8601. */
    openedAt: z.string(),
    /** The next input number the desktop applies. */
    nextInputSeq: z.number().int().min(1),
  })
  .passthrough()
export type TerminalSummary = z.infer<typeof terminalSummarySchema>

export const terminalOpenResultSchema = terminalSummarySchema
export const terminalAttachResultSchema = terminalSummarySchema

export const terminalWriteResultSchema = z
  .object({
    /** False for an input number the desktop already applied. */
    applied: z.boolean(),
  })
  .passthrough()

export const terminalListResultSchema = z
  .object({ terminals: z.array(terminalSummarySchema).max(64) })
  .passthrough()

/** Why a terminal is gone for the device. */
export const terminalClosedReasonSchema = z
  .enum([
    /** The device closed it. */
    "closed",
    /** No device was attached for `TERMINAL_LIMITS.detachedMs`. */
    "detached",
    /** The desktop no longer allows terminals from paired devices. */
    "grant_revoked",
  ])
  // A reason a newer desktop added reads as a plain close.
  .catch("closed")
export type TerminalClosedReason = z.infer<typeof terminalClosedReasonSchema>

export const terminalOutputFrameSchema = z.object({
  channel: z.literal(TERMINAL_CHANNELS.output),
  data: z.object({
    terminalId,
    /** The `seq` of the last event this output belongs to. */
    seq,
    output: z.string(),
  }),
})

export const terminalExitFrameSchema = z.object({
  channel: z.literal(TERMINAL_CHANNELS.exit),
  data: z.object({
    terminalId,
    seq,
    exitCode: z.number().int().nullable(),
    signal: z.union([z.number(), z.string()]).nullable(),
  }),
})

export const terminalGapFrameSchema = z.object({
  channel: z.literal(TERMINAL_CHANNELS.gap),
  data: z.object({
    terminalId,
    /** The first and last `seq` the buffer dropped before they were sent. */
    fromSeq: seq,
    toSeq: seq,
  }),
})

export const terminalClosedFrameSchema = z.object({
  channel: z.literal(TERMINAL_CHANNELS.closed),
  data: z.object({ terminalId, reason: terminalClosedReasonSchema }),
})

export const terminalFrameSchema = z.discriminatedUnion("channel", [
  terminalOutputFrameSchema,
  terminalExitFrameSchema,
  terminalGapFrameSchema,
  terminalClosedFrameSchema,
])
export type TerminalFrame = z.infer<typeof terminalFrameSchema>
