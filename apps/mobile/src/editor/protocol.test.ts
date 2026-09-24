import { describe, expect, it } from "vitest"
import {
  editorLanguageFor,
  MAX_EDITABLE_BYTES,
  parseEditorEvent,
} from "./protocol"

describe("the editor's languages", () => {
  it("follow the file's extension, and plain text otherwise", () => {
    expect(editorLanguageFor("App.tsx")).toBe("typescript")
    expect(editorLanguageFor("server.mjs")).toBe("javascript")
    expect(editorLanguageFor("package.json")).toBe("json")
    expect(editorLanguageFor("README.MD")).toBe("markdown")
    expect(editorLanguageFor("ci.yml")).toBe("yaml")
    expect(editorLanguageFor("main.py")).toBe("python")
    expect(editorLanguageFor("Makefile")).toBe("text")
    expect(editorLanguageFor("notes.unknown")).toBe("text")
  })
})

describe("events from the editor", () => {
  it("are accepted as the protocol describes them", () => {
    expect(parseEditorEvent('{"type":"ready"}')).toEqual({ type: "ready" })
    expect(
      parseEditorEvent(
        '{"type":"changed","dirty":true,"canUndo":true,"canRedo":false}'
      )
    ).toEqual({ type: "changed", dirty: true, canUndo: true, canRedo: false })
    expect(
      parseEditorEvent('{"type":"text","requestId":"text-1","text":"a\\nb"}')
    ).toEqual({ type: "text", requestId: "text-1", text: "a\nb" })
  })

  it("are ignored when they are anything else", () => {
    for (const data of [
      "not json",
      "null",
      '{"type":"navigate","url":"https://example.com"}',
      '{"type":"changed","dirty":"yes"}',
      '{"type":"text","requestId":"","text":"x"}',
      JSON.stringify({
        type: "text",
        requestId: "text-1",
        text: "x".repeat(MAX_EDITABLE_BYTES * 4 + 1),
      }),
    ]) {
      expect(parseEditorEvent(data), data.slice(0, 40)).toBeNull()
    }
  })
})
