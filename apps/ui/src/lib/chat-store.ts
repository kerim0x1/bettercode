import { create } from "zustand"
import {
  mergeHandoffSnapshot,
  retainNewerHandoff,
} from "@/lib/provider-handoff"
import { usePreferencesStore } from "@/lib/preferences-store"
import { snapshotComposerModelSettings } from "@/lib/composer-settings"
import {
  upsertThreadMeta as upsertThreadMetaDb,
  saveThreadMessage as saveThreadMessageDb,
  saveThread as saveThreadDb,
  deleteThreadDb,
  loadMessage,
  loadMessages,
} from "@/services/backend/coreApi"
import { loadThreadActivities } from "@/services/backend/chatApi"
import {
  autoCheckpointFromToolCalls,
  useCheckpointStore,
} from "@/lib/checkpoint-store"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { parseQuestionsFromText } from "@/lib/question-parser"
import { createLogger } from "@/lib/logger"
import type {
  ToolCall,
  TokenUsage,
  ChatQuestion,
  ChatMessage,
  ChatThread,
  ThreadActivity,
} from "@betterc0de/schema"
import {
  type AutonomousStatus,
  type ChatState,
  type ThreadStreamState,
  type ThreadSettings,
  emptyStreamState,
  PERSIST_DEBOUNCE_MS,
  type ThreadContextPatch,
} from "./chat/types"
import {
  applyLru,
  generateId,
  hydrationInFlight,
  mergeMessageSnapshot,
  metaSaveTimeouts,
  oldestMessageSequence,
  type LruOptions,
} from "./chat/pure-helpers"
import { deriveThreadAttention } from "@/lib/pending-attention"
import {
  applyThreadSettingsChange,
  queueThreadSettingsChange,
  threadSettingsChange,
  unsettledThreadSettingKeys,
} from "@/lib/thread-settings-sync"
import {
  keepLoadedMessagePayloads,
  messageHasOmittedAttachmentData,
  messageHasOmittedPayload,
  withFullMessagePayloads,
} from "./chat/message-payloads"

const log = createLogger("chat-store")

/**
 * Transcript paging. Opening a chat reads only its newest page; older rows
 * load when the transcript asks for them (scrolling up, "Show earlier
 * messages"). The provider history sent with a turn uses at most the newest
 * 80 messages of the active context (see `buildWireHistory`), so the first
 * page must stay above that.
 */
export const INITIAL_MESSAGE_PAGE_SIZE = 100
export const OLDER_MESSAGE_PAGE_SIZE = 100
/** Backend maximum; used when a command needs the whole transcript. */
const FULL_TRANSCRIPT_PAGE_SIZE = 2_000

/** The threads listed directly above and below `threadId`. */
function sidebarNeighbourIds(
  threads: ReadonlyArray<{ id: string }>,
  threadId: string
): [string | undefined, string | undefined] {
  const index = threads.findIndex((thread) => thread.id === threadId)
  if (index < 0) return [undefined, undefined]
  return [threads[index - 1]?.id, threads[index + 1]?.id]
}

/** Rows the LRU must keep: an open approval, question or plan review. */
function lruOptionsFor(
  state: Pick<ChatState, "activitiesByThread">
): LruOptions {
  return {
    keepResident: (threadId) => {
      const activities = state.activitiesByThread[threadId]
      return Boolean(
        activities?.length &&
        deriveThreadAttention(threadId, activities).total > 0
      )
    },
  }
}

// ── Local messages a server snapshot may not contain yet ────────────────
// A forced hydration merges the server page into the transcript (see
// `mergeMessageSnapshot`). These two registries name the local rows that
// survive the merge even though the page lacks them.

/** Message ids whose save is still queued or in flight, per thread. */
const unsyncedMessageIds = new Map<string, Map<string, number>>()
/** Ids added to a thread while one of its hydrations was reading. */
const hydrationWatchers = new Map<string, Set<Set<string>>>()

function markMessageUnsynced(threadId: string, messageId: string) {
  let ids = unsyncedMessageIds.get(threadId)
  if (!ids) {
    ids = new Map()
    unsyncedMessageIds.set(threadId, ids)
  }
  ids.set(messageId, (ids.get(messageId) ?? 0) + 1)
}

function markMessageSynced(threadId: string, messageId: string) {
  const ids = unsyncedMessageIds.get(threadId)
  const pending = ids?.get(messageId)
  if (!ids || pending === undefined) return
  if (pending > 1) ids.set(messageId, pending - 1)
  else ids.delete(messageId)
  if (ids.size === 0) unsyncedMessageIds.delete(threadId)
}

function watchLocalMessages(threadId: string): {
  readonly ids: Set<string>
  readonly stop: () => void
} {
  const ids = new Set<string>()
  let watchers = hydrationWatchers.get(threadId)
  if (!watchers) {
    watchers = new Set()
    hydrationWatchers.set(threadId, watchers)
  }
  watchers.add(ids)
  return {
    ids,
    stop: () => {
      const current = hydrationWatchers.get(threadId)
      current?.delete(ids)
      if (current?.size === 0) hydrationWatchers.delete(threadId)
    },
  }
}

function noteLocalMessage(threadId: string, messageId: string) {
  hydrationWatchers.get(threadId)?.forEach((ids) => ids.add(messageId))
}

/**
 * Rows projected from a backend response (`persist: false`) that the
 * backend stores itself. Until a page shows them they may still be in the
 * backend's write path, so a refresh keeps them for a short while.
 */
const awaitingServerMessages = new Map<string, Map<string, number>>()
const AWAITING_SERVER_GRACE_MS = 120_000

function markMessageAwaitingServer(threadId: string, messageId: string) {
  let ids = awaitingServerMessages.get(threadId)
  if (!ids) {
    ids = new Map()
    awaitingServerMessages.set(threadId, ids)
  }
  ids.set(messageId, Date.now())
}

/** Rows a server page returned are no longer waiting for the server. */
function noteServerMessages(
  threadId: string,
  page: ReadonlyArray<{ id: string }>
) {
  const ids = awaitingServerMessages.get(threadId)
  if (!ids) return
  for (const message of page) ids.delete(message.id)
  if (ids.size === 0) awaitingServerMessages.delete(threadId)
}

function localMessageIdsToKeep(
  threadId: string,
  watched: ReadonlySet<string>
): Set<string> {
  const keep = new Set(watched)
  unsyncedMessageIds.get(threadId)?.forEach((_count, id) => keep.add(id))
  const awaiting = awaitingServerMessages.get(threadId)
  if (awaiting) {
    const now = Date.now()
    awaiting.forEach((insertedAt, id) => {
      if (now - insertedAt < AWAITING_SERVER_GRACE_MS) keep.add(id)
      else awaiting.delete(id)
    })
    if (awaiting.size === 0) awaitingServerMessages.delete(threadId)
  }
  return keep
}

function withoutKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record
  const rest = { ...record }
  delete rest[key]
  return rest
}

function withCursor(
  cursors: Record<string, number>,
  threadId: string,
  cursor: number | undefined
): Record<string, number> {
  if (cursor === undefined) return withoutKey(cursors, threadId)
  if (cursors[threadId] === cursor) return cursors
  return { ...cursors, [threadId]: cursor }
}

const olderPageInFlight = new Map<string, Promise<void>>()
/** Full-message reads in flight, keyed by thread and message id. */
const fullMessageInFlight = new Map<string, Promise<void>>()
/** Full-message reads `ensureFullThreadMessages` runs at once. */
const FULL_MESSAGE_FETCH_CONCURRENCY = 4

/**
 * A message read light still carries placeholders for its diff text or
 * attachment data. Writing it back as-is would ask the backend to store
 * the placeholders, so the full copy is read first and its payloads are
 * folded in; everything else stays as the store has it.
 */
async function withPersistablePayloads(
  threadId: string,
  message: ChatMessage
): Promise<ChatMessage> {
  if (!messageHasOmittedPayload(message)) return message
  const restored = withFullMessagePayloads(
    message,
    await loadMessage(threadId, message.id)
  )
  // The backend keeps stored diff text over a placeholder, but rejects an
  // attachment without its data.
  if (messageHasOmittedAttachmentData(restored)) {
    throw new Error(
      `Attachment data for message ${message.id} is unavailable; not saving placeholders.`
    )
  }
  return restored
}

// Re-exports so the 45+ importers of `@/lib/chat-store` keep resolving
// ToolCall/TokenUsage/ChatQuestion/ChatMessage/ChatThread and the local types.
export type {
  ToolCall,
  TokenUsage,
  ChatQuestion,
  ChatMessage,
  ChatThread,
  ThreadActivity,
  AutonomousStatus,
  ThreadStreamState,
}
export { emptyStreamState }
export {
  getThreadStream,
  useActiveThread,
  useThreadById,
  useThreadMessages,
  useThreadActivities,
  useActiveMessages,
} from "./chat/selectors"

// ── Persistence helpers (store-coupled; kept here so they can read
//    `useChatStore.getState()` without a circular import dance) ────────────

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Error"
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

const TOOL_OUTPUT_PREVIEW_LIMIT = 16_000
const MAX_THREAD_PROPOSED_PLAN_ACTIVITIES = 200
// Non-plan activities (tool/task/work cards) are transient UI state. A single
// tool-heavy turn can emit thousands of `tool.updated` upserts, so we keep only
// a bounded tail in memory — otherwise the array (and the per-event insert cost)
// grows without bound. The full history stays in SQLite and re-hydrates on
// reopen; a chat that scrolls back further than this reads it from there.
const MAX_THREAD_OTHER_ACTIVITIES = 1_000

// Debug trace flag. Read once at module load instead of on every reasoning
// delta — toggling it via localStorage takes effect after a reload, which is
// fine for a diagnostic flag and keeps a synchronous storage read out of the
// per-delta streaming hot path.
const REASONING_TRACE_ENABLED = (() => {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("betterc0de:trace-provider-events") === "1"
    )
  } catch {
    return false
  }
})()
const THREAD_CONTEXT_KEYS = [
  "projectName",
  "projectPath",
  "envMode",
  "branch",
  "worktreePath",
  "baseBranch",
  "worktreeState",
  "parentThreadId",
] as const satisfies ReadonlyArray<keyof ThreadContextPatch>

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output
  if (output === null || output === undefined) return ""
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

function summarizeToolOutput(output: unknown) {
  const text = stringifyToolOutput(output)
  const truncated = text.length > TOOL_OUTPUT_PREVIEW_LIMIT
  const preview = truncated ? text.slice(0, TOOL_OUTPUT_PREVIEW_LIMIT) : text
  return {
    outputPreview: preview,
    outputTruncated: truncated,
    outputBytes: text.length,
    outputLineCount: text ? text.split(/\r?\n/).length : 0,
  }
}

function toolDurationMs(
  startedAt: string | undefined,
  completedAt: string
): number | undefined {
  if (!startedAt) return undefined
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Math.max(0, end - start)
}

function compareThreadActivities(a: ThreadActivity, b: ThreadActivity): number {
  const aSeq =
    typeof a.sequence === "number" ? a.sequence : Number.NEGATIVE_INFINITY
  const bSeq =
    typeof b.sequence === "number" ? b.sequence : Number.NEGATIVE_INFINITY
  if (aSeq !== bSeq) return aSeq - bSeq
  const created = a.createdAt.localeCompare(b.createdAt)
  if (created !== 0) return created
  return a.id.localeCompare(b.id)
}

function isProposedPlanActivity(activity: ThreadActivity): boolean {
  return (
    activity.kind === "turn.proposed.completed" ||
    activity.kind === "turn_proposed_completed"
  )
}

/**
 * Enforce the per-class retention caps on an array that is already sorted
 * ascending. Drops the oldest entries first in each class (plan / other) while
 * preserving the remaining order. Returns the input untouched when both classes
 * are within their caps so callers keep the same reference on the common path.
 */
function enforceActivityCaps(sorted: ThreadActivity[]): ThreadActivity[] {
  let planCount = 0
  let otherCount = 0
  for (const activity of sorted) {
    if (isProposedPlanActivity(activity)) planCount += 1
    else otherCount += 1
  }
  let planDrop = Math.max(0, planCount - MAX_THREAD_PROPOSED_PLAN_ACTIVITIES)
  let otherDrop = Math.max(0, otherCount - MAX_THREAD_OTHER_ACTIVITIES)
  if (planDrop === 0 && otherDrop === 0) return sorted

  const result: ThreadActivity[] = []
  for (const activity of sorted) {
    if (isProposedPlanActivity(activity)) {
      if (planDrop > 0) {
        planDrop -= 1
        continue
      }
    } else if (otherDrop > 0) {
      otherDrop -= 1
      continue
    }
    result.push(activity)
  }
  return result
}

function capThreadActivities(
  activities: ReadonlyArray<ThreadActivity>
): ThreadActivity[] {
  return enforceActivityCaps([...activities].sort(compareThreadActivities))
}

/**
 * Insert or replace `activity` in an array that maintains ascending
 * `compareThreadActivities` order, without re-sorting the whole array on the
 * streaming hot path. Provider events arrive in near-sequence order, so an
 * insertion-sort from the tail is O(1) amortized; a full sort is used only as a
 * fallback when a replacement genuinely breaks local ordering.
 */
function upsertActivitySorted(
  existing: ReadonlyArray<ThreadActivity>,
  activity: ThreadActivity
): ThreadActivity[] {
  // Updates almost always target a recent activity, so search from the tail.
  let idx = -1
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    if (existing[index].id === activity.id) {
      idx = index
      break
    }
  }
  if (idx >= 0) {
    activity = retainNewerHandoff(existing[idx], activity)
    const next = existing.slice()
    next[idx] = activity
    const brokeOrder =
      (idx > 0 && compareThreadActivities(next[idx - 1], activity) > 0) ||
      (idx < next.length - 1 &&
        compareThreadActivities(activity, next[idx + 1]) > 0)
    if (brokeOrder) next.sort(compareThreadActivities)
    return enforceActivityCaps(next)
  }
  const next = existing.slice()
  let i = next.length
  next.push(activity)
  while (i > 0 && compareThreadActivities(next[i - 1], activity) > 0) {
    next[i] = next[i - 1]
    i -= 1
  }
  next[i] = activity
  return enforceActivityCaps(next)
}

/** Persist thread to SQLite (per-thread debounce).
 *
 *  Gated on `messagesLoadedByThread` — if the thread was evicted from the
 *  LRU, `messages: []` is a skeleton, not the ground truth. Saving that
 *  to SQLite would wipe the stored history; skip instead and trust the
 *  DB copy until the user reopens the thread (which re-hydrates). */
function persistThread(threadId: string) {
  if (metaSaveTimeouts.has(threadId))
    clearTimeout(metaSaveTimeouts.get(threadId)!)
  metaSaveTimeouts.set(
    threadId,
    setTimeout(() => {
      metaSaveTimeouts.delete(threadId)
      const thread = useChatStore
        .getState()
        .threads.find((t) => t.id === threadId)
      if (!thread) return
      upsertThreadMetaDb(thread).catch((err) => {
        log.error(
          "[chat-store] Failed to persist thread metadata",
          threadId,
          describeError(err)
        )
      })
    }, PERSIST_DEBOUNCE_MS)
  )
}

/** Persist immediately (for addMessage — backend needs current DB state) */
function persistThreadNow(threadId: string) {
  if (metaSaveTimeouts.has(threadId))
    clearTimeout(metaSaveTimeouts.get(threadId)!)
  metaSaveTimeouts.delete(threadId)
  const thread = useChatStore.getState().threads.find((t) => t.id === threadId)
  if (!thread) return
  upsertThreadMetaDb(thread).catch((err) => {
    log.error(
      "[chat-store] Failed to persist thread metadata",
      threadId,
      describeError(err)
    )
  })
}

/** Tail of each thread's save queue; saves for one thread run in order. */
const persistQueues = new Map<string, Promise<void>>()

function persistMessage(threadId: string, message: ChatMessage) {
  const thread = useChatStore.getState().threads.find((t) => t.id === threadId)
  if (!thread) return

  markMessageUnsynced(threadId, message.id)
  // Order matters: the backend's `POST /threads/:id/messages` calls
  // `assertThreadExists` before inserting. If the message save lands
  // before the corresponding thread meta upsert commits, SQLite 404s the
  // insert and the message is lost. Chain with `.then` so the message
  // save only fires after the meta upsert settles.
  //
  // Saves for one thread are queued behind each other, so two quick
  // messages reach the server (and its sequence order) in the order they
  // were added. An empty queue starts the save synchronously.
  const save = () =>
    upsertThreadMetaDb(
      useChatStore.getState().threads.find((t) => t.id === threadId) ?? thread
    )
      .then(() => withPersistablePayloads(threadId, message))
      .then((persistable) => saveThreadMessageDb(threadId, persistable))
  const previous = persistQueues.get(threadId)
  const saved = previous ? previous.then(save, save) : save()
  const settled: Promise<void> = saved.then(
    () => {
      // A failed save stays unsynced, so a refresh keeps showing it.
      markMessageSynced(threadId, message.id)
    },
    (err) => {
      log.error(
        "[chat-store] Failed to persist thread message",
        threadId,
        message.id,
        describeError(err)
      )
    }
  )
  persistQueues.set(threadId, settled)
  void settled.finally(() => {
    if (persistQueues.get(threadId) === settled) persistQueues.delete(threadId)
  })
}

function forkTitle(title: string): string {
  const base = title.trim() || "New Chat"
  return /\(fork\)$/i.test(base) ? base : `${base} (fork)`
}

function clonePlain<T>(value: T): T {
  if (value === undefined || value === null) return value
  return JSON.parse(JSON.stringify(value)) as T
}

/** Only model-related composer state follows a newly-created chat. Modes such
 * as Plan/Ask and permissions stay thread-local and use their normal defaults. */
function modelSettingsForNewThread(
  settings: ThreadSettings | undefined
): ThreadSettings | undefined {
  if (!settings) return undefined
  const inherited: ThreadSettings = {}
  if (settings.selectedModel?.trim()) {
    inherited.selectedModel = settings.selectedModel
  }
  if (settings.selectedProviderId?.trim()) {
    inherited.selectedProviderId = settings.selectedProviderId
  }
  if (
    settings.modelSelectionByProvider &&
    Object.keys(settings.modelSelectionByProvider).length > 0
  ) {
    inherited.modelSelectionByProvider = clonePlain(
      settings.modelSelectionByProvider
    )
  }
  return Object.keys(inherited).length > 0 ? inherited : undefined
}

function cloneMessageForFork(message: ChatMessage): ChatMessage {
  const cloned: ChatMessage = {
    id: generateId(),
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    turnId: null,
  }

  if (message.reasoning !== undefined) cloned.reasoning = message.reasoning
  if (message.reasoningDurationMs !== undefined) {
    cloned.reasoningDurationMs = message.reasoningDurationMs
  }
  if (message.toolCalls !== undefined) {
    cloned.toolCalls = clonePlain(message.toolCalls).map((tool) => ({
      ...tool,
      id: generateId(),
      turnId: undefined,
    }))
  }
  if (message.questions !== undefined) {
    cloned.questions = clonePlain(message.questions)
  }
  if (message.answeredQuestions !== undefined) {
    cloned.answeredQuestions = clonePlain(message.answeredQuestions)
  }
  if (message.diffs !== undefined) cloned.diffs = clonePlain(message.diffs)
  if (message.attachments !== undefined) {
    cloned.attachments = clonePlain(message.attachments)
  }
  if (message.usage !== undefined) cloned.usage = clonePlain(message.usage)
  if (message.modelId !== undefined) cloned.modelId = message.modelId
  if (message.compactedContext === true) cloned.compactedContext = true
  if (message.internalContext === "provider-handoff")
    cloned.internalContext = "provider-handoff"
  if (message.compactionGeneration !== undefined) {
    cloned.compactionGeneration = message.compactionGeneration
  }

  return cloned
}

// ── Per-thread settings persistence ─────────────────────────────────────
// Each chat tab can override global defaults (selectedModel, providerId,
// chatMode, …) via `setThreadSetting`. Without this localStorage layer
// those overrides reset to global defaults on every reload — so the user
// has to re-pick the model for every chat. We snapshot `settingsByThread`
// on every change and rehydrate on store creation.

const THREAD_SETTINGS_STORAGE_KEY = "betterc0de-thread-settings"

function loadPersistedThreadSettings(): Record<
  string,
  Record<string, unknown>
> {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(THREAD_SETTINGS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {}
    return parsed as Record<string, Record<string, unknown>>
  } catch {
    return {}
  }
}

let threadSettingsSaveTimer: ReturnType<typeof setTimeout> | null = null
const activityHydrationInFlight = new Map<string, Promise<void>>()
const forcedMessageHydrationQueued = new Map<string, Promise<void>>()
const forcedActivityHydrationQueued = new Map<string, Promise<void>>()

/**
 * Writes the store's per-thread settings to the localStorage cache, after
 * the backend's copies were merged in (use-persisted-threads).
 */
export function cacheThreadSettings(): void {
  persistThreadSettings(
    useChatStore.getState().settingsByThread as Record<
      string,
      Record<string, unknown>
    >
  )
}

function persistThreadSettings(
  settings: Record<string, Record<string, unknown>>
) {
  if (typeof localStorage === "undefined") return
  if (threadSettingsSaveTimer) clearTimeout(threadSettingsSaveTimer)
  threadSettingsSaveTimer = setTimeout(() => {
    threadSettingsSaveTimer = null
    try {
      localStorage.setItem(
        THREAD_SETTINGS_STORAGE_KEY,
        JSON.stringify(settings)
      )
    } catch {
      // Silent fail — quota / disabled storage shouldn't crash the app.
    }
  }, 200)
}

/** Apply parsed questions to the last assistant message in a thread */
function applyQuestionsToThread(threadId: string, text: string) {
  const parsed = parseQuestionsFromText(text)
  if (parsed.length === 0) return

  const thread = useChatStore.getState().threads.find((t) => t.id === threadId)
  if (!thread) return
  let lastIdx = -1
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (thread.messages[i].role === "assistant") {
      lastIdx = i
      break
    }
  }
  if (lastIdx === -1) return

  useChatStore.setState((state) => ({
    threads: state.threads.map((t) => {
      if (t.id !== threadId) return t
      return {
        ...t,
        messages: t.messages.map((m, i) =>
          i === lastIdx ? { ...m, questions: parsed } : m
        ),
      }
    }),
  }))

  const updatedMessage = useChatStore
    .getState()
    .threads.find((t) => t.id === threadId)?.messages[lastIdx]
  if (updatedMessage) persistMessage(threadId, updatedMessage)
}

// ── Store ────────────────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  threads: [],
  activeThreadId: null,
  streamingByThread: {},
  activitiesByThread: {},
  activitiesLoadedByThread: {},
  messagesLoadedByThread: {},
  messageHydrationErrorsByThread: {},
  olderMessagesCursorByThread: {},
  olderMessagesLoadingByThread: {},
  lruOrder: [],
  pinnedThreadIds: new Set(),
  draftsByThread: {},
  // Hydrate per-thread overrides (model, provider, chat mode, …) from
  // localStorage so the user's last-picked model for each chat survives
  // an app restart instead of falling back to the global default.
  settingsByThread:
    loadPersistedThreadSettings() as ChatState["settingsByThread"],
  lastUsage: null,

  // Autonomous Work runs, as the backend reports them.
  autonomyByThread: {},

  setActiveThread: (id) => {
    if (!id) {
      set({ activeThreadId: null })
      return
    }
    set((s) => {
      // The sidebar neighbours are prefetched below. Keeping the resident
      // ones avoids evicting a thread only to read it again a moment later.
      const neighbours = sidebarNeighbourIds(s.threads, id)
      const base = lruOptionsFor(s)
      return {
        activeThreadId: id,
        ...applyLru({ ...s, activeThreadId: id }, id, {
          keepResident: (threadId) =>
            neighbours.includes(threadId) ||
            base.keepResident?.(threadId) === true,
        }),
      }
    })
    const state = get()
    void state.hydrateThreadMessages(id)
    void state.hydrateThreadActivities(id)
    const idx = state.threads.findIndex((t) => t.id === id)
    if (idx >= 0) {
      const [prev, next] = sidebarNeighbourIds(state.threads, id)
      if (prev) void state.hydrateThreadMessages(prev)
      if (next) void state.hydrateThreadMessages(next)
      if (prev) void state.hydrateThreadActivities(prev)
      if (next) void state.hydrateThreadActivities(next)
    }
  },

  hydrateThreadMessages: async (threadId, force = false) => {
    const s = get()
    if (
      s.messagesLoadedByThread[threadId] &&
      !s.messageHydrationErrorsByThread[threadId] &&
      !force
    ) {
      return
    }
    const existing = hydrationInFlight.get(threadId)
    if (existing) {
      if (!force) return existing
      const alreadyQueued = forcedMessageHydrationQueued.get(threadId)
      if (alreadyQueued) return alreadyQueued
      const queued = existing
        .then(() => get().hydrateThreadMessages(threadId, true))
        .finally(() => forcedMessageHydrationQueued.delete(threadId))
      forcedMessageHydrationQueued.set(threadId, queued)
      return queued
    }

    const promise = (async () => {
      // Rows added while the read runs are not in its snapshot; the merge
      // below must not drop them.
      const watcher = watchLocalMessages(threadId)
      try {
        const raw = (await loadMessages(threadId, {
          limit: INITIAL_MESSAGE_PAGE_SIZE,
          light: true,
        })) as ChatMessage[] | null
        const page = Array.isArray(raw) ? raw : []
        noteServerMessages(threadId, page)
        const pageHasOlder =
          page.length >= INITIAL_MESSAGE_PAGE_SIZE &&
          oldestMessageSequence(page) !== undefined
        set((state) => {
          const messageHydrationErrorsByThread = {
            ...state.messageHydrationErrorsByThread,
          }
          delete messageHydrationErrorsByThread[threadId]
          const local =
            state.threads.find((t) => t.id === threadId)?.messages ?? []
          // Merge rather than replace: a forced refresh (replay gap) must not
          // erase a message sent or answered while this read was running,
          // nor the older history the user already paged in.
          const merged = mergeMessageSnapshot({
            local,
            // Payloads already read in full survive a light re-read.
            page: keepLoadedMessagePayloads(page, local),
            pageHasOlder,
            previousCursor: state.olderMessagesCursorByThread[threadId],
            keepLocalIds: localMessageIdsToKeep(threadId, watcher.ids),
          })
          return {
            threads: state.threads.map((t) =>
              t.id === threadId ? { ...t, messages: merged.messages } : t
            ),
            messagesLoadedByThread: {
              ...state.messagesLoadedByThread,
              [threadId]: true,
            },
            messageHydrationErrorsByThread,
            olderMessagesCursorByThread: withCursor(
              state.olderMessagesCursorByThread,
              threadId,
              merged.olderCursor
            ),
          }
        })
      } catch (err) {
        // Previously the catch was empty and `messagesLoadedByThread`
        // stayed `false`. Downstream, `addMessage` reads that flag and
        // recursively calls itself after `hydrateThreadMessages` resolves
        // — when hydration kept failing, the recursion re-entered hydrate
        // forever and the new message was NEVER added to the store,
        // which is why the user saw "chat doesn't save". Mark the thread
        // as loaded on failure so new messages flow through and the real
        // error is surfaced to the console instead of silently eaten.
        const detail = describeError(err)
        log.error(
          "[chat-store] Failed to hydrate thread messages",
          threadId,
          detail
        )
        set((state) => ({
          messagesLoadedByThread: {
            ...state.messagesLoadedByThread,
            [threadId]: true,
          },
          messageHydrationErrorsByThread: {
            ...state.messageHydrationErrorsByThread,
            [threadId]: detail,
          },
        }))
      } finally {
        watcher.stop()
        hydrationInFlight.delete(threadId)
      }
    })()
    hydrationInFlight.set(threadId, promise)
    return promise
  },

  loadOlderThreadMessages: (threadId, options) => {
    const existing = olderPageInFlight.get(threadId)
    if (existing) return existing
    const start = get()
    const cursor = start.olderMessagesCursorByThread[threadId]
    if (cursor === undefined || !start.messagesLoadedByThread[threadId]) {
      return Promise.resolve()
    }
    const limit = Math.min(
      FULL_TRANSCRIPT_PAGE_SIZE,
      Math.max(1, Math.floor(options?.limit ?? OLDER_MESSAGE_PAGE_SIZE))
    )
    const promise = (async () => {
      set((state) => ({
        olderMessagesLoadingByThread: {
          ...state.olderMessagesLoadingByThread,
          [threadId]: true,
        },
      }))
      try {
        const raw = (await loadMessages(threadId, {
          limit,
          beforeSequence: cursor,
          light: options?.light !== false,
        })) as ChatMessage[] | null
        const page = Array.isArray(raw) ? raw : []
        noteServerMessages(threadId, page)
        set((state) => {
          const olderMessagesLoadingByThread = withoutKey(
            state.olderMessagesLoadingByThread,
            threadId
          )
          const thread = state.threads.find((t) => t.id === threadId)
          // An eviction or a refresh moved the cursor while this read ran;
          // its rows no longer line up with the transcript.
          if (
            !thread ||
            !state.messagesLoadedByThread[threadId] ||
            state.olderMessagesCursorByThread[threadId] !== cursor
          ) {
            return { olderMessagesLoadingByThread }
          }
          const known = new Set(thread.messages.map((message) => message.id))
          const older = page.filter((message) => !known.has(message.id))
          const oldest = oldestMessageSequence(page)
          const nextCursor =
            page.length >= limit && oldest !== undefined && oldest < cursor
              ? oldest
              : undefined
          return {
            threads:
              older.length === 0
                ? state.threads
                : state.threads.map((t) =>
                    t.id === threadId
                      ? { ...t, messages: [...older, ...t.messages] }
                      : t
                  ),
            olderMessagesCursorByThread: withCursor(
              state.olderMessagesCursorByThread,
              threadId,
              nextCursor
            ),
            olderMessagesLoadingByThread,
          }
        })
      } catch (err) {
        log.error(
          "[chat-store] Failed to load earlier thread messages",
          threadId,
          describeError(err)
        )
        set((state) => ({
          olderMessagesLoadingByThread: withoutKey(
            state.olderMessagesLoadingByThread,
            threadId
          ),
        }))
      } finally {
        olderPageInFlight.delete(threadId)
      }
    })()
    olderPageInFlight.set(threadId, promise)
    return promise
  },

  ensureFullThreadMessages: async (threadId, options) => {
    const payloads = options?.payloads !== false
    await get().hydrateThreadMessages(threadId)
    // Bounded: 2,000 rows per page covers a million-message transcript.
    for (let page = 0; page < 500; page += 1) {
      const state = get()
      const cursor = state.olderMessagesCursorByThread[threadId]
      if (cursor === undefined || !state.messagesLoadedByThread[threadId]) {
        break
      }
      // Rows read for a whole-conversation command arrive in full, so only
      // the light pages read before need a second look below.
      await state.loadOlderThreadMessages(threadId, {
        limit: FULL_TRANSCRIPT_PAGE_SIZE,
        light: !payloads,
      })
      // A failed read leaves the cursor in place; stop instead of spinning.
      if (get().olderMessagesCursorByThread[threadId] === cursor) break
    }
    if (!payloads) return
    const pending = (
      get().threads.find((thread) => thread.id === threadId)?.messages ?? []
    )
      .filter(messageHasOmittedPayload)
      .map((message) => message.id)
    const worker = async () => {
      for (let next = pending.shift(); next; next = pending.shift()) {
        const messageId = next
        await get()
          .hydrateFullMessage(threadId, messageId)
          .catch((err) => {
            log.error(
              "[chat-store] Failed to load full message",
              threadId,
              messageId,
              describeError(err)
            )
          })
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(FULL_MESSAGE_FETCH_CONCURRENCY, pending.length) },
        worker
      )
    )
  },

  hydrateFullMessage: (threadId, messageId) => {
    const key = `${threadId}\u0000${messageId}`
    const existing = fullMessageInFlight.get(key)
    if (existing) return existing
    const current = get()
      .threads.find((thread) => thread.id === threadId)
      ?.messages.find((message) => message.id === messageId)
    if (!current || !messageHasOmittedPayload(current)) {
      return Promise.resolve()
    }
    const promise = (async () => {
      try {
        const full = await loadMessage(threadId, messageId)
        set((state) => {
          // An evicted thread is read again (light) when it is reopened.
          if (!state.messagesLoadedByThread[threadId]) return state
          let changed = false
          const threads = state.threads.map((thread) => {
            if (thread.id !== threadId) return thread
            const messages = thread.messages.map((message) => {
              if (message.id !== messageId) return message
              // Fold into the message as it is now, not as it was when the
              // read started: a streamed update must not be rolled back.
              const next = withFullMessagePayloads(message, full)
              if (next !== message) changed = true
              return next
            })
            return changed ? { ...thread, messages } : thread
          })
          return changed ? { threads } : state
        })
      } finally {
        fullMessageInFlight.delete(key)
      }
    })()
    fullMessageInFlight.set(key, promise)
    return promise
  },

  hydrateThreadActivities: async (threadId, force = false) => {
    const s = get()
    if (s.activitiesLoadedByThread[threadId] && !force) return
    const existing = activityHydrationInFlight.get(threadId)
    if (existing) {
      if (!force) return existing
      const alreadyQueued = forcedActivityHydrationQueued.get(threadId)
      if (alreadyQueued) return alreadyQueued
      const queued = existing
        .then(() => get().hydrateThreadActivities(threadId, true))
        .finally(() => forcedActivityHydrationQueued.delete(threadId))
      forcedActivityHydrationQueued.set(threadId, queued)
      return queued
    }

    const promise = (async () => {
      try {
        const activities = await loadThreadActivities(threadId)
        set((state) => ({
          activitiesByThread: {
            ...state.activitiesByThread,
            [threadId]: Array.isArray(activities)
              ? capThreadActivities(
                  mergeHandoffSnapshot(
                    activities,
                    state.activitiesByThread[threadId] ?? [],
                    s.activitiesByThread[threadId] ?? []
                  )
                )
              : [],
          },
          activitiesLoadedByThread: {
            ...state.activitiesLoadedByThread,
            [threadId]: true,
          },
        }))
      } catch (err) {
        log.error(
          "[chat-store] Failed to hydrate thread activities",
          threadId,
          describeError(err)
        )
        set((state) => ({
          activitiesLoadedByThread: {
            ...state.activitiesLoadedByThread,
            [threadId]: true,
          },
        }))
      } finally {
        activityHydrationInFlight.delete(threadId)
      }
    })()
    activityHydrationInFlight.set(threadId, promise)
    return promise
  },

  setDraft: (threadId, text) =>
    set((state) => {
      if (!text) {
        if (!(threadId in state.draftsByThread)) return state
        const rest = { ...state.draftsByThread }
        delete rest[threadId]
        return { draftsByThread: rest }
      }
      return {
        draftsByThread: { ...state.draftsByThread, [threadId]: text },
      }
    }),

  getDraft: (threadId) => get().draftsByThread[threadId] ?? "",

  setThreadSetting: (threadId, key, value) =>
    set((state) => {
      if (!threadId) return state
      const prev = state.settingsByThread[threadId] ?? {}
      // Setting to `undefined` means "clear override and inherit global pref".
      if (value === undefined) {
        if (!(key in prev)) return state
        const next = { ...prev }
        delete next[key]
        // The backend keeps some of these with the chat; it hears the clear.
        queueThreadSettingsChange(threadId, threadSettingsChange(prev, next))
        // If the thread now has no overrides, drop its row entirely so
        // `settingsByThread` doesn't grow with empty objects.
        if (Object.keys(next).length === 0) {
          const restSettings = { ...state.settingsByThread }
          delete restSettings[threadId]
          persistThreadSettings(
            restSettings as Record<string, Record<string, unknown>>
          )
          return { settingsByThread: restSettings }
        }
        const updated = { ...state.settingsByThread, [threadId]: next }
        persistThreadSettings(
          updated as Record<string, Record<string, unknown>>
        )
        return { settingsByThread: updated }
      }
      // Even a repeated clear invalidates an older in-flight database snapshot.
      if (key !== "goal" && Object.is(prev[key], value)) return state
      const updated = {
        ...state.settingsByThread,
        [threadId]: {
          ...prev,
          [key]: value,
          ...(key === "goal"
            ? { goalRevision: (prev.goalRevision ?? 0) + 1 }
            : {}),
        },
      }
      persistThreadSettings(updated as Record<string, Record<string, unknown>>)
      queueThreadSettingsChange(
        threadId,
        threadSettingsChange(prev, updated[threadId])
      )
      return { settingsByThread: updated }
    }),

  getThreadSettings: (threadId) =>
    threadId ? (get().settingsByThread[threadId] ?? {}) : {},

  initializeThreadModelSettings: (threadId) =>
    set((state) => {
      if (!state.threads.some((thread) => thread.id === threadId)) return state
      const previous = state.settingsByThread[threadId]
      const selection = previous?.selectedProviderId
        ? previous.modelSelectionByProvider?.[previous.selectedProviderId]
        : undefined
      if (
        previous?.selectedModel &&
        selection?.selectedModel &&
        selection.thinkingMode !== undefined &&
        selection.fastMode !== undefined &&
        selection.contextWindow !== undefined &&
        selection.optionSelections !== undefined
      )
        return state
      const settingsByThread = {
        ...state.settingsByThread,
        [threadId]: snapshotComposerModelSettings(
          usePreferencesStore.getState(),
          previous
        ),
      }
      persistThreadSettings(
        settingsByThread as Record<string, Record<string, unknown>>
      )
      queueThreadSettingsChange(
        threadId,
        threadSettingsChange(previous, settingsByThread[threadId])
      )
      return { settingsByThread }
    }),

  applyStoredThreadSettings: (threadId, change) =>
    set((state) => {
      // Another client changed what the backend keeps with this chat. The
      // backend already has it, so nothing is written back.
      if (!state.threads.some((thread) => thread.id === threadId)) return state
      const next = applyThreadSettingsChange(
        state.settingsByThread[threadId],
        change,
        unsettledThreadSettingKeys(threadId)
      )
      if (!next) return state
      const settingsByThread = { ...state.settingsByThread }
      if (Object.keys(next).length === 0) delete settingsByThread[threadId]
      else settingsByThread[threadId] = next
      persistThreadSettings(
        settingsByThread as Record<string, Record<string, unknown>>
      )
      return { settingsByThread }
    }),

  pinThread: (threadId) =>
    set((state) => {
      if (state.pinnedThreadIds.has(threadId)) return state
      const next = new Set(state.pinnedThreadIds)
      next.add(threadId)
      return { pinnedThreadIds: next }
    }),

  unpinThread: (threadId) =>
    set((state) => {
      if (!state.pinnedThreadIds.has(threadId)) return state
      const next = new Set(state.pinnedThreadIds)
      next.delete(threadId)
      return { pinnedThreadIds: next }
    }),

  createThread: (title, projectName, projectPath, options) => {
    const id = generateId()
    const now = new Date().toISOString()
    const sourceThreadId = get().activeThreadId
    const inheritedModelSettings = snapshotComposerModelSettings(
      usePreferencesStore.getState(),
      modelSettingsForNewThread(
        sourceThreadId ? get().settingsByThread[sourceThreadId] : undefined
      )
    )
    const thread: ChatThread = {
      id,
      title,
      projectName,
      projectPath: projectPath || "",
      envMode:
        options?.envMode ?? (options?.worktreePath ? "worktree" : "local"),
      branch: options?.branch ?? null,
      worktreePath: options?.worktreePath ?? null,
      baseBranch: options?.baseBranch ?? null,
      worktreeState:
        options?.worktreeState ?? (options?.worktreePath ? "ready" : "none"),
      parentThreadId: options?.parentThreadId ?? null,
      codexThreadId: null,
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    set((state) => {
      const withThread = {
        ...state,
        threads: [thread, ...state.threads],
        messagesLoadedByThread: {
          ...state.messagesLoadedByThread,
          [id]: true,
        },
        settingsByThread: {
          ...state.settingsByThread,
          [id]: inheritedModelSettings,
        },
      }
      return {
        ...applyLru(
          { ...withThread, activeThreadId: id },
          id,
          lruOptionsFor(withThread)
        ),
        activeThreadId: id,
        settingsByThread: withThread.settingsByThread,
      }
    })
    persistThreadSettings(
      get().settingsByThread as Record<string, Record<string, unknown>>
    )
    persistThreadNow(id)
    // After the chat is saved: the backend keeps its model selection too.
    queueThreadSettingsChange(
      id,
      threadSettingsChange(undefined, inheritedModelSettings)
    )
    return id
  },

  forkThread: async (sourceThreadId, into, options) => {
    // A fork copies the whole conversation, not just the pages on screen.
    await get().ensureFullThreadMessages(sourceThreadId)

    const source = get().threads.find((thread) => thread.id === sourceThreadId)
    if (!source) return null
    // "Fork from here" keeps the history up to and including one message.
    const throughMessageId = options?.throughMessageId
    const throughIndex = throughMessageId
      ? source.messages.findIndex((message) => message.id === throughMessageId)
      : source.messages.length - 1
    if (throughMessageId && throughIndex < 0) {
      log.error(
        "[chat-store] Cannot fork: the message to fork from is gone",
        sourceThreadId,
        throughMessageId
      )
      return null
    }
    const sourceMessages = source.messages.slice(0, throughIndex + 1)
    // A copy is written as a new chat; placeholders have no stored copy to
    // fall back on there.
    const missingPayload = sourceMessages.find(messageHasOmittedPayload)
    if (missingPayload) {
      log.error(
        "[chat-store] Cannot fork: a message is missing its diff or attachment data",
        sourceThreadId,
        missingPayload.id
      )
      return null
    }

    const id = generateId()
    const now = new Date().toISOString()
    const messages = sourceMessages.map(cloneMessageForFork)
    // Forking into a project starts a fresh binding: the source chat's branch
    // and worktree belong to wherever it was running, not to the new repo.
    const thread: ChatThread = {
      id,
      title: into ? source.title.trim() || "New Chat" : forkTitle(source.title),
      projectName: into ? into.projectName : source.projectName,
      projectPath: into ? into.projectPath : source.projectPath,
      envMode: into
        ? "local"
        : (source.envMode ?? (source.worktreePath ? "worktree" : "local")),
      branch: into ? null : (source.branch ?? null),
      worktreePath: into ? null : (source.worktreePath ?? null),
      baseBranch: into ? null : (source.baseBranch ?? null),
      worktreeState: into
        ? "none"
        : (source.worktreeState ?? (source.worktreePath ? "ready" : "none")),
      parentThreadId: source.id,
      codexThreadId: null,
      messages,
      messageCount: messages.length,
      // The source's totals describe its whole conversation, not a part.
      usage:
        source.usage && sourceMessages.length === source.messages.length
          ? clonePlain(source.usage)
          : undefined,
      createdAt: now,
      updatedAt: now,
    }

    try {
      await saveThreadDb(thread)
    } catch (err) {
      log.error(
        "[chat-store] Failed to persist forked thread",
        id,
        describeError(err)
      )
      return null
    }

    set((state) => {
      const sourceSettings = state.settingsByThread[sourceThreadId]
      const copiedSettings = sourceSettings
        ? clonePlain(sourceSettings)
        : undefined
      // Provider goals are session-scoped. A fork gets its own provider
      // session and must not inherit a goal that belongs to the source chat.
      if (copiedSettings) delete copiedSettings.goal
      // A fork is not one of the models its source was compared with.
      if (copiedSettings) delete copiedSettings.compareGroupId
      const settingsByThread =
        copiedSettings && Object.keys(copiedSettings).length > 0
          ? {
              ...state.settingsByThread,
              [id]: copiedSettings,
            }
          : state.settingsByThread
      const withThread = {
        ...state,
        threads: [thread, ...state.threads],
        messagesLoadedByThread: {
          ...state.messagesLoadedByThread,
          [id]: true,
        },
        activitiesByThread: {
          ...state.activitiesByThread,
          [id]: [],
        },
        activitiesLoadedByThread: {
          ...state.activitiesLoadedByThread,
          [id]: true,
        },
        settingsByThread,
      }
      return {
        ...applyLru(
          { ...withThread, activeThreadId: id },
          id,
          lruOptionsFor(withThread)
        ),
        activeThreadId: id,
        settingsByThread,
      }
    })

    const forkedSettings = get().settingsByThread[id]
    if (forkedSettings) {
      persistThreadSettings(
        get().settingsByThread as Record<string, Record<string, unknown>>
      )
      queueThreadSettingsChange(
        id,
        threadSettingsChange(undefined, forkedSettings)
      )
    }

    return id
  },

  addMessage: (threadId, message, options) => {
    const snap = get()

    if (!snap.messagesLoadedByThread[threadId]) {
      void snap.hydrateThreadMessages(threadId).then(() => {
        get().addMessage(threadId, message, options)
      })
      return
    }

    const thread = snap.threads.find((t) => t.id === threadId)
    const isFirstUserMessage =
      thread && thread.messages.length === 0 && message.role === "user"

    noteLocalMessage(threadId, message.id)
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: [...t.messages, message],
              updatedAt: new Date().toISOString(),
              // Temporary title from first message, replaced by AI later
              // only if no explicit title was set while generation ran.
              title: isFirstUserMessage
                ? temporaryThreadTitleFromMessage(message.content)
                : t.title,
            }
          : t
      ),
    }))

    if (isFirstUserMessage) {
      generateThreadTitle(threadId, message.content)
    }

    if (options?.persist !== false) persistMessage(threadId, message)
    else markMessageAwaitingServer(threadId, message.id)
  },

  appendStreamDelta: (threadId, delta) => {
    set((state) => {
      const cur = state.streamingByThread[threadId] ?? emptyStreamState
      // The agent has started answering, so whatever it was thinking is
      // finished — seal it into its own block rather than leaving it to be
      // overwritten by the next stretch of reasoning.
      const sealed =
        cur.reasoningText.trim().length > 0
          ? {
              reasoningSegments: [
                ...cur.reasoningSegments,
                {
                  id: `reasoning-${cur.reasoningSegments.length}-${cur.reasoningStartedAt ?? 0}`,
                  text: cur.reasoningText,
                  startedAt: cur.reasoningStartedAt,
                  endedAt: cur.reasoningEndedAt,
                },
              ],
              reasoningText: "",
              reasoningStartedAt: null,
              reasoningEndedAt: null,
            }
          : {}
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            ...sealed,
            isStreaming: true,
            isReasoning: false,
            lastBoundaryAt: Date.now(),
            streamingText: cur.streamingText + delta,
          },
        },
      }
    })
  },

  appendPlanStreamDelta: (threadId, delta) => {
    get().closeReasoningSegment(threadId)
    set((state) => {
      const cur = state.streamingByThread[threadId] ?? emptyStreamState
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            isStreaming: true,
            isPlanStreaming: true,
            isReasoning: false,
            streamingPlanText: cur.streamingPlanText + delta,
          },
        },
      }
    })
  },

  replacePlanStreamText: (threadId, text) => {
    get().closeReasoningSegment(threadId)
    set((state) => {
      const cur = state.streamingByThread[threadId] ?? emptyStreamState
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            isStreaming: true,
            isPlanStreaming: true,
            isReasoning: false,
            streamingPlanText: text,
          },
        },
      }
    })
  },

  appendReasoningDelta: (threadId, delta) => {
    set((state) => {
      const cur = state.streamingByThread[threadId] ?? emptyStreamState
      if (REASONING_TRACE_ENABLED) {
        // [REASON-TRACE:STORE-APPLY]
        console.log(
          `[REASON-TRACE:STORE-APPLY] thread=${threadId} deltaLen=${delta.length} cumulative=${cur.reasoningText.length + delta.length}`
        )
      }
      const now = Date.now()
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            isStreaming: true,
            isReasoning: true,
            reasoningText: cur.reasoningText + delta,
            // A block delivered in one piece starts at the last boundary,
            // not at its own arrival — see `lastBoundaryAt`.
            reasoningStartedAt:
              cur.reasoningStartedAt ?? cur.lastBoundaryAt ?? now,
            reasoningEndedAt: now,
          },
        },
      }
    })
  },

  /**
   * Seals the stretch of thinking that just ended so the next one starts its
   * own block. Called when the agent moves on to a tool call or begins
   * answering — the same boundaries that split assistant text into bubbles.
   * A no-op when nothing has been thought, so it is safe to call on every
   * boundary without checking first.
   */
  closeReasoningSegment: (threadId) => {
    set((state) => {
      const cur = state.streamingByThread[threadId]
      if (!cur || (!cur.isReasoning && cur.reasoningText.length === 0))
        return state
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            reasoningSegments:
              cur.reasoningText.trim().length > 0
                ? [
                    ...cur.reasoningSegments,
                    {
                      id: `reasoning-${cur.reasoningSegments.length}-${cur.reasoningStartedAt ?? 0}`,
                      text: cur.reasoningText,
                      startedAt: cur.reasoningStartedAt,
                      endedAt: cur.reasoningEndedAt,
                    },
                  ]
                : cur.reasoningSegments,
            reasoningText: "",
            isReasoning: false,
            reasoningStartedAt: null,
            reasoningEndedAt: null,
          },
        },
      }
    })
  },

  setStreamingModelId: (threadId, modelId) => {
    set((state) => {
      const cur = state.streamingByThread[threadId] ?? emptyStreamState
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: { ...cur, streamingModelId: modelId },
        },
      }
    })
  },

  setActiveTurnId: (threadId, turnId) => {
    set((state) => {
      const existing = state.streamingByThread[threadId]
      if (!existing && turnId === null) return state
      const cur = existing ?? emptyStreamState
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            isStreaming: turnId !== null || cur.isStreaming,
            activeTurnId: turnId,
            ...(turnId !== null ? { lastBoundaryAt: Date.now() } : {}),
          },
        },
      }
    })
  },

  setThreadActivities: (threadId, activities) => {
    set((state) => ({
      activitiesByThread: {
        ...state.activitiesByThread,
        [threadId]: capThreadActivities(activities),
      },
      activitiesLoadedByThread: {
        ...state.activitiesLoadedByThread,
        [threadId]: true,
      },
    }))
  },

  upsertThreadActivity: (threadId, activity) => {
    set((state) => {
      const existing = state.activitiesByThread[threadId] ?? []
      return {
        activitiesByThread: {
          ...state.activitiesByThread,
          [threadId]: upsertActivitySorted(existing, activity),
        },
      }
    })
  },

  addToolCall: (threadId, toolCall) => {
    // Acting on a decision ends the thinking that led to it. Sealing here is
    // what produces the think → act → think again rhythm instead of one
    // block that keeps rewriting itself.
    get().closeReasoningSegment(threadId)
    const normalizedToolCall: ToolCall = {
      ...toolCall,
      startedAt: toolCall.startedAt ?? new Date().toISOString(),
      state: toolCall.state ?? "input-available",
    }
    const toolName = (toolCall.name || "").toLowerCase()
    const isFileOp =
      toolName.includes("edit") ||
      toolName.includes("write") ||
      toolName.includes("read") ||
      toolName.includes("grep")
    const filePath = toolInputPathLocal(normalizedToolCall.input)

    set((state) => {
      const cur = state.streamingByThread[threadId] ?? { ...emptyStreamState }
      const tools = cur.streamingTools

      const existingById = tools.find((t) => t.id === toolCall.id)
      if (existingById) {
        return {
          streamingByThread: {
            ...state.streamingByThread,
            [threadId]: {
              ...cur,
              lastBoundaryAt: Date.now(),
              streamingTools: tools.map((t) =>
                t.id === toolCall.id ? { ...t, ...normalizedToolCall } : t
              ),
            },
          },
        }
      }

      // Merge consecutive same-file operations (Edit utils.js x5 → one entry)
      if (isFileOp && filePath) {
        const existing = tools.find((t) => {
          const tName = t.name.toLowerCase()
          const tPath = toolInputPathLocal(t.input)
          return tName === toolName && tPath === filePath
        })
        if (existing) {
          return {
            streamingByThread: {
              ...state.streamingByThread,
              [threadId]: {
                ...cur,
                lastBoundaryAt: Date.now(),
                streamingTools: tools.map((t) =>
                  t === existing
                    ? {
                        ...t,
                        ...normalizedToolCall,
                        id: normalizedToolCall.id,
                        startedAt: t.startedAt ?? normalizedToolCall.startedAt,
                      }
                    : t
                ),
              },
            },
          }
        }
      }

      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            lastBoundaryAt: Date.now(),
            streamingTools: [...tools, normalizedToolCall],
          },
        },
      }
    })
  },

  updateToolCallInput: (threadId, toolId, input) => {
    set((state) => {
      const cur = state.streamingByThread[threadId]
      if (!cur) return state
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            streamingTools: cur.streamingTools.map((t) =>
              t.id === toolId
                ? { ...t, input, state: "input-available" as const }
                : t
            ),
          },
        },
      }
    })
  },

  appendToolOutputDelta: (
    threadId,
    toolId,
    delta,
    toolName,
    providerKind,
    providerInstanceId,
    mode = "append"
  ) => {
    if (!delta) return
    set((state) => {
      const cur = state.streamingByThread[threadId] ?? { ...emptyStreamState }
      const now = new Date().toISOString()
      const existing = cur.streamingTools.find((t) => t.id === toolId)
      // A cumulative payload (ACP `detail`, Codex `patchUpdated`) is the whole
      // output so far: it replaces rather than compounds on the stored
      // preview, which is what put `npm testnpm testnpm test` on the card.
      const nextOutput =
        mode === "replace"
          ? delta
          : `${stringifyToolOutput(existing?.output)}${delta}`
      const summary = summarizeToolOutput(nextOutput)
      const nextTool: ToolCall = existing
        ? {
            ...existing,
            providerKind: existing.providerKind ?? providerKind,
            providerInstanceId:
              existing.providerInstanceId ?? providerInstanceId,
            output: summary.outputPreview,
            ...summary,
          }
        : {
            id: toolId,
            name: toolName || "unknown",
            input: {},
            output: summary.outputPreview,
            state: "input-available",
            providerKind,
            providerInstanceId,
            startedAt: now,
            ...summary,
          }
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            isStreaming: true,
            lastBoundaryAt: Date.now(),
            streamingTools: existing
              ? cur.streamingTools.map((t) => (t.id === toolId ? nextTool : t))
              : [...cur.streamingTools, nextTool],
          },
        },
      }
    })
  },

  updateToolResult: (
    threadId,
    toolId,
    output,
    providerKind,
    providerInstanceId
  ) => {
    set((state) => {
      const cur = state.streamingByThread[threadId] ?? { ...emptyStreamState }
      const completedAt = new Date().toISOString()
      const hasTool = cur.streamingTools.some((t) => t.id === toolId)
      const fallbackTool: ToolCall = {
        id: toolId,
        name: "unknown",
        input: {},
        output,
        state: "output-available",
        providerKind,
        providerInstanceId,
        startedAt: completedAt,
        completedAt,
        durationMs: 0,
        ...summarizeToolOutput(output),
      }
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            lastBoundaryAt: Date.now(),
            streamingTools: hasTool
              ? cur.streamingTools.map((t) =>
                  t.id === toolId
                    ? {
                        ...t,
                        output,
                        providerKind: t.providerKind ?? providerKind,
                        providerInstanceId:
                          t.providerInstanceId ?? providerInstanceId,
                        state: "output-available" as const,
                        completedAt,
                        durationMs: toolDurationMs(t.startedAt, completedAt),
                        ...summarizeToolOutput(output),
                      }
                    : t
                )
              : [...cur.streamingTools, fallbackTool],
          },
        },
      }
    })
  },

  updateToolFailure: (
    threadId,
    toolId,
    error,
    output,
    providerKind,
    providerInstanceId
  ) => {
    set((state) => {
      const cur = state.streamingByThread[threadId] ?? { ...emptyStreamState }
      const completedAt = new Date().toISOString()
      const failureOutput = output ?? error
      const hasTool = cur.streamingTools.some((t) => t.id === toolId)
      const fallbackTool: ToolCall = {
        id: toolId,
        name: "unknown",
        input: {},
        output: failureOutput,
        error,
        state: "output-error",
        providerKind,
        providerInstanceId,
        startedAt: completedAt,
        completedAt,
        durationMs: 0,
        ...summarizeToolOutput(failureOutput),
      }
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            lastBoundaryAt: Date.now(),
            streamingTools: hasTool
              ? cur.streamingTools.map((t) =>
                  t.id === toolId
                    ? {
                        ...t,
                        output: failureOutput,
                        error,
                        providerKind: t.providerKind ?? providerKind,
                        providerInstanceId:
                          t.providerInstanceId ?? providerInstanceId,
                        state: "output-error" as const,
                        completedAt,
                        durationMs: toolDurationMs(t.startedAt, completedAt),
                        ...summarizeToolOutput(failureOutput),
                      }
                    : t
                )
              : [...cur.streamingTools, fallbackTool],
          },
        },
      }
    })
  },

  addQuestion: (threadId, question) => {
    set((state) => {
      const cur = state.streamingByThread[threadId] ?? { ...emptyStreamState }
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            pendingQuestions: [...cur.pendingQuestions, question],
          },
        },
      }
    })
  },

  answerQuestion: (threadId, questionId, answer) => {
    set((state) => {
      const cur = state.streamingByThread[threadId]
      if (!cur) return state
      return {
        streamingByThread: {
          ...state.streamingByThread,
          [threadId]: {
            ...cur,
            pendingQuestions: cur.pendingQuestions.map((q) =>
              q.id === questionId
                ? { ...q, answer, answeredAt: new Date().toISOString() }
                : q
            ),
          },
        },
      }
    })
  },

  dismissPendingQuestions: (threadId) => {
    set((state) => {
      const stream = state.streamingByThread[threadId]
      const updatedStream = stream
        ? {
            streamingByThread: {
              ...state.streamingByThread,
              [threadId]: { ...stream, pendingQuestions: [] },
            },
          }
        : {}

      const updatedThreads = state.threads.map((t) => {
        if (t.id !== threadId || !t.messages?.length) return t
        let lastAssistantIdx = -1
        for (let i = t.messages.length - 1; i >= 0; i -= 1) {
          if (t.messages[i].role === "assistant") {
            lastAssistantIdx = i
            break
          }
        }
        if (lastAssistantIdx < 0) return t
        const prev = t.messages[lastAssistantIdx]
        if (!prev.questions || prev.questions.length === 0) return t
        const nextMessages = [...t.messages]
        nextMessages[lastAssistantIdx] = { ...prev, questions: undefined }
        return { ...t, messages: nextMessages }
      })

      return { ...state, ...updatedStream, threads: updatedThreads }
    })

    const updatedAssistant = [
      ...(useChatStore.getState().threads.find((t) => t.id === threadId)
        ?.messages ?? []),
    ]
      .reverse()
      .find((message) => message.role === "assistant")
    if (updatedAssistant) persistMessage(threadId, updatedAssistant)
  },

  finalizeStream: (threadId, options) => {
    const threadStream = get().streamingByThread[threadId] ?? emptyStreamState
    const {
      streamingText,
      reasoningStartedAt,
      reasoningEndedAt,
      streamingTools,
      streamingModelId,
      streamingDiffs,
      activeTurnId,
    } = threadStream

    // A turn can think several times, so the stored message carries every
    // stretch — the sealed segments plus whatever is still in the live
    // buffer. Reading only the buffer would drop all the earlier thinking.
    const reasoningText = [
      ...threadStream.reasoningSegments.map((segment) => segment.text),
      threadStream.reasoningText,
    ]
      .filter((text) => text.trim().length > 0)
      .join("\n\n")
    const reasoningMs =
      threadStream.reasoningSegments.reduce((total, segment) => {
        if (segment.startedAt === null || segment.endedAt === null) return total
        return total + Math.max(0, segment.endedAt - segment.startedAt)
      }, 0) +
      (reasoningStartedAt !== null && reasoningEndedAt !== null
        ? Math.max(0, reasoningEndedAt - reasoningStartedAt)
        : 0)

    if (
      !threadStream.isPlanStreaming &&
      (streamingText || reasoningText || streamingTools.length > 0)
    ) {
      const assistantMessage: ChatMessage = {
        id: options?.messageId ?? generateId(),
        role: "assistant",
        content: streamingText || (reasoningText ? "(reasoning only)" : ""),
        turnId: activeTurnId,
        reasoning: reasoningText || undefined,
        reasoningDurationMs:
          reasoningText && reasoningMs > 0 ? reasoningMs : undefined,
        toolCalls: streamingTools.length > 0 ? [...streamingTools] : undefined,
        diffs: streamingDiffs.length > 0 ? [...streamingDiffs] : undefined,
        modelId: streamingModelId || undefined,
        createdAt: new Date().toISOString(),
      }
      if (options?.persist === false) {
        noteLocalMessage(threadId, assistantMessage.id)
        markMessageAwaitingServer(threadId, assistantMessage.id)
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id !== threadId
              ? thread
              : {
                  ...thread,
                  messages: thread.messages.some(
                    (message) => message.id === assistantMessage.id
                  )
                    ? thread.messages.map((message) =>
                        message.id === assistantMessage.id
                          ? assistantMessage
                          : message
                      )
                    : [...thread.messages, assistantMessage],
                  updatedAt: assistantMessage.createdAt,
                }
          ),
        }))
      } else {
        get().addMessage(threadId, assistantMessage)
      }

      if (streamingText && streamingText.includes("?")) {
        applyQuestionsToThread(threadId, streamingText)
      }

      if (streamingTools.length > 0) {
        const thread = get().threads.find((t) => t.id === threadId)
        const lastMsg = thread?.messages[thread.messages.length - 1]
        if (lastMsg) {
          autoCheckpointFromToolCalls(
            threadId,
            lastMsg.id,
            streamingTools,
            resolveThreadRuntimePath(thread)
          ).catch(() => {
            log.warn(
              "Auto-checkpoint from tool calls failed for thread:",
              threadId
            )
          })
        }
      }
    }

    set((state) => {
      const rest = { ...state.streamingByThread }
      if (options?.keepTurnActive) {
        rest[threadId] = {
          ...emptyStreamState,
          isStreaming: true,
          activeTurnId,
          streamingModelId,
          lastBoundaryAt: Date.now(),
        }
      } else {
        delete rest[threadId]
      }
      return { streamingByThread: rest }
    })
  },

  clearStreaming: (threadId?) => {
    if (threadId) {
      set((state) => {
        const rest = { ...state.streamingByThread }
        delete rest[threadId]
        return { streamingByThread: rest }
      })
    } else {
      set({ streamingByThread: {} })
    }
  },

  deleteThread: (threadId) => {
    void deleteThreadDb(threadId)
      .then(() => {
        // Only discard queued drafts after the backend confirms deletion.
        void import("@/lib/message-queue-store")
          .then(({ useMessageQueueStore }) => {
            useMessageQueueStore.getState().discardThread(threadId)
          })
          .catch((error) =>
            log.warn(
              "Failed to clear deleted chat's queued drafts",
              describeError(error)
            )
          )
        set((state) => {
          const restStreaming = { ...state.streamingByThread }
          const restActivities = { ...state.activitiesByThread }
          const restActivitiesLoaded = { ...state.activitiesLoadedByThread }
          const restLoaded = { ...state.messagesLoadedByThread }
          const restHydrationErrors = {
            ...state.messageHydrationErrorsByThread,
          }
          const restDrafts = { ...state.draftsByThread }
          const restSettings = { ...state.settingsByThread }
          delete restStreaming[threadId]
          delete restActivities[threadId]
          delete restActivitiesLoaded[threadId]
          delete restLoaded[threadId]
          delete restHydrationErrors[threadId]
          delete restDrafts[threadId]
          delete restSettings[threadId]
          unsyncedMessageIds.delete(threadId)
          awaitingServerMessages.delete(threadId)
          persistThreadSettings(
            restSettings as Record<string, Record<string, unknown>>
          )
          return {
            threads: state.threads.filter((t) => t.id !== threadId),
            // The backend ended the run with the chat.
            autonomyByThread: withoutKey(state.autonomyByThread, threadId),
            settingsByThread: restSettings,
            activeThreadId:
              state.activeThreadId === threadId ? null : state.activeThreadId,
            streamingByThread: restStreaming,
            activitiesByThread: restActivities,
            activitiesLoadedByThread: restActivitiesLoaded,
            messagesLoadedByThread: restLoaded,
            messageHydrationErrorsByThread: restHydrationErrors,
            olderMessagesCursorByThread: withoutKey(
              state.olderMessagesCursorByThread,
              threadId
            ),
            olderMessagesLoadingByThread: withoutKey(
              state.olderMessagesLoadingByThread,
              threadId
            ),
            draftsByThread: restDrafts,
            lruOrder: state.lruOrder.filter((x) => x !== threadId),
          }
        })
        // File snapshots of a deleted chat can never be restored.
        useCheckpointStore.getState().clearCheckpointsForThread(threadId)
      })
      .catch((err) => {
        log.error(
          "[chat-store] Failed to delete thread from database",
          threadId,
          describeError(err)
        )
      })
  },

  updateThreadTitle: (threadId, title) => {
    const updatedAt = new Date().toISOString()
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, title, updatedAt } : t
      ),
    }))
    persistThread(threadId)
  },

  updateThreadContext: (threadId, patch) => {
    const current = get().threads.find((t) => t.id === threadId)
    if (!current) return

    const nextPatch: ThreadContextPatch = {}
    for (const key of THREAD_CONTEXT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
      const value = patch[key]
      if (value === undefined || Object.is(current[key], value)) continue
      ;(nextPatch as Record<string, string | null>)[key] = value
    }
    if (Object.keys(nextPatch).length === 0) return

    const updatedAt = new Date().toISOString()
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, ...nextPatch, updatedAt } : t
      ),
    }))
    persistThread(threadId)
  },

  updateThreadUsage: (threadId, usage) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, usage } : t
      ),
    }))
  },

  setThreadAutonomy: (threadId, autonomy) => {
    set((state) => {
      if (!autonomy) {
        const rest = withoutKey(state.autonomyByThread, threadId)
        return rest === state.autonomyByThread
          ? state
          : { autonomyByThread: rest }
      }
      // A control's response can arrive after a newer push of the same run.
      const current = state.autonomyByThread[threadId]
      if (current?.id === autonomy.id && current.updatedAt > autonomy.updatedAt)
        return state
      return {
        autonomyByThread: { ...state.autonomyByThread, [threadId]: autonomy },
      }
    })
  },
}))

// Local alias to avoid a name collision with the re-exported selector module.
function toolInputPathLocal(input: unknown): string {
  const obj = input as Record<string, unknown> | null | undefined
  return (obj?.path as string) || (obj?.file_path as string) || ""
}

// Generate thread title using Haiku 4.5 (cheap + fast) via dedicated IPC
async function generateThreadTitle(threadId: string, userMessage: string) {
  try {
    const { generateTitle } = await import("@/services/backend/chatApi")
    const title = await generateTitle(userMessage)
    if (title && title.length > 0 && title.length < 80) {
      const currentThread = useChatStore
        .getState()
        .threads.find((thread) => thread.id === threadId)
      if (
        currentThread &&
        currentThread.title !== temporaryThreadTitleFromMessage(userMessage)
      ) {
        return
      }
      useChatStore.getState().updateThreadTitle(threadId, title)
    }
  } catch {
    // Silently fail — keep the truncated title
  }
}

function temporaryThreadTitleFromMessage(message: string): string {
  return message.slice(0, 40) + (message.length > 40 ? "..." : "")
}
