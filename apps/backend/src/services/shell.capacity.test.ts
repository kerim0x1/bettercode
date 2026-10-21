import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const children = vi.hoisted(
  () =>
    [] as Array<
      EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        kill: ReturnType<typeof vi.fn>
      }
    >
)

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(() => true),
      exitCode: null,
    })
    children.push(child)
    return child
  }),
}))

import {
  __abortAllShellSessionsForTests,
  abortShellSession,
  activeShellSessionCount,
  closeAllShellSessions,
  closeShellSessionsForOwner,
  MAX_ACTIVE_SHELL_SESSIONS,
  MAX_ACTIVE_SHELL_SESSIONS_PER_OWNER,
  runShellCommand,
} from "./shell"

beforeEach(() => {
  __abortAllShellSessionsForTests()
  for (const child of children.splice(0)) child.emit("close", 0, null)
})

describe("shell process admission", () => {
  it("rejects duplicate caller-selected ids without losing the original", async () => {
    const original = runShellCommand({
      command: "echo first",
      cwd: process.cwd(),
      sessionId: "same-id",
    })

    await expect(
      runShellCommand({
        command: "echo second",
        cwd: process.cwd(),
        sessionId: "same-id",
      })
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(activeShellSessionCount()).toBe(1)

    children[0]!.emit("close", 0, null)
    await expect(original).resolves.toMatchObject({ success: true })
  })

  it("caps concurrently active child processes", async () => {
    const pending = Array.from(
      { length: MAX_ACTIVE_SHELL_SESSIONS },
      (_, index) =>
        runShellCommand({
          command: "echo held",
          cwd: process.cwd(),
          sessionId: `held-${index}`,
        })
    )

    await expect(
      runShellCommand({
        command: "echo overflow",
        cwd: process.cwd(),
        sessionId: "overflow",
      })
    ).rejects.toMatchObject({ statusCode: 429 })
    expect(activeShellSessionCount()).toBe(MAX_ACTIVE_SHELL_SESSIONS)

    for (const child of children) child.emit("close", 0, null)
    await Promise.all(pending)
    expect(activeShellSessionCount()).toBe(0)
  })

  it("isolates session ownership and caps each authenticated caller", async () => {
    const ownerAPending = Array.from(
      { length: MAX_ACTIVE_SHELL_SESSIONS_PER_OWNER },
      (_, index) =>
        runShellCommand({
          command: "echo held",
          cwd: process.cwd(),
          sessionId: `owner-a-${index}`,
          ownerId: "owner-a",
        })
    )

    await expect(
      runShellCommand({
        command: "echo overflow",
        cwd: process.cwd(),
        sessionId: "owner-a-overflow",
        ownerId: "owner-a",
      })
    ).rejects.toMatchObject({ statusCode: 429 })

    const ownerBPending = runShellCommand({
      command: "echo independent",
      cwd: process.cwd(),
      sessionId: "owner-b-session",
      ownerId: "owner-b",
    })
    expect(abortShellSession("owner-a-0", "owner-b")).toBe(false)
    expect(abortShellSession("owner-a-0", "owner-a")).toBe(true)

    for (const child of children) child.emit("close", 0, null)
    await Promise.all([...ownerAPending, ownerBPending])
  })

  it("waits for active children while closing every shell session", async () => {
    const pending = runShellCommand({
      command: "echo held",
      cwd: process.cwd(),
      sessionId: "shutdown",
    })
    const child = children[0]!

    const shutdown = closeAllShellSessions(1_000)
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    child.emit("close", null, "SIGTERM")

    await expect(shutdown).resolves.toBe(1)
    await expect(pending).resolves.toMatchObject({ aborted: true })
    expect(activeShellSessionCount()).toBe(0)
  })

  it("terminates and releases a shell session when its owner signal aborts", async () => {
    const controller = new AbortController()
    const pending = runShellCommand({
      command: "echo held",
      cwd: process.cwd(),
      sessionId: "turn-abort",
      signal: controller.signal,
    })
    const child = children[0]!

    expect(activeShellSessionCount()).toBe(1)
    controller.abort()
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")

    // Windows taskkill commonly reports a null close signal. The explicit
    // signal marker must still normalize this as an aborted command.
    child.emit("close", null, null)
    await expect(pending).resolves.toMatchObject({
      success: false,
      aborted: true,
      timedOut: false,
    })
    expect(activeShellSessionCount()).toBe(0)
  })

  it("closes only process trees owned by a revoked principal", async () => {
    const ownerAPending = runShellCommand({
      command: "echo owner-a",
      cwd: process.cwd(),
      sessionId: "revoked-owner-a",
      ownerId: "remote:owner-a",
    })
    const ownerBPending = runShellCommand({
      command: "echo owner-b",
      cwd: process.cwd(),
      sessionId: "active-owner-b",
      ownerId: "remote:owner-b",
    })

    const cleanup = closeShellSessionsForOwner("remote:owner-a", 1_000)
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM")
    expect(children[1]!.kill).not.toHaveBeenCalled()
    children[0]!.emit("close", null, "SIGTERM")

    await expect(cleanup).resolves.toBe(1)
    await expect(ownerAPending).resolves.toMatchObject({ aborted: true })
    children[1]!.emit("close", 0, null)
    await expect(ownerBPending).resolves.toMatchObject({ success: true })
  })

  it("revalidates a remote owner after spawn registration", async () => {
    const isOwnerActive = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const pending = runShellCommand({
      command: "echo race",
      cwd: process.cwd(),
      sessionId: "owner-race",
      ownerId: "remote:owner-race",
      ownerExpiresAt: Date.now() + 60_000,
      isOwnerActive,
    })

    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM")
    children[0]!.emit("close", null, "SIGTERM")
    await expect(pending).resolves.toMatchObject({ aborted: true })
    expect(isOwnerActive).toHaveBeenCalledTimes(2)
  })

  it("terminates a remote-owned process at its absolute session expiry", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"))
      const pending = runShellCommand({
        command: "echo expiry",
        cwd: process.cwd(),
        sessionId: "owner-expiry",
        ownerId: "remote:owner-expiry",
        ownerExpiresAt: Date.now() + 1_000,
      })

      await vi.advanceTimersByTimeAsync(1_000)
      expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM")
      children[0]!.emit("close", null, "SIGTERM")
      await expect(pending).resolves.toMatchObject({ aborted: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a shell process tree that survives both shutdown signals", async () => {
    vi.useFakeTimers()
    try {
      const pending = runShellCommand({
        command: "echo held",
        cwd: process.cwd(),
        sessionId: "shutdown-survivor",
      })
      const child = children[0]!
      const shutdown = closeAllShellSessions(100)
      const shutdownExpectation = expect(shutdown).rejects.toMatchObject({
        code: "SHELL_SHUTDOWN_INCOMPLETE",
        sessionIds: ["shutdown-survivor"],
      })

      await vi.advanceTimersByTimeAsync(100)
      expect(child.kill).toHaveBeenCalledWith("SIGTERM")
      expect(child.kill).toHaveBeenCalledWith("SIGKILL")
      await vi.advanceTimersByTimeAsync(6_000)
      await shutdownExpectation

      child.emit("close", null, "SIGKILL")
      await expect(pending).resolves.toMatchObject({ aborted: true })
    } finally {
      vi.useRealTimers()
    }
  })
})
