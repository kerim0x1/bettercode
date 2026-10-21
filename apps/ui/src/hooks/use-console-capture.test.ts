import { afterEach, describe, expect, it, vi } from "vitest"
import { useConsoleCapture, type ConsoleLog } from "./use-console-capture"

const effects = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
}))
const { sendReport } = vi.hoisted(() => ({
  sendReport: vi.fn().mockResolvedValue({ ok: true, retryAfterMs: 10_000 }),
}))
vi.mock("@/services/ipc-facade", () => ({
  ipcApi: { bugReport: { send: sendReport } },
}))
vi.mock("react", () => ({
  useEffect: (effect: () => () => void) => {
    effects.cleanup = effect()
  },
}))

afterEach(() => {
  effects.cleanup?.()
  effects.cleanup = undefined
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  sendReport.mockClear()
})

describe("capturing diagnostic errors", () => {
  it("reports renderer errors and rejections with recent logs, and removes listeners on cleanup", () => {
    vi.useFakeTimers()
    const listeners = new Map<string, (event: unknown) => void>()
    vi.stubGlobal("window", {
      addEventListener: (name: string, listener: (event: unknown) => void) =>
        listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    })
    vi.spyOn(console, "info").mockImplementation(() => {})
    useConsoleCapture(vi.fn())
    console.info("Opening the editor")
    const error = new Error("Renderer failure")
    listeners.get("error")?.({ error, message: error.message })
    expect(sendReport).toHaveBeenLastCalledWith({
      automatic: true,
      message: error.message,
      stack: error.stack,
      logs: expect.stringContaining("Opening the editor"),
    })
    listeners.get("unhandledrejection")?.({
      reason: new Error("Rejected operation"),
    })
    expect(sendReport).toHaveBeenCalledTimes(2)
    expect(sendReport.mock.lastCall?.[0].message).toBe("Rejected operation")
    effects.cleanup?.()
    expect(listeners.size).toBe(0)
    effects.cleanup = undefined
  })
  it("retains Error messages and stacks for the report while forwarding to the console", () => {
    vi.useFakeTimers()
    const originalError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {})
    let logs: ConsoleLog[] = []
    useConsoleCapture((update) => {
      logs = typeof update === "function" ? update(logs) : update
    })
    const error = new Error("Could not open preview")
    console.error("Preview failed:", error)
    vi.advanceTimersByTime(150)
    expect(originalError).toHaveBeenCalledWith("Preview failed:", error)
    expect(logs).toHaveLength(1)
    expect(logs[0].message).toBe(
      "Preview failed: Error: Could not open preview"
    )
    expect(logs[0].stack).toBe(error.stack)
    expect(logs[0].type).toBe("error")
  })

  it("keeps plain messages working and bounds unusually large error stacks", () => {
    vi.useFakeTimers()
    vi.spyOn(console, "error").mockImplementation(() => {})
    let logs: ConsoleLog[] = []
    useConsoleCapture((update) => {
      logs = typeof update === "function" ? update(logs) : update
    })
    console.error("A plain error message")
    const error = new Error("Large error")
    error.stack = "x".repeat(20_000)
    console.error(error)
    vi.advanceTimersByTime(150)
    expect(logs[0].message).toBe("A plain error message")
    expect(logs[0].stack).toBeUndefined()
    expect(logs[1].stack).toHaveLength(16_000)
  })
})
