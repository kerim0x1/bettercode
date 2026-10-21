import { HttpError } from "../errors"
import type { WorktreeRegistryQuery } from "../persistence/projections"
import type { ProviderSessionBindingStore } from "../provider/runtime/ProviderSessionBindingStore"
import type { CheckpointRevertOperationStore } from "./checkpoint-revert-operations"
import type { ThreadService } from "./threads"
import type { WorktreeManager } from "./worktree"
import {
  acquireExclusiveWorkspaceMaintenance,
  type ExclusiveWorkspaceMaintenanceState,
} from "./workspace-exclusive-maintenance"
import type {
  WorkspaceRecoveryGate,
  WorkspaceRecoveryLease,
} from "./workspace-recovery-gate"

export interface CheckpointRecoveryMutationScope {
  readonly threadIds?: readonly string[]
  readonly workspaces?: readonly string[]
}

/**
 * The durable revert journal the fences consult, and the instance's recovery
 * gate a mutation's shared lease is taken on. Required: a fence that cannot
 * see the journal must not let a mutation through.
 */
export interface CheckpointRecoveryFenceState {
  readonly checkpointReverts: Pick<
    CheckpointRevertOperationStore,
    "hasBlockingRecovery" | "blockingThreadForCwd"
  >
  readonly workspaceRecoveryGate: Pick<WorkspaceRecoveryGate, "acquireShared">
}

/** Where a thread's work happens: its binding, project and worktree. */
export interface ThreadWorkspaceLookup {
  readonly providerSessionBindings: Pick<
    ProviderSessionBindingStore,
    "getLatestForThread"
  >
  readonly threads: Pick<ThreadService, "getThreadProjectPath">
  readonly worktrees: Pick<WorktreeManager, "findForThread">
  readonly worktreeRegistry: Pick<WorktreeRegistryQuery, "findByThread">
}

export function assertThreadRecoveryComplete(
  state: CheckpointRecoveryFenceState,
  threadId: string
): void {
  const store = state.checkpointReverts
  try {
    if (!store.hasBlockingRecovery(threadId)) return
  } catch {
    throw new HttpError(
      503,
      `Checkpoint recovery state for thread '${threadId}' could not be verified.`,
      "checkpoint_recovery_unavailable"
    )
  }
  throw new HttpError(
    409,
    `Thread '${threadId}' has unfinished checkpoint recovery; only recovery inspection and resolution are allowed.`,
    "checkpoint_recovery_pending"
  )
}

export function assertWorkspaceRecoveryComplete(
  state: CheckpointRecoveryFenceState,
  cwd: string
): void {
  const store = state.checkpointReverts
  let threadId: string | null
  try {
    threadId = store.blockingThreadForCwd(cwd)
  } catch {
    throw new HttpError(
      503,
      "Checkpoint recovery state for this workspace could not be verified.",
      "checkpoint_recovery_unavailable"
    )
  }
  if (!threadId) return
  throw new HttpError(
    409,
    `Workspace mutations are fenced while thread '${threadId}' has unfinished checkpoint recovery.`,
    "checkpoint_recovery_pending"
  )
}

/**
 * Acquire a shared workspace/repository lease and then re-check every durable
 * recovery fence while the lease is held. Callers that transfer work beyond
 * the request lifetime (provider turns and PTYs) can retain the returned lease
 * until that work has actually settled.
 */
export async function acquireCheckpointRecoveryMutationLease(
  state: CheckpointRecoveryFenceState,
  scope: CheckpointRecoveryMutationScope
): Promise<WorkspaceRecoveryLease | null> {
  const workspaces = normalizedWorkspaces(scope.workspaces)
  const lease =
    workspaces.length > 0
      ? await state.workspaceRecoveryGate.acquireShared(workspaces)
      : null
  try {
    for (const threadId of new Set(scope.threadIds ?? [])) {
      if (threadId.trim().length > 0) {
        assertThreadRecoveryComplete(state, threadId)
      }
    }
    for (const workspace of workspaces) {
      assertWorkspaceRecoveryComplete(state, workspace)
    }
    return lease
  } catch (error) {
    lease?.release()
    throw error
  }
}

export async function withCheckpointRecoveryMutation<T>(
  state: CheckpointRecoveryFenceState,
  scope: CheckpointRecoveryMutationScope,
  operation: () => Promise<T> | T
): Promise<T> {
  const lease = await acquireCheckpointRecoveryMutationLease(state, scope)
  try {
    return await operation()
  } finally {
    lease?.release()
  }
}

/**
 * Destructive workspace maintenance variant. It queues an exclusive
 * repository barrier, drains conflicting shell/PTY owners, and only then
 * re-checks durable recovery state before mutating anything.
 */
export async function withCheckpointRecoveryExclusiveMutation<T>(
  /** The process owners are drained for the workspaces before the
   * destructive operation runs. */
  state: CheckpointRecoveryFenceState & ExclusiveWorkspaceMaintenanceState,
  scope: CheckpointRecoveryMutationScope,
  operation: () => Promise<T> | T
): Promise<T> {
  const workspaces = normalizedWorkspaces(scope.workspaces)
  const lease =
    workspaces.length > 0
      ? await acquireExclusiveWorkspaceMaintenance(state, workspaces)
      : null
  try {
    for (const threadId of new Set(scope.threadIds ?? [])) {
      if (threadId.trim().length > 0) {
        assertThreadRecoveryComplete(state, threadId)
      }
    }
    for (const workspace of workspaces) {
      assertWorkspaceRecoveryComplete(state, workspace)
    }
    return await operation()
  } finally {
    lease?.release()
  }
}

export function recoveryWorkspacesForThread(
  state: ThreadWorkspaceLookup,
  threadId: string,
  knownProviderWorkspace?: string | null
): string[] {
  const worktree =
    state.worktrees.findForThread(threadId) ??
    state.worktreeRegistry.findByThread(threadId) ??
    null
  return normalizedWorkspaces([
    knownProviderWorkspace === undefined
      ? (state.providerSessionBindings.getLatestForThread(threadId)?.cwd ??
        null)
      : knownProviderWorkspace,
    state.threads.getThreadProjectPath(threadId) ?? null,
    worktree?.base_repo_path ?? null,
    worktree?.worktree_path ?? null,
  ])
}

function normalizedWorkspaces(
  values: readonly (string | null | undefined)[] | undefined
): string[] {
  return [
    ...new Set(
      (values ?? [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ]
}
