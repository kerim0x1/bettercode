import type { CheckpointReactor } from "../checkpointing/CheckpointReactor"
import { logger } from "../observability/logger"
import {
  cancelPendingApprovals,
  forgetSessionPermission,
} from "../provider/permissions"
import { clearSessionRules } from "../provider/session-permission-rules"
import type { ThreadTurnCoordinator } from "../provider/threadTurnCoordinator"
import type { EventNdjsonLogger, ProviderHub } from "../provider/runtime"
import type { AssistantTranscriptRecoveryStore } from "../provider/runtime/AssistantTranscriptRecoveryStore"
import type { ThreadService } from "./threads"
import type { CheckpointRevertOperationStore } from "./checkpoint-revert-operations"
import type { WorktreeManager } from "./worktree"
import { deleteThreadCheckpointRefs } from "./git"
import type { TerminalPtyService } from "./terminalPty"
import type { ShellSessionService } from "./shell"
import { withExclusiveWorkspaceMaintenance } from "./workspace-exclusive-maintenance"
import type { WorkspaceRecoveryGate } from "./workspace-recovery-gate"

export interface ThreadRetentionOptions {
  readonly archiveAfterDays?: number
  readonly purgeAfterArchiveDays?: number
  readonly batchSize?: number
  readonly intervalMs?: number
}

interface ThreadRetentionDependencies {
  /** Ends a purged thread's terminals before its workspace is removed. */
  readonly terminalPtys: Pick<TerminalPtyService, "shutdownForWorkspace">
  /** Ends a purged thread's shell commands before its workspace is removed. */
  readonly shellSessions: Pick<ShellSessionService, "closeSessionsForWorkspace">
  /** The instance's recovery gate a purge holds its exclusive barrier on. */
  readonly workspaceRecoveryGate: Pick<
    WorkspaceRecoveryGate,
    "acquireExclusiveAfterQuiesce"
  >
  readonly forgetThreadGoal?: (threadId: string) => void
  readonly orchestrator?: Pick<
    import("./orchestrator/service").OrchestratorService,
    "quiesceThread" | "forgetThread"
  >
  readonly threads: Pick<
    ThreadService,
    | "archiveOldThreads"
    | "purgeArchivedOlderThan"
    | "getThreadProjectPath"
    | "delete"
  >
  readonly worktrees: Pick<WorktreeManager, "findForThread" | "removeForThread">
  readonly threadTurnCoordinator: Pick<ThreadTurnCoordinator, "withTeardown">
  readonly providerHub: Pick<ProviderHub, "withThreadTeardown">
  /** The direct-API (legacy) provider stack's per-thread teardown. */
  readonly providers: {
    withThreadTeardown<T>(
      threadId: string,
      operation: () => Promise<T> | T
    ): Promise<T>
    forgetThread(threadId: string): void
  }
  readonly providerEventLoggers: readonly Pick<
    EventNdjsonLogger,
    "removeThread"
  >[]
  readonly transcriptRecoveryStore?: Pick<
    AssistantTranscriptRecoveryStore,
    "removeThread"
  >
  readonly checkpointReactor: Pick<CheckpointReactor, "forgetThread">
  readonly checkpointReverts?: Pick<
    CheckpointRevertOperationStore,
    "blockingThreadForCwd" | "hasBlockingRecovery"
  >
  readonly deleteThreadCheckpointRefs?: (
    cwd: string,
    threadId: string
  ) => Promise<number>
}

export interface ThreadRetentionRunResult {
  readonly archived: number
  readonly purged: number
  readonly failed: number
}

const DEFAULT_ARCHIVE_AFTER_DAYS = 30
const DEFAULT_PURGE_AFTER_ARCHIVE_DAYS = 30
const DEFAULT_BATCH_SIZE = 50
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000
// Node clamps larger timer delays to 1 ms, which would turn retention into a
// tight loop when the environment requests a monthly interval.
const MAX_TIMER_INTERVAL_MS = 2 ** 31 - 1

/**
 * Periodically retires inactive threads through the same teardown gates as
 * the explicit DELETE route. The database row is deliberately deleted last,
 * so any external-resource failure leaves an archived candidate for retry.
 */
export class ThreadRetentionScheduler {
  private readonly archiveAfterDays: number
  private readonly purgeAfterArchiveDays: number
  private readonly batchSize: number
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | null = null
  private activeRun: Promise<ThreadRetentionRunResult> | null = null
  private stopped = false

  constructor(
    private readonly dependencies: ThreadRetentionDependencies,
    options: ThreadRetentionOptions = {}
  ) {
    this.archiveAfterDays = boundedInteger(
      options.archiveAfterDays,
      DEFAULT_ARCHIVE_AFTER_DAYS,
      1,
      3_650
    )
    this.purgeAfterArchiveDays = boundedInteger(
      options.purgeAfterArchiveDays,
      DEFAULT_PURGE_AFTER_ARCHIVE_DAYS,
      1,
      3_650
    )
    this.batchSize = boundedInteger(
      options.batchSize,
      DEFAULT_BATCH_SIZE,
      1,
      500
    )
    this.intervalMs = boundedInteger(
      options.intervalMs,
      DEFAULT_INTERVAL_MS,
      60_000,
      MAX_TIMER_INTERVAL_MS
    )
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => {
      void this.runNow()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.activeRun
  }

  runNow(): Promise<ThreadRetentionRunResult> {
    if (this.stopped) {
      return Promise.resolve({ archived: 0, purged: 0, failed: 0 })
    }
    if (this.activeRun) return this.activeRun

    const run = this.execute().finally(() => {
      if (this.activeRun === run) this.activeRun = null
    })
    this.activeRun = run
    return run
  }

  private async execute(): Promise<ThreadRetentionRunResult> {
    let archived = 0
    try {
      archived = this.dependencies.threads.archiveOldThreads(
        this.archiveAfterDays
      )
    } catch (error) {
      logger.error({ err: error }, "thread retention archive pass failed")
      return { archived: 0, purged: 0, failed: 1 }
    }

    let candidates: string[]
    try {
      candidates = this.dependencies.threads.purgeArchivedOlderThan(
        this.purgeAfterArchiveDays,
        this.batchSize
      )
    } catch (error) {
      logger.error({ err: error }, "thread retention candidate query failed")
      return { archived, purged: 0, failed: 1 }
    }

    let purged = 0
    let failed = 0
    for (const threadId of candidates) {
      if (this.stopped) break
      try {
        if (await this.purgeThread(threadId)) purged += 1
      } catch (error) {
        failed += 1
        logger.warn(
          { err: error, threadId },
          "thread retention teardown failed; archived row retained for retry"
        )
      }
    }
    if (archived > 0 || purged > 0 || failed > 0) {
      logger.info(
        { archived, purged, failed },
        "thread retention pass completed"
      )
    }
    return { archived, purged, failed }
  }

  private async purgeThread(threadId: string): Promise<boolean> {
    const { dependencies } = this
    await dependencies.orchestrator?.quiesceThread(threadId)
    return dependencies.threadTurnCoordinator.withTeardown(threadId, () =>
      dependencies.providerHub.withThreadTeardown(threadId, () =>
        dependencies.providers.withThreadTeardown(threadId, async () => {
          const projectPath =
            dependencies.threads.getThreadProjectPath(threadId)
          const worktree = dependencies.worktrees.findForThread(threadId)
          const workspaces = [
            projectPath,
            worktree?.base_repo_path,
            worktree?.worktree_path,
          ].filter(
            (workspace): workspace is string =>
              typeof workspace === "string" && workspace.trim().length > 0
          )
          const purge = async (): Promise<boolean> => {
            if (dependencies.checkpointReverts?.hasBlockingRecovery(threadId)) {
              return false
            }
            if (
              workspaces.some(
                (workspace) =>
                  dependencies.checkpointReverts?.blockingThreadForCwd(
                    workspace
                  ) != null
              )
            ) {
              return false
            }
            await dependencies.checkpointReactor.forgetThread(threadId)
            if (projectPath) {
              await (
                dependencies.deleteThreadCheckpointRefs ??
                deleteThreadCheckpointRefs
              )(projectPath, threadId)
            }
            await dependencies.worktrees.removeForThread(threadId, {
              force: true,
              deleteBranch: false,
            })
            await Promise.all(
              dependencies.providerEventLoggers.map((eventLogger) =>
                eventLogger.removeThread(threadId)
              )
            )
            dependencies.transcriptRecoveryStore?.removeThread(threadId)
            cancelPendingApprovals(threadId)
            forgetSessionPermission(threadId)
            clearSessionRules(threadId)
            dependencies.providers.forgetThread(threadId)
            dependencies.forgetThreadGoal?.(threadId)
            dependencies.threads.delete(threadId)
            dependencies.orchestrator?.forgetThread(threadId)
            return true
          }
          return workspaces.length > 0
            ? withExclusiveWorkspaceMaintenance(dependencies, workspaces, purge)
            : purge()
        })
      )
    )
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value)) return fallback
  return Math.min(Math.max(value!, minimum), maximum)
}
