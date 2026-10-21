import type {
  ToolCall,
  TokenUsage,
  ChatQuestion,
  ChatMessage,
  ChatThread,
  DesignBrief,
  ThreadActivity,
  ThreadGoal,
  AutonomyRunConfig,
  AutonomyStopReason,
  AutonomyTask,
  ThreadAutonomy,
} from "@betterc0de/schema"
import {
  AUTONOMY_DEFAULT_MAX_ITERATIONS,
  AUTONOMY_DEFAULT_TIME_BUDGET_MIN,
} from "@betterc0de/schema"
import type { ProviderComposerSelectionMap } from "@/lib/provider-composer-selection"

/** A chat's Autonomous Work run as the UI shows it; "idle": the chat has none. */
export type AutonomousStatus = "idle" | ThreadAutonomy["status"]

/** Reason an autonomous run stopped — surfaced to the user in the status bar. */
export type AutonomousStopReason = AutonomyStopReason

/** Single task row in an Autonomous Work run. */
export type AutonomousTask = AutonomyTask

export interface FinalizeStreamOptions {
  readonly messageId?: string
  readonly persist?: boolean
  readonly keepTurnActive?: boolean
}

/** One finished stretch of thinking, with the time it took. */
export interface ReasoningSegment {
  readonly id: string
  readonly text: string
  readonly startedAt: number | null
  readonly endedAt: number | null
}

/** Per-thread streaming state — each chat gets its own independent stream */
export interface ThreadStreamState {
  isStreaming: boolean
  streamingText: string
  streamingPlanText: string
  isPlanStreaming: boolean
  reasoningText: string
  isReasoning: boolean
  /**
   * Reasoning the agent finished before doing something else — running a
   * tool, or starting to answer. Kept as separate entries so a long turn
   * retains every phase and its timing. The UI groups them into one disclosure
   * without replacing earlier reasoning when a new phase starts.
   *
   * `reasoningText` remains the segment currently being written.
   */
  reasoningSegments: ReasoningSegment[]
  /** Timestamps of the first/last reasoning delta — used to persist the
      actual thinking duration onto the finalized assistant message. */
  reasoningStartedAt: number | null
  reasoningEndedAt: number | null
  /**
   * When the agent last did something other than think: the turn started,
   * answer text arrived, a tool started or finished. A reasoning block that
   * is delivered in one piece is timed from here — its own deltas span only
   * the delivery, which read as "Thought for 69ms" after a minute of work.
   */
  lastBoundaryAt: number | null
  streamingModelId: string | null
  streamingTools: ToolCall[]
  streamingTasks: { text: string; completed: boolean }[]
  streamingDiffs: {
    path: string
    additions: number
    deletions: number
    oldText: string
    newText: string
    isNew: boolean
  }[]
  pendingQuestions: ChatQuestion[]
  activeTurnId: string | null
}

export const emptyStreamState: ThreadStreamState = {
  isStreaming: false,
  streamingText: "",
  streamingPlanText: "",
  isPlanStreaming: false,
  reasoningText: "",
  isReasoning: false,
  reasoningSegments: [],
  reasoningStartedAt: null,
  reasoningEndedAt: null,
  lastBoundaryAt: null,
  streamingModelId: null,
  streamingTools: [],
  streamingTasks: [],
  streamingDiffs: [],
  pendingQuestions: [],
  activeTurnId: null,
}

/**
 * Per-thread composer settings. Every field is optional so a fresh thread
 * inherits whatever the global preferences (`usePreferencesStore`) are
 * set to when it was created — writes via `setThreadSetting` ONLY touch
 * the active thread, so flipping Plan mode in tab 1 no longer leaks into
 * tabs 3 / 4. `useAppPreferences` merges this map over the global
 * preferences at read time.
 */
export interface ThreadSettings {
  /** Per-chat provider permission pool. The selected chat model remains the coordinator. */
  orchestration?: import("@betterc0de/schema").ChatOrchestration
  orchestrationWorker?: boolean
  chatMode?: string
  thinkingMode?: string | null
  selectedModel?: string
  selectedProviderId?: string
  modelSelectionByProvider?: ProviderComposerSelectionMap
  permissionLevel?: string
  contextWindow?: "200k" | "1m"
  specialMode?: string | null
  designBrief?: DesignBrief
  /** Design-mode canvas: last preview URL for this thread's artboard. */
  designPreviewUrl?: string
  designPreviewSource?: import("@/lib/canvas-preview-source").CanvasPreviewSource
  /** Design-mode canvas: selected artboard device preset id. */
  designDevicePreset?: string
  /** Live devices shown together inside this chat's project frame. */
  designDevicePresets?: Array<"desktop" | "tablet" | "mobile">
  /** Design-mode canvas: the card's own size factor on top of the half-size
      preview (1 = default, clamped to the CARD_SCALE range). */
  designCardScale?: number
  /** Canvas card: show the runtime pane (requests, endpoints, logs, tools). */
  designRuntimePane?: boolean
  /** Provider-native `/goal` state mirrored into BetterC0de's composer UI. */
  goal?: ThreadGoal | null
  /** Local revision fences slow snapshots against newer provider metadata, including clears. */
  goalRevision?: number
  /** Shared by the chats one prompt started with several models (Compare). */
  compareGroupId?: string
}

export type { ThreadGoal, ThreadGoalStatus } from "@betterc0de/schema"

export interface CreateThreadOptions {
  envMode?: string | null
  branch?: string | null
  worktreePath?: string | null
  baseBranch?: string | null
  worktreeState?: string | null
  parentThreadId?: string | null
}

export type ThreadContextPatch = Partial<
  Pick<
    ChatThread,
    | "projectName"
    | "projectPath"
    | "envMode"
    | "branch"
    | "worktreePath"
    | "baseBranch"
    | "worktreeState"
    | "parentThreadId"
  >
>

/**
 * LRU cache sizing. We keep the last N threads' messages and activities
 * resident, counting prefetched neighbours too; older threads have their
 * `messages` array and activity log dropped (the thread itself stays in
 * the sidebar, just skeletal). Re-opening an evicted thread triggers a
 * single `loadMessages` page read which fills it back in within ~20–50ms.
 *
 * 10 is a sweet spot: average users hop between 2–4 threads per session,
 * so the cap is rarely hit; power users with many open sessions still keep
 * memory bounded (10 × ~1–5 MB of rendered messages).
 */
export const LRU_CAPACITY = 10

/** Debounce delay (ms) for persisting thread state to SQLite after edits. */
export const PERSIST_DEBOUNCE_MS = 500

/** Default cap for autonomous-mode iterations before the agent pauses. */
export const AUTONOMOUS_MAX_ITERATIONS = AUTONOMY_DEFAULT_MAX_ITERATIONS

/**
 * Default wall-clock budget for an autonomous run, in minutes. User-configurable
 * from the Autonomous Work dialog; 0 means "no time limit" (only iterations cap
 * applies). 90 min is a minimum floor suggested by the user — feel free to raise.
 */
export const AUTONOMOUS_DEFAULT_TIME_BUDGET_MIN =
  AUTONOMY_DEFAULT_TIME_BUDGET_MIN

export interface ChatState {
  threads: ChatThread[]
  activeThreadId: string | null
  /** Per-thread streaming state keyed by threadId */
  streamingByThread: Record<string, ThreadStreamState>
  activitiesByThread: Record<string, ThreadActivity[]>
  activitiesLoadedByThread: Record<string, boolean>
  messagesLoadedByThread: Record<string, boolean>
  messageHydrationErrorsByThread: Record<string, string>
  /**
   * Storage sequence of the oldest loaded message, per thread, while older
   * rows exist on the backend. Absent once the start of the chat is loaded.
   */
  olderMessagesCursorByThread: Record<string, number>
  /** True while an older page is being read for that thread. */
  olderMessagesLoadingByThread: Record<string, boolean>
  lruOrder: string[]
  pinnedThreadIds: Set<string>
  draftsByThread: Record<string, string>
  /** Per-thread composer settings (mode, model, thinking, permission, …).
   *  An empty entry means "inherit global prefs". Writes to the active
   *  thread's settings never leak into other threads — see the Plan-mode
   *  tab-leak bug (pre-fix: changing Chat 1 to Plan flipped Chat 3+4 too). */
  settingsByThread: Record<string, ThreadSettings>
  lastUsage: TokenUsage | null

  /**
   * Each chat's Autonomous Work run as the backend reports it (the thread
   * list, its `thread.metadata.updated` pushes and the control responses;
   * see `@/lib/chat/autonomy-sync`). The backend schedules the turns; a
   * chat without a run has no entry.
   */
  autonomyByThread: Record<string, ThreadAutonomy>
  // Actions
  setActiveThread: (id: string | null) => void
  /**
   * Loads the newest page of a thread's transcript. `force` re-reads that
   * page and merges it into what is already loaded. Pages are read light:
   * diff text and large inline attachments arrive as placeholders
   * (`textOmitted` / `dataOmitted`) until `hydrateFullMessage` fills them.
   */
  hydrateThreadMessages: (threadId: string, force?: boolean) => Promise<void>
  /**
   * Prepends the next older page, if the backend has one. Light unless
   * `light: false`.
   */
  loadOlderThreadMessages: (
    threadId: string,
    options?: { limit?: number; light?: boolean }
  ) => Promise<void>
  /**
   * Loads every page of a thread with every payload filled in. For commands
   * that read or copy the whole conversation (export, share, fork,
   * compaction, statistics). `payloads: false` loads the rows only, for a
   * caller that just shows or counts them.
   */
  ensureFullThreadMessages: (
    threadId: string,
    options?: { payloads?: boolean }
  ) => Promise<void>
  /**
   * Replaces a loaded message's diff text and attachment placeholders with
   * the full copy from the backend. Concurrent calls for one message share
   * one request; a thread that is not loaded is left alone.
   */
  hydrateFullMessage: (threadId: string, messageId: string) => Promise<void>
  hydrateThreadActivities: (threadId: string, force?: boolean) => Promise<void>
  setDraft: (threadId: string, text: string) => void
  getDraft: (threadId: string) => string
  /** Sets a single composer-setting field on the given thread. Only this
   *  thread's row in `settingsByThread` is touched — other threads keep
   *  reading their own override or falling through to the global pref. */
  setThreadSetting: <K extends keyof ThreadSettings>(
    threadId: string,
    key: K,
    value: ThreadSettings[K]
  ) => void
  getThreadSettings: (threadId: string | null | undefined) => ThreadSettings
  initializeThreadModelSettings: (threadId: string) => void
  /**
   * Takes over the settings the backend keeps with a chat after another
   * client changed them (a `thread.metadata` push, see
   * `@/lib/thread-settings-sync`), except this window's own changes still
   * on their way. Nothing is written back.
   */
  applyStoredThreadSettings: (
    threadId: string,
    change: import("@/lib/thread-settings-sync").ThreadSettingsChange
  ) => void
  pinThread: (threadId: string) => void
  unpinThread: (threadId: string) => void
  createThread: (
    title: string,
    projectName: string,
    projectPath?: string,
    options?: CreateThreadOptions
  ) => string
  /**
   * Branches a chat, keeping the original. `into` rebinds the fork to another
   * project folder — that is how a folder-less chat becomes a repo-scoped one
   * without losing the conversation it grew out of.
   */
  /** Seals the current reasoning stretch into its own block. */
  closeReasoningSegment: (threadId: string) => void
  forkThread: (
    sourceThreadId: string,
    into?: { projectPath: string; projectName: string },
    /** `throughMessageId` keeps the history up to and including that message. */
    options?: { throughMessageId?: string }
  ) => Promise<string | null>
  addMessage: (
    threadId: string,
    message: ChatMessage,
    options?: { persist?: boolean }
  ) => void
  appendStreamDelta: (threadId: string, delta: string) => void
  appendPlanStreamDelta: (threadId: string, delta: string) => void
  replacePlanStreamText: (threadId: string, text: string) => void
  appendReasoningDelta: (threadId: string, delta: string) => void
  setStreamingModelId: (threadId: string, modelId: string) => void
  setActiveTurnId: (threadId: string, turnId: string | null) => void
  setThreadActivities: (threadId: string, activities: ThreadActivity[]) => void
  upsertThreadActivity: (threadId: string, activity: ThreadActivity) => void
  addToolCall: (threadId: string, toolCall: ToolCall) => void
  updateToolCallInput: (
    threadId: string,
    toolId: string,
    input: unknown
  ) => void
  appendToolOutputDelta: (
    threadId: string,
    toolId: string,
    delta: string,
    toolName?: string,
    providerKind?: string,
    providerInstanceId?: string,
    /** "replace" for a cumulative snapshot of the whole output; default appends a chunk. */
    mode?: "append" | "replace"
  ) => void
  updateToolResult: (
    threadId: string,
    toolId: string,
    output: unknown,
    providerKind?: string,
    providerInstanceId?: string
  ) => void
  updateToolFailure: (
    threadId: string,
    toolId: string,
    error: string,
    output?: unknown,
    providerKind?: string,
    providerInstanceId?: string
  ) => void
  addQuestion: (threadId: string, question: ChatQuestion) => void
  answerQuestion: (threadId: string, questionId: string, answer: string) => void
  dismissPendingQuestions: (threadId: string) => void
  finalizeStream: (threadId: string, options?: FinalizeStreamOptions) => void
  clearStreaming: (threadId?: string) => void
  deleteThread: (threadId: string) => void
  updateThreadTitle: (threadId: string, title: string) => void
  updateThreadContext: (threadId: string, patch: ThreadContextPatch) => void
  updateThreadUsage: (
    threadId: string,
    usage: TokenUsage & { usedTokens?: number; maxTokens?: number }
  ) => void
  /**
   * Mirrors the backend's run of a chat (`null`: none). An older state of
   * the same run never replaces a newer one.
   */
  setThreadAutonomy: (threadId: string, autonomy: ThreadAutonomy | null) => void
}

/** One composer submission, as the submit hook and the message queue carry it. */
export interface ChatSubmitPayload {
  /** Explicit pane ownership; omitted for commands in the active chat. */
  threadId?: string | null
  text: string
  files: unknown[]
  visibleText?: string
  chatModeOverride?: string | null
  sourceProposedPlan?:
    | import("@/lib/plan-modal").SourceProposedPlanReference
    | null
  /**
   * While a turn runs: queue the message for after it, or steer it into the
   * turn. Left out, the "While the agent works, Enter…" setting decides;
   * Ctrl/Cmd+Enter in the composer sets the other one.
   */
  delivery?: "queue" | "steer"
  /** Stable identity and captured element tags for a queued draft's delivery. */
  queuedSubmission?: {
    id: string
    createdAt: string
    browserElements: import("@betterc0de/schema").BrowserElementReference[]
  }
  /**
   * Set by the Autonomous Work dialog: this message opens a run with these
   * tasks and limits, which the backend then continues on its own.
   */
  autonomy?: AutonomyRunConfig
}
