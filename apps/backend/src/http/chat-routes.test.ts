import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import { HttpError } from "./errors"
import { buildApp as buildAppUnfilled } from "./router"
import { routerLifecycleServices } from "../testUtils/routing-services"
import { withInertStateArgument } from "../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const buildApp = withInertStateArgument(buildAppUnfilled, 1)

function makeConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 3773,
    dataDir: "/tmp/betterc0de-test",
    dbPath: "/tmp/betterc0de-test/betterc0de.db",
    settingsPath: "/tmp/betterc0de-test/settings.json",
    authPath: "/tmp/betterc0de-test/auth.json",
    logsDir: "/tmp/betterc0de-test/logs",
    providerLogsDir: "/tmp/betterc0de-test/logs/provider",
    providerEventLogPath: "/tmp/betterc0de-test/logs/provider/events.log",
    authToken: "secret",
  }
}

function makeState(): AppState {
  return {
    ...routerLifecycleServices(),
    providerRegistry: { all: () => [] },
    providers: {
      withThreadMaintenance: async (_threadId: string, run: () => unknown) =>
        run(),
    },
    db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
    chatHelpers: {
      generateCommitMessage: vi.fn(async () => ({
        subject: "Update project files",
        body: "",
      })),
      generatePrContent: vi.fn(async () => ({
        title: "Update project changes",
        body: "## Summary\n\n- Updated\n\n## Testing\n\n- Not run",
      })),
      generateBranchName: vi.fn(async () => ({ branch: "update-project" })),
      generateThreadContextSummary: vi.fn(async () => ({
        summary: "Compacted BetterC0de thread context",
      })),
    },
  } as unknown as AppState
}

describe("chat text-generation routes", () => {
  it("returns a backend-owned automatic compaction decision before a turn", async () => {
    const state = {
      ...makeState(),
      threads: {
        listMessages: vi.fn(() => [
          { role: "user", content: "one" },
          { role: "assistant", content: "done one" },
          { role: "user", content: "two" },
          { role: "assistant", content: "done two" },
          { role: "user", content: "three" },
          { role: "assistant", content: "done three" },
        ]),
        getThreadProjectPath: vi.fn(() => null),
      },
      threadActivities: { listByThread: vi.fn(() => []) },
      providerSessionBindings: { list: vi.fn(() => []) },
      threadTurnCoordinator: { activeOwner: vi.fn(() => null) },
    } as unknown as AppState
    const app = buildApp(makeConfig(), state)

    const result = await postJson(
      app,
      "/api/v1/chat/compaction/decision",
      {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      {
        threadId: "thread-1",
        incomingContent: "x".repeat(4_000),
        usage: { usedTokens: 179_000, maxTokens: 200_000 },
        modelLimits: {
          contextTokens: 200_000,
          outputTokens: 32_000,
        },
      }
    )

    expect(result).toMatchObject({
      shouldCompact: true,
      reason: "threshold-reached",
      projectedTokens: 180_000,
      thresholdTokens: 168_000,
      completedTurns: 3,
    })
  })

  it("does not reuse pre-checkpoint usage to compact a fresh checkpoint", async () => {
    const state = {
      ...makeState(),
      threads: {
        listMessages: vi.fn(() => [
          {
            role: "assistant",
            content: "# Compacted Session Context\n\nFresh summary",
            compactedContext: true,
            compactionGeneration: 2,
            createdAt: "2026-07-10T18:00:00.000Z",
          },
        ]),
        getThreadProjectPath: vi.fn(() => null),
      },
      threadActivities: {
        latestByThreadKind: vi.fn(() => ({
          kind: "context-window.updated",
          payload: { usedTokens: 195_000, maxTokens: 200_000 },
          created_at: "2026-07-10T17:59:00.000Z",
        })),
      },
      providerSessionBindings: { list: vi.fn(() => []) },
      threadTurnCoordinator: { activeOwner: vi.fn(() => null) },
    } as unknown as AppState
    const app = buildApp(makeConfig(), state)

    const result = await postJson(
      app,
      "/api/v1/chat/compaction/decision",
      {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      {
        threadId: "thread-1",
        incomingContent: "continue",
        usage: { usedTokens: 195_000, maxTokens: 200_000 },
      }
    )

    expect(result).toMatchObject({
      shouldCompact: false,
      reason: "below-threshold",
      compactionGeneration: 2,
      completedTurns: 0,
    })
    expect((result as { usedTokens: number }).usedTokens).toBeLessThan(1_000)
  })

  it("refuses an automatic compaction decision while a turn owns admission", async () => {
    const state = {
      ...makeState(),
      threads: {
        listMessages: vi.fn(() => [
          { role: "user", content: "one" },
          { role: "assistant", content: "done one" },
          { role: "user", content: "two" },
          { role: "assistant", content: "done two" },
          { role: "user", content: "three" },
          { role: "assistant", content: "done three" },
        ]),
        getThreadProjectPath: vi.fn(() => null),
      },
      threadActivities: { listByThread: vi.fn(() => []) },
      providerSessionBindings: { list: vi.fn(() => []) },
      threadTurnCoordinator: {
        activeOwner: vi.fn(() => "active-turn-1"),
      },
    } as unknown as AppState
    const app = buildApp(makeConfig(), state)

    const result = await postJson(
      app,
      "/api/v1/chat/compaction/decision",
      {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      {
        threadId: "thread-1",
        usage: { usedTokens: 195_000, maxTokens: 200_000 },
      }
    )

    expect(result).toMatchObject({
      shouldCompact: false,
      reason: "turn-active",
    })
  })

  it("stops every bound session before atomically committing compaction", async () => {
    const stopSession = vi.fn(async () => {})
    const commitCompaction = vi.fn(() => ({
      alreadyCommitted: false,
      generation: 3,
      messageId: "checkpoint-1",
    }))
    const state = {
      ...makeState(),
      threads: {
        findCompactionCommit: vi.fn(() => null),
        commitCompaction,
      },
      providerHub: {
        stopSession,
        withThreadMaintenance: async (_threadId: string, run: () => unknown) =>
          run(),
      },
      providerSessionBindings: {
        list: vi.fn(() => [
          {
            threadId: "thread-1",
            providerKind: "codex",
            providerInstanceId: "codex-work",
            status: "ready",
            activeTurnId: null,
          },
          {
            threadId: "thread-1",
            providerKind: "claude",
            providerInstanceId: "claude-work",
            status: "stopped",
            activeTurnId: null,
          },
        ]),
      },
    } as unknown as AppState
    const app = buildApp(makeConfig(), state)

    const result = await postJson(
      app,
      "/api/v1/chat/session/rotate",
      {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      {
        threadId: "thread-1",
        checkpointMessageId: "checkpoint-1",
        checkpointContent: "# Compacted Session Context\n\nDurable summary",
        checkpointCreatedAt: "2026-07-10T18:00:00.000Z",
        commandMessageId: "compact-command-1",
        commandContent: "/compact",
        commandCreatedAt: "2026-07-10T17:59:59.000Z",
      }
    )

    expect(result).toEqual({
      rotated: true,
      generation: 3,
      messageId: "checkpoint-1",
    })
    expect(stopSession).toHaveBeenCalledTimes(2)
    expect(stopSession.mock.invocationCallOrder.at(-1) ?? 0).toBeLessThan(
      commitCompaction.mock.invocationCallOrder[0] ?? 0
    )
    expect(commitCompaction).toHaveBeenCalledWith({
      thread_id: "thread-1",
      request_id: "checkpoint-1",
      command_message: {
        message_id: "compact-command-1",
        turn_id: null,
        role: "user",
        content: "/compact",
        created_at: "2026-07-10T17:59:59.000Z",
        extra: {},
      },
      checkpoint_message: {
        message_id: "checkpoint-1",
        turn_id: null,
        role: "assistant",
        content: "# Compacted Session Context\n\nDurable summary",
        created_at: "2026-07-10T18:00:00.000Z",
        extra: { compactedContext: true },
      },
    })
  })

  it("does not persist a compaction checkpoint when stopping a session fails", async () => {
    const commitCompaction = vi.fn()
    const state = {
      ...makeState(),
      threads: { findCompactionCommit: vi.fn(() => null), commitCompaction },
      providerHub: {
        stopSession: vi.fn(async () => {
          throw new Error("stop failed")
        }),
        withThreadMaintenance: async (_threadId: string, run: () => unknown) =>
          run(),
      },
      providerSessionBindings: {
        list: vi.fn(() => [
          {
            threadId: "thread-1",
            providerKind: "codex",
            providerInstanceId: "codex-work",
            status: "ready",
            activeTurnId: null,
          },
        ]),
      },
    } as unknown as AppState
    const app = buildApp(makeConfig(), state)
    const response = await app.request("/api/v1/chat/session/rotate", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-1",
        checkpointMessageId: "checkpoint-failed",
        checkpointContent: "# Compacted Session Context\n\nSummary",
        checkpointCreatedAt: "2026-07-10T18:00:00.000Z",
        commandMessageId: "compact-command-failed",
        commandContent: "/compact",
        commandCreatedAt: "2026-07-10T17:59:59.000Z",
      }),
    })

    expect(response.status).toBe(500)
    expect(commitCompaction).not.toHaveBeenCalled()
  })

  it("returns an idempotent compaction retry without stopping sessions again", async () => {
    const stopSession = vi.fn()
    const commitCompaction = vi.fn()
    const list = vi.fn()
    const state = {
      ...makeState(),
      threads: {
        findCompactionCommit: vi.fn(() => ({
          alreadyCommitted: true,
          generation: 4,
          messageId: "checkpoint-retry",
        })),
        commitCompaction,
      },
      providerHub: {
        stopSession,
        withThreadMaintenance: async (_threadId: string, run: () => unknown) =>
          run(),
      },
      providerSessionBindings: { list },
    } as unknown as AppState
    const app = buildApp(makeConfig(), state)

    const result = await postJson(
      app,
      "/api/v1/chat/session/rotate",
      {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      {
        threadId: "thread-1",
        checkpointMessageId: "checkpoint-retry",
        checkpointContent: "# Compacted Session Context\n\nSummary",
        checkpointCreatedAt: "2026-07-10T18:00:00.000Z",
        commandMessageId: "compact-command-retry",
        commandContent: "/compact",
        commandCreatedAt: "2026-07-10T17:59:59.000Z",
      }
    )

    expect(result).toEqual({
      rotated: true,
      generation: 4,
      messageId: "checkpoint-retry",
    })
    expect(list).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()
    expect(commitCompaction).not.toHaveBeenCalled()
  })

  it("rejects a stale automatic compaction precondition before stopping sessions", async () => {
    const stopSession = vi.fn()
    const commitCompaction = vi.fn()
    const state = {
      ...makeState(),
      threads: {
        findCompactionCommit: vi.fn(() => null),
        listMessages: vi.fn(() => [
          {
            id: "checkpoint-newer",
            role: "assistant",
            content: "# Compacted Session Context\n\nNewer summary",
            compactedContext: true,
            compactionGeneration: 2,
            createdAt: "2026-07-10T18:00:00.000Z",
          },
        ]),
        commitCompaction,
      },
      providerHub: {
        stopSession,
        withThreadMaintenance: async (_threadId: string, run: () => unknown) =>
          run(),
      },
      providers: {
        withThreadMaintenance: async (_threadId: string, run: () => unknown) =>
          run(),
      },
      providerSessionBindings: { list: vi.fn(() => []) },
    } as unknown as AppState
    const app = buildApp(makeConfig(), state)

    const response = await app.request("/api/v1/chat/session/rotate", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-1",
        checkpointMessageId: "checkpoint-stale",
        checkpointContent: "# Compacted Session Context\n\nStale summary",
        checkpointCreatedAt: "2026-07-10T18:01:00.000Z",
        commandMessageId: "compact-command-stale",
        commandContent: "/compact --automatic",
        commandCreatedAt: "2026-07-10T18:00:59.000Z",
        autoCompactionPrecondition: {
          compactionGeneration: 1,
          lastMessageId: "assistant-old",
        },
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: "compaction_decision_stale",
    })
    expect(stopSession).not.toHaveBeenCalled()
    expect(commitCompaction).not.toHaveBeenCalled()
  })

  it("blocks compaction while a legacy provider turn owns thread admission", async () => {
    const commitCompaction = vi.fn()
    const state = {
      ...makeState(),
      providers: {
        withThreadMaintenance: vi.fn(async () => {
          throw new HttpError(
            409,
            "Thread 'thread-1' already has an active legacy provider turn.",
            "turn_active"
          )
        }),
      },
      threads: { findCompactionCommit: vi.fn(() => null), commitCompaction },
      providerHub: {
        stopSession: vi.fn(),
        withThreadMaintenance: async (_threadId: string, run: () => unknown) =>
          run(),
      },
      providerSessionBindings: { list: vi.fn(() => []) },
    } as unknown as AppState
    const app = buildApp(makeConfig(), state)

    const response = await app.request("/api/v1/chat/session/rotate", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-1",
        checkpointMessageId: "checkpoint-legacy-busy",
        checkpointContent: "# Compacted Session Context\n\nSummary",
        checkpointCreatedAt: "2026-07-10T18:00:00.000Z",
        commandMessageId: "compact-command-legacy-busy",
        commandContent: "/compact",
        commandCreatedAt: "2026-07-10T17:59:59.000Z",
      }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: "turn_active",
    })
    expect(commitCompaction).not.toHaveBeenCalled()
  })

  it("mounts commit, PR, branch, and context-summary generation endpoints", async () => {
    const state = makeState()
    const app = buildApp(makeConfig(), state)
    const headers = {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    }

    await expect(
      postJson(app, "/api/v1/chat/text-generation/commit-message", headers, {
        stagedSummary: "M README.md",
        stagedPatch: "diff",
      })
    ).resolves.toEqual({ subject: "Update project files", body: "" })

    await expect(
      postJson(app, "/api/v1/chat/text-generation/pr-content", headers, {
        baseBranch: "main",
        headBranch: "feature/demo",
        commitSummary: "Update files",
        diffSummary: "1 file changed",
        diffPatch: "diff",
      })
    ).resolves.toMatchObject({ title: "Update project changes" })

    await expect(
      postJson(app, "/api/v1/chat/text-generation/branch-name", headers, {
        message: "Fix branch generation",
      })
    ).resolves.toEqual({ branch: "update-project" })

    await expect(
      postJson(
        app,
        "/api/v1/chat/text-generation/thread-context-summary",
        headers,
        {
          transcript: "User asked for Claude Terminal handoff.",
        }
      )
    ).resolves.toEqual({ summary: "Compacted BetterC0de thread context" })
  })
})

async function postJson(
  app: ReturnType<typeof buildApp>,
  pathName: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const response = await app.request(pathName, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return response.json()
}
