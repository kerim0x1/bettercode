/**
 * The renderer's mirror of the backend's chat resume records
 * (apps/backend services/chat/resume-runtime.ts). The backend decides when a
 * chat a usage limit or a restart stopped resumes; it reports each record
 * with the thread list (`ChatThread.resume`), on the `thread.metadata`
 * channel (`resume`, `resumePrompt`) and in the answer to a choice
 * (`controlChatResume`). Nothing here sends a turn itself.
 *
 * While a limit holds a chat, this window also holds the chat's queued
 * messages, which would only meet the same limit, and lets them go just
 * before the backend resumes (`queueHold`): the first queued follow-up then
 * goes out instead of "Continue.".
 */
import { useEffect, useState } from "react"
import { create } from "zustand"
import {
  isThreadResumeLimit,
  threadResumePromptSchema,
  threadResumeSchema,
  type ChatResumeAction,
  type ChatThread,
  type ThreadResume,
  type ThreadResumePrompt,
} from "@betterc0de/schema"
import { useChatStore } from "@/lib/chat-store"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import {
  isLimitedNow,
  limitedLabel,
  mergePersistedThreadResumes,
  queueHold,
  QUEUE_HOLD_REASON,
} from "@/lib/chat-resume"
import { postChatResume } from "@/services/backend/resume-api"

interface ChatResumeState {
  byThread: Readonly<Record<string, ThreadResume>>
}

export const useChatResumeStore = create<ChatResumeState>(() => ({
  byThread: {},
}))

/** The chat's record; `null` when it has none. */
export function useThreadResume(
  threadId: string | null | undefined
): ThreadResume | null {
  return useChatResumeStore((state) =>
    threadId ? (state.byThread[threadId] ?? null) : null
  )
}

/**
 * "Limited · resets 14:30" (or "Limited") while a usage or rate limit holds
 * the chat; `null` otherwise. For the sidebar's status glyph and labels.
 */
export function useThreadLimitLabel(
  threadId: string | null | undefined
): string | null {
  const resume = useThreadResume(threadId)
  const now = useResumeClock(isThreadResumeLimit(resume), 60_000)
  return resume && isLimitedNow(resume, now) ? limitedLabel(resume, now) : null
}

/**
 * The current time, ticking every `intervalMs` while `active`, so a label
 * such as "resets 14:30" goes away once the reset has passed.
 */
export function useResumeClock(active: boolean, intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}

function setThreadResume(threadId: string, resume: ThreadResume | null): void {
  useChatResumeStore.setState((state) => {
    if ((state.byThread[threadId] ?? null) === resume) return state
    const byThread = { ...state.byThread }
    if (resume) byThread[threadId] = resume
    else delete byThread[threadId]
    return { byThread }
  })
  syncQueueHold(threadId, resume)
}

/**
 * Applies a `thread.metadata` push with a `resume` field. A record that
 * does not parse is ignored; `null` removes the chat's record.
 */
export function applyThreadResumePush(
  threadId: string,
  resume: unknown,
  prompt?: unknown
): void {
  const parsed = threadResumeSchema.nullable().safeParse(resume)
  if (!parsed.success) return
  setThreadResume(threadId, parsed.data)
  const message = threadResumePromptSchema.safeParse(prompt)
  if (message.success) showResumePrompt(threadId, message.data)
}

/**
 * The message of a turn the backend just started, shown as the note it is
 * before the reply streams in. A chat whose transcript is not loaded gets
 * it with the transcript.
 */
function showResumePrompt(threadId: string, prompt: ThreadResumePrompt): void {
  const store = useChatStore.getState()
  if (!store.messagesLoadedByThread[threadId]) return
  const thread = store.threads.find((candidate) => candidate.id === threadId)
  if (
    !thread ||
    thread.messages.some((message) => message.id === prompt.messageId)
  )
    return
  store.addMessage(
    threadId,
    {
      id: prompt.messageId,
      role: "user",
      content: prompt.content,
      automatic: prompt.automatic,
      ...(prompt.modelId ? { modelId: prompt.modelId } : {}),
      createdAt: prompt.createdAt,
    },
    { persist: false }
  )
  if (prompt.modelId) store.setStreamingModelId(threadId, prompt.modelId)
}

/** The records of a freshly loaded thread list (`loadThreads`). */
export function applyPersistedThreadResumes(
  threads: ReadonlyArray<Pick<ChatThread, "id" | "resume">>,
  beforeLoad: ChatResumeState["byThread"]
): void {
  const current = useChatResumeStore.getState().byThread
  const next = mergePersistedThreadResumes(current, threads, beforeLoad)
  if (next === current) return
  useChatResumeStore.setState({ byThread: next })
  for (const id of new Set([...Object.keys(current), ...Object.keys(next)]))
    if (current[id] !== next[id]) syncQueueHold(id, next[id] ?? null)
}

/**
 * The user's choice on the resume card: resume at the reset, at once, not
 * at all, or forget the record. The backend's answer is applied.
 */
export async function controlChatResume(
  threadId: string,
  action: ChatResumeAction
): Promise<void> {
  const { resume } = await postChatResume(threadId, action)
  setThreadResume(threadId, resume)
}

// ── Holding the queue ───────────────────────────────────────────────────

interface Hold {
  timer: ReturnType<typeof setTimeout> | null
  /** The user resumed the queue by hand: it is theirs again. */
  overridden: boolean
}

const holds = new Map<string, Hold>()
let stopWatchingQueue: (() => void) | null = null

/** Node and browsers run a longer timer at once. */
const MAX_TIMER_MS = 2_147_483_647

function pauseHeldQueue(threadId: string): void {
  try {
    useMessageQueueStore.getState().pause(threadId, QUEUE_HOLD_REASON)
  } catch (error) {
    console.warn("[chat-resume] could not hold the queue", error)
  }
}

/** Lets the queue go, unless the user paused messages of it themselves. */
function releaseHeldQueue(threadId: string): void {
  const hold = holds.get(threadId)
  if (!hold) return
  if (hold.timer) clearTimeout(hold.timer)
  holds.delete(threadId)
  if (holds.size === 0) {
    stopWatchingQueue?.()
    stopWatchingQueue = null
  }
  if (hold.overridden) return
  const queue = useMessageQueueStore.getState()
  const paused = queue.messages.filter(
    (message) => message.threadId === threadId && message.status === "paused"
  )
  if (
    paused.length === 0 ||
    paused.some((message) => message.error !== QUEUE_HOLD_REASON)
  )
    return
  try {
    queue.resume(threadId)
  } catch (error) {
    console.warn("[chat-resume] could not release the queue", error)
  }
}

/**
 * A message queued while the chat is held waits too; a queue the user
 * resumed by hand is left to them.
 */
function watchQueue(): void {
  if (stopWatchingQueue) return
  stopWatchingQueue = useMessageQueueStore.subscribe((state, previous) => {
    for (const [threadId, hold] of holds) {
      if (hold.overridden) continue
      const resumedByHand = state.messages.some(
        (message) =>
          message.threadId === threadId &&
          message.status === "queued" &&
          previous.messages.find((before) => before.id === message.id)
            ?.status === "paused"
      )
      if (resumedByHand) {
        hold.overridden = true
        continue
      }
      if (
        state.messages.some(
          (message) =>
            message.threadId === threadId && message.status === "queued"
        )
      )
        pauseHeldQueue(threadId)
    }
  })
}

function syncQueueHold(threadId: string, resume: ThreadResume | null): void {
  const hold = queueHold(resume, Date.now())
  if (!hold) {
    releaseHeldQueue(threadId)
    return
  }
  const existing = holds.get(threadId)
  if (existing?.timer) clearTimeout(existing.timer)
  const next: Hold = {
    timer:
      hold.releaseAt === null
        ? null
        : setTimeout(
            () => releaseHeldQueue(threadId),
            Math.min(MAX_TIMER_MS, Math.max(0, hold.releaseAt - Date.now()))
          ),
    overridden: existing?.overridden ?? false,
  }
  holds.set(threadId, next)
  watchQueue()
  if (!next.overridden) pauseHeldQueue(threadId)
}
