import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkpointRefForThreadTurn } from "@betterc0de/schema"
import { describe, expect, it, vi } from "vitest"
import { CheckpointReactor } from "../../checkpointing/CheckpointReactor"
import { openDatabase } from "../../persistence/db"
import { EventStore } from "../../persistence/eventStore"
import { runMigrations } from "../../persistence/migrations"
import type { ThreadActivityProjection } from "../../persistence/projections"
import {
  CheckpointDiffProjectionQuery,
  ThreadActivityProjectionQuery,
} from "../../persistence/projections"
import { ProviderEventBus } from "../events"
import type { ProviderRuntimeEvent as LegacyProviderRuntimeEvent } from "../types"
import { hasCheckpointRef } from "../../services/git"
import { ThreadService } from "../../services/threads"
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderKind,
  ThreadId,
} from "./contracts"
import { canonicalToLegacy } from "./legacyBridge"
import { ProviderHub } from "./ProviderHub"
import { ProviderRuntimeEventJournal } from "./ProviderRuntimeEventJournal"
import { ProviderRuntimeIngestion } from "./ProviderRuntimeIngestion"
import { ProviderRuntimeJournalRecoveryStore } from "./ProviderRuntimeJournalRecoveryStore"
import { ProviderRuntimeJournalReplayer } from "./ProviderRuntimeJournalReplayer"
import { ProviderRuntimeProjectionReceiptStore } from "./ProviderRuntimeProjectionReceiptStore"
import { ProviderSessionBindingStore } from "./ProviderSessionBindingStore"
import { makeTestProviderAdapterHarness } from "./testUtils/TestProviderAdapterHarness"

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeBroadcaster() {
  const frames: unknown[] = []
  return {
    frames,
    broadcast: vi.fn((frame: unknown) => {
      frames.push(frame)
    }),
    clientCount: vi.fn(() => 1),
  }
}

function channelFrames(
  frames: ReadonlyArray<unknown>,
  channel: string
): unknown[] {
  return frames.filter(
    (frame) =>
      typeof frame === "object" &&
      frame !== null &&
      (frame as { channel?: unknown }).channel === channel
  )
}

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", [...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
}

function createGitRepo(): string {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-provider-harness-")
  )
  runGit(cwd, ["init", "--initial-branch=main"])
  runGit(cwd, ["config", "user.email", "test@example.com"])
  runGit(cwd, ["config", "user.name", "Test User"])
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8")
  runGit(cwd, ["add", "."])
  runGit(cwd, ["commit", "-m", "Initial"])
  return cwd
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastValue: T | undefined
  while (Date.now() <= deadline) {
    lastValue = await read()
    if (predicate(lastValue)) return lastValue
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(lastValue)}`
  )
}

describe("ProviderHub harness integration", () => {
  it("drives a deterministic provider turn through hub, legacy bridge and runtime ingestion", async () => {
    const threadId = "thread-1" as ThreadId
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const legacyBus = new ProviderEventBus()
    const harness = makeTestProviderAdapterHarness({
      provider: "codex" as ProviderKind,
      models: [
        {
          slug: "gpt-5.5",
          name: "GPT 5.5",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "xhigh", label: "Extra High" }],
              },
            ],
          },
        },
      ],
      skills: [{ name: "review", path: "/tmp/skills/review", enabled: true }],
      slashCommands: [{ name: "compact" }],
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex" as ProviderKind,
          displayName: "Codex Work",
          enabled: true,
          adapter: harness.adapter,
        },
      ],
    })
    hub.subscribe((event) => legacyBus.emitCanonical(event))
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: legacyBus,
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster,
      logger,
      sequenceStart: 100,
    })
    const stopIngestion = ingestion.start()

    harness.queueTurnResponseForNextSession({
      events: [
        { type: "turn.started", turnId: "turn-1" },
        {
          type: "message.delta",
          turnId: "turn-1",
          delta: "I will run the harness.\n",
        },
        {
          type: "tool.started",
          turnId: "turn-1",
          toolId: "tool-1",
          toolName: "exec_command",
          title: "Run tests",
          input: { command: "npm test" },
        },
        {
          type: "tool.completed",
          turnId: "turn-1",
          toolId: "tool-1",
          toolName: "exec_command",
          output: { stdout: "ok" },
        },
        {
          type: "approval.requested",
          turnId: "turn-1",
          requestId: "approval-1",
          requestKind: "command",
          tool: "exec_command",
          input: { command: "git status" },
          detail: "git status",
        },
        {
          type: "request.resolved",
          turnId: "turn-1",
          requestId: "approval-1",
          decision: "approve",
        },
        { type: "turn.completed", turnId: "turn-1", status: "completed" },
      ],
    })

    await hub.sendTurn("codex" as ProviderKind, {
      providerInstanceId: "codex-work",
      threadId: "thread-1",
      message: "Run tests",
      modelId: "gpt-5.5",
      modelSelection: {
        instanceId: "codex-work",
        model: "gpt-5.5",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      history: [],
      projectPath: "/repo",
      reasoningEffort: "xhigh",
    })

    await hub.respondToRequest(
      "codex" as ProviderKind,
      threadId,
      "approval-1" as ApprovalRequestId,
      {
        kind: "tool_approval",
        decision: "approve",
      } as ProviderApprovalDecision,
      "codex-work"
    )
    await hub.interruptTurnForInstance(
      "codex" as ProviderKind,
      threadId,
      "codex-work"
    )
    stopIngestion()

    expect(harness.getStartCount()).toBe(1)
    expect(harness.listActiveSessionIds()).toEqual(["thread-1"])
    expect(harness.getSentTurns(threadId)[0]).toMatchObject({
      providerInstanceId: "codex-work",
      modelId: "gpt-5.5",
      reasoningEffort: "xhigh",
      modelSelection: {
        instanceId: "codex-work",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    })
    expect(harness.getApprovalResponses(threadId)).toEqual([
      {
        requestId: "approval-1",
        decision: { kind: "tool_approval", decision: "approve" },
      },
    ])
    expect(harness.getInterruptCalls(threadId)).toEqual(["thread-1"])

    const providerEvents = channelFrames(
      broadcaster.frames,
      "provider.runtimeEvent"
    ).map((frame) => (frame as { data: LegacyProviderRuntimeEvent }).data)
    expect(providerEvents.map((event) => event.event_type)).toEqual([
      "session.started",
      "turn_started",
      "content_delta",
      "tool_call",
      "tool_result",
      "tool_approval_requested",
      "tool_approval_resolved",
      "turn_completed",
    ])
    expect(providerEvents[3]).toMatchObject({
      thread_id: "thread-1",
      payload: {
        providerKind: "codex",
        providerInstanceId: "codex-work",
        tool_id: "tool-1",
        tool_name: "exec_command",
        input: { command: "npm test" },
        turn_id: "turn-1",
      },
    })

    expect(activities.map((activity) => activity.kind)).toEqual([
      "session.started",
      "turn.started",
      "tool.started",
      "tool.completed",
      "approval.requested",
      "approval.resolved",
      "turn.completed",
    ])
    expect(activities[2]).toMatchObject({
      thread_id: "thread-1",
      turn_id: "turn-1",
      provider_instance_id: "codex-work",
      kind: "tool.started",
      sequence: 104,
    })
    expect(activities[2]?.summary).toContain("npm test")
    expect(channelFrames(broadcaster.frames, "thread.activity")).toHaveLength(7)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("captures real git checkpoints and persists turn diff read models through the runtime harness", async () => {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-runtime-harness-")
    )
    const workspaceDir = createGitRepo()
    const db = openDatabase(path.join(rootDir, "test.sqlite"))
    runMigrations(db)
    const headBefore = runGit(workspaceDir, ["rev-parse", "HEAD"]).trim()
    const threadId = "thread-checkpoint-harness" as ThreadId
    const baseRef = checkpointRefForThreadTurn(threadId, 0)
    const checkpointRef = checkpointRefForThreadTurn(threadId, 1)
    const activities = new ThreadActivityProjectionQuery(db)
    const checkpointDiffs = new CheckpointDiffProjectionQuery(db)
    const threads = new ThreadService(db)
    const now = "2026-05-01T00:00:00.000Z"
    threads.upsertThreadMeta({
      thread_id: threadId,
      project_name: "Harness Project",
      title: "Harness Thread",
      project_path: workspaceDir,
      created_at: now,
      updated_at: now,
      codex_thread_id: null,
    })

    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const legacyBus = new ProviderEventBus()
    const checkpointReactor = new CheckpointReactor({
      eventBus: legacyBus,
      threads,
      logger,
    })
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: legacyBus,
      activityStore: activities,
      checkpointDiffStore: checkpointDiffs,
      broadcaster,
      logger,
      sequenceStart: 300,
      projectedSink: (event) => legacyBus.emitProjected(event),
    })
    const stopCheckpointReactor = checkpointReactor.start()
    const stopIngestion = ingestion.start()

    try {
      const harness = makeTestProviderAdapterHarness({
        provider: "codex" as ProviderKind,
      })
      const hub = new ProviderHub({
        instances: [
          {
            instanceId: "codex-work",
            driver: "codex",
            provider: "codex" as ProviderKind,
            displayName: "Codex Work",
            enabled: true,
            adapter: harness.adapter,
          },
        ],
        beforeTurn: (input) =>
          checkpointReactor.prepareTurn({
            event_type: "turn_started",
            thread_id: input.threadId,
            payload: {
              turn_id: input.turnId,
              dispatchTurnId: input.turnId,
              provider_kind: input.providerKind,
              provider_instance_id: input.providerInstanceId,
              ...(input.projectPath ? { project_path: input.projectPath } : {}),
            },
          }),
        afterTurn: async (event) => {
          const legacy = canonicalToLegacy(event)
          if (legacy) await checkpointReactor.finalizeTurn(legacy)
        },
      })
      hub.subscribe((event) => legacyBus.emitCanonical(event))

      harness.queueTurnResponseForNextSession({
        events: [
          { type: "turn.started", turnId: "turn-1" },
          {
            type: "content.delta",
            turnId: "turn-1",
            streamKind: "assistant_text",
            delta: "I updated the workspace.\n",
          },
          { type: "turn.completed", turnId: "turn-1", status: "completed" },
        ],
        mutateWorkspace: async ({ cwd }) => {
          await waitFor(
            () => hasCheckpointRef({ cwd, checkpointRef: baseRef }),
            (exists) => exists,
            "baseline checkpoint ref"
          )
          fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8")
          fs.writeFileSync(path.join(cwd, "notes.txt"), "new\n", "utf8")
        },
      })

      const turn = hub.startTurn("codex" as ProviderKind, {
        providerInstanceId: "codex-work",
        threadId,
        message: "Update files",
        modelId: "gpt-5.5",
        history: [],
        projectPath: workspaceDir,
        reasoningEffort: "xhigh",
      })
      await turn.completion
      await turn.settled

      const checkpointRows = await waitFor(
        () => checkpointDiffs.listCheckpointDiffsByThread(threadId),
        (rows) => rows.length === 1,
        "checkpoint diff read model"
      )
      const turnDiffRows = checkpointDiffs.listTurnDiffsByThread(threadId)
      const activityRows = activities.listByThread(threadId)

      expect(
        await hasCheckpointRef({ cwd: workspaceDir, checkpointRef: baseRef })
      ).toBe(false)
      expect(await hasCheckpointRef({ cwd: workspaceDir, checkpointRef })).toBe(
        true
      )
      expect(runGit(workspaceDir, ["rev-parse", "HEAD"]).trim()).toBe(
        headBefore
      )
      expect(runGit(workspaceDir, ["show", `${checkpointRef}:README.md`])).toBe(
        "v2\n"
      )
      expect(checkpointRows[0]).toMatchObject({
        thread_id: threadId,
        turn_id: turn.turnId,
        checkpoint_ref: checkpointRef,
      })
      expect(checkpointRows[0]?.diff_content).toContain(
        "diff --git a/README.md b/README.md"
      )
      expect(checkpointRows[0]?.diff_content).toContain(
        "diff --git a/notes.txt b/notes.txt"
      )
      expect(turnDiffRows).toEqual([
        expect.objectContaining({
          thread_id: threadId,
          turn_index: 1,
          files_changed: 2,
          insertions: 2,
          deletions: 1,
        }),
      ])
      expect(activityRows.map((activity) => activity.kind)).toContain(
        "checkpoint.captured"
      )
      expect(
        channelFrames(broadcaster.frames, "provider.runtimeEvent").some(
          (frame) =>
            (frame as { data?: { event_type?: string } }).data?.event_type ===
            "turn.diff.updated"
        )
      ).toBe(true)
      expect(logger.error).not.toHaveBeenCalled()
      await hub.stopAll()
    } finally {
      stopCheckpointReactor()
      await checkpointReactor.stop()
      stopIngestion()
      db.close()
      fs.rmSync(rootDir, { recursive: true, force: true })
      fs.rmSync(workspaceDir, { recursive: true, force: true })
    }
  }, 30_000)

  it("records failed turn runtime state and captures checkpoint status as error", async () => {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-runtime-failure-")
    )
    const workspaceDir = createGitRepo()
    const db = openDatabase(path.join(rootDir, "test.sqlite"))
    runMigrations(db)
    const headBefore = runGit(workspaceDir, ["rev-parse", "HEAD"]).trim()
    const threadId = "thread-failed-checkpoint-harness" as ThreadId
    const baseRef = checkpointRefForThreadTurn(threadId, 0)
    const checkpointRef = checkpointRefForThreadTurn(threadId, 1)
    const activities = new ThreadActivityProjectionQuery(db)
    const checkpointDiffs = new CheckpointDiffProjectionQuery(db)
    const threads = new ThreadService(db)
    const now = "2026-05-01T00:00:00.000Z"
    threads.upsertThreadMeta({
      thread_id: threadId,
      project_name: "Failed Harness Project",
      title: "Failed Harness Thread",
      project_path: workspaceDir,
      created_at: now,
      updated_at: now,
      codex_thread_id: null,
    })

    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const legacyBus = new ProviderEventBus()
    const checkpointReactor = new CheckpointReactor({
      eventBus: legacyBus,
      threads,
      logger,
    })
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: legacyBus,
      activityStore: activities,
      checkpointDiffStore: checkpointDiffs,
      broadcaster,
      logger,
      sequenceStart: 400,
      projectedSink: (event) => legacyBus.emitProjected(event),
    })
    const stopCheckpointReactor = checkpointReactor.start()
    const stopIngestion = ingestion.start()

    try {
      const harness = makeTestProviderAdapterHarness({
        provider: "codex" as ProviderKind,
      })
      const hub = new ProviderHub({
        instances: [
          {
            instanceId: "codex-work",
            driver: "codex",
            provider: "codex" as ProviderKind,
            displayName: "Codex Work",
            enabled: true,
            adapter: harness.adapter,
          },
        ],
        beforeTurn: (input) =>
          checkpointReactor.prepareTurn({
            event_type: "turn_started",
            thread_id: input.threadId,
            payload: {
              turn_id: input.turnId,
              dispatchTurnId: input.turnId,
              provider_kind: input.providerKind,
              provider_instance_id: input.providerInstanceId,
              ...(input.projectPath ? { project_path: input.projectPath } : {}),
            },
          }),
        afterTurn: async (event) => {
          const legacy = canonicalToLegacy(event)
          if (legacy) await checkpointReactor.finalizeTurn(legacy)
        },
      })
      hub.subscribe((event) => legacyBus.emitCanonical(event))

      harness.queueTurnResponseForNextSession({
        events: [
          { type: "turn.started", turnId: "turn-failed" },
          {
            type: "content.delta",
            turnId: "turn-failed",
            streamKind: "assistant_text",
            delta: "Partial output before failure.\n",
          },
          {
            type: "runtime.error",
            turnId: "turn-failed",
            message: "Sandbox command failed.",
            class: "provider_error",
          },
          {
            type: "turn.completed",
            turnId: "turn-failed",
            status: "failed",
            error: "Sandbox command failed.",
          },
        ],
        mutateWorkspace: async ({ cwd }) => {
          await waitFor(
            () => hasCheckpointRef({ cwd, checkpointRef: baseRef }),
            (exists) => exists,
            "failed turn baseline checkpoint ref"
          )
          fs.writeFileSync(path.join(cwd, "README.md"), "broken\n", "utf8")
        },
      })

      const turn = hub.startTurn("codex" as ProviderKind, {
        providerInstanceId: "codex-work",
        threadId,
        message: "Run risky command",
        modelId: "gpt-5.5",
        history: [],
        projectPath: workspaceDir,
        reasoningEffort: "xhigh",
      })
      await turn.completion
      await turn.settled

      const checkpointRows = await waitFor(
        () => checkpointDiffs.listCheckpointDiffsByThread(threadId),
        (rows) => rows.length === 1,
        "failed checkpoint diff read model"
      )
      const turnDiffRows = checkpointDiffs.listTurnDiffsByThread(threadId)
      const activityRows = activities.listByThread(threadId)
      const checkpointActivity = activityRows.find(
        (activity) => activity.kind === "checkpoint.captured"
      )
      const runtimeErrorActivities = activityRows.filter(
        (activity) => activity.kind === "runtime.error"
      )
      const providerEvents = channelFrames(
        broadcaster.frames,
        "provider.runtimeEvent"
      ).map((frame) => (frame as { data: LegacyProviderRuntimeEvent }).data)

      expect(
        await hasCheckpointRef({ cwd: workspaceDir, checkpointRef: baseRef })
      ).toBe(false)
      expect(await hasCheckpointRef({ cwd: workspaceDir, checkpointRef })).toBe(
        true
      )
      expect(runGit(workspaceDir, ["rev-parse", "HEAD"]).trim()).toBe(
        headBefore
      )
      expect(runGit(workspaceDir, ["show", `${checkpointRef}:README.md`])).toBe(
        "broken\n"
      )
      expect(checkpointRows[0]).toMatchObject({
        thread_id: threadId,
        turn_id: turn.turnId,
        checkpoint_ref: checkpointRef,
      })
      expect(checkpointRows[0]?.diff_content).toContain("-v1\n+broken")
      expect(turnDiffRows).toEqual([
        expect.objectContaining({
          thread_id: threadId,
          turn_index: 1,
          files_changed: 1,
          insertions: 1,
          deletions: 1,
        }),
      ])
      expect(runtimeErrorActivities).toHaveLength(2)
      expect(runtimeErrorActivities.at(-1)?.summary).toBe(
        "Provider runtime error"
      )
      expect(checkpointActivity?.payload).toMatchObject({
        status: "error",
        checkpointRef,
        baseCheckpointRef: baseRef,
        turn_id: turn.turnId,
      })
      expect(providerEvents.map((event) => event.event_type)).toEqual(
        expect.arrayContaining([
          "turn_error",
          "turn.diff.updated",
          "checkpoint.captured",
        ])
      )
      expect(logger.error).toHaveBeenCalledTimes(2)
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "turn_error" }),
        "event failed"
      )
      await hub.stopAll()
    } finally {
      stopCheckpointReactor()
      await checkpointReactor.stop()
      stopIngestion()
      db.close()
      fs.rmSync(rootDir, { recursive: true, force: true })
      fs.rmSync(workspaceDir, { recursive: true, force: true })
    }
  }, 30_000)

  it("reuses one provider session across multi-turn approval flow and persists both turn diffs", async () => {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-runtime-multi-")
    )
    const workspaceDir = createGitRepo()
    const db = openDatabase(path.join(rootDir, "test.sqlite"))
    runMigrations(db)
    const headBefore = runGit(workspaceDir, ["rev-parse", "HEAD"]).trim()
    const threadId = "thread-multi-turn-harness" as ThreadId
    const turn1BaseRef = checkpointRefForThreadTurn(threadId, 0)
    const turn1CheckpointRef = checkpointRefForThreadTurn(threadId, 1)
    const turn2BaseRef = checkpointRefForThreadTurn(threadId, 2)
    const turn2CheckpointRef = checkpointRefForThreadTurn(threadId, 3)
    const activities = new ThreadActivityProjectionQuery(db)
    const checkpointDiffs = new CheckpointDiffProjectionQuery(db)
    const threads = new ThreadService(db)
    const now = "2026-05-01T00:00:00.000Z"
    threads.upsertThreadMeta({
      thread_id: threadId,
      project_name: "Multi Turn Harness Project",
      title: "Multi Turn Harness Thread",
      project_path: workspaceDir,
      created_at: now,
      updated_at: now,
      codex_thread_id: null,
    })

    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const legacyBus = new ProviderEventBus()
    const checkpointReactor = new CheckpointReactor({
      eventBus: legacyBus,
      threads,
      logger,
    })
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: legacyBus,
      activityStore: activities,
      checkpointDiffStore: checkpointDiffs,
      broadcaster,
      logger,
      sequenceStart: 500,
      projectedSink: (event) => legacyBus.emitProjected(event),
    })
    const stopCheckpointReactor = checkpointReactor.start()
    const stopIngestion = ingestion.start()

    try {
      const harness = makeTestProviderAdapterHarness({
        provider: "codex" as ProviderKind,
      })
      const hub = new ProviderHub({
        instances: [
          {
            instanceId: "codex-work",
            driver: "codex",
            provider: "codex" as ProviderKind,
            displayName: "Codex Work",
            enabled: true,
            adapter: harness.adapter,
          },
        ],
        beforeTurn: (input) =>
          checkpointReactor.prepareTurn({
            event_type: "turn_started",
            thread_id: input.threadId,
            payload: {
              turn_id: input.turnId,
              dispatchTurnId: input.turnId,
              provider_kind: input.providerKind,
              provider_instance_id: input.providerInstanceId,
              ...(input.projectPath ? { project_path: input.projectPath } : {}),
            },
          }),
        afterTurn: async (event) => {
          const legacy = canonicalToLegacy(event)
          if (legacy) await checkpointReactor.finalizeTurn(legacy)
        },
      })
      hub.subscribe((event) => legacyBus.emitCanonical(event))

      harness.queueTurnResponseForNextSession({
        events: [
          { type: "turn.started", turnId: "turn-1" },
          {
            type: "item.started",
            turnId: "turn-1",
            itemId: "item-1",
            kind: "tool:exec_command",
            payload: { command: "printf v2 > README.md" },
          },
          {
            type: "item.completed",
            turnId: "turn-1",
            itemId: "item-1",
            kind: "tool:exec_command",
            payload: { status: "completed" },
          },
          {
            type: "content.delta",
            turnId: "turn-1",
            streamKind: "assistant_text",
            delta: "Applied the first edit.\n",
          },
          { type: "turn.completed", turnId: "turn-1", status: "completed" },
        ],
        mutateWorkspace: async ({ cwd }) => {
          await waitFor(
            () => hasCheckpointRef({ cwd, checkpointRef: turn1BaseRef }),
            (exists) => exists,
            "turn 1 baseline checkpoint ref"
          )
          fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8")
        },
      })

      const firstTurn = hub.startTurn("codex" as ProviderKind, {
        providerInstanceId: "codex-work",
        threadId,
        message: "turn 1",
        modelId: "gpt-5.5",
        history: [],
        projectPath: workspaceDir,
        reasoningEffort: "xhigh",
      })
      await firstTurn.completion
      await firstTurn.settled

      await waitFor(
        () => checkpointDiffs.listCheckpointDiffsByThread(threadId),
        (rows) => rows.length === 1,
        "first turn checkpoint diff"
      )

      harness.queueTurnResponse(threadId, {
        events: [
          { type: "turn.started", turnId: "turn-2" },
          {
            type: "request.opened",
            turnId: "turn-2",
            requestId: "approval-2",
            kind: "tool_approval",
            tool: "exec_command",
            input: { command: "printf v3 > README.md" },
          },
          {
            type: "request.resolved",
            turnId: "turn-2",
            requestId: "approval-2",
            decision: "approve",
          },
          {
            type: "tool.started",
            turnId: "turn-2",
            toolKind: "command",
            title: "Update README",
            detail: "printf v3 > README.md",
          },
          {
            type: "tool.completed",
            turnId: "turn-2",
            toolKind: "command",
            title: "Update README",
            detail: "printf v3 > README.md",
          },
          {
            type: "content.delta",
            turnId: "turn-2",
            streamKind: "assistant_text",
            delta: "Approval received and second edit applied.\n",
          },
          { type: "turn.completed", turnId: "turn-2", status: "completed" },
        ],
        mutateWorkspace: async ({ cwd }) => {
          await waitFor(
            () => hasCheckpointRef({ cwd, checkpointRef: turn2BaseRef }),
            (exists) => exists,
            "turn 2 baseline checkpoint ref"
          )
          fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8")
        },
      })

      const secondTurn = hub.startTurn("codex" as ProviderKind, {
        providerInstanceId: "codex-work",
        threadId,
        message: "turn 2 approval",
        modelId: "gpt-5.5",
        history: [],
        projectPath: workspaceDir,
        reasoningEffort: "xhigh",
      })
      await secondTurn.completion
      await secondTurn.settled
      await hub.respondToRequest(
        "codex" as ProviderKind,
        threadId,
        "approval-2" as ApprovalRequestId,
        {
          kind: "tool_approval",
          decision: "approve",
        } as ProviderApprovalDecision,
        "codex-work"
      )

      const checkpointRows = await waitFor(
        () => checkpointDiffs.listCheckpointDiffsByThread(threadId),
        (rows) => rows.length === 2,
        "two checkpoint diff rows"
      )
      const turnDiffRows = checkpointDiffs.listTurnDiffsByThread(threadId)
      const activityRows = activities.listByThread(threadId)
      const providerEvents = channelFrames(
        broadcaster.frames,
        "provider.runtimeEvent"
      ).map((frame) => (frame as { data: LegacyProviderRuntimeEvent }).data)

      expect(harness.getStartCount()).toBe(1)
      expect(harness.listActiveSessionIds()).toEqual([threadId])
      expect(
        harness.getSentTurns(threadId).map((turn) => turn.message)
      ).toEqual(["turn 1", "turn 2 approval"])
      expect(harness.getApprovalResponses(threadId)).toEqual([
        {
          requestId: "approval-2",
          decision: { kind: "tool_approval", decision: "approve" },
        },
      ])
      expect(
        await hasCheckpointRef({
          cwd: workspaceDir,
          checkpointRef: turn1BaseRef,
        })
      ).toBe(false)
      expect(
        await hasCheckpointRef({
          cwd: workspaceDir,
          checkpointRef: turn1CheckpointRef,
        })
      ).toBe(true)
      expect(
        await hasCheckpointRef({
          cwd: workspaceDir,
          checkpointRef: turn2BaseRef,
        })
      ).toBe(false)
      expect(
        await hasCheckpointRef({
          cwd: workspaceDir,
          checkpointRef: turn2CheckpointRef,
        })
      ).toBe(true)
      expect(runGit(workspaceDir, ["rev-parse", "HEAD"]).trim()).toBe(
        headBefore
      )
      expect(
        runGit(workspaceDir, ["show", `${turn1CheckpointRef}:README.md`])
      ).toBe("v2\n")
      expect(
        runGit(workspaceDir, ["show", `${turn2CheckpointRef}:README.md`])
      ).toBe("v3\n")
      expect(checkpointRows.map((row) => row.turn_id)).toEqual([
        firstTurn.turnId,
        secondTurn.turnId,
      ])
      expect(checkpointRows.map((row) => row.checkpoint_ref)).toEqual([
        turn1CheckpointRef,
        turn2CheckpointRef,
      ])
      expect(turnDiffRows).toEqual([
        expect.objectContaining({
          thread_id: threadId,
          turn_index: 1,
          files_changed: 1,
          insertions: 1,
          deletions: 1,
        }),
        expect.objectContaining({
          thread_id: threadId,
          turn_index: 2,
          files_changed: 1,
          insertions: 1,
          deletions: 1,
        }),
      ])
      expect(activityRows.map((activity) => activity.kind)).toEqual(
        expect.arrayContaining([
          "turn.started",
          "tool.started",
          "tool.completed",
          "approval.requested",
          "approval.resolved",
          "checkpoint.captured",
          "turn.completed",
        ])
      )
      expect(providerEvents.map((event) => event.event_type)).toEqual(
        expect.arrayContaining([
          "tool_call",
          "tool_result",
          "tool_approval_requested",
          "tool_approval_resolved",
          "turn.diff.updated",
        ])
      )
      expect(
        fs.readFileSync(path.join(workspaceDir, "README.md"), "utf8")
      ).toBe("v3\n")
      await expect(
        hub.rollbackConversation(
          "codex" as ProviderKind,
          threadId,
          1,
          "codex-work"
        )
      ).resolves.toBe(true)
      expect(harness.getRollbackCalls(threadId)).toEqual([1])
      expect(
        fs.readFileSync(path.join(workspaceDir, "README.md"), "utf8")
      ).toBe("v3\n")
      expect(logger.error).not.toHaveBeenCalled()
      await hub.stopAll()
    } finally {
      stopCheckpointReactor()
      await checkpointReactor.stop()
      stopIngestion()
      db.close()
      fs.rmSync(rootDir, { recursive: true, force: true })
      fs.rmSync(workspaceDir, { recursive: true, force: true })
    }
  }, 30_000)

  it("recovers claude sessions after adapter stopAll using persisted resume state", async () => {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-claude-recover-")
    )
    const db = openDatabase(path.join(rootDir, "test.sqlite"))
    runMigrations(db)
    const bindings = new ProviderSessionBindingStore(db)
    const activities = new ThreadActivityProjectionQuery(db)
    const threadId = "thread-claude-recover-harness" as ThreadId
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const legacyBus = new ProviderEventBus()
    const harness = makeTestProviderAdapterHarness({
      provider: "claude" as ProviderKind,
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-main",
          driver: "claude",
          provider: "claude" as ProviderKind,
          displayName: "Claude Main",
          enabled: true,
          adapter: harness.adapter,
        },
      ],
    })
    const stopHubEvents = hub.subscribe((event) =>
      legacyBus.emitCanonical(event)
    )
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: legacyBus,
      activityStore: activities,
      sessionLifecycleStore: bindings,
      broadcaster,
      logger,
      sequenceStart: 700,
    })
    const stopIngestion = ingestion.start()
    let restartedHub: ProviderHub | null = null

    try {
      harness.queueTurnResponseForNextSession({
        events: [
          { type: "turn.started", turnId: "turn-before-restart" },
          {
            type: "content.delta",
            turnId: "turn-before-restart",
            streamKind: "assistant_text",
            delta: "Turn before restart.\n",
          },
          {
            type: "turn.completed",
            turnId: "turn-before-restart",
            status: "completed",
          },
        ],
      })

      await hub.sendTurn(
        "claude" as ProviderKind,
        {
          providerInstanceId: "claude-main",
          threadId,
          message: "Before restart",
          modelId: "claude-opus-4-7",
          modelSelection: {
            instanceId: "claude-main",
            model: "claude-opus-4-7",
            options: [{ id: "effort", value: "max" }],
          },
          history: [],
          projectPath: "/repo",
          reasoningEffort: "max",
        },
        { bindings }
      )

      expect(harness.getStartCount()).toBe(1)
      expect(harness.listActiveSessionIds()).toEqual([threadId])
      expect(bindings.get(threadId, "claude-main")).toMatchObject({
        threadId,
        providerKind: "claude",
        providerInstanceId: "claude-main",
        providerThreadId: `claude-${threadId}`,
        cwd: "/repo",
        modelSelection: {
          instanceId: "claude-main",
          model: "claude-opus-4-7",
        },
      })

      hub.beginShutdown()
      stopHubEvents()
      await harness.adapter.stopAll()
      expect(harness.listActiveSessionIds()).toEqual([])

      const restartedHarness = makeTestProviderAdapterHarness({
        provider: "claude" as ProviderKind,
      })
      restartedHub = new ProviderHub({
        instances: [
          {
            instanceId: "claude-main",
            driver: "claude",
            provider: "claude" as ProviderKind,
            displayName: "Claude Main",
            enabled: true,
            adapter: restartedHarness.adapter,
          },
        ],
      })
      restartedHub.subscribe((event) => legacyBus.emitCanonical(event))

      restartedHarness.queueTurnResponseForNextSession({
        events: [
          { type: "turn.started", turnId: "turn-after-restart" },
          {
            type: "content.delta",
            turnId: "turn-after-restart",
            streamKind: "assistant_text",
            delta: "Turn after restart.\n",
          },
          {
            type: "turn.completed",
            turnId: "turn-after-restart",
            status: "completed",
          },
        ],
      })

      await restartedHub.sendTurn(
        "claude" as ProviderKind,
        {
          providerInstanceId: "claude-main",
          threadId,
          message: "After restart",
          modelId: "claude-opus-4-7",
          history: [],
        },
        { bindings }
      )

      const sentTurns = restartedHarness.getSentTurns(threadId)
      const providerEvents = channelFrames(
        broadcaster.frames,
        "provider.runtimeEvent"
      ).map((frame) => (frame as { data: LegacyProviderRuntimeEvent }).data)

      expect(harness.getStartCount() + restartedHarness.getStartCount()).toBe(2)
      expect(restartedHarness.listActiveSessionIds()).toEqual([threadId])
      expect(sentTurns).toHaveLength(1)
      expect(sentTurns[0]).toMatchObject({
        providerInstanceId: "claude-main",
        threadId,
        message: "After restart",
        projectPath: "/repo",
        modelSelection: {
          instanceId: "claude-main",
          model: "claude-opus-4-7",
          options: [{ id: "effort", value: "max" }],
        },
      })
      expect(bindings.get(threadId, "claude-main")).toMatchObject({
        status: "ready",
        activeTurnId: null,
        cwd: "/repo",
        modelSelection: {
          instanceId: "claude-main",
          model: "claude-opus-4-7",
        },
      })
      expect(providerEvents.map((event) => event.event_type)).toEqual(
        expect.arrayContaining([
          "turn_started",
          "content_delta",
          "turn_completed",
        ])
      )
      expect(
        activities
          .listByThread(threadId)
          .some(
            (activity) =>
              activity.kind === "turn.completed" &&
              activity.turn_id === "turn-after-restart"
          )
      ).toBe(true)
      expect(logger.error).not.toHaveBeenCalled()
    } finally {
      await Promise.allSettled([
        hub.stopAll(),
        restartedHub?.stopAll() ?? Promise.resolve(),
      ])
      stopIngestion()
      db.close()
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it("covers proposed-plan, user-input, context-usage and runtime-error event shapes", async () => {
    const activities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    const legacyBus = new ProviderEventBus()
    const harness = makeTestProviderAdapterHarness({
      provider: "claude" as ProviderKind,
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "claude-max",
          driver: "claude",
          provider: "claude" as ProviderKind,
          displayName: "Claude Max",
          enabled: true,
          adapter: harness.adapter,
        },
      ],
    })
    hub.subscribe((event) => legacyBus.emitCanonical(event))
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: legacyBus,
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster,
      logger,
      sequenceStart: 200,
    })
    const stopIngestion = ingestion.start()

    harness.queueTurnResponseForNextSession({
      events: [
        { type: "turn.started", turnId: "turn-plan" },
        {
          type: "turn.plan.updated",
          turnId: "turn-plan",
          payload: {
            explanation: "Implementation plan",
            plan: [{ step: "Scan provider pipeline", status: "completed" }],
          },
        },
        {
          type: "turn.proposed.delta",
          turnId: "turn-plan",
          payload: { delta: "# Plan\n" },
        },
        {
          type: "turn.proposed.completed",
          turnId: "turn-plan",
          payload: { planMarkdown: "# Plan\n- Scan provider pipeline" },
        },
        {
          type: "request.opened",
          turnId: "turn-plan",
          requestId: "question-1",
          kind: "user_input",
          questions: [
            {
              id: "scope",
              question: "Which scope?",
              options: ["Backend", "Frontend"],
            },
          ],
        },
        {
          type: "request.resolved",
          turnId: "turn-plan",
          requestId: "question-1",
          decision: "answer",
        },
        {
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: 120,
              inputTokens: 50,
              outputTokens: 70,
            },
          },
        },
        {
          type: "runtime.warning",
          turnId: "turn-plan",
          message: "provider got slow",
          willRetry: true,
          detail: { latencyMs: 1500 },
        },
        {
          type: "runtime.error",
          turnId: "turn-plan",
          message: "provider failed",
          class: "provider_error",
        },
      ],
    })

    await hub.sendTurn("claude" as ProviderKind, {
      providerInstanceId: "claude-max",
      threadId: "thread-plan",
      message: "Plan only",
      modelId: "claude-opus-4-7",
      history: [],
      reasoningEffort: "max",
    })
    stopIngestion()

    const providerEvents = channelFrames(
      broadcaster.frames,
      "provider.runtimeEvent"
    ).map((frame) => (frame as { data: LegacyProviderRuntimeEvent }).data)
    expect(providerEvents.map((event) => event.event_type)).toEqual([
      "session.started",
      "turn_started",
      "turn.plan.updated",
      "turn.proposed.delta",
      "turn.proposed.completed",
      "user_input_requested",
      "user_input_resolved",
      "thread.token-usage.updated",
      "turn_warning",
      "turn_error",
    ])
    expect(activities.map((activity) => activity.kind)).toEqual([
      "session.started",
      "turn.started",
      "turn.plan.updated",
      "turn.proposed.delta",
      "turn.proposed.completed",
      "user-input.requested",
      "user-input.resolved",
      "context-window.updated",
      "runtime.warning",
      "runtime.error",
    ])
    expect(activities[3]).toMatchObject({
      thread_id: "thread-plan",
      provider_instance_id: "claude-max",
      kind: "turn.proposed.delta",
      payload: expect.objectContaining({
        detail: "# Plan\n",
        providerKind: "claude",
        providerInstanceId: "claude-max",
      }),
    })
    expect(activities[5]).toMatchObject({
      turn_id: "turn-plan",
      kind: "user-input.requested",
      payload: expect.objectContaining({
        event_id: expect.any(String),
        turn_id: "turn-plan",
      }),
    })
    expect(activities[6]).toMatchObject({
      turn_id: "turn-plan",
      kind: "user-input.resolved",
      payload: expect.objectContaining({
        event_id: expect.any(String),
        turn_id: "turn-plan",
      }),
    })
    expect(activities[7]).toMatchObject({
      kind: "context-window.updated",
      payload: expect.objectContaining({
        usedTokens: 120,
        inputTokens: 50,
        outputTokens: 70,
      }),
    })
    expect(activities[8]).toMatchObject({
      turn_id: "turn-plan",
      kind: "runtime.warning",
      tone: "info",
      summary: "Provider runtime warning",
      payload: expect.objectContaining({
        event_id: expect.any(String),
        turn_id: "turn-plan",
        willRetry: true,
      }),
    })
    expect(activities[9]).toMatchObject({
      turn_id: "turn-plan",
      kind: "runtime.error",
      tone: "error",
      summary: "Provider runtime error",
      payload: expect.objectContaining({
        class: "provider_error",
        event_id: expect.any(String),
        turn_id: "turn-plan",
      }),
    })
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "turn_error" }),
      "event failed"
    )
  })
})

/**
 * The wiring after the bridge moved behind the journal: the hub publishes
 * canonical events on the bus, ingestion journals them as canonical rows,
 * the legacy stack still writes legacy rows, and the checkpoint reactor
 * observes only the post-journal lane.
 */
describe("ProviderHub canonical journaling through the bus", () => {
  function openJournalDb(label: string) {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `betterc0de-${label}-`)
    )
    const db = openDatabase(path.join(rootDir, "test.sqlite"))
    runMigrations(db)
    return { rootDir, db }
  }

  function makeCodexHub(threadId: ThreadId, bus: ProviderEventBus) {
    const harness = makeTestProviderAdapterHarness({
      provider: "codex" as ProviderKind,
    })
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex" as ProviderKind,
          displayName: "Codex Work",
          enabled: true,
          adapter: harness.adapter,
        },
      ],
    })
    const stopHubEvents = hub.subscribe((event) => bus.emitCanonical(event))
    harness.queueTurnResponseForNextSession({
      events: [
        { type: "turn.started", turnId: "turn-1" },
        { type: "message.delta", turnId: "turn-1", delta: "Working.\n" },
        {
          type: "tool.started",
          turnId: "turn-1",
          toolId: "tool-1",
          toolName: "exec_command",
          input: { command: "npm test" },
        },
        {
          type: "tool.completed",
          turnId: "turn-1",
          toolId: "tool-1",
          toolName: "exec_command",
          output: { stdout: "ok" },
        },
        { type: "turn.completed", turnId: "turn-1", status: "completed" },
      ],
    })
    const sendTurn = () =>
      hub.sendTurn("codex" as ProviderKind, {
        providerInstanceId: "codex-work",
        threadId,
        message: "Run tests",
        modelId: "gpt-5.5",
        history: [],
        projectPath: "/repo",
      })
    return { harness, hub, stopHubEvents, sendTurn }
  }

  function legacyStackTurn(threadId: string): LegacyProviderRuntimeEvent[] {
    // What the frozen in-process stack (`ProviderService` + `BaseProviderAdapter`)
    // emits on the raw lane for one API-key turn.
    return [
      {
        event_type: "turn_started",
        thread_id: threadId,
        payload: { turn_id: "legacy-turn-1", provider_kind: "openai" },
      },
      {
        event_type: "tool_call",
        thread_id: threadId,
        payload: {
          tool_id: "legacy-tool-1",
          tool_name: "read_file",
          input: { path: "a.ts" },
        },
      },
      {
        event_type: "tool_result",
        thread_id: threadId,
        payload: {
          tool_id: "legacy-tool-1",
          tool_name: "read_file",
          output: "x",
        },
      },
      {
        event_type: "turn_completed",
        thread_id: threadId,
        payload: { turn_id: "legacy-turn-1", status: "completed" },
      },
    ]
  }

  function withoutCreatedAt(
    activities: ReadonlyArray<ThreadActivityProjection>
  ) {
    return activities.map(({ created_at: _createdAt, ...rest }) => rest)
  }

  it("journals a hub turn as schema 3 rows and a legacy-stack turn as schema 2 rows, and a restart replays both to the same activities", async () => {
    const { db } = openJournalDb("canonical-rows")
    const events = new EventStore(db)
    const receipts = new ProviderRuntimeProjectionReceiptStore(db)
    const journal = new ProviderRuntimeEventJournal(events)
    const threadId = "thread-canonical-rows" as ThreadId
    const legacyThreadId = "thread-legacy-rows"
    const bus = new ProviderEventBus()
    const liveActivities: ThreadActivityProjection[] = []
    const broadcaster = makeBroadcaster()
    const logger = makeLogger()
    // Live: no receipts, so the restart below sees every row as unprojected.
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: bus,
      eventJournal: journal,
      activityStore: {
        upsert: (activity) => liveActivities.push(structuredClone(activity)),
      },
      broadcaster,
      logger,
      sequenceStart: 900,
    })
    const stopIngestion = ingestion.start()
    const { hub, stopHubEvents, sendTurn } = makeCodexHub(threadId, bus)

    await sendTurn()
    for (const event of legacyStackTurn(legacyThreadId)) bus.emitEvent(event)
    stopHubEvents()
    stopIngestion()
    await hub.stopAll()

    const rows = db
      .prepare(
        `SELECT stream_id, event_type, metadata_json FROM orchestration_events
         WHERE aggregate_kind = 'provider_runtime' ORDER BY sequence`
      )
      .all() as Array<{
      stream_id: string
      event_type: string
      metadata_json: string
    }>
    const hubRows = rows.filter((row) => row.stream_id === threadId)
    const legacyRows = rows.filter((row) => row.stream_id === legacyThreadId)
    expect(hubRows.map((row) => row.event_type)).toEqual([
      "ProviderRuntime:session.started",
      "ProviderRuntime:turn.started",
      "ProviderRuntime:message.delta",
      "ProviderRuntime:tool.started",
      "ProviderRuntime:tool.completed",
      "ProviderRuntime:turn.completed",
    ])
    for (const row of hubRows) {
      expect(JSON.parse(row.metadata_json)).toMatchObject({ schema: 3 })
    }
    expect(legacyRows.map((row) => row.event_type)).toEqual([
      "ProviderRuntime:turn_started",
      "ProviderRuntime:tool_call",
      "ProviderRuntime:tool_result",
      "ProviderRuntime:turn_completed",
    ])
    for (const row of legacyRows) {
      expect(JSON.parse(row.metadata_json)).toMatchObject({ schema: 2 })
    }
    expect(liveActivities.map((activity) => activity.kind)).toEqual([
      "session.started",
      "turn.started",
      "tool.started",
      "tool.completed",
      "turn.completed",
      "turn.started",
      "tool.started",
      "tool.completed",
      "turn.completed",
    ])

    // Restart: a fresh ingestion replays every row, both shapes, into the
    // same activities the live run produced.
    const replayedActivities: ThreadActivityProjection[] = []
    const restarted = new ProviderRuntimeIngestion({
      eventBus: new ProviderEventBus(),
      eventJournal: journal,
      projectionReceipts: receipts,
      activityStore: {
        upsert: (activity) =>
          replayedActivities.push(structuredClone(activity)),
      },
      broadcaster: makeBroadcaster(),
      logger,
      sequenceStart: 900,
    })
    expect(
      new ProviderRuntimeJournalReplayer(
        events,
        receipts,
        restarted,
        logger
      ).replayAll()
    ).toEqual({ replayed: rows.length, discarded: 0, blocked: null })
    expect(withoutCreatedAt(replayedActivities)).toEqual(
      withoutCreatedAt(liveActivities)
    )
    expect(logger.error).not.toHaveBeenCalled()
    db.close()
  })

  it("journals each hub event exactly once, before the reactor lane observes it", async () => {
    const { db } = openJournalDb("journal-before-reactor")
    const events = new EventStore(db)
    const journal = new ProviderRuntimeEventJournal(events)
    const threadId = "thread-journal-order" as ThreadId
    const bus = new ProviderEventBus()
    const trace: string[] = []
    const append = vi.spyOn(events, "append")
    append.mockImplementation((rows) => {
      trace.push(`append:${rows[0]!.event_type}`)
      return EventStore.prototype.append.call(events, rows)
    })
    // Stand-in for the checkpoint reactor: the only lane it listens on.
    bus.on("projected", (event: LegacyProviderRuntimeEvent) => {
      trace.push(`projected:${event.event_type}`)
    })
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: bus,
      eventJournal: journal,
      projectionReceipts: new ProviderRuntimeProjectionReceiptStore(db),
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger: makeLogger(),
      sequenceStart: 1_000,
      projectedSink: (event) => bus.emitProjected(event),
    })
    const stopIngestion = ingestion.start()
    const { hub, stopHubEvents, sendTurn } = makeCodexHub(threadId, bus)

    await sendTurn()
    stopHubEvents()
    stopIngestion()
    await hub.stopAll()

    expect(trace).toEqual([
      "append:ProviderRuntime:session.started",
      "projected:session.started",
      "append:ProviderRuntime:turn.started",
      "projected:turn_started",
      "append:ProviderRuntime:message.delta",
      "projected:content_delta",
      "append:ProviderRuntime:tool.started",
      "projected:tool_call",
      "append:ProviderRuntime:tool.completed",
      "projected:tool_result",
      "append:ProviderRuntime:turn.completed",
      "projected:turn_completed",
    ])
    // Exactly once: six hub events, six appends, no loop between the lanes.
    expect(append).toHaveBeenCalledTimes(6)
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_kind = 'provider_runtime'"
        )
        .get()
    ).toEqual({ count: 6 })
    db.close()
  })

  it("journals the turn.aborted and session.exited the hub emits for a session still active at shutdown, when the hub stops before ingestion", async () => {
    // The order `runGracefulShutdown` uses: `providerHub.stopAll()` first,
    // so the terminals the hub itself emits for an open turn go through a
    // live ingestion, then `ingestion.stop()` spools whatever is queued. The
    // other way round the hub would emit into an unsubscribed bus and the
    // journal would show a turn that never ended.
    const { db } = openJournalDb("shutdown-order")
    const events = new EventStore(db)
    const receipts = new ProviderRuntimeProjectionReceiptStore(db)
    const journal = new ProviderRuntimeEventJournal(events)
    const threadId = "thread-open-at-shutdown" as ThreadId
    const bus = new ProviderEventBus()
    const activities: ThreadActivityProjection[] = []
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: bus,
      eventJournal: journal,
      projectionReceipts: receipts,
      activityStore: {
        upsert: (activity) => activities.push(structuredClone(activity)),
      },
      broadcaster: makeBroadcaster(),
      logger,
      sequenceStart: 3_000,
    })
    ingestion.start()

    // A native-style adapter: `turn.started`, then the process goes quiet.
    // No terminal arrives until the hub interrupts or stops it, which is
    // exactly the state a turn is in when the user quits mid-run.
    const harness = makeTestProviderAdapterHarness({
      provider: "codex" as ProviderKind,
    })
    const listeners = new Set<
      (
        event: Parameters<Parameters<typeof harness.adapter.subscribe>[0]>[0]
      ) => void
    >()
    const openTurnAdapter: typeof harness.adapter = {
      ...harness.adapter,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      sendTurn: async (input) => {
        for (const listener of listeners) {
          listener({
            threadId: input.threadId,
            providerKind: "codex" as ProviderKind,
            providerInstanceId: "codex-work",
            eventId: "open-turn-started",
            at: 1_777_000_000_001,
            type: "turn.started",
            turnId: "turn-open",
            payload: { dispatchTurnId: input.dispatchTurnId },
          })
        }
      },
      listSessions: async () => [
        {
          threadId,
          providerThreadId: "codex-thread-open",
          status: "running",
          cwd: null,
          activeTurnId: "turn-open",
          createdAt: 1_777_000_000_000,
          updatedAt: 1_777_000_000_001,
        },
      ],
      hasSession: () => true,
      interruptTurn: async () => {},
      stopAll: async () => {},
    }
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "codex-work",
          driver: "codex",
          provider: "codex" as ProviderKind,
          displayName: "Codex Work",
          enabled: true,
          adapter: openTurnAdapter,
        },
      ],
    })
    const stopHubEvents = hub.subscribe((event) => bus.emitCanonical(event))
    await hub.sendTurn("codex" as ProviderKind, {
      providerInstanceId: "codex-work",
      threadId,
      message: "Run tests",
      modelId: "gpt-5.5",
      history: [],
      projectPath: "/repo",
    })
    expect(activities.map((activity) => activity.kind)).toEqual([
      "turn.started",
    ])

    await hub.stopAll()
    stopHubEvents()
    expect(() => ingestion.stop()).not.toThrow()

    const rows = db
      .prepare(
        `SELECT event_type, stream_version, payload_json FROM orchestration_events
         WHERE aggregate_kind = 'provider_runtime' AND stream_id = ? ORDER BY sequence`
      )
      .all(threadId) as Array<{
      event_type: string
      stream_version: number
      payload_json: string
    }>
    expect(rows.map((row) => row.event_type)).toEqual([
      "ProviderRuntime:turn.started",
      "ProviderRuntime:turn.aborted",
      "ProviderRuntime:session.exited",
    ])
    const [, aborted, exited] = rows.map(
      (row) => JSON.parse(row.payload_json) as Record<string, unknown>
    )
    expect(aborted).toMatchObject({
      type: "turn.aborted",
      turnId: "turn-open",
      payload: {
        reason: "provider.stopAll",
        status: "interrupted",
        dispatchTurnId: expect.any(String),
      },
    })
    expect(exited).toMatchObject({
      type: "session.exited",
      payload: { reason: "provider.stopAll", exitKind: "graceful" },
    })
    // Every row projected and receipted live; nothing was left for replay.
    expect(activities.map((activity) => activity.kind)).toEqual([
      "turn.started",
      "turn.aborted",
      "session.exited",
    ])
    for (const row of rows) {
      expect(
        receipts.get(
          events.readProviderRuntimeByStreamVersion(
            threadId,
            row.stream_version
          )[0]!.sequence
        )
      ).toMatchObject({ status: "projected" })
    }
    expect(events.readUnprojectedProviderRuntimeEvents(10)).toEqual([])
    expect(logger.error).not.toHaveBeenCalled()
    db.close()
  })

  it("spools queued canonical hub events on shutdown and replays them into schema 3 rows on the next start", async () => {
    const { rootDir, db } = openJournalDb("spool-canonical")
    const events = new EventStore(db)
    const receipts = new ProviderRuntimeProjectionReceiptStore(db)
    const recoveryStore = new ProviderRuntimeJournalRecoveryStore(
      path.join(rootDir, "spool"),
      { logger: makeLogger() }
    )
    const threadId = "thread-spool-canonical" as ThreadId
    const bus = new ProviderEventBus()
    const logger = makeLogger()
    const ingestion = new ProviderRuntimeIngestion({
      eventBus: bus,
      eventJournal: {
        persist: () => {
          throw new Error("database remains locked")
        },
      },
      journalRecoveryStore: recoveryStore,
      activityStore: { upsert: vi.fn() },
      broadcaster: makeBroadcaster(),
      logger,
      sequenceStart: 2_000,
      journalRetryBaseMs: 60_000,
      journalRetryMaxMs: 60_000,
    })
    const stopIngestion = ingestion.start()
    const { hub, stopHubEvents, sendTurn } = makeCodexHub(threadId, bus)

    await sendTurn()
    stopHubEvents()
    stopIngestion()
    // Graceful shutdown with the journal still locked: every queued
    // canonical entry goes to the filesystem spool.
    expect(() => ingestion.stop()).not.toThrow()
    await hub.stopAll()
    expect(recoveryStore.pendingCount()).toBe(6)

    // Next start: the spool commits into the real journal as canonical rows,
    // then the replayer projects them.
    const journal = new ProviderRuntimeEventJournal(events)
    expect(recoveryStore.replay(journal)).toEqual({
      replayed: 6,
      quarantined: 0,
      pending: 0,
    })
    const rows = db
      .prepare(
        `SELECT event_type, stream_version, metadata_json FROM orchestration_events
         WHERE aggregate_kind = 'provider_runtime' ORDER BY sequence`
      )
      .all() as Array<{
      event_type: string
      stream_version: number
      metadata_json: string
    }>
    expect(rows.map((row) => [row.event_type, row.stream_version])).toEqual([
      ["ProviderRuntime:session.started", 2_001],
      ["ProviderRuntime:turn.started", 2_002],
      ["ProviderRuntime:message.delta", 2_003],
      ["ProviderRuntime:tool.started", 2_004],
      ["ProviderRuntime:tool.completed", 2_005],
      ["ProviderRuntime:turn.completed", 2_006],
    ])
    for (const row of rows) {
      expect(JSON.parse(row.metadata_json)).toMatchObject({ schema: 3 })
    }
    const activities: ThreadActivityProjection[] = []
    const restarted = new ProviderRuntimeIngestion({
      eventBus: new ProviderEventBus(),
      eventJournal: journal,
      projectionReceipts: receipts,
      activityStore: { upsert: (activity) => activities.push(activity) },
      broadcaster: makeBroadcaster(),
      logger,
      sequenceStart: 2_000,
    })
    expect(
      new ProviderRuntimeJournalReplayer(
        events,
        receipts,
        restarted,
        logger
      ).replayAll()
    ).toEqual({ replayed: 6, discarded: 0, blocked: null })
    expect(
      activities.map((activity) => [activity.kind, activity.sequence])
    ).toEqual([
      ["session.started", 2_001],
      ["turn.started", 2_002],
      ["tool.started", 2_004],
      ["tool.completed", 2_005],
      ["turn.completed", 2_006],
    ])
    db.close()
  })
})
