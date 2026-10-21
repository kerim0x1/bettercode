import { logger } from "../observability/logger"
import { ProviderRuntimeEventJournal } from "../provider/runtime/ProviderRuntimeEventJournal"
import {
  ProviderRuntimeJournalReplayer,
  providerRuntimeJournalRecoveryBlocksStartup,
} from "../provider/runtime"
import { initializeThreadGoals } from "../services/chat/goal-runtime"
import { initializeThreadAutonomy } from "../services/chat/autonomy-runtime"
import { initializeChatResume } from "../services/chat/resume-runtime"
import { ProviderRuntimeIngestion } from "../provider/runtime/ProviderRuntimeIngestion"
import { recoverPendingCheckpointReverts } from "../services/checkpoint-revert-saga"
import { withCheckpointRecoveryMutation } from "../http/checkpointRecoveryFence"
import { recoverChatDispatchesAfterRestart } from "../services/chat-dispatch-store"
import type { WsHub } from "../ws/server"
import type {
  BootRoot,
  PersistenceContext,
  ProvidersContext,
  RecoveryContext,
  SettingsContext,
} from "./context"

/**
 * Phase 5a: the provider runtime journal. Replays the filesystem spool into
 * the journal, wires ingestion (journal-first projection) and starts the
 * checkpoint reactor behind it, replays journaled events, then normalises
 * dispatch and session lifecycle state that a crash may have left running.
 * Needs the hub because ingestion broadcasts what it projects.
 */
export function recoverProviderRuntime(
  root: BootRoot,
  persistence: PersistenceContext,
  settingsCtx: SettingsContext,
  providers: ProvidersContext,
  hub: WsHub
): RecoveryContext {
  const { startupCleanup, eventBus } = root
  const { taintBackend } = root.taint
  const {
    eventStore,
    checkpointDiffs,
    threadActivities,
    providerSessionBindings,
    providerRuntimeProjectionReceipts,
    providerRuntimeJournalRecoveryStore,
    threads,
    chatDispatches,
  } = persistence
  const { settings, transcriptRecoveryStore } = settingsCtx
  const { sourceProposedPlanImplementations, checkpointReactor } = providers
  const providerRuntimeEventJournal = new ProviderRuntimeEventJournal(
    eventStore
  )
  const providerRuntimeSpoolReplay = providerRuntimeJournalRecoveryStore.replay(
    providerRuntimeEventJournal
  )
  if (
    providerRuntimeSpoolReplay.replayed > 0 ||
    providerRuntimeSpoolReplay.quarantined > 0 ||
    providerRuntimeSpoolReplay.pending > 0
  ) {
    logger.info(
      { ...providerRuntimeSpoolReplay },
      "provider runtime journal filesystem recovery completed"
    )
  }
  if (providerRuntimeJournalRecoveryBlocksStartup(providerRuntimeSpoolReplay)) {
    throw new Error(
      `Provider runtime journal recovery is blocked by ${providerRuntimeSpoolReplay.pending} pending and ${providerRuntimeSpoolReplay.quarantined} quarantined record(s).`
    )
  }

  const providerRuntimeIngestion = new ProviderRuntimeIngestion({
    eventBus,
    eventJournal: providerRuntimeEventJournal,
    journalRecoveryStore: providerRuntimeJournalRecoveryStore,
    projectionReceipts: providerRuntimeProjectionReceipts,
    chatDispatchLifecycleStore: chatDispatches,
    shouldPersistConversations: () =>
      settings.get().auto_save_conversations !== false,
    activityStore: threadActivities,
    threadMetadataStore: threads,
    sessionLifecycleStore: providerSessionBindings,
    checkpointDiffStore: checkpointDiffs,
    transcriptStore: threads,
    transcriptRecoveryStore,
    onFatalDurabilityFailure: (error) =>
      taintBackend(error, "assistant_transcript_durability"),
    onFatalProjectionFailure: (error) =>
      taintBackend(error, "provider_runtime_projection_receipt"),
    sourceProposedPlanImplementations,
    broadcaster: hub,
    logger,
    // The post-projection lane: the reactor observes the legacy view of an
    // event only after ingestion has processed it — journaled first whenever
    // journaling applies (auto-save off and transcript-lane deltas are the
    // cases where it does not), never before the journal saw it.
    projectedSink: (event) => eventBus.emitProjected(event),
  })

  // Startup checkpoint recovery emits canonical runtime diff events. Wire
  // both synchronous projection and reactor observation before that recovery,
  // while HTTP/provider admissions are still closed.
  //
  // Ordering is structural, not positional: the reactor listens on the
  // bus's `"projected"` lane, which ingestion feeds after the journal write,
  // so it cannot observe an event the journal has not recorded — whichever
  // of the two subscribes first. The reactor's dedup keys off
  // `dispatchTurnId`, which the hub injects before emitting.
  providerRuntimeIngestion.start()
  startupCleanup.push({
    name: "provider runtime ingestion",
    run: () => providerRuntimeIngestion.stop(),
  })
  checkpointReactor.start()
  startupCleanup.push({
    name: "checkpoint reactor",
    run: () => checkpointReactor.stop(),
  })

  // Recover journaled events before the backend accepts requests. A row
  // that fails to project stays unreceipted and stops replay there, but it
  // does not fail startup: one poisoned row used to boot-loop the whole
  // app. The replayer retries it on the next boot and discards it after
  // its attempt budget.
  const providerRuntimeReplay = new ProviderRuntimeJournalReplayer(
    eventStore,
    providerRuntimeProjectionReceipts,
    providerRuntimeIngestion,
    logger
  ).replayAll()
  if (
    providerRuntimeReplay.replayed > 0 ||
    providerRuntimeReplay.discarded > 0
  ) {
    logger.info(
      {
        replayed: providerRuntimeReplay.replayed,
        discarded: providerRuntimeReplay.discarded,
      },
      "provider runtime journal startup replay completed"
    )
  }
  if (providerRuntimeReplay.blocked) {
    const { error, ...block } = providerRuntimeReplay.blocked
    logger.error(
      { err: error, ...block },
      "provider runtime journal startup replay skipped the rest of a thread at a row that could not be projected; other threads were replayed, continuing startup, the row is retried on the next start"
    )
  }
  const abandonedSourcePlanLinks = sourceProposedPlanImplementations.clearAll()
  if (abandonedSourcePlanLinks > 0) {
    logger.warn(
      { abandonedSourcePlanLinks },
      "cleared accepted source-plan links without a recoverable turn start"
    )
  }

  const recoveredChatDispatches = recoverChatDispatchesAfterRestart(
    chatDispatches,
    providerSessionBindings
  )
  if (recoveredChatDispatches.length > 0) {
    logger.warn(
      { recoveredChatDispatches: recoveredChatDispatches.length },
      "recovered pending chat dispatches as uncertain after backend restart"
    )
  }

  // Replay may restore a pre-crash running state. Normalize lifecycle only
  // after replay so no stale active turn can survive this boot.
  const recoveredProviderSessions =
    providerSessionBindings.recoverAfterProcessRestart()
  if (recoveredProviderSessions > 0) {
    logger.warn(
      { recoveredProviderSessions },
      "cleared stale provider session lifecycle state after backend restart"
    )
  }
  const stopGoals = initializeThreadGoals(providers.state, eventBus)
  startupCleanup.push({ name: "thread goals", run: stopGoals })
  const stopAutonomy = initializeThreadAutonomy(providers.state, eventBus)
  startupCleanup.push({ name: "thread autonomy", run: stopAutonomy })
  // Chats that resume by themselves after a usage limit, or once after a
  // quit or crash cut their turn off. After replay, like the schedulers
  // above, so it continues only what this boot found interrupted.
  const stopChatResume = initializeChatResume(providers.state, eventBus)
  startupCleanup.push({ name: "chat resume", run: stopChatResume })
  return { providerRuntimeIngestion }
}

/**
 * Phase 5b: checkpoint turn-slot reconciliation, admitted-turn recovery,
 * pending revert recovery, worktree reconciliation under the recovery fence,
 * and the checkpoint ref cleanup worker. Runs after the journal replay above
 * because every step here decides based on projected checkpoint state.
 */
export async function recoverCheckpointsAndWorktrees(
  root: BootRoot,
  providers: ProvidersContext
): Promise<void> {
  const { options, startupCleanup } = root
  const {
    checkpointTurnSlots,
    checkpointReactor,
    registeredRepositories,
    checkpointReverts,
    worktrees,
    checkpointRefCleanup,
    state,
  } = providers
  // Runtime-journal replay may have projected a checkpoint after migration
  // seeded the allocator. Reclaim only reservations that never crossed the
  // durable pre-turn admission barrier, then recover every admitted crash-gap
  // from its retained baseline before any cleanup worker or request starts.
  checkpointTurnSlots.reconcileAll()
  const recoveredCheckpointAdmissions =
    await checkpointReactor.recoverPendingAdmissions()
  if (recoveredCheckpointAdmissions > 0) {
    logger.warn(
      { recoveredCheckpointAdmissions },
      "recovered admitted checkpoint turns after backend restart"
    )
  }
  await recoverPendingCheckpointReverts(state)
  options.signal?.throwIfAborted()

  // Revert journals own the workspace until their recovery has either
  // completed or been durably quarantined. Worktree reconciliation can
  // remove worktrees/branches and must therefore run only after revert
  // recovery, under the same repository-wide mutation fence. A quarantined
  // repository remains available for recovery inspection, but its mutable
  // startup reconciliation is deliberately skipped.
  let nextRepository = 0
  const reconciliations = await Promise.allSettled(
    Array.from(
      { length: Math.min(4, registeredRepositories.length) },
      async () => {
        try {
          while (nextRepository < registeredRepositories.length) {
            options.signal?.throwIfAborted()
            const repository = registeredRepositories[nextRepository++]
            if (!repository) continue
            const blockingThreadId =
              checkpointReverts.blockingThreadForCwd(repository)
            if (blockingThreadId) {
              logger.warn(
                { repository, blockingThreadId },
                "worktree reconciliation skipped while checkpoint recovery remains fenced"
              )
              continue
            }
            await withCheckpointRecoveryMutation(
              state,
              { workspaces: [repository] },
              () => worktrees.reconcile(repository)
            )
          }
        } catch (error) {
          // Stop claiming new repositories, but let already admitted workers
          // release their recovery leases before startup can close SQLite.
          nextRepository = registeredRepositories.length
          throw error
        }
      }
    )
  )
  const failedReconciliation = reconciliations.find(
    (result) => result.status === "rejected"
  )
  if (failedReconciliation?.status === "rejected") {
    throw failedReconciliation.reason
  }
  options.signal?.throwIfAborted()

  // A crash can leave a cleanup intent after the checkpoint event was
  // durably journaled but before its projection was applied. Replay must
  // therefore complete before the cleanup worker decides that a ref is
  // unreferenced.
  await checkpointRefCleanup.recoverOrphansAtStartup()
  checkpointRefCleanup.start()
  startupCleanup.push({
    name: "checkpoint ref cleanup scheduler",
    run: () => checkpointRefCleanup.stop(),
  })
}
