import { create } from "zustand"
import { clearSnoozeOnOpen } from "@/lib/chat-list-actions"
import { useChatStore } from "@/lib/chat-store"

/**
 * The sidebar chat list's visible order (pinned chats first, then open
 * folders or projects, the feed and an open Inactive section), published
 * by whichever layout is shown. Ctrl/Cmd+1…9 opens the 1st…9th chat in it,
 * and Shift+click selects ranges along it. A split pane grid keeps
 * Ctrl+1…8 for its panes, so the jump only applies with one pane
 * (`hooks/use-panes.ts`); holding Ctrl/Cmd shows the numbers on the rows.
 */

interface ChatListNavState {
  order: string[]
  /** The layout that published `order`, so an unmounting one can clear it. */
  owner: string | null
  /** Ctrl/Cmd is held: rows show their quick-jump number. */
  hintsVisible: boolean
  /** One pane in the Agent grid: Ctrl/Cmd+number opens chats. */
  jumpAvailable: boolean
}

export const useChatListNavStore = create<ChatListNavState>(() => ({
  order: [],
  owner: null,
  hintsVisible: false,
  jumpAvailable: true,
}))

/** Chats the quick jump reaches. */
export const CHAT_JUMP_SLOTS = 9

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

export function publishChatListOrder(owner: string, order: string[]): void {
  const current = useChatListNavStore.getState()
  if (current.owner === owner && sameOrder(current.order, order)) return
  useChatListNavStore.setState({ owner, order })
}

export function releaseChatListOrder(owner: string): void {
  if (useChatListNavStore.getState().owner !== owner) return
  useChatListNavStore.setState({ owner: null, order: [] })
}

export function setChatJumpAvailable(available: boolean): void {
  if (useChatListNavStore.getState().jumpAvailable === available) return
  useChatListNavStore.setState({ jumpAvailable: available })
}

export function setChatJumpHintsVisible(visible: boolean): void {
  if (useChatListNavStore.getState().hintsVisible === visible) return
  useChatListNavStore.setState({ hintsVisible: visible })
}

/**
 * The slot (1–9) a Ctrl/Cmd+digit press asks for, or null. Reads the
 * physical key first so layouts whose digit row needs Shift still work.
 */
export function chatSlotFromKeyEvent(event: {
  code?: string
  key?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}): number | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
    return null
  }
  const fromCode = /^(?:Digit|Numpad)([1-9])$/.exec(event.code ?? "")?.[1]
  const fromKey = /^[1-9]$/.test(event.key ?? "") ? event.key : undefined
  const digit = fromCode ?? fromKey
  return digit ? Number(digit) : null
}

/**
 * Opens a chat the way a sidebar row does (pane or composer tab). Opening
 * ends its snooze, also when it already was the open chat.
 */
export function openChatFromList(threadId: string, title?: string): void {
  clearSnoozeOnOpen(threadId)
  useChatStore.getState().setActiveThread(threadId)
  window.dispatchEvent(
    new CustomEvent("betterc0de:open-thread", {
      detail: { threadId, label: title },
    })
  )
}

/** Opens the chat in that slot of the visible order; false when none. */
export function openChatListSlot(slot: number): boolean {
  if (!Number.isInteger(slot) || slot < 1 || slot > CHAT_JUMP_SLOTS) {
    return false
  }
  const threadId = useChatListNavStore.getState().order[slot - 1]
  if (!threadId) return false
  const thread = useChatStore
    .getState()
    .threads.find((candidate) => candidate.id === threadId)
  if (!thread) return false
  openChatFromList(threadId, thread.title || undefined)
  return true
}
