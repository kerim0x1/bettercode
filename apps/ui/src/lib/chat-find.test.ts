import { describe, expect, it } from "vitest"
import { chatFindPattern } from "@betterc0de/schema"
import {
  buildChatFindResult,
  ChatFindCountCache,
  chatFindSegmentRanges,
  chatFindTargets,
  describeChatFindCount,
  findChatFindMatchIndex,
  formatChatFindCount,
  initialChatFindIndex,
  sameChatFindResult,
  stepChatFindIndex,
  type ChatFindTarget,
} from "./chat-find"

function pattern(query: string, caseSensitive = false): RegExp {
  const result = chatFindPattern(query, { caseSensitive })
  if (!result) throw new Error(`no pattern for ${JSON.stringify(query)}`)
  return result
}

const targets: ChatFindTarget[] = [
  { id: "u1", text: "Deploy the app" },
  { id: "a1", text: "Deploying now. deploy log follows." },
  { id: "u2", text: "thanks" },
  { id: "a2", text: "DEPLOY done" },
]

describe("chatFindTargets", () => {
  it("searches user and assistant messages and recorded plans in order", () => {
    expect(
      chatFindTargets([
        {
          kind: "message",
          id: "u1",
          msg: { role: "user", content: "hi" },
          hidePlanCard: false,
        },
        { kind: "model-switch", id: "switch" },
        {
          kind: "message",
          id: "sys",
          msg: { role: "system", content: "internal" },
        },
        {
          kind: "message",
          id: "plan-message",
          msg: { role: "assistant", content: "# Plan" },
          hidePlanCard: true,
        },
        { kind: "proposed-plan", id: "plan", content: "# Plan" },
        {
          kind: "proposed-plan",
          id: "reviewing",
          content: "# Other plan",
          awaitingApproval: true,
        },
        {
          kind: "message",
          id: "empty",
          msg: { role: "assistant", content: "" },
        },
        {
          kind: "message",
          id: "a1",
          msg: { role: "assistant", content: "hello" },
        },
      ])
    ).toEqual([
      { id: "u1", text: "hi" },
      { id: "plan", text: "# Plan" },
      { id: "a1", text: "hello" },
    ])
  })
})

describe("buildChatFindResult", () => {
  it("numbers every match oldest first with its place in the entry", () => {
    const result = buildChatFindResult({ targets, pattern: pattern("deploy") })
    expect(
      result.matches.map((match) => [match.entryId, match.occurrence])
    ).toEqual([
      ["u1", 0],
      ["a1", 0],
      ["a1", 1],
      ["a2", 0],
    ])
    expect(result.matches.every((match) => match.loaded)).toBe(true)
    expect(result.truncated).toBe(false)
  })

  it("honours match case", () => {
    const result = buildChatFindResult({
      targets,
      pattern: pattern("DEPLOY", true),
    })
    expect(result.matches.map((match) => match.entryId)).toEqual(["a2"])
  })

  it("puts older stored messages before the loaded ones", () => {
    const result = buildChatFindResult({
      targets,
      pattern: pattern("deploy"),
      remoteHits: [
        { messageId: "old-2", sequence: 7, matchCount: 1 },
        { messageId: "old-1", sequence: 3, matchCount: 2 },
        // Loaded since the backend answered: counted from the loaded copy.
        { messageId: "a1", sequence: 12, matchCount: 2 },
        // Loaded but not shown (a hidden handoff message).
        { messageId: "hidden", sequence: 9, matchCount: 1 },
      ],
      loadedIds: new Set(["u1", "a1", "u2", "a2", "hidden"]),
    })
    expect(
      result.matches.map((match) => [
        match.entryId,
        match.occurrence,
        match.loaded,
      ])
    ).toEqual([
      ["old-1", 0, false],
      ["old-1", 1, false],
      ["old-2", 0, false],
      ["u1", 0, true],
      ["a1", 0, true],
      ["a1", 1, true],
      ["a2", 0, true],
    ])
    expect(result.matches[0]?.sequence).toBe(3)
  })

  it("keeps the newest matches past the limit", () => {
    const result = buildChatFindResult({
      targets,
      pattern: pattern("deploy"),
      remoteHits: [{ messageId: "old", sequence: 1, matchCount: 5 }],
      limit: 3,
    })
    expect(
      result.matches.map((match) => [match.entryId, match.occurrence])
    ).toEqual([
      ["a1", 0],
      ["a1", 1],
      ["a2", 0],
    ])
    expect(result.truncated).toBe(true)
  })

  it("keeps the last matches of an entry cut by the limit", () => {
    const result = buildChatFindResult({
      targets: [{ id: "many", text: "a a a a a" }],
      pattern: pattern("a"),
      limit: 2,
    })
    expect(result.matches.map((match) => match.occurrence)).toEqual([3, 4])
    expect(result.truncated).toBe(true)
  })

  it("reports the backend's truncation", () => {
    const result = buildChatFindResult({
      targets,
      pattern: pattern("thanks"),
      remoteHits: [],
      remoteTruncated: true,
    })
    expect(result.matches).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it("reuses counts while an entry's text is unchanged", () => {
    const cache = new ChatFindCountCache()
    const deploy = pattern("deploy")
    expect(cache.count({ id: "a", text: "deploy deploy" }, deploy)).toBe(2)
    expect(cache.count({ id: "a", text: "deploy" }, deploy)).toBe(1)
    const other = pattern("x")
    expect(cache.count({ id: "a", text: "deploy" }, other)).toBe(0)
  })
})

describe("sameChatFindResult", () => {
  it("compares the listed matches, not the objects", () => {
    const a = buildChatFindResult({ targets, pattern: pattern("deploy") })
    const b = buildChatFindResult({
      targets: [...targets],
      pattern: pattern("deploy"),
    })
    expect(a).not.toBe(b)
    expect(sameChatFindResult(a, b)).toBe(true)
    const c = buildChatFindResult({ targets, pattern: pattern("thanks") })
    expect(sameChatFindResult(a, c)).toBe(false)
  })
})

describe("navigation", () => {
  const result = buildChatFindResult({ targets, pattern: pattern("deploy") })

  it("finds a match by entry and occurrence", () => {
    expect(
      findChatFindMatchIndex(result.matches, { entryId: "a1", occurrence: 1 })
    ).toBe(2)
    expect(findChatFindMatchIndex(result.matches, null)).toBe(-1)
  })

  it("starts at the first match from the reading position", () => {
    expect(initialChatFindIndex(result.matches, targets, "u2")).toBe(3)
    expect(initialChatFindIndex(result.matches, targets, "a1")).toBe(1)
    expect(initialChatFindIndex(result.matches, targets, "u1")).toBe(0)
  })

  it("falls back to the newest match", () => {
    const older = buildChatFindResult({ targets, pattern: pattern("thanks") })
    expect(initialChatFindIndex(older.matches, targets, "a2")).toBe(0)
    expect(initialChatFindIndex(result.matches, targets, null)).toBe(3)
    expect(initialChatFindIndex([], targets, "u1")).toBe(-1)
  })

  it("wraps around at either end", () => {
    expect(stepChatFindIndex(3, 4, 1)).toBe(0)
    expect(stepChatFindIndex(0, 4, -1)).toBe(3)
    expect(stepChatFindIndex(-1, 4, 1)).toBe(0)
    expect(stepChatFindIndex(-1, 4, -1)).toBe(3)
    expect(stepChatFindIndex(0, 0, 1)).toBe(-1)
  })
})

describe("formatChatFindCount", () => {
  it("shows the position, the total and a limit marker", () => {
    expect(formatChatFindCount(2, 12, false)).toBe("3 of 12")
    expect(formatChatFindCount(0, 1000, true)).toBe("1 of 1000+")
    expect(formatChatFindCount(-1, 0, false)).toBe("No results")
    expect(describeChatFindCount(2, 12, false)).toBe("Result 3 of 12")
    expect(describeChatFindCount(0, 1000, true)).toBe(
      "Result 1 of more than 1000"
    )
  })
})

describe("chatFindSegmentRanges", () => {
  it("finds a phrase split over inline elements", () => {
    // "foo **bar** baz" renders as three text nodes in one paragraph.
    const ranges = chatFindSegmentRanges(
      [
        { text: "foo ", block: 0 },
        { text: "bar", block: 0 },
        { text: " baz", block: 0 },
      ],
      pattern("foo bar")
    )
    expect(ranges).toEqual([
      { startSegment: 0, startOffset: 0, endSegment: 1, endOffset: 3 },
    ])
  })

  it("does not join the text of two blocks", () => {
    const segments = [
      { text: "end", block: 0 },
      { text: "start", block: 1 },
    ]
    expect(chatFindSegmentRanges(segments, pattern("endstart"))).toEqual([])
    // The break between them still matches whitespace in the query.
    expect(chatFindSegmentRanges(segments, pattern("end start"))).toEqual([
      { startSegment: 0, startOffset: 0, endSegment: 1, endOffset: 5 },
    ])
  })

  it("maps several matches to their own segments", () => {
    expect(
      chatFindSegmentRanges(
        [
          { text: "a cat", block: 0 },
          { text: "the cat sat", block: 1 },
        ],
        pattern("cat")
      )
    ).toEqual([
      { startSegment: 0, startOffset: 2, endSegment: 0, endOffset: 5 },
      { startSegment: 1, startOffset: 4, endSegment: 1, endOffset: 7 },
    ])
  })

  it("starts a match after a block break in the next segment", () => {
    expect(
      chatFindSegmentRanges(
        [
          { text: "one", block: 0 },
          { text: "two", block: 1 },
        ],
        pattern(" two")
      )
    ).toEqual([
      { startSegment: 1, startOffset: 0, endSegment: 1, endOffset: 3 },
    ])
  })
})
