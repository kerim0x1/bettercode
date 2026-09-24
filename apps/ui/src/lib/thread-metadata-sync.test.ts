import { describe, expect, it } from "vitest"
import { remoteTitleChange } from "./thread-metadata-sync"

const threads = [
  { id: "thread-1", title: "Old title" },
  { id: "thread-2", title: "Other" },
]
const frame = (data: Record<string, unknown>) => ({
  updatedAt: "2026-09-24T10:00:00.000Z",
  ...data,
})

describe("a chat renamed on another client", () => {
  it("takes the new title over", () => {
    expect(
      remoteTitleChange(threads, frame({ threadId: "thread-1", title: "New" }))
    ).toEqual({ threadId: "thread-1", title: "New" })
  })

  it("changes nothing that is already current, unknown or malformed", () => {
    expect(
      remoteTitleChange(
        threads,
        frame({ threadId: "thread-2", title: "Other" })
      )
    ).toBeNull()
    expect(
      remoteTitleChange(threads, frame({ threadId: "thread-9", title: "New" }))
    ).toBeNull()
    expect(remoteTitleChange(threads, { threadId: "thread-1" })).toBeNull()
    expect(
      remoteTitleChange(threads, frame({ threadId: "thread-1", title: "" }))
    ).toBeNull()
    expect(remoteTitleChange(threads, null)).toBeNull()
  })
})
