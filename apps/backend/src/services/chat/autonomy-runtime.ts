import { randomUUID } from "node:crypto"
import type {
  ChatAutonomyStartBody,
  ChatSendBody,
  ThreadAutonomy,
} from "@betterc0de/schema"
import type { ChatSendResponse } from "@betterc0de/schema/http-contracts"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import type { LegacyProviderEvent } from "../../provider/types"
import { resolveChatWorkspaceRoot } from "../workspace/authorization"
import { ThreadAutonomyRuns } from "./autonomy"
import { threadAutonomyRuns, type AutonomyContext } from "./autonomy-registry"
import {
  asHubProviderKind,
  dispatchChatTurn,
  prepareChatSendBody,
} from "./dispatch"
import { threadGoals } from "./goal-registry"
import type { GoalEventBus } from "./goal-runtime"
import { currentThreadPermissionLevel } from "./thread-settings"
import { runMessageSendHooks } from "./turn-preparation"

/**
 * Wires the Autonomous Work scheduler (`autonomy.ts`) to the backend, the
 * way `goal-runtime.ts` wires goals: a run's state is journaled as the
 * chat's `thread.metadata.updated` event (projected into
 * `projection_threads.autonomy_json`, pushed to every client like a goal
 * update), its turns go through `dispatchChatTurn` with the opening
 * request's settings and caller, and a run left working by a previous
 * process is paused until the user resumes it.
 */

/** The run's turns reuse the request's settings, never its content. */
function continuationBody(body: ChatSendBody): ChatSendBody {
  return {
    ...body,
    history: [],
    attachments: [],
    user_message_id: null,
    user_message_content: null,
    user_message_created_at: null,
    source_proposed_plan: null,
    // Usage the client saw then; the backend's own figures stay current.
    auto_compaction_usage: null,
  }
}

/** The chat's last message when the assistant wrote it, otherwise "". */
function lastAssistantReply(state: AppState, threadId: string): string {
  const [last] = state.threads.listMessages(threadId, {
    limit: 1,
    light: true,
  }) as Array<{ role?: unknown; content?: unknown } | undefined>
  return last?.role === "assistant" && typeof last.content === "string"
    ? last.content
    : ""
}

export function initializeThreadAutonomy(
  state: AppState,
  eventBus: GoalEventBus
): () => void {
  const runs = new ThreadAutonomyRuns<AutonomyContext>({
    read: (threadId) => state.threads.getThreadAutonomy(threadId),
    publish: (threadId, autonomy, prompt) => {
      if (state.taintedRef() || state.drainingRef())
        throw new Error("Backend is not accepting Autonomous Work updates.")
      const mutationId = randomUUID()
      let projected = false
      const observe = (event: LegacyProviderEvent) => {
        const metadata = event.payload.metadata as
          | Record<string, unknown>
          | undefined
        if (
          event.thread_id === threadId &&
          metadata?.autonomyMutationId === mutationId
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
              autonomy,
              autonomyMutationId: mutationId,
              ...(prompt ? { autonomyPrompt: prompt } : {}),
            },
          },
        })
        if (!projected)
          throw new Error(
            "Autonomous Work update could not be durably projected. No further autonomous turn will be started."
          )
      } finally {
        eventBus.off("projected", observe)
      }
    },
    isIdle: (threadId) =>
      state.threadTurnCoordinator.activeOwner(threadId) === null,
    waitForIdle: async (threadId) => {
      await state.threadTurnCoordinator.waitForIdle(threadId)
      await state.providerHub.waitForThreadIdle(threadId)
    },
    lastReply: (threadId) => lastAssistantReply(state, threadId),
    dispatch: async (threadId, prompt, context, guard, started) => {
      const available = () => {
        if (state.taintedRef() || state.drainingRef())
          throw new Error(
            "The backend is stopping. Resume Autonomous Work after it restarts."
          )
        if (!state.threads.hasThread(threadId))
          throw new Error("The chat of this Autonomous Work run is gone.")
      }
      available()
      if (state.settings.get().auto_save_conversations === false)
        throw new Error(
          "Conversation auto-save is required to continue Autonomous Work."
        )
      await dispatchChatTurn(
        state,
        {
          ...context.body,
          thread_id: threadId,
          message: prompt.content,
          user_message_id: prompt.messageId,
          user_message_content: prompt.content,
          user_message_created_at: prompt.createdAt,
          attachments: [],
          history: [],
          source_proposed_plan: null,
          // As for a goal: live permission changes apply to the following
          // turns; the request's own (capped) level stands for the first.
          ...(context.continued
            ? {
                permission_level: currentThreadPermissionLevel(state, threadId),
              }
            : {}),
        },
        context.reserveRemoteTurn,
        {
          guard: () => {
            guard()
            available()
          },
          started: () => started(),
        }
      )
      context.continued = true
    },
    modelId: (context) => context.body.model_id,
    onError: (error) => logger.error({ err: error }, "autonomous work stopped"),
    onDispose: () => {
      threadAutonomyRuns.delete(state)
    },
  })
  threadAutonomyRuns.set(state, runs)
  try {
    // Read only the rows that keep a run, without the conversations.
    const rows = state.db
      .prepare(
        "SELECT thread_id FROM projection_threads WHERE autonomy_json IS NOT NULL"
      )
      .all() as Array<{ thread_id: string }>
    for (const row of rows) {
      const autonomy = state.threads.getThreadAutonomy(row.thread_id)
      if (autonomy) runs.recover(row.thread_id, autonomy)
    }
  } catch (error) {
    // Bootstrap cannot register the disposer until this returns.
    runs.dispose()
    throw error
  }
  return () => {
    runs.dispose()
    threadAutonomyRuns.delete(state)
  }
}

function autonomyRuns(state: AppState): ThreadAutonomyRuns<AutonomyContext> {
  const runs = threadAutonomyRuns.get(state)
  if (!runs)
    throw new HttpError(
      503,
      "Autonomous Work is unavailable.",
      "autonomy_unavailable"
    )
  return runs
}

/**
 * What every turn of a run needs before the run starts or resumes: the
 * chat, durable history to continue from, a provider the backend runs (a
 * desktop provider plugin cannot be driven from here) and no active goal
 * scheduling turns of its own. Then the user's "on message send" hooks run
 * once, for the request, as for a goal; the run's own turns skip them.
 */
async function prepareAutonomyRequest(
  state: AppState,
  body: ChatSendBody
): Promise<ChatSendBody> {
  if (!state.threads.hasThread(body.thread_id))
    throw new HttpError(404, "Chat not found.", "thread_not_found")
  if (state.settings.get().auto_save_conversations === false)
    throw new HttpError(
      409,
      "Enable conversation auto-save before starting Autonomous Work. It keeps the history the run continues from.",
      "autonomy_requires_auto_save"
    )
  const hubKind = asHubProviderKind(body.provider_kind)
  if (
    !hubKind ||
    !(state.providerHub.has(hubKind) || body.provider_instance_id)
  ) {
    // Throws 400 for a kind the backend does not serve (a provider plugin).
    state.providers.resolveProviderKind(body.provider_kind)
  }
  if (threadGoals.get(state)?.get(body.thread_id)?.status === "active")
    throw new HttpError(
      409,
      "A goal is active in this chat. Pause or clear it before starting Autonomous Work.",
      "goal_active"
    )
  // In the chat's approved folder, never in one the request names.
  const projectPath = await resolveChatWorkspaceRoot(
    state,
    body.thread_id,
    body.project_path
  )
  await runMessageSendHooks(state, { ...body, project_path: projectPath })
  return prepareChatSendBody(state, body)
}

/**
 * POST /chat/autonomy/start: starts the chat's run (replacing any run it
 * had) and sends its opening message as `/chat/send` would. The body is
 * already capped for the caller (`capRemoteChatPermissions`).
 */
export async function startThreadAutonomy(
  state: AppState,
  body: ChatAutonomyStartBody,
  reserveRemoteTurn: AutonomyContext["reserveRemoteTurn"]
): Promise<{ autonomy: ThreadAutonomy | null; turn: ChatSendResponse }> {
  const runs = autonomyRuns(state)
  const { autonomy: config, ...opening } = body
  const prepared = await prepareAutonomyRequest(state, opening)
  const context: AutonomyContext = {
    body: continuationBody(prepared),
    reserveRemoteTurn,
  }
  // The opening message is the user's own: shown and stored as sent.
  const { autonomy, result } = await runs.start(
    opening.thread_id,
    config,
    context,
    (guard) =>
      dispatchChatTurn(state, opening, reserveRemoteTurn, {
        guard,
        started: () => undefined,
      })
  )
  context.continued = true
  return { autonomy, turn: result }
}

/**
 * POST /chat/autonomy/resume: continues a paused run with the caller's
 * provider, model and (capped) permission level, as `/goal resume` does.
 */
export async function resumeThreadAutonomy(
  state: AppState,
  body: ChatSendBody,
  reserveRemoteTurn: AutonomyContext["reserveRemoteTurn"]
): Promise<{ autonomy: ThreadAutonomy | null }> {
  const runs = autonomyRuns(state)
  const current = runs.get(body.thread_id)
  if (current?.status !== "paused") return { autonomy: current }
  const prepared = await prepareAutonomyRequest(state, body)
  return {
    autonomy: runs.resume(body.thread_id, {
      body: continuationBody(prepared),
      reserveRemoteTurn,
    }),
  }
}

/** POST /chat/autonomy/pause: no further turn; one already running finishes. */
export function pauseThreadAutonomy(
  state: AppState,
  threadId: string
): { autonomy: ThreadAutonomy | null } {
  return { autonomy: autonomyRuns(state).pause(threadId) }
}

/** POST /chat/autonomy/stop: ends the run without a summary. */
export function stopThreadAutonomy(
  state: AppState,
  threadId: string
): { autonomy: null } {
  return { autonomy: autonomyRuns(state).stop(threadId) }
}

/** POST /chat/autonomy/task: ticks a task off by hand, or reopens it. */
export function setThreadAutonomyTask(
  state: AppState,
  threadId: string,
  taskId: string,
  done: boolean
): { autonomy: ThreadAutonomy | null } {
  return {
    autonomy: autonomyRuns(state).setTaskDone(threadId, taskId, done),
  }
}
