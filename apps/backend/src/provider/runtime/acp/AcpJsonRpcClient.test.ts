import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { logger } from "../../../observability/logger"
import {
  AcpJsonRpcClient,
  AcpRpcTimeoutError,
  AcpServerResponseRefusedError,
  acpTurnFailureMessage,
  acpWindowsKillRecord,
  terminateAcpChildProcess,
} from "./AcpJsonRpcClient"

describe("AcpJsonRpcClient", () => {
  it("retains a child after failed termination so close can retry", async () => {
    const cleanupFailure = new Error("ACP tree still alive")
    const terminateChildProcess = vi
      .fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const client = new AcpJsonRpcClient({
      command: "cursor-agent",
      terminateChildProcess,
    })
    const child = Object.assign(new EventEmitter(), {
      pid: 8_101,
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcessWithoutNullStreams
    const state = client as unknown as {
      child: ChildProcessWithoutNullStreams | null
    }
    state.child = child

    await expect(client.close()).rejects.toBe(cleanupFailure)
    expect(state.child).toBe(child)

    await expect(client.close()).resolves.toBeUndefined()
    expect(state.child).toBeNull()
    expect(terminateChildProcess).toHaveBeenCalledTimes(2)
  })

  it("forgets a child that failed to spawn so close() has nothing to terminate", async () => {
    const missing =
      process.platform === "win32"
        ? "C:\\betterc0de-missing\\missing.exe"
        : "/betterc0de-missing/missing"
    const client = new AcpJsonRpcClient({ command: missing })
    const state = client as unknown as {
      child: ChildProcessWithoutNullStreams | null
    }
    await expect(client.spawnChild()).rejects.toMatchObject({ code: "ENOENT" })
    expect(state.child).toBeNull()
    expect(client.isAlive()).toBe(false)
    await expect(client.close()).resolves.toBeUndefined()
  })

  it("exchanges JSON-RPC calls, notifications, and server requests over stdio", async () => {
    const client = new AcpJsonRpcClient({
      command: process.execPath,
      args: ["-e", mockAcpPeerScript],
      callTimeoutMs: 5_000,
    })
    const notifications: Array<{ method: string; params: unknown }> = []
    const serverRequests: Array<{ method: string; params: unknown }> = []
    client.onNotification("session/update", (method, params) => {
      notifications.push({ method, params })
    })
    client.setServerRequestHandler((method, params, respond) => {
      serverRequests.push({ method, params })
      respond({ outcome: { outcome: "selected", optionId: "allow-once" } })
    })

    await client.spawnChild()
    await expect(
      client.call("initialize", { protocolVersion: 1 })
    ).resolves.toEqual({
      protocolVersion: 1,
    })
    await expect(
      client.call("session/prompt", { sessionId: "s1", prompt: [] })
    ).resolves.toEqual({ stopReason: "end_turn" })

    expect(notifications).toEqual([
      {
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
          },
        },
      },
    ])
    expect(serverRequests).toEqual([
      {
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: { toolCallId: "tool-1", kind: "execute" },
          options: [{ optionId: "allow-once", kind: "allow_once" }],
        },
      },
    ])

    await client.close()
  })

  it("fails only the call whose response exceeds the byte cap and keeps the agent", async () => {
    const client = new AcpJsonRpcClient({
      command: process.execPath,
      args: [
        "-e",
        `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "huge") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: "x".repeat(2048) }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n");
});
`,
      ],
      callTimeoutMs: 5_000,
      stdoutLineByteCap: 1_024,
    })
    const childErrors: Error[] = []
    client.on("child-error", (error: Error) => childErrors.push(error))

    await client.spawnChild()
    try {
      await expect(client.call("huge", {})).rejects.toThrow(
        /response for huge exceeded the 1024-byte line cap/i
      )
      await expect(client.call("small", {})).resolves.toEqual({ ok: true })
      expect(client.isAlive()).toBe(true)
      expect(childErrors).toEqual([])
    } finally {
      await client.close()
    }
  })

  /**
   * `session/prompt` only resolves when the whole turn is finished. It used to
   * share the 60s per-call timeout, so every turn that took longer than a
   * minute was killed mid-work and surfaced to the user as
   * "Error: Grok provider failed."
   */
  describe("long-running prompt", () => {
    function attachFakeChild(client: AcpJsonRpcClient): void {
      const child = Object.assign(new EventEmitter(), {
        pid: 4_242,
        exitCode: null,
        signalCode: null,
        stdin: { write: () => true },
      }) as unknown as ChildProcessWithoutNullStreams
      ;(
        client as unknown as { child: ChildProcessWithoutNullStreams | null }
      ).child = child
    }

    function feedLine(client: AcpJsonRpcClient, payload: unknown): void {
      ;(client as unknown as { handleLine: (line: string) => void }).handleLine(
        JSON.stringify(payload)
      )
    }

    it("stays alive far past its budget while the agent keeps streaming", async () => {
      vi.useFakeTimers()
      try {
        const client = new AcpJsonRpcClient({ command: "grok" })
        attachFakeChild(client)

        const pending = client.call("session/prompt", {}, 1_000, {
          resetTimeoutOnActivity: true,
        })
        let settled = false
        void pending.then(
          () => (settled = true),
          () => (settled = true)
        )

        // Five times the raw budget, but never silent for a full window.
        for (let i = 0; i < 5; i += 1) {
          await vi.advanceTimersByTimeAsync(900)
          feedLine(client, {
            jsonrpc: "2.0",
            method: "session/update",
            params: {},
          })
        }
        expect(settled).toBe(false)

        // Only silence ends it.
        await vi.advanceTimersByTimeAsync(1_001)
        await expect(pending).rejects.toThrow(/no output for 1000 ms/)
      } finally {
        vi.useRealTimers()
      }
    })

    it("reports a timeout as a timeout, not as a generic provider fault", () => {
      // The whole point of the typed error: the user learns the agent went
      // quiet. Before this, a killed turn read as "Grok provider failed." and
      // the only explanation lived in the backend log.
      const idle = new AcpRpcTimeoutError("session/prompt", 600_000, true)
      expect(acpTurnFailureMessage(idle, "Grok")).toBe(
        "Grok stopped responding — nothing received for 10 minutes."
      )

      const hard = new AcpRpcTimeoutError("session/new", 30_000, false)
      expect(acpTurnFailureMessage(hard, "Cursor")).toBe(
        "Cursor did not answer within 30s."
      )
    })

    it("keeps every other failure generic", () => {
      // Only the timeout is safe to repeat verbatim. Anything else could carry
      // a path, a prompt fragment or a credential.
      for (const err of [
        new Error("ENOENT /home/user/.secret/token"),
        new Error("acp rpc error -32000: internal"),
        "not even an error",
        null,
      ]) {
        expect(acpTurnFailureMessage(err, "Grok")).toBe("Grok provider failed.")
      }
    })

    it("still fails a call that opted out of activity resets", async () => {
      vi.useFakeTimers()
      try {
        const client = new AcpJsonRpcClient({ command: "grok" })
        attachFakeChild(client)

        const pending = client.call("session/new", {}, 1_000)
        void pending.catch(() => {})

        // Traffic must NOT rescue an ordinary call — a handshake that never
        // answers is a real failure, not a long turn.
        await vi.advanceTimersByTimeAsync(900)
        feedLine(client, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {},
        })
        await vi.advanceTimersByTimeAsync(101)
        await expect(pending).rejects.toThrow(/timeout after 1000 ms/)
      } finally {
        vi.useRealTimers()
      }
    })

    it("holds the silence limit while the agent waits on our answer", async () => {
      vi.useFakeTimers()
      try {
        const client = new AcpJsonRpcClient({ command: "grok" })
        attachFakeChild(client)

        const pending = client.call("session/prompt", {}, 1_000, {
          resetTimeoutOnActivity: true,
        })
        let settled = false
        void pending.then(
          () => (settled = true),
          () => (settled = true)
        )

        await vi.advanceTimersByTimeAsync(900)
        const release = client.holdIdleTimeouts()
        // A permission request parked for the user for an hour, with traffic
        // in between that must not restart the clock during the hold.
        await vi.advanceTimersByTimeAsync(30 * 60_000)
        feedLine(client, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {},
        })
        await vi.advanceTimersByTimeAsync(30 * 60_000)
        expect(settled).toBe(false)

        // Releasing gives the call its full window back, not the 100 ms left.
        release()
        release()
        await vi.advanceTimersByTimeAsync(999)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(2)
        await expect(pending).rejects.toThrow(/no output for 1000 ms/)
      } finally {
        vi.useRealTimers()
      }
    })

    it("waits for the last of several holds and leaves fixed deadlines alone", async () => {
      vi.useFakeTimers()
      try {
        const client = new AcpJsonRpcClient({ command: "grok" })
        attachFakeChild(client)

        const first = client.holdIdleTimeouts()
        const second = client.holdIdleTimeouts()
        // Started during a hold: its silence clock starts on release.
        const prompt = client.call("session/prompt", {}, 1_000, {
          resetTimeoutOnActivity: true,
        })
        let promptSettled = false
        void prompt.then(
          () => (promptSettled = true),
          () => (promptSettled = true)
        )
        const handshake = client.call("session/new", {}, 1_000)
        void handshake.catch(() => {})

        await vi.advanceTimersByTimeAsync(1_001)
        await expect(handshake).rejects.toThrow(/timeout after 1000 ms/)
        expect(promptSettled).toBe(false)

        first()
        await vi.advanceTimersByTimeAsync(5_000)
        expect(promptSettled).toBe(false)

        second()
        await vi.advanceTimersByTimeAsync(1_001)
        await expect(prompt).rejects.toThrow(/no output for 1000 ms/)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("child stream lifecycle", () => {
    function attachFakeChild(client: AcpJsonRpcClient) {
      const child = Object.assign(new EventEmitter(), {
        pid: 8_303,
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

    it("answers an oversized server request and drops an oversized notification", async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      try {
        const client = new AcpJsonRpcClient({
          command: "cursor-agent",
          stdoutLineByteCap: 256,
        })
        const child = attachFakeChild(client)
        const notified = vi.fn()
        client.onNotification("session/update", notified)
        const big = "y".repeat(1_024)
        child.stdout.write(
          `{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"blob":"${big}"}}\n`
        )
        child.stdout.write(
          `{"jsonrpc":"2.0","method":"session/update","params":{"blob":"${big}"}}\n`
        )
        child.stdout.write(
          '{"jsonrpc":"2.0","method":"session/update","params":{"small":true}}\n'
        )
        const written = child.stdin.write.mock.calls.map((call) =>
          JSON.parse(String((call as unknown[])[0]))
        )
        expect(written).toContainEqual(
          expect.objectContaining({
            id: "perm-1",
            error: expect.objectContaining({ code: -32600 }),
          })
        )
        expect(notified).toHaveBeenCalledTimes(1)
        expect(notified).toHaveBeenCalledWith("session/update", { small: true })
        expect(client.isAlive()).toBe(true)
      } finally {
        warn.mockRestore()
      }
    })

    it("keeps a bounded stderr tail across chunk boundaries", () => {
      const client = new AcpJsonRpcClient({ command: "cursor-agent" })
      const child = attachFakeChild(client)
      child.stderr.write("Error: login expi")
      child.stderr.write("red, run cursor-agent login\n")
      expect(client.stderrText()).toBe(
        "Error: login expired, run cursor-agent login"
      )
    })

    it("ignores non-record JSON lines and invalid request IDs before dispatch", async () => {
      const client = new AcpJsonRpcClient({ command: "cursor-agent" })
      const child = attachFakeChild(client)
      const serverRequest = vi.fn()
      client.setServerRequestHandler(serverRequest)
      const pending = client.call("initialize")
      for (const payload of [
        null,
        [],
        true,
        7,
        "text",
        { id: {}, method: "session/request_permission" },
      ]) {
        expect(() =>
          child.stdout.write(`${JSON.stringify(payload)}\n`)
        ).not.toThrow()
      }
      expect(serverRequest).not.toHaveBeenCalled()
      child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n')
      await expect(pending).resolves.toEqual({ ok: true })
    })

    it("survives a stdin error without throwing and reports it", async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      try {
        const client = new AcpJsonRpcClient({
          command: "cursor-agent",
          callTimeoutMs: 50,
        })
        const child = attachFakeChild(client)
        const childErrors: unknown[] = []
        client.on("child-error", (error) => childErrors.push(error))

        expect(() =>
          child.stdin.emit("error", new Error("EPIPE"))
        ).not.toThrow()

        expect(childErrors).toEqual([
          expect.objectContaining({ message: "EPIPE" }),
        ])
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ label: "acp rpc" }),
          "acp rpc stdin errored; later writes are dropped"
        )
        await expect(client.call("session/new")).rejects.toThrow(
          /stdin is closed/
        )
        expect(child.stdin.write).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it("rejects a prompt already in flight when stdin errors instead of waiting out the idle budget", async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      try {
        const client = new AcpJsonRpcClient({ command: "cursor-agent" })
        const child = attachFakeChild(client)
        client.on("child-error", () => {})
        const pending = client.call("session/prompt", {}, 600_000, {
          resetTimeoutOnActivity: true,
        })
        void pending.catch(() => {})

        child.stdin.emit("error", new Error("EPIPE"))

        await expect(pending).rejects.toThrow(
          /stdin errored while waiting on session\/prompt: EPIPE/
        )
      } finally {
        warn.mockRestore()
      }
    })

    it("builds exactly one stdin writer per child", () => {
      const client = new AcpJsonRpcClient({ command: "cursor-agent" })
      const child = attachFakeChild(client)
      const state = client as unknown as {
        stdin: unknown
        attachChild: (child: ChildProcessWithoutNullStreams) => void
      }
      const first = state.stdin
      state.attachChild(child as unknown as ChildProcessWithoutNullStreams)
      expect(state.stdin).toBe(first)
      expect(child.stdin.listenerCount("error")).toBe(1)
    })

    it("keeps retrying termination after the exit event dropped the child", async () => {
      // On Windows that exit can be our own SIGKILL of the cmd.exe shim,
      // which says nothing about the agent under it. The next close() used
      // to find no child and report success, releasing the quarantine.
      const cleanupFailure = new Error("ACP tree still alive")
      const terminateChildProcess = vi
        .fn()
        .mockRejectedValueOnce(cleanupFailure)
        .mockResolvedValueOnce(undefined)
      const client = new AcpJsonRpcClient({
        command: "cursor-agent",
        terminateChildProcess,
      })
      const child = attachFakeChild(client)
      const state = client as unknown as {
        child: ChildProcessWithoutNullStreams | null
      }

      await expect(client.close()).rejects.toBe(cleanupFailure)
      child.signalCode = "SIGKILL"
      child.emit("exit", null, "SIGKILL")
      expect(state.child).toBeNull()

      await expect(client.close()).resolves.toBeUndefined()
      expect(terminateChildProcess).toHaveBeenCalledTimes(2)
      expect(terminateChildProcess.mock.calls[1]?.[0]).toBe(child)
      // Confirmed: nothing left to retry.
      await expect(client.close()).resolves.toBeUndefined()
      expect(terminateChildProcess).toHaveBeenCalledTimes(2)
    })

    it("fails the turn when the reply to a permission request is refused by the stdin writer", async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      const error = vi.spyOn(logger, "error").mockImplementation(() => {})
      try {
        const client = new AcpJsonRpcClient({
          command: "cursor-agent",
          callTimeoutMs: 60_000,
        })
        const child = attachFakeChild(client)
        const state = client as unknown as {
          handleLine: (line: string) => void
        }
        const childErrors: unknown[] = []
        client.on("child-error", (failure) => childErrors.push(failure))
        const captured: { respond: ((result: unknown) => void) | null } = {
          respond: null,
        }
        client.setServerRequestHandler((_method, _params, reply) => {
          captured.respond = reply
        })
        // The prompt goes out; the reply to the permission request hits a
        // pipe that dies mid-write, so the writer refuses it.
        child.stdin.write
          .mockReturnValueOnce(true)
          .mockImplementationOnce(() => {
            throw new Error("EPIPE")
          })
        const prompt = client.call(
          "session/prompt",
          { sessionId: "s1", prompt: [] },
          10 * 60_000,
          { resetTimeoutOnActivity: true }
        )
        void prompt.catch(() => {})
        state.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "perm-1",
            method: "session/request_permission",
            params: {},
          })
        )
        expect(captured.respond).not.toBeNull()
        captured.respond?.({
          outcome: { outcome: "selected", optionId: "allow-once" },
        })

        // The turn fails now, with the reason, instead of sitting out the
        // 10-minute idle budget behind a misleading timeout.
        await expect(prompt).rejects.toBeInstanceOf(
          AcpServerResponseRefusedError
        )
        expect(childErrors).toEqual([
          expect.objectContaining({
            name: "AcpServerResponseRefusedError",
            method: "session/request_permission",
            requestId: "perm-1",
          }),
        ])
        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "session/request_permission",
            id: "perm-1",
          }),
          "acp rpc server-request response refused by the stdin writer; failing the turn"
        )
        expect(acpTurnFailureMessage(childErrors[0], "Cursor")).toBe(
          "Cursor did not receive the reply to its permission request because its input backlog is full; the turn was stopped."
        )
      } finally {
        warn.mockRestore()
        error.mockRestore()
      }
    })

    it("forgets the child on exit and turns late server responses into a log line", () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      try {
        const client = new AcpJsonRpcClient({ command: "cursor-agent" })
        const child = attachFakeChild(client)
        const state = client as unknown as {
          child: ChildProcessWithoutNullStreams | null
          handleLine: (line: string) => void
        }
        let lateRespond: ((result: unknown) => void) | null = null
        client.setServerRequestHandler((_method, _params, respond) => {
          lateRespond = respond
        })
        state.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "req-1",
            method: "session/request_permission",
            params: {},
          })
        )

        child.emit("exit", 0, null)
        expect(state.child).toBeNull()

        expect(() =>
          lateRespond?.({ outcome: { outcome: "cancelled" } })
        ).not.toThrow()
        expect(child.stdin.write).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "session/request_permission",
            id: "req-1",
          }),
          "acp rpc server-request response dropped; child already exited"
        )
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe("terminateAcpChildProcess on Windows", () => {
    function fakeChild(input: {
      pid?: number
      exited?: boolean
      killExits?: boolean
    }) {
      const child = Object.assign(new EventEmitter(), {
        pid: input.pid ?? 4_242,
        exitCode: input.exited ? 0 : (null as number | null),
        signalCode: null as string | null,
        kill: vi.fn(() => {
          if (input.killExits) {
            child.signalCode = "SIGKILL"
            child.emit("exit", null, "SIGKILL")
          }
          return true
        }),
      })
      return child
    }

    it("returns success without taskkill when the child has already exited", async () => {
      const runTaskkill = vi.fn(async () => {})
      const child = fakeChild({ exited: true })
      await expect(
        terminateAcpChildProcess(
          child as unknown as ChildProcessWithoutNullStreams,
          {
            platform: "win32",
            runTaskkill,
          }
        )
      ).resolves.toBeUndefined()
      expect(runTaskkill).not.toHaveBeenCalled()
    })

    it("still fails when taskkill fails even though SIGKILL confirms the root exit", async () => {
      // On Windows a non-.exe command is spawned through cmd.exe, so
      // `child.pid` is the shim. Killing the shim after a failed taskkill
      // orphans the real agent; reporting success here is what leaked
      // `cursor-agent` / `grok` processes behind every failed close.
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      try {
        const taskkillFailure = new Error("access denied")
        const runTaskkill = vi.fn(async () => {
          throw taskkillFailure
        })
        const child = fakeChild({ killExits: true })
        await expect(
          terminateAcpChildProcess(
            child as unknown as ChildProcessWithoutNullStreams,
            {
              platform: "win32",
              runTaskkill,
              listDescendants: async () => [],
              killGraceMs: 200,
            }
          )
        ).rejects.toMatchObject({
          code: "ACP_PROCESS_TREE_UNCONFIRMED",
          pid: 4_242,
          cause: taskkillFailure,
        })
        expect(runTaskkill).toHaveBeenCalledWith(4_242)
        // The shim is still signalled so the pipes close; that is best
        // effort, not confirmation.
        expect(child.kill).toHaveBeenCalledWith("SIGKILL")
      } finally {
        warn.mockRestore()
      }
    })

    it("returns success when taskkill succeeds and the root exit is confirmed", async () => {
      const runTaskkill = vi.fn(async () => {})
      const child = fakeChild({ killExits: false })
      const termination = terminateAcpChildProcess(
        child as unknown as ChildProcessWithoutNullStreams,
        { platform: "win32", runTaskkill, taskkillExitGraceMs: 500 }
      )
      // taskkill /T /F reaped the tree; the root's exit event arrives async.
      child.exitCode = 1
      child.emit("exit", 1, null)
      await expect(termination).resolves.toBeUndefined()
      expect(child.kill).not.toHaveBeenCalled()
    })

    it("still fails when neither taskkill nor SIGKILL produces an exit", async () => {
      const runTaskkill = vi.fn(async () => {})
      const child = fakeChild({ killExits: false })
      await expect(
        terminateAcpChildProcess(
          child as unknown as ChildProcessWithoutNullStreams,
          {
            platform: "win32",
            runTaskkill,
            listDescendants: async () => [],
            taskkillExitGraceMs: 20,
            killGraceMs: 20,
          }
        )
      ).rejects.toMatchObject({
        code: "ACP_PROCESS_TREE_UNCONFIRMED",
        pid: 4_242,
      })
    })

    it("never confirms a tree on retry just because we killed its shim", async () => {
      // First close: taskkill fails, the shim is SIGKILLed and exits. The
      // retry (the quarantine's next start/stop) used to see the root exited
      // and return success over a live agent process. With no descendant
      // snapshot to finish, nothing can ever confirm the tree.
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      try {
        const runTaskkill = vi.fn(async () => {
          throw new Error("access denied")
        })
        const listDescendants = vi.fn(async () => {
          throw new Error("powershell missing")
        })
        const child = fakeChild({ killExits: true })
        const deps = {
          platform: "win32" as const,
          runTaskkill,
          listDescendants,
          killGraceMs: 200,
        }
        const terminate = () =>
          terminateAcpChildProcess(
            child as unknown as ChildProcessWithoutNullStreams,
            deps
          )

        await expect(terminate()).rejects.toMatchObject({
          code: "ACP_PROCESS_TREE_UNCONFIRMED",
        })
        expect(child.signalCode).toBe("SIGKILL")
        expect(
          acpWindowsKillRecord(
            child as unknown as ChildProcessWithoutNullStreams
          )
        ).toEqual({ killAttempted: true, descendants: null })

        await expect(terminate()).rejects.toMatchObject({
          code: "ACP_PROCESS_TREE_UNCONFIRMED",
          message: expect.stringContaining(
            "before its process tree could be enumerated"
          ),
        })
        await expect(terminate()).rejects.toMatchObject({
          code: "ACP_PROCESS_TREE_UNCONFIRMED",
        })
        // A dead root PID is never taskkilled again (it may be reused), and
        // the snapshot is taken once, before the first kill.
        expect(runTaskkill).toHaveBeenCalledTimes(1)
        expect(listDescendants).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    })

    it("finishes the recorded descendants on retry and confirms only then", async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      try {
        const descendant = { pid: 5_151, createdAt: "2026-09-11T10:00:00.000Z" }
        const taskkillCalls: number[] = []
        let descendantKillable = false
        const runTaskkill = vi.fn(async (pid: number) => {
          taskkillCalls.push(pid)
          if (pid === 4_242) throw new Error("access denied")
          if (!descendantKillable) throw new Error("still busy")
        })
        const listDescendants = vi.fn(async () => [descendant])
        const probeDescendant = vi.fn(async () => true)
        const child = fakeChild({ killExits: true })
        const deps = {
          platform: "win32" as const,
          runTaskkill,
          listDescendants,
          probeDescendant,
          killGraceMs: 200,
        }
        const terminate = () =>
          terminateAcpChildProcess(
            child as unknown as ChildProcessWithoutNullStreams,
            deps
          )

        await expect(terminate()).rejects.toMatchObject({
          code: "ACP_PROCESS_TREE_UNCONFIRMED",
        })
        expect(listDescendants).toHaveBeenCalledWith(4_242)
        expect(
          acpWindowsKillRecord(
            child as unknown as ChildProcessWithoutNullStreams
          )
        ).toEqual({ killAttempted: true, descendants: [descendant] })

        // Retry: the descendant is still the process we recorded and its
        // taskkill fails, so the tree stays unconfirmed.
        await expect(terminate()).rejects.toMatchObject({
          code: "ACP_PROCESS_TREE_UNCONFIRMED",
          message: expect.stringContaining("1 recorded descendant"),
        })
        expect(probeDescendant).toHaveBeenCalledWith(descendant)
        expect(taskkillCalls).toEqual([4_242, 5_151])

        descendantKillable = true
        await expect(terminate()).resolves.toBeUndefined()
        expect(taskkillCalls).toEqual([4_242, 5_151, 5_151])
        expect(
          acpWindowsKillRecord(
            child as unknown as ChildProcessWithoutNullStreams
          )
        ).toBeNull()
      } finally {
        warn.mockRestore()
      }
    })

    it("treats a recorded descendant whose PID now belongs to another process as gone", async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
      try {
        const runTaskkill = vi.fn(async (pid: number) => {
          if (pid === 4_242) throw new Error("access denied")
        })
        const probeDescendant = vi.fn(async () => false)
        const child = fakeChild({ killExits: true })
        const deps = {
          platform: "win32" as const,
          runTaskkill,
          listDescendants: async () => [{ pid: 5_252, createdAt: "t0" }],
          probeDescendant,
          killGraceMs: 200,
        }
        const terminate = () =>
          terminateAcpChildProcess(
            child as unknown as ChildProcessWithoutNullStreams,
            deps
          )
        await expect(terminate()).rejects.toMatchObject({
          code: "ACP_PROCESS_TREE_UNCONFIRMED",
        })
        // PID reuse: the recorded process is gone, so it is not taskkilled.
        await expect(terminate()).resolves.toBeUndefined()
        expect(probeDescendant).toHaveBeenCalledWith({
          pid: 5_252,
          createdAt: "t0",
        })
        expect(runTaskkill).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    })
  })
})

const mockAcpPeerScript = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let pendingPromptId = null;
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === "session/prompt") {
    pendingPromptId = message.id;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" }
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: "server-request-1",
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: { toolCallId: "tool-1", kind: "execute" },
        options: [{ optionId: "allow-once", kind: "allow_once" }]
      }
    });
    return;
  }
  if (message.id === "server-request-1" && pendingPromptId !== null) {
    send({
      jsonrpc: "2.0",
      id: pendingPromptId,
      result: { stopReason: "end_turn" }
    });
  }
});
`
