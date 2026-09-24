import { TERMINAL_LIMITS } from "@betterc0de/schema/remote-terminal"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { takeChunk, TerminalClient } from "./terminal-client"

/** A desktop whose answers each test gives by hand. */
function fakeDesktop() {
  const calls: Array<{
    method: string
    params: Record<string, unknown>
    resolve(result: unknown): void
    reject(error: unknown): void
  }> = []
  const call = (method: string, params: unknown) =>
    new Promise((resolve, reject) => {
      calls.push({
        method,
        params: params as Record<string, unknown>,
        resolve,
        reject,
      })
    })
  const of = (method: string) => calls.filter((each) => each.method === method)
  return { calls, call, of }
}

const summary = (nextInputSeq = 1) => ({
  terminalId: "t1",
  cwd: "/repo",
  shell: "zsh",
  status: "running",
  openedAt: "2026-09-24T12:00:00.000Z",
  nextInputSeq,
})

const events = () => ({
  output: vi.fn(),
  gap: vi.fn(),
  exit: vi.fn(),
  closed: vi.fn(),
  failed: vi.fn(),
})

const output = (seq: number, text: string, terminalId = "t1") => ({
  channel: "terminal.output",
  data: { terminalId, seq, output: text },
})

const lost = () =>
  Object.assign(new Error("The connection to the desktop was lost."), {
    code: "connection_lost",
  })

async function opened() {
  const desktop = fakeDesktop()
  const on = events()
  const client = new TerminalClient(desktop.call, on)
  const opening = client.open("/repo", 80, 24)
  desktop.calls[0]!.resolve(summary())
  await opening
  return { desktop, on, client }
}

const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a terminal on the desktop, from the phone", () => {
  it("opens where it is asked to, and numbers input in the order it was typed", async () => {
    const { desktop, client } = await opened()
    expect(desktop.calls[0]).toMatchObject({
      method: "terminal.open",
      params: { cwd: "/repo", cols: 80, rows: 24 },
    })
    for (const key of ["l", "s", "\r"]) client.write(key)

    expect(desktop.of("terminal.write").map((each) => each.params)).toEqual([
      { terminalId: "t1", inputSeq: 1, data: "l" },
      { terminalId: "t1", inputSeq: 2, data: "s" },
      { terminalId: "t1", inputSeq: 3, data: "\r" },
    ])
  })

  it("has at most eight writes on their way, and gathers what waits", async () => {
    const { desktop, client } = await opened()
    for (const key of "abcdefghij") client.write(key)
    const writes = desktop.of("terminal.write")
    expect(writes).toHaveLength(8)

    writes[0]!.resolve({ applied: true })
    await settle()
    expect(desktop.of("terminal.write").at(-1)!.params).toEqual({
      terminalId: "t1",
      inputSeq: 9,
      data: "ij",
    })
  })

  it("shows each piece of output once, and acknowledges what it showed", async () => {
    const { desktop, on, client } = await opened()
    expect(client.receive(output(2, "a"))).toBe(true)
    expect(client.receive(output(3, "b"))).toBe(true)
    // Sent again after a reconnect.
    expect(client.receive(output(3, "b"))).toBe(true)
    expect(on.output.mock.calls).toEqual([["a"], ["b"]])

    expect(desktop.of("terminal.ack")).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(desktop.of("terminal.ack").map((each) => each.params)).toEqual([
      { terminalId: "t1", seq: 3 },
    ])

    // A lot at once is acknowledged at once.
    client.receive(output(4, "x".repeat(64 * 1024)))
    expect(desktop.of("terminal.ack").at(-1)!.params).toEqual({
      terminalId: "t1",
      seq: 4,
    })
  })

  it("says so when output was dropped, and ends with the exit", async () => {
    const { on, client } = await opened()
    client.receive({
      channel: "terminal.gap",
      data: { terminalId: "t1", fromSeq: 1, toSeq: 40 },
    })
    client.receive(output(12, "old"))
    client.receive(output(41, "new"))
    client.receive({
      channel: "terminal.exit",
      data: { terminalId: "t1", seq: 42, exitCode: 0, signal: null },
    })
    expect(on.gap).toHaveBeenCalledTimes(1)
    expect(on.output.mock.calls).toEqual([["new"]])
    expect(on.exit).toHaveBeenCalledWith(0)
  })

  it("sends input the desktop did not apply again after a reconnect, and only that", async () => {
    const { desktop, client } = await opened()
    for (const key of ["a", "b", "c"]) client.write(key)
    const [first, second, third] = desktop.of("terminal.write")

    // The connection goes; the desktop had applied a and b.
    client.detached()
    for (const write of [first, second, third]) write!.reject(lost())
    await settle()
    client.write("d")
    expect(desktop.of("terminal.write")).toHaveLength(3)

    client.receive(output(5, "ab"))
    const attaching = client.attach()
    const attach = desktop.of("terminal.attach")[0]!
    expect(attach.params).toEqual({ terminalId: "t1", afterSeq: 5 })
    attach.resolve(summary(3))
    await attaching

    expect(
      desktop
        .of("terminal.write")
        .slice(3)
        .map((each) => each.params)
    ).toEqual([
      { terminalId: "t1", inputSeq: 3, data: "c" },
      { terminalId: "t1", inputSeq: 4, data: "d" },
    ])
  })

  it("sends again a write that got no answer, with its number", async () => {
    const { desktop, client } = await opened()
    client.write("x")
    desktop
      .of("terminal.write")[0]!
      .reject(Object.assign(new Error("late"), { code: "timeout" }))
    await settle()
    expect(desktop.of("terminal.write")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(desktop.of("terminal.write").map((each) => each.params)).toEqual([
      { terminalId: "t1", inputSeq: 1, data: "x" },
      { terminalId: "t1", inputSeq: 1, data: "x" },
    ])
  })

  it("stops for good when the desktop says the terminal is gone", async () => {
    const { desktop, on, client } = await opened()
    client.write("x")
    const gone = Object.assign(new Error("Terminal not found."), {
      code: "terminal_not_found",
    })
    desktop.of("terminal.write")[0]!.reject(gone)
    await settle()
    expect(on.failed).toHaveBeenCalledWith(gone)
    expect(client.isEnded).toBe(true)
    client.write("y")
    await vi.advanceTimersByTimeAsync(5_000)
    expect(desktop.of("terminal.write")).toHaveLength(1)
  })

  it("hears why the desktop closed it, and minds only its own frames", async () => {
    const { on, client } = await opened()
    expect(client.receive(output(2, "other", "t2"))).toBe(false)
    expect(client.receive({ channel: "thread.activity", data: {} })).toBe(false)
    expect(client.receive("not a frame")).toBe(false)
    expect(
      client.receive({
        channel: "terminal.closed",
        data: { terminalId: "t1", reason: "grant_revoked" },
      })
    ).toBe(true)
    expect(on.closed).toHaveBeenCalledWith("grant_revoked")
    expect(on.output).not.toHaveBeenCalled()
    expect(client.isEnded).toBe(true)
  })

  it("splits a long paste into writes the desktop takes, never inside a character", () => {
    const limit = TERMINAL_LIMITS.maxWriteBytes
    expect(takeChunk("short")).toBe("short")
    const ascii = "a".repeat(limit + 10)
    expect(takeChunk(ascii)).toHaveLength(limit)
    const wide = "é".repeat(limit)
    const chunk = takeChunk(wide)
    expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(limit)
    expect(chunk).toBe("é".repeat(limit / 2))
    const emoji = "😀".repeat(limit)
    expect(takeChunk(emoji)).toBe("😀".repeat(limit / 4))
  })
})
