/**
 * The Autonomous Work controls (status bar): each asks the backend, which
 * owns the run, and mirrors the run it answers with. The run's start is
 * the opening message itself (the dialog sends it through the composer's
 * submit with `autonomy`, see `sendChatMessage`).
 */
import { useChatStore } from "@/lib/chat-store"
import { sendChatMessage } from "@/lib/chat/send-message"
import { coerceThinkingModeForModel } from "@/lib/model-capabilities"
import type { UiProvider } from "@/lib/provider-types"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import {
  postChatAutonomyPause,
  postChatAutonomyStop,
  postChatAutonomyTask,
} from "@/services/backend/autonomyApi"

/** No further turn; one already running finishes. */
export async function pauseAutonomousRun(threadId: string): Promise<void> {
  const { autonomy } = await postChatAutonomyPause(threadId)
  useChatStore.getState().setThreadAutonomy(threadId, autonomy)
}

/** Ends the run without a summary; the status bar goes away. */
export async function stopAutonomousRun(threadId: string): Promise<void> {
  const { autonomy } = await postChatAutonomyStop(threadId)
  useChatStore.getState().setThreadAutonomy(threadId, autonomy)
}

/** Ticks a task off by hand (the model forgot its marker), or reopens it. */
export async function setAutonomousTaskDone(
  threadId: string,
  taskId: string,
  done: boolean
): Promise<void> {
  const { autonomy } = await postChatAutonomyTask(threadId, taskId, done)
  useChatStore.getState().setThreadAutonomy(threadId, autonomy)
}

/** The chat's composer selection the run continues with. */
export interface AutonomousResumeSettings {
  readonly provider: UiProvider | undefined
  readonly modelId: string
  readonly thinkingMode: string | null
  readonly chatMode: string
  readonly specialMode: string | null
  readonly permissionLevel: string
  readonly contextWindow?: string | null
  readonly projectPath?: string | null
  readonly appMode?: "agent" | "editor" | "design"
}

/**
 * Continues a paused run with the chat's current provider, model and
 * permission level, resolved as the renderer's own loop resolved them for
 * each follow-up. The backend sends the next turn once the chat is idle.
 */
export async function resumeAutonomousRun(
  threadId: string,
  settings: AutonomousResumeSettings
): Promise<void> {
  const target = await resolveProviderTarget(
    settings.provider,
    settings.modelId
  )
  const modelId =
    target.providerKind !== "openrouter" && settings.modelId.includes("/")
      ? (settings.modelId.split("/").pop() ?? settings.modelId)
      : settings.modelId
  await sendChatMessage(
    threadId,
    "Resume Autonomous Work",
    modelId,
    target.providerKind,
    coerceThinkingModeForModel(
      settings.provider,
      settings.modelId,
      settings.thinkingMode
    ),
    settings.chatMode,
    settings.projectPath ?? null,
    settings.specialMode,
    settings.permissionLevel,
    target.openaiTransport,
    null,
    target.providerInstanceId,
    settings.contextWindow ?? null,
    null,
    null,
    null,
    settings.appMode,
    undefined,
    undefined,
    null,
    null,
    undefined,
    { action: "resume" }
  )
}
