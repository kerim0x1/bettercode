import { describe, expect, it } from "vitest"
import {
  TRANSCRIPT_WINDOW_SIZE,
  growTranscriptWindow,
  revealWholeTranscript,
  transcriptWindowStart,
  windowTranscriptEntries,
} from "./transcript-window"

describe("windowTranscriptEntries", () => {
  it("does not return every historical entry when the transcript is long", () => {
    const entries = Array.from({ length: 200 }, (_, index) => index)
    const windowed = windowTranscriptEntries(entries)

    expect(windowed.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE)
    expect(windowed.hiddenBefore).toBe(200 - TRANSCRIPT_WINDOW_SIZE)
    expect(windowed.visible[0]).toBe(200 - TRANSCRIPT_WINDOW_SIZE)
    expect(windowed.visible.at(-1)).toBe(199)
    expect(windowed.visible).not.toContain(0)
  })

  it("can expand the window toward older history without mounting the full list", () => {
    const entries = Array.from({ length: 80 }, (_, index) => `m-${index}`)
    const windowed = windowTranscriptEntries(entries, {
      size: 10,
      startIndex: 20,
    })

    expect(windowed.visible).toEqual(
      Array.from({ length: 60 }, (_, index) => `m-${20 + index}`)
    )
    expect(windowed.hiddenBefore).toBe(20)
    expect(windowed.visible).not.toContain("m-0")
  })
})

describe("transcript history anchor", () => {
  const entries = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `e${from + index}` }))

  it("keeps the tail window until the user asks for more", () => {
    expect(transcriptWindowStart(entries(0, 100), null, "t")).toBeUndefined()
  })

  it("grows the window by one step above the first mounted entry", () => {
    const list = entries(0, 200)
    const tailStart = windowTranscriptEntries(list).startIndex
    const anchor = growTranscriptWindow(list, tailStart, "t")
    const start = transcriptWindowStart(list, anchor, "t")
    expect(start).toBe(tailStart - TRANSCRIPT_WINDOW_SIZE)
    const windowed = windowTranscriptEntries(list, { startIndex: start })
    expect(windowed.visible).toHaveLength(TRANSCRIPT_WINDOW_SIZE * 2)
    // A reply appended at the end does not shift the opened history.
    const withReply = [...list, { id: "reply" }]
    expect(transcriptWindowStart(withReply, anchor, "t")).toBe(start)
  })

  it("shows a prepended older page under the same anchor", () => {
    const loaded = entries(100, 30)
    const anchor = growTranscriptWindow(loaded, 0, "t")
    expect(transcriptWindowStart(loaded, anchor, "t")).toBe(0)
    const withOlderPage = [...entries(0, 100), ...loaded]
    expect(transcriptWindowStart(withOlderPage, anchor, "t")).toBe(
      100 - TRANSCRIPT_WINDOW_SIZE
    )
  })

  it("ignores an anchor that belongs to another thread or a vanished entry", () => {
    const list = entries(0, 100)
    const anchor = growTranscriptWindow(list, 60, "t")
    expect(transcriptWindowStart(list, anchor, "other")).toBeUndefined()
    expect(transcriptWindowStart(entries(500, 10), anchor, "t")).toBeUndefined()
  })

  it("can mount everything, including pages loaded later", () => {
    const list = entries(100, 50)
    const anchor = revealWholeTranscript(list, "t")
    expect(
      transcriptWindowStart([...entries(0, 100), ...list], anchor, "t")
    ).toBe(0)
  })
})
