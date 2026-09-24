import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../services/shell", () => ({ runShellCommand: vi.fn() }))
vi.mock("../../services/workspace", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  searchEntriesDetailed: vi.fn(),
  searchContentDetailed: vi.fn(),
}))

import { executeTool, type ToolExecContext } from "./tool-executor"
import { runShellCommand } from "../../services/shell"
import {
  readFile,
  writeFile,
  searchEntriesDetailed,
  searchContentDetailed,
} from "../../services/workspace"

const ctx: ToolExecContext = {
  cwd: "/proj",
  toolId: "t1",
  limits: { maxLines: 2000, maxBytes: 50_000 },
}

beforeEach(() => vi.clearAllMocks())

/** A `/workspace/read` result; the executor only uses `content`. */
function readResult(content: string, path: string) {
  return {
    content,
    path,
    size: Buffer.byteLength(content),
    sha256: "0".repeat(64),
    isUtf8: true,
  }
}

describe("Read", () => {
  it("reads a file and returns its content", async () => {
    vi.mocked(readFile).mockResolvedValue(readResult("hello", "/proj/a.txt"))
    const r = await executeTool("Read", { path: "a.txt" }, ctx)
    expect(readFile).toHaveBeenCalledWith({
      cwd: "/proj",
      relative_path: "a.txt",
    })
    expect(r).toEqual({ output: "hello" })
  })

  it("surfaces a path-escape (403) as an executor error", async () => {
    const privateDiagnostic =
      "path escapes C:\\private\\project with token sk-sensitive"
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error(privateDiagnostic), { statusCode: 403 })
    )
    const r = await executeTool("Read", { path: "../secret" }, ctx)
    expect(r).toEqual({
      output: "Error: Tool access was denied.",
      error: "Tool access was denied.",
    })
    expect(JSON.stringify(r)).not.toContain(privateDiagnostic)
  })

  it("does not expose unexpected workspace diagnostics", async () => {
    const privateDiagnostic =
      "read C:\\private\\project\\secret.txt failed with token sk-sensitive"
    vi.mocked(readFile).mockRejectedValue(new Error(privateDiagnostic))

    const r = await executeTool("Read", { path: "secret.txt" }, ctx)

    expect(r).toEqual({
      output: "Error: Tool execution failed.",
      error: "Tool execution failed.",
    })
    expect(JSON.stringify(r)).not.toContain(privateDiagnostic)
  })

  it("requires a path", async () => {
    const r = await executeTool("Read", {}, ctx)
    expect(r.error).toBeTruthy()
    expect(readFile).not.toHaveBeenCalled()
  })

  it("rejects extra or mistyped provider arguments before workspace dispatch", async () => {
    const extra = await executeTool(
      "Read",
      { path: "a.txt", unexpected: true },
      ctx
    )
    const mistyped = await executeTool("Read", { path: 42 }, ctx)

    expect(extra.error).toContain('unexpected "unexpected"')
    expect(mistyped.error).toContain('"path" must be string')
    expect(readFile).not.toHaveBeenCalled()
  })

  it("normalizes established provider aliases before strict validation", async () => {
    vi.mocked(readFile).mockResolvedValue(readResult("legacy", "/proj/a.txt"))

    await expect(
      executeTool("Read", { file_path: "a.txt" }, ctx)
    ).resolves.toEqual({ output: "legacy" })
    expect(readFile).toHaveBeenCalledWith({
      cwd: "/proj",
      relative_path: "a.txt",
    })
  })

  it("errors when no folder is attached", async () => {
    const r = await executeTool("Read", { path: "a.txt" }, { ...ctx, cwd: "" })
    expect(r.error).toContain("No project folder")
    expect(readFile).not.toHaveBeenCalled()
  })
})

describe("Write", () => {
  it("binds a new file to a missing preimage and returns a structured patch", async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("missing"), { statusCode: 404 })
    )

    const result = await executeTool(
      "Write",
      { path: "new.txt", content: "hello\n" },
      ctx
    )

    expect(writeFile).toHaveBeenCalledWith("/proj", "new.txt", "hello\n", {
      expectedContentHash: null,
    })
    expect(result).toMatchObject({
      mutation: {
        path: "new.txt",
        operation: "write",
        preimageHash: null,
        resultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        additions: 1,
        deletions: 0,
        isNew: true,
        patchComplete: true,
        unifiedDiff: expect.stringContaining("+++ b/new.txt"),
      },
    })
  })
})

describe("Edit", () => {
  it("replaces a unique match", async () => {
    vi.mocked(readFile).mockResolvedValue(readResult("foo bar baz", "p"))
    const r = await executeTool(
      "Edit",
      { path: "a.txt", old_string: "bar", new_string: "qux" },
      ctx
    )
    expect(writeFile).toHaveBeenCalledWith("/proj", "a.txt", "foo qux baz", {
      expectedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(r.error).toBeUndefined()
    expect(r.mutation).toMatchObject({
      path: "a.txt",
      operation: "edit",
      additions: 1,
      deletions: 1,
      isNew: false,
      patchComplete: true,
    })
  })

  it("fails when old_string is not found", async () => {
    vi.mocked(readFile).mockResolvedValue(readResult("foo", "p"))
    const r = await executeTool(
      "Edit",
      { path: "a.txt", old_string: "zzz", new_string: "q" },
      ctx
    )
    expect(r.error).toContain("not found")
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("fails when old_string is ambiguous without replace_all", async () => {
    vi.mocked(readFile).mockResolvedValue(readResult("x x x", "p"))
    const r = await executeTool(
      "Edit",
      { path: "a.txt", old_string: "x", new_string: "y" },
      ctx
    )
    expect(r.error).toContain("not unique")
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("replace_all rewrites every occurrence", async () => {
    vi.mocked(readFile).mockResolvedValue(readResult("x x x", "p"))
    const r = await executeTool(
      "Edit",
      { path: "a.txt", old_string: "x", new_string: "y", replace_all: true },
      ctx
    )
    expect(writeFile).toHaveBeenCalledWith("/proj", "a.txt", "y y y", {
      expectedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(r.error).toBeUndefined()
  })

  it("treats $-sequences in new_string literally", async () => {
    vi.mocked(readFile).mockResolvedValue(readResult("a TOKEN b", "p"))
    await executeTool(
      "Edit",
      { path: "a.txt", old_string: "TOKEN", new_string: "$&$1" },
      ctx
    )
    expect(writeFile).toHaveBeenCalledWith("/proj", "a.txt", "a $&$1 b", {
      expectedContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it("redirects the model when a concurrent file change invalidates the preimage", async () => {
    vi.mocked(readFile).mockResolvedValue(readResult("old", "p"))
    vi.mocked(writeFile).mockRejectedValue(
      Object.assign(new Error("private workspace diagnostic"), {
        statusCode: 409,
        code: "WORKSPACE_PATH_CHANGED",
      })
    )

    const result = await executeTool(
      "Edit",
      { path: "a.txt", old_string: "old", new_string: "new" },
      ctx
    )

    expect(result).toEqual({
      output:
        "Error: The file changed after it was read. Read the latest contents and retry the edit.",
      error:
        "The file changed after it was read. Read the latest contents and retry the edit.",
    })
  })
})

describe("Bash", () => {
  it("returns combined output and passes the toolId as sessionId", async () => {
    vi.mocked(runShellCommand).mockResolvedValue({
      success: true,
      combined: "ok",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      sessionId: "t1",
      aborted: false,
      timedOut: false,
    })
    const r = await executeTool("Bash", { command: "echo ok" }, ctx)
    expect(runShellCommand).toHaveBeenCalledWith({
      command: "echo ok",
      cwd: "/proj",
      timeoutMs: 60_000,
      sessionId: "t1",
      signal: expect.any(AbortSignal),
    })
    expect(r.output).toContain("ok")
    expect(r.error).toBeUndefined()
  })

  it("treats a non-zero exit as a normal result (not an executor error)", async () => {
    vi.mocked(runShellCommand).mockResolvedValue({
      success: false,
      combined: "boom",
      stdout: "",
      stderr: "boom",
      exitCode: 2,
      sessionId: "t1",
      aborted: false,
      timedOut: false,
    })
    const r = await executeTool("Bash", { command: "false" }, ctx)
    expect(r.error).toBeUndefined()
    expect(r.output).toContain("exit code 2")
  })

  it("normalizes a shell-owned timeout and preserves bounded partial output", async () => {
    vi.mocked(runShellCommand).mockResolvedValueOnce({
      success: false,
      combined: "partial",
      stdout: "partial",
      stderr: "",
      exitCode: null,
      sessionId: "t1",
      aborted: false,
      timedOut: true,
    })

    await expect(
      executeTool("Bash", { command: "slow" }, ctx)
    ).resolves.toMatchObject({
      output: expect.stringContaining("partial"),
      error: "Tool execution timed out.",
      status: "timed_out",
    })
  })

  it("normalizes turn cancellation after the shell session settles", async () => {
    const controller = new AbortController()
    let releaseShell!: () => void
    let signalObserved = false
    vi.mocked(runShellCommand).mockImplementationOnce(
      ({ sessionId = "generated", signal }) =>
        new Promise((resolve) => {
          releaseShell = () =>
            resolve({
              success: false,
              combined: "",
              stdout: "",
              stderr: "",
              exitCode: null,
              sessionId,
              aborted: true,
              timedOut: false,
            })
          signal?.addEventListener(
            "abort",
            () => {
              signalObserved = true
            },
            { once: true }
          )
        })
    )

    const pending = executeTool(
      "Bash",
      { command: "long-running" },
      {
        ...ctx,
        signal: controller.signal,
      }
    )
    let published = false
    void pending.then(() => {
      published = true
    })
    await vi.waitFor(() => expect(runShellCommand).toHaveBeenCalledOnce())
    controller.abort()
    await Promise.resolve()
    expect(signalObserved).toBe(true)
    expect(published).toBe(false)
    releaseShell()

    await expect(pending).resolves.toEqual({
      output: "Error: Tool execution was cancelled.",
      error: "Tool execution was cancelled.",
      status: "cancelled",
    })
  })

  it("enforces the bounded central timeout and distinguishes it from cancellation", async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(runShellCommand).mockImplementationOnce(
        ({ sessionId = "generated", signal }) =>
          new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () =>
                resolve({
                  success: false,
                  combined: "",
                  stdout: "",
                  stderr: "",
                  exitCode: null,
                  sessionId,
                  aborted: true,
                  timedOut: false,
                }),
              { once: true }
            )
          })
      )

      const pending = executeTool(
        "Bash",
        { command: "long-running", timeout_ms: 25 },
        { ...ctx, timeoutMs: 1_000 }
      )
      await vi.advanceTimersByTimeAsync(25)

      await expect(pending).resolves.toEqual({
        output: "Error: Tool execution timed out.",
        error: "Tool execution timed out.",
        status: "timed_out",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not disguise an incomplete process-tree cleanup as cancellation", async () => {
    const controller = new AbortController()
    vi.mocked(runShellCommand).mockImplementationOnce(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("tree survived"), {
                  code: "SHELL_PROCESS_TREE_INCOMPLETE",
                })
              ),
            { once: true }
          )
        })
    )

    const pending = executeTool(
      "Bash",
      { command: "long-running" },
      {
        ...ctx,
        signal: controller.signal,
      }
    )
    await vi.waitFor(() => expect(runShellCommand).toHaveBeenCalledOnce())
    controller.abort()

    await expect(pending).resolves.toEqual({
      output: "Error: Tool process cleanup failed.",
      error: "Tool process cleanup failed.",
    })
  })
})

describe("central execution lifecycle", () => {
  it("does not dispatch an already-cancelled tool", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      executeTool(
        "Read",
        { path: "a.txt" },
        {
          ...ctx,
          signal: controller.signal,
        }
      )
    ).resolves.toMatchObject({ status: "cancelled" })
    expect(readFile).not.toHaveBeenCalled()
  })

  it("bounds a non-process workspace primitive without leaking rejection", async () => {
    vi.useFakeTimers()
    let finishRead!: (value: ReturnType<typeof readResult>) => void
    try {
      vi.mocked(readFile).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = resolve
          })
      )
      const pending = executeTool(
        "Read",
        { path: "a.txt" },
        {
          ...ctx,
          timeoutMs: 20,
        }
      )

      await vi.advanceTimersByTimeAsync(20)
      await expect(pending).resolves.toMatchObject({
        error: "Tool execution timed out.",
        status: "timed_out",
      })

      // The underlying Node filesystem primitive is not forcibly cancellable;
      // its handled promise may settle later without changing the published
      // result or creating an unhandled rejection.
      finishRead(readResult("late", "/proj/a.txt"))
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits for a mutating workspace primitive to quiesce before timing out", async () => {
    vi.useFakeTimers()
    let finishWrite!: () => void
    try {
      vi.mocked(readFile).mockRejectedValueOnce(
        Object.assign(new Error("missing"), { statusCode: 404 })
      )
      vi.mocked(writeFile).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishWrite = resolve
          })
      )
      const pending = executeTool(
        "Write",
        { path: "a.txt", content: "late" },
        { ...ctx, timeoutMs: 20 }
      )
      let published = false
      void pending.then(() => {
        published = true
      })

      await vi.advanceTimersByTimeAsync(20)
      expect(published).toBe(false)
      finishWrite()

      await expect(pending).resolves.toMatchObject({
        error: "Tool execution timed out.",
        status: "timed_out",
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("Glob / Grep", () => {
  it("Glob lists matching paths and marks directories", async () => {
    vi.mocked(searchEntriesDetailed).mockResolvedValue({
      entries: [
        { path: "src/a.ts", name: "a.ts", is_dir: false },
        { path: "src", name: "src", is_dir: true },
      ],
      truncated: false,
    })
    const r = await executeTool("Glob", { pattern: "a" }, ctx)
    expect(searchEntriesDetailed).toHaveBeenCalledWith("/proj", "a")
    expect(r.output).toContain("src/a.ts")
    expect(r.output).toContain("src/")
    expect(r.output).not.toContain("truncated")
  })

  it("Glob tells the agent when the listing was cut short", async () => {
    vi.mocked(searchEntriesDetailed).mockResolvedValue({
      entries: [{ path: "src/a.ts", name: "a.ts", is_dir: false }],
      truncated: true,
      truncatedReason: "deadline",
    })
    const r = await executeTool("Glob", { pattern: "a" }, ctx)
    expect(r.output).toContain("src/a.ts")
    expect(r.output).toContain("[results truncated (deadline)")
  })

  it("Grep formats path:line: preview", async () => {
    vi.mocked(searchContentDetailed).mockResolvedValue({
      results: [
        {
          path: "src/a.ts",
          name: "a.ts",
          matches: [
            {
              line: 12,
              column: 1,
              length: 3,
              previewColumn: 1,
              previewLength: 3,
              preview: "  foo()",
            },
          ],
        },
      ],
      truncated: false,
    })
    const r = await executeTool("Grep", { pattern: "foo", regex: true }, ctx)
    expect(searchContentDetailed).toHaveBeenCalledWith("/proj", "foo", {
      regex: true,
      caseSensitive: false,
      include: undefined,
      exclude: undefined,
    })
    expect(r.output).toContain("src/a.ts:12: foo()")
    expect(r.output).not.toContain("truncated")
  })

  it("Grep tells the agent when matches were cut short", async () => {
    vi.mocked(searchContentDetailed).mockResolvedValue({
      results: [],
      truncated: true,
      truncatedReason: "limit",
    })
    const r = await executeTool("Grep", { pattern: "foo" }, ctx)
    expect(r.output).toContain('No matches for "foo".')
    expect(r.output).toContain("[matches truncated (limit)")
  })

  it("reports truncation when the listing times out before finding any paths", async () => {
    vi.mocked(searchEntriesDetailed).mockResolvedValue({
      entries: [],
      truncated: true,
      truncatedReason: "deadline",
    })
    const r = await executeTool("Glob", { pattern: "foo" }, ctx)
    expect(r.output).toContain('No files match "foo".')
    expect(r.output).toContain("[results truncated (deadline)")
  })
})

describe("truncation + unknown", () => {
  it("truncates output by line cap", async () => {
    const big = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    vi.mocked(readFile).mockResolvedValue(readResult(big, "p"))
    const r = await executeTool(
      "Read",
      { path: "a.txt" },
      {
        ...ctx,
        limits: { maxLines: 3, maxBytes: 50_000 },
      }
    )
    expect(r.output).toContain("line0")
    expect(r.output).toContain("truncated")
    expect(r.output).not.toContain("line9")
  })

  it("enforces the byte cap without splitting Unicode code points", async () => {
    vi.mocked(readFile).mockResolvedValue(readResult("😀".repeat(100), "p"))
    const r = await executeTool(
      "Read",
      { path: "a.txt" },
      {
        ...ctx,
        limits: { maxLines: 2000, maxBytes: 64 },
      }
    )
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(64)
    expect(r.output).toContain("truncated")
    expect(r.output).not.toContain("�")
  })

  it("returns an error for an unknown tool", async () => {
    const r = await executeTool("Nope", {}, ctx)
    expect(r.error).toContain("Unknown tool")
  })
})
