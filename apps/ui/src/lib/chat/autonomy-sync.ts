/**
 * The renderer's mirror of the backend's Autonomous Work runs
 * (apps/backend services/chat/autonomy-runtime.ts). The backend schedules a
 * run's turns and reports the run with the chat: in the thread list
 * (`ChatThread.autonomy`), in the chat's `thread.metadata.updated` pushes
 * and in the answers to the controls (`@/lib/chat/autonomy-controls`). The
 * chat store keeps what it last heard (`autonomyByThread`); nothing here
 * decides when a turn is sent.
 */
import {
  autonomyPromptSchema,
  threadAutonomySchema,
  type AutonomyPrompt,
  type ChatThread,
} from "@betterc0de/schema"
import { useChatStore } from "@/lib/chat-store"
import type { ChatState } from "@/lib/chat/types"
import { providerKindFromPayload } from "@/lib/provider-events/payload"

type AutonomyByThread = ChatState["autonomyByThread"]

/**
 * Applies a `thread.metadata.updated` push. Only the backend's runtime
 * reports a run (a mutation id and no provider), so a provider's own
 * metadata never becomes one.
 */
export function applyAutonomyMetadata(
  threadId: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>
): void {
  if (
    typeof metadata.autonomyMutationId !== "string" ||
    providerKindFromPayload(payload)
  )
    return
  if (Object.prototype.hasOwnProperty.call(metadata, "autonomy")) {
    const parsed = threadAutonomySchema.nullable().safeParse(metadata.autonomy)
    if (parsed.success)
      useChatStore.getState().setThreadAutonomy(threadId, parsed.data)
  }
  const prompt = autonomyPromptSchema.safeParse(metadata.autonomyPrompt)
  if (prompt.success) showAutonomyPrompt(threadId, prompt.data)
}

/**
 * The user message of a turn the run just started (a follow-up or the
 * summary), shown before the reply streams in, as the renderer's own loop
 * used to add it. The backend has stored it: a chat whose transcript is
 * not loaded yet gets it with the transcript.
 */
function showAutonomyPrompt(threadId: string, prompt: AutonomyPrompt): void {
  const store = useChatStore.getState()
  if (!store.messagesLoadedByThread[threadId]) return
  const thread = store.threads.find((candidate) => candidate.id === threadId)
  if (
    !thread ||
    thread.messages.some((message) => message.id === prompt.messageId)
  )
    return
  store.addMessage(
    threadId,
    {
      id: prompt.messageId,
      role: "user",
      content: prompt.content,
      ...(prompt.modelId ? { modelId: prompt.modelId } : {}),
      createdAt: prompt.createdAt,
    },
    { persist: false }
  )
  if (prompt.modelId) store.setStreamingModelId(threadId, prompt.modelId)
}

/**
 * The runs of a freshly loaded thread list. A chat whose run a push changed
 * while the list loaded keeps the pushed state; a chat the list shows
 * without a run has none.
 */
export function mergePersistedThreadAutonomy(
  current: AutonomyByThread,
  persisted: ChatThread[],
  beforeLoad: AutonomyByThread
): AutonomyByThread {
  let next = current
  for (const thread of persisted) {
    if (current[thread.id] !== beforeLoad[thread.id]) continue
    const autonomy = thread.autonomy ?? undefined
    if (autonomy === current[thread.id]) continue
    if (next === current) next = { ...current }
    if (autonomy) next[thread.id] = autonomy
    else delete next[thread.id]
  }
  return next
}
