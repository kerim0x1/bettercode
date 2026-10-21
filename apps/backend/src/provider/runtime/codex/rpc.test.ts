import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { logger } from "../../../observability/logger"

const terminateProviderChildProcessTree = vi.hoisted(() => vi.fn())

vi.mock("../ChildProcessTermination", () => ({
  terminateProviderChildProcessTree,
}))

import { CodexRpcClient, CodexServerResponseRefusedError } from "./rpc"

describe("CodexRpcClient close lifecycle", () => {
  beforeEach(() => {
    terminateProviderChildProcessTree.mockReset()
  })

  it("retains a child after failed termination so a later close can retry", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 7_101,
      exitCode: null,
      signalCode: null,
      stdin: {
        end: vi.fn(),
      },
    }) as unknown as ChildProcessWithoutNullStreams
    const client = new CodexRpcClient({ binaryPath: "codex" })
    const state = client as unknown as {
      child: ChildProcessWithoutNullStreams | null
    }
    state.child = child
    const firstFailure = new Error("tree still alive")
    terminateProviderChildProcessTree
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce(undefined)

    await expect(client.close()).rejects.toBe(firstFailure)
    expect(state.child).toBe(child)

    await expect(client.close()).resolves.toBeUndefined()
    expect(state.child).toBeNull()
    expect(terminateProviderChildProcessTree).toHaveBeenCalledTimes(2)
  })

  it("deduplicates concurrent close attempts for the same child", async () => {
    let finishTermination: (() => void) | undefined
    terminateProviderChildProcessTree.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishTermination = resolve
        })
    )
    const child = Object.assign(new EventEmitter(), {
      pid: 7_202,
      exitCode: null,
      signalCode: null,
      stdin: {
        end: vi.fn(),
      },
    }) as unknown as ChildProcessWithoutNullStreams
    const client = new CodexRpcClient({ binaryPath: "codex" })
    ;(
      client as unknown as {
        child: ChildProcessWithoutNullStreams | null
      }
    ).child = child

    const first = client.close()
    const second = client.close()
    expect(terminateProviderChildProcessTree).toHaveBeenCalledTimes(1)

    finishTermination?.()
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ])
  })
})

describe("CodexRpcClient child stream lifecycle", () => {
  function attachFakeChild(client: CodexRpcClient) {
    const child = Object.assign(new EventEmitter(), {
      pid: 7_303,
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdin: Object.assign(new EventEmitter(), { write: vi.fn(() => true) }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    ;(
      client as unknown as {
        attachChild: (child: ChildProcessWithoutNullStreams) => void
      }
    ).attachChild(child as unknown as ChildProcessWithoutNullStreams)
    return child
  }

  it.skipIf(process.platform !== "win32").each(["during", "after"])(
    "retains unconfirmed descendants when the root exits %s failed cleanup",
    async (timing) => {
      const client = new CodexRpcClient({ binaryPath: "codex" })
      const child = attachFakeChild(client)
      const state = client as unknown as {
        child: ChildProcessWithoutNullStreams | null
      }
      const failure = new Error("taskkill failed")
      const exit = () => {
        child.exitCode = 1
        child.emit("exit", 1, null)
      }
      terminateProviderChildProcessTree
        .mockReset()
        .mockImplementationOnce(async () => {
          if (timing === "during") exit()
          throw failure
        })
      await expect(client.close()).rejects.toBe(failure)
      if (timing === "after") exit()
      expect(state.child).toBe(child)
      await expect(client.close()).rejects.toThrow(
        "descendant cleanup remains unconfirmed"
      )
      expect(terminateProviderChildProcessTree).toHaveBeenCalledOnce()
      expect(client.isAlive()).toBe(false)
    }
  )

  it("ignores non-object JSON and malformed request ids without crashing", () => {
    const client = new CodexRpcClient({ binaryPath: "codex" })
    const child = attachFakeChild(client)
    const requested = vi.fn()
    client.setServerRequestHandler(requested)
    for (const value of [
      null,
      [],
      false,
      42,
      "noise",
      { id: {}, method: "approval" },
    ]) {
      expect(() =>
        child.stdout.write(JSON.stringify(value) + "\n")
      ).not.toThrow()
    }
    expect(requested).not.toHaveBeenCalled()
    child.stdout.write(
      JSON.stringify({ id: "valid", method: "approval" }) + "\n"
    )
    expect(requested).toHaveBeenCalledTimes(1)
  })

  it("preserves split UTF-8 notifications and a final line without a newline", async () => {
    const client = new CodexRpcClient({ binaryPath: "codex" })
    const child = attachFakeChild(client)
    const notified = vi.fn()
    client.onNotification("ready", notified)
    const frame = Buffer.from(
      JSON.stringify({ method: "ready", params: { text: "é" } })
    )
    const split = frame.indexOf(Buffer.from("é")) + 1
    child.stdout.write(frame.subarray(0, split))
    child.stdout.end(frame.subarray(split))
    await new Promise<void>((resolve) => child.stdout.once("end", resolve))
    expect(notified).toHaveBeenCalledWith("ready", { text: "é" })
  })

  it("skips an oversized line, fails only its call and keeps the app-server", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    terminateProviderChildProcessTree.mockResolvedValue(undefined)
    const client = new CodexRpcClient({
      binaryPath: "codex",
      stdoutLineByteCap: 100,
    })
    const child = attachFakeChild(client)
    const errors: Error[] = []
    client.on("child-error", (error) => errors.push(error))
    const notified = vi.fn()
    client.onNotification("turn/diff/updated", notified)
    const pending = client.call("turn/start")
    void pending.catch(() => {})
    try {
      // An unterminated oversized frame is not accumulated in memory.
      child.stdout.write(Buffer.from('{"id":1,"result":"' + "é".repeat(60)))
      child.stdout.write(Buffer.from("é".repeat(60) + '"}\n'))
      await expect(pending).rejects.toThrow(
        /response for turn\/start exceeded the 100-byte line cap/i
      )
      // An oversized notification is dropped; the next one still arrives.
      child.stdout.write(
        `{"method":"turn/diff/updated","params":{"diff":"${"x".repeat(200)}"}}\n`
      )
      child.stdout.write(
        '{"method":"turn/diff/updated","params":{"diff":"ok"}}\n'
      )
      expect(notified).toHaveBeenCalledTimes(1)
      expect(notified).toHaveBeenCalledWith("turn/diff/updated", { diff: "ok" })
      expect(errors).toEqual([])
      expect(terminateProviderChildProcessTree).not.toHaveBeenCalled()
      expect(client.isAlive()).toBe(true)
    } finally {
      await client.close()
      warn.mockRestore()
    }
  })

  it("logs a throwing notification handler instead of swallowing it", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {})
    try {
      const client = new CodexRpcClient({ binaryPath: "codex" })
      const child = attachFakeChild(client)
      const after = vi.fn()
      client.onNotification("*", () => {
        throw new Error("translator bug")
      })
      client.onNotification("*", after)
      child.stdout.write('{"method":"item/started","params":{}}\n')
      expect(after).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ method: "item/started" }),
        expect.stringContaining("notification handler threw")
      )
    } finally {
      error.mockRestore()
    }
  })

  it("answers a server request when no handler is registered", () => {
    const client = new CodexRpcClient({ binaryPath: "codex" })
    const child = attachFakeChild(client)
    child.stdout.write('{"id":"srv-1","method":"item/tool/call","params":{}}\n')
    const written = child.stdin.write.mock.calls.map((call) =>
      JSON.parse(String((call as unknown[])[0]))
    )
    expect(written).toContainEqual(
      expect.objectContaining({
        id: "srv-1",
        error: expect.objectContaining({ code: -32601 }),
      })
    )
  })

  it("survives a stdin error without throwing and reports it", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const client = new CodexRpcClient({
        binaryPath: "codex",
        callTimeoutMs: 50,
      })
      const child = attachFakeChild(client)
      const childErrors: unknown[] = []
      client.on("child-error", (error) => childErrors.push(error))

      expect(() => child.stdin.emit("error", new Error("EPIPE"))).not.toThrow()

      expect(childErrors).toEqual([
        expect.objectContaining({ message: "EPIPE" }),
      ])
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ label: "codex rpc" }),
        "codex rpc stdin errored; later writes are dropped"
      )
      // A call after the pipe died fails immediately instead of hanging on
      // the timeout with a payload nobody will ever read.
      await expect(client.call("thread/start")).rejects.toThrow(
        /stdin is closed/
      )
      expect(child.stdin.write).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("rejects a call already in flight when stdin errors instead of waiting out the timeout", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const client = new CodexRpcClient({
        binaryPath: "codex",
        callTimeoutMs: 60_000,
      })
      const child = attachFakeChild(client)
      client.on("child-error", () => {})
      const pending = client.call("turn/start")
      void pending.catch(() => {})
      expect(child.stdin.write).toHaveBeenCalledTimes(1)

      child.stdin.emit("error", new Error("EPIPE"))

      await expect(pending).rejects.toThrow(
        /stdin errored while waiting on turn\/start: EPIPE/
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("builds exactly one stdin writer when a call races the spawn", () => {
    const client = new CodexRpcClient({ binaryPath: "codex" })
    const child = attachFakeChild(client)
    const state = client as unknown as {
      stdin: unknown
      attachChild: (child: ChildProcessWithoutNullStreams) => void
    }
    const first = state.stdin
    // Re-attaching the same child (as spawnChild does after building the
    // writer before its await) must not build a second writer over the pipe.
    state.attachChild(child as unknown as ChildProcessWithoutNullStreams)
    expect(state.stdin).toBe(first)
    expect(child.stdin.listenerCount("error")).toBe(1)
  })

  it("forgets the child on exit and turns late server responses into a log line", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const client = new CodexRpcClient({ binaryPath: "codex" })
      const child = attachFakeChild(client)
      const state = client as unknown as {
        child: ChildProcessWithoutNullStreams | null
        handleLine: (line: string) => void
      }
      let lateRespond: ((result: unknown) => void) | null = null
      let lateRespondError: ((code: number, message: string) => void) | null =
        null
      client.setServerRequestHandler(
        (_method, _params, respond, respondError) => {
          lateRespond = respond
          lateRespondError = respondError
        }
      )
      state.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "item/commandExecution/requestApproval",
          params: {},
        })
      )

      child.emit("exit", 0, null)
      expect(state.child).toBeNull()
      expect(client.isAlive()).toBe(false)

      expect(() => lateRespond?.({ decision: "accept" })).not.toThrow()
      expect(() => lateRespondError?.(-1, "denied")).not.toThrow()
      expect(child.stdin.write).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "item/commandExecution/requestApproval",
          id: 9,
        }),
        "codex rpc server-request response dropped; child already exited"
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("fails the turn when the reply to an approval request is refused by the stdin writer", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
    const error = vi.spyOn(logger, "error").mockImplementation(() => {})
    try {
      const client = new CodexRpcClient({
        binaryPath: "codex",
        callTimeoutMs: 60_000,
      })
      const child = attachFakeChild(client)
      const state = client as unknown as { handleLine: (line: string) => void }
      const childErrors: unknown[] = []
      client.on("child-error", (failure) => childErrors.push(failure))
      const captured: { respond: ((result: unknown) => void) | null } = {
        respond: null,
      }
      client.setServerRequestHandler((_method, _params, reply) => {
        captured.respond = reply
      })
      // The turn request goes out; the approval reply hits a pipe that dies
      // mid-write, so the writer refuses it.
      child.stdin.write.mockReturnValueOnce(true).mockImplementationOnce(() => {
        throw new Error("EPIPE")
      })
      const pending = client.call("turn/start")
      void pending.catch(() => {})
      state.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "item/commandExecution/requestApproval",
          params: {},
        })
      )
      expect(captured.respond).not.toBeNull()
      captured.respond?.({ decision: "accept" })

      await expect(pending).rejects.toBeInstanceOf(
        CodexServerResponseRefusedError
      )
      expect(childErrors).toEqual([
        expect.objectContaining({
          name: "CodexServerResponseRefusedError",
          method: "item/commandExecution/requestApproval",
          requestId: 9,
        }),
      ])
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "item/commandExecution/requestApproval",
          id: 9,
        }),
        "codex rpc server-request response refused by the stdin writer; failing the turn"
      )
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it("forgets a child that failed to spawn so close() has nothing to terminate", async () => {
    const missing =
      process.platform === "win32"
        ? "C:\\betterc0de-missing\\missing.exe"
        : "/betterc0de-missing/missing"
    const client = new CodexRpcClient({ binaryPath: missing })
    const state = client as unknown as {
      child: ChildProcessWithoutNullStreams | null
    }
    await expect(client.spawnChild()).rejects.toMatchObject({ code: "ENOENT" })
    expect(state.child).toBeNull()
    expect(client.isAlive()).toBe(false)
    await expect(client.close()).resolves.toBeUndefined()
  })

  it("waits for drain before writing more when stdin reports backpressure", () => {
    const client = new CodexRpcClient({
      binaryPath: "codex",
      callTimeoutMs: 10_000,
    })
    const child = attachFakeChild(client)
    child.stdin.write.mockReturnValueOnce(false).mockReturnValue(true)

    void client.call("first").catch(() => {})
    client.notify("second")
    client.notify("third")
    expect(child.stdin.write).toHaveBeenCalledTimes(1)

    child.stdin.emit("drain")
    expect(child.stdin.write).toHaveBeenCalledTimes(3)
    const methods = child.stdin.write.mock.calls.map(
      (call) =>
        (JSON.parse((call as unknown as [string])[0]) as { method: string })
          .method
    )
    expect(methods).toEqual(["first", "second", "third"])
    void client.close()
  })
})
