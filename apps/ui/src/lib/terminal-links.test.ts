import { describe, expect, it } from "vitest"
import { findTerminalUrls } from "./terminal-links"

describe("findTerminalUrls", () => {
  it("finds a dev server's address in its output", () => {
    const line = "  ➜  Local:   http://localhost:5173/"
    expect(findTerminalUrls(line)).toEqual([
      {
        start: line.indexOf("http"),
        end: line.length,
        url: "http://localhost:5173/",
      },
    ])
  })

  it("leaves sentence punctuation and unopened brackets out of the link", () => {
    expect(
      findTerminalUrls("Docs at https://example.com/docs.").map((m) => m.url)
    ).toEqual(["https://example.com/docs"])
    expect(
      findTerminalUrls("(see https://example.com/a)").map((m) => m.url)
    ).toEqual(["https://example.com/a"])
    expect(
      findTerminalUrls("https://en.wikipedia.org/wiki/Tree_(graph_theory)").map(
        (m) => m.url
      )
    ).toEqual(["https://en.wikipedia.org/wiki/Tree_(graph_theory)"])
  })

  it("finds several links and ignores other schemes", () => {
    const text =
      "a https://one.test b http://two.test/x?y=1 file:///etc/passwd javascript:alert(1)"
    expect(findTerminalUrls(text).map((m) => m.url)).toEqual([
      "https://one.test",
      "http://two.test/x?y=1",
    ])
  })

  it("stops at quotes and escape characters", () => {
    expect(
      findTerminalUrls('url="https://example.com/a"').map((m) => m.url)
    ).toEqual(["https://example.com/a"])
    expect(
      findTerminalUrls("https://example.com/b\u001b[0m").map((m) => m.url)
    ).toEqual(["https://example.com/b"])
  })
})
