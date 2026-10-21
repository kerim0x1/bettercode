/**
 * Autonomous Work transport: one function per `/chat/autonomy/*` endpoint,
 * nothing else. The backend schedules a run's turns
 * (apps/backend services/chat/autonomy-runtime.ts); the renderer starts,
 * pauses, resumes and stops it and mirrors its state
 * (`@/lib/chat/autonomy-sync`). Keep store and hook imports out of this
 * module, as in `chatApi.ts`.
 */
import { invokeContract } from "./contracts"

/**
 * Body of `/chat/autonomy/start` and `/chat/autonomy/resume`: a chat send
 * body (`chatSendSchema`), plus `autonomy` (tasks and limits) for a start.
 */
export type AutonomyDispatchBody = Readonly<Record<string, unknown>>

/** Sends the run's opening message; it may wait as long as `/chat/send`. */
export const postChatAutonomyStart = (body: AutonomyDispatchBody) =>
  invokeContract("chatAutonomyStart", {
    timeoutMs: 210_000,
    method: "POST",
    body,
  })

export const postChatAutonomyResume = (body: AutonomyDispatchBody) =>
  invokeContract("chatAutonomyResume", { method: "POST", body })

export const postChatAutonomyPause = (threadId: string) =>
  invokeContract("chatAutonomyPause", { method: "POST", body: { threadId } })

export const postChatAutonomyStop = (threadId: string) =>
  invokeContract("chatAutonomyStop", { method: "POST", body: { threadId } })

export const postChatAutonomyTask = (
  threadId: string,
  taskId: string,
  done: boolean
) =>
  invokeContract("chatAutonomyTask", {
    method: "POST",
    body: { threadId, taskId, done },
  })
