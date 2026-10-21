import type { ChatMessageAttachment } from "./chat"

/**
 * Domain types shared between renderer and backend.
 *
 * These are **richer** than the persistence wire schemas in `threads.ts`
 * (which use `z.unknown()` for the free-form fields so any renderer shape
 * round-trips without loss). When you handle a message in the UI, use these
 * types; when you validate an HTTP body, use the Zod schemas in `threads.ts`.
 */

export interface ToolCall {
  id: string
  name: string
  /** Latest provider title; ACP providers change it per event. */
  title?: string
  /** The provider's own classification of the call (ACP `kind`). */
  kind?: string
  input: unknown
  output?: unknown
  state: "input-available" | "output-available" | "output-error"
  providerKind?: string
  providerInstanceId?: string
  turnId?: string
  sessionId?: string
  taskId?: string
  parentTaskId?: string
  agentId?: string
  parentAgentId?: string
  parentToolId?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  error?: string
  outputPreview?: string
  outputTruncated?: boolean
  outputBytes?: number
  outputLineCount?: number
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cachedInputTokens?: number
  reasoningOutputTokens?: number
  totalTokens?: number
  usedTokens?: number
  totalProcessedTokens?: number
  maxTokens?: number
  toolUses?: number
  durationMs?: number
  totalCostUsd?: number
  compactsAutomatically?: boolean
}

export interface ChatQuestion {
  id: string
  text: string
  options: { label: string; description?: string }[]
  answer?: string
  answeredAt?: string
}

export interface MessageDiff {
  path: string
  additions: number
  deletions: number
  oldText: string
  newText: string
  isNew: boolean
  /**
   * Set by a light transcript read: `oldText` and `newText` are empty and
   * the full message (`GET /threads/:id/messages/:messageId`) has them.
   */
  textOmitted?: boolean
}

export interface ChatMessage {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  turnId?: string | null
  reasoning?: string
  /** Wall-clock thinking time in ms, measured from the live reasoning stream. */
  reasoningDurationMs?: number
  toolCalls?: ToolCall[]
  questions?: ChatQuestion[]
  answeredQuestions?: { question: string; answer: string }[]
  diffs?: MessageDiff[]
  attachments?: ChatMessageAttachment[]
  usage?: TokenUsage
  modelId?: string
  /** Character count captured from the actual dispatched system instruction. */
  systemInstructionCharacters?: number
  compactedContext?: boolean
  internalContext?: "provider-handoff"
  /** A user message the backend sent by itself (thread-resume.ts). */
  automatic?: import("./thread-resume").AutomaticMessageKind
  compactionGeneration?: number
  transcriptTruncated?: boolean
  dispatchStatus?:
    | "pending"
    | "accepted"
    | "completed"
    | "failed"
    | "uncertain"
    | "reverted"
  dispatchFailed?: boolean
  createdAt: string
  /**
   * Storage order within the thread. Present on paged message reads, where
   * it is the cursor for the next older page (`beforeSequence`).
   */
  sequence?: number
}

export interface ChatThreadSession {
  providerKind?: string | null
  providerInstanceId?: string | null
  providerThreadId?: string | null
  resumeCursor?: unknown | null
  continuationKey?: string | null
  status?: string | null
  activeTurnId?: string | null
  lastError?: string | null
  runtimeMode?: string | null
  updatedAt?: string | null
}

export interface ChatThread {
  /** Provider-reported goal. Omitted until the backend has observed goal metadata. */
  goal?: import("./thread-goal").ThreadGoal | null
  /** The chat's Autonomous Work run. Omitted when it has none. */
  autonomy?: import("./thread-autonomy").ThreadAutonomy | null
  /**
   * A usage limit or a restart stopped the chat and it may continue by
   * itself (thread-resume.ts). Omitted when it has none.
   */
  resume?: import("./thread-resume").ThreadResume | null
  /**
   * The chat's own settings kept by the backend (permission level, model
   * selection, orchestration). Omitted until a client has set one.
   */
  settings?: import("./threads").ThreadSettings | null
  /** The Claude Code or Codex session an imported chat came from. */
  importedFrom?: import("./conversation-import").ThreadImportSource | null
  id: string
  title: string
  projectName: string
  projectPath: string
  envMode?: string | null
  branch?: string | null
  worktreePath?: string | null
  baseBranch?: string | null
  worktreeState?: string | null
  parentThreadId?: string | null
  codexThreadId?: string | null
  messages: ChatMessage[]
  /**
   * Persisted message count as maintained by the backend (SQLite column
   * `projection_threads.message_count`). Surfaced on `listThreads` so the
   * sidebar can tell "real chat, messages not hydrated yet" apart from
   * "empty + button placeholder" before lazy hydration kicks in.
   */
  messageCount?: number
  /** Last recorded assistant model, available before transcript hydration. */
  lastModelId?: string | null
  session?: ChatThreadSession | null
  usage?: TokenUsage & { usedTokens?: number; maxTokens?: number }
  createdAt: string
  updatedAt: string
}

export type ThreadActivityTone =
  | "thinking"
  | "tool"
  | "info"
  | "approval"
  | "error"

export interface ThreadActivity {
  id: string
  threadId: string
  turnId?: string | null
  providerInstanceId?: string | null
  kind: string
  tone: ThreadActivityTone
  summary: string
  payload: unknown
  sequence?: number | null
  createdAt: string
}
