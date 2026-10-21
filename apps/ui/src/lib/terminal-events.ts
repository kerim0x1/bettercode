import { useChatStore } from "@/lib/chat-store"

export const TERMINAL_NEW_SESSION_EVENT = "betterc0de:terminal-new-session"
export const TERMINAL_CLOSE_ACTIVE_SESSION_EVENT =
  "betterc0de:terminal-close-active-session"
export const TERMINAL_SPLIT_EVENT = "betterc0de:terminal-split"

export interface TerminalNewSessionEventDetail {
  mode?: "agent" | "editor" | "design"
  cwd?: string | null
  shell?: string | null
  initialCommand?: string | null
  targetPanelId?: string | null
  threadId?: string | null
}

export function terminalSessionTargetsPanel(
  detail: TerminalNewSessionEventDetail,
  panel: {
    id: string
    mode: "agent" | "editor" | "design"
    threadId?: string | null
  }
): boolean {
  if (detail.mode && detail.mode !== panel.mode) return false
  if (detail.targetPanelId) return detail.targetPanelId === panel.id
  return panel.threadId === undefined || detail.threadId === panel.threadId
}

export interface TerminalCloseActiveSessionEventDetail {
  targetPanelId: string
}

/** Split the focused terminal of a panel: right (side by side) or down (stacked). */
export interface TerminalSplitEventDetail {
  targetPanelId: string
  direction: "right" | "down"
}

export function dispatchTerminalSplit(detail: TerminalSplitEventDetail): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<TerminalSplitEventDetail>(TERMINAL_SPLIT_EVENT, { detail })
  )
}

export function dispatchTerminalNewSession(
  detail: TerminalNewSessionEventDetail = {}
): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<TerminalNewSessionEventDetail>(TERMINAL_NEW_SESSION_EVENT, {
      detail: {
        ...detail,
        threadId:
          detail.threadId === undefined
            ? useChatStore.getState().activeThreadId
            : detail.threadId,
      },
    })
  )
}

export function dispatchTerminalCloseActiveSession(
  detail: TerminalCloseActiveSessionEventDetail
): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<TerminalCloseActiveSessionEventDetail>(
      TERMINAL_CLOSE_ACTIVE_SESSION_EVENT,
      { detail }
    )
  )
}
