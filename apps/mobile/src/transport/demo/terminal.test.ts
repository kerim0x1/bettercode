import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DemoTerminals, evaluateArithmetic, expandArithmetic } from "./terminal"

const ROOT = "/Users/demo/code/weather-app"

function shell() {
  const frames: Array<{ channel: string; data: Record<string, unknown> }> = []
  const terminals = new DemoTerminals(
    {
      roots: () => [ROOT],
      list: () => ["README.md", "package.json", "src/"],
      now: () => new Date("2026-09-24T12:00:00.000Z"),
    },
    (frame) => frames.push(frame as (typeof frames)[number])
  )
  const shown = () =>
    frames
      .filter((frame) => frame.channel === "terminal.output")
      .map((frame) => String(frame.data.output))
      .join("")
  return { terminals, frames, shown }
}

async function opened() {
  const demo = shell()
  const { terminalId } = demo.terminals.handle("terminal.open", {
    cwd: ROOT,
    cols: 80,
    rows: 24,
  }) as { terminalId: string }
  let inputSeq = 0
  const type = async (data: string) => {
    inputSeq += 1
    const result = demo.terminals.handle("terminal.write", {
      terminalId,
      inputSeq,
      data,
    })
    await vi.advanceTimersByTimeAsync(0)
    return result
  }
  await vi.advanceTimersByTimeAsync(0)
  return { ...demo, terminalId, type }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("the demo's terminal", () => {
  it("opens only in the demo's workspaces, with a greeting and a prompt", async () => {
    expect(() =>
      shell().terminals.handle("terminal.open", {
        cwd: "/etc",
        cols: 80,
        rows: 24,
      })
    ).toThrow(expect.objectContaining({ code: "workspace_not_registered" }))
    const { shown } = await opened()
    expect(shown()).toContain("it runs nothing")
    expect(shown()).toMatch(/weather-app.* % $/)
  })

  it("echoes what is typed and answers a few commands", async () => {
    const { shown, type } = await opened()
    await type("echo $((6*7))\r")
    expect(shown()).toContain("echo $((6*7))\r\n42\r\n")
    await type("pwd\r")
    expect(shown()).toContain(`${ROOT}\r\n`)
    await type("ls\r")
    expect(shown()).toContain("README.md  package.json  src/\r\n")
    await type("rm -rf /\r")
    expect(shown()).toContain("demo: command not found: rm\r\n")
    // Backspace takes a character back; Ctrl-C drops the line.
    await type("pwx\x7fd\r")
    expect(shown().match(new RegExp(`${ROOT}\\r\\n`, "g"))).toHaveLength(2)
    await type("whoam\x03")
    expect(shown()).toContain("whoam^C\r\n")
  })

  it("applies input once and in order, like the desktop", async () => {
    const { terminals, terminalId, shown } = await opened()
    const write = (inputSeq: number, data: string) =>
      terminals.handle("terminal.write", { terminalId, inputSeq, data })
    expect(write(1, "e")).toEqual({ applied: true })
    expect(write(1, "e")).toEqual({ applied: false })
    expect(() => write(3, "x")).toThrow(
      expect.objectContaining({ code: "terminal_input_gap" })
    )
    expect(write(2, "cho hi\r")).toEqual({ applied: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(shown()).toContain("echo hi\r\nhi\r\n")
  })

  it("gives a phone that attaches again what came after its last output", async () => {
    const { terminals, terminalId, frames, type } = await opened()
    await type("whoami\r")
    const had = Number(frames.at(-1)!.data.seq)
    await type("pwd\r")
    const before = frames.length
    expect(
      terminals.handle("terminal.attach", { terminalId, afterSeq: had })
    ).toMatchObject({ terminalId, status: "running", nextInputSeq: 3 })
    await vi.advanceTimersByTimeAsync(0)
    const again = frames.slice(before)
    expect(again.length).toBeGreaterThan(0)
    expect(again.every((frame) => Number(frame.data.seq) > had)).toBe(true)
  })

  it("ends with exit, and is gone once closed", async () => {
    const { terminals, terminalId, frames, type } = await opened()
    await type("exit\r")
    expect(frames.at(-1)).toMatchObject({
      channel: "terminal.exit",
      data: { terminalId, exitCode: 0 },
    })
    expect(() =>
      terminals.handle("terminal.write", {
        terminalId,
        inputSeq: 2,
        data: "ls\r",
      })
    ).toThrow(expect.objectContaining({ code: "terminal_exited" }))

    terminals.handle("terminal.close", { terminalId })
    await vi.advanceTimersByTimeAsync(0)
    expect(frames.at(-1)).toEqual({
      channel: "terminal.closed",
      data: { terminalId, reason: "closed" },
    })
    expect(terminals.handle("terminal.list", {})).toEqual({ terminals: [] })
    expect(() =>
      terminals.handle("terminal.resize", { terminalId, cols: 80, rows: 24 })
    ).toThrow(expect.objectContaining({ code: "terminal_not_found" }))
  })

  it("sends its output in order where timers due together run in any order", () => {
    // React Native on Android runs timers due in the same millisecond in no
    // set order (JavaTimerManager's queue sorts by due time only), and the
    // phone drops output numbered below what it showed. This stand-in runs
    // them last first.
    vi.useRealTimers()
    const due: Array<() => void> = []
    vi.stubGlobal("setTimeout", (callback: () => void) => {
      due.push(callback)
      return due.length
    })
    const runDue = () => {
      while (due.length > 0) due.pop()!()
    }
    try {
      const { terminals, frames, shown } = shell()
      const { terminalId } = terminals.handle("terminal.open", {
        cwd: ROOT,
        cols: 80,
        rows: 24,
      }) as { terminalId: string }
      runDue()
      terminals.handle("terminal.write", {
        terminalId,
        inputSeq: 1,
        data: "whoami\r",
      })
      runDue()

      const numbers = frames.map((frame) => Number(frame.data.seq))
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
      expect(shown()).toContain("whoami\r\ndemo\r\n")
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("arithmetic in the demo's echo", () => {
  it("is integer arithmetic with precedence and parentheses", () => {
    expect(evaluateArithmetic("6*7")).toBe(42)
    expect(evaluateArithmetic("1 + 2 * 3")).toBe(7)
    expect(evaluateArithmetic("(1 + 2) * 3")).toBe(9)
    expect(evaluateArithmetic("-7 / 2")).toBe(-3)
    expect(evaluateArithmetic("17 % 5")).toBe(2)
  })

  it("leaves alone what it cannot work out, and never runs it", () => {
    expect(evaluateArithmetic("1 / 0")).toBeNull()
    expect(evaluateArithmetic("process.exit()")).toBeNull()
    expect(evaluateArithmetic("2 +")).toBeNull()
    expect(evaluateArithmetic("")).toBeNull()
    expect(expandArithmetic("a $((2+3)) b $((x)) c")).toBe("a 5 b $((x)) c")
  })
})
