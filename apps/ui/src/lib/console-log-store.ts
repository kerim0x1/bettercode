import type { SetStateAction } from "react"
import { create } from "zustand"

export type ConsoleLog = {
  type: "log" | "warn" | "error" | "info" | "debug"
  message: string
  stack?: string
  timestamp: Date
}

export type ConsoleTab = "console" | "report"

/**
 * The in-app console's captured log stream and its selected tab.
 *
 * `useConsoleCapture` flushes batches here. Keeping the stream out of the
 * app-shell hook means a flush re-renders only the console panel and the
 * title bar's counts, not the whole shell.
 */
export interface ConsoleLogState {
  logs: ConsoleLog[]
  tab: ConsoleTab
  setLogs: (value: SetStateAction<ConsoleLog[]>) => void
  setTab: (tab: ConsoleTab) => void
}

export const useConsoleLogStore = create<ConsoleLogState>()((set, get) => ({
  logs: [],
  tab: "console",
  setLogs: (value) => {
    const previous = get().logs
    const next = typeof value === "function" ? value(previous) : value
    if (next !== previous) set({ logs: next })
  },
  setTab: (tab) => {
    if (get().tab !== tab) set({ tab })
  },
}))

/** Number of captured `console.error` entries. */
export function countConsoleErrors(logs: readonly ConsoleLog[]): number {
  let count = 0
  for (const log of logs) if (log.type === "error") count += 1
  return count
}
