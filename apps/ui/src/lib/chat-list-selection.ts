import { create } from "zustand"

/**
 * Multi-select in the sidebar's chat lists: Ctrl/Cmd+click (or Space on a
 * focused row) toggles a chat, Shift+click (Shift+Space) selects the range
 * from the last toggled chat in the list's visible order, Escape clears.
 * The bulk bar acts on the selection. Pure edits plus a small store.
 */

export interface ChatSelection {
  ids: string[]
  /** Where a Shift range starts: the last chat toggled. */
  anchor: string | null
}

const EMPTY: ChatSelection = { ids: [], anchor: null }

export function toggleChatSelection(
  selection: ChatSelection,
  threadId: string
): ChatSelection {
  const selected = selection.ids.includes(threadId)
  return {
    ids: selected
      ? selection.ids.filter((id) => id !== threadId)
      : [...selection.ids, threadId],
    anchor: threadId,
  }
}

/**
 * The chats from the anchor to `threadId` in `order`, replacing the
 * selection. Without an anchor in `order` it toggles `threadId` instead.
 */
export function rangeChatSelection(
  selection: ChatSelection,
  order: readonly string[],
  threadId: string
): ChatSelection {
  const from = selection.anchor ? order.indexOf(selection.anchor) : -1
  const to = order.indexOf(threadId)
  if (from < 0 || to < 0) return toggleChatSelection(selection, threadId)
  const [start, end] = from <= to ? [from, to] : [to, from]
  return { ids: order.slice(start, end + 1), anchor: selection.anchor }
}

/** Drops chats the list no longer shows (deleted, archived, filtered). */
export function pruneChatSelection(
  selection: ChatSelection,
  shown: ReadonlySet<string>
): ChatSelection {
  const ids = selection.ids.filter((id) => shown.has(id))
  const anchor =
    selection.anchor && shown.has(selection.anchor) ? selection.anchor : null
  if (ids.length === selection.ids.length && anchor === selection.anchor) {
    return selection
  }
  return { ids, anchor }
}

interface ChatSelectionState extends ChatSelection {
  toggle: (threadId: string) => void
  selectRange: (order: readonly string[], threadId: string) => void
  prune: (shown: ReadonlySet<string>) => void
  clear: () => void
}

export const useChatSelectionStore = create<ChatSelectionState>((set, get) => ({
  ...EMPTY,
  toggle: (threadId) => set(toggleChatSelection(get(), threadId)),
  selectRange: (order, threadId) =>
    set(rangeChatSelection(get(), order, threadId)),
  prune: (shown) => {
    const current = get()
    const next = pruneChatSelection(current, shown)
    if (next !== current) set(next)
  },
  clear: () => {
    if (get().ids.length > 0 || get().anchor !== null) set(EMPTY)
  },
}))
