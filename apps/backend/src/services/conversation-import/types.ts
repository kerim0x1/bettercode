import type { ConversationImportProvider } from "@betterc0de/schema"

/**
 * Bounds for reading the CLIs' session stores. A store holds years of
 * sessions and single files reach tens of megabytes, so a listing reads the
 * newest files only, within a time budget, and an import keeps a chat to a
 * size the transcript and the provider history handle comfortably.
 */
export const IMPORT_LIMITS = {
  /** Sessions listed per CLI, newest first. */
  sessionsPerProvider: 200,
  /** Session files looked at per CLI before the newest are picked. */
  filesPerProvider: 5_000,
  /** Larger session files are left out. */
  maxFileBytes: 50 * 1024 * 1024,
  /** What a listing may spend reading whole files; later ones are read from the start only. */
  scanBudgetMs: 8_000,
  /** What a listing reads of a file once the budget is spent. */
  headBytes: 256 * 1024,
  /** Messages kept per chat; older ones are left out. */
  maxMessages: 2_000,
  maxMessageChars: 100_000,
  maxReasoningChars: 20_000,
  maxToolCallsPerMessage: 200,
  maxToolInputChars: 300,
  maxToolOutputChars: 2_000,
  titleChars: 80,
  /** Summaries kept between listings, keyed by file. */
  summaryCacheEntries: 2_000,
} as const

/** A tool call as an imported chat shows it: name, short arguments, cut result. */
export interface ImportedToolCall {
  id: string
  name: string
  input: unknown
  output?: string
  outputTruncated?: boolean
  failed?: boolean
}

export interface ImportedMessage {
  role: "user" | "assistant"
  text: string
  createdAt: string
  /** Reasoning the CLI showed (Claude thinking text, Codex summaries). */
  reasoning?: string
  toolCalls?: ImportedToolCall[]
  modelId?: string
}

/** What a session file holds, read by one of the parsers. */
export interface ImportedTranscript {
  provider: ConversationImportProvider
  /** The CLI's session id from inside the file, when it names one. */
  sessionId: string | null
  /** The folder the session ran in. */
  cwd: string | null
  /** The first prompt, trimmed for a title. */
  title: string | null
  startedAt: string | null
  endedAt: string | null
  /** Empty when the parser only counts. */
  messages: ImportedMessage[]
  /** User prompts and assistant replies, as the import creates them. */
  messageCount: number
  /** Older messages beyond `IMPORT_LIMITS.maxMessages`, left out. */
  omittedMessages: number
  /** Not started by the user (a Codex sub-agent): never offered. */
  internal: boolean
}

export interface TranscriptParser {
  pushLine(line: string): void
  finish(): ImportedTranscript
}

export interface ParserOptions {
  /** Keep messages (an import) or only count them (a listing). */
  keepMessages: boolean
  /** The time for rows that carry none (the file's modification time). */
  fallbackAt?: string
}
