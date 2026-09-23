import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  listWindowsChildProcesses,
  parseWindowsProcessRows,
  runProviderWindowsTaskkill,
  terminateProviderChildProcessTree,
  windowsProcessStillMatches,
} from "./ChildProcessTermination"

interface FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(pid: number): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("provider child process-tree termination", () => {
  it("waits for both successful Windows taskkill and the root exit", async () => {
    const child = fakeChild(6_101)
    const killer = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    })
    const spawnTaskkill = vi.fn(() => killer as never)
    let settled = false

    const termination = terminateProviderChildProcessTree(
      child as unknown as ChildProcess,
      {
        platform: "win32",
        spawnTaskkill,
        taskkillTimeoutMs: 1_000,
        killGraceMs: 1_000,
      }
    )
    void termination.then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(spawnTaskkill).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/pid", "6101", "/T", "/F"],
      expect.objectContaining({
        stdio: "ignore",
        windowsHide: true,
      })
    )
    expect(settled).toBe(false)

    killer.emit("close", 0, null)
    await Promise.resolve()
    expect(settled).toBe(false)

    child.exitCode = 0
    child.emit("exit", 0, null)
    await expect(termination).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })

  it("rejects a Windows taskkill failure without pretending the tree exited", async () => {
    const child = fakeChild(6_202)
    const killer = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    })
    const termination = terminateProviderChildProcessTree(
      child as unknown as ChildProcess,
      {
        platform: "win32",
        spawnTaskkill: () => killer as never,
        taskkillTimeoutMs: 1_000,
      }
    )

    killer.emit("close", 1, null)
    await expect(termination).rejects.toMatchObject({
      code: "PROVIDER_TASKKILL_FAILED",
      pid: 6_202,
      exitCode: 1,
    })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it("kills a timed-out taskkill helper but still waits for its close event", async () => {
    vi.useFakeTimers()
    const killer = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    })
    let settled = false
    const termination = runProviderWindowsTaskkill(6_303, {
      spawnTaskkill: () => killer as never,
      timeoutMs: 20,
      closeGraceMs: 1_000,
    })
    const expectation = expect(termination).rejects.toMatchObject({
      code: "PROVIDER_TASKKILL_TIMEOUT",
      pid: 6_303,
    })
    void termination.catch(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(20)
    expect(killer.kill).toHaveBeenCalledWith("SIGKILL")
    expect(settled).toBe(false)

    killer.emit("close", null, "SIGKILL")
    await expectation
    expect(settled).toBe(true)
  })

  it("escalates a live POSIX process group from SIGTERM to SIGKILL", async () => {
    vi.useFakeTimers()
    const child = fakeChild(6_404)
    let alive = true
    const killProcess = vi.fn(
      (pid: number, signal?: NodeJS.Signals | number) => {
        expect(pid).toBe(-6_404)
        if (signal === 0) {
          if (alive) return true
          throw Object.assign(new Error("gone"), { code: "ESRCH" })
        }
        if (signal === "SIGKILL") alive = false
        return true
      }
    ) as unknown as typeof process.kill

    const termination = terminateProviderChildProcessTree(
      child as unknown as ChildProcess,
      {
        platform: "linux",
        termGraceMs: 25,
        killGraceMs: 25,
        killProcess,
      }
    )
    await vi.advanceTimersByTimeAsync(30)
    await expect(termination).resolves.toBeUndefined()
    expect(killProcess).toHaveBeenCalledWith(-6_404, "SIGTERM")
    expect(killProcess).toHaveBeenCalledWith(-6_404, "SIGKILL")
  })

  it("reports a POSIX process group that survives SIGKILL", async () => {
    vi.useFakeTimers()
    const child = fakeChild(6_505)
    const killProcess = vi.fn(() => true) as unknown as typeof process.kill
    const termination = terminateProviderChildProcessTree(
      child as unknown as ChildProcess,
      {
        platform: "linux",
        termGraceMs: 25,
        killGraceMs: 25,
        killProcess,
      }
    )
    const expectation = expect(termination).rejects.toMatchObject({
      code: "PROVIDER_PROCESS_GROUP_SURVIVED_SIGKILL",
      pid: 6_505,
    })

    await vi.advanceTimersByTimeAsync(60)
    await expectation
    expect(killProcess).toHaveBeenCalledWith(-6_505, "SIGKILL")
  })
})

describe("Windows process queries", () => {
  function fakeHelper() {
    return Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      kill: vi.fn(() => true),
    })
  }

  it("parses helper rows and pins them by creation time", () => {
    expect(
      parseWindowsProcessRows(
        '[{"pid":5151,"created":"2026-09-11T10:00:00.0000000Z"},{"pid":"6161","created":null},{"pid":0}]'
      )
    ).toEqual([
      { pid: 5_151, createdAt: "2026-09-11T10:00:00.0000000Z" },
      { pid: 6_161, createdAt: null },
    ])
    // A host that unrolls a one-element array still parses.
    expect(parseWindowsProcessRows('{"pid":7171,"created":"t"}')).toEqual([
      { pid: 7_171, createdAt: "t" },
    ])
    expect(parseWindowsProcessRows("")).toEqual([])
    expect(parseWindowsProcessRows("null")).toEqual([])
    expect(() => parseWindowsProcessRows("not json")).toThrow(
      expect.objectContaining({ code: "PROVIDER_PROCESS_QUERY_UNPARSABLE" })
    )
  })

  it("lists the direct children of a root from the helper's JSON output", async () => {
    const helper = fakeHelper()
    const spawnPowerShell = vi.fn(() => helper as never)
    const listing = listWindowsChildProcesses(4_242, { spawnPowerShell })

    expect(spawnPowerShell).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive"]),
      expect.objectContaining({
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      })
    )
    const script = (
      spawnPowerShell.mock.calls[0] as unknown as [string, string[]]
    )[1].at(-1)
    expect(script).toContain("ParentProcessId=4242")
    helper.stdout.write('[{"pid":5151,"created":"t1"}]')
    helper.emit("close", 0, null)
    await expect(listing).resolves.toEqual([{ pid: 5_151, createdAt: "t1" }])
  })

  it("rejects when the helper fails, so an unknown tree stays unconfirmed", async () => {
    const helper = fakeHelper()
    const listing = listWindowsChildProcesses(4_242, {
      spawnPowerShell: () => helper as never,
    })
    helper.emit("close", 1, null)
    await expect(listing).rejects.toMatchObject({
      code: "PROVIDER_PROCESS_QUERY_FAILED",
      exitCode: 1,
    })
  })

  it("kills a helper that hangs and reports the timeout", async () => {
    vi.useFakeTimers()
    const helper = fakeHelper()
    const listing = listWindowsChildProcesses(4_242, {
      spawnPowerShell: () => helper as never,
      timeoutMs: 50,
    })
    const expectation = expect(listing).rejects.toMatchObject({
      code: "PROVIDER_PROCESS_QUERY_TIMEOUT",
    })
    await vi.advanceTimersByTimeAsync(50)
    expect(helper.kill).toHaveBeenCalledWith("SIGKILL")
    await expectation
  })

  it.each(["", "[]"])(
    "rejects overflow instead of treating retained %j as a complete snapshot",
    async (prefix) => {
      const helper = fakeHelper()
      const listing = listWindowsChildProcesses(4_242, {
        spawnPowerShell: () => helper as never,
      })
      if (prefix) helper.stdout.write(prefix)
      helper.stdout.write("x".repeat(256 * 1024 + 1))
      helper.emit("close", 0, null)
      await expect(listing).rejects.toMatchObject({
        code: "PROVIDER_PROCESS_QUERY_OUTPUT_LIMIT",
      })
      expect(helper.kill).toHaveBeenCalledWith("SIGKILL")
    }
  )

  it.each([
    [null, "current"],
    ["original", null],
    [null, null],
  ])(
    "refuses to identify a live process without both creation times (%s/%s)",
    async (original, current) => {
      const helper = fakeHelper()
      const result = windowsProcessStillMatches(
        { pid: 5_151, createdAt: original },
        { spawnPowerShell: () => helper as never }
      )
      helper.stdout.write(JSON.stringify([{ pid: 5151, created: current }]))
      helper.emit("close", 0, null)
      await expect(result).rejects.toMatchObject({
        code: "PROVIDER_PROCESS_IDENTITY_UNCONFIRMED",
      })
    }
  )

  it("does not match a PID that a newer process now owns", async () => {
    const probe = (output: string) => {
      const helper = fakeHelper()
      const result = windowsProcessStillMatches(
        { pid: 5_151, createdAt: "t-original" },
        { spawnPowerShell: () => helper as never }
      )
      helper.stdout.write(output)
      helper.emit("close", 0, null)
      return result
    }
    await expect(probe('[{"pid":5151,"created":"t-original"}]')).resolves.toBe(
      true
    )
    await expect(probe('[{"pid":5151,"created":"t-reused"}]')).resolves.toBe(
      false
    )
    await expect(probe("[]")).resolves.toBe(false)
  })
})
