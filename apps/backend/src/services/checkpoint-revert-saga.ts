import { checkpointRefForThreadTurn } from "@betterc0de/schema"
import type { AppState } from "../appState"
import { logger } from "../observability/logger"
import type { ThreadId } from "../provider/runtime/contracts"
import type {
  CheckpointRevertOperation,
  CheckpointRevertOperationStore,
} from "./checkpoint-revert-operations"
import { assertCheckpointRevertTurnRange } from "./checkpoint-revert-operations"
import { recoveryWorkspacesForThread } from "./checkpoint-recovery-fence"
import * as git from "./git"
import { parseThreadCheckpointRevertRequest } from "./threads"

/**
 * Checkpoint revert saga.
 *
 * Moved verbatim out of `http/routes/threads.ts`: the route owns transport
 * (parsing, the recovery fence middleware); this module owns the multi-phase
 * filesystem → provider → database revert and its startup recovery. The
 * phases are journaled in `CheckpointRevertOperationStore` before each
 * external side effect so a crash resumes at the right boundary instead of
 * applying a rollback twice.
 */

export function recordCheckpointRevertFailed(
  state: Pick<AppState, "threadActivities">,
  input: {
    readonly threadId: string
    readonly turnCount?: number | null
    readonly numTurns?: number | null
    readonly providerKind?: string | null
    readonly providerInstanceId?: string | null
    readonly detail: string
  }
): void {
  const createdAt = new Date().toISOString()
  state.threadActivities.upsert({
    activity_id: `${input.threadId}::checkpoint.revert.failed::${createdAt}`,
    thread_id: input.threadId,
    turn_id: null,
    provider_instance_id: input.providerInstanceId ?? null,
    kind: "checkpoint.revert.failed",
    tone: "error",
    summary: "Checkpoint revert failed",
    payload: {
      detail: input.detail,
      ...(typeof input.turnCount === "number"
        ? { turnCount: input.turnCount }
        : {}),
      ...(typeof input.numTurns === "number"
        ? { numTurns: input.numTurns }
        : {}),
      ...(input.providerKind ? { providerKind: input.providerKind } : {}),
      ...(input.providerInstanceId
        ? { providerInstanceId: input.providerInstanceId }
        : {}),
    },
    sequence: null,
    created_at: createdAt,
  })
}

/**
 * Runs `operation` while the thread's turn coordinator and the provider hub
 * (and the direct-API provider stack, while it exists) hold the thread in
 * maintenance, so no turn can start or run under a revert.
 */
export async function withCheckpointMaintenance<T>(
  state: AppState,
  threadId: string,
  operation: () => Promise<T> | T
): Promise<T> {
  const withLegacyMaintenance = state.providers?.withThreadMaintenance?.bind(
    state.providers
  )
  const runLegacy = () =>
    withLegacyMaintenance
      ? withLegacyMaintenance(threadId, operation)
      : operation()
  const runProviders = () =>
    state.providerHub.withThreadMaintenance(threadId, runLegacy)
  return state.threadTurnCoordinator.withMaintenance(threadId, runProviders)
}

export async function revertThreadCheckpoint(input: {
  readonly state: AppState
  readonly threadId: string
  readonly turnCount: number
  readonly updatedAt: string
  readonly preserveFuture?: boolean
}): Promise<{
  reverted: boolean
  rolledBackTurns: number
  deletedMessages: number
  boundaryMessageId: string | null
  reason?: string
}> {
  const { state, threadId, turnCount, updatedAt } = input
  assertCheckpointRevertTurnRange(turnCount, turnCount)
  const binding = state.providerSessionBindings.getLatestForThread(threadId)
  if (!binding?.cwd) {
    return failRevert(state, {
      threadId,
      turnCount,
      detail:
        "No active provider session with workspace cwd is bound to this thread.",
    })
  }

  const checkpointRefs =
    state.checkpointDiffs.listCheckpointRefsByThread(threadId)
  const currentTurnCount = currentCheckpointTurnCount(
    threadId,
    checkpointRefs,
    state.checkpointDiffs.latestTurnIndex(threadId)
  )
  if (turnCount <= currentTurnCount) {
    assertCheckpointRevertTurnRange(turnCount, currentTurnCount)
  }

  const recoveryWorkspaces = [
    binding.cwd,
    ...recoveryWorkspacesForThread(state, threadId),
  ]
  const exclusiveLease =
    await state.workspaceRecoveryGate.acquireExclusiveAfterQuiesce(
      recoveryWorkspaces,
      async () => {
        // The exclusive waiter is queued before these long-lived shared
        // leases are drained. Fairness then prevents a new shell/PTY mutation
        // from slipping into the workspace between drain and restore.
        for (const workspace of new Set(recoveryWorkspaces)) {
          await Promise.all([
            state.shellSessions.closeSessionsForWorkspace(workspace),
            state.terminalPtys.shutdownForWorkspace(workspace),
          ])
        }
      }
    )
  try {
    const repo = await git.isRepo(binding.cwd)
    if (!repo.is_repo) {
      return failRevert(state, {
        threadId,
        turnCount,
        detail:
          "Checkpoints are unavailable because this project is not a git repository.",
        providerKind: binding.providerKind,
        providerInstanceId: binding.providerInstanceId,
      })
    }

    if (turnCount > currentTurnCount) {
      return failRevert(state, {
        threadId,
        turnCount,
        detail: `Checkpoint turn count ${turnCount} exceeds current turn count ${currentTurnCount}.`,
        providerKind: binding.providerKind,
        providerInstanceId: binding.providerInstanceId,
      })
    }

    const targetCheckpointRef = resolveTargetCheckpointRef(
      threadId,
      turnCount,
      checkpointRefs
    )
    if (!targetCheckpointRef) {
      return failRevert(state, {
        threadId,
        turnCount,
        detail: `Checkpoint ref for turn ${turnCount} is unavailable in read model.`,
        providerKind: binding.providerKind,
        providerInstanceId: binding.providerInstanceId,
      })
    }

    const operationInput: Omit<CheckpointRevertOperation, "phase"> = {
      threadId,
      turnCount,
      currentTurnCount,
      updatedAt,
      cwd: binding.cwd,
      providerKind: binding.providerKind,
      providerInstanceId: binding.providerInstanceId,
      targetCheckpointRef,
      currentCheckpointRef: resolveTargetCheckpointRef(
        threadId,
        currentTurnCount,
        checkpointRefs
      ),
      // Deterministic turn refs are derived from the compact turn range during
      // execution. Persisting two refs per turn made otherwise valid long
      // histories exceed the recovery-journal parser limit.
      staleCheckpointRefs: [],
      // Keeping hidden future refs while deleting their read model creates
      // unreachable, unbounded Git objects. The request field remains accepted
      // for wire compatibility, but rollback now always retires the future.
      preserveFuture: false,
    }
    const operation = state.checkpointReverts.begin(operationInput)
    return executeCheckpointRevertOperation(
      state,
      operation,
      state.checkpointReverts
    )
  } finally {
    exclusiveLease.release()
  }
}

export async function recoverPendingCheckpointReverts(
  state: AppState
): Promise<void> {
  const store = state.checkpointReverts
  for (const operation of store.list()) {
    try {
      await state.workspaceRecoveryGate.withExclusive(operation.cwd, () =>
        withCheckpointMaintenance(state, operation.threadId, async () => {
          await executeCheckpointRevertOperation(state, operation, store)
        })
      )
    } catch (error) {
      logger.error(
        {
          err: error,
          thread: operation.threadId,
          phase: operation.phase,
        },
        "checkpoint revert recovery failed; continuing with remaining journals"
      )
    }
  }
}

async function executeCheckpointRevertOperation(
  state: AppState,
  initialOperation: CheckpointRevertOperation,
  store: CheckpointRevertOperationStore
): Promise<{
  reverted: boolean
  rolledBackTurns: number
  deletedMessages: number
  boundaryMessageId: string | null
  /** Pre-restore worktree snapshot; lets the client offer "Undo restore". */
  safetyRef?: string | null
  /** What the restore overwrote or deleted, for an honest post-hoc summary. */
  restorePreview?: {
    modified: readonly string[]
    removed: readonly string[]
    truncated: boolean
  } | null
  reason?: string
}> {
  let operation = initialOperation
  assertCheckpointRevertTurnRange(
    operation.turnCount,
    operation.currentTurnCount
  )
  let safetyRef: string | null = null
  let restorePreview: {
    modified: readonly string[]
    removed: readonly string[]
    truncated: boolean
  } | null = null
  await Promise.all([
    state.shellSessions.closeSessionsForWorkspace(operation.cwd),
    state.terminalPtys.shutdownForWorkspace(operation.cwd),
  ])
  const setPhase = (phase: CheckpointRevertOperation["phase"]) => {
    operation = store.setPhase(operation, phase)
  }

  if (operation.phase === "prepared") {
    const restoreResult = await git.restoreCheckpoint({
      cwd: operation.cwd,
      checkpointRef: operation.targetCheckpointRef,
      // Turn zero has its own retained pre-first-turn checkpoint. Falling
      // back to the current HEAD would silently restore the wrong filesystem
      // state when that durable ref is missing.
      fallbackToHead: false,
    })
    const restored = restoreResult.restored
    safetyRef = restoreResult.safetyRef
    restorePreview = restoreResult.preview
    if (!restored) {
      store.delete(operation.threadId)
      return failRevert(state, {
        threadId: operation.threadId,
        turnCount: operation.turnCount,
        detail: `Filesystem checkpoint is unavailable for turn ${operation.turnCount}.`,
        providerKind: operation.providerKind,
        providerInstanceId: operation.providerInstanceId,
      })
    }
    setPhase("filesystem_restored")
  }

  const rolledBackTurns = Math.max(
    0,
    operation.currentTurnCount - operation.turnCount
  )
  const staleCheckpointRefs = staleCheckpointRefsAfterTurn(
    operation.threadId,
    operation.turnCount,
    operation.currentTurnCount,
    state.checkpointDiffs.listCheckpointRefsByThread(operation.threadId),
    operation.staleCheckpointRefs
  )
  if (operation.phase === "filesystem_restored") {
    if (rolledBackTurns === 0) {
      setPhase("provider_rollback_done")
    } else {
      // Persist the ambiguous boundary before calling the external provider.
      // A crash after this point recovers by discarding that provider session
      // instead of risking a second rollback.
      setPhase("provider_rollback_started")
      const rolledBack = await state.providerHub.rollbackConversation(
        operation.providerKind,
        operation.threadId as ThreadId,
        rolledBackTurns,
        operation.providerInstanceId,
        state.providerSessionBindings
      )
      if (!rolledBack) {
        // Do not compensate the filesystem after the durable
        // `provider_rollback_started` boundary. A crash between compensation
        // and journal deletion would make startup truncate the database to
        // the target while the filesystem had already been restored to the
        // newer state. Discarding the ambiguous provider session below is
        // idempotent and keeps filesystem, provider generation, and DB on the
        // requested revert boundary.
        logger.warn(
          {
            threadId: operation.threadId,
            providerKind: operation.providerKind,
            providerInstanceId: operation.providerInstanceId,
          },
          "provider conversation rollback was unavailable; discarding the session to complete checkpoint revert"
        )
      } else {
        setPhase("provider_rollback_done")
      }
    }
  }

  if (operation.phase === "provider_rollback_started") {
    // The rollback may have completed before the process or request failed.
    // Retrying it could roll back a second provider turn, so both startup
    // recovery and an online HTTP retry discard the ambiguous session and
    // rotate its generation before continuing the local saga.
    await state.providerHub.stopSession(
      operation.providerKind,
      operation.threadId as ThreadId,
      operation.providerInstanceId
    )
    state.providerSessionBindings.rotateGeneration(
      operation.threadId,
      operation.providerInstanceId
    )
    setPhase("provider_rollback_done")
  }

  let truncateResult = {
    deletedMessages: 0,
    boundaryMessageId: null as string | null,
  }
  if (operation.phase === "provider_rollback_done") {
    truncateResult = state.threads.truncateAfterTurnCount(
      parseThreadCheckpointRevertRequest(
        operation.threadId,
        { turnCount: operation.turnCount, updatedAt: operation.updatedAt },
        staleCheckpointRefs
      )
    )
    state.checkpointTurnSlots.reconcileThread(operation.threadId)
    setPhase("database_truncated")
  }

  if (
    operation.phase === "database_truncated" &&
    staleCheckpointRefs.length > 0
  ) {
    try {
      await git.deleteCheckpointRefs({
        cwd: operation.cwd,
        checkpointRefs: staleCheckpointRefs,
      })
    } catch (error) {
      const cleanupStore = state.checkpointRefCleanupStore
      try {
        const intents = cleanupStore.enqueue({
          threadId: operation.threadId,
          cwd: operation.cwd,
          checkpointRefs: staleCheckpointRefs,
        })
        for (const intent of intents) {
          if (!cleanupStore.recordIntentFailure(intent, error)) {
            throw new Error(
              `Failed to activate checkpoint cleanup intent '${intent.intentId}'.`
            )
          }
        }
      } catch (queueError) {
        throw Object.assign(
          new AggregateError(
            [error, queueError],
            "Checkpoint revert committed, but stale Git refs could not be durably queued for cleanup."
          ),
          { statusCode: 503, code: "CHECKPOINT_REF_CLEANUP_QUEUE_FAILED" }
        )
      }
      logger.warn(
        {
          err: error,
          threadId: operation.threadId,
          checkpointRefCount: staleCheckpointRefs.length,
        },
        "checkpoint revert committed; stale Git ref cleanup durably queued"
      )
    }
  }
  store.delete(operation.threadId)
  return {
    reverted: true,
    rolledBackTurns,
    ...truncateResult,
    safetyRef,
    restorePreview,
  }
}

function failRevert(
  state: AppState,
  input: {
    readonly threadId: string
    readonly turnCount: number
    readonly providerKind?: string | null
    readonly providerInstanceId?: string | null
    readonly detail: string
  }
): {
  reverted: false
  rolledBackTurns: 0
  deletedMessages: 0
  boundaryMessageId: null
  reason: string
} {
  recordCheckpointRevertFailed(state, input)
  return {
    reverted: false,
    rolledBackTurns: 0,
    deletedMessages: 0,
    boundaryMessageId: null,
    reason: input.detail,
  }
}

function currentCheckpointTurnCount(
  threadId: string,
  checkpointRefs: readonly string[],
  latestTurnIndex: number
): number {
  assertCheckpointRevertTurnRange(latestTurnIndex, latestTurnIndex)
  let max = latestTurnIndex
  for (const checkpointRef of checkpointRefs) {
    max = Math.max(
      max,
      checkpointTurnCountFromRef(threadId, checkpointRef) ?? 0
    )
  }
  return max
}

/** The Git ref a revert to `turnCount` restores; `null` when none is recorded. */
export function resolveTargetCheckpointRef(
  threadId: string,
  turnCount: number,
  checkpointRefs: readonly string[]
): string | null {
  if (turnCount === 0) return checkpointRefForThreadTurn(threadId, 0)
  const availableRefs = new Set(checkpointRefs)
  const pairedRef = checkpointRefForThreadTurn(
    threadId,
    (turnCount - 1) * 2 + 1
  )
  if (availableRefs.has(pairedRef)) {
    return pairedRef
  }
  const directRef = checkpointRefForThreadTurn(threadId, turnCount)
  if (availableRefs.has(directRef)) {
    return directRef
  }
  return (
    checkpointRefs.find(
      (checkpointRef) =>
        checkpointTurnCountFromRef(threadId, checkpointRef) === turnCount
    ) ?? null
  )
}

function staleCheckpointRefsAfterTurn(
  threadId: string,
  targetTurnCount: number,
  currentTurnCount: number,
  checkpointRefs: readonly string[],
  persistedCheckpointRefs: readonly string[] = []
): string[] {
  const refs = new Set<string>(persistedCheckpointRefs)
  for (const checkpointRef of checkpointRefs) {
    const turnCount = checkpointTurnCountFromRef(threadId, checkpointRef)
    if (turnCount !== null && turnCount > targetTurnCount) {
      refs.add(checkpointRef)
    }
  }
  for (
    let turnCount = targetTurnCount + 1;
    turnCount <= currentTurnCount;
    turnCount += 1
  ) {
    refs.add(checkpointRefForThreadTurn(threadId, (turnCount - 1) * 2 + 1))
    const baselineRef = checkpointRefForThreadTurn(
      threadId,
      (turnCount - 1) * 2
    )
    if (
      !(
        targetTurnCount === 0 &&
        baselineRef === checkpointRefForThreadTurn(threadId, 0)
      )
    ) {
      refs.add(baselineRef)
    }
  }
  return [...refs]
}

function checkpointTurnCountFromRef(
  threadId: string,
  checkpointRef: string
): number | null {
  const prefix = checkpointRefForThreadTurn(threadId, 0).replace(/0$/, "")
  if (!checkpointRef.startsWith(prefix)) return null
  const suffix = checkpointRef.slice(prefix.length)
  if (!/^(0|[1-9]\d*)$/.test(suffix)) return null
  const slot = Number(suffix)
  if (!Number.isSafeInteger(slot) || slot < 0) return null
  if (slot === 0) return 0
  return slot % 2 === 1 ? (slot + 1) / 2 : slot
}

/**
 * Highest checkpoint turn a thread can be restored from: the larger of the
 * newest recorded turn diff and the newest checkpoint ref. Reads only refs and
 * the turn index, never diff bodies, and never throws (0 when there is none).
 */
export function latestCheckpointTurnCount(
  state: Pick<AppState, "checkpointDiffs">,
  threadId: string
): number {
  if (!threadId.trim()) return 0
  let max = state.checkpointDiffs.latestTurnIndex(threadId)
  for (const checkpointRef of state.checkpointDiffs.listCheckpointRefsByThread(
    threadId
  )) {
    max = Math.max(
      max,
      checkpointTurnCountFromRef(threadId, checkpointRef) ?? 0
    )
  }
  return max
}
