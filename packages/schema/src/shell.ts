import { z } from "zod"

const SHELL_COMMAND_MAX_CHARS = 16 * 1024
const SHELL_CWD_MAX_CHARS = 32 * 1024
const SHELL_SESSION_ID_MAX_CHARS = 256
const SHELL_DATA_MAX_CHARS = 64 * 1024
const SHELL_ENV_MAX_ENTRIES = 64
const SHELL_ENV_MAX_CHARS = 24 * 1024
const SHELL_ARGS_MAX_ENTRIES = 128
const SHELL_ARGS_MAX_CHARS = 24 * 1024
const TOOL_OUTPUT_ARCHIVE_ID_RE = /^[A-Za-z0-9_-]{32}$/

const shellCommandSchema = z.string().max(SHELL_COMMAND_MAX_CHARS)
const shellCwdSchema = z.coerce.string().max(SHELL_CWD_MAX_CHARS)
const shellSessionIdSchema = z.string().min(1).max(SHELL_SESSION_ID_MAX_CHARS)
const permissionLevelSchema = z.string().max(64)

const shellEnvironmentSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.string().max(8 * 1024)
  )
  .superRefine((environment, context) => {
    const entries = Object.entries(environment)
    if (entries.length > SHELL_ENV_MAX_ENTRIES) {
      context.addIssue({
        code: "custom",
        message: `env is limited to ${SHELL_ENV_MAX_ENTRIES} entries`,
      })
    }
    const characters = entries.reduce(
      (total, [key, value]) => total + key.length + value.length + 2,
      0
    )
    if (characters > SHELL_ENV_MAX_CHARS) {
      context.addIssue({
        code: "custom",
        message: `env exceeds ${SHELL_ENV_MAX_CHARS} characters`,
      })
    }
  })

const terminalArgsSchema = z
  .array(z.string().max(4 * 1024))
  .max(SHELL_ARGS_MAX_ENTRIES)
  .superRefine((args, context) => {
    const characters = args.reduce((total, arg) => total + arg.length + 1, 0)
    if (characters > SHELL_ARGS_MAX_CHARS) {
      context.addIssue({
        code: "custom",
        message: `args exceed ${SHELL_ARGS_MAX_CHARS} characters`,
      })
    }
  })

export const shellRunSchema = z
  .object({
    command: z.coerce.string().max(SHELL_COMMAND_MAX_CHARS).default(""),
    cwd: shellCwdSchema.default("."),
    shell: z.string().max(1_024).optional(),
    env: shellEnvironmentSchema.optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
    sessionId: shellSessionIdSchema.optional(),
    // Human intent alone is not authorization. The backend also requires the
    // short-lived, operation-bound capability issued by /shell/capability.
    humanOrigin: z.boolean().optional(),
    humanCapability: z.string().min(1).max(256).optional(),
    // Optional permission override for non-human-origin callers. Must be one of
    // the four permission levels; unknown values fall back to `ask-on-edit`.
    permissionLevel: permissionLevelSchema.optional(),
  })
  .strict()
export type ShellRunBody = z.infer<typeof shellRunSchema>

/**
 * The launch a run or PTY capability is bound to: the shell, the PTY argument
 * vector and the command environment of the request that will spend it,
 * with the same limits that request has. An absent field means "the
 * default"; the backend refuses the capability for any other launch.
 */
export const shellCapabilityLaunchSchema = z
  .object({
    shell: z.string().max(1_024).optional(),
    args: terminalArgsSchema.optional(),
    env: shellEnvironmentSchema.optional(),
  })
  .strict()
export type ShellCapabilityLaunch = z.infer<typeof shellCapabilityLaunchSchema>

export const shellCapabilityRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("run"),
      command: shellCommandSchema,
      cwd: z.string().max(SHELL_CWD_MAX_CHARS),
      launch: shellCapabilityLaunchSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("pty-open"),
      cwd: z.string().max(SHELL_CWD_MAX_CHARS),
      sessionId: shellSessionIdSchema.optional(),
      command: shellCommandSchema.optional(),
      launch: shellCapabilityLaunchSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("pty-write"),
      sessionId: shellSessionIdSchema,
      data: z.string().max(SHELL_DATA_MAX_CHARS),
    })
    .strict(),
])
export type ShellCapabilityRequest = z.infer<
  typeof shellCapabilityRequestSchema
>

export const shellAbortSchema = z
  .object({
    sessionId: shellSessionIdSchema,
  })
  .strict()
export type ShellAbortBody = z.infer<typeof shellAbortSchema>

/** Opaque server-issued identifier used by the authenticated archive route. */
export const toolOutputArchiveIdSchema = z
  .string()
  .regex(TOOL_OUTPUT_ARCHIVE_ID_RE)
export type ToolOutputArchiveId = z.infer<typeof toolOutputArchiveIdSchema>

const terminalDimensionSchema = z.coerce.number().int().min(2).max(500)

export const terminalOpenSchema = z
  .object({
    sessionId: shellSessionIdSchema.optional(),
    cwd: shellCwdSchema.default("."),
    shell: z.string().max(1_024).optional(),
    command: shellCommandSchema.min(1).optional(),
    args: terminalArgsSchema.optional(),
    env: shellEnvironmentSchema.optional(),
    cols: terminalDimensionSchema.optional(),
    rows: terminalDimensionSchema.optional(),
    humanOrigin: z.boolean().optional(),
    humanCapability: z.string().min(1).max(256).optional(),
    permissionLevel: permissionLevelSchema.optional(),
  })
  .strict()
export type TerminalOpenBody = z.infer<typeof terminalOpenSchema>

export const terminalWriteSchema = z
  .object({
    sessionId: shellSessionIdSchema,
    data: z.string().max(SHELL_DATA_MAX_CHARS),
    humanOrigin: z.boolean().optional(),
    humanCapability: z.string().min(1).max(256).optional(),
    permissionLevel: permissionLevelSchema.optional(),
  })
  .strict()
export type TerminalWriteBody = z.infer<typeof terminalWriteSchema>

export const terminalResizeSchema = z
  .object({
    sessionId: shellSessionIdSchema,
    cols: terminalDimensionSchema,
    rows: terminalDimensionSchema,
  })
  .strict()
export type TerminalResizeBody = z.infer<typeof terminalResizeSchema>

export const terminalReadSchema = z
  .object({
    sessionId: shellSessionIdSchema,
    cursor: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  })
  .strict()
export type TerminalReadBody = z.infer<typeof terminalReadSchema>
