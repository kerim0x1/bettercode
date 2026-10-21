import { afterEach, describe, expect, it, vi } from "vitest"

const spawnedHandles = vi.hoisted(
  () =>
    [] as Array<{
      kill: ReturnType<typeof vi.fn>
      resolveExit: () => void
    }>
)

vi.mock("../provider/runtime/claudeTerminal/NativePty", () => ({
  spawnNativePty: vi.fn(() => {
    let resolveExit!: (exit: { exitCode: number; signal: null }) => void
    const exitPromise = new Promise<{ exitCode: number; signal: null }>(
      (resolve) => {
        resolveExit = resolve
      }
    )
    const handle = {
      pid: 10_000 + spawnedHandles.length,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      waitForExit: vi.fn(() => exitPromise),
      resolveExit: () => resolveExit({ exitCode: 0, signal: null }),
    }
    spawnedHandles.push(handle)
    return handle
  }),
}))

import {
  TERMINAL_PTY_KILLED_EXIT_REPORT_MS,
  TERMINAL_PTY_MAX_ACTIVE_SESSIONS,
  TERMINAL_PTY_MAX_ACTIVE_SESSIONS_FOR_DESKTOP,
  TERMINAL_PTY_MAX_ACTIVE_SESSIONS_PER_OWNER,
  TerminalPtyService,
} from "./terminalPty"

/** The service under test; one per file, as the module state used to be. */
const ptys = new TerminalPtyService()

const openedSessionIds: string[] = []

afterEach(async () => {
  for (const sessionId of openedSessionIds.splice(0)) {
    ptys.closeSession(sessionId)
  }
  for (const handle of spawnedHandles) handle.resolveExit()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await ptys.shutdownAll(0)
  spawnedHandles.splice(0)
})

describe("terminal PTY capacity", () => {
  it("coalesces repeated close requests while native termination is pending", async () => {
    vi.useFakeTimers()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const opened = ptys.openSession({
      sessionId: "coalesced-close",
      cwd: process.cwd(),
      command: process.execPath,
    })
    openedSessionIds.push(opened.sessionId)
    const handle = spawnedHandles.at(-1)!
    handle.kill.mockReturnValue(pending)
    try {
      ptys.closeSession(opened.sessionId)
      await vi.advanceTimersByTimeAsync(2_000)
      for (let retry = 0; retry < 3; retry += 1) {
        ptys.closeSession(opened.sessionId)
        await vi.advanceTimersByTimeAsync(2_000)
      }
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(handle.kill.mock.calls.map(([signal]) => signal)).toEqual([
        "SIGTERM",
        "SIGKILL",
      ])
    } finally {
      release()
      handle.resolveExit()
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it("notifies a lifecycle owner exactly once after the native process exits", async () => {
    const onProcessExit = vi.fn()
    const opened = ptys.openSession({
      sessionId: "exit-owner",
      cwd: process.cwd(),
      command: process.execPath,
      onProcessExit,
    })
    openedSessionIds.push(opened.sessionId)
    const handle = spawnedHandles.at(-1)!

    expect(ptys.closeSession(opened.sessionId)).toBe(true)
    expect(onProcessExit).not.toHaveBeenCalled()
    handle.resolveExit()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(onProcessExit).toHaveBeenCalledTimes(1)
  })

  it("retains capacity until a closed PTY has actually exited", async () => {
    for (let index = 0; index < TERMINAL_PTY_MAX_ACTIVE_SESSIONS; index += 1) {
      const opened = ptys.openSession({
        sessionId: `capacity-${index}`,
        cwd: process.cwd(),
        command: process.execPath,
      })
      openedSessionIds.push(opened.sessionId)
    }

    expect(() =>
      ptys.openSession({
        sessionId: "capacity-overflow",
        cwd: process.cwd(),
        command: process.execPath,
      })
    ).toThrow(/too many active terminal sessions/i)
    expect(spawnedHandles).toHaveLength(TERMINAL_PTY_MAX_ACTIVE_SESSIONS)

    expect(ptys.closeSession(openedSessionIds.shift()!)).toBe(true)
    expect(() =>
      ptys.openSession({
        sessionId: "capacity-still-closing",
        cwd: process.cwd(),
        command: process.execPath,
      })
    ).toThrow(/too many active terminal sessions/i)

    spawnedHandles[0]!.resolveExit()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const replacement = ptys.openSession({
      sessionId: "capacity-replacement",
      cwd: process.cwd(),
      command: process.execPath,
    })
    openedSessionIds.push(replacement.sessionId)
    expect(spawnedHandles).toHaveLength(TERMINAL_PTY_MAX_ACTIVE_SESSIONS + 1)
  })

  it("shuts down only PTYs owned by a revoked principal", async () => {
    const ownerA = ptys.openSession({
      sessionId: "remote-owner-a",
      ownerId: "remote:owner-a",
      cwd: process.cwd(),
      command: process.execPath,
    })
    const ownerB = ptys.openSession({
      sessionId: "remote-owner-b",
      ownerId: "remote:owner-b",
      cwd: process.cwd(),
      command: process.execPath,
    })
    openedSessionIds.push(ownerA.sessionId, ownerB.sessionId)

    const cleanup = ptys.shutdownForOwner("remote:owner-a", 1_000)
    expect(spawnedHandles[0]!.kill).toHaveBeenCalledWith("SIGTERM")
    expect(spawnedHandles[1]!.kill).not.toHaveBeenCalled()
    spawnedHandles[0]!.resolveExit()

    await expect(cleanup).resolves.toBe(1)
    expect(ptys.readSession(ownerA.sessionId)).toBeNull()
    expect(ptys.readSession(ownerB.sessionId)).not.toBeNull()
  })

  it("terminates a remote-owned PTY at its absolute session expiry", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"))
      const opened = ptys.openSession({
        sessionId: "remote-owner-expiry",
        ownerId: "remote:owner-expiry",
        ownerExpiresAt: Date.now() + 1_000,
        cwd: process.cwd(),
        command: process.execPath,
      })
      openedSessionIds.push(opened.sessionId)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(spawnedHandles.at(-1)!.kill).toHaveBeenCalledWith("SIGTERM")
      spawnedHandles.at(-1)!.resolveExit()
      await vi.runAllTimersAsync()
    } finally {
      vi.useRealTimers()
    }
  })

  it("escalates a closed running session using the retained handle", async () => {
    vi.useFakeTimers()
    try {
      const opened = ptys.openSession({
        sessionId: "close-escalation",
        cwd: process.cwd(),
        command: process.execPath,
      })
      const handle = spawnedHandles.at(-1)!

      expect(ptys.closeSession(opened.sessionId)).toBe(true)
      expect(handle.kill).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(handle.kill).toHaveBeenCalledTimes(2)
      handle.resolveExit()
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it("isolates session ownership and caps each authenticated caller", () => {
    const ownerASessions = Array.from(
      { length: TERMINAL_PTY_MAX_ACTIVE_SESSIONS_PER_OWNER },
      (_, index) =>
        ptys.openSession({
          sessionId: `pty-owner-a-${index}`,
          ownerId: "owner-a",
          cwd: process.cwd(),
          command: process.execPath,
        })
    )
    openedSessionIds.push(...ownerASessions.map((session) => session.sessionId))

    expect(() =>
      ptys.openSession({
        sessionId: "pty-owner-a-overflow",
        ownerId: "owner-a",
        cwd: process.cwd(),
        command: process.execPath,
      })
    ).toThrow(/too many active terminal sessions for this caller/i)

    const ownerB = ptys.openSession({
      sessionId: "pty-owner-b",
      ownerId: "owner-b",
      cwd: process.cwd(),
      command: process.execPath,
    })
    openedSessionIds.push(ownerB.sessionId)
    expect(ptys.activeSessionCount()).toBe(
      TERMINAL_PTY_MAX_ACTIVE_SESSIONS_PER_OWNER + 1
    )
    expect(
      ptys.readSession(ownerASessions[0]!.sessionId, 0, "owner-b")
    ).toBeNull()
    expect(
      ptys.writeSession(ownerASessions[0]!.sessionId, "whoami\n", "owner-b")
    ).toBe(false)
    expect(ptys.closeSession(ownerASessions[0]!.sessionId, "owner-b")).toBe(
      false
    )
    expect(ptys.closeSession(ownerASessions[0]!.sessionId, "owner-a")).toBe(
      true
    )
  })

  it("lets the desktop app run more terminals than a paired device", () => {
    expect(TERMINAL_PTY_MAX_ACTIVE_SESSIONS_FOR_DESKTOP).toBeGreaterThan(
      TERMINAL_PTY_MAX_ACTIVE_SESSIONS_PER_OWNER
    )
    const desktopSessions = Array.from(
      { length: TERMINAL_PTY_MAX_ACTIVE_SESSIONS_FOR_DESKTOP },
      (_, index) =>
        ptys.openSession({
          sessionId: `pty-desktop-${index}`,
          ownerId: "local-owner",
          ownerIsDesktop: true,
          cwd: process.cwd(),
          command: process.execPath,
        })
    )
    openedSessionIds.push(
      ...desktopSessions.map((session) => session.sessionId)
    )

    expect(() =>
      ptys.openSession({
        sessionId: "pty-desktop-overflow",
        ownerId: "local-owner",
        ownerIsDesktop: true,
        cwd: process.cwd(),
        command: process.execPath,
      })
    ).toThrow(`(${TERMINAL_PTY_MAX_ACTIVE_SESSIONS_FOR_DESKTOP} maximum)`)

    // A paired device keeps its own, smaller allowance next to the desktop's.
    const device = ptys.openSession({
      sessionId: "pty-paired-device",
      ownerId: "remote:device",
      cwd: process.cwd(),
      command: process.execPath,
    })
    openedSessionIds.push(device.sessionId)
    expect(ptys.activeSessionCount("remote:device")).toBe(1)
  })

  it("closes every retained terminal session during shutdown", () => {
    for (let index = 0; index < 3; index += 1) {
      ptys.openSession({
        sessionId: `shutdown-${index}`,
        cwd: process.cwd(),
        command: process.execPath,
      })
    }

    expect(ptys.closeAllSessions()).toBe(3)
    for (const handle of spawnedHandles) {
      expect(handle.kill).toHaveBeenCalled()
    }
  })

  it("bounds shutdown and escalates PTYs that do not exit", async () => {
    vi.useFakeTimers()
    try {
      for (let index = 0; index < 2; index += 1) {
        ptys.openSession({
          sessionId: `bounded-shutdown-${index}`,
          cwd: process.cwd(),
          command: process.execPath,
        })
      }

      const shutdown = ptys.shutdownAll(100)
      const shutdownExpectation = expect(shutdown).rejects.toThrow(
        /terminal session\(s\) did not exit during shutdown/i
      )
      for (const handle of spawnedHandles) {
        expect(handle.kill).toHaveBeenCalledTimes(1)
      }

      await vi.advanceTimersByTimeAsync(100)
      for (const handle of spawnedHandles) {
        expect(handle.kill).toHaveBeenCalledTimes(2)
      }

      await vi.advanceTimersByTimeAsync(TERMINAL_PTY_KILLED_EXIT_REPORT_MS)
      await shutdownExpectation
      for (const handle of spawnedHandles) handle.resolveExit()
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it("propagates native process-tree termination failures", async () => {
    vi.useFakeTimers()
    try {
      ptys.openSession({
        sessionId: "failed-tree-shutdown",
        cwd: process.cwd(),
        command: process.execPath,
      })
      const handle = spawnedHandles.at(-1)!
      handle.kill.mockRejectedValue(new Error("taskkill failed"))

      const shutdown = ptys.shutdownAll(0)
      const shutdownResult = shutdown.catch((error) => error)

      await vi.advanceTimersByTimeAsync(TERMINAL_PTY_KILLED_EXIT_REPORT_MS)
      const error = await shutdownResult
      expect(error).toMatchObject({
        code: "TERMINAL_PTY_SHUTDOWN_INCOMPLETE",
        sessionIds: ["failed-tree-shutdown"],
      })
      expect(error.causes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "taskkill failed" }),
        ])
      )
      handle.resolveExit()
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps each service's terminals to itself", async () => {
    const other = new TerminalPtyService()
    const ownBefore = ptys.activeSessionCount()
    const opened = other.openSession({
      cwd: process.cwd(),
      command: process.execPath,
    })
    try {
      expect(other.activeSessionCount()).toBe(1)
      expect(ptys.activeSessionCount()).toBe(ownBefore)
      expect(ptys.readSession(opened.sessionId)).toBeNull()
      expect(ptys.closeSession(opened.sessionId)).toBe(false)
      expect(other.readSession(opened.sessionId)?.status).toBe("running")
    } finally {
      for (const handle of spawnedHandles) handle.resolveExit()
      await new Promise<void>((resolve) => setImmediate(resolve))
      await other.shutdownAll(0)
    }
  })

  it("refuses new terminals after its own shutdown began, until reopened", () => {
    const other = new TerminalPtyService()
    other.beginShutdown()
    expect(() =>
      other.openSession({ cwd: process.cwd(), command: process.execPath })
    ).toThrow("Terminal service is shutting down.")
    // Another instance keeps admitting.
    const opened = ptys.openSession({
      cwd: process.cwd(),
      command: process.execPath,
    })
    openedSessionIds.push(opened.sessionId)
    other.resumeAdmissions()
    expect(other.activeSessionCount()).toBe(0)
  })
})
