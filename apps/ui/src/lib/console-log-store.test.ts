import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  countConsoleErrors,
  useConsoleLogStore,
  type ConsoleLog,
} from "./console-log-store"

const initial = useConsoleLogStore.getState()
const log = (type: ConsoleLog["type"], message: string): ConsoleLog => ({
  type,
  message,
  timestamp: new Date("2026-10-07T00:00:00Z"),
})

beforeEach(() => {
  useConsoleLogStore.setState(initial, true)
})

describe("console log store", () => {
  it("appends flushed batches through an updater, as the capture hook does", () => {
    const { setLogs } = useConsoleLogStore.getState()
    setLogs((previous) => [...previous, log("info", "one")])
    setLogs((previous) => [...previous, log("error", "two")])
    expect(
      useConsoleLogStore.getState().logs.map((entry) => entry.message)
    ).toEqual(["one", "two"])
    setLogs([])
    expect(useConsoleLogStore.getState().logs).toEqual([])
  })

  it("does not notify subscribers for an unchanged list or tab", () => {
    const listener = vi.fn()
    const unsubscribe = useConsoleLogStore.subscribe(listener)
    const { setLogs, setTab } = useConsoleLogStore.getState()
    setLogs((previous) => previous)
    setTab("console")
    expect(listener).not.toHaveBeenCalled()
    setTab("report")
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("counts only error entries", () => {
    expect(
      countConsoleErrors([
        log("error", "a"),
        log("warn", "b"),
        log("error", "c"),
        log("debug", "d"),
      ])
    ).toBe(2)
    expect(countConsoleErrors([])).toBe(0)
  })
})
