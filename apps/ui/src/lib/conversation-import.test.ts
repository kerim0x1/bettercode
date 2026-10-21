import type { ConversationImportCandidate } from "@betterc0de/schema"
import { describe, expect, it } from "vitest"
import {
  conversationImportKey,
  filterConversationCandidates,
  formatMessageCount,
  formatSessionDate,
  groupConversationCandidates,
  groupSelectionState,
  withSelection,
} from "@/lib/conversation-import"

function candidate(
  overrides: Partial<ConversationImportCandidate>
): ConversationImportCandidate {
  return {
    provider: "claude",
    sessionId: "s1",
    projectPath: "/work/app",
    projectName: "app",
    folderExists: true,
    title: "Title",
    startedAt: null,
    updatedAt: "2026-03-01T10:00:00.000Z",
    messageCount: 4,
    threadId: null,
    resumable: true,
    archived: false,
    sizeBytes: 100,
    ...overrides,
  }
}

describe("conversation import helpers", () => {
  const sessions = [
    candidate({ sessionId: "a" }),
    candidate({
      sessionId: "b",
      provider: "codex",
      projectPath: null,
      projectName: null,
    }),
    candidate({ sessionId: "c", threadId: "thread-1" }),
  ]

  it("groups sessions by project in the order they arrive", () => {
    const groups = groupConversationCandidates(sessions)
    expect(
      groups.map((group) => [group.name, group.candidates.length])
    ).toEqual([
      ["app", 2],
      [null, 1],
    ])
  })

  it("filters by CLI", () => {
    expect(
      filterConversationCandidates(sessions, "codex").map(
        (entry) => entry.sessionId
      )
    ).toEqual(["b"])
    expect(filterConversationCandidates(sessions, "all")).toHaveLength(3)
  })

  it("selects only sessions that are not imported yet", () => {
    const [app] = groupConversationCandidates(sessions)
    const selected = withSelection(new Set(), app!.candidates, true)
    expect([...selected]).toEqual([conversationImportKey(sessions[0]!)])
    expect(groupSelectionState(app!, selected)).toBe(true)
    expect(groupSelectionState(app!, new Set())).toBe(false)
    expect(withSelection(selected, app!.candidates, false).size).toBe(0)
  })

  it("reports a partly selected project", () => {
    const [app] = groupConversationCandidates([
      candidate({ sessionId: "x" }),
      candidate({ sessionId: "y" }),
    ])
    expect(groupSelectionState(app!, new Set(["claude:x"]))).toBe(
      "indeterminate"
    )
  })

  it("formats counts and dates", () => {
    const now = new Date("2026-03-10T12:00:00.000Z")
    expect(formatMessageCount(null)).toBe("")
    expect(formatMessageCount(1)).toBe("1 message")
    expect(formatMessageCount(12)).toBe("12 messages")
    expect(formatSessionDate("2026-03-10T11:30:00.000Z", now)).toBe("30m ago")
    expect(formatSessionDate("2026-03-08T12:00:00.000Z", now)).toBe("2d ago")
    expect(formatSessionDate("not a date", now)).toBe("")
  })
})
