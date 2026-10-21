import { describe, expect, it } from "vitest"
import { HttpError, sanitizeError } from "./errors"

describe("sanitizeError", () => {
  it("preserves the message of a nominal HttpError", () => {
    const result = sanitizeError(
      new HttpError(
        409,
        "Thread already has active provider work.",
        "turn_active"
      ),
      "chat send"
    )
    expect(result).toEqual({
      message: "Thread already has active provider work.",
      statusCode: 409,
      code: "turn_active",
    })
  })

  it("surfaces the real message for allowlisted operational codes (duck-typed)", () => {
    // Mirrors ProviderTurnConflictError: extends Error (not HttpError) but
    // carries statusCode + a safe `turn_active` code. Its message must reach
    // the client instead of being masked to "chat send failed".
    class ProviderTurnConflictLike extends Error {
      readonly statusCode = 409
      readonly code = "turn_active"
      constructor() {
        super("Thread 't1' already has an active provider turn.")
        this.name = "ProviderTurnConflictError"
      }
    }
    const result = sanitizeError(new ProviderTurnConflictLike(), "chat send")
    expect(result.message).toBe(
      "Thread 't1' already has an active provider turn."
    )
    expect(result.statusCode).toBe(409)
    expect(result.code).toBe("turn_active")
  })

  it("masks the message of a duck-typed error with an unlisted code", () => {
    const err = Object.assign(new Error("secret internal detail"), {
      statusCode: 400,
      code: "some_internal_code",
    })
    const result = sanitizeError(err, "chat send")
    expect(result.message).toBe("chat send failed")
    expect(result.statusCode).toBe(400)
    expect(result.code).toBe("some_internal_code")
  })

  it("surfaces classified remote git failures", () => {
    const err = Object.assign(
      new Error("No remote configured - add one in Settings > Remotes."),
      {
        statusCode: 400,
        code: "git_remote_error",
      }
    )
    const result = sanitizeError(err, "git push")
    expect(result).toEqual({
      message: "No remote configured - add one in Settings > Remotes.",
      statusCode: 400,
      code: "git_remote_error",
    })
  })

  it("surfaces workspace trust refusals so the user learns why", () => {
    // `AgentWorkspaceUntrustedError` is duck-typed; its message names only
    // the refused operation, so it is safe and the only useful hint.
    const err = Object.assign(
      new Error("The workspace is untrusted and cannot Git mutation."),
      { statusCode: 403, code: "workspace_untrusted" }
    )
    expect(sanitizeError(err, "git commit")).toEqual({
      message: "The workspace is untrusted and cannot Git mutation.",
      statusCode: 403,
      code: "workspace_untrusted",
    })
  })

  it("masks arbitrary non-HttpError failures to a generic 500", () => {
    const result = sanitizeError(new Error("boom stack trace"), "chat send")
    expect(result).toEqual({ message: "chat send failed", statusCode: 500 })
  })
})
