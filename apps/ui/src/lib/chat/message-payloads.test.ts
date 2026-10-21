import type { ChatMessage } from "@betterc0de/schema"
import { describe, expect, it } from "vitest"
import {
  keepLoadedMessagePayloads,
  messageHasOmittedAttachmentData,
  messageHasOmittedDiffText,
  messageHasOmittedPayload,
  withFullMessagePayloads,
} from "./message-payloads"

const diff = (path: string, text: string) => ({
  path,
  additions: 1,
  deletions: 1,
  oldText: `${text}-old`,
  newText: `${text}-new`,
  isNew: false,
})
const omittedDiff = (path: string) => ({
  ...diff(path, ""),
  oldText: "",
  newText: "",
  textOmitted: true,
})

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "done",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("light transcript payloads", () => {
  it("detects placeholders", () => {
    const plain = message({ diffs: [diff("a.ts", "a")] })
    expect(messageHasOmittedPayload(plain)).toBe(false)
    expect(
      messageHasOmittedDiffText(message({ diffs: [omittedDiff("a")] }))
    ).toBe(true)
    const attachment = message({
      attachments: [
        { type: "image", url: "data:image/png;base64,", dataOmitted: true },
      ],
    })
    expect(messageHasOmittedAttachmentData(attachment)).toBe(true)
    expect(messageHasOmittedPayload(attachment)).toBe(true)
  })

  it("fills placeholders by file and keeps everything else", () => {
    const target = message({
      content: "newer text",
      diffs: [omittedDiff("b.ts"), omittedDiff("a.ts"), diff("c.ts", "c")],
      attachments: [
        {
          type: "image",
          filename: "x.png",
          url: "data:image/png;base64,",
          dataOmitted: true,
        },
        { type: "file", url: "https://example.com/doc" },
      ],
    })
    const full = message({
      content: "older text",
      diffs: [diff("a.ts", "a"), diff("b.ts", "b"), diff("c.ts", "stale")],
      attachments: [
        { type: "image", filename: "x.png", url: "data:image/png;base64,QQ==" },
        { type: "file", url: "https://example.com/doc" },
      ],
    })

    const merged = withFullMessagePayloads(target, full)

    expect(merged.content).toBe("newer text")
    expect(merged.diffs).toEqual([
      diff("b.ts", "b"),
      diff("a.ts", "a"),
      // Not a placeholder: the local copy wins.
      diff("c.ts", "c"),
    ])
    expect(merged.attachments).toEqual([
      { type: "image", filename: "x.png", url: "data:image/png;base64,QQ==" },
      { type: "file", url: "https://example.com/doc" },
    ])
    expect(messageHasOmittedPayload(merged)).toBe(false)
  })

  it("leaves a placeholder the full copy cannot fill, and returns the same object when nothing changes", () => {
    const target = message({ diffs: [omittedDiff("gone.ts")] })
    expect(withFullMessagePayloads(target, message({ diffs: [] }))).toBe(target)
  })

  it("keeps already loaded payloads when a light page is read again", () => {
    const loaded = [message({ id: "m1", diffs: [diff("a.ts", "a")] })]
    const page = [
      message({ id: "m1", diffs: [omittedDiff("a.ts")] }),
      message({ id: "m2", diffs: [omittedDiff("b.ts")] }),
    ]

    const kept = keepLoadedMessagePayloads(page, loaded)

    expect(kept[0]?.diffs).toEqual([diff("a.ts", "a")])
    // Never loaded in full: still a placeholder.
    expect(kept[1]).toBe(page[1])
  })
})
