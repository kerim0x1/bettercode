import { asRecord } from "@betterc0de/schema"
import { useCallback, useMemo, useRef } from "react"
import {
  getThreadStream,
  useChatStore,
  type ThreadActivity,
} from "@/lib/chat-store"
import {
  EMPTY_ACTIVITIES,
  selectThreadActivities,
  selectThreadMessages,
} from "@/lib/chat/thread-derived"
import { isStructuredPlanMarkdown } from "@/lib/message-utils"
import { parseBetterC0dePlanJson, unwrapPlanContent } from "@/lib/plan-content"
import { useShimmerPhase } from "@/hooks/use-shimmer-phase"
import type { SourceProposedPlanReference } from "@/lib/plan-modal"

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function sourceProposedPlanKey(source: SourceProposedPlanReference): string {
  return `${source.threadId}::${source.planId}`
}

function sourceProposedPlanFromPayload(
  payload: Record<string, unknown>
): SourceProposedPlanReference | null {
  const source = asRecord(
    payload.sourceProposedPlan ?? payload.source_proposed_plan
  )
  const threadId = stringFrom(source.threadId) ?? stringFrom(source.thread_id)
  const planId = stringFrom(source.planId) ?? stringFrom(source.plan_id)
  return threadId && planId ? { threadId, planId } : null
}

function planContentFromActivity(activity: ThreadActivity): string | null {
  if (activity.kind !== "turn.proposed.completed") return null
  const payload = asRecord(activity.payload)
  return (
    stringFrom(payload.planMarkdown) ??
    stringFrom(payload.plan_markdown) ??
    stringFrom(payload.detail) ??
    null
  )
}

function sourceProposedPlanFromActivity(
  activity: ThreadActivity
): SourceProposedPlanReference {
  return { threadId: activity.threadId, planId: activity.id }
}

export interface PlanEntry {
  id: string
  content: string
  preview: string
  createdAt?: string
  streaming: boolean
  sourceProposedPlan?: SourceProposedPlanReference | null
  implemented?: boolean
  implementedAt?: string | null
  implementationThreadId?: string | null
}

type PlanSourceMessage = {
  id?: string
  content: string
  role: string
  createdAt?: string
}

function buildPlanPreview(content: string): string {
  const planContent = unwrapPlanContent(content)
  const parsedJsonPlan = parseBetterC0dePlanJson(planContent)
  if (parsedJsonPlan) return parsedJsonPlan.previewContent

  const maxLines = 8
  const lines = planContent
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("```"))
  return lines.slice(0, maxLines).join("\n").trim()
}

function computePersistedPlans(
  messages: ReadonlyArray<PlanSourceMessage>,
  activities: ReadonlyArray<ThreadActivity>
): PlanEntry[] {
  const out: PlanEntry[] = []
  const implementedPlans = new Map<
    string,
    { implementedAt?: string | null; implementationThreadId?: string | null }
  >()
  activities.forEach((activity) => {
    if (activity.kind !== "turn.proposed.implemented") return
    const payload = asRecord(activity.payload)
    const source = sourceProposedPlanFromPayload(payload)
    if (!source) return
    implementedPlans.set(sourceProposedPlanKey(source), {
      implementedAt:
        stringFrom(payload.implementedAt) ?? stringFrom(payload.implemented_at),
      implementationThreadId:
        stringFrom(payload.implementationThreadId) ??
        stringFrom(payload.implementation_thread_id),
    })
  })
  messages.forEach((msg, idx) => {
    if (msg.role === "assistant" && isStructuredPlanMarkdown(msg.content)) {
      out.push({
        id: msg.id ?? `plan-${idx}`,
        content: msg.content,
        preview: buildPlanPreview(msg.content),
        createdAt: msg.createdAt,
        streaming: false,
      })
    }
  })

  activities.forEach((activity) => {
    const content = planContentFromActivity(activity)
    if (!content) return
    const sourceProposedPlan = sourceProposedPlanFromActivity(activity)
    const implementation = implementedPlans.get(
      sourceProposedPlanKey(sourceProposedPlan)
    )
    out.push({
      id: activity.id,
      content,
      preview: buildPlanPreview(content),
      createdAt: activity.createdAt,
      streaming: false,
      sourceProposedPlan,
      implemented: Boolean(implementation),
      implementedAt: implementation?.implementedAt ?? null,
      implementationThreadId: implementation?.implementationThreadId ?? null,
    })
  })

  out.sort((left, right) => {
    if (!left.createdAt || !right.createdAt) return 0
    return left.createdAt.localeCompare(right.createdAt)
  })
  return out
}

const persistedPlanCache = new WeakMap<
  ReadonlyArray<PlanSourceMessage>,
  WeakMap<ReadonlyArray<ThreadActivity>, PlanEntry[]>
>()

/**
 * Plans recorded in a thread's history (assistant plan messages and
 * `turn.proposed.completed` activities). The scan runs a regex per message,
 * so the result is cached per (messages, activities) array pair: the chat
 * column, the plan list and the workspace panel all read the same thread
 * and share one computation per history change.
 */
export function derivePersistedPlans(
  messages: ReadonlyArray<PlanSourceMessage>,
  activities: ReadonlyArray<ThreadActivity>
): PlanEntry[] {
  let byActivities = persistedPlanCache.get(messages)
  if (!byActivities) {
    byActivities = new WeakMap()
    persistedPlanCache.set(messages, byActivities)
  }
  const cached = byActivities.get(activities)
  if (cached) return cached
  const plans = computePersistedPlans(messages, activities)
  byActivities.set(activities, plans)
  return plans
}

/** Appends the plan being written right now, if there is one. */
function withStreamingPlan(
  persistedPlans: PlanEntry[],
  streamingPlanText: string,
  streamingTextPlan: string
): PlanEntry[] {
  const content = streamingPlanText || streamingTextPlan
  if (!content) return persistedPlans
  return [
    ...persistedPlans,
    {
      id: "plan-streaming",
      content,
      preview: buildPlanPreview(content),
      streaming: true,
    },
  ]
}

/**
 * A plan is only "streaming" once the real <proposed_plan> boundary is
 * crossed (store flag set by turn.proposed.* events or the content prefix
 * detector). The old `isStructuredPlanMarkdown(streamingText)` disjunct
 * promoted preliminary narration containing a `## Tasks`/`## Overview`
 * header into a premature plan card while the agent was still narrating.
 */
function planIsStreaming(
  isStreaming: boolean,
  planStreamingFlag: boolean,
  streamingPlanText: string
): boolean {
  return isStreaming && (planStreamingFlag || !!streamingPlanText)
}

/**
 * Bundles every chat-store streaming selector we need into one call,
 * plus the derived plan-preview + shimmer-phase state.
 *
 * Each `useChatStore((s) => getThreadStream(s, s.activeThreadId).X)` is a
 * subscription — we list them individually rather than as one object so
 * zustand can still bail out re-renders at the field level (returning the
 * same primitive value from the selector gives you the usual zustand
 * equality check without needing `shallow`).
 *
 * This hook re-renders on every streamed delta. Mount it only where the live
 * text is shown (the transcript); surfaces that need plans or flags use
 * {@link usePlanStreamingState} / {@link useThreadPersistedPlans}.
 */
export function useChatStreamingState(
  messages: PlanSourceMessage[],
  /**
   * Override the thread we subscribe to — split-mode columns pass their
   * own tab's threadId. If omitted, defaults to the globally-active thread
   * (original behavior).
   */
  explicitThreadId?: string | null,
  /**
   * When `includeShimmer: false`, the shimmer-phase timer is held at 0 and
   * never advances — the orchestrator hook passes this so shimmer ticks do
   * not cascade re-renders through prop-bag memos that don't consume it.
   */
  options?: { includeShimmer?: boolean },
  activities: ThreadActivity[] = EMPTY_ACTIVITIES
) {
  const activeThreadId = useChatStore((s) =>
    explicitThreadId === undefined ? s.activeThreadId : explicitThreadId
  )
  const isStreaming = useChatStore(
    (s) => getThreadStream(s, activeThreadId).isStreaming
  )
  const streamingText = useChatStore(
    (s) => getThreadStream(s, activeThreadId).streamingText
  )
  const streamingPlanText = useChatStore(
    (s) => getThreadStream(s, activeThreadId).streamingPlanText
  )
  const planStreamingFlag = useChatStore(
    (s) => getThreadStream(s, activeThreadId).isPlanStreaming
  )
  const reasoningText = useChatStore(
    (s) => getThreadStream(s, activeThreadId).reasoningText
  )
  const isReasoning = useChatStore(
    (s) => getThreadStream(s, activeThreadId).isReasoning
  )
  const reasoningSegments = useChatStore(
    (s) => getThreadStream(s, activeThreadId).reasoningSegments
  )
  const streamingTools = useChatStore(
    (s) => getThreadStream(s, activeThreadId).streamingTools
  )
  const streamingTasks = useChatStore(
    (s) => getThreadStream(s, activeThreadId).streamingTasks
  )
  const streamingDiffs = useChatStore(
    (s) => getThreadStream(s, activeThreadId).streamingDiffs
  )
  const streamingModelId = useChatStore(
    (s) => getThreadStream(s, activeThreadId).streamingModelId
  )

  // Always call the hook (rules-of-hooks) but disable the phase timer when
  // the caller opts out — keeps the re-render cost at zero for consumers
  // that don't read shimmerPhase.
  const shimmerEnabled = options?.includeShimmer !== false
  const shimmerPhase = useShimmerPhase({
    isStreaming: shimmerEnabled ? isStreaming : false,
    hasStreamingContent: !!(
      streamingText ||
      streamingPlanText ||
      reasoningText ||
      isReasoning ||
      streamingTools.length > 0
    ),
  })

  // Persisted plans are derived from history only and cached per array pair,
  // so this does not rescan the history per streamed token. The live
  // streaming entry is appended separately below.
  const persistedPlans = derivePersistedPlans(messages, activities)

  const allPlans = useMemo<PlanEntry[]>(
    () =>
      withStreamingPlan(
        persistedPlans,
        streamingPlanText,
        streamingText && isStructuredPlanMarkdown(streamingText)
          ? streamingText
          : ""
      ),
    [persistedPlans, streamingText, streamingPlanText]
  )

  const latestPlanContent =
    allPlans.length > 0 ? allPlans[allPlans.length - 1].content : null
  const latestPlanPreviewMarkdown =
    allPlans.length > 0 ? allPlans[allPlans.length - 1].preview : ""

  const isPlanStreaming = planIsStreaming(
    isStreaming,
    planStreamingFlag,
    streamingPlanText
  )

  return {
    activeThreadId,
    isStreaming,
    streamingText,
    streamingPlanText,
    reasoningText,
    reasoningSegments,
    isReasoning,
    streamingTools,
    streamingTasks,
    streamingDiffs,
    streamingModelId,
    planStreamingFlag,
    shimmerPhase,
    latestPlanContent,
    latestPlanPreviewMarkdown,
    isPlanStreaming,
    allPlans,
  }
}

type ChatStoreState = ReturnType<typeof useChatStore.getState>

/**
 * The thread's recorded plans. The array is stable between history changes,
 * so a component reading only plans does not re-render on streamed deltas,
 * and the scan behind it is shared and cached.
 */
export function useThreadPersistedPlans(
  threadId: string | null | undefined
): PlanEntry[] {
  // Most activity events (tool updates) add no plan. Returning the previous
  // array when the plans are unchanged keeps zustand's equality check from
  // re-rendering on them.
  const last = useRef<PlanEntry[] | null>(null)
  return useChatStore(
    useCallback(
      (state: ChatStoreState) => {
        const next = derivePersistedPlans(
          selectThreadMessages(state, threadId),
          selectThreadActivities(state, threadId)
        )
        const previous = last.current
        if (previous && samePlanEntries(previous, next)) return previous
        last.current = next
        return next
      },
      [threadId]
    )
  )
}

/** Whether two plan lists show the same plans in the same state. */
export function samePlanEntries(
  left: ReadonlyArray<PlanEntry>,
  right: ReadonlyArray<PlanEntry>
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((plan, index) => {
    const other = right[index]!
    return (
      plan.id === other.id &&
      plan.content === other.content &&
      plan.createdAt === other.createdAt &&
      plan.streaming === other.streaming &&
      plan.implemented === other.implemented &&
      plan.implementedAt === other.implementedAt &&
      plan.implementationThreadId === other.implementationThreadId &&
      plan.sourceProposedPlan?.threadId ===
        other.sourceProposedPlan?.threadId &&
      plan.sourceProposedPlan?.planId === other.sourceProposedPlan?.planId
    )
  })
}

/**
 * Plans plus the plan-streaming flag for surfaces that list plans (the
 * workspace panel and the per-pane plan list). Unlike
 * {@link useChatStreamingState} it ignores ordinary answer text: it
 * re-renders while a plan is being written, not on every reply delta.
 */
export function usePlanStreamingState(threadId: string | null | undefined): {
  isPlanStreaming: boolean
  allPlans: PlanEntry[]
} {
  const persistedPlans = useThreadPersistedPlans(threadId)
  const isStreaming = useChatStore(
    useCallback(
      (state: ChatStoreState) =>
        getThreadStream(state, threadId ?? null).isStreaming,
      [threadId]
    )
  )
  const planStreamingFlag = useChatStore(
    useCallback(
      (state: ChatStoreState) =>
        getThreadStream(state, threadId ?? null).isPlanStreaming,
      [threadId]
    )
  )
  const streamingPlanText = useChatStore(
    useCallback(
      (state: ChatStoreState) =>
        getThreadStream(state, threadId ?? null).streamingPlanText,
      [threadId]
    )
  )
  // Answer text counts only when it is itself a structured plan. The check
  // is cached per text value, so other store updates do not repeat it.
  const planTextCheck = useRef<{ text: string; plan: string }>({
    text: "",
    plan: "",
  })
  const streamingTextPlan = useChatStore(
    useCallback(
      (state: ChatStoreState) => {
        const text = getThreadStream(state, threadId ?? null).streamingText
        const cache = planTextCheck.current
        if (cache.text !== text) {
          cache.text = text
          cache.plan = text && isStructuredPlanMarkdown(text) ? text : ""
        }
        return cache.plan
      },
      [threadId]
    )
  )
  const allPlans = useMemo(
    () =>
      withStreamingPlan(persistedPlans, streamingPlanText, streamingTextPlan),
    [persistedPlans, streamingPlanText, streamingTextPlan]
  )
  return {
    isPlanStreaming: planIsStreaming(
      isStreaming,
      planStreamingFlag,
      streamingPlanText
    ),
    allPlans,
  }
}
