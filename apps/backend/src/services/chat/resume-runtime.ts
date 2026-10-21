import type { ChatResumeAction, ThreadResume } from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { logger } from "../../observability/logger"
import type { ProviderEventBus } from "../../provider/events"
import type { LegacyProviderEvent } from "../../provider/types"
import { broadcastThreadResume } from "../../ws/threadActivityBroadcast"
import { asHubProviderKind, dispatchChatTurn } from "./dispatch"
import { resumeSendBody, stricterPermissionLevel } from "./resume-policy"
import { chatResumes } from "./resume-registry"
import { ChatResumeScheduler, type ResumeCaller } from "./resume-scheduler"
import { SqliteChatResumeStore } from "./resume-store"
import { currentThreadPermissionLevel } from "./thread-settings"

/**
 * Wires the chat resume scheduler (resume-scheduler.ts) to the backend, as
 * goal-runtime.ts wires goals: it reads every turn from the bus's
 * `"projected"` lane (after the journal), keeps its state with the chat
 * (resume-store.ts), tells clients on the `thread.metadata` channel and
 * sends its turns through `dispatchChatTurn` like a goal's. Started with
 * the other schedulers (bootstrap/schedulers.ts), before the backend binds
 * its port, so it sees every turn and recovers what a quit or crash left.
 */

export type ChatResumeEventBus = Pick<ProviderEventBus, "on" | "off">

export function initializeChatResume(
  state: AppState,
  eventBus: ChatResumeEventBus
): () => void {
  const scheduler = new ChatResumeScheduler({
    store: new SqliteChatResumeStore(state.db),
    now: () => Date.now(),
    random: () => Math.random(),
    settings: () => {
      const settings = state.settings.get()
      return {
        resumeAfterUsageLimit: settings.resume_after_usage_limit !== false,
        continueAfterRestart: settings.continue_after_restart !== false,
        autoSave: settings.auto_save_conversations !== false,
      }
    },
    canResumeSession: (providerKind, providerInstanceId) => {
      const kind = providerKind ? asHubProviderKind(providerKind) : null
      if (!kind) return false
      const adapter =
        (providerInstanceId
          ? state.providerHub.getInstance(providerInstanceId)?.adapter
          : null) ?? state.providerHub.get(kind)
      return adapter?.capabilities.supportsResume === true
    },
    isIdle: (threadId) =>
      state.threadTurnCoordinator.activeOwner(threadId) === null,
    dispatch: async (request, guard, started) => {
      const available = () => {
        if (state.taintedRef() || state.drainingRef())
          throw new Error(
            "The backend is stopping. The chat resumes after it restarts."
          )
        if (!state.threads.hasThread(request.threadId))
          throw new Error("The chat is gone.")
      }
      available()
      const original = request.template.permission_level
      const body = resumeSendBody({
        threadId: request.threadId,
        template: request.template,
        content: request.content,
        messageId: request.messageId,
        createdAt: request.createdAt,
        // Never more than the stopped turn had, nor than the chat has now.
        permissionLevel: stricterPermissionLevel(
          typeof original === "string" ? original : null,
          currentThreadPermissionLevel(state, request.threadId)
        ),
      })
      const caller = request.caller
      await dispatchChatTurn(
        state,
        caller ? caller.capBody(body) : body,
        caller ? caller.reserveRemoteTurn : () => null,
        {
          guard: () => {
            guard()
            available()
          },
          started,
        }
      )
    },
    publish: (threadId, record, prompt) =>
      broadcastThreadResume({
        threadId,
        resume: record,
        ...(prompt ? { resumePrompt: prompt } : {}),
      }),
    onError: (error) =>
      logger.error({ err: error }, "chat resume scheduler failed"),
  })
  const observe = (event: LegacyProviderEvent) => scheduler.observe(event)
  eventBus.on("projected", observe)
  chatResumes.set(state, scheduler)
  try {
    scheduler.recover()
  } catch (error) {
    // Bootstrap cannot register the disposer until this returns.
    eventBus.off("projected", observe)
    chatResumes.delete(state)
    scheduler.dispose()
    throw error
  }
  return () => {
    eventBus.off("projected", observe)
    scheduler.dispose()
    if (chatResumes.get(state) === scheduler) chatResumes.delete(state)
  }
}

/** POST /chat/resume: the user's choice for a chat a limit or a restart stopped. */
export async function controlChatResume(
  state: AppState,
  threadId: string,
  action: ChatResumeAction,
  caller: ResumeCaller | null
): Promise<{ resume: ThreadResume | null }> {
  const scheduler = chatResumes.get(state)
  if (!scheduler)
    throw new HttpError(
      503,
      "Resuming chats is unavailable.",
      "resume_unavailable"
    )
  if (!state.threads.hasThread(threadId))
    throw new HttpError(404, "Chat not found.", "thread_not_found")
  try {
    return { resume: await scheduler.control(threadId, action, caller) }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(
      409,
      error instanceof Error ? error.message : String(error),
      "resume_failed"
    )
  }
}
