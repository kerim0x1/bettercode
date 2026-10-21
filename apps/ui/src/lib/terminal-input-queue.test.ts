import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalInputQueue } from "./terminal-input-queue"

interface PendingWrite {
  data: string
  resolve: () => void
  reject: (error: unknown) => void
}

function harness(
  options: { maxChunkChars?: number; maxBacklogChars?: number } = {}
) {
  const writes: PendingWrite[] = []
  const onSent = vi.fn()
  const onFailed = vi.fn()
  const queue = new TerminalInputQueue({
    send: (data) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ data, resolve, reject })
      }),
    onSent,
    onFailed,
    isRetryable: (error) => error === "busy",
    retryDelayMs: () => 100,
    ...options,
  })
  return { queue, writes, onSent, onFailed }
}

/** Lets the queue's promise callbacks run. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("TerminalInputQueue", () => {
  it("keeps one write on its way and sends what was typed meanwhile together", async () => {
    const { queue, writes, onSent } = harness()
    queue.push("l")
    queue.push("s")
    queue.push("\r")
    expect(writes.map((write) => write.data)).toEqual(["l"])
    expect(queue.backlog).toBe(2)

    writes[0]!.resolve()
    await settle()
    expect(onSent).toHaveBeenCalledTimes(1)
    expect(writes.map((write) => write.data)).toEqual(["l", "s\r"])
  })

  it("sends a refused write again before anything typed after it", async () => {
    const { queue, writes, onFailed } = harness()
    queue.push("ab")
    queue.push("c")
    writes[0]!.reject("busy")
    await settle()
    queue.push("d")
    expect(writes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(100)
    expect(writes.map((write) => write.data)).toEqual(["ab", "abcd"])
    expect(onFailed).not.toHaveBeenCalled()
  })

  it("drops its input and reports once a write fails for good", async () => {
    const { queue, writes, onFailed } = harness()
    queue.push("x")
    queue.push("y")
    const gone = new Error("Terminal session not found.")
    writes[0]!.reject(gone)
    await settle()
    expect(onFailed).toHaveBeenCalledWith(gone)
    expect(queue.backlog).toBe(0)
    expect(writes).toHaveLength(1)
  })

  it("splits a large paste into writes of the route's size", async () => {
    const { queue, writes } = harness({ maxChunkChars: 4 })
    queue.push("0123456789")
    expect(writes.map((write) => write.data)).toEqual(["0123"])
    writes[0]!.resolve()
    await settle()
    writes[1]!.resolve()
    await settle()
    expect(writes.map((write) => write.data)).toEqual(["0123", "4567", "89"])
  })

  it("refuses input past its backlog and after disposal", () => {
    const { queue, writes } = harness({ maxBacklogChars: 4 })
    expect(queue.push("12345")).toBe(false)
    expect(queue.push("1234")).toBe(true)
    queue.dispose()
    expect(queue.push("5")).toBe(false)
    expect(writes).toHaveLength(1)
  })
})
