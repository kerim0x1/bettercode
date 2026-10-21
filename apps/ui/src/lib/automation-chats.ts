import type { ChatThread } from "@betterc0de/schema"
import { useChatStore } from "@/lib/chat-store"
import { HttpError } from "@/lib/errors/types"
import { loadAutomationRunChat } from "@/services/backend/automations-api"

/**
 * Automation runs start their chats in the backend, while this window may
 * be open with the chat list it loaded at startup. These helpers add such
 * chats to the list (without their messages, which load when opened), the
 * way the startup load does.
 */

/** Adds the chats the list does not know yet; ones already there are kept. */
export function addAutomationChats(threads: readonly ChatThread[]): void {
  if (threads.length === 0) return
  useChatStore.setState((state) => {
    const present = new Set(state.threads.map((thread) => thread.id))
    const added = threads
      .filter((thread) => !present.has(thread.id))
      .map((thread) => ({ ...thread, messages: [] }))
    return added.length > 0 ? { threads: [...state.threads, ...added] } : state
  })
}

/** Run chats the backend no longer has (deleted), not asked for again. */
const deletedChats = new Set<string>()

/** Loads and adds the run chats in `threadIds` the list does not have. */
export async function ensureAutomationChats(
  threadIds: readonly string[]
): Promise<void> {
  const known = new Set(
    useChatStore.getState().threads.map((thread) => thread.id)
  )
  const missing = [...new Set(threadIds)].filter(
    (threadId) =>
      threadId && !known.has(threadId) && !deletedChats.has(threadId)
  )
  if (missing.length === 0) return
  const loaded = await Promise.all(
    missing.map((threadId) =>
      loadAutomationRunChat(threadId).catch((error: unknown) => {
        if (error instanceof HttpError && error.status === 404) {
          deletedChats.add(threadId)
        }
        return null
      })
    )
  )
  addAutomationChats(
    loaded.filter((thread): thread is ChatThread => thread !== null)
  )
}

/**
 * Opens a run's chat, adding it to the chat list first when needed.
 * Resolves to `false` when the chat no longer exists.
 */
export async function openAutomationChat(
  threadId: string,
  label: string
): Promise<boolean> {
  await ensureAutomationChats([threadId])
  const store = useChatStore.getState()
  if (!store.threads.some((thread) => thread.id === threadId)) return false
  store.setActiveThread(threadId)
  window.dispatchEvent(
    new CustomEvent("betterc0de:open-thread", {
      detail: { threadId, label },
    })
  )
  return true
}
