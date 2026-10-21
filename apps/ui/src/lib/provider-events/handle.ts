/**
 * The single provider event entry point for WS push, Electron IPC and
 * plugin events. Owns the delta barrier and the chat store mutations.
 */

import { asRecord, readString } from "@betterc0de/schema"
import { toolFailureText } from "@/lib/execution-diagnostics"
import { useChatStore, emptyStreamState } from "@/lib/chat-store"
import { maybeMarkBetterC0deAutoShare } from "@/lib/betterc0de-auto-share"
import {
  buildBetterC0dePlanJson,
  extractProposedPlanMarkdown,
  providerPlanStepsToTasks,
} from "@/lib/plan-content"
import type { SetPlanModalContent } from "@/lib/plan-modal"
import { dispatchProviderMetadataChanged } from "@/lib/provider-metadata-events"
import { normalizeProviderGoal } from "@/lib/thread-goal"
import { applyAutonomyMetadata } from "@/lib/chat/autonomy-sync"
import { activityFromProviderEvent } from "./activities"
import {
  traceProviderEventsEnabled,
  COALESCED_DELTA_EVENT_TYPES,
  queueDelta,
  flushPendingDeltas,
  appendAssistantContentDelta,
  clearContentPlanCapture,
  pendingPlanCaptureText,
  finalizeAssistantTextAtInteractionBoundary,
} from "./delta-coalescing"
import { normalizeProviderEvent } from "./normalize"
import {
  payloadTurnId,
  backendOwnedFinalizeOptions,
  providerKindFromPayload,
  providerInstanceIdFromPayload,
  correlationFromPayload,
  isCumulativeToolOutputPayload,
  usagePayload,
} from "./payload"
import {
  isAssistantMessageItem,
  completeAssistantMessageItem,
  planMarkdownFromContent,
  upsertProposedPlanActivity,
  turnDiffSummariesFromPayload,
  upsertStreamingDiffSummaries,
  recordCapturedCheckpoint,
} from "./turn-artifacts"

export interface ProviderEventCallbacks {
  setPlanModalContent?: SetPlanModalContent
  projectActivities?: boolean
  respondToolApproval?: (
    requestId: string,
    approved: boolean,
    context?: {
      pluginId?: string
      providerKind?: string
      providerInstanceId?: string
      threadId?: string
      tool?: string
      input?: unknown
    }
  ) => void
}

export function handleProviderEvent(
  threadId: string,
  type: string,
  payload: Record<string, unknown>,
  callbacks?: ProviderEventCallbacks
): void {
  const store = useChatStore.getState()
  const normalized = normalizeProviderEvent(type, payload)
  // [REASON-TRACE:RENDER-IN]
  if (traceProviderEventsEnabled()) {
    const dl = (payload.delta as string | undefined)?.length ?? 0
    const tl = (payload.text as string | undefined)?.length ?? 0
    console.log(
      `[REASON-TRACE:RENDER-IN] type=${type} normalizedType=${normalized.type} deltaLen=${dl} textLen=${tl}`
    )
  }
  type = normalized.type
  payload = normalized.payload
  // Barrier: everything except a pure append must observe the buffered deltas
  // already applied, otherwise a finalize/replace/reset could overtake tokens
  // still sitting in the coalescer.
  if (!COALESCED_DELTA_EVENT_TYPES.has(type)) {
    flushPendingDeltas(threadId)
  }
  if (type === "provider.metadata.changed") {
    dispatchProviderMetadataChanged({
      providerKind: providerKindFromPayload(payload),
      providerInstanceId: providerInstanceIdFromPayload(payload),
      metadataKind: readString(payload, "metadataKind", "metadata_kind"),
      cwd:
        typeof payload.cwd === "string" || payload.cwd === null
          ? payload.cwd
          : undefined,
    })
  }
  if (callbacks?.projectActivities !== false) {
    const activeTurnId =
      payloadTurnId(payload) ??
      useChatStore.getState().streamingByThread[threadId]?.activeTurnId ??
      undefined
    if (activeTurnId && !payloadTurnId(payload)) {
      payload = { ...payload, turn_id: activeTurnId }
    }
    const activity = activityFromProviderEvent(threadId, type, payload)
    if (activity) {
      store.upsertThreadActivity(threadId, activity)
    }
  }

  // ACP providers can first report a tool through an update or completion.
  // Establish that tool's boundary once, preserving later reasoning when an
  // already-known tool sends a delayed result (including background tools).
  if (
    (type === "tool_call_delta" || type === "tool_result") &&
    typeof payload.tool_id === "string" &&
    !useChatStore
      .getState()
      .streamingByThread[
        threadId
      ]?.streamingTools.some((tool) => tool.id === payload.tool_id)
  ) {
    store.addToolCall(threadId, {
      id: payload.tool_id,
      name: readString(payload, "tool_name") ?? "unknown",
      input: payload.input ?? {},
      state: "input-available",
      providerKind: providerKindFromPayload(payload),
      providerInstanceId: providerInstanceIdFromPayload(payload),
      ...correlationFromPayload(payload),
      turnId: payloadTurnId(payload) ?? undefined,
    })
  }

  switch (type) {
    case "content_delta":
      if (payload.delta) {
        const turnId = payloadTurnId(payload)
        if (turnId) store.setActiveTurnId(threadId, turnId)
        appendAssistantContentDelta(threadId, payload.delta as string)
      }
      break

    case "content_replace":
      if (payload.text) {
        store.closeReasoningSegment(threadId)
        clearContentPlanCapture(threadId)
        const text = payload.text as string
        const planMarkdown = extractProposedPlanMarkdown(text)
        if (planMarkdown) {
          useChatStore.getState().replacePlanStreamText(threadId, text)
          const activeTurnId =
            payloadTurnId(payload) ??
            useChatStore.getState().streamingByThread[threadId]?.activeTurnId
          upsertProposedPlanActivity(threadId, {
            ...payload,
            planMarkdown,
            ...(activeTurnId ? { turn_id: activeTurnId } : {}),
          })
          if (!activeTurnId) store.clearStreaming(threadId)
          break
        }
        useChatStore.setState((state) => {
          const cur = state.streamingByThread[threadId] ?? emptyStreamState
          return {
            streamingByThread: {
              ...state.streamingByThread,
              [threadId]: {
                ...cur,
                isStreaming: true,
                streamingText: text,
                isReasoning: false,
              },
            },
          }
        })
      }
      break

    case "reasoning_delta":
      if (payload.delta)
        queueDelta(threadId, "reasoning", payload.delta as string)
      break

    case "reasoning_replace":
      if (payload.text) {
        useChatStore.setState((state) => {
          const cur = state.streamingByThread[threadId] ?? emptyStreamState
          return {
            streamingByThread: {
              ...state.streamingByThread,
              [threadId]: {
                ...cur,
                isStreaming: true,
                reasoningText: payload.text as string,
                isReasoning: true,
              },
            },
          }
        })
      }
      break

    case "tool_call":
      {
        const providerKind = providerKindFromPayload(payload)
        const providerInstanceId = providerInstanceIdFromPayload(payload)
        store.addToolCall(threadId, {
          id: (payload.tool_id as string) || crypto.randomUUID(),
          name: (payload.tool_name as string) || "unknown",
          input: payload.input,
          providerKind,
          providerInstanceId,
          ...correlationFromPayload(payload),
          turnId:
            typeof payload.turn_id === "string" ? payload.turn_id : undefined,
          startedAt:
            typeof payload.started_at === "string"
              ? payload.started_at
              : typeof payload.started_at === "number"
                ? new Date(payload.started_at).toISOString()
                : undefined,
          state: "input-available",
        })
        // Track tool name for live editor updates
        if (payload.tool_id && payload.tool_name) {
          window.__betterc0de_tool_calls__ =
            window.__betterc0de_tool_calls__ || {}
          window.__betterc0de_tool_calls__[payload.tool_id as string] = {
            name: payload.tool_name as string,
            input: payload.input as Record<string, unknown>,
          }
        }
      }
      break

    case "tool_call_delta": {
      if (!payload.tool_id) break
      const providerKind = providerKindFromPayload(payload)
      const providerInstanceId = providerInstanceIdFromPayload(payload)
      if (payload.input !== undefined) {
        store.updateToolCallInput(
          threadId,
          payload.tool_id as string,
          payload.input
        )
      }
      if (typeof payload.output_delta === "string") {
        store.appendToolOutputDelta(
          threadId,
          payload.tool_id as string,
          payload.output_delta,
          typeof payload.tool_name === "string" ? payload.tool_name : undefined,
          providerKind,
          providerInstanceId,
          // Same predicate as the activity key: a cumulative snapshot
          // replaces the streaming output, a chunk appends to it.
          isCumulativeToolOutputPayload(payload) ? "replace" : "append"
        )
      }
      break
    }

    case "tool_result": {
      const providerKind = providerKindFromPayload(payload)
      const providerInstanceId = providerInstanceIdFromPayload(payload)
      const failure = toolFailureText(payload.error)
      if (failure) {
        store.updateToolFailure(
          threadId,
          payload.tool_id as string,
          failure,
          payload.output,
          providerKind,
          providerInstanceId
        )
      } else {
        store.updateToolResult(
          threadId,
          payload.tool_id as string,
          payload.output,
          providerKind,
          providerInstanceId
        )
      }

      // Live editor update — if Write or Edit tool completed, refresh the editor tab
      const toolInfo =
        window.__betterc0de_tool_calls__?.[payload.tool_id as string]
      const toolName = (toolInfo?.name || "").toLowerCase()
      if (
        toolInfo &&
        (toolName === "write" ||
          toolName === "edit" ||
          toolName.includes("write") ||
          toolName.includes("edit") ||
          toolName.includes("file_change"))
      ) {
        const relPath = (toolInfo.input?.path ||
          toolInfo.input?.file_path ||
          "") as string
        if (relPath) {
          import("@/lib/editor-store")
            .then(({ useEditorStore }) => {
              const editorState = useEditorStore.getState()
              // Build absolute path from project path + relative path
              const thread = useChatStore
                .getState()
                .threads.find((t) => t.id === threadId)
              const projectPath = thread?.projectPath || ""
              const isAbsolute =
                relPath.includes(":") || relPath.startsWith("/")
              const absPath = isAbsolute
                ? relPath
                : projectPath
                  ? `${projectPath.replace(/\\/g, "/")}/${relPath}`
                  : relPath

              // Notify UI surfaces (file tree, preview, editor) immediately.
              window.dispatchEvent(
                new CustomEvent("betterc0de:file-changed", {
                  detail: {
                    threadId,
                    projectPath,
                    path: absPath,
                    relativePath: relPath,
                    toolName,
                  },
                })
              )

              // Check if tab is already open (match by full path or ending)
              const existingTab = editorState.tabs.find(
                (t) =>
                  t.filePath === absPath ||
                  t.filePath === relPath ||
                  t.filePath
                    .replace(/\\/g, "/")
                    .endsWith(relPath.replace(/\\/g, "/"))
              )
              if (existingTab) {
                // Reload from disk, capturing the pre-edit content as diff baseline
                editorState.reloadFromAi(existingTab.filePath)
              }
            })
            .catch(() => {
              console.warn("Failed to reload editor tab after file_edit event")
            })
        }
      }
      break
    }

    case "token_usage": {
      const usage = payload.usage as Record<string, number> | undefined
      if (usage) store.updateThreadUsage(threadId, usage)
      break
    }

    case "thread.token-usage.updated": {
      const usage = usagePayload(payload)
      if (usage)
        store.updateThreadUsage(threadId, usage as Record<string, number>)
      break
    }

    case "thread.metadata.updated": {
      const title = readString(payload, "name", "title")
      if (title) store.updateThreadTitle(threadId, title.trim())
      const metadata = asRecord(payload.metadata)
      if (Object.prototype.hasOwnProperty.call(metadata, "goal")) {
        const current = store.getThreadSettings(threadId).goal
        const goal = normalizeProviderGoal(
          metadata.goal,
          current,
          providerKindFromPayload(payload)
        )
        if (goal !== undefined) {
          store.setThreadSetting(threadId, "goal", goal)
        }
      }
      // The backend's Autonomous Work run and the message of the turn it
      // just started.
      applyAutonomyMetadata(threadId, payload, metadata)
      break
    }

    case "thread.realtime.started":
    case "thread.realtime.item-added":
    case "thread.realtime.audio.delta":
    case "thread.realtime.error":
    case "thread.realtime.closed":
      break

    case "turn.plan.updated": {
      const tasks = providerPlanStepsToTasks(payload.plan)
      if (tasks.length > 0) {
        useChatStore.setState((state) => {
          const cur = state.streamingByThread[threadId] ?? {
            ...emptyStreamState,
          }
          return {
            streamingByThread: {
              ...state.streamingByThread,
              [threadId]: { ...cur, isStreaming: true, streamingTasks: tasks },
            },
          }
        })
      }
      break
    }

    case "turn.proposed.delta":
      if (typeof payload.delta === "string") {
        clearContentPlanCapture(threadId)
        queueDelta(threadId, "plan", payload.delta)
      }
      break

    case "turn.proposed.completed": {
      const planContent = readString(payload, "planMarkdown", "plan_markdown")
      if (planContent) {
        clearContentPlanCapture(threadId)
        store.replacePlanStreamText(threadId, planContent)
      }
      if (!useChatStore.getState().streamingByThread[threadId]?.activeTurnId)
        store.clearStreaming(threadId)
      break
    }

    case "item.completed":
      if (isAssistantMessageItem(payload)) {
        completeAssistantMessageItem(threadId, payload)
      }
      break

    case "turn_completed":
      if (payload.input_tokens || payload.output_tokens) {
        store.updateThreadUsage(threadId, {
          inputTokens: payload.input_tokens as number,
          outputTokens: payload.output_tokens as number,
          usedTokens:
            ((payload.input_tokens as number) || 0) +
            ((payload.output_tokens as number) || 0),
        })
      }
      {
        const stream = useChatStore.getState().streamingByThread[threadId]
        if (stream?.isPlanStreaming && stream.streamingPlanText) {
          const planMarkdown = planMarkdownFromContent(stream.streamingPlanText)
          if (callbacks?.projectActivities !== false) {
            upsertProposedPlanActivity(threadId, {
              ...payload,
              planMarkdown,
              turn_id: stream.activeTurnId ?? payloadTurnId(payload),
            })
          }
          clearContentPlanCapture(threadId)
          store.clearStreaming(threadId)
          store.setActiveTurnId(threadId, null)
          break
        }
      }
      {
        const held = pendingPlanCaptureText(threadId)
        if (held) {
          store.appendStreamDelta(threadId, held)
          clearContentPlanCapture(threadId)
        }
      }
      {
        const stream = useChatStore.getState().streamingByThread[threadId]
        if (
          stream?.isStreaming &&
          !stream.streamingText &&
          stream.streamingTasks.length > 0
        ) {
          store.appendStreamDelta(
            threadId,
            buildBetterC0dePlanJson({
              title: "Plan",
              tasks: stream.streamingTasks,
            })
          )
        }
      }
      {
        const stream = useChatStore.getState().streamingByThread[threadId]
        const completedEmpty =
          stream?.isStreaming &&
          !stream.streamingText &&
          !stream.reasoningText &&
          stream.streamingTools.length === 0 &&
          !store.threads
            .find((thread) => thread.id === threadId)
            ?.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.turnId ===
                  (payloadTurnId(payload) ?? stream.activeTurnId)
            )
        if (completedEmpty) {
          store.addMessage(threadId, {
            id: crypto.randomUUID(),
            role: "assistant",
            content:
              "Error: Provider completed without returning response content.",
            createdAt: new Date().toISOString(),
          })
          store.clearStreaming(threadId)
          break
        }
      }
      {
        const finalStream = useChatStore.getState().streamingByThread[threadId]
        store.finalizeStream(
          threadId,
          backendOwnedFinalizeOptions(
            threadId,
            payloadTurnId(payload) ?? finalStream?.activeTurnId
          )
        )
        store.setActiveTurnId(threadId, null)
        clearContentPlanCapture(threadId)
        const thread = useChatStore
          .getState()
          .threads.find((t) => t.id === threadId)
        const latestAssistant = [...(thread?.messages || [])]
          .reverse()
          .find((message) => message.role === "assistant")
        window.dispatchEvent(
          new CustomEvent("betterc0de:response-complete", {
            detail: {
              threadId,
              projectPath: thread?.projectPath || "",
              response: latestAssistant?.content || "",
            },
          })
        )
        void maybeMarkBetterC0deAutoShare(threadId)
      }
      break

    case "turn_error": {
      const errorMsg = (payload.error as string) || "Connection error"
      store.addMessage(threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `Error: ${errorMsg}`,
        createdAt: new Date().toISOString(),
      })
      store.clearStreaming(threadId)
      store.setActiveTurnId(threadId, null)
      clearContentPlanCapture(threadId)
      break
    }

    case "turn_warning":
      break

    case "turn_interrupted":
    case "turn.aborted":
      store.finalizeStream(
        threadId,
        backendOwnedFinalizeOptions(
          threadId,
          payloadTurnId(payload) ??
            useChatStore.getState().streamingByThread[threadId]?.activeTurnId
        )
      )
      store.setActiveTurnId(threadId, null)
      clearContentPlanCapture(threadId)
      break

    case "turn_started":
      {
        const turnId = payloadTurnId(payload) ?? crypto.randomUUID()
        clearContentPlanCapture(threadId)
        store.setActiveTurnId(threadId, turnId)
        store.appendStreamDelta(threadId, "")
      }
      break

    case "turn.diff.updated": {
      upsertStreamingDiffSummaries(
        threadId,
        turnDiffSummariesFromPayload(payload)
      )
      break
    }

    case "checkpoint.captured": {
      recordCapturedCheckpoint(threadId, payload)
      break
    }

    case "file_diff": {
      // Merge diff with existing entry for same file (per-thread)
      const newPath = (payload.path as string) || ""
      useChatStore.setState((state) => {
        const cur = state.streamingByThread[threadId] ?? {
          ...emptyStreamState,
        }
        const diffs = cur.streamingDiffs
        const existing = diffs.find((d) => d.path === newPath)
        const newDiffs = existing
          ? diffs.map((d) =>
              d.path === newPath
                ? {
                    ...d,
                    additions:
                      d.additions + ((payload.additions as number) || 0),
                    deletions:
                      d.deletions + ((payload.deletions as number) || 0),
                    oldText:
                      d.oldText +
                      (d.oldText && payload.old_text ? "\n" : "") +
                      ((payload.old_text as string) || ""),
                    newText:
                      d.newText +
                      (d.newText && payload.new_text ? "\n" : "") +
                      ((payload.new_text as string) || ""),
                  }
                : d
            )
          : [
              ...diffs,
              {
                path: newPath,
                additions: (payload.additions as number) || 0,
                deletions: (payload.deletions as number) || 0,
                oldText: (payload.old_text as string) || "",
                newText: (payload.new_text as string) || "",
                isNew: (payload.is_new as boolean) || false,
              },
            ]
        return {
          streamingByThread: {
            ...state.streamingByThread,
            [threadId]: { ...cur, streamingDiffs: newDiffs },
          },
        }
      })
      break
    }

    case "task_list": {
      // Store task list for Queue component rendering (per-thread)
      const tasks = payload.tasks as { text: string; completed: boolean }[]
      if (tasks) {
        useChatStore.setState((state) => {
          const cur = state.streamingByThread[threadId] ?? {
            ...emptyStreamState,
          }
          return {
            streamingByThread: {
              ...state.streamingByThread,
              [threadId]: { ...cur, streamingTasks: tasks },
            },
          }
        })
      }
      break
    }

    case "user_input_requested": {
      finalizeAssistantTextAtInteractionBoundary(threadId)
      const questions =
        (payload.questions as {
          question?: string
          header?: string
          options?: { label: string; description?: string }[]
        }[]) || []
      const requestId = payload.requestId as string
      for (const q of questions) {
        store.addQuestion(threadId, {
          id: requestId,
          text: q.question || q.header || "Question",
          options: (q.options || []).map((o) =>
            typeof o === "string"
              ? { label: o }
              : { label: o.label, description: o.description }
          ),
        })
      }
      break
    }

    case "tool_approval_requested":
      finalizeAssistantTextAtInteractionBoundary(threadId)
      // Persisted/displayed as a pending activity. The user responds from the
      // chat approval row instead of an immediate window.confirm side effect.
      break

    case "plan_approval_requested":
      // The turn is paused inside canUseTool awaiting the user's plan
      // decision — finalize text and stop the shimmer while they review.
      finalizeAssistantTextAtInteractionBoundary(threadId)
      clearContentPlanCapture(threadId)
      store.clearStreaming(threadId)
      break

    case "plan_approval_resolved": {
      const decision = readString(payload, "decision")
      if (decision === "approve") {
        store.setThreadSetting(threadId, "chatMode", "agent")
        // The same turn continues into implementation — re-arm the streaming
        // indicator so the transcript shows activity instead of a dead stop.
        store.appendStreamDelta(threadId, "")
      }
      break
    }

    case "session.started":
    case "session.configured":
    case "session.state.changed":
    case "session.exited":
    case "task.started":
    case "task.progress":
    case "task.completed":
    case "task_started":
    case "task_progress":
    case "task_completed":
    case "hook.started":
    case "hook.progress":
    case "hook.completed":
    case "hook_started":
    case "hook_progress":
    case "hook_completed":
    case "hook_response":
      // Lifecycle-only events are already represented as activities.
      break

    default:
      // Log unhandled events at debug level
      if (type !== "content_delta" && type !== "reasoning_delta") {
        console.debug(`[BetterC0de] unhandled event: ${type}`, payload)
      }
  }
}
