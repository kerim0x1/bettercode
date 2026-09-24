import { describe, expect, it } from "vitest"
import { parseTerminalPageEvent } from "./page-protocol"

describe("events from the terminal's page", () => {
  it("are accepted as the protocol describes them", () => {
    expect(
      parseTerminalPageEvent('{"type":"ready","cols":80,"rows":24}')
    ).toEqual({ type: "ready", cols: 80, rows: 24 })
    expect(parseTerminalPageEvent('{"type":"input","data":"ls\\r"}')).toEqual({
      type: "input",
      data: "ls\r",
    })
    expect(
      parseTerminalPageEvent('{"type":"resize","cols":120,"rows":40}')
    ).toEqual({ type: "resize", cols: 120, rows: 40 })
  })

  it("are ignored when they are anything else", () => {
    for (const data of [
      "not json",
      "null",
      '{"type":"navigate","url":"https://example.com"}',
      '{"type":"input","data":""}',
      '{"type":"ready","cols":0,"rows":24}',
      '{"type":"resize","cols":"80","rows":24}',
      JSON.stringify({ type: "input", data: "x".repeat(256 * 1024 + 1) }),
    ]) {
      expect(parseTerminalPageEvent(data), data.slice(0, 40)).toBeNull()
    }
  })
})
