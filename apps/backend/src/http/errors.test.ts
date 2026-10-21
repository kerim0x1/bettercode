import { afterEach, describe, expect, it, vi } from "vitest"
import { logger } from "../observability/logger"
import { runWithRequestContext } from "../observability/requestContext"
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

  describe("server-side diagnostics", () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it("logs the redacted message, stack and request id of an unexpected 500", () => {
      const error = vi.spyOn(logger, "error").mockImplementation(() => {})
      const err = new TypeError(
        "upstream rejected Authorization: Bearer abc.def.ghi with key sk-ant-1234567890abcdef"
      )
      const result = runWithRequestContext({ reqId: "deadbeef" }, () =>
        sanitizeError(err, "shell run", { path: "/api/v1/shell/run" })
      )
      expect(result).toEqual({ message: "shell run failed", statusCode: 500 })
      expect(error).toHaveBeenCalledTimes(1)
      const [bindings, message] = error.mock.calls[0] as [
        Record<string, unknown>,
        string,
      ]
      expect(message).toBe("shell run failed")
      expect(bindings).toMatchObject({
        operation: "shell run",
        path: "/api/v1/shell/run",
        statusCode: 500,
        errorType: "TypeError",
        reqId: "deadbeef",
      })
      expect(bindings.errorMessage).toContain("upstream rejected")
      expect(String(bindings.stack)).toContain("TypeError")
      const logged = JSON.stringify(bindings)
      expect(logged).not.toContain("abc.def.ghi")
      expect(logged).not.toContain("1234567890abcdef")
    })

    it("logs a refused 4xx at warn level without a stack", () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      const error = vi.spyOn(logger, "error").mockImplementation(() => {})
      const err = Object.assign(new Error("root is not registered"), {
        statusCode: 404,
        code: "root_not_found",
      })
      sanitizeError(err, "workspace read")
      expect(error).not.toHaveBeenCalled()
      const [bindings] = warn.mock.calls[0] as [Record<string, unknown>]
      expect(bindings.errorMessage).toBe("root is not registered")
      expect(bindings).not.toHaveProperty("stack")
    })

    it("logs a nominal 5xx HttpError but not a nominal 4xx one", () => {
      const error = vi.spyOn(logger, "error").mockImplementation(() => {})
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      sanitizeError(new HttpError(409, "conflict", "turn_active"), "chat send")
      expect(error).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      const result = sanitizeError(
        new HttpError(503, "Provider unavailable."),
        "chat send"
      )
      expect(result).toEqual({
        message: "Provider unavailable.",
        statusCode: 503,
        code: undefined,
      })
      expect(error).toHaveBeenCalledTimes(1)
      expect(error.mock.calls[0]?.[0]).toHaveProperty("stack")
    })
  })
})
