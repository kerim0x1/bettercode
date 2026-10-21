import { create } from "zustand"

/**
 * Open state of the chat lists' own dialogs: the custom snooze time and
 * the Archived chats view. Both are mounted once with the left sidebar, so
 * the sidebar's menus, the bulk bar and Settings can open them.
 *
 * Opening waits a tick, like the prompt dialog: callers sit in Radix menus
 * that close in the same tick and hand focus back to their trigger, which
 * a dialog opened at once would take as an outside interaction and close.
 */

interface ChatListDialogsState {
  /** Chats the custom snooze dialog is for, or null while closed. */
  snoozeThreadIds: string[] | null
  archivedOpen: boolean
}

export const useChatListDialogsStore = create<ChatListDialogsState>(() => ({
  snoozeThreadIds: null,
  archivedOpen: false,
}))

export function openCustomSnooze(threadIds: readonly string[]): void {
  if (threadIds.length === 0) return
  const ids = [...threadIds]
  setTimeout(() => {
    useChatListDialogsStore.setState({ snoozeThreadIds: ids })
  }, 0)
}

export function closeCustomSnooze(): void {
  useChatListDialogsStore.setState({ snoozeThreadIds: null })
}

export function openArchivedChats(): void {
  setTimeout(() => {
    useChatListDialogsStore.setState({ archivedOpen: true })
  }, 0)
}

export function setArchivedChatsOpen(open: boolean): void {
  useChatListDialogsStore.setState({ archivedOpen: open })
}
