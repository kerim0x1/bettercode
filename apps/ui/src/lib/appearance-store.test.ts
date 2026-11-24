import { describe, expect, it } from "vitest"
import { migrateMessageTextDefault } from "./appearance-store"

const firstLoad = { done: false, interim: false }

describe("migrateMessageTextDefault", () => {
  it("moves a save on the old 13px default to 18px once", () => {
    const saved: Record<string, unknown> = { messageTextSize: 13 }
    expect(migrateMessageTextDefault(saved, firstLoad)).toBe(true)
    expect(saved.messageTextSize).toBe(18)
  })

  it("moves 16px only where a development build set it as the default", () => {
    const interim: Record<string, unknown> = { messageTextSize: 16 }
    expect(
      migrateMessageTextDefault(interim, { done: false, interim: true })
    ).toBe(true)
    expect(interim.messageTextSize).toBe(18)

    const chosen: Record<string, unknown> = { messageTextSize: 16 }
    expect(migrateMessageTextDefault(chosen, firstLoad)).toBe(false)
    expect(chosen.messageTextSize).toBe(16)
  })

  it("keeps any other size, and 13px chosen after the move", () => {
    const other: Record<string, unknown> = { messageTextSize: 15 }
    expect(migrateMessageTextDefault(other, firstLoad)).toBe(false)
    expect(other.messageTextSize).toBe(15)

    const chosen: Record<string, unknown> = { messageTextSize: 13 }
    expect(
      migrateMessageTextDefault(chosen, { done: true, interim: false })
    ).toBe(false)
    expect(chosen.messageTextSize).toBe(13)
  })
})
