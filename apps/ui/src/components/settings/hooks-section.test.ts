import { describe, expect, it } from "vitest"
import { hookActionErrorMessage } from "./hooks-section"
import { IpcError } from "@/lib/errors/types"

describe("hook save errors", () => {
  it("says plainly that a declined approval kept the hook from being saved", () => {
    // What apps/shell/hooks-ipc.cjs rejects with when the dialog is cancelled.
    const declined = new IpcError(
      "The hook was not saved because its command was not allowed.",
      "hook:save"
    )
    expect(hookActionErrorMessage(declined, "Not saved")).toBe(
      "Not saved: the command wasn't approved."
    )
    expect(hookActionErrorMessage(declined, "Not changed")).toBe(
      "Not changed: the command wasn't approved."
    )
  })

  it("passes any other failure through", () => {
    expect(
      hookActionErrorMessage(
        new Error("Hook command must be at most 4096 characters."),
        "Not saved"
      )
    ).toBe("Not saved: Hook command must be at most 4096 characters.")
    expect(hookActionErrorMessage("disk full", "Not removed")).toBe(
      "Not removed: disk full"
    )
  })
})
