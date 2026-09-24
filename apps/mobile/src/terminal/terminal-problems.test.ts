import { terminalClosedReasonSchema } from "@betterc0de/schema/remote-terminal"
import { describe, expect, it } from "vitest"
import { terminalClosedMessage } from "./terminal-problems"

describe("terminalClosedMessage", () => {
  it("says who ended the terminal, and where to look", () => {
    expect(terminalClosedMessage("ended_on_desktop")).toBe(
      "The terminal was ended on the desktop."
    )
    expect(terminalClosedMessage("grant_revoked")).toContain(
      "Settings → Remote Access"
    )
    expect(terminalClosedMessage("detached")).toContain("15 minutes")
    expect(terminalClosedMessage("closed")).toBe("The terminal was closed.")
  })

  it("reads a reason from a newer desktop as a plain close", () => {
    const reason = terminalClosedReasonSchema.parse("moved_to_mars")
    expect(terminalClosedMessage(reason)).toBe("The terminal was closed.")
  })
})
