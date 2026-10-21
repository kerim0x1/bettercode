import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  configureBackendLogging,
  getBackendLoggingSettings,
  logger,
} from "./logger"

let output: string[] = []
let previous: ReturnType<typeof getBackendLoggingSettings>

beforeEach(() => {
  previous = getBackendLoggingSettings()
  configureBackendLogging({
    backend_log_format: "simple",
    backend_log_level: "debug",
  })
  output = []
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    output.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
})

afterEach(() => {
  vi.restoreAllMocks()
  configureBackendLogging({
    backend_log_format: previous.format,
    backend_log_level: previous.level,
  })
})

describe("simple log format", () => {
  it("prints the stack and cause chain of an error below the summary line", () => {
    const err = new Error("request failed", {
      cause: new Error("socket hang up"),
    })
    logger.error({ err, operation: "providers.list" }, "providers.list failed")
    const [line] = output
    expect(line.split("\n")[0]).toBe(
      "error providers.list failed err=request failed operation=providers.list"
    )
    expect(line).toMatch(/\n {4}err: Error: request failed\n {4}\s+at /)
    expect(line).toMatch(/\n {4}Caused by: Error: socket hang up/)
  })

  it("prints explicit stack and cause bindings as blocks, redacted", () => {
    logger.error(
      {
        operation: "x",
        stack:
          "Error: upstream said Bearer abcdefghijklmnop\n    at handler (x.ts:1:1)",
        cause: "Error: token=supersecretvalue",
      },
      "x failed"
    )
    const [line] = output
    expect(line.split("\n")[0]).toBe("error x failed operation=x")
    expect(line).toContain("    stack: Error: upstream said Bearer [REDACTED]")
    expect(line).toContain("        at handler (x.ts:1:1)")
    expect(line).toContain("    cause: Error: token=[REDACTED]")
    expect(line).not.toContain("supersecretvalue")
  })

  it("keeps warnings to one line and redacts credential-named bindings", () => {
    logger.warn(
      { err: new Error("probe failed"), apiKey: "sk-live", token: "t" },
      "probe"
    )
    expect(output).toEqual([
      "warn probe err=probe failed apiKey=[REDACTED] token=[REDACTED]\n",
    ])
  })
})
