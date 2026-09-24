import { create } from "zustand"
import {
  normalizeProviderGoal,
  parseGoalCommand,
  isRecord,
} from "@betterc0de/schema"
import type {
  ChatMessage,
  ChatThread,
  ConnectionProfile,
  ModelOption,
  PendingRequest,
  ProjectSummary,
  ThreadActivity,
} from "@/types/remote"
import { remoteApi } from "@/lib/remote-api"
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
}

export interface RuntimeOutcome {
  threadId: string
  terminal: boolean
  refreshThreads: boolean
}

interface AppStore {
  threads: ChatThread[]
  projects: ProjectSummary[]
  messagesByThread: Record<string, ChatMessage[]>
  activitiesByThread: Record<string, ThreadActivity[]>
  streamsByThread: Record<string, StreamState>
  requestsByThread: Record<string, PendingRequest[]>
  selectedModels: Record<string, ModelOption>
  turnOptionsByThread: Record<string, TurnOptions>
  loadingThreads: boolean
  loadingProjects: boolean
  loadingMessages: Record<string, boolean>
  error: string | null
  refreshThreads: (profile: ConnectionProfile) => Promise<void>
  refreshProjects: (profile: ConnectionProfile) => Promise<void>
  loadMessages: (
    profile: ConnectionProfile,
    threadId: string,
    clearCompletedStream?: boolean
  ) => Promise<void>
  loadActivities: (
    profile: ConnectionProfile,
    threadId: string
  ) => Promise<void>
  createThread: (
    profile: ConnectionProfile,
    project: ProjectSummary
  ) => Promise<ChatThread>
  send: (
    profile: ConnectionProfile,
    threadId: string,
    content: string,
    selection: ModelOption
  ) => Promise<void>
  interrupt: (profile: ConnectionProfile, threadId: string) => Promise<void>
  resolveRequest: (
    profile: ConnectionProfile,
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
  projects: [] as ProjectSummary[],
  messagesByThread: {} as Record<string, ChatMessage[]>,
  activitiesByThread: {} as Record<string, ThreadActivity[]>,
  streamsByThread: {} as Record<string, StreamState>,
  requestsByThread: {} as Record<string, PendingRequest[]>,
  selectedModels: {} as Record<string, ModelOption>,
  turnOptionsByThread: {} as Record<string, TurnOptions>,
  loadingThreads: false,
  loadingProjects: false,
  loadingMessages: {} as Record<string, boolean>,
  error: null as string | null,
}

// Reset retires all awaited writes owned by the previous session.
let generation = 0

export const useAppStore = create<AppStore>((set, get) => ({
  ...initialState,

  refreshThreads: async (profile) => {
    const owner = generation
    set({ loadingThreads: true, error: null })
    try {
      const beforeLoad = new Map(
        get().threads.map((thread) => [thread.id, thread])
      )
      const threads = await remoteApi(profile).listThreads()
      if (owner !== generation) return
      threads.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      set((state) => {
        const current = new Map(
          state.threads.map((thread) => [thread.id, thread])
        )
        return {
          threads: threads.map((thread) => {
            const live = current.get(thread.id)
            return live &&
              live !== beforeLoad.get(thread.id) &&
              live.goal !== undefined
              ? { ...thread, goal: live.goal }
              : thread
          }),
          loadingThreads: false,
        }
      })
    } catch (error) {
      if (owner !== generation) return
      set({ loadingThreads: false, error: readableError(error) })
      throw error
    }
  },

  refreshProjects: async (profile) => {
    const owner = generation
    set({ loadingProjects: true })
    try {
      const projects = await remoteApi(profile).listProjects()
      if (owner !== generation) return
      projects.sort((a, b) => a.name.localeCompare(b.name))
      set({ projects, loadingProjects: false })
    } catch (error) {
      if (owner !== generation) return
      set({ loadingProjects: false, error: readableError(error) })
      throw error
    }
  },

  loadMessages: async (profile, threadId, clearCompletedStream = false) => {
    const owner = generation
    set((state) => ({
      loadingMessages: { ...state.loadingMessages, [threadId]: true },
    }))
    try {
      const messages = await remoteApi(profile).listMessages(threadId)
      if (owner !== generation) return
      set((state) => ({
        messagesByThread: { ...state.messagesByThread, [threadId]: messages },
        loadingMessages: { ...state.loadingMessages, [threadId]: false },
        streamsByThread:
          clearCompletedStream &&
          shouldClearCompletedStream(state.streamsByThread[threadId], messages)
            ? omitKey(state.streamsByThread, threadId)
            : state.streamsByThread,
      }))
    } catch (error) {
      if (owner !== generation) return
      set((state) => ({
        loadingMessages: { ...state.loadingMessages, [threadId]: false },
        error: readableError(error),
      }))
      throw error
    }
  },

  loadActivities: async (profile, threadId) => {
    const owner = generation
    const activities = await remoteApi(profile).listActivities(threadId)
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

  createThread: async (profile, project) => {
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
    await remoteApi(profile).createThread(thread)
    if (owner !== generation)
      throw new Error("The session changed while creating the chat.")
    set((state) => ({ threads: [thread, ...state.threads] }))
    return thread
  },

  send: async (profile, threadId, content, selection) => {
    const owner = generation
    const thread = get().threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error("Chat not found.")
    const history = providerHistory(
      get().messagesByThread[threadId] ?? thread.messages ?? []
    )
    // Same parser as the desktop and the backend: a malformed command is
    // rejected here with the desktop's wording instead of a round trip.
    if (parseGoalCommand(content) !== null) {
      const options = get().turnOptionsByThread[threadId]
      const result = await remoteApi(profile).goal({
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
      if (owner !== generation) return
      set((state) => ({
        threads: state.threads.map((item) =>
          item.id === threadId && item.goal === thread.goal
            ? { ...item, goal: result.goal }
            : item
        ),
      }))
      return
    }
    const now = new Date().toISOString()
    const messageId = createId("mobile-message")
    const optimistic: ChatMessage = {
      id: messageId,
      role: "user",
      content,
      createdAt: now,
      dispatchStatus: "pending",
    }
    set((state) => ({
      messagesByThread: {
        ...state.messagesByThread,
        [threadId]: [...(state.messagesByThread[threadId] ?? []), optimistic],
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
        },
      },
      threads: state.threads.map((item) =>
        item.id === threadId ? { ...item, updatedAt: now } : item
      ),
      error: null,
    }))
    const turnOptions = get().turnOptionsByThread[threadId]
    try {
      const result = await remoteApi(profile).sendMessage({
        providerKind: selection.providerKind,
        providerInstanceId: selection.providerInstanceId,
        threadId,
        userMessageId: messageId,
        userMessageContent: content,
        userMessageCreatedAt: now,
        threadTitle: thread.title,
        threadProjectName: thread.projectName,
        threadCreatedAt: thread.createdAt,
        message: content,
        modelId: selection.modelId,
        projectPath: thread.worktreePath || thread.projectPath,
        history,
        attachments: [],
        appMode: "agent",
        reasoningEffort: turnOptions?.thinkingMode ?? null,
        fastMode: turnOptions?.fastMode ?? null,
      })
      if (owner !== generation) return
      set((state) => ({
        messagesByThread: {
          ...state.messagesByThread,
          [threadId]: (state.messagesByThread[threadId] ?? []).map((message) =>
            message.id === messageId
              ? { ...message, dispatchStatus: "accepted" }
              : message
          ),
        },
        streamsByThread: {
          ...state.streamsByThread,
          [threadId]: {
            ...(state.streamsByThread[threadId] ?? {
              content: "",
              reasoning: "",
              running: true,
              error: null,
              startedAt: now,
            }),
            turnId: result.turnId,
          },
        },
      }))
    } catch (error) {
      if (owner !== generation) return
      set((state) => ({
        messagesByThread: {
          ...state.messagesByThread,
          [threadId]: (state.messagesByThread[threadId] ?? []).map((message) =>
            message.id === messageId
              ? { ...message, dispatchStatus: "failed", dispatchFailed: true }
              : message
          ),
        },
        streamsByThread: {
          ...state.streamsByThread,
          [threadId]: {
            ...(state.streamsByThread[threadId] ?? {
              turnId: null,
              content: "",
              reasoning: "",
              startedAt: now,
            }),
            running: false,
            error: readableError(error),
          },
        },
      }))
      throw error
    }
  },

  interrupt: async (profile, threadId) => {
    const thread = get().threads.find((candidate) => candidate.id === threadId)
    if (!thread) throw new Error("Chat not found.")
    const selected = get().selectedModels[threadId]
    await remoteApi(profile).interrupt({
      providerKind:
        selected?.providerKind || thread.session?.providerKind || "openai",
      providerInstanceId:
        selected?.providerInstanceId || thread.session?.providerInstanceId,
      threadId,
    })
  },

  resolveRequest: async (profile, request, response) => {
    const owner = generation
    const body = {
      providerKind: request.providerKind,
      providerInstanceId: request.providerInstanceId,
      threadId: request.threadId,
      requestId: request.id,
    }
    const api = remoteApi(profile)
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
            event.providerKind
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
 */
export function shouldClearCompletedStream(
  stream: StreamState | undefined,
  messages: readonly ChatMessage[]
): boolean {
  if (!stream) return false
  if (stream.running) return false
  if (stream.content.length === 0) return true
  const startedAt = Date.parse(stream.startedAt)
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      (Number.isNaN(startedAt) || Date.parse(message.createdAt) >= startedAt)
  )
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed."
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
