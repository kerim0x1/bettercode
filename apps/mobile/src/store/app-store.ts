import { create } from "zustand"
import {
  normalizeProviderGoal,
  parseGoalCommand,
  isRecord,
} from "@betterc0de/schema"
import {
  PERMISSION_MODE_FAILED,
  PERMISSION_MODE_QUEUED,
  type PermissionLevel,
} from "@betterc0de/schema/chat-controls"
import type {
  ChatMessage,
  ChatThread,
  ModelOption,
  PendingRequest,
  ProjectSummary,
  ThreadActivity,
} from "@/types/remote"
import { createId } from "@/lib/ids"
import { describeRemoteError, remoteErrorMessage } from "@/lib/remote-errors"
import { RemoteApiError } from "@/transport/live/http"
import type { ChatRequestBody, RemoteApi } from "@/transport/types"
import { useComposerSettings } from "./composer-settings-store"
import {
  decodeRuntimeFrame,
  eventDelta,
  isTurnStarted,
  isTurnTerminal,
  pendingRequestFromEvent,
  reasoningDelta,
  replacementText,
  resolvedRequestId,
  runtimeToolId,
  terminalError,
} from "@/lib/runtime-events"

export interface TurnOptions {
  thinkingMode: string | null
  fastMode: boolean
}

export interface StreamState {
  turnId: string | null
  content: string
  reasoning: string
  isReasoning?: boolean
  observedToolIds?: string[]
  running: boolean
  error: string | null
  startedAt: string
  /** The provider running this turn; Stop must reach this one, whatever the picker shows now. */
  providerKind?: string | null
  providerInstanceId?: string | null
}

/** Messages are loaded newest first, this many at a time. */
export const MESSAGE_PAGE_SIZE = 200

export interface RuntimeOutcome {
  threadId: string
  terminal: boolean
  refreshThreads: boolean
}

/**
 * A message the desktop has not confirmed yet. Its request is kept exactly
 * as it was first sent: the desktop recognises a retry by the message id
 * and refuses one whose request differs, and the chat's title in it can
 * change while the message waits.
 */
export interface OutboxEntry {
  threadId: string
  /** "queue" when the message queue sends it and shows its failures. */
  owner: "chat" | "queue"
  body: ChatRequestBody
  selection: ModelOption
  /** Why the last attempt failed; `null` while one is under way. */
  error: string | null
  /** `false` once the desktop has said it will never accept this id. */
  retryable: boolean
}

/**
 * A message sent under an id it already has: a queued one keeps the id and
 * time it was queued with, and a retry those of the first attempt.
 */
export interface SendDelivery {
  messageId: string
  createdAt: string
  owner: OutboxEntry["owner"]
  /** The thinking and Fast Mode choice queued with the message. */
  turnOptions?: TurnOptions
}

/**
 * `busy`: the chat was running another turn and nothing was recorded (only
 * a queued message gets this; a message typed in the chat fails instead).
 */
export type SendOutcome =
  | { status: "sent" }
  | { status: "busy" }
  | { status: "failed"; error: string }

/** A notice the chat shows after a permission change: the desktop's words. */
export type PermissionNotice =
  | typeof PERMISSION_MODE_QUEUED
  | typeof PERMISSION_MODE_FAILED

interface AppStore {
  threads: ChatThread[]
  /** Cursor of the next page of chats, or `null` when all are loaded. */
  nextThreadsCursor: string | null
  loadingMoreThreads: boolean
  threadsError: string | null
  projects: ProjectSummary[]
  projectsError: string | null
  messagesByThread: Record<string, ChatMessage[]>
  /** Whether the desktop has older messages than the loaded ones. */
  earlierMessagesByThread: Record<string, boolean>
  messagesErrorByThread: Record<string, string | null>
  activitiesByThread: Record<string, ThreadActivity[]>
  streamsByThread: Record<string, StreamState>
  requestsByThread: Record<string, PendingRequest[]>
  selectedModels: Record<string, ModelOption>
  turnOptionsByThread: Record<string, TurnOptions>
  /** Messages the desktop has not confirmed, by message id. */
  outbox: Record<string, OutboxEntry>
  loadingThreads: boolean
  loadingProjects: boolean
  loadingMessages: Record<string, boolean>
  error: string | null
  refreshThreads: (api: RemoteApi) => Promise<void>
  loadMoreThreads: (api: RemoteApi) => Promise<void>
  /** Fetches one chat that is not in the loaded pages (a deep link, a notification). */
  ensureThread: (api: RemoteApi, threadId: string) => Promise<ChatThread | null>
  refreshProjects: (api: RemoteApi) => Promise<void>
  loadMessages: (
    api: RemoteApi,
    threadId: string,
    clearCompletedStream?: boolean
  ) => Promise<void>
  loadEarlierMessages: (api: RemoteApi, threadId: string) => Promise<void>
  loadActivities: (api: RemoteApi, threadId: string) => Promise<void>
  createThread: (api: RemoteApi, project: ProjectSummary) => Promise<ChatThread>
  /**
   * Sends a message, or runs a /goal command. A message that fails stays in
   * the chat, marked, with its request in the outbox; a queued message's
   * failure is the queue's to show, so it leaves the chat.
   */
  send: (
    api: RemoteApi,
    threadId: string,
    content: string,
    selection: ModelOption,
    delivery?: SendDelivery
  ) => Promise<SendOutcome>
  /** Sends a failed message again, unchanged and under the same id. */
  retrySend: (api: RemoteApi, messageId: string) => Promise<SendOutcome>
  /** Removes a failed message from the chat. */
  discardFailed: (messageId: string) => void
  /** Sends a failed message's text again as a new message. */
  sendAgainAsNew: (api: RemoteApi, messageId: string) => Promise<SendOutcome>
  /** Drops the saved requests of queued messages the queue no longer holds. */
  pruneQueueOutbox: (queuedIds: ReadonlySet<string>) => void
  /**
   * Saves the chat's permission preset and tells the desktop, which also
   * switches a running turn where the provider can. Resolves with the
   * notice to show while a turn runs, or `null`.
   */
  changePermissionLevel: (
    api: RemoteApi,
    threadId: string,
    level: PermissionLevel
  ) => Promise<PermissionNotice | null>
  interrupt: (api: RemoteApi, threadId: string) => Promise<void>
  resolveRequest: (
    api: RemoteApi,
    request: PendingRequest,
    response: {
      decision?: "approve" | "deny"
      answers?: Record<string, unknown>
      message?: string
    }
  ) => Promise<void>
  setSelectedModel: (threadId: string, option: ModelOption) => void
  setTurnOptions: (threadId: string, patch: Partial<TurnOptions>) => void
  applyFrame: (frame: unknown) => RuntimeOutcome | null
  clearStream: (threadId: string) => void
  reset: () => void
}

const initialState = {
  threads: [] as ChatThread[],
  nextThreadsCursor: null as string | null,
  loadingMoreThreads: false,
  threadsError: null as string | null,
  projects: [] as ProjectSummary[],
  projectsError: null as string | null,
  messagesByThread: {} as Record<string, ChatMessage[]>,
  earlierMessagesByThread: {} as Record<string, boolean>,
  messagesErrorByThread: {} as Record<string, string | null>,
  activitiesByThread: {} as Record<string, ThreadActivity[]>,
  streamsByThread: {} as Record<string, StreamState>,
  requestsByThread: {} as Record<string, PendingRequest[]>,
  selectedModels: {} as Record<string, ModelOption>,
  turnOptionsByThread: {} as Record<string, TurnOptions>,
  outbox: {} as Record<string, OutboxEntry>,
  loadingThreads: false,
  loadingProjects: false,
  loadingMessages: {} as Record<string, boolean>,
  error: null as string | null,
}

// Reset retires all awaited writes owned by the previous session.
let generation = 0

export const useAppStore = create<AppStore>((set, get) => ({
  ...initialState,

  refreshThreads: async (api) => {
    const owner = generation
    set({ loadingThreads: true, threadsError: null, error: null })
    try {
      const beforeLoad = new Map(
        get().threads.map((thread) => [thread.id, thread])
      )
      const page = await api.listThreadsPage()
      if (owner !== generation) return
      set((state) => {
        const current = new Map(
          state.threads.map((thread) => [thread.id, thread])
        )
        const first = page.threads.map((thread) => {
          const live = current.get(thread.id)
          return live &&
            live !== beforeLoad.get(thread.id) &&
            live.goal !== undefined
            ? { ...thread, goal: live.goal }
            : thread
        })
        // Chats from later pages stay, so a refresh never drops the pages
        // the user already scrolled through.
        const firstIds = new Set(first.map((thread) => thread.id))
        const beyond = page.nextCursor
          ? state.threads.filter((thread) => !firstIds.has(thread.id))
          : []
        return {
          threads: sortByUpdated([...first, ...beyond]),
          nextThreadsCursor:
            beyond.length > 0
              ? (state.nextThreadsCursor ?? page.nextCursor)
              : page.nextCursor,
          loadingThreads: false,
        }
      })
    } catch (error) {
      if (owner !== generation) return
      const message = remoteErrorMessage(error)
      set({ loadingThreads: false, threadsError: message, error: message })
      throw error
    }
  },

  loadMoreThreads: async (api) => {
    const owner = generation
    const cursor = get().nextThreadsCursor
    if (!cursor || get().loadingMoreThreads) return
    set({ loadingMoreThreads: true })
    try {
      const page = await api.listThreadsPage(cursor)
      if (owner !== generation) return
      set((state) => {
        const known = new Set(state.threads.map((thread) => thread.id))
        return {
          threads: sortByUpdated([
            ...state.threads,
            ...page.threads.filter((thread) => !known.has(thread.id)),
          ]),
          nextThreadsCursor: page.nextCursor,
          loadingMoreThreads: false,
        }
      })
    } catch (error) {
      if (owner !== generation) return
      set({
        loadingMoreThreads: false,
        threadsError: remoteErrorMessage(error),
      })
      throw error
    }
  },

  ensureThread: async (api, threadId) => {
    const known = get().threads.find((thread) => thread.id === threadId)
    if (known) return known
    const owner = generation
    const thread = await api.getThread(threadId)
    if (owner !== generation || !thread) return null
    set((state) =>
      state.threads.some((item) => item.id === thread.id)
        ? {}
        : { threads: sortByUpdated([...state.threads, thread]) }
    )
    return get().threads.find((item) => item.id === threadId) ?? thread
  },

  refreshProjects: async (api) => {
    const owner = generation
    set({ loadingProjects: true, projectsError: null })
    try {
      const projects = await api.listProjects()
      if (owner !== generation) return
      projects.sort((a, b) => a.name.localeCompare(b.name))
      set({ projects, loadingProjects: false })
    } catch (error) {
      if (owner !== generation) return
      set({ loadingProjects: false, projectsError: remoteErrorMessage(error) })
      throw error
    }
  },

  loadMessages: async (api, threadId, clearCompletedStream = false) => {
    const owner = generation
    set((state) => ({
      loadingMessages: { ...state.loadingMessages, [threadId]: true },
      messagesErrorByThread: {
        ...state.messagesErrorByThread,
        [threadId]: null,
      },
    }))
    try {
      const newest = await api.listMessages(threadId, {
        limit: MESSAGE_PAGE_SIZE,
      })
      if (owner !== generation) return
      set((state) => {
        const loaded = state.messagesByThread[threadId] ?? []
        const merged = mergeNewestPage(loaded, newest)
        return {
          messagesByThread: {
            ...state.messagesByThread,
            [threadId]: keepUnconfirmed(merged, loaded, state.outbox, threadId),
          },
          earlierMessagesByThread: {
            ...state.earlierMessagesByThread,
            // A full page from a desktop that numbers its messages may have
            // more before it; earlier pages the user loaded keep their answer.
            [threadId]:
              merged.length > newest.length
                ? (state.earlierMessagesByThread[threadId] ?? false)
                : newest.length >= MESSAGE_PAGE_SIZE &&
                  messageSequence(newest[0]) !== null,
          },
          loadingMessages: { ...state.loadingMessages, [threadId]: false },
          streamsByThread:
            clearCompletedStream &&
            shouldClearCompletedStream(state.streamsByThread[threadId], newest)
              ? omitKey(state.streamsByThread, threadId)
              : state.streamsByThread,
        }
      })
    } catch (error) {
      if (owner !== generation) return
      set((state) => ({
        loadingMessages: { ...state.loadingMessages, [threadId]: false },
        messagesErrorByThread: {
          ...state.messagesErrorByThread,
          [threadId]: remoteErrorMessage(error),
        },
      }))
      throw error
    }
  },

  loadEarlierMessages: async (api, threadId) => {
    const owner = generation
    const loaded = get().messagesByThread[threadId] ?? []
    const oldest = messageSequence(loaded[0])
    if (oldest === null || !get().earlierMessagesByThread[threadId]) return
    const earlier = await api.listMessages(threadId, {
      limit: MESSAGE_PAGE_SIZE,
      beforeSequence: oldest,
    })
    if (owner !== generation) return
    set((state) => {
      const current = state.messagesByThread[threadId] ?? []
      const known = new Set(current.map((message) => message.id))
      return {
        messagesByThread: {
          ...state.messagesByThread,
          [threadId]: [
            ...earlier.filter((message) => !known.has(message.id)),
            ...current,
          ],
        },
        earlierMessagesByThread: {
          ...state.earlierMessagesByThread,
          [threadId]: earlier.length >= MESSAGE_PAGE_SIZE,
        },
      }
    })
  },

  loadActivities: async (api, threadId) => {
    const owner = generation
    const activities = await api.listActivities(threadId)
    if (owner !== generation) return
    set((state) => ({
      activitiesByThread: {
        ...state.activitiesByThread,
        [threadId]: activities,
      },
      requestsByThread: {
        ...state.requestsByThread,
        [threadId]: pendingRequestsFromActivities(activities),
      },
    }))
  },

  createThread: async (api, project) => {
    const owner = generation
    const now = new Date().toISOString()
    const thread: ChatThread = {
      id: createId("mobile-thread"),
      title: "New Chat",
      projectName: project.name,
      projectPath: project.path,
      envMode: "local",
      messages: [],
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    await api.createThread(thread)
    if (owner !== generation)
      throw new Error("The session changed while creating the chat.")
    set((state) => ({ threads: [thread, ...state.threads] }))
    return thread
  },

  send: async (api, threadId, content, selection, delivery) => {
    const owner = generation
    const thread = get().threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error("Chat not found.")
    // Same parser as the desktop and the backend: a malformed command is
    // rejected here with the desktop's wording instead of a round trip.
    if (parseGoalCommand(content) !== null) {
      const options = get().turnOptionsByThread[threadId]
      const result = await api.goal({
        threadId,
        message: content,
        modelId: selection.modelId,
        providerKind: selection.providerKind,
        providerInstanceId: selection.providerInstanceId,
        projectPath: thread.worktreePath || thread.projectPath,
        appMode: "agent",
        reasoningEffort: options?.thinkingMode ?? null,
        fastMode: options?.fastMode ?? null,
      })
      if (owner !== generation) return { status: "sent" }
      set((state) => ({
        threads: state.threads.map((item) =>
          item.id === threadId && item.goal === thread.goal
            ? { ...item, goal: result.goal }
            : item
        ),
      }))
      return { status: "sent" }
    }
    const messageId = delivery?.messageId ?? createId("mobile-message")
    const createdAt = delivery?.createdAt ?? new Date().toISOString()
    // A message sent before keeps the request it was first sent with.
    const entry: OutboxEntry = get().outbox[messageId] ?? {
      threadId,
      owner: delivery?.owner ?? "chat",
      selection,
      error: null,
      retryable: true,
      body: sendBody({
        thread,
        messageId,
        content,
        createdAt,
        selection,
        turnOptions:
          delivery?.turnOptions ?? get().turnOptionsByThread[threadId],
      }),
    }
    const now = new Date().toISOString()
    set((state) => ({
      outbox: { ...state.outbox, [messageId]: { ...entry, error: null } },
      messagesByThread: {
        ...state.messagesByThread,
        [threadId]: [
          ...(state.messagesByThread[threadId] ?? []).filter(
            (message) => message.id !== messageId
          ),
          {
            id: messageId,
            role: "user",
            content,
            createdAt,
            dispatchStatus: "pending",
          },
        ],
      },
      streamsByThread: {
        ...state.streamsByThread,
        [threadId]: {
          turnId: null,
          content: "",
          reasoning: "",
          running: true,
          error: null,
          startedAt: now,
          providerKind: entry.selection.providerKind,
          providerInstanceId: entry.selection.providerInstanceId,
        },
      },
      threads: state.threads.map((item) =>
        item.id === threadId ? { ...item, updatedAt: now } : item
      ),
      error: null,
    }))
    return dispatchOutboxMessage(api, messageId)
  },

  retrySend: async (api, messageId) => {
    const entry = get().outbox[messageId]
    if (!entry?.error || !entry.retryable)
      throw new Error("This message cannot be sent again as it is.")
    return get().send(
      api,
      entry.threadId,
      String(entry.body.userMessageContent ?? ""),
      entry.selection,
      {
        messageId,
        createdAt: String(entry.body.userMessageCreatedAt ?? ""),
        owner: entry.owner,
      }
    )
  },

  discardFailed: (messageId) =>
    set((state) => {
      const entry = state.outbox[messageId]
      if (!entry || entry.error === null) return {}
      return {
        outbox: omitKey(state.outbox, messageId),
        messagesByThread: {
          ...state.messagesByThread,
          [entry.threadId]: (
            state.messagesByThread[entry.threadId] ?? []
          ).filter((message) => message.id !== messageId),
        },
      }
    }),

  sendAgainAsNew: async (api, messageId) => {
    const entry = get().outbox[messageId]
    if (!entry || entry.error === null)
      throw new Error("This message is not waiting to be sent again.")
    get().discardFailed(messageId)
    return get().send(
      api,
      entry.threadId,
      String(entry.body.userMessageContent ?? ""),
      entry.selection
    )
  },

  pruneQueueOutbox: (queuedIds) =>
    set((state) => {
      const stale = Object.entries(state.outbox).filter(
        ([id, entry]) => entry.owner === "queue" && !queuedIds.has(id)
      )
      if (stale.length === 0) return {}
      const outbox = { ...state.outbox }
      for (const [id] of stale) delete outbox[id]
      return { outbox }
    }),

  changePermissionLevel: async (api, threadId, level) => {
    useComposerSettings.getState().update(threadId, { permissionLevel: level })
    const thread = get().threads.find((candidate) => candidate.id === threadId)
    if (!thread) return null
    const stream = get().streamsByThread[threadId]
    const target = interruptTarget(
      stream,
      thread,
      get().selectedModels[threadId]
    )
    if (!target) return null
    // Every message carries the preset, so outside a turn the change needs
    // no notice; during one, the user must know whether it took effect.
    const running = Boolean(stream?.running || thread.session?.activeTurnId)
    try {
      const result = await api.setPermissionMode({
        ...target,
        threadId,
        permissionLevel: level,
      })
      if (result.status === "failed") throw new Error(result.error)
      return running && result.applied !== "live"
        ? PERMISSION_MODE_QUEUED
        : null
    } catch {
      return running ? PERMISSION_MODE_FAILED : null
    }
  },

  interrupt: async (api, threadId) => {
    const thread = get().threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error("Chat not found.")
    const target = interruptTarget(
      get().streamsByThread[threadId],
      thread,
      get().selectedModels[threadId]
    )
    if (!target) throw new Error("It is not known which agent runs this chat.")
    await api.interrupt({ ...target, threadId })
  },

  resolveRequest: async (api, request, response) => {
    const owner = generation
    const body = {
      providerKind: request.providerKind,
      providerInstanceId: request.providerInstanceId,
      threadId: request.threadId,
      requestId: request.id,
    }
    const result =
      request.kind === "user-input"
        ? response.decision === "deny"
          ? await api.rejectUserInput(body)
          : await api.respondUserInput({
              ...body,
              answers: response.answers ?? {},
            })
        : request.kind === "plan"
          ? await api.respondPlan({
              ...body,
              decision: response.decision ?? "deny",
              message: response.message ?? null,
              permissionMode:
                response.decision === "approve" ? "acceptEdits" : "default",
            })
          : await api.respondApproval({
              ...body,
              decision: response.decision ?? "deny",
              message: response.message ?? null,
            })
    if (result.status === "failed")
      throw new Error(result.error || "Response failed.")
    if (owner !== generation) return
    set((state) => ({
      requestsByThread: {
        ...state.requestsByThread,
        [request.threadId]: (
          state.requestsByThread[request.threadId] ?? []
        ).filter((candidate) => candidate.id !== request.id),
      },
    }))
  },

  setSelectedModel: (threadId, option) =>
    set((state) => ({
      selectedModels: { ...state.selectedModels, [threadId]: option },
    })),

  setTurnOptions: (threadId, patch) =>
    set((state) => ({
      turnOptionsByThread: {
        ...state.turnOptionsByThread,
        [threadId]: {
          thinkingMode: null,
          fastMode: false,
          ...state.turnOptionsByThread[threadId],
          ...patch,
        },
      },
    })),

  applyFrame: (frame) => {
    const event = decodeRuntimeFrame(frame)
    if (!event) return null
    const delta = eventDelta(event)
    const thought = reasoningDelta(event)
    const toolId = runtimeToolId(event)
    const replacement = replacementText(event)
    const request = pendingRequestFromEvent(event)
    const resolvedId = resolvedRequestId(event)
    const terminal = isTurnTerminal(event.type)
    const started = isTurnStarted(event.type)
    const eventError = terminalError(event)

    set((state) => {
      const update: Partial<AppStore> = {}
      if (event.type === "thread.metadata.updated") {
        const metadata = event.payload.metadata ?? event.payload
        const thread = state.threads.find((item) => item.id === event.threadId)
        let patch: Partial<ChatThread> = {}
        if (metadata && typeof metadata === "object" && "goal" in metadata) {
          const goal = normalizeProviderGoal(
            metadata.goal,
            thread?.goal,
            event.providerKind ?? undefined
          )
          if (goal !== undefined) patch = { ...patch, goal }
        }
        // Providers name a thread mid-turn (`name`, the compat adapter's
        // `title`). The desktop applies it live; the list here would
        // otherwise say "New Chat" until the next full refresh.
        const title = metadataTitle(event.payload)
        if (title && title !== thread?.title) patch = { ...patch, title }
        if (thread && Object.keys(patch).length > 0) {
          update.threads = state.threads.map((item) =>
            item.id === event.threadId ? { ...item, ...patch } : item
          )
        }
      }
      const existing = state.streamsByThread[event.threadId]
      const newTool =
        toolId !== null && !existing?.observedToolIds?.includes(toolId)
      const touchesStream =
        started ||
        delta !== null ||
        thought !== null ||
        replacement !== null ||
        (newTool && Boolean(existing)) ||
        (terminal && Boolean(existing || eventError))
      if (touchesStream) {
        const current = existing ?? {
          turnId: event.turnId,
          content: "",
          reasoning: "",
          running: false,
          error: null,
          startedAt: new Date().toISOString(),
          providerKind: event.providerKind,
          providerInstanceId: event.providerInstanceId,
        }
        let stream = current
        if (newTool) {
          stream = {
            ...stream,
            isReasoning: false,
            observedToolIds: [...(current.observedToolIds ?? []), toolId!],
          }
        }
        if (
          started ||
          delta !== null ||
          thought !== null ||
          replacement !== null
        ) {
          // A new turn starts from a clean slate: whatever the previous
          // turn streamed has been reloaded from the durable messages by
          // now, and a stale error must not survive into the next reply.
          const base = started
            ? {
                ...current,
                content: "",
                reasoning: "",
                error: null,
                observedToolIds: [],
                startedAt: new Date().toISOString(),
                providerKind: event.providerKind,
                providerInstanceId: event.providerInstanceId,
              }
            : current
          stream = {
            ...stream,
            ...(started ? base : {}),
            turnId: event.turnId ?? current.turnId,
            running: true,
            isReasoning: thought !== null || replacement?.kind === "reasoning",
            error: null,
            content:
              replacement?.kind === "content"
                ? replacement.text
                : base.content + (delta ?? ""),
            reasoning:
              replacement?.kind === "reasoning"
                ? replacement.text
                : base.reasoning + (thought ?? ""),
          }
        }
        if (terminal) {
          stream = {
            ...stream,
            running: false,
            isReasoning: false,
            error: eventError,
          }
        }
        update.streamsByThread = {
          ...state.streamsByThread,
          [event.threadId]: stream,
        }
      }

      let requests = state.requestsByThread[event.threadId] ?? []
      let requestsChanged = false
      if (request) {
        requests = [
          ...requests.filter((item) => item.id !== request.id),
          request,
        ]
        requestsChanged = true
      }
      if (resolvedId && requests.some((item) => item.id === resolvedId)) {
        requests = requests.filter((item) => item.id !== resolvedId)
        requestsChanged = true
      }
      if (requestsChanged) {
        update.requestsByThread = {
          ...state.requestsByThread,
          [event.threadId]: requests,
        }
      }
      return update
    })

    return {
      threadId: event.threadId,
      terminal,
      refreshThreads: terminal || started,
    }
  },

  clearStream: (threadId) =>
    set((state) => ({
      streamsByThread: omitKey(state.streamsByThread, threadId),
    })),

  reset: () => {
    generation += 1
    set({ ...initialState })
  },
}))

/**
 * The /chat/send request for a message, built once: retries resend it as
 * it is. The chat's permission preset and mode are the ones set on this
 * phone when the message is first sent, as on the desktop.
 */
function sendBody({
  thread,
  messageId,
  content,
  createdAt,
  selection,
  turnOptions,
}: {
  thread: ChatThread
  messageId: string
  content: string
  createdAt: string
  selection: ModelOption
  turnOptions: TurnOptions | undefined
}): ChatRequestBody {
  const settings = useComposerSettings.getState().settingsFor(thread.id)
  return {
    providerKind: selection.providerKind,
    providerInstanceId: selection.providerInstanceId,
    threadId: thread.id,
    userMessageId: messageId,
    userMessageContent: content,
    userMessageCreatedAt: createdAt,
    ...(thread.title ? { threadTitle: thread.title } : {}),
    ...(thread.projectName ? { threadProjectName: thread.projectName } : {}),
    threadCreatedAt: thread.createdAt,
    message: content,
    modelId: selection.modelId,
    projectPath: thread.worktreePath || thread.projectPath,
    attachments: [],
    appMode: "agent",
    chatMode: settings.chatMode,
    permissionLevel: settings.permissionLevel,
    reasoningEffort: turnOptions?.thinkingMode ?? null,
    fastMode: turnOptions?.fastMode ?? null,
  }
}

/**
 * One attempt at delivering a message from the outbox. Everything but the
 * history goes out exactly as the first time: the desktop leaves the
 * history out when it recognises a retry, and a fresh one includes the
 * replies that arrived since.
 */
async function dispatchOutboxMessage(
  api: RemoteApi,
  messageId: string
): Promise<SendOutcome> {
  const owner = generation
  const entry = useAppStore.getState().outbox[messageId]
  if (!entry) throw new Error("The message is no longer waiting to be sent.")
  const { threadId } = entry
  const history = providerHistory(
    (useAppStore.getState().messagesByThread[threadId] ?? []).filter(
      (message) => message.id !== messageId
    )
  )
  try {
    const result = await api.sendMessage({ ...entry.body, history })
    if (owner === generation) settleOutboxMessage(messageId, result.turnId)
    return { status: "sent" }
  } catch (error) {
    const description = describeRemoteError(error)
    if (owner !== generation)
      return { status: "failed", error: description.message }
    const code = error instanceof RemoteApiError ? error.code : undefined
    // The desktop already has the message and is still starting its turn.
    if (code === "dispatch_in_progress") {
      settleOutboxMessage(messageId, null)
      return { status: "sent" }
    }
    const failed: OutboxEntry = {
      ...entry,
      error: description.message,
      retryable: description.action !== "send_as_new",
    }
    useAppStore.setState((state) => {
      const messages = state.messagesByThread[threadId] ?? []
      const stream = state.streamsByThread[threadId]
      return {
        outbox:
          entry.owner === "queue" && code === "turn_active"
            ? // Nothing was recorded; the queue sends it after this turn.
              omitKey(state.outbox, messageId)
            : { ...state.outbox, [messageId]: failed },
        messagesByThread: {
          ...state.messagesByThread,
          // The queue shows its own failures and keeps the message; the
          // chat shows it only while it is on its way.
          [threadId]:
            entry.owner === "queue"
              ? messages.filter((message) => message.id !== messageId)
              : messages.map((message) =>
                  message.id === messageId
                    ? {
                        ...message,
                        dispatchStatus: "failed",
                        dispatchFailed: true,
                      }
                    : message
                ),
        },
        streamsByThread: isPlaceholderStream(stream)
          ? omitKey(state.streamsByThread, threadId)
          : state.streamsByThread,
      }
    })
    if (entry.owner === "queue" && code === "turn_active")
      return { status: "busy" }
    return { status: "failed", error: description.message }
  }
}

/** The desktop accepted the message: it leaves the outbox. */
function settleOutboxMessage(messageId: string, turnId: string | null) {
  useAppStore.setState((state) => {
    const entry = state.outbox[messageId]
    if (!entry) return {}
    const { threadId } = entry
    const stream = state.streamsByThread[threadId]
    return {
      outbox: omitKey(state.outbox, messageId),
      messagesByThread: {
        ...state.messagesByThread,
        [threadId]: (state.messagesByThread[threadId] ?? []).map((message) =>
          message.id === messageId
            ? { ...message, dispatchStatus: "accepted", dispatchFailed: false }
            : message
        ),
      },
      // A turn that already finished and was cleared stays cleared; one
      // whose start event came first keeps the id it brought.
      streamsByThread:
        stream && turnId && !stream.turnId
          ? { ...state.streamsByThread, [threadId]: { ...stream, turnId } }
          : state.streamsByThread,
    }
  })
}

/** Whether the stream is still only what a send put up: nothing arrived for it yet. */
function isPlaceholderStream(stream: StreamState | undefined): boolean {
  return Boolean(
    stream &&
    stream.turnId === null &&
    !stream.content &&
    !stream.reasoning &&
    !stream.observedToolIds?.length
  )
}

/**
 * Messages still in the outbox that a reload does not list yet: the
 * desktop has not recorded them (or not yet), and the chat must not lose
 * them, or their Retry.
 */
function keepUnconfirmed(
  merged: ChatMessage[],
  loaded: ChatMessage[],
  outbox: Record<string, OutboxEntry>,
  threadId: string
): ChatMessage[] {
  const listed = new Set(merged.map((message) => message.id))
  const unconfirmed = loaded.filter(
    (message) =>
      outbox[message.id]?.threadId === threadId && !listed.has(message.id)
  )
  return unconfirmed.length > 0 ? [...merged, ...unconfirmed] : merged
}

function metadataTitle(payload: Record<string, unknown>): string | null {
  const raw = payload.name ?? payload.title
  const title = typeof raw === "string" ? raw.trim() : ""
  return title.length > 0 ? title : null
}

/**
 * Whether a finished stream can be dropped in favour of the reloaded
 * messages. The terminal event races the backend's persistence of the
 * reply: reloading 180 ms later usually finds it, but when the list does
 * not yet hold an assistant message from this turn the streamed text is
 * the only copy the user has, so it stays until a later reload finds one.
 *
 * The reply is recognised by its turn id. Only when the desktop stores no
 * turn ids does the time decide, and the phone's clock may be off from the
 * desktop's, so that is the fallback, not the rule.
 */
export function shouldClearCompletedStream(
  stream: StreamState | undefined,
  messages: readonly ChatMessage[]
): boolean {
  if (!stream) return false
  if (stream.running) return false
  if (stream.content.length === 0) return true
  const assistant = messages.filter((message) => message.role === "assistant")
  if (stream.turnId && assistant.some((message) => message.turnId)) {
    return assistant.some((message) => message.turnId === stream.turnId)
  }
  const startedAt = Date.parse(stream.startedAt)
  return assistant.some(
    (message) =>
      Number.isNaN(startedAt) || Date.parse(message.createdAt) >= startedAt
  )
}

/**
 * Which agent Stop must reach: the one running the turn (recorded when it
 * was sent or started), then the chat's session, and only then the model
 * picker, which may already show a different provider for the next message.
 */
export function interruptTarget(
  stream: StreamState | undefined,
  thread: ChatThread,
  selected: ModelOption | undefined
): { providerKind: string; providerInstanceId: string | null } | null {
  if (stream?.providerKind) {
    return {
      providerKind: stream.providerKind,
      providerInstanceId: stream.providerInstanceId ?? null,
    }
  }
  if (thread.session?.providerKind) {
    return {
      providerKind: thread.session.providerKind,
      providerInstanceId: thread.session.providerInstanceId ?? null,
    }
  }
  if (selected) {
    return {
      providerKind: selected.providerKind,
      providerInstanceId: selected.providerInstanceId,
    }
  }
  return null
}

function sortByUpdated(threads: ChatThread[]): ChatThread[] {
  return [...threads].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  )
}

/** The desktop numbers messages when asked for a page; older desktops do not. */
function messageSequence(message: ChatMessage | undefined): number | null {
  const sequence = (message as { sequence?: unknown } | undefined)?.sequence
  return typeof sequence === "number" && Number.isFinite(sequence)
    ? sequence
    : null
}

/**
 * The newest page replaces the newest part of what is loaded; earlier pages
 * the user already fetched stay in front of it.
 */
function mergeNewestPage(
  loaded: ChatMessage[],
  newest: ChatMessage[]
): ChatMessage[] {
  const first = messageSequence(newest[0])
  if (first === null) return newest
  const earlier = loaded.filter((message) => {
    const sequence = messageSequence(message)
    return sequence !== null && sequence < first
  })
  return [...earlier, ...newest]
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

export function pendingRequestsFromActivities(
  activities: ThreadActivity[]
): PendingRequest[] {
  const pending = new Map<string, PendingRequest>()
  const settled = new Set<string>()
  for (const activity of activities) {
    if (
      [
        "approval.resolved",
        "plan-approval.resolved",
        "user-input.resolved",
      ].includes(activity.kind) ||
      isStaleRequestFailure(activity)
    ) {
      const id = requestIdFromPayload(activity.payload)
      if (id) settled.add(id)
    }
  }
  const ordered = [...activities].sort(
    (a, b) =>
      (a.sequence ?? 0) - (b.sequence ?? 0) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
  )
  for (const activity of ordered) {
    const eventType = activityEventType(activity.kind)
    if (!eventType) {
      if (isStaleRequestFailure(activity)) {
        const staleId = requestIdFromPayload(activity.payload)
        if (staleId) pending.delete(staleId)
      }
      continue
    }
    const payload = isRecord(activity.payload) ? activity.payload : {}
    const event = decodeRuntimeFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: eventType,
        thread_id: activity.threadId,
        providerInstanceId: activity.providerInstanceId,
        payload: {
          ...payload,
          detail:
            typeof payload.detail === "string"
              ? payload.detail
              : activity.summary,
        },
      },
    })
    if (!event) continue
    const opened = pendingRequestFromEvent(event)
    if (opened && !settled.has(opened.id)) pending.set(opened.id, opened)
    const resolved = resolvedRequestId(event)
    if (resolved) pending.delete(resolved)
  }
  return [...pending.values()]
}

function activityEventType(kind: string): string | null {
  if (kind === "approval.requested") return "tool_approval_requested"
  if (kind === "approval.resolved") return "tool_approval_resolved"
  if (kind === "plan-approval.requested") return "plan_approval_requested"
  if (kind === "plan-approval.resolved") return "plan_approval_resolved"
  if (kind === "user-input.requested") return "user_input_requested"
  if (kind === "user-input.resolved") return "user_input_resolved"
  return null
}

function isStaleRequestFailure(activity: ThreadActivity): boolean {
  if (
    activity.kind !== "provider.approval.respond.failed" &&
    activity.kind !== "provider.user-input.respond.failed"
  ) {
    return false
  }
  const payload = isRecord(activity.payload) ? activity.payload : {}
  const detail = [
    payload.detail,
    payload.error,
    payload.message,
    activity.summary,
  ]
    .find((value): value is string => typeof value === "string")
    ?.toLowerCase()
  return Boolean(
    detail &&
    (detail.includes("stale pending") || detail.includes("unknown pending"))
  )
}

function requestIdFromPayload(value: unknown): string | null {
  const payload = isRecord(value) ? value : {}
  const direct = payload.requestId ?? payload.request_id
  if (typeof direct === "string" && direct) return direct
  for (const nested of [payload.data, payload.item]) {
    if (!isRecord(nested)) continue
    const id = nested.requestId ?? nested.request_id
    if (typeof id === "string" && id) return id
  }
  return null
}

function providerHistory(messages: ChatMessage[]): Array<{
  role: "user" | "assistant"
  content: string
}> {
  const history: Array<{ role: "user" | "assistant"; content: string }> = []
  let remainingCharacters = 100_000
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (history.length >= 160 || remainingCharacters <= 0) break
    const message = messages[index]
    if (!message || (message.role !== "user" && message.role !== "assistant"))
      continue
    if (message.dispatchFailed || !message.content) continue
    const content = message.content.slice(-remainingCharacters)
    if (!content) continue
    history.push({ role: message.role, content })
    remainingCharacters -= content.length
  }
  return history.reverse()
}
