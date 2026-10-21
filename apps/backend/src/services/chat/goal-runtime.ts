import { randomUUID } from "node:crypto"
import type { ChatSendBody, ThreadGoal } from "@betterc0de/schema"
import { parseGoalCommand } from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import type { ProviderEventBus } from "../../provider/events"
import { threadId as toThreadId } from "../../provider/runtime"
import type { LegacyProviderEvent } from "../../provider/types"
import { ThreadGoals } from "./goals"
import { threadGoals, type GoalContext } from "./goal-registry"
import { threadAutonomyRuns } from "./autonomy-registry"
import {
  asHubProviderKind,
  dispatchChatTurn,
  prepareChatSendBody,
} from "./dispatch"
import { resolveChatWorkspaceRoot } from "../workspace/authorization"
import { currentThreadPermissionLevel } from "./thread-settings"
import { runMessageSendHooks } from "./turn-preparation"

/**
 * The bus lanes the goal runtime uses: it publishes a goal change as a
 * canonical event and waits for its projection.
 */
export type GoalEventBus = Pick<
  ProviderEventBus,
  "on" | "off" | "emitCanonical"
>

export function initializeThreadGoals(
  state: AppState,
  eventBus: GoalEventBus
): () => void {
  const goals = new ThreadGoals<GoalContext>({
    read: (threadId) => state.threads.getThreadGoal(threadId),
    publish: (threadId, goal) => {
      if (state.taintedRef() || state.drainingRef())
        throw new Error("Backend is not accepting goal updates.")
      const mutationId = randomUUID()
      let projected = false
      const observe = (event: LegacyProviderEvent) => {
        const metadata = event.payload.metadata as
          | Record<string, unknown>
          | undefined
        if (
          event.thread_id === threadId &&
          metadata?.goalMutationId === mutationId
        )
          projected = true
      }
      eventBus.on("projected", observe)
      try {
        eventBus.emitCanonical({
          eventId: mutationId,
          threadId,
          type: "thread.metadata.updated",
          at: Date.now(),
          payload: {
            metadata: {
              goal: goal ?? { source: "betterc0de", goal: null },
              goalMutationId: mutationId,
            },
          },
        })
        if (!projected)
          throw new Error(
            "Goal update could not be durably projected. No further goal turn will be started."
          )
      } finally {
        eventBus.off("projected", observe)
      }
    },
    waitForIdle: async (threadId) => {
      await state.threadTurnCoordinator.waitForIdle(threadId)
      await state.providerHub.waitForThreadIdle(threadId)
    },
    dispatch: async (threadId, prompt, context, guard, started) => {
      if (state.taintedRef() || state.drainingRef())
        throw new Error("Backend is stopping; resume the goal after restart.")
      if (!state.threads.hasThread(threadId))
        throw new Error("Goal chat is no longer available.")
      if (state.settings.get().auto_save_conversations === false)
        throw new Error(
          "Conversation auto-save is required to continue a goal safely."
        )
      const modelKind = asHubProviderKind(context.body.provider_kind)
      if (
        !modelKind ||
        !(state.providerHub.has(modelKind) || context.body.provider_instance_id)
      ) {
        throw new Error(
          "Goals require a runtime provider (Claude CLI, Codex, Cursor, Grok CLI or an HTTP compatibility instance)."
        )
      }
      const now = new Date().toISOString()
      await dispatchChatTurn(
        state,
        {
          ...context.body,
          thread_id: threadId,
          message: prompt,
          user_message_id: randomUUID(),
          user_message_content: "Continue working toward the goal.",
          user_message_created_at: now,
          attachments: [],
          // Live permission changes apply to subsequent turns too; the
          // chat's own level stands in until this process has seen one.
          ...(context.continued
            ? {
                permission_level: currentThreadPermissionLevel(state, threadId),
              }
            : {}),
          source_proposed_plan: null,
        },
        context.reserveRemoteTurn,
        {
          guard: () => {
            guard()
            if (
              state.taintedRef() ||
              state.drainingRef() ||
              !state.threads.hasThread(threadId)
            )
              throw new Error(
                "Goal admission cancelled because the chat or backend is unavailable."
              )
          },
          started,
        }
      )
      context.continued = true
    },
    interrupt: (threadId, turnId) =>
      state.providerHub.interruptTurnIfActive(toThreadId(threadId), turnId),
    onError: (error) =>
      logger.error({ err: error }, "goal continuation stopped"),
    onDispose: () => {
      eventBus.off("projected", observe)
      threadGoals.delete(state)
    },
  })
  const observe = (event: LegacyProviderEvent) =>
    goals.observe(event.thread_id, event.event_type, event.payload)
  eventBus.on("projected", observe)
  threadGoals.set(state, goals)
  try {
    // Read only goal-bearing rows, without loading the conversation history.
    const rows = state.db
      .prepare(
        "SELECT thread_id, provider_goal_json FROM projection_threads WHERE provider_goal_json IS NOT NULL"
      )
      .all() as Array<{ thread_id: string; provider_goal_json: string }>
    for (const row of rows) {
      const goal = state.threads.getThreadGoal(row.thread_id)
      if (goal) goals.recover(row.thread_id, goal)
    }
  } catch (error) {
    // Bootstrap cannot register our disposer until initialization returns.
    // Query/record failures must unwind the listener and state entry here too.
    goals.dispose()
    throw error
  }
  return () => {
    goals.dispose()
    eventBus.off("projected", observe)
    threadGoals.delete(state)
  }
}

export async function controlThreadGoal(
  state: AppState,
  body: ChatSendBody,
  reserveRemoteTurn: GoalContext["reserveRemoteTurn"]
): Promise<{ goal: ThreadGoal | null }> {
  const goals = threadGoals.get(state)
  if (!goals)
    throw new HttpError(503, "Goal service is unavailable.", "goal_unavailable")
  try {
    const command = parseGoalCommand(body.message)
    if (!command)
      throw new Error("Expected /goal followed by an objective or command.")
    // The user's message hooks run here, once, not with each of the goal's
    // turns: for every command that starts provider work, whichever client
    // sent it, and for any command a client typed as a message
    // (`prepareTurn`). The desktop's pause, clear and status buttons send
    // controls, which start nothing.
    const startsWork =
      command.action === "set" ||
      command.action === "edit" ||
      command.action === "resume"
    if (body.prepare_turn || startsWork) {
      // In the chat's approved folder, never in one the request names. A
      // pause or a clear still goes through when that folder is gone.
      let projectPath: string | null = null
      try {
        projectPath = await resolveChatWorkspaceRoot(
          state,
          body.thread_id,
          body.project_path
        )
      } catch (error) {
        if (startsWork) throw error
      }
      await runMessageSendHooks(state, { ...body, project_path: projectPath })
    }
    if (command.action !== "status" && !state.threads.hasThread(body.thread_id))
      throw new HttpError(404, "Goal chat not found.", "thread_not_found")
    if (
      command.action === "set" ||
      command.action === "resume" ||
      command.action === "edit"
    ) {
      // Two schedulers must not take turns in one chat.
      if (
        threadAutonomyRuns.get(state)?.get(body.thread_id)?.status === "working"
      )
        throw new Error(
          "Autonomous Work is running in this chat. Pause or stop it before starting a goal."
        )
      if (state.settings.get().auto_save_conversations === false)
        throw new Error(
          "Enable conversation auto-save before starting a goal. It preserves the history needed for continuation and recovery."
        )
      body = await prepareChatSendBody(state, body)
      const kind = asHubProviderKind(body.provider_kind)
      if (!kind || !(state.providerHub.has(kind) || body.provider_instance_id))
        throw new Error(
          "This provider does not support managed goals. Select a CLI or runtime HTTP provider."
        )
    }
    return {
      goal: goals.command(body.thread_id, command, { body, reserveRemoteTurn }),
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(
      400,
      error instanceof Error ? error.message : String(error),
      "goal_command_failed"
    )
  }
}
