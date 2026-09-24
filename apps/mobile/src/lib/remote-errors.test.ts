import { describe, expect, it } from "vitest"
import { RemoteApiError } from "@/transport/live/http"
import { describeRemoteError } from "./remote-errors"

const refusal = (status: number, code?: string, details = {}) =>
  new RemoteApiError("raw desktop message", status, code, details)

describe("describeRemoteError", () => {
  it("tells the user what to do for each refusal the desktop names", () => {
    const cases: Array<[RemoteApiError, string, string | undefined]> = [
      [
        refusal(426, "client_update_required", { minClientVersion: "0.2.0" }),
        "Update BetterC0de Remote",
        "update_app",
      ],
      [
        refusal(426, "secure_transport_required"),
        "Use a private or secure address",
        "retry",
      ],
      [
        refusal(401, "pairing_code_invalid"),
        "Pairing code expired",
        "pair_again",
      ],
      [refusal(401, "unauthorized"), "Signed out", "pair_again"],
      [refusal(403, "remote_access_disabled"), "Remote Access is off", "retry"],
      [
        refusal(403, "remote_read_only"),
        "This phone can only watch",
        "pair_again",
      ],
      [refusal(403, "desktop_only"), "Desktop only", undefined],
      [refusal(403, "remote_terminal_disabled"), "Terminal is off", undefined],
      [
        refusal(403, "workspace_not_registered"),
        "Project not open on the desktop",
        undefined,
      ],
      [refusal(413, "request_too_large"), "Too large", undefined],
      [
        refusal(429, "rate_limited", { retryAfterMs: 7_000 }),
        "Too many requests",
        "wait",
      ],
      [refusal(409, "turn_active"), "The agent is still working", "wait"],
      [refusal(409, "dispatch_id_conflict"), "Message conflict", "send_as_new"],
      [
        refusal(409, "dispatch_outcome_unknown"),
        "Not known if it arrived",
        "send_as_new",
      ],
      [
        refusal(409, "dispatch_failed"),
        "The agent refused the message",
        "send_as_new",
      ],
      [refusal(409, "dispatch_reverted"), "Message undone", "send_as_new"],
      [refusal(403, "workspace_untrusted"), "Project not trusted", undefined],
      [
        refusal(409, "checkpoint_recovery_required"),
        "A restore did not finish",
        undefined,
      ],
      [
        refusal(409, "worktree_removal_pending"),
        "Worktree still being removed",
        "retry",
      ],
      [refusal(0, "timeout"), "No answer from the desktop", "retry"],
      [refusal(0, "network"), "Desktop unreachable", "retry"],
      [refusal(503), "Desktop busy", "retry"],
    ]
    for (const [error, title, action] of cases) {
      const description = describeRemoteError(error)
      expect(description.title, error.code ?? String(error.status)).toBe(title)
      expect(description.action).toBe(action)
    }
  })

  it("names the version the desktop needs and when to retry", () => {
    expect(
      describeRemoteError(
        refusal(426, "client_update_required", { minClientVersion: "0.2.0" })
      ).message
    ).toBe("This desktop needs version 0.2.0 or newer of the app.")
    expect(
      describeRemoteError(refusal(429, "rate_limited", { retryAfterMs: 7_000 }))
        .message
    ).toBe("Try again in 7 seconds.")
  })

  it("falls back to the status for older desktops that send no code", () => {
    expect(describeRemoteError(refusal(401)).action).toBe("pair_again")
    expect(describeRemoteError(refusal(426)).title).toBe(
      "Use a private or secure address"
    )
    expect(describeRemoteError(refusal(500)).message).toBe(
      "raw desktop message"
    )
    expect(describeRemoteError(new Error("boom")).message).toBe("boom")
  })
})
