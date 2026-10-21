import { memo, useMemo } from "react"
import { CheckIcon } from "lucide-react"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning"
import { ChatFileChanges } from "@/components/chat/chat-file-changes"
import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue"
import { AgentActivity } from "@/components/ai-elements/agent-activity"
import type { ReasoningSegment } from "@/lib/chat/types"
import { PlanImplementationCard } from "@/components/chat/plan-implementation-card"
import type { SetPlanModalContent } from "@/lib/plan-modal"
import { ToolCallGroup } from "@/components/chat/tool-call-group"
import { buildReasoningSummary } from "@/lib/reasoning-summary"
import { combineStreamingReasoning } from "@/lib/streaming-reasoning"

type StreamingTool = {
  id: string
  name: string
  input: unknown
  output?: unknown
  state?: string
  providerKind?: string
  providerInstanceId?: string
  sessionId?: string
  taskId?: string
  parentTaskId?: string
  agentId?: string
  parentAgentId?: string
  parentToolId?: string
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
 * The assistant "bubble" shown while a streaming turn is in progress.
 *
 * Layers (shown top-to-bottom as they become available):
 *  - Model/time metadata belongs to the turn header above the user message.
 *  - One reasoning disclosure for the turn, followed by the tool timeline.
 *  - Streaming body — one of three views based on content:
 *      * If we're in plan mode and the partial text already parses as a
 *        structured plan, render a clickable "Generating plan..." card
 *        that opens the live preview.
 *      * Otherwise, if we have streaming text, render any file diff cards
 *        and task queue above the prose.
 *      * Before content arrives, show a quiet animated activity pill.
 */
function StreamingMessageInner({
  streamingText,
  streamingPlanText,
  streamingTools,
  streamingDiffs,
  streamingTasks,
  reasoningText,
  reasoningSegments = [],
  isReasoning,
  isPlanStreaming,
  shimmerPhase,
  onOpenPlanModal,
  workspaceRoot,
  compact = false,
  showThinking = true,
  showReasoningSummaries = false,
  showToolDetails = false,
  shellToolPartsExpanded = false,
  editToolPartsExpanded = false,
  showGenericToolOutput = false,
  concealCodeBlocks = false,
}: {
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
  onOpenPlanModal: SetPlanModalContent
  workspaceRoot?: string | null
  compact?: boolean
  showThinking?: boolean
  showReasoningSummaries?: boolean
  showToolDetails?: boolean
  shellToolPartsExpanded?: boolean
  editToolPartsExpanded?: boolean
  showGenericToolOutput?: boolean
  concealCodeBlocks?: boolean
}) {
  const reasoning = useMemo(
    () => combineStreamingReasoning(reasoningSegments, reasoningText),
    [reasoningSegments, reasoningText]
  )
  return (
    <Message from="assistant">
      <MessageContent
        className={
          compact
            ? "text-[length:calc(var(--message-font-size)_-_1px)]"
            : undefined
        }
      >
        {showThinking && (reasoning.text || isReasoning) && (
          <Reasoning
            data-slot="turn-reasoning"
            isStreaming={isReasoning}
            duration={reasoning.durationSeconds}
            defaultOpen={false}
          >
            <ReasoningTrigger
              getThinkingMessage={
                showReasoningSummaries && reasoning.text
                  ? () => (
                      <span>
                        {buildReasoningSummary(reasoning.text) ?? "Thought"}
                      </span>
                    )
                  : undefined
              }
            />
            <ReasoningContent>{reasoning.text}</ReasoningContent>
          </Reasoning>
        )}

        {streamingTools.length > 0 && (
          <ToolCallGroup
            tools={streamingTools}
            streaming
            defaultOpen={showToolDetails}
            shellToolPartsExpanded={shellToolPartsExpanded}
            editToolPartsExpanded={editToolPartsExpanded}
            showGenericOutput={showGenericToolOutput}
            workspaceRoot={workspaceRoot}
          />
        )}

        {/* Streaming text / Plan / Activity */}
        {isPlanStreaming || streamingPlanText ? (
          <PlanImplementationCard
            content={streamingPlanText || streamingText}
            onOpenPlanModal={onOpenPlanModal}
            streaming
            workspaceRoot={workspaceRoot}
          />
        ) : streamingText ? (
          <>
            {streamingDiffs.length > 0 && (
              <ChatFileChanges
                diffs={streamingDiffs}
                workspaceRoot={workspaceRoot}
              />
            )}
            {streamingTasks.length > 0 && (
              <Queue className="mb-3">
                <QueueSection>
                  <QueueSectionTrigger>
                    <QueueSectionLabel
                      label={
                        streamingTasks.every((t) => t.completed)
                          ? "completed"
                          : "in progress"
                      }
                      count={streamingTasks.length}
                      icon={<CheckIcon className="size-3.5" />}
                    />
                  </QueueSectionTrigger>
                  <QueueSectionContent>
                    <QueueList>
                      {streamingTasks.map((task, i) => (
                        <QueueItem key={i}>
                          <div className="flex items-center gap-2.5">
                            <QueueItemIndicator completed={task.completed} />
                            <QueueItemContent completed={task.completed}>
                              {task.text}
                            </QueueItemContent>
                          </div>
                        </QueueItem>
                      ))}
                    </QueueList>
                  </QueueSectionContent>
                </QueueSection>
              </Queue>
            )}
            {/* Not `isAnimating`: the answer should land as text, not
                type itself out. The per-token fade made a finished reply feel
                slower than it was and fought with the shimmer above it. */}
            <MessageResponse
              concealCodeBlocks={concealCodeBlocks}
              workspaceRoot={workspaceRoot}
              streaming
            >
              {streamingText}
            </MessageResponse>
          </>
        ) : !reasoning.text && !isReasoning && streamingTools.length === 0 ? (
          <AgentActivity
            state="breathing"
            label={shimmerPhase >= 2 ? "Still working..." : "Thinking..."}
          />
        ) : null}
      </MessageContent>
    </Message>
  )
}

// [PERF] Memoized so unrelated parent re-renders (e.g. sidebar resize, theme
// toggle) don't redundantly re-render the streaming body. The props that
// actually change per token — streamingText, streamingTools, etc. — still
// trigger a re-render via shallow equality, which is exactly what we want.
export const StreamingMessage = memo(StreamingMessageInner)
