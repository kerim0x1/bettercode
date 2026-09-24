import {
  CHECKPOINT_RESTORE_BODY,
  CHECKPOINT_RESTORE_TITLE,
} from "@betterc0de/schema/chat-controls"
import { copyText } from "@/lib/clipboard"
import React from "react"
import { ClockIcon, CopyIcon, RefreshCwIcon, UndoIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { MessageAttachments } from "@/components/chat/message-attachments"
import { readBrowserElementAttachment } from "@betterc0de/schema"
import { browserMentionRanges } from "@/lib/browser-element-mentions"
import { BrowserElementMessage } from "./browser-element-message"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  MessageToolbar,
} from "@/components/ai-elements/message"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning"
import { ChatFileChanges } from "@/components/chat/chat-file-changes"
import {
  Checkpoint,
  CheckpointIcon,
  CheckpointTrigger,
} from "@/components/ai-elements/checkpoint"
import { formatTime } from "@/lib/format"
import { getModelInfo } from "@/lib/get-model-info"
import { logoNeedsDarkInvert } from "@/lib/logo-invert"
import { classifyTask, getCategoryLabel } from "@/lib/task-classifier"
import { turnDurationMs } from "@/lib/turn-duration"
import { previousVisibleUserMessage } from "@/lib/chat-context"
import {
  isStructuredPlanMarkdown,
  parseInlineEditMessage,
  stripQuestionLines,
} from "@/lib/message-utils"
import { useChatStore, type ChatMessage } from "@/lib/chat-store"
import {
  useCheckpointStore,
  type Checkpoint as StoredCheckpoint,
} from "@/lib/checkpoint-store"
import {
  revertThreadCheckpoint,
  rollbackProviderConversation,
  truncateThreadMessages,
} from "@/services/backend"
import {
  ToolCallGroup,
  type ToolCallGroupWorkEntry,
} from "@/components/chat/tool-call-group"
import { InlineEditMessageCard } from "@/components/chat/inline-edit-message-card"
import { AnsweredQuestionsSummary } from "@/components/chat/answered-questions-summary"
import { PlanImplementationCard } from "@/components/chat/plan-implementation-card"
import type { ConfirmAction } from "@/components/dialogs/confirm-action-dialog"
import type { ProviderSkill } from "@betterc0de/schema"
import type { SetPlanModalContent } from "@/lib/plan-modal"
import { buildReasoningSummary } from "@/lib/reasoning-summary"
import {
  formatDuration,
  type ToolCallData,
} from "@/components/chat/tool-call-item"
import { handleError } from "@/lib/errors"

function countAssistantTurnsAfter(
  messages: readonly ChatMessage[],
  index: number
): number {
  return messages
    .slice(index + 1)
    .filter((message) => message.role === "assistant").length
}

function latestCheckpointTurnNumber(
  checkpoints: readonly StoredCheckpoint[]
): number | null {
  const values = checkpoints
    .map((checkpoint) => checkpoint.turnNumber)
    .filter((value): value is number => typeof value === "number")
  return values.length > 0 ? Math.max(...values) : null
}

async function rollbackProviderConversationAfter(
  threadId: string | null,
  messages: readonly ChatMessage[],
  index: number,
  checkpoints: readonly StoredCheckpoint[] = [],
  targetTurnNumber?: number
): Promise<void> {
  if (!threadId) return
  const latestTurnNumber = latestCheckpointTurnNumber(checkpoints)
  const numTurns =
    typeof targetTurnNumber === "number" && latestTurnNumber !== null
      ? Math.max(0, latestTurnNumber - targetTurnNumber)
      : countAssistantTurnsAfter(messages, index)
  if (numTurns <= 0) return

  const thread = useChatStore
    .getState()
    .threads.find((candidate) => candidate.id === threadId)
  const result = await rollbackProviderConversation(threadId, numTurns, {
    providerKind: thread?.session?.providerKind ?? null,
    providerInstanceId: thread?.session?.providerInstanceId ?? null,
  })
  if (!result.rolledBack) {
    throw new Error("Provider conversation could not be rolled back.")
  }
}

async function persistThreadTruncation(
  threadId: string | null,
  messageId: string
): Promise<void> {
  if (!threadId) return
  await truncateThreadMessages(threadId, messageId)
}

function replaceThreadMessages(
  threadId: string | null,
  messages: readonly ChatMessage[]
): void {
  if (!threadId) return
  const keep = [...messages]
  useChatStore.setState((s) => ({
    threads: s.threads.map((t) =>
      t.id === threadId
        ? {
            ...t,
            messages: keep,
            messageCount: keep.length,
            updatedAt: new Date().toISOString(),
          }
        : t
    ),
  }))
}

function pruneCheckpointsAfter(
  threadId: string | null,
  messages: readonly ChatMessage[],
  index: number,
  targetTurnNumber?: number
): void {
  if (!threadId) return
  const deletedMessageIds = messages
    .slice(index + 1)
    .map((message) => message.id)
  useCheckpointStore.getState().deleteCheckpointsAfter(threadId, {
    messageIds: deletedMessageIds,
    turnNumber: targetTurnNumber,
  })
}

/**
 * Single chat message in the conversation transcript — renders the whole
 * vertical stack for one `msg` in a fixed turn anatomy so every exchange
 * reads the same top-to-bottom:
 *
 *   user:      meta (model · time · task badge) → bubble
 *   assistant: thinking → tool steps → diffs → body
 *              → hover toolbar (copy / retry / revert · duration)
 *
 * The turn is headed by exactly one meta row, above the user bubble, carrying
 * the model that answers it — the assistant block has no meta row of its own
 * (mid-chat model changes surface via ModelSwitchNotice).
 * Activity-derived tool calls (`activityTools`/`activityWork`, supplied by
 * chat-transcript) render inside the assistant block after the thinking row,
 * matching the streaming twin's order, instead of floating above the
 * message. For assistant messages that aren't the last one, a quiet
 * checkpoint divider is appended below as the turn boundary.
 *
 * State access:
 *  - `msg` + derived state comes in by prop (pure render).
 *  - The retry / revert / restore-checkpoint callbacks need thread context
 *    (active thread, all messages, message index) — those are threaded
 *    through as props rather than reading the store again, so the item
 *    stays a dumb renderer.
 *  - Store writes for revert/restore go through `useChatStore.setState`
 *    directly; those are conceptually global ops, not per-pane.
 *
 * [PERF] Exported via `React.memo` with a custom comparator so streaming
 * deltas on a fresh assistant message don't cause the entire history to
 * re-render. The comparator intentionally ignores `messages` reference
 * changes — handler closures read the array at click-time, which is also
 * the point at which retry/revert want the freshest slice.
 */
function ChatMessageItemInner({
  msg,
  idx,
  messages,
  activeThreadId,
  onRetry,
  onOpenConfirm,
  onOpenPlanModal,
  providerSkills = [],
  workspaceRoot,
  activityTools = [],
  activityWork = [],
  hideToolCalls = false,
  hidePlanCard = false,
  compact = false,
  showTimestamp = true,
  showThinking = true,
  showReasoningSummaries = false,
  showToolDetails = false,
  shellToolPartsExpanded = false,
  editToolPartsExpanded = false,
  showGenericToolOutput = false,
  concealCodeBlocks = false,
}: {
  msg: ChatMessage
  idx: number
  messages: ChatMessage[]
  activeThreadId: string | null
  onRetry: (content: string) => void
  onOpenConfirm: (action: ConfirmAction) => void
  onOpenPlanModal: SetPlanModalContent
  providerSkills?: ReadonlyArray<Pick<ProviderSkill, "name" | "displayName">>
  providerInstanceId?: string | null
  workspaceRoot?: string | null
  activityTools?: ToolCallData[]
  activityWork?: ToolCallGroupWorkEntry[]
  hideToolCalls?: boolean
  /** A `proposed-plan` timeline entry already renders this plan's card. */
  hidePlanCard?: boolean
  compact?: boolean
  showTimestamp?: boolean
  showThinking?: boolean
  showReasoningSummaries?: boolean
  showToolDetails?: boolean
  shellToolPartsExpanded?: boolean
  editToolPartsExpanded?: boolean
  showGenericToolOutput?: boolean
  concealCodeBlocks?: boolean
}) {
  // One meta header per turn, sitting ABOVE the user bubble: model · time ·
  // task badge. The assistant block renders no meta row of its own — its
  // machinery starts directly with thinking/steps, and mid-chat model
  // changes are announced by the ModelSwitchNotice divider instead.
  const modelInfo = msg.role === "user" ? getModelInfo(msg.modelId) : null
  const browserElements = (msg.attachments ?? []).flatMap((attachment) => {
    const element = readBrowserElementAttachment(attachment)
    return element ? [element] : []
  })
  const visibleAttachments = msg.attachments?.filter((attachment) => {
    const element = readBrowserElementAttachment(attachment)
    return !element || !browserMentionRanges(msg.content, [element]).length
  })
  const taskCategory =
    msg.role === "user" && msg.content.length > 10
      ? classifyTask(msg.content)
      : null
  const showTaskCategory =
    Boolean(taskCategory) &&
    taskCategory!.category !== "general" &&
    taskCategory!.confidence >= 0.2
  const showMeta =
    msg.role === "user" &&
    (Boolean(modelInfo) || showTimestamp || showTaskCategory)
  // Prefer the activity-derived tool timeline (durations, provider badges,
  // work entries) over the persisted msg.toolCalls snapshot when both exist.
  const renderedTools = hideToolCalls
    ? []
    : activityTools.length > 0
      ? activityTools
      : (msg.toolCalls ?? [])
  const renderedWork = hideToolCalls ? [] : activityWork

  return (
    <React.Fragment>
      <Message from={msg.role as "user" | "assistant"}>
        {/* Timestamp + Model meta */}
        {showMeta && (
          <span className="inline-flex items-center gap-1 text-[10px] leading-none whitespace-nowrap text-muted-foreground/50">
            {modelInfo && (
              <>
                {modelInfo.logo ? (
                  <img
                    src={modelInfo.logo}
                    alt=""
                    className={cn(
                      "size-3",
                      logoNeedsDarkInvert(modelInfo.logo) && "dark:invert"
                    )}
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.display = "none"
                    }}
                  />
                ) : null}
                <span className="font-medium">{modelInfo.name}</span>
                {(showTimestamp || showTaskCategory) && (
                  <span className="text-muted-foreground/30">·</span>
                )}
              </>
            )}
            {showTimestamp && <span>{formatTime(msg.createdAt)}</span>}
            {showTaskCategory && taskCategory ? (
              <>
                {showTimestamp && (
                  <span className="text-muted-foreground/30">·</span>
                )}
                {/* Deliberately NOT `getCategoryColor` here. The meta line is
                    model · time · category; giving one of the three a
                    saturated hue made an automatic classification the loudest
                    thing above the user's own message. */}
                <span className="font-medium">
                  {getCategoryLabel(taskCategory.category)}
                </span>
              </>
            ) : null}
          </span>
        )}

        <MessageContent className={compact ? "text-xs" : undefined}>
          {visibleAttachments?.length ? (
            <MessageAttachments attachments={visibleAttachments} />
          ) : null}

          {msg.role === "assistant" && msg.transcriptTruncated ? (
            <div
              role="status"
              className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              This response exceeded the local transcript limit and was saved in
              truncated form.
            </div>
          ) : null}

          {msg.role === "assistant" && showThinking && msg.reasoning && (
            <Reasoning isStreaming={false} defaultOpen={false}>
              <ReasoningTrigger
                getThinkingMessage={() => {
                  // Prefer the persisted wall-clock thinking time; older
                  // messages (saved before the field existed) fall back to
                  // the vague "a few seconds" label.
                  const duration =
                    typeof msg.reasoningDurationMs === "number" &&
                    msg.reasoningDurationMs > 0
                      ? formatDuration(msg.reasoningDurationMs)
                      : null
                  const summary = showReasoningSummaries
                    ? buildReasoningSummary(msg.reasoning ?? "")
                    : null
                  const base =
                    summary ??
                    (duration
                      ? `Thought for ${duration}`
                      : "Thought for a few seconds")
                  return (
                    <span>
                      {base}
                      {summary && duration ? (
                        <span className="text-muted-foreground/60">
                          {" · "}
                          {duration}
                        </span>
                      ) : null}
                    </span>
                  )
                }}
              />
              <ReasoningContent>{msg.reasoning || ""}</ReasoningContent>
            </Reasoning>
          )}

          {msg.role === "assistant" &&
          (renderedTools.length > 0 || renderedWork.length > 0) ? (
            <ToolCallGroup
              tools={renderedTools}
              work={renderedWork}
              defaultOpen={showToolDetails}
              shellToolPartsExpanded={shellToolPartsExpanded}
              editToolPartsExpanded={editToolPartsExpanded}
              showGenericOutput={showGenericToolOutput}
              workspaceRoot={workspaceRoot}
              treeKey={`${activeThreadId ?? "thread"}:${msg.id}`}
            />
          ) : null}

          {msg.diffs && msg.diffs.length > 0 && (
            <ChatFileChanges diffs={msg.diffs} workspaceRoot={workspaceRoot} />
          )}

          {msg.role === "assistant" &&
          isStructuredPlanMarkdown(msg.content) ? null : msg.role ===
            "assistant" ? (
            <MessageResponse
              concealCodeBlocks={concealCodeBlocks}
              workspaceRoot={workspaceRoot}
            >
              {msg.questions?.length
                ? stripQuestionLines(msg.content, msg.questions)
                : msg.content}
            </MessageResponse>
          ) : msg.answeredQuestions?.length ? (
            <AnsweredQuestionsSummary questions={msg.answeredQuestions} />
          ) : (
            (() => {
              const inlineEdit = parseInlineEditMessage(msg.content)
              return inlineEdit ? (
                <InlineEditMessageCard
                  range={inlineEdit.range}
                  filePath={inlineEdit.filePath}
                  instruction={inlineEdit.instruction}
                />
              ) : (
                <BrowserElementMessage
                  content={msg.content}
                  elements={browserElements}
                  skills={providerSkills}
                />
              )
            })()
          )}
        </MessageContent>

        {msg.role === "assistant" &&
          !hidePlanCard &&
          isStructuredPlanMarkdown(msg.content) && (
            <PlanImplementationCard
              content={msg.content}
              onOpenPlanModal={onOpenPlanModal}
              workspaceRoot={workspaceRoot}
            />
          )}

        {/* The turn duration stays visible; only the actions fade in on hover.
            It used to live inside the hidden toolbar, so how long an answer
            took was only discoverable by hovering over it.

            It also has to come FIRST. `opacity-0` hides the actions but keeps
            their layout box, so with the duration after them it was indented by
            the width of buttons nobody could see. */}
        {msg.role === "assistant" && (
          <MessageToolbar className="mt-1 justify-start gap-2">
            {(() => {
              const ms = turnDurationMs(messages, idx)
              if (ms === null) return null
              return (
                <span
                  title="Total time for this turn"
                  className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground/60 tabular-nums"
                >
                  <ClockIcon className="size-3 shrink-0" aria-hidden="true" />
                  {formatDuration(ms)}
                </span>
              )
            })()}
            <MessageActions className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
              <MessageAction
                tooltip="Copy"
                className="text-muted-foreground/70 hover:text-foreground"
                onClick={() => copyText(msg.content)}
              >
                <CopyIcon className="size-3.5" />
              </MessageAction>
              <MessageAction
                tooltip="Retry"
                className="text-muted-foreground/70 hover:text-foreground"
                onClick={() => {
                  const prevUser = previousVisibleUserMessage(messages, idx)
                  if (prevUser?.role === "user") {
                    onRetry(prevUser.content)
                  }
                }}
              >
                <RefreshCwIcon className="size-3.5" />
              </MessageAction>
              <MessageAction
                tooltip="Revert to here"
                className="text-muted-foreground/70 hover:text-foreground"
                onClick={() =>
                  onOpenConfirm({
                    title: "Revert to here?",
                    description:
                      "All messages after this point will be permanently deleted.",
                    action: async () => {
                      try {
                        await rollbackProviderConversationAfter(
                          activeThreadId,
                          messages,
                          idx
                        )
                        const keep = messages.slice(0, idx + 1)
                        await persistThreadTruncation(activeThreadId, msg.id)
                        pruneCheckpointsAfter(activeThreadId, messages, idx)
                        replaceThreadMessages(activeThreadId, keep)
                      } catch (error) {
                        handleError(error, { source: "message-revert" })
                      }
                    },
                  })
                }
              >
                <UndoIcon className="size-3.5" />
              </MessageAction>
            </MessageActions>
          </MessageToolbar>
        )}
      </Message>

      {msg.role === "assistant" && idx < messages.length - 1 && (
        <Checkpoint>
          <CheckpointIcon />
          <CheckpointTrigger
            tooltip="Restore to this point (messages + files)"
            onClick={() =>
              onOpenConfirm({
                title: CHECKPOINT_RESTORE_TITLE,
                // Say what this actually does. `restoreCheckpoint` runs
                // `git restore --worktree --staged -- .` followed by
                // `git clean -fd -- .` across the WHOLE worktree: it reverts
                // every tracked file (not only the ones the agent touched, so
                // edits you made by hand while it ran are discarded too) and
                // deletes every untracked file created since this point.
                // BetterC0de snapshots the current worktree first so the
                // operation can be undone, but the old wording ("file changes
                // will be reverted") did not describe deletion at all.
                description: CHECKPOINT_RESTORE_BODY,
                action: async () => {
                  try {
                    // 1. Find the user message before this assistant message (for SDK rewindFiles)
                    const userMsgBefore = previousVisibleUserMessage(
                      messages,
                      idx
                    )

                    // 2. Try checkpoint-store first, then SDK plugin
                    const cpStore = useCheckpointStore.getState()
                    const msgCheckpoints = cpStore.getCheckpointsForThread(
                      activeThreadId || ""
                    )
                    const matchingCp =
                      msgCheckpoints.find(
                        (cp) => cp.messageId === msg.id && cp.checkpointRef
                      ) ?? msgCheckpoints.find((cp) => cp.messageId === msg.id)
                    let serverReverted = false
                    if (
                      activeThreadId &&
                      matchingCp?.checkpointRef &&
                      typeof matchingCp.turnNumber === "number"
                    ) {
                      const result = await revertThreadCheckpoint(
                        activeThreadId,
                        matchingCp.turnNumber
                      )
                      if (!result.reverted) {
                        throw new Error(
                          result.reason ??
                            `Checkpoint turn ${matchingCp.turnNumber} could not be restored.`
                        )
                      }
                      serverReverted = true
                    }

                    if (!serverReverted) {
                      if (matchingCp?.checkpointRef) {
                        throw new Error(
                          "This Git checkpoint has no server turn boundary and cannot be restored safely."
                        )
                      } else if (matchingCp) {
                        await cpStore.restoreCheckpoint(matchingCp.id)
                      } else if (
                        userMsgBefore &&
                        activeThreadId &&
                        window.electronAPI?.rewindFiles
                      ) {
                        await window.electronAPI.rewindFiles(
                          "claude",
                          activeThreadId,
                          userMsgBefore.id
                        )
                      } else {
                        throw new Error(
                          "No restorable filesystem checkpoint is available for this message."
                        )
                      }
                    }

                    if (!serverReverted) {
                      await rollbackProviderConversationAfter(
                        activeThreadId,
                        messages,
                        idx,
                        msgCheckpoints,
                        matchingCp?.turnNumber
                      )
                    }

                    // 3. Remove messages after checkpoint
                    const keep = messages.slice(0, idx + 1)
                    if (!serverReverted) {
                      await persistThreadTruncation(activeThreadId, msg.id)
                    }
                    pruneCheckpointsAfter(
                      activeThreadId,
                      messages,
                      idx,
                      matchingCp?.turnNumber
                    )
                    replaceThreadMessages(activeThreadId, keep)
                  } catch (error) {
                    handleError(error, { source: "checkpoint-revert" })
                  }
                },
              })
            }
          >
            Restore checkpoint
          </CheckpointTrigger>
        </Checkpoint>
      )}
    </React.Fragment>
  )
}

/**
 * Cheap content-equality for the activity arrays: `deriveTranscriptTimeline`
 * rebuilds every per-turn array whenever any activity event lands, so
 * reference equality would re-render the entire history on each streaming
 * delta. Past turns receive no new events, so comparing the fields that can
 * actually change (state / completion / error / output size) is both correct
 * and O(n) over a handful of rows.
 */
function sameActivityTools(
  a: ToolCallData[] | undefined,
  b: ToolCallData[] | undefined
): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.id !== y.id ||
      x.state !== y.state ||
      x.completedAt !== y.completedAt ||
      x.error !== y.error ||
      x.outputBytes !== y.outputBytes
    ) {
      return false
    }
  }
  return true
}

function sameActivityWork(
  a: ToolCallGroupWorkEntry[] | undefined,
  b: ToolCallGroupWorkEntry[] | undefined
): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.id !== y.id || x.label !== y.label || x.tone !== y.tone) {
      return false
    }
  }
  return true
}

export const ChatMessageItem = React.memo(
  ChatMessageItemInner,
  (prev, next) => {
    // Re-render only when this message's own content changes or the surrounding
    // context (index in list, active thread) shifts. Ignoring `messages` and the
    // three callback props is intentional — see component docblock.
    if (prev.msg !== next.msg) return false
    if (prev.idx !== next.idx) return false
    if (prev.activeThreadId !== next.activeThreadId) return false
    if (prev.providerSkills !== next.providerSkills) return false
    if (prev.providerInstanceId !== next.providerInstanceId) return false
    if (prev.workspaceRoot !== next.workspaceRoot) return false
    if (!sameActivityTools(prev.activityTools, next.activityTools)) return false
    if (!sameActivityWork(prev.activityWork, next.activityWork)) return false
    if (prev.hideToolCalls !== next.hideToolCalls) return false
    if (prev.hidePlanCard !== next.hidePlanCard) return false
    if (prev.showTimestamp !== next.showTimestamp) return false
    if (prev.showThinking !== next.showThinking) return false
    if (prev.showReasoningSummaries !== next.showReasoningSummaries) {
      return false
    }
    if (prev.showToolDetails !== next.showToolDetails) return false
    if (prev.shellToolPartsExpanded !== next.shellToolPartsExpanded) {
      return false
    }
    if (prev.editToolPartsExpanded !== next.editToolPartsExpanded) {
      return false
    }
    if (prev.showGenericToolOutput !== next.showGenericToolOutput) return false
    if (prev.concealCodeBlocks !== next.concealCodeBlocks) return false
    return true
  }
)
