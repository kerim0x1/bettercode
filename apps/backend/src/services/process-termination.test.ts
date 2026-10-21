import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  isNoSuchProcessError,
  runWindowsTaskkill,
  runWindowsTaskkillDetailed,
  taskkillChildProcessTree,
} from "./process-termination"

function fakeKiller() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("runWindowsTaskkill", () => {
  it("waits for the helper close event before settling", async () => {
    const killer = fakeKiller()
    const spawnProcess = vi.fn(() => killer as never)
    let settled = false

    const termination = runWindowsTaskkill(4242, true, {
      spawnProcess,
      timeoutMs: 1_000,
    })
    void termination.then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-z]:\\.*\\System32\\taskkill\.exe$/i),
      ["/pid", "4242", "/T", "/F"],
      expect.objectContaining({
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      })
    )

    killer.emit("close", 0, null)
    await expect(termination).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })

  it("omits /F for a graceful request", async () => {
    const killer = fakeKiller()
    const spawnProcess = vi.fn(() => killer as never)
    const termination = runWindowsTaskkill(7, false, { spawnProcess })
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-z]:\\.*\\System32\\taskkill\.exe$/i),
      ["/pid", "7", "/T"],
      expect.anything()
    )
    killer.emit("close", 0, null)
    await expect(termination).resolves.toBeUndefined()
  })

  it("propagates a helper failure only after helper close", async () => {
    const killer = fakeKiller()
    const failure = new Error("taskkill unavailable")
    const termination = runWindowsTaskkill(4343, false, {
      spawnProcess: () => killer as never,
      timeoutMs: 1_000,
    })
    let rejected = false
    void termination.catch(() => {
      rejected = true
    })

    killer.emit("error", failure)
    await Promise.resolve()
    expect(rejected).toBe(false)

    killer.emit("close", null, null)
    await expect(termination).rejects.toMatchObject({
      message: "taskkill unavailable",
      code: "TASKKILL_SPAWN_FAILED",
    })
    expect(rejected).toBe(true)
  })

  it("reports a non-zero helper exit as TASKKILL_FAILED", async () => {
    const killer = fakeKiller()
    const termination = runWindowsTaskkill(9, true, {
      spawnProcess: () => killer as never,
    })
    killer.emit("close", 128, null)
    await expect(termination).rejects.toMatchObject({
      code: "TASKKILL_FAILED",
      exitCode: 128,
    })
  })

  it("kills a hung helper before the deadline and still awaits its close", async () => {
    vi.useFakeTimers()
    const killer = fakeKiller()
    const termination = runWindowsTaskkillDetailed(11, true, {
      spawnProcess: () => killer as never,
      timeoutMs: 1_000,
    })
    let result: unknown = null
    void termination.then((value) => {
      result = value
    })

    // The kill is sent early enough to leave room for the helper to close.
    await vi.advanceTimersByTimeAsync(700)
    expect(killer.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(killer.kill).toHaveBeenCalledWith("SIGKILL")
    expect(result).toBeNull()

    killer.emit("close", null, "SIGKILL")
    await expect(termination).resolves.toEqual({ status: "timeout" })
  })

  it("gives up on a helper that never closes after being killed", async () => {
    vi.useFakeTimers()
    const killer = fakeKiller()
    const termination = runWindowsTaskkillDetailed(12, false, {
      spawnProcess: () => killer as never,
      timeoutMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(1_100)
    await expect(termination).resolves.toEqual({ status: "timeout" })
  })

  it("reports a spawn throw without waiting", async () => {
    await expect(
      runWindowsTaskkillDetailed(13, true, {
        spawnProcess: () => {
          throw new Error("spawn EPERM")
        },
      })
    ).resolves.toEqual({ status: "error", message: "spawn EPERM" })
  })
})

describe("taskkillChildProcessTree", () => {
  it("force-kills the tree of a root that is still running", async () => {
    const killer = fakeKiller()
    const spawnProcess = vi.fn(() => killer as never)
    const termination = taskkillChildProcessTree(
      { pid: 5150, exitCode: null, signalCode: null },
      { spawnProcess, timeoutMs: 1_000 }
    )
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.stringMatching(/\\System32\\taskkill\.exe$/i),
      ["/pid", "5150", "/T", "/F"],
      expect.anything()
    )
    killer.emit("close", 0, null)
    await expect(termination).resolves.toBeUndefined()
  })

  it("never targets the PID of a root that already exited", async () => {
    const spawnProcess = vi.fn()
    for (const child of [
      { pid: 5151, exitCode: 0, signalCode: null },
      { pid: 5152, exitCode: null, signalCode: "SIGTERM" as const },
      { pid: undefined, exitCode: null, signalCode: null },
    ]) {
      await expect(
        taskkillChildProcessTree(child, { spawnProcess: spawnProcess as never })
      ).rejects.toMatchObject({ code: "TASKKILL_ROOT_EXITED" })
    }
    expect(spawnProcess).not.toHaveBeenCalled()
  })
})

describe("isNoSuchProcessError", () => {
  it("recognizes ESRCH and nothing else", () => {
    expect(
      isNoSuchProcessError(Object.assign(new Error("gone"), { code: "ESRCH" }))
    ).toBe(true)
    expect(
      isNoSuchProcessError(
        Object.assign(new Error("denied"), { code: "EPERM" })
      )
    ).toBe(false)
    expect(isNoSuchProcessError(null)).toBe(false)
    expect(isNoSuchProcessError(undefined)).toBe(false)
  })
})
