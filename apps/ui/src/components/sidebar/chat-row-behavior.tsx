import {
  useCallback,
  useEffect,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react"
import { AlarmClockIcon, PencilLineIcon } from "lucide-react"
import { create } from "zustand"
import type { SnoozedChat } from "@betterc0de/schema"
import { THREAD_DRAG_TYPE } from "@/components/layout/panes/pane-drop-zone"
import { clearSnoozeOnOpen } from "@/lib/chat-list-actions"
import { nextSnoozeWake } from "@/lib/chat-snooze"
import { useChatStore } from "@/lib/chat-store"
import { useChatListNavStore, CHAT_JUMP_SLOTS } from "@/lib/chat-list-nav"
import { useChatSelectionStore } from "@/lib/chat-list-selection"
import { cn } from "@/lib/utils"

/**
 * What every chat row in the sidebar's lists does besides showing the chat:
 * click opens it, Ctrl/Cmd+click and Shift+click select (Space and
 * Shift+Space on a focused row), the arrow keys move between rows, a right
 * click or the context-menu key opens its action menu, and dragging carries
 * the whole selection when the row is part of it. Plus the small marks a
 * row can carry: Back (from a snooze), Draft, and its Ctrl/Cmd+number while
 * the key is held.
 */

/** Rows are focusable options inside a `listbox` per section. */
export const CHAT_ROW_SELECTOR = "[data-chat-row]"

/** The drag payload's chats: a dragged selection, or the one row. */
export function draggedThreadIds(event: DragEvent): string[] {
  try {
    const raw = event.dataTransfer.getData(THREAD_DRAG_TYPE)
    if (!raw) return []
    const payload = JSON.parse(raw) as {
      threadId?: unknown
      threadIds?: unknown
    }
    if (Array.isArray(payload.threadIds)) {
      const ids = payload.threadIds.filter(
        (id): id is string => typeof id === "string"
      )
      if (ids.length > 0) return ids
    }
    return typeof payload.threadId === "string" ? [payload.threadId] : []
  } catch {
    return []
  }
}

/**
 * The chats a sidebar row is dragging right now, so drop targets in other
 * sections (Pinned) accept only the list's own drags. Cleared when the
 * drag ends anywhere, also when its row moved and unmounted meanwhile.
 */
export const useChatDragStore = create<{ ids: string[] | null }>(() => ({
  ids: null,
}))

function endChatDrag(): void {
  setTimeout(() => useChatDragStore.setState({ ids: null }), 0)
}

function moveRowFocus(row: HTMLElement, step: 1 | -1): void {
  const scope = row.closest("[data-chat-list]") ?? document
  const rows = [...scope.querySelectorAll<HTMLElement>(CHAT_ROW_SELECTOR)]
  const index = rows.indexOf(row)
  rows[index + step]?.focus()
}

export function useChatRowBehavior({
  threadId,
  title,
  openThread,
}: {
  threadId: string
  title: string
  openThread: (threadId: string, title?: string) => void
}) {
  const selected = useChatSelectionStore((state) =>
    state.ids.includes(threadId)
  )
  // The row's action menu, controlled so a right click can open it.
  const [menuOpen, setMenuOpen] = useState(false)

  const open = useCallback(() => {
    useChatSelectionStore.getState().clear()
    openThread(threadId, title || undefined)
  }, [openThread, threadId, title])

  const selectRange = useCallback(() => {
    window.getSelection()?.removeAllRanges()
    useChatSelectionStore
      .getState()
      .selectRange(useChatListNavStore.getState().order, threadId)
  }, [threadId])

  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        useChatSelectionStore.getState().toggle(threadId)
        return
      }
      if (event.shiftKey) {
        event.preventDefault()
        selectRange()
        return
      }
      open()
    },
    [open, selectRange, threadId]
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      // Keys typed in the row's menus and cards bubble here through their
      // portals; only the focused row itself counts.
      if (event.target !== event.currentTarget) return
      if (event.key === "Enter") {
        event.preventDefault()
        if (event.ctrlKey || event.metaKey) {
          useChatSelectionStore.getState().toggle(threadId)
        } else {
          open()
        }
      } else if (event.key === " ") {
        event.preventDefault()
        if (event.shiftKey) selectRange()
        else useChatSelectionStore.getState().toggle(threadId)
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        moveRowFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1)
      } else if (
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")
      ) {
        event.preventDefault()
        setMenuOpen(true)
      }
    },
    [open, selectRange, threadId]
  )

  const onContextMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.target as Node)) return
    event.preventDefault()
    setMenuOpen(true)
  }, [])

  const onDragStart = useCallback(
    (event: DragEvent<HTMLElement>) => {
      const selection = useChatSelectionStore.getState().ids
      const ids =
        selection.length > 1 && selection.includes(threadId)
          ? selection
          : [threadId]
      event.dataTransfer.effectAllowed = "copyMove"
      event.dataTransfer.setData(
        THREAD_DRAG_TYPE,
        JSON.stringify({
          threadId,
          label: title,
          ...(ids.length > 1 ? { threadIds: ids } : {}),
        })
      )
      useChatDragStore.setState({ ids: [...ids] })
      window.addEventListener("dragend", endChatDrag, {
        capture: true,
        once: true,
      })
      window.addEventListener("drop", endChatDrag, {
        capture: true,
        once: true,
      })
    },
    [threadId, title]
  )

  return {
    selected,
    menuOpen,
    setMenuOpen,
    rowProps: {
      role: "option" as const,
      "aria-selected": selected,
      tabIndex: 0,
      "data-chat-row": threadId,
      draggable: true,
      onClick,
      onKeyDown,
      onContextMenu,
      onDragStart,
    },
  }
}

/** The selected look, over the row's hover and open fills. */
export const SELECTED_ROW_CLASS =
  "bg-primary/10 ring-1 ring-primary/30 ring-inset hover:bg-primary/[0.14]"

/** Keyboard focus for a row (they have no border to carry it). */
export const ROW_FOCUS_CLASS =
  "outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"

/**
 * A chat back from a snooze loses its mark once it is the open chat, also
 * when it came back while already open.
 */
export function useClearBackWhenActive(
  threadId: string,
  active: boolean,
  back: boolean
): void {
  useEffect(() => {
    if (active && back) clearSnoozeOnOpen(threadId)
  }, [active, back, threadId])
}

/**
 * Re-renders the list when the next snoozed chat is due, so it comes back
 * on time without waiting for another change.
 */
export function useSnoozeWakeTick(entries: readonly SnoozedChat[]): void {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const next = nextSnoozeWake(entries, Date.now())
    if (next === null) return
    // setTimeout holds at most ~24.8 days; a later wake re-arms on the tick.
    const delay = Math.min(2_147_483_000, Math.max(0, next - Date.now()) + 250)
    const timer = setTimeout(() => setTick((value) => value + 1), delay)
    return () => clearTimeout(timer)
  }, [entries, tick])
}

/** An unsent draft in a chat that is not the open one. */
export function useChatHasDraft(threadId: string): boolean {
  return useChatStore(
    (state) =>
      state.activeThreadId !== threadId &&
      (state.draftsByThread[threadId]?.trim().length ?? 0) > 0
  )
}

/** The chat's Ctrl/Cmd+number while the key is held, else null. */
export function useChatJumpSlot(threadId: string): number | null {
  return useChatListNavStore((state) => {
    if (!state.hintsVisible || !state.jumpAvailable) return null
    const index = state.order.indexOf(threadId)
    return index >= 0 && index < CHAT_JUMP_SLOTS ? index + 1 : null
  })
}

/** The number a held Ctrl/Cmd jumps to, in place of the row's age. */
export function ChatJumpHint({
  slot,
  className,
}: {
  slot: number
  className?: string
}) {
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        "inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-[4px] bg-foreground/[0.08] px-1 font-mono text-[10px] leading-none font-medium text-sidebar-foreground/80",
        className
      )}
    >
      {slot}
    </kbd>
  )
}

/** "Back" after a snooze ended, until the chat is opened. */
export function ChatBackMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-0.5 text-[10px] leading-4 font-medium text-primary",
        className
      )}
      title="Back from snooze"
    >
      <AlarmClockIcon aria-hidden="true" className="size-3" strokeWidth={2} />
      Back
      <span className="sr-only"> from snooze</span>
    </span>
  )
}

/** An unsent draft: a pencil and a muted label. */
export function ChatDraftMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-0.5 text-[10px] leading-4 text-sidebar-foreground/45",
        className
      )}
      title="Unsent draft"
    >
      <PencilLineIcon
        aria-hidden="true"
        className="size-3"
        strokeWidth={1.75}
      />
      Draft
    </span>
  )
}
