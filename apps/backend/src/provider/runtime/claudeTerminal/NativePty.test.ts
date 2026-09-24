import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  ensureNativePtyPosixProcessGroupTerminated,
  prepareNativePtyCommand,
  probeNativePtySupport,
  runNativePtyWindowsTaskkill,
  windowsTreeEndedMeanwhile,
  windowsTreeTermination,
} from "./NativePty"

describe("native PTY command preparation", () => {
  it("loads node-pty through the asynchronous probe", async () => {
    await expect(probeNativePtySupport()).resolves.toEqual({
      available: true,
    })
  })

  it("resolves PATH and shebangs without synchronous filesystem calls", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-pty-command-")
    )
    const executable = path.join(root, "claude-async-test")
    fs.writeFileSync(
      executable,
      "#!/usr/bin/env node --no-warnings\nprocess.exit(0)\n",
      "utf8"
    )
    fs.chmodSync(executable, 0o755)

    const platform = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("linux")
    const accessSync = vi.spyOn(fs, "accessSync")
    const openSync = vi.spyOn(fs, "openSync")
    const readSync = vi.spyOn(fs, "readSync")
    const closeSync = vi.spyOn(fs, "closeSync")
    const readdirSync = vi.spyOn(fs, "readdirSync")
    const statSync = vi.spyOn(fs, "statSync")
    const chmodSync = vi.spyOn(fs, "chmodSync")

    try {
      await expect(
        prepareNativePtyCommand("claude-async-test", ["--version"], {
          PATH: root,
        })
      ).resolves.toEqual({
        command: "/usr/bin/env",
        args: ["node", "--no-warnings", executable, "--version"],
      })
      expect(accessSync).not.toHaveBeenCalled()
      expect(openSync).not.toHaveBeenCalled()
      expect(readSync).not.toHaveBeenCalled()
      expect(closeSync).not.toHaveBeenCalled()
      expect(readdirSync).not.toHaveBeenCalled()
      expect(statSync).not.toHaveBeenCalled()
      expect(chmodSync).not.toHaveBeenCalled()
    } finally {
      platform.mockRestore()
      accessSync.mockRestore()
      openSync.mockRestore()
      readSync.mockRestore()
      closeSync.mockRestore()
      readdirSync.mockRestore()
      statSync.mockRestore()
      chmodSync.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("native PTY process-tree termination", () => {
  it("awaits Windows taskkill /T through the helper close event", async () => {
    const killer = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    })
    const spawnProcess = vi.fn(() => killer as never)
    let settled = false

    const termination = runNativePtyWindowsTaskkill(5151, true, {
      spawnProcess,
      timeoutMs: 1_000,
    })
    void termination.then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(spawnProcess).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/pid", "5151", "/T", "/F"],
      expect.objectContaining({ stdio: "ignore", windowsHide: true })
    )

    killer.emit("close", 0, null)
    await expect(termination).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })

  it("rejects when the Windows taskkill helper reports failure", async () => {
    const killer = Object.assign(new EventEmitter(), {
      kill: vi.fn(() => true),
    })
    const termination = runNativePtyWindowsTaskkill(5252, false, {
      spawnProcess: () => killer as never,
      timeoutMs: 1_000,
    })

    killer.emit("close", 1, null)
    await expect(termination).rejects.toMatchObject({
      code: "NATIVE_PTY_TASKKILL_FAILED",
      pid: 5252,
      exitCode: 1,
    })
  })

  it("terminates descendants that remain after the PTY root exits", async () => {
    vi.useFakeTimers()
    let alive = true
    const kill = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number
    ) => {
      expect(pid).toBe(-5353)
      if (signal === 0) {
        if (alive) return true
        throw Object.assign(new Error("gone"), { code: "ESRCH" })
      }
      if (signal === "SIGKILL") alive = false
      return true
    }) as typeof process.kill)
    try {
      const termination = ensureNativePtyPosixProcessGroupTerminated(5353)
      await vi.advanceTimersByTimeAsync(300)
      await expect(termination).resolves.toBeUndefined()
      expect(kill).toHaveBeenCalledWith(-5353, "SIGTERM")
      expect(kill).toHaveBeenCalledWith(-5353, "SIGKILL")
    } finally {
      kill.mockRestore()
      vi.useRealTimers()
    }
  })

  it("reports a PTY process group that survives SIGKILL", async () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, "kill").mockImplementation(((
      pid: number
    ) => {
      expect(pid).toBe(-5454)
      return true
    }) as typeof process.kill)
    try {
      const termination = ensureNativePtyPosixProcessGroupTerminated(5454)
      const expectation = expect(termination).rejects.toMatchObject({
        code: "NATIVE_PTY_GROUP_SURVIVED_ROOT_EXIT",
        pid: 5454,
      })
      await vi.advanceTimersByTimeAsync(800)
      await expectation
    } finally {
      kill.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe("overlapping terminations of a Windows PTY tree", () => {
  it("taskkill the tree until a request reached it, then only escalate while its root runs", () => {
    const next = (
      signal: NodeJS.Signals,
      rootExited: boolean,
      treeReached: boolean
    ) => windowsTreeTermination({ signal, rootExited, treeReached })

    // Nothing reached the tree yet: taskkill it while the root runs.
    expect(next("SIGTERM", false, false)).toBe("run")
    expect(next("SIGKILL", false, false)).toBe("run")
    // The root exited first: its descendants cannot be checked.
    expect(next("SIGTERM", true, false)).toBe("unaddressable")
    expect(next("SIGKILL", true, false)).toBe("unaddressable")
    // Reached: a graceful request again adds nothing; the escalation runs
    // while the root does; after the root exited nothing is addressed
    // (its PID may belong to another process by then).
    expect(next("SIGTERM", false, true)).toBe("skip")
    expect(next("SIGKILL", false, true)).toBe("run")
    expect(next("SIGTERM", true, true)).toBe("skip")
    expect(next("SIGKILL", true, true)).toBe("skip")
  })

  it("take a tree taskkill no longer finds as ended only after a request reached it", () => {
    const notFound = Object.assign(new Error("not found"), {
      code: "NATIVE_PTY_TASKKILL_FAILED",
      exitCode: 128,
    })
    const refused = Object.assign(new Error("access denied"), {
      code: "NATIVE_PTY_TASKKILL_FAILED",
      exitCode: 1,
    })
    const timedOut = Object.assign(new Error("timed out"), {
      code: "NATIVE_PTY_TASKKILL_TIMEOUT",
    })
    expect(windowsTreeEndedMeanwhile(notFound, true)).toBe(true)
    expect(windowsTreeEndedMeanwhile(notFound, false)).toBe(false)
    expect(windowsTreeEndedMeanwhile(refused, true)).toBe(false)
    expect(windowsTreeEndedMeanwhile(timedOut, true)).toBe(false)
    expect(windowsTreeEndedMeanwhile(null, true)).toBe(false)
  })
})
