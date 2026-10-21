import { describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDatabase } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import {
  isProviderSessionContinuationCompatible,
  ProviderSessionBindingStore,
  type ProviderSessionBinding,
} from "./ProviderSessionBindingStore"

function tmpDbPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bc0de-bindings-${label}-`))
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

describe("ProviderSessionBindingStore", () => {
  it("requires both provider kind and continuation key before reusing native state", () => {
    const binding: ProviderSessionBinding = {
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "native-thread-1",
      resumeCursor: { threadId: "native-thread-1" },
      continuationKey: "codex:home:/Users/example/.codex-work",
      status: "ready",
      activeTurnId: null,
      lastError: null,
      runtimeMode: "full-access",
      cwd: "/repo",
      modelSelection: null,
      generation: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    }

    expect(
      isProviderSessionContinuationCompatible(binding, {
        providerKind: "codex",
        continuationKey: "codex:home:/Users/example/.codex-work",
      })
    ).toBe(true)
    expect(
      isProviderSessionContinuationCompatible(binding, {
        providerKind: "codex",
        continuationKey: "codex:home:/Users/example/.codex",
      })
    ).toBe(false)
    expect(
      isProviderSessionContinuationCompatible(binding, {
        providerKind: "claude",
        continuationKey: "codex:home:/Users/example/.codex-work",
      })
    ).toBe(false)
  })

  it("clears stale active lifecycle state after a process restart without losing resume data", () => {
    const db = openDatabase(tmpDbPath("restart-recovery"))
    runMigrations(db)
    insertThread(db, "thread-1")

    const store = new ProviderSessionBindingStore(db)
    store.upsert({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      providerThreadId: "sdk-session-1",
      resumeCursor: { sessionId: "sdk-session-1" },
      continuationKey: "claude:home:/Users/example",
      status: "running",
      activeTurnId: "turn-stale",
      cwd: "/repo",
    })
    store.upsert({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-main",
      providerThreadId: "codex-session-1",
      continuationKey: "codex:home:/Users/example/.codex",
      status: "ready",
      activeTurnId: null,
    })

    expect(store.recoverAfterProcessRestart()).toBe(2)
    expect(store.get("thread-1", "claude-main")).toMatchObject({
      status: "stopped",
      activeTurnId: null,
      providerThreadId: "sdk-session-1",
      resumeCursor: { sessionId: "sdk-session-1" },
      continuationKey: "claude:home:/Users/example",
      cwd: "/repo",
      lastError:
        "Backend restarted before the provider session reached a terminal state.",
    })
    expect(store.get("thread-1", "codex-main")).toMatchObject({
      status: "stopped",
      activeTurnId: null,
      providerThreadId: "codex-session-1",
      lastError: null,
    })
    expect(store.recoverAfterProcessRestart()).toBe(0)
    db.close()
  })

  it("rotates a provider session generation without losing runtime context", () => {
    const db = openDatabase(tmpDbPath("rotate-generation"))
    runMigrations(db)
    insertThread(db, "thread-1")

    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "native-thread-1",
      resumeCursor: { threadId: "native-thread-1" },
      continuationKey: "codex:work",
    })
    store.updateRuntimeContext({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      cwd: "/repo",
      modelSelection: { instanceId: "codex-work", model: "gpt-live" },
    })
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-work",
      providerThreadId: "native-claude-1",
      resumeCursor: { sessionId: "native-claude-1" },
    })

    expect(store.rotateGeneration("thread-1", "codex-work")).toBe(1)
    expect(store.get("thread-1", "codex-work")).toMatchObject({
      generation: 1,
      providerThreadId: null,
      resumeCursor: null,
      continuationKey: null,
      status: "ready",
      activeTurnId: null,
      cwd: "/repo",
      modelSelection: { instanceId: "codex-work", model: "gpt-live" },
    })
    expect(store.get("thread-1", "claude-work")).toMatchObject({
      generation: 1,
      providerThreadId: null,
      resumeCursor: null,
    })
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-later",
      providerThreadId: "native-current-generation",
    })
    expect(store.get("thread-1", "codex-later")?.generation).toBe(1)
    expect(store.rotateGeneration("thread-1", "codex-work")).toBe(2)
    db.close()
  })

  it("atomically retires all native continuations when switching providers", () => {
    const db = openDatabase(tmpDbPath("provider-switch-generation"))
    runMigrations(db)
    insertThread(db, "thread-1")

    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "native-codex-1",
      resumeCursor: { threadId: "native-codex-1" },
      continuationKey: "codex:work",
    })
    store.updateRuntimeContext({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      cwd: "/repo",
      runtimeMode: "full-access",
      modelSelection: { instanceId: "codex-work", model: "gpt-live" },
    })
    store.updateSessionLifecycle({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      status: "running",
      activeTurnId: "turn-codex",
      lastError: "stale error",
    })
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-work",
      providerThreadId: "native-claude-1",
      resumeCursor: { sessionId: "native-claude-1" },
      continuationKey: "claude:work",
    })
    store.updateRuntimeContext({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-work",
      cwd: "/other-repo",
      runtimeMode: "read-only",
      modelSelection: {
        instanceId: "claude-work",
        model: "claude-opus-4-7",
      },
    })

    expect(
      store.rotateGenerationForProviderSwitch("thread-1", "codex-work")
    ).toBe(1)
    expect(store.getThreadGeneration("thread-1")).toBe(1)
    expect(store.get("thread-1", "codex-work")).toMatchObject({
      generation: 1,
      providerThreadId: null,
      resumeCursor: null,
      continuationKey: null,
      status: "stopped",
      activeTurnId: null,
      lastError: null,
      cwd: "/repo",
      runtimeMode: "full-access",
      modelSelection: { instanceId: "codex-work", model: "gpt-live" },
    })
    expect(store.get("thread-1", "claude-work")).toMatchObject({
      generation: 1,
      providerThreadId: null,
      resumeCursor: null,
      continuationKey: null,
      status: "stopped",
      activeTurnId: null,
      lastError: null,
      cwd: "/other-repo",
      runtimeMode: "read-only",
      modelSelection: {
        instanceId: "claude-work",
        model: "claude-opus-4-7",
      },
    })

    expect(
      store.rotateGenerationForProviderSwitch("thread-1", "missing-source")
    ).toBeNull()
    expect(store.getThreadGeneration("thread-1")).toBe(1)
    db.close()
  })

  it("keeps provider thread ids isolated per provider instance", () => {
    const db = openDatabase(tmpDbPath("isolated"))
    runMigrations(db)
    insertThread(db, "thread-1")

    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex",
      providerThreadId: "codex-thread-default",
      continuationKey: "codex:home:/Users/example/.codex",
    })
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "codex-thread-work",
      continuationKey: "codex:home:/Users/example/.codex-work",
    })

    expect(store.getProviderThreadId("thread-1", "codex")).toBe(
      "codex-thread-default"
    )
    expect(store.getProviderThreadId("thread-1", "codex-work")).toBe(
      "codex-thread-work"
    )
    expect(store.get("thread-1", "codex-work")).toMatchObject({
      providerKind: "codex",
      providerInstanceId: "codex-work",
      continuationKey: "codex:home:/Users/example/.codex-work",
      resumeCursor: { providerThreadId: "codex-thread-work" },
    })
    db.close()
  })

  it("updates an existing binding instead of adding another row", () => {
    const db = openDatabase(tmpDbPath("upsert"))
    runMigrations(db)
    insertThread(db, "thread-1")

    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude",
      providerThreadId: "session-a",
      continuationKey: "claude:home:/Users/example",
    })
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude",
      providerThreadId: "session-b",
      continuationKey: "claude:home:/Users/example",
    })

    expect(store.getProviderThreadId("thread-1", "claude")).toBe("session-b")
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM provider_session_bindings")
      .get() as { n: number }
    expect(count.n).toBe(1)
    db.close()
  })

  it("persists provider-specific resume cursors when supplied", () => {
    const db = openDatabase(tmpDbPath("resume-cursor"))
    runMigrations(db)
    insertThread(db, "thread-1")

    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude",
      providerThreadId: "sdk-session",
      resumeCursor: {
        threadId: "thread-1",
        resume: "sdk-session",
        sessionId: "sdk-session",
        resumeSessionAt: "assistant-uuid-1",
        turnCount: 2,
      },
      continuationKey: "claude:home:/Users/example",
    })

    expect(store.get("thread-1", "claude")).toMatchObject({
      providerKind: "claude",
      providerThreadId: "sdk-session",
      resumeCursor: {
        threadId: "thread-1",
        resume: "sdk-session",
        sessionId: "sdk-session",
        resumeSessionAt: "assistant-uuid-1",
        turnCount: 2,
      },
    })
    db.close()
  })

  it("returns latest bindings for a thread and provider kind", () => {
    const db = openDatabase(tmpDbPath("latest"))
    runMigrations(db)
    insertThread(db, "thread-1")

    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex",
      providerThreadId: "codex-session",
      continuationKey: "codex:home:/Users/example/.codex",
    })
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-work",
      providerThreadId: "claude-session",
      continuationKey: "claude:home:/Users/example",
    })
    db.prepare(
      `
      UPDATE provider_session_bindings
      SET updated_at = '2099-02-01T00:00:00.000Z'
      WHERE provider_instance_id = 'claude-work'
    `
    ).run()

    expect(store.getLatestForThreadProvider("thread-1", "codex")).toMatchObject(
      {
        providerKind: "codex",
        providerInstanceId: "codex",
        providerThreadId: "codex-session",
      }
    )
    expect(store.getLatestForThread("thread-1")).toMatchObject({
      providerKind: "claude",
      providerInstanceId: "claude-work",
      providerThreadId: "claude-session",
    })
    db.close()
  })

  it("persists runtime lifecycle without dropping provider resume data", () => {
    const db = openDatabase(tmpDbPath("lifecycle"))
    runMigrations(db)
    insertThread(db, "thread-1")

    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-work",
      providerThreadId: "sdk-session",
      resumeCursor: { sessionId: "sdk-session" },
      continuationKey: "claude:home:/Users/example",
    })
    store.updateSessionLifecycle({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-work",
      status: "running",
      activeTurnId: "turn-1",
    })
    store.updateSessionLifecycle({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-work",
      status: "error",
      activeTurnId: null,
      lastError: "model failed",
    })

    expect(store.get("thread-1", "claude-work")).toMatchObject({
      providerKind: "claude",
      providerInstanceId: "claude-work",
      providerThreadId: "sdk-session",
      resumeCursor: { sessionId: "sdk-session" },
      continuationKey: "claude:home:/Users/example",
      status: "error",
      activeTurnId: null,
      lastError: "model failed",
      // No mode was ever stated: fail closed rather than bypass.
      runtimeMode: "approval-required",
    })
    db.close()
  })

  it("persists runtime context without dropping provider resume data", () => {
    const db = openDatabase(tmpDbPath("runtime-context"))
    runMigrations(db)
    insertThread(db, "thread-1")

    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "codex-thread-1",
      resumeCursor: { threadId: "codex-thread-1" },
      continuationKey: "codex:home:/Users/example/.codex-work",
    })
    store.updateRuntimeContext({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      cwd: "/Users/example/project",
      modelSelection: {
        instanceId: "codex-work",
        model: "gpt-5.5",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "fastMode", value: true },
        ],
      },
    })
    store.updateSessionLifecycle({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      status: "running",
      activeTurnId: "turn-1",
    })

    expect(store.get("thread-1", "codex-work")).toMatchObject({
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "codex-thread-1",
      resumeCursor: { threadId: "codex-thread-1" },
      continuationKey: "codex:home:/Users/example/.codex-work",
      cwd: "/Users/example/project",
      modelSelection: {
        instanceId: "codex-work",
        model: "gpt-5.5",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "fastMode", value: true },
        ],
      },
      status: "running",
      activeTurnId: "turn-1",
    })
    db.close()
  })

  it("lists bindings for maintenance sweeps", () => {
    const db = openDatabase(tmpDbPath("list"))
    runMigrations(db)
    insertThread(db, "thread-1")
    insertThread(db, "thread-2")

    const store = new ProviderSessionBindingStore(db)
    store.setProviderThreadId({
      threadId: "thread-2",
      providerKind: "claude",
      providerInstanceId: "claude-work",
      providerThreadId: "sdk-session-2",
      continuationKey: "claude:home:/Users/example",
    })
    store.setProviderThreadId({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex-work",
      providerThreadId: "codex-session-1",
      continuationKey: "codex:home:/Users/example/.codex",
    })

    expect(
      store
        .list()
        .map((binding) => binding.threadId)
        .sort()
    ).toEqual(["thread-1", "thread-2"])
    db.close()
  })
})
