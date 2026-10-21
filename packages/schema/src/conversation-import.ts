import { z } from "zod"
import type { RecordSchema } from "./http-endpoint"

/**
 * Importing earlier Claude Code and Codex conversations (desktop only). The
 * backend reads the sessions those CLIs keep on this computer, offers them
 * as candidates and copies the chosen ones into BetterC0de chats
 * (`GET` and `POST /conversation-imports`,
 * apps/backend/src/http/routes/conversationImport.ts). A client names a
 * session by provider and id only; the backend finds the file itself.
 */

export const CONVERSATION_IMPORT_PROVIDERS = ["claude", "codex"] as const

export type ConversationImportProvider =
  (typeof CONVERSATION_IMPORT_PROVIDERS)[number]

export const conversationImportProviderSchema = z.enum(
  CONVERSATION_IMPORT_PROVIDERS
)

/** The most sessions one import request may name; clients send batches. */
export const CONVERSATION_IMPORT_MAX_BATCH = 25

/** Both CLIs name a session with a UUID; nothing path-like is accepted. */
export const conversationImportSessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,128}$/, "Invalid session id")

/**
 * Where an imported chat came from, kept with the chat (`importedFrom` on a
 * thread). It marks the session as imported, so it is offered only once,
 * and the transcript shows its origin.
 */
export interface ThreadImportSource {
  provider: ConversationImportProvider
  /** The CLI's own session id (Claude Code session, Codex thread). */
  sessionId: string
  /** The session file the chat was read from. */
  filePath: string
  importedAt: string
  /**
   * Whether continuing the chat resumes the CLI's own session. When false,
   * the first new turn passes the imported messages along as context.
   */
  resumable?: boolean
  /** Older messages left out because the session was longer than the limit. */
  omittedMessages?: number
}

export const threadImportSourceSchema: RecordSchema<ThreadImportSource> = z
  .object({
    provider: conversationImportProviderSchema,
    sessionId: z.string().min(1).max(256),
    filePath: z.string().max(32_768),
    importedAt: z.string().min(1).max(64),
    resumable: z.boolean().optional(),
    omittedMessages: z.number().int().nonnegative().optional(),
  })
  .passthrough()

/** One earlier session, as `GET /conversation-imports` lists it. */
export interface ConversationImportCandidate {
  provider: ConversationImportProvider
  sessionId: string
  /** The folder the session ran in, as the CLI recorded it; null if unknown. */
  projectPath: string | null
  /** The project's name in BetterC0de, else the folder's name. */
  projectName: string | null
  /** Whether that folder still exists. A chat without one imports folderless. */
  folderExists: boolean
  /** The first prompt, trimmed. */
  title: string
  startedAt: string | null
  updatedAt: string
  /** Messages the import creates; null when the scan ran out of time. */
  messageCount: number | null
  /** The BetterC0de chat that already holds it; null when not imported. */
  threadId: string | null
  /** Whether continuing it would resume the CLI's own session. */
  resumable: boolean
  /** Codex keeps archived sessions apart; they import like the others. */
  archived: boolean
  sizeBytes: number
}

/** What was found for one CLI. */
export interface ConversationImportSourceStatus {
  provider: ConversationImportProvider
  /** The CLI's session folder exists on this computer. */
  found: boolean
  /** Session files found. */
  sessions: number
  /** Files left out: beyond the newest ones listed, too large or unreadable. */
  skipped: number
}

/** `GET /conversation-imports`, newest first. */
export interface ConversationImportList {
  candidates: ConversationImportCandidate[]
  sources: ConversationImportSourceStatus[]
  /** False when the scan ran out of time; some counts are then missing. */
  complete: boolean
}

const conversationImportCandidateSchema: RecordSchema<ConversationImportCandidate> =
  z
    .object({
      provider: conversationImportProviderSchema,
      sessionId: z.string(),
      projectPath: z.string().nullable(),
      projectName: z.string().nullable(),
      folderExists: z.boolean(),
      title: z.string(),
      startedAt: z.string().nullable(),
      updatedAt: z.string(),
      messageCount: z.number().int().nonnegative().nullable(),
      threadId: z.string().nullable(),
      resumable: z.boolean(),
      archived: z.boolean(),
      sizeBytes: z.number().nonnegative(),
    })
    .passthrough()

const conversationImportSourceStatusSchema: RecordSchema<ConversationImportSourceStatus> =
  z
    .object({
      provider: conversationImportProviderSchema,
      found: z.boolean(),
      sessions: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    })
    .passthrough()

export const conversationImportListSchema: RecordSchema<ConversationImportList> =
  z
    .object({
      candidates: z.array(conversationImportCandidateSchema),
      sources: z.array(conversationImportSourceStatusSchema),
      complete: z.boolean(),
    })
    .passthrough()

/** `POST /conversation-imports`: the sessions to import, by provider and id. */
export const conversationImportRequestSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            provider: conversationImportProviderSchema,
            sessionId: conversationImportSessionIdSchema,
          })
          .strict()
      )
      .min(1)
      .max(CONVERSATION_IMPORT_MAX_BATCH),
  })
  .strict()

export type ConversationImportRequest = z.infer<
  typeof conversationImportRequestSchema
>

/** How one requested session went. `skipped`: it was imported before. */
export type ConversationImportStatus = "imported" | "skipped" | "failed"
