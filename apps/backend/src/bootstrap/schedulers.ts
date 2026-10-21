import { logger } from "../observability/logger"
import { incrementalVacuum } from "../persistence/db"
import { ProviderSessionReaper } from "../provider/runtime"
import { ThreadRetentionScheduler } from "../services/thread-retention"
import { threadGoals } from "../services/chat/goal-registry"
import { threadAutonomyRuns } from "../services/chat/autonomy-registry"
import { stopAllToolOutputArchiveStores } from "../services/tool-output-archive-store"
import { PullRequestWatcher } from "../services/github-pull-request-watch"
import { startAutomations } from "../services/automations/registry"
import { chatResumes } from "../services/chat/resume-registry"
import {
  nonNegativeEnvCount,
  positiveEnvInteger,
  positiveEnvMs,
  readTuningEnv,
} from "./env"
import type {
  BootRoot,
  PersistenceContext,
  ProvidersContext,
  RetentionContext,
  SettingsContext,
  TimersContext,
} from "./context"

/**
 * Phase 6: the thread retention scheduler plus the tool-output archive
 * cleanup step. Split from `startTimers` only so the HTTP app can be built
 * between the two, exactly where it was built before.
 */
export function startRetention(
  root: BootRoot,
  persistence: PersistenceContext,
  settingsCtx: SettingsContext,
  providersCtx: ProvidersContext
): RetentionContext {
  const { startupCleanup } = root
  const { threads } = persistence
  const { transcriptRecoveryStore } = settingsCtx
  const {
    worktrees,
    threadTurnCoordinator,
    providerHub,
    providers,
    providerEventLoggers,
    checkpointReactor,
    checkpointReverts,
  } = providersCtx
  const threadRetention = new ThreadRetentionScheduler(
    {
      terminalPtys: root.terminalPtys,
      shellSessions: root.shellSessions,
      workspaceRecoveryGate: root.workspaceRecoveryGate,
      orchestrator: providersCtx.state.orchestrator,
      threads,
      worktrees,
      threadTurnCoordinator,
      providerHub,
      providers,
      providerEventLoggers,
      transcriptRecoveryStore,
      checkpointReactor,
      checkpointReverts,
      // A purged chat's turn schedulers: its goal, its Autonomous Work run
      // and its resume after a limit or a restart.
      forgetThreadGoal: (threadId) => {
        threadGoals.get(providersCtx.state)?.forgetThread(threadId)
        threadAutonomyRuns.get(providersCtx.state)?.forgetThread(threadId)
        chatResumes.get(providersCtx.state)?.forgetThread(threadId)
      },
    },
    {
      archiveAfterDays: positiveEnvInteger(
        "BETTERC0DE_THREAD_ARCHIVE_AFTER_DAYS"
      ),
      purgeAfterArchiveDays: positiveEnvInteger(
        "BETTERC0DE_THREAD_PURGE_AFTER_ARCHIVE_DAYS"
      ),
      batchSize: positiveEnvInteger("BETTERC0DE_THREAD_RETENTION_BATCH_SIZE"),
      intervalMs: positiveEnvInteger("BETTERC0DE_THREAD_RETENTION_INTERVAL_MS"),
    }
  )
  startupCleanup.push({
    name: "thread retention scheduler",
    run: () => threadRetention.stop(),
  })
  threadRetention.start()

  startupCleanup.push({
    name: "tool output archive stores",
    run: stopAllToolOutputArchiveStores,
  })
  return { threadRetention }
}

/**
 * Phase 8: background timers — periodic transcript recovery replay, the
 * provider session reaper (opt-out via `BETTERC0DE_PROVIDER_SESSION_REAPER=0`)
 * and the optional incremental vacuum. All unref'd; none keeps the process
 * alive on its own.
 */
export function startTimers(
  root: BootRoot,
  persistence: PersistenceContext,
  settingsCtx: SettingsContext,
  providersCtx: ProvidersContext
): TimersContext {
  const { startupCleanup } = root
  const { db, providerSessionBindings } = persistence
  const { transcriptRecoveryStore, transcriptRecoveryTarget } = settingsCtx
  const { providerHub } = providersCtx
  const transcriptRecoveryTimer = setInterval(() => {
    transcriptRecoveryStore.replay(transcriptRecoveryTarget, {
      maxRecords: 32,
    })
  }, 5_000)
  transcriptRecoveryTimer.unref?.()
  startupCleanup.push({
    name: "transcript recovery timer",
    run: () => clearInterval(transcriptRecoveryTimer),
  })

  const providerSessionReaper =
    process.env.BETTERC0DE_PROVIDER_SESSION_REAPER === "0"
      ? null
      : new ProviderSessionReaper({
          bindings: providerSessionBindings,
          providerHub,
          logger,
          inactivityThresholdMs: positiveEnvMs(
            "BETTERC0DE_PROVIDER_SESSION_REAPER_INACTIVITY_MS"
          ),
          sweepIntervalMs: positiveEnvMs(
            "BETTERC0DE_PROVIDER_SESSION_REAPER_SWEEP_MS"
          ),
          // Idle sessions kept warm per provider instance; 0 keeps none and
          // "unlimited" removes the cap.
          maxIdleSessionsPerInstance: readTuningEnv(
            "BETTERC0DE_PROVIDER_MAX_IDLE_SESSIONS",
            nonNegativeEnvCount,
            (name) =>
              logger.warn(
                { name },
                "Ignoring an invalid environment setting; the default applies"
              )
          ),
        })
  providerSessionReaper?.start()
  startupCleanup.push({
    name: "provider session reaper",
    run: () => providerSessionReaper?.stop(),
  })

  // Optional background maintenance: reclaim deleted pages from the event
  // store + projection tables so the file doesn't grow without bound after
  // heavy churn.  Opt-in via env var; typical cadence is 15-30 minutes.
  // A zero or missing value disables the timer entirely so the default
  // behaviour stays identical to before this change.
  const vacuumIntervalMs = Number(
    process.env.BETTERC0DE_VACUUM_INTERVAL_MS ?? 0
  )
  const vacuumTimer =
    Number.isFinite(vacuumIntervalMs) && vacuumIntervalMs > 0
      ? // Node reduces an overflowing timer delay to 1ms, which would turn a
        // long maintenance cadence into a synchronous database hot loop.
        setInterval(
          () => incrementalVacuum(db),
          Math.min(vacuumIntervalMs, 2_147_483_647)
        )
      : null
  if (vacuumTimer?.unref) vacuumTimer.unref()
  startupCleanup.push({
    name: "vacuum timer",
    run: () => {
      if (vacuumTimer) clearInterval(vacuumTimer)
    },
  })

  // Pull request wake-ups (services/github-pull-request-watch): the chats
  // that asked for them are checked at the sidebar's two-minute pull request
  // cadence. Its timer is unref'd and reads the state only when it fires.
  const pullRequestWatcher = new PullRequestWatcher(providersCtx.state)
  pullRequestWatcher.start()
  startupCleanup.push({
    name: "pull request watcher",
    run: () => pullRequestWatcher.stop(),
  })

  // Automations (services/automations): one unref'd timer that wakes for the
  // next scheduled run, plus the runs webhooks and "Run now" start. The
  // graceful shutdown stops it early, with the goal and Autonomous Work
  // schedulers.
  const stopAutomations = startAutomations(providersCtx.state)
  startupCleanup.push({ name: "automations", run: stopAutomations })
  return {
    transcriptRecoveryTimer,
    providerSessionReaper,
    vacuumTimer,
    pullRequestWatcher,
  }
}
