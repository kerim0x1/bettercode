import { create } from "zustand"
import { lastEditableQueuedMessage } from "@/lib/message-queue-editing"
import { useMessageQueueStore } from "@/lib/message-queue-store"

/**
 * Which queued message is open for inline editing above the composer. One
 * at a time; the edit itself is saved through the queue store.
 */
interface QueuedMessageEditorState {
  editingId: string | null
  start(id: string): void
  /** Closes the editor, or only `id`'s when given. */
  stop(id?: string): void
}

export const useQueuedMessageEditor = create<QueuedMessageEditorState>(
  (set, get) => ({
    editingId: null,
    start: (id) => set({ editingId: id }),
    stop: (id) => {
      if (id === undefined || get().editingId === id) set({ editingId: null })
    },
  })
)

/**
 * Whether the chat's next queued message is open in the editor. The queue
 * holds it until the edit closes, so the old text is not sent meanwhile.
 */
export function isQueueHeadBeingEdited(threadId: string): boolean {
  const editingId = useQueuedMessageEditor.getState().editingId
  if (!editingId) return false
  return (
    useMessageQueueStore
      .getState()
      .messages.find((message) => message.threadId === threadId)?.id ===
    editingId
  )
}

/**
 * Alt+Up in an empty composer edits the chat's last queued message. Returns
 * that message's id when the key event is this shortcut and there is one to
 * edit; the global Alt+Up/Down chat switching leaves such an event alone.
 */
export function queuedMessageForEditKey(event: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  target: EventTarget | null
}): string | null {
  if (
    event.key !== "ArrowUp" ||
    !event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return null
  const target = event.target
  if (
    typeof HTMLTextAreaElement === "undefined" ||
    !(target instanceof HTMLTextAreaElement) ||
    target.name !== "message" ||
    target.value !== ""
  )
    return null
  const threadId = target.closest<HTMLElement>("[data-composer-thread]")
    ?.dataset.composerThread
  if (!threadId) return null
  return (
    lastEditableQueuedMessage(
      useMessageQueueStore.getState().messages,
      threadId
    )?.id ?? null
  )
}
