import { asRecord } from "@betterc0de/schema"
import { cn } from "@/lib/utils"
import { providerHandoffMessageIds } from "@/lib/chat-context"
import {
  deriveProviderHandoffs,
  type ProviderHandoffEntry,
} from "@/lib/provider-handoff"
import { ProviderHandoffStatus } from "@/components/chat/provider-handoff-status"
import { OrchestratorTeamStatus } from "@/components/chat/orchestrator-team-status"
import { runtimeFailurePresentation } from "@/lib/execution-diagnostics"
import {
  activityCorrelationFields,
  buildActivityTools,
  compareActivities,
  groupToolActivitiesByTurn,
  providerInstanceIdFromActivityPayload,
  providerKindFromActivityPayload,
  type ActivityTool,
} from "@betterc0de/schema/activity-tools"
import { useEffect, useMemo, useState, useId } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { CubeIcon } from "@hugeicons/core-free-icons"
import { getModelInfo } from "@/lib/get-model-info"
import { logoNeedsDarkInvert } from "@/lib/logo-invert"
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { ChatMessageItem } from "@/components/chat/chat-message-item"
import { PlanImplementationCard } from "@/components/chat/plan-implementation-card"
import { StreamingMessage } from "@/components/chat/streaming-message"
import { ErrorBoundary } from "@/components/error-boundary"
import { ToolCallGroup } from "@/components/chat/tool-call-group"
import type { ReasoningSegment } from "@/lib/chat/types"
import { Button } from "@/components/ui/button"
import { CheckIcon, ShieldAlertIcon, XIcon } from "lucide-react"
import { EmptyStateHero } from "@/components/chat/empty-state-hero"
import { chatContentWidth } from "./chat-layout"
import {
  useChatStore,
  type ChatMessage,
  type ThreadActivity,
} from "@/lib/chat-store"
import { useSettingsStore } from "@/lib/settings-store"
import type { ConfirmAction } from "@/components/dialogs/confirm-action-dialog"
import type { UiProvider } from "@/lib/provider-types"
import {
  derivePendingApprovals,
  derivePendingPlanApprovals,
  type PendingApproval,
} from "@/lib/pending-approvals"
import {
  ALWAYS_ALLOW_DESTINATIONS,
  ApprovalRequestContext,
  alwaysAllowRules,
  buildAlwaysAllowUpdate,
  describeAlwaysAllowRules,
  submitApprovalDecision,
} from "@/components/chat/approval-request-context"
import { PlanApprovalCard } from "@/components/chat/plan-approval-card"
import { isStructuredPlanMarkdown } from "@/lib/message-utils"
import { stripProposedPlanWrapper } from "@/lib/plan-content"
import { usePreferencesStore } from "@/lib/preferences-store"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { formatProviderActivityLabel } from "@/lib/provider-label"
import type {
  SetPlanModalContent,
  SourceProposedPlanReference,
} from "@/lib/plan-modal"
import type { ChatSubmitPayload } from "@/hooks/use-chat-submit"
import { windowTranscriptEntries } from "@/components/chat/transcript-window"

type StreamingTool = {
  id: string
  name: string
  input: unknown
  output?: unknown
  state?: string
  providerKind?: string
  providerInstanceId?: string
}

type StreamingDiff = {
  path: string
  additions: number
  deletions: number
  oldText: string
  newText: string
  isNew: boolean
}

type StreamingTask = {
  text: string
  completed: boolean
}

/**
 * Scrollable chat transcript: loops over persisted messages via
 * {@link ChatMessageItem}, then optionally appends {@link StreamingMessage}
 * for the in-flight assistant turn.
 *
 * The outer `<Conversation>` primitive handles auto-scroll / keep-bottom
 * behavior; this component just owns the content + layout width
 * constraint (900 px in Simple UI mode, wider otherwise).
 *
 * Rendered in single-conversation mode; the swarm-grid view swaps in a
 * different component at the parent level.
 */
export function ChatTranscript({
  messages,
  activities,
  isStreaming,
  minimalChat,
  activeThreadId,
  activeProjectPath,
  handleSubmit,
  setConfirmAction,
  setPlanModalContent,
  streamingText,
  streamingPlanText,
  streamingTools,
  streamingDiffs,
  streamingTasks,
  reasoningText,
  reasoningSegments,
  isReasoning,
  isPlanStreaming,
  chatMode,
  shimmerPhase,
  selectedProvider,
  appMode = "agent",
}: {
  messages: ChatMessage[]
  activities: ThreadActivity[]
  isStreaming: boolean
  minimalChat: boolean
  activeThreadId: string | null
  activeProjectPath?: string | null
  handleSubmit: (args: ChatSubmitPayload) => void
  setConfirmAction: (a: ConfirmAction) => void
  setPlanModalContent: SetPlanModalContent
  streamingText: string
  streamingPlanText: string
  streamingTools: StreamingTool[]
  streamingDiffs: StreamingDiff[]
  streamingTasks: StreamingTask[]
  reasoningText: string
  reasoningSegments?: ReadonlyArray<ReasoningSegment>
  isReasoning: boolean
  isPlanStreaming: boolean
  chatMode: string
  shimmerPhase: number
  selectedProvider: UiProvider | undefined
  appMode?: "agent" | "editor" | "design"
}) {
  const editorCompact = false
  const showMessageTimestamps = useSettingsStore(
    (state) => state.showMessageTimestamps
  )
  const showThinkingBlocks = useSettingsStore(
    (state) => state.showThinkingBlocks
  )
  const showReasoningSummaries = useSettingsStore(
    (state) => state.showReasoningSummaries
  )
  const showToolDetails = useSettingsStore((state) => state.showToolDetails)
  const showSessionProgressBar = useSettingsStore(
    (state) => state.showSessionProgressBar
  )
  const shellToolPartsExpanded = useSettingsStore(
    (state) => state.shellToolPartsExpanded
  )
  const editToolPartsExpanded = useSettingsStore(
    (state) => state.editToolPartsExpanded
  )
  const showChatScrollbar = useSettingsStore((state) => state.showChatScrollbar)
  const showGenericToolOutput = useSettingsStore(
    (state) => state.showGenericToolOutput
  )
  const concealCodeBlocks = useSettingsStore((state) => state.concealCodeBlocks)
  const hasProviderOutput = Boolean(
    streamingText ||
    streamingPlanText ||
    reasoningText ||
    reasoningSegments?.length ||
    streamingTools.length
  )
  const timeline = useMemo(
    () =>
      deriveTranscriptTimeline(messages, activities, {
        showSessionProgressBar,
        isStreaming,
        hasProviderOutput,
      }),
    [
      messages,
      activities,
      showSessionProgressBar,
      isStreaming,
      hasProviderOutput,
    ]
  )
  const isCompactingPreviousContext = timeline.some(
    (entry) => entry.kind === "context-handoff" && entry.status === "compacting"
  )
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(activities),
    [activities]
  )
  const pendingPlanApprovals = useMemo(
    () => derivePendingPlanApprovals(activities),
    [activities]
  )
  const activeThreadSession = useChatStore((state) =>
    activeThreadId
      ? state.threads.find((thread) => thread.id === activeThreadId)?.session
      : null
  )
  const transcriptId = useId()
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{ target?: string; threadId?: string | null }>
      ).detail
      const owner =
        detail?.threadId === undefined
          ? useChatStore.getState().activeThreadId
          : detail.threadId
      if (owner !== activeThreadId) return
      const scope = document.getElementById(transcriptId)
      if (scope) scrollChatMessageTarget(scope, detail?.target)
    }
    window.addEventListener("betterc0de:chat-scroll-message", handler)
    return () =>
      window.removeEventListener("betterc0de:chat-scroll-message", handler)
  }, [activeThreadId, transcriptId])

  const windowedTimeline = useMemo(
    () => windowTranscriptEntries(timeline),
    [timeline]
  )
  const isEmptyThread =
    timeline.length === 0 &&
    !isStreaming &&
    pendingApprovals.length === 0 &&
    pendingPlanApprovals.length === 0

  return (
    <Conversation
      id={transcriptId}
      className={cn(
        "min-h-0 flex-1",
        showChatScrollbar ? "chat-scrollbar-visible" : "chat-scrollbar-hidden"
      )}
    >
      <ConversationContent
        scrollClassName={
          isEmptyThread ? "flex flex-col [scrollbar-gutter:auto]!" : undefined
        }
        data-betterc0de-chat-transcript-content="true"
        className={cn(
          "chat-prose mx-auto",
          editorCompact
            ? "chat-prose--editor max-w-none gap-3 px-2.5 py-3"
            : cn(
                "gap-4 px-4 py-4",
                minimalChat && "chat-prose--compact",
                chatContentWidth(minimalChat)
              ),
          // Fill the scroll parent's flex column; short panes still scroll.
          isEmptyThread && "min-h-full w-full flex-1"
        )}
      >
        {activeThreadId && (
          <OrchestratorTeamStatus
            key={activeThreadId}
            threadId={activeThreadId}
          />
        )}
        {isEmptyThread ? (
          <EmptyStateHero variant={appMode} threadId={activeThreadId} />
        ) : (
          <>
            {windowedTimeline.hiddenBefore > 0 ? (
              <div
                aria-hidden
                data-betterc0de-transcript-hidden-before={
                  windowedTimeline.hiddenBefore
                }
                style={{ height: windowedTimeline.hiddenBefore * 72 }}
              />
            ) : null}
            {windowedTimeline.visible.map((entry) =>
              entry.kind === "message" ? (
                <div
                  key={entry.id}
                  data-betterc0de-chat-message="true"
                  data-chat-message-role={entry.msg.role}
                  data-chat-message-index={entry.idx}
                >
                  <ErrorBoundary label={`Message ${entry.msg.id}`}>
                    <ChatMessageItem
                      msg={entry.msg}
                      idx={entry.idx}
                      messages={messages}
                      activeThreadId={activeThreadId}
                      providerSkills={selectedProvider?.skills}
                      providerInstanceId={
                        activeThreadSession?.providerInstanceId ??
                        selectedProvider?.providerInstanceId ??
                        null
                      }
                      workspaceRoot={activeProjectPath}
                      activityTools={entry.tools}
                      activityWork={entry.work}
                      hidePlanCard={entry.hidePlanCard}
                      compact={editorCompact}
                      showTimestamp={showMessageTimestamps}
                      showThinking={showThinkingBlocks}
                      showReasoningSummaries={showReasoningSummaries}
                      showToolDetails={showToolDetails}
                      shellToolPartsExpanded={shellToolPartsExpanded}
                      editToolPartsExpanded={editToolPartsExpanded}
                      showGenericToolOutput={showGenericToolOutput}
                      concealCodeBlocks={concealCodeBlocks}
                      onRetry={(content) =>
                        handleSubmit({ text: content, files: [] })
                      }
                      onOpenConfirm={setConfirmAction}
                      onOpenPlanModal={setPlanModalContent}
                    />
                  </ErrorBoundary>
                </div>
              ) : entry.kind === "context-handoff" ? (
                <ProviderHandoffStatus
                  key={entry.id}
                  entry={entry}
                  workspaceRoot={activeProjectPath}
                />
              ) : entry.kind === "model-switch" ? (
                <ModelSwitchNotice
                  key={entry.id}
                  from={entry.from}
                  to={entry.to}
                />
              ) : (
                <ErrorBoundary
                  key={entry.id}
                  label={`Proposed plan ${entry.id}`}
                >
                  {(entry.tools.length > 0 || entry.work.length > 0) && (
                    <ToolCallGroup
                      tools={entry.tools}
                      work={entry.work}
                      defaultOpen={showToolDetails}
                      showGenericOutput={showGenericToolOutput}
                      shellToolPartsExpanded={shellToolPartsExpanded}
                      editToolPartsExpanded={editToolPartsExpanded}
                      treeKey={`${activeThreadId ?? "thread"}:${entry.id}`}
                    />
                  )}
                  {/* While the approval is open, PlanApprovalCard in the
                      pending slot owns this plan — it's the only card with
                      approve/feedback. The tool group above stays either way,
                      so it doesn't flicker across the decision. */}
                  {!entry.awaitingApproval && (
                    <PlanImplementationCard
                      content={entry.content}
                      sourceProposedPlan={entry.sourceProposedPlan}
                      implemented={entry.implemented}
                      implementedAt={entry.implementedAt}
                      implementationThreadId={entry.implementationThreadId}
                      onOpenPlanModal={setPlanModalContent}
                      workspaceRoot={activeProjectPath}
                    />
                  )}
                </ErrorBoundary>
              )
            )}
            {(pendingApprovals.length > 0 || pendingPlanApprovals.length > 0) &&
            activeThreadId ? (
              <div className="flex flex-col gap-2">
                {pendingPlanApprovals.map((planApproval) => (
                  <PlanApprovalCard
                    key={planApproval.requestId}
                    threadId={activeThreadId}
                    planApproval={planApproval}
                    onReviewFullPlan={(planMarkdown) =>
                      setPlanModalContent(planMarkdown)
                    }
                  />
                ))}
                {pendingApprovals.map((approval) => (
                  <PendingApprovalRow
                    key={approval.requestId}
                    threadId={activeThreadId}
                    approval={approval}
                  />
                ))}
              </div>
            ) : null}
            {isStreaming && !isCompactingPreviousContext && (
              <ErrorBoundary label="Streaming message">
                <StreamingMessage
                  streamingText={streamingText}
                  streamingPlanText={streamingPlanText}
                  streamingTools={streamingTools}
                  streamingDiffs={streamingDiffs}
                  streamingTasks={streamingTasks}
                  reasoningText={reasoningText}
                  reasoningSegments={reasoningSegments}
                  isReasoning={isReasoning}
                  isPlanStreaming={isPlanStreaming}
                  chatMode={chatMode}
                  shimmerPhase={shimmerPhase}
                  onOpenPlanModal={setPlanModalContent}
                  workspaceRoot={activeProjectPath}
                  compact={editorCompact}
                  showThinking={showThinkingBlocks}
                  showReasoningSummaries={showReasoningSummaries}
                  showToolDetails={showToolDetails}
                  shellToolPartsExpanded={shellToolPartsExpanded}
                  editToolPartsExpanded={editToolPartsExpanded}
                  showGenericToolOutput={showGenericToolOutput}
                  concealCodeBlocks={concealCodeBlocks}
                />
              </ErrorBoundary>
            )}
          </>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}

function scrollChatMessageTarget(
  scope: HTMLElement,
  target: string | undefined
): void {
  if (isChatTranscriptStepScrollTarget(target)) {
    scrollChatTranscriptBy(scope, target)
    return
  }

  const nodes = Array.from(
    scope.querySelectorAll<HTMLElement>("[data-betterc0de-chat-message]")
  )
  if (nodes.length === 0) return

  const targetNode = resolveChatMessageScrollNode(nodes, target)
  targetNode?.scrollIntoView({ behavior: "smooth", block: "center" })
}

function resolveChatMessageScrollNode(
  nodes: readonly HTMLElement[],
  target: string | undefined
): HTMLElement | null {
  if (target === "first") return nodes[0] ?? null
  if (target === "last") return nodes.at(-1) ?? null
  if (target === "last-user") {
    return (
      [...nodes]
        .reverse()
        .find((node) => node.dataset.chatMessageRole === "user") ?? null
    )
  }

  const currentIndex = nearestVisibleChatMessageIndex(nodes)
  if (target === "next") {
    return nodes[Math.min(currentIndex + 1, nodes.length - 1)] ?? null
  }
  if (target === "previous") {
    return nodes[Math.max(currentIndex - 1, 0)] ?? null
  }
  return null
}

type ChatTranscriptStepScrollTarget =
  | "page-up"
  | "page-down"
  | "half-page-up"
  | "half-page-down"
  | "line-up"
  | "line-down"

function isChatTranscriptStepScrollTarget(
  target: string | undefined
): target is ChatTranscriptStepScrollTarget {
  return (
    target === "page-up" ||
    target === "page-down" ||
    target === "half-page-up" ||
    target === "half-page-down" ||
    target === "line-up" ||
    target === "line-down"
  )
}

function scrollChatTranscriptBy(
  scope: HTMLElement,
  target: ChatTranscriptStepScrollTarget
): void {
  const container = findChatTranscriptScrollContainer(scope)
  const direction = target.endsWith("up") ? -1 : 1
  const viewportHeight =
    container?.clientHeight || window.innerHeight || document.body.clientHeight
  const amount = target.startsWith("page")
    ? Math.max(320, viewportHeight * 0.82)
    : target.startsWith("half-page")
      ? Math.max(160, viewportHeight * 0.41)
      : 56
  const top = direction * amount

  if (container) {
    container.scrollBy({ top, behavior: "smooth" })
  }
}

function findChatTranscriptScrollContainer(
  scope: HTMLElement
): HTMLElement | null {
  const content = scope.querySelector<HTMLElement>(
    "[data-betterc0de-chat-transcript-content]"
  )
  let node = content?.parentElement ?? null
  while (node && scope.contains(node)) {
    if (node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return scope.scrollHeight > scope.clientHeight ? scope : null
}

function nearestVisibleChatMessageIndex(nodes: readonly HTMLElement[]): number {
  const viewportCenter = window.innerHeight / 2
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  nodes.forEach((node, index) => {
    const rect = node.getBoundingClientRect()
    const center = rect.top + rect.height / 2
    const distance = Math.abs(center - viewportCenter)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  })
  return bestIndex
}

// Re-export for existing importers/tests; the implementation lives in the
// shared lib so the attention system uses the same pairing rules.
export { derivePendingApprovals, type PendingApproval }

export type ActivityWorkEntry = {
  id: string
  label: string
  detail?: string
  providerKind?: string
  providerInstanceId?: string
  providerLabel?: string
  kind: string
  tone: "thinking" | "tool" | "info" | "approval" | "error"
  createdAt: string
  sessionId?: string
  taskId?: string
  parentTaskId?: string
  agentId?: string
  parentAgentId?: string
  parentToolId?: string
}

type TranscriptTimelineEntry =
  | ProviderHandoffEntry
  | {
      kind: "message"
      id: string
      createdAt: string
      msg: ChatMessage
      idx: number
      /** The plan card is already rendered by a `proposed-plan` entry. */
      hidePlanCard: boolean
      tools: ActivityTool[]
      work: ActivityWorkEntry[]
    }
  | {
      kind: "proposed-plan"
      id: string
      createdAt: string
      turnId?: string | null
      content: string
      /** A `plan_approval` request for this plan is still open. */
      awaitingApproval: boolean
      sourceProposedPlan: SourceProposedPlanReference
      implemented: boolean
      implementedAt?: string | null
      implementationThreadId?: string | null
      tools: ActivityTool[]
      work: ActivityWorkEntry[]
    }
  | {
      kind: "model-switch"
      id: string
      createdAt: string
      from: string
      to: string
    }

export function deriveTranscriptTimeline(
  messages: ChatMessage[],
  activities: ThreadActivity[],
  options: {
    showSessionProgressBar?: boolean
    isStreaming?: boolean
    hasProviderOutput?: boolean
  } = {}
) {
  const toolsByTurn = new Map<string, ActivityTool[]>()
  for (const [turnId, turnActivities] of groupToolActivitiesByTurn(
    activities
  )) {
    toolsByTurn.set(turnId, buildActivityTools(turnActivities))
  }
  const workByTurn = groupWorkActivitiesByTurn(activities, options)
  const implementedPlans = new Map<
    string,
    { implementedAt?: string | null; implementationThreadId?: string | null }
  >()
  for (const activity of activities) {
    if (activity.kind !== "turn.proposed.implemented") continue
    const payload = asRecord(activity.payload)
    const source = sourceProposedPlanFromPayload(payload)
    if (!source) continue
    implementedPlans.set(sourceProposedPlanKey(source), {
      implementedAt:
        stringFrom(payload.implementedAt) ?? stringFrom(payload.implemented_at),
      implementationThreadId:
        stringFrom(payload.implementationThreadId) ??
        stringFrom(payload.implementation_thread_id),
    })
  }
  // Plans whose approval request is still open. Derived here rather than
  // passed in so this function stays pure over (messages, activities).
  const pendingApprovalTurnIds = new Set<string>()
  const pendingApprovalFingerprints = new Set<string>()
  for (const approval of derivePendingPlanApprovals(activities)) {
    if (approval.turnId) pendingApprovalTurnIds.add(approval.turnId)
    const fingerprint = planFingerprint(approval.planMarkdown)
    if (fingerprint) pendingApprovalFingerprints.add(fingerprint)
  }
  const proposedPlanEntries: TranscriptTimelineEntry[] = activities
    .filter((activity) => activity.kind === "turn.proposed.completed")
    .map((activity) => {
      const payload = asRecord(activity.payload)
      const content =
        stringFrom(payload.planMarkdown) ??
        stringFrom(payload.plan_markdown) ??
        stringFrom(payload.detail) ??
        ""
      const turnId = activity.turnId
      const sourceProposedPlan = {
        threadId: activity.threadId,
        planId:
          stringFrom(payload.planId) ??
          stringFrom(payload.plan_id) ??
          activity.id,
      }
      const implementation = implementedPlans.get(
        sourceProposedPlanKey(sourceProposedPlan)
      )
      return {
        kind: "proposed-plan",
        id: activity.id,
        createdAt: activity.createdAt,
        turnId,
        content,
        awaitingApproval:
          (turnId ? pendingApprovalTurnIds.has(turnId) : false) ||
          pendingApprovalFingerprints.has(planFingerprint(content)),
        sourceProposedPlan,
        implemented: Boolean(implementation),
        implementedAt: implementation?.implementedAt ?? null,
        implementationThreadId: implementation?.implementationThreadId ?? null,
        tools: turnId ? (toolsByTurn.get(turnId) ?? []) : [],
        work: turnId ? (workByTurn.get(turnId) ?? []) : [],
      } satisfies TranscriptTimelineEntry
    })
    .filter((entry) => entry.content.trim())

  // Index the plans that already have a card, so a plan-only assistant message
  // in the same turn doesn't render a second one. ExitPlanMode raises the
  // activity, and the model's preamble makes the streamed plan text finalize
  // into a message at the approval boundary — same plan, two ingestion paths.
  const proposedPlanTurnIds = new Set<string>()
  const proposedPlanFingerprints = new Set<string>()
  for (const entry of proposedPlanEntries) {
    if (entry.kind !== "proposed-plan") continue
    if (entry.turnId) proposedPlanTurnIds.add(entry.turnId)
    const fingerprint = planFingerprint(entry.content)
    if (fingerprint) proposedPlanFingerprints.add(fingerprint)
  }

  const hiddenMessageIds = providerHandoffMessageIds(messages)
  const messageEntries: TranscriptTimelineEntry[] = messages.map((msg, idx) => {
    // Fail open: the model writes the plan twice (streamed, then as the
    // ExitPlanMode argument), so byte equality isn't guaranteed. A duplicate
    // card beats a vanished plan.
    const hidePlanCard =
      msg.role === "assistant" &&
      isStructuredPlanMarkdown(msg.content) &&
      ((msg.turnId ? proposedPlanTurnIds.has(msg.turnId) : false) ||
        proposedPlanFingerprints.has(planFingerprint(msg.content)))
    return {
      kind: "message",
      id: msg.id,
      createdAt: msg.createdAt,
      msg,
      idx,
      hidePlanCard,
      // A suppressed plan message surrenders the turn's tool group to the
      // proposed-plan entry, which sorts first (the ExitPlanMode activity
      // predates the message finalized at the approval boundary).
      tools:
        msg.role === "assistant" && msg.turnId && !hidePlanCard
          ? (toolsByTurn.get(msg.turnId) ?? [])
          : [],
      work:
        msg.role === "assistant" && msg.turnId && !hidePlanCard
          ? (workByTurn.get(msg.turnId) ?? [])
          : [],
    }
  })
  const visibleMessageEntries = messageEntries.filter(
    (entry) => !hiddenMessageIds.has(entry.id)
  )
  const modelSwitchEntries: TranscriptTimelineEntry[] = activities.flatMap(
    (activity) => {
      if (activity.kind !== "session.model.switched") return []
      const payload = asRecord(activity.payload)
      const from =
        stringFrom(payload.fromModelId) ?? stringFrom(payload.from_model_id)
      const to =
        stringFrom(payload.toModelId) ?? stringFrom(payload.to_model_id)
      if (!from || !to || from === to) return []
      return [
        {
          kind: "model-switch",
          id: activity.id,
          createdAt: activity.createdAt,
          from,
          to,
        },
      ]
    }
  )

  const timeline = [
    ...visibleMessageEntries,
    ...deriveProviderHandoffs(
      messages,
      activities,
      options.isStreaming === true,
      options.hasProviderOutput === true
    ),
    ...proposedPlanEntries,
    ...modelSwitchEntries,
  ].sort((a, b) => {
    const created = a.createdAt.localeCompare(b.createdAt)
    if (created !== 0) return created
    if (a.kind === "message" && b.kind === "message") return a.idx - b.idx
    const kindOrder = {
      "model-switch": 0,
      message: 1,
      "context-handoff": 2,
      "proposed-plan": 3,
    }
    if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind]
    return a.id.localeCompare(b.id)
  })
  return placeModelSwitchesAtTurnBoundaries(
    timeline,
    options.isStreaming === true
  )
}

/** A switch belongs before the user's turn, never between its status and answer. */
function placeModelSwitchesAtTurnBoundaries(
  timeline: TranscriptTimelineEntry[],
  isStreaming: boolean
): TranscriptTimelineEntry[] {
  type SwitchEntry = Extract<TranscriptTimelineEntry, { kind: "model-switch" }>
  type MessageEntry = Extract<TranscriptTimelineEntry, { kind: "message" }>
  const turns: {
    user: MessageEntry
    firstAnswer?: MessageEntry
    modelId?: string
  }[] = []
  for (const entry of timeline) {
    if (entry.kind !== "message" || entry.msg.compactedContext) continue
    if (entry.msg.role === "user") {
      turns.push({ user: entry, modelId: entry.msg.modelId })
    } else if (entry.msg.role === "assistant") {
      const turn = turns.at(-1)
      if (turn && !turn.firstAnswer) {
        turn.firstAnswer = entry
        turn.modelId ??= entry.msg.modelId
      }
    }
  }

  const beforeTurn = new Map<string, SwitchEntry[]>()
  const trailing: SwitchEntry[] = []
  for (const entry of timeline) {
    if (entry.kind !== "model-switch") continue
    // A delayed event can arrive after the optimistic user message. Only
    // attach it backwards when the message already names its target model.
    const current = turns.findLast(
      (turn) => turn.user.createdAt <= entry.createdAt
    )
    const target =
      current?.modelId === entry.to &&
      (!current.firstAnswer || entry.createdAt <= current.firstAnswer.createdAt)
        ? current
        : turns.find((turn) => turn.user.createdAt > entry.createdAt)
    if (!target) {
      trailing.push(entry)
      continue
    }
    const switches = beforeTurn.get(target.user.id) ?? []
    if (
      !switches.some(
        (switchEntry) =>
          switchEntry.from === entry.from && switchEntry.to === entry.to
      )
    ) {
      switches.push(entry)
    }
    beforeTurn.set(target.user.id, switches)
  }

  const turnsById = new Map(turns.map((turn) => [turn.user.id, turn]))
  const result: TranscriptTimelineEntry[] = []
  let lastModelId: string | undefined
  for (const entry of timeline) {
    if (entry.kind === "model-switch") continue
    if (entry.kind === "message" && !entry.msg.compactedContext) {
      if (entry.msg.role === "user") {
        const switches = beforeTurn.get(entry.id) ?? []
        result.push(...switches)
        const modelId = turnsById.get(entry.id)?.modelId
        if (
          lastModelId &&
          modelId &&
          modelId !== lastModelId &&
          !switches.some((notice) => notice.to === modelId)
        ) {
          result.push({
            kind: "model-switch",
            id: `model-switch:${entry.id}`,
            createdAt: entry.createdAt,
            from: lastModelId,
            to: modelId,
          })
        }
        lastModelId = modelId ?? switches.at(-1)?.to ?? lastModelId
      } else if (entry.msg.role === "assistant") {
        lastModelId = entry.msg.modelId ?? lastModelId
      }
    }
    result.push(entry)
  }
  // The streaming answer renders after this timeline. A selection for the
  // next turn must not interrupt the response that is still being written.
  return isStreaming ? result : [...result, ...trailing]
}

function sourceProposedPlanKey(source: SourceProposedPlanReference): string {
  return `${source.threadId}::${source.planId}`
}

/**
 * Normalized plan text, used to match the same plan across its two ingestion
 * paths (the `turn.proposed.completed` activity and the assistant message the
 * approval boundary finalizes). `stripProposedPlanWrapper` — not
 * `unwrapPlanContent` — because it drops the model's preamble and tolerates an
 * unclosed `<proposed_plan>` tag, which is exactly the shape that produces the
 * duplicate in the first place.
 */
function planFingerprint(text: string): string {
  return stripProposedPlanWrapper(text)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
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

function groupWorkActivitiesByTurn(
  activities: ThreadActivity[],
  options: { showSessionProgressBar?: boolean } = {}
) {
  const showSessionProgressBar = options.showSessionProgressBar !== false
  const groups = new Map<string, ActivityWorkEntry[]>()
  for (const activity of [...activities].sort(compareActivities)) {
    if (!activity.turnId) continue
    const entry = deriveActivityWorkEntry(activity)
    if (!entry) continue
    if (!showSessionProgressBar && entry.kind === "task.progress") continue
    const existing = groups.get(activity.turnId) ?? []
    existing.push(entry)
    groups.set(activity.turnId, existing)
  }
  return groups
}

export function deriveActivityWorkEntry(
  activity: ThreadActivity
): ActivityWorkEntry | null {
  const payload = asRecord(activity.payload)
  const providerFields = workEntryProviderFields(activity, payload)
  const correlationFields = activityCorrelationFields(payload)
  if (
    activity.kind === "tool.started" ||
    activity.kind === "tool.updated" ||
    activity.kind === "tool.completed" ||
    activity.kind === "tool.failed"
  ) {
    return null
  }
  if (activity.kind === "task.started" || activity.kind === "task.progress") {
    const label =
      stringFrom(payload.summary) ??
      stringFrom(payload.detail) ??
      activity.summary
    return {
      id: activity.id,
      label,
      detail: stringFrom(payload.lastToolName)
        ? `Last tool: ${stringFrom(payload.lastToolName)}`
        : undefined,
      ...providerFields,
      ...correlationFields,
      kind: activity.kind,
      tone: activity.tone,
      createdAt: activity.createdAt,
    }
  }
  if (activity.kind === "task.completed") {
    return {
      id: activity.id,
      label: stringFrom(payload.detail) ?? activity.summary,
      detail: stringFrom(payload.status),
      ...providerFields,
      ...correlationFields,
      kind: activity.kind,
      tone: activity.tone,
      createdAt: activity.createdAt,
    }
  }
  if (
    activity.kind === "tool.summary" ||
    activity.kind === "tool.denied" ||
    activity.kind.startsWith("hook.") ||
    activity.kind === "auth.status" ||
    activity.kind === "mcp.oauth.completed" ||
    activity.kind === "model.rerouted" ||
    activity.kind === "config.warning" ||
    activity.kind === "deprecation.notice" ||
    activity.kind === "files.persisted" ||
    activity.kind === "context-compaction" ||
    activity.kind === "turn.plan.updated" ||
    activity.kind === "turn.diff.updated" ||
    activity.kind === "runtime.warning" ||
    activity.kind === "runtime.error"
  ) {
    const label =
      stringFrom(payload.summary) ??
      stringFrom(payload.message) ??
      activity.summary
    const detail =
      stringFrom(payload.detail) ??
      stringFrom(payload.reason) ??
      stringFrom(payload.path) ??
      stringFrom(payload.status) ??
      stringFrom(payload.outcome)
    return {
      id: activity.id,
      label,
      detail: detail && detail !== label ? detail : undefined,
      ...(activity.kind === "runtime.error"
        ? runtimeFailurePresentation(payload)
        : {}),
      ...providerFields,
      ...correlationFields,
      kind: activity.kind,
      tone: activity.tone,
      createdAt: activity.createdAt,
    }
  }
  return null
}

function PendingApprovalRow({
  threadId,
  approval,
}: {
  threadId: string
  approval: PendingApproval
}) {
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null)
  const [denyMessageOpen, setDenyMessageOpen] = useState(false)
  const [denyMessage, setDenyMessage] = useState("")
  const isReadOnly =
    usePreferencesStore((state) => state.permissionLevel) === "read-only"
  // See the modal: `null` means no safely-rememberable scope for this call.
  // These are the exact rules that will be persisted — the label below renders
  // the same array that `buildAlwaysAllowUpdate` sends, so the menu can never
  // advertise a narrower scope than the one actually written.
  const alwaysAllowScopeRules = alwaysAllowRules(approval)
  const alwaysAllowScope = alwaysAllowScopeRules
    ? describeAlwaysAllowRules(alwaysAllowScopeRules)
    : null
  const label = approval.toolName ?? approval.requestKind ?? "tool action"
  const providerLabel = formatProviderActivityLabel(approval, "Provider")

  const submit = async (
    decision: "approve" | "deny",
    options?: Parameters<typeof submitApprovalDecision>[3]
  ) => {
    if (submitting) return
    setSubmitting(decision)
    try {
      await submitApprovalDecision(threadId, approval, decision, options)
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-3">
        <ShieldAlertIcon className="size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">Approval required</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {providerLabel} wants to run {label}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={submitting !== null}
          onClick={() => {
            if (denyMessageOpen) {
              void submit("deny", { message: denyMessage.trim() || undefined })
            } else {
              void submit("deny")
            }
          }}
        >
          <XIcon className="size-3.5" />
          Deny
        </Button>
        {!approval.pluginId && !isReadOnly && alwaysAllowScope ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={submitting !== null}
              >
                Always allow
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {ALWAYS_ALLOW_DESTINATIONS.map((destination) => (
                <DropdownMenuItem
                  key={destination.id}
                  onClick={() => {
                    const update = buildAlwaysAllowUpdate(
                      approval,
                      destination.id
                    )
                    void submit("approve", {
                      updatedPermissions: update ? [update] : undefined,
                    })
                  }}
                >
                  <span className="flex flex-col items-start">
                    <span>{destination.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {alwaysAllowScope}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={submitting !== null}
          onClick={() => void submit("approve")}
        >
          <CheckIcon className="size-3.5" />
          Approve
        </Button>
      </div>
      <ApprovalRequestContext approval={approval} compact />
      {!approval.pluginId ? (
        denyMessageOpen ? (
          <Textarea
            value={denyMessage}
            onChange={(event) => setDenyMessage(event.target.value)}
            placeholder="Tell Claude why this was denied (optional) — then click Deny"
            className="min-h-12 text-xs"
          />
        ) : (
          <button
            type="button"
            className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setDenyMessageOpen(true)}
          >
            Deny with message…
          </button>
        )
      ) : null}
    </div>
  )
}

function workEntryProviderFields(
  activity: ThreadActivity,
  payload: Record<string, unknown>
): Pick<
  ActivityWorkEntry,
  "providerKind" | "providerInstanceId" | "providerLabel"
> {
  const providerKind = providerKindFromActivityPayload(payload)
  const providerInstanceId = providerInstanceIdFromActivityPayload(
    activity,
    payload
  )
  const providerLabel =
    providerKind || providerInstanceId
      ? formatProviderActivityLabel({ providerKind, providerInstanceId })
      : undefined
  return {
    ...(providerKind ? { providerKind } : {}),
    ...(providerInstanceId ? { providerInstanceId } : {}),
    ...(providerLabel ? { providerLabel } : {}),
  }
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Subtle centered divider row announcing a mid-chat model change
 * (Codex-style: "◇ Model switched from X to Y").
 */
export function ModelSwitchNotice({ from, to }: { from: string; to: string }) {
  const fromInfo = getModelInfo(from)
  const toInfo = getModelInfo(to)
  const fromName = fromInfo?.name || from
  const toName = toInfo?.name || to
  // The row announces which model takes over, so it carries that model's mark.
  // Falls back to the generic cube for an unknown id, which `getModelInfo`
  // reports with an empty logo rather than null.
  const toLogo = toInfo?.logo || ""
  return (
    <div
      className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground/70"
      title="The model changed for the following turn."
    >
      <span className="h-px min-w-6 flex-1 bg-border/45" aria-hidden="true" />
      <span className="flex shrink-0 items-center gap-1.5">
        {toLogo ? (
          <img
            src={toLogo}
            alt=""
            className={cn(
              "size-3.5 shrink-0 object-contain",
              logoNeedsDarkInvert(toLogo) && "dark:invert"
            )}
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = "none"
            }}
          />
        ) : (
          <HugeiconsIcon
            icon={CubeIcon}
            strokeWidth={1.75}
            className="size-3.5"
          />
        )}
        <span>
          Model switched from {fromName} to {toName}.
        </span>
      </span>
      <span className="h-px min-w-6 flex-1 bg-border/45" aria-hidden="true" />
    </div>
  )
}
