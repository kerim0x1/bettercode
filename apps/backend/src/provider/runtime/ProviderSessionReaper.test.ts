import { describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDatabase } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import { ProviderSessionBindingStore } from "./ProviderSessionBindingStore"
import { ProviderSessionReaper } from "./ProviderSessionReaper"

function tmpDbPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bc0de-reaper-${label}-`))
  return path.join(dir, "test.sqlite")
}

function insertThread(
  db: ReturnType<typeof openDatabase>,
  threadId: string
): void {
  db.prepare(
    `
    INSERT INTO projection_threads
      (thread_id, project_id, title, status, env_mode, created_at, updated_at)
    VALUES (?, 'project-1', NULL, 'active', 'local', '2026-01-01', '2026-01-01')
  `
  ).run(threadId)
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }
}

function makeProviderHub(stopSession: () => Promise<void>) {
  async function withThreadMaintenance<T>(
    _threadId: string,
    operation: () => Promise<T> | T
  ): Promise<T> {
    return await operation()
  }
  return {
    stopSession,
    withThreadMaintenance,
  }
}

describe("ProviderSessionReaper", () => {
  it.each([
    [Number.NaN, 5 * 60 * 1000],
    [Number.POSITIVE_INFINITY, 5 * 60 * 1000],
    [30 * 24 * 60 * 60 * 1000, 2 ** 31 - 1],
  ])(
    "keeps invalid or overflowing sweep delay %s from becoming a busy loop",
    async (sweepIntervalMs, expectedDelay) => {
      vi.useFakeTimers()
      const db = openDatabase(":memory:")
      runMigrations(db)
      const reaper = new ProviderSessionReaper({
        bindings: new ProviderSessionBindingStore(db),
        providerHub: makeProviderHub(async () => undefined),
        logger: makeLogger(),
        sweepIntervalMs,
      })
      const sweep = vi.spyOn(reaper, "sweep").mockResolvedValue({
        totalBindings: 0,
        reapedCount: 0,
        skippedActiveCount: 0,
        skippedFreshCount: 0,
        skippedStoppedCount: 0,
        failedCount: 0,
      })
      try {
        reaper.start()
        await vi.advanceTimersByTimeAsync(expectedDelay - 1)
        expect(sweep).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(sweep).toHaveBeenCalledTimes(1)
        await reaper.stop()
        await vi.advanceTimersByTimeAsync(expectedDelay)
        expect(sweep).toHaveBeenCalledTimes(1)
      } finally {
        await reaper.stop()
        db.close()
        vi.useRealTimers()
      }
    }
  )

  it("reaps stale provider sessions without active turns", async () => {
    const db = openDatabase(tmpDbPath("stale"))
    runMigrations(db)
    insertThread(db, "thread-stale")
    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-stale",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      providerThreadId: "sdk-session",
      continuationKey: "claude:home:/Users/example",
    })
    db.prepare(
      "UPDATE provider_session_bindings SET updated_at = ? WHERE thread_id = ?"
    ).run("2026-05-13T00:00:00.000Z", "thread-stale")

    const stopSession = vi.fn(async () => {})
    const logger = makeLogger()
    const reaper = new ProviderSessionReaper({
      bindings: store,
      providerHub: makeProviderHub(stopSession),
      logger,
      inactivityThresholdMs: 1_000,
      now: () => Date.parse("2026-05-13T00:00:02.000Z"),
    })

    await expect(reaper.sweep()).resolves.toMatchObject({
      totalBindings: 1,
      reapedCount: 1,
      failedCount: 0,
    })
    expect(stopSession).toHaveBeenCalledWith(
      "claude",
      "thread-stale",
      "claude-main"
    )
    expect(store.get("thread-stale", "claude-main")).toMatchObject({
      status: "stopped",
      activeTurnId: null,
    })
    db.close()
  })

  it("skips active, fresh, and already stopped sessions", async () => {
    const db = openDatabase(tmpDbPath("skip"))
    runMigrations(db)
    for (const threadId of [
      "thread-active",
      "thread-fresh",
      "thread-stopped",
    ]) {
      insertThread(db, threadId)
    }
    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-active",
      providerKind: "codex",
      providerInstanceId: "codex-main",
      providerThreadId: "codex-session-active",
      continuationKey: "codex:home:/Users/example/.codex",
    })
    store.updateSessionLifecycle({
      threadId: "thread-active",
      providerKind: "codex",
      providerInstanceId: "codex-main",
      status: "running",
      activeTurnId: "turn-active",
    })
    store.setProviderThreadId({
      threadId: "thread-fresh",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      providerThreadId: "sdk-session-fresh",
      continuationKey: "claude:home:/Users/example",
    })
    store.setProviderThreadId({
      threadId: "thread-stopped",
      providerKind: "claude",
      providerInstanceId: "claude-old",
      providerThreadId: "sdk-session-stopped",
      continuationKey: "claude:home:/Users/example",
    })
    store.updateSessionLifecycle({
      threadId: "thread-stopped",
      providerKind: "claude",
      providerInstanceId: "claude-old",
      status: "stopped",
      activeTurnId: null,
    })
    db.prepare(
      "UPDATE provider_session_bindings SET updated_at = ? WHERE thread_id IN (?, ?)"
    ).run("2026-05-13T00:00:00.000Z", "thread-active", "thread-stopped")
    db.prepare(
      "UPDATE provider_session_bindings SET updated_at = ? WHERE thread_id = ?"
    ).run("2026-05-13T00:00:01.500Z", "thread-fresh")

    const stopSession = vi.fn(async () => {})
    const reaper = new ProviderSessionReaper({
      bindings: store,
      providerHub: makeProviderHub(stopSession),
      logger: makeLogger(),
      inactivityThresholdMs: 1_000,
      now: () => Date.parse("2026-05-13T00:00:02.000Z"),
    })

    await expect(reaper.sweep()).resolves.toMatchObject({
      totalBindings: 3,
      reapedCount: 0,
      skippedActiveCount: 1,
      skippedFreshCount: 1,
      skippedStoppedCount: 1,
    })
    expect(stopSession).not.toHaveBeenCalled()
    db.close()
  })

  it("coalesces overlapping sweeps until the active sweep completes", async () => {
    const db = openDatabase(tmpDbPath("overlap"))
    runMigrations(db)
    insertThread(db, "thread-overlap")
    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-overlap",
      providerKind: "codex",
      providerInstanceId: "codex-main",
      providerThreadId: "codex-session",
      continuationKey: "codex:home:/Users/example/.codex",
    })
    db.prepare(
      "UPDATE provider_session_bindings SET updated_at = ? WHERE thread_id = ?"
    ).run("2026-05-13T00:00:00.000Z", "thread-overlap")

    let releaseStop!: () => void
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const stopSession = vi.fn(() => stopGate)
    const reaper = new ProviderSessionReaper({
      bindings: store,
      providerHub: makeProviderHub(stopSession),
      logger: makeLogger(),
      inactivityThresholdMs: 1_000,
      now: () => Date.parse("2026-05-13T00:00:02.000Z"),
    })

    const first = reaper.sweep()
    const second = reaper.sweep()
    expect(second).toBe(first)
    expect(stopSession).toHaveBeenCalledTimes(1)

    releaseStop()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ reapedCount: 1, failedCount: 0 }),
      expect.objectContaining({ reapedCount: 1, failedCount: 0 }),
    ])
    expect(stopSession).toHaveBeenCalledTimes(1)
    db.close()
  })
})
