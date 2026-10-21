import { describe, expect, it, vi } from "vitest"
import {
  NdjsonLineReader,
  dispatchNdjsonNotification,
  identifyOversizedLine,
} from "./NdjsonLineReader"
import { ProcessStderrTail, withStderrTail } from "./ProcessStderrTail"
import { logger } from "../../observability/logger"

describe("NdjsonLineReader", () => {
  it("frames lines across chunks, strips CR and flushes a trailing line", () => {
    const lines: string[] = []
    const reader = new NdjsonLineReader(
      1_024,
      (line) => lines.push(line),
      () => {
        throw new Error("unexpected oversized line")
      }
    )
    const frame = Buffer.from('{"text":"é"}\r\n{"b":2}')
    const split = frame.indexOf(Buffer.from("é")) + 1
    reader.push(frame.subarray(0, split))
    reader.push(frame.subarray(split))
    expect(lines).toEqual(['{"text":"é"}'])
    reader.end()
    expect(lines).toEqual(['{"text":"é"}', '{"b":2}'])
  })

  it("skips an oversized line without buffering it and keeps reading", () => {
    const lines: string[] = []
    const oversized = vi.fn()
    const reader = new NdjsonLineReader(
      32,
      (line) => lines.push(line),
      oversized
    )
    reader.push('{"id":7,"result":"' + "x".repeat(40))
    reader.push("x".repeat(40_000))
    expect(oversized).not.toHaveBeenCalled()
    reader.push('"}\n{"ok":true}\n')
    expect(oversized).toHaveBeenCalledWith({
      bytes: 18 + 40 + 40_000 + 2,
      head: expect.stringMatching(/^\{"id":7,"result":"x+$/),
    })
    expect(lines).toEqual(['{"ok":true}'])
  })
})

describe("identifyOversizedLine", () => {
  it("reads only the top-level envelope", () => {
    expect(
      identifyOversizedLine('{"jsonrpc":"2.0","id":12,"result":{"method":"x"')
    ).toEqual({
      id: 12,
      method: null,
    })
    expect(
      identifyOversizedLine(
        '{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{'
      )
    ).toEqual({ id: "perm-1", method: "session/request_permission" })
    expect(
      identifyOversizedLine('{"method":"turn/diff/updated","params":{"id":3')
    ).toEqual({
      id: null,
      method: "turn/diff/updated",
    })
    expect(identifyOversizedLine("not json")).toEqual({
      id: null,
      method: null,
    })
  })
})

describe("dispatchNdjsonNotification", () => {
  it("isolates and logs a throwing handler", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {})
    try {
      const after = vi.fn()
      const throwing = () => {
        throw new Error("bug")
      }
      const handlers = new Map<
        string,
        Set<(method: string, params: unknown) => void>
      >([["*", new Set([throwing, after])]])
      dispatchNdjsonNotification(handlers, "item/started", {}, "test rpc")
      expect(after).toHaveBeenCalledWith("item/started", {})
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })
})

describe("ProcessStderrTail", () => {
  it("keeps whole lines across chunks, bounded and redacted", () => {
    const tail = new ProcessStderrTail(64, 40)
    expect(tail.push("Error: token=sk-abcdefghijklmnop")).toEqual([])
    expect(tail.push("qrstuv expired\nsecond\n")).toEqual([
      "Error: token=sk-abcdefghijklmnopqrstuv e…",
      "second",
    ])
    for (let index = 0; index < 10; index++) tail.push(`line ${index}\n`)
    const text = tail.tail()
    expect(text).not.toContain("sk-abcdefghijklmnop")
    expect(text).toContain("line 9")
    expect(text.length).toBeLessThanOrEqual(64)
  })

  it("appends the tail to a failure detail only when there is one", () => {
    const tail = new ProcessStderrTail()
    expect(withStderrTail("exited with code 1", tail)).toBe(
      "exited with code 1"
    )
    tail.push("Not logged in\n")
    expect(withStderrTail("exited with code 1", tail)).toContain(
      "Not logged in"
    )
  })
})
