import { describe, expect, it } from "vitest"
import { historyThatFits, requestBytes } from "./request-size"

describe("request size", () => {
  it("counts the UTF-8 bytes of the JSON, as the desktop's limit does", () => {
    expect(requestBytes({ a: "x" })).toBe('{"a":"x"}'.length)
    // "ü" is two bytes, "€" three, "😀" four.
    expect(requestBytes("ü€😀")).toBe(2 + 2 + 3 + 4)
  })
})

describe("history that fits", () => {
  const body = { message: "hi", attachments: [{ url: "x".repeat(1_000) }] }
  const history = [
    { role: "user", content: "a".repeat(300) },
    { role: "assistant", content: "b".repeat(300) },
    { role: "user", content: "c".repeat(300) },
  ]

  it("keeps all of it when the request has room", () => {
    const fits = historyThatFits(body, history, 10_000)
    expect(fits).toEqual(history)
    expect(requestBytes({ ...body, history: fits })).toBeLessThanOrEqual(10_000)
  })

  it("drops the oldest entries until the request fits", () => {
    const limit = requestBytes({ ...body, history: history.slice(1) })
    const fits = historyThatFits(body, history, limit)
    expect(fits).toEqual(history.slice(1))
    expect(requestBytes({ ...body, history: fits })).toBeLessThanOrEqual(limit)
    expect(historyThatFits(body, history, limit - 1)).toEqual(history.slice(2))
  })

  it("is empty when the request is too large even without it", () => {
    expect(historyThatFits(body, history, 100)).toEqual([])
  })
})
