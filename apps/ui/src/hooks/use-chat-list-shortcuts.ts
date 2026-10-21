import { useEffect } from "react"
import {
  clearSnoozeOnOpen,
  forgetDeletedChats,
  undoChatListChange,
} from "@/lib/chat-list-actions"
import { useChatListDialogsStore } from "@/lib/chat-list-dialogs"
import {
  setChatJumpHintsVisible,
  useChatListNavStore,
} from "@/lib/chat-list-nav"
import { useChatSelectionStore } from "@/lib/chat-list-selection"
import { useChatStore } from "@/lib/chat-store"
import { pendingThreadDeletes } from "@/lib/pending-thread-deletes"
import { usePreferencesStore } from "@/lib/preferences-store"
import { whenBackendReady } from "@/services/backend/runtime"

/**
 * Window-wide behavior of the sidebar's chat lists, installed once by the
 * left sidebar:
 *
 * - Ctrl/Cmd+Z undoes the newest chat list change (archive, delete, pin,
 *   snooze, filing, folder removal) in Agent mode or in the Archived chats
 *   view, unless focus is in a text field, editor or terminal, which keep
 *   their own undo.
 * - Escape clears a multi-selection when focus is not in a field, menu or
 *   dialog.
 * - Holding Ctrl/Cmd alone for a moment shows the Ctrl/Cmd+1…9 numbers on
 *   the rows (the jump itself is in `use-panes.ts`).
 * - Deletions still waiting for their undo window run when the window
 *   closes or reloads, and ones journaled at the last quit run at start.
 * - Chats that leave the chat store (deleted anywhere) are forgotten in the
 *   pins, snoozes, folders and archive; opening a chat ends its snooze.
 */

/** How long Ctrl/Cmd is held alone before the numbers appear. */
const HINT_DELAY_MS = 450

function isTextEntry(target: Element | null): boolean {
  if (!target) return false
  if (target.closest("[contenteditable='true'], .monaco-editor")) return true
  if (target.closest(".betterc0de-terminal")) return true
  const element = target.closest("input, textarea, select")
  if (!element) return false
  if (element instanceof HTMLInputElement) {
    return !element.readOnly && !element.disabled
  }
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return !element.disabled
  }
  return true
}

export function useChatListShortcuts(): void {
  useEffect(() => {
    let hintTimer: ReturnType<typeof setTimeout> | null = null
    const hideHints = () => {
      if (hintTimer !== null) {
        clearTimeout(hintTimer)
        hintTimer = null
      }
      setChatJumpHintsVisible(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (event.key === "Control" || event.key === "Meta") {
        if (
          !event.repeat &&
          !event.altKey &&
          !event.shiftKey &&
          usePreferencesStore.getState().appMode === "agent" &&
          useChatListNavStore.getState().jumpAvailable
        ) {
          if (hintTimer !== null) clearTimeout(hintTimer)
          hintTimer = setTimeout(() => {
            hintTimer = null
            setChatJumpHintsVisible(true)
          }, HINT_DELAY_MS)
        }
        return
      }
      // Any other key: Ctrl was a modifier, not a request for the numbers.
      hideHints()
      if (event.defaultPrevented) return

      const ctrl = event.ctrlKey || event.metaKey
      if (
        ctrl &&
        !event.shiftKey &&
        !event.altKey &&
        (event.code === "KeyZ" || event.key.toLowerCase() === "z")
      ) {
        if (isTextEntry(target)) return
        const archivedOpen = useChatListDialogsStore.getState().archivedOpen
        if (!archivedOpen) {
          if (usePreferencesStore.getState().appMode !== "agent") return
          if (target?.closest("[role='dialog']")) return
        }
        if (undoChatListChange()) event.preventDefault()
        return
      }

      if (
        event.key === "Escape" &&
        !ctrl &&
        !event.altKey &&
        !event.shiftKey &&
        useChatSelectionStore.getState().ids.length > 0
      ) {
        if (isTextEntry(target)) return
        if (target?.closest("[role='dialog'], [role='menu']")) return
        useChatSelectionStore.getState().clear()
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta") hideHints()
    }

    const flush = () => pendingThreadDeletes.flush()

    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", hideHints)
    window.addEventListener("pagehide", flush)
    window.addEventListener("beforeunload", flush)

    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (
        state.threads !== previous.threads &&
        state.threads.length < previous.threads.length
      ) {
        const remaining = new Set(state.threads.map((thread) => thread.id))
        const removed = previous.threads
          .filter((thread) => !remaining.has(thread.id))
          .map((thread) => thread.id)
        if (removed.length > 0) forgetDeletedChats(removed)
      }
      if (
        state.activeThreadId &&
        state.activeThreadId !== previous.activeThreadId
      ) {
        clearSnoozeOnOpen(state.activeThreadId)
      }
    })

    const controller = new AbortController()
    whenBackendReady(controller.signal).then(
      () => {
        if (!controller.signal.aborted) pendingThreadDeletes.resume()
      },
      () => {}
    )

    return () => {
      hideHints()
      controller.abort()
      unsubscribe()
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", hideHints)
      window.removeEventListener("pagehide", flush)
      window.removeEventListener("beforeunload", flush)
    }
  }, [])
}
