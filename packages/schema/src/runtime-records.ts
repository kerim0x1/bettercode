import { z } from "zod"
import { RUNTIME_HOOK_EVENTS, type RuntimeHookEvent } from "./runtime-hooks"

/**
 * The per-user files the desktop process (`apps/shell`) writes and the
 * backend reads: `hooks.json` and `mcp-servers.json`, each a JSON array of
 * records in the desktop's data folder. The shell checks every record it
 * writes against these schemas (`apps/shell/shared/runtime-records.cjs`);
 * the backend's readers (`services/chat/turn-preparation.ts`,
 * `provider/runtime/acp/AcpMcpServers.ts`) take the same limits; the
 * renderer's views are derived from the record types.
 *
 * The files outlive releases, so the schemas describe what may be on disk,
 * not only what the current release writes: fields an older release did not
 * write are optional, and unknown fields pass through untouched.
 */

/** A schema whose parsed value and accepted input are both `T`. */
type RecordSchema<T> = z.ZodType<T, T>

// ── Approval markers ────────────────────────────────────────────────────

/**
 * Stored next to a command the user allowed in the desktop's native dialog
 * (`apps/shell/shared/command-approval.cjs`); the backend checks it again
 * before it runs the command (`security/commandApproval.ts`).
 */
export interface CommandApprovalMarker {
  v: number
  alg: string
  digest: string
}

export const commandApprovalMarkerSchema: RecordSchema<CommandApprovalMarker> =
  z
    .object({
      v: z.number().int(),
      alg: z.string().min(1).max(32),
      digest: z.string().min(1).max(128),
    })
    .passthrough()

// ── hooks.json ──────────────────────────────────────────────────────────

/** How the last run of a hook went. */
export const RUNTIME_HOOK_STATUSES = [
  "idle",
  "running",
  "success",
  "error",
] as const

export type RuntimeHookStatus = (typeof RUNTIME_HOOK_STATUSES)[number]

/** Bounds of `hooks.json`, the same for the shell that writes it and the backend that reads it. */
export const RUNTIME_HOOK_LIMITS = {
  /** Most hooks in the file (the shell's store has always allowed this many). */
  maxHooks: 1_000,
  maxIdChars: 128,
  maxCommandChars: 4_096,
  maxErrorChars: 8_192,
  maxFileBytes: 4 * 1024 * 1024,
} as const

/** One entry of `hooks.json`. */
export interface RuntimeHookRecord {
  id: string
  event: RuntimeHookEvent
  /** Run with the user's shell; empty for a hook that is not set up yet. */
  command: string
  enabled: boolean
  /** Present once the user allowed this exact command. */
  approval?: CommandApprovalMarker | null
  createdAt?: string
  updatedAt?: string
  lastRunAt?: string | null
  lastStatus?: RuntimeHookStatus
  lastExitCode?: number | null
  lastError?: string | null
}

export const runtimeHookRecordSchema: RecordSchema<RuntimeHookRecord> = z
  .object({
    id: z
      .string()
      .max(RUNTIME_HOOK_LIMITS.maxIdChars)
      .refine((value) => value.trim().length > 0, "Hook id must not be blank"),
    event: z.enum(RUNTIME_HOOK_EVENTS),
    command: z
      .string()
      .max(RUNTIME_HOOK_LIMITS.maxCommandChars)
      .refine((value) => !value.includes("\0"), "Hook command contains NUL"),
    enabled: z.boolean(),
    approval: commandApprovalMarkerSchema.nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    lastRunAt: z.string().nullable().optional(),
    lastStatus: z.enum(RUNTIME_HOOK_STATUSES).optional(),
    lastExitCode: z.number().int().nullable().optional(),
    lastError: z
      .string()
      .max(RUNTIME_HOOK_LIMITS.maxErrorChars)
      .nullable()
      .optional(),
  })
  .passthrough()

/**
 * A hook as the renderer gets it (`hook:list`): the record without its
 * approval marker, plus whether the marker is valid for this command.
 * `approved` is absent from desktops older than command approvals.
 */
export type RuntimeHookView = Omit<RuntimeHookRecord, "approval"> & {
  approved?: boolean
}

// ── mcp-servers.json ────────────────────────────────────────────────────

/** Bounds of `mcp-servers.json`, the same for its writer and its readers. */
export const RUNTIME_MCP_LIMITS = {
  maxServers: 128,
  maxNameChars: 256,
  maxTypeChars: 32,
  maxCommandOrUrlChars: 4_096,
  maxArgs: 32,
  maxArgChars: 2_048,
  maxArgsChars: 16_384,
  /** Entries of `env`, `headers` or `headerEnv`. */
  maxEnvEntries: 64,
  maxEnvKeyChars: 128,
  /** A plaintext value. */
  maxEnvValueChars: 8_192,
  /** An `enc:v1:` value as stored (base64 of iv, tag and ciphertext). */
  maxEncryptedValueChars: 16_384,
  maxStoreBytes: 4 * 1024 * 1024,
} as const

/**
 * Where an imported server came from. A user-level server carries no scope
 * (or `user`); `project` and `local` servers were declared for one
 * workspace (`projectRoot`) and apply only there, once it is trusted.
 */
export type RuntimeMcpScope = "user" | "project" | "local"

/**
 * One entry of `mcp-servers.json`. `env` and `headers` values are stored
 * encrypted (`enc:v1:`) once the desktop has its settings key.
 */
export interface RuntimeMcpServerRecord {
  id: string
  name?: string
  /** `command` (stdio, the default); `http`, `sse` or another remote transport. */
  type?: string
  command?: string
  url?: string | null
  args?: string[]
  env?: Record<string, string>
  /** Static HTTP headers of a remote server. */
  headers?: Record<string, string>
  /** HTTP headers filled from the named environment variables. */
  headerEnv?: Record<string, string>
  enabled?: boolean
  /** Signed in through the provider CLI (OAuth); the desktop cannot start it. */
  authenticated?: boolean
  installedAt?: string
  updatedAt?: string
  scope?: RuntimeMcpScope
  projectRoot?: string | null
  /** Present once the user allowed this exact command line. */
  approval?: CommandApprovalMarker | null
}

const mcpValueRecord = z
  .record(
    z.string().min(1).max(RUNTIME_MCP_LIMITS.maxEnvKeyChars),
    z.string().max(RUNTIME_MCP_LIMITS.maxEncryptedValueChars)
  )
  .refine(
    (record) => Object.keys(record).length <= RUNTIME_MCP_LIMITS.maxEnvEntries,
    `At most ${RUNTIME_MCP_LIMITS.maxEnvEntries} entries`
  )

export const runtimeMcpServerRecordSchema: RecordSchema<RuntimeMcpServerRecord> =
  z
    .object({
      id: z
        .string()
        .max(RUNTIME_MCP_LIMITS.maxNameChars)
        .refine((value) => value.trim().length > 0, "MCP id must not be blank"),
      name: z.string().max(RUNTIME_MCP_LIMITS.maxNameChars).optional(),
      type: z.string().max(RUNTIME_MCP_LIMITS.maxTypeChars).optional(),
      command: z
        .string()
        .max(RUNTIME_MCP_LIMITS.maxCommandOrUrlChars)
        .optional(),
      url: z
        .string()
        .max(RUNTIME_MCP_LIMITS.maxCommandOrUrlChars)
        .nullable()
        .optional(),
      args: z
        .array(z.string().max(RUNTIME_MCP_LIMITS.maxArgChars))
        .max(RUNTIME_MCP_LIMITS.maxArgs)
        .refine(
          (args) =>
            args.reduce((total, arg) => total + arg.length, 0) <=
            RUNTIME_MCP_LIMITS.maxArgsChars,
          `MCP args exceed ${RUNTIME_MCP_LIMITS.maxArgsChars} characters`
        )
        .optional(),
      env: mcpValueRecord.optional(),
      headers: mcpValueRecord.optional(),
      headerEnv: mcpValueRecord.optional(),
      enabled: z.boolean().optional(),
      authenticated: z.boolean().optional(),
      installedAt: z.string().optional(),
      updatedAt: z.string().optional(),
      scope: z.enum(["user", "project", "local"]).optional(),
      projectRoot: z
        .string()
        .max(RUNTIME_MCP_LIMITS.maxCommandOrUrlChars)
        .nullable()
        .optional(),
      approval: commandApprovalMarkerSchema.nullable().optional(),
    })
    .passthrough()
