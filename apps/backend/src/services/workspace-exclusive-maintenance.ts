import path from "node:path"
import type { ShellSessionService } from "./shell"
import type { TerminalPtyService } from "./terminalPty"
import type {
  WorkspaceRecoveryGate,
  WorkspaceRecoveryLease,
} from "./workspace-recovery-gate"

/**
 * The long-lived process owners a destructive workspace operation drains:
 * the instance's terminals and its shell commands.
 */
export interface WorkspaceProcessOwners {
  readonly terminalPtys: Pick<TerminalPtyService, "shutdownForWorkspace">
  readonly shellSessions: Pick<ShellSessionService, "closeSessionsForWorkspace">
}

/**
 * What exclusive workspace maintenance needs: the instance's recovery gate
 * the barrier queues on, and the process owners it drains.
 */
export interface ExclusiveWorkspaceMaintenanceState extends WorkspaceProcessOwners {
  readonly workspaceRecoveryGate: Pick<
    WorkspaceRecoveryGate,
    "acquireExclusiveAfterQuiesce"
  >
}

/**
 * Queues a repository-wide exclusive barrier, then drains long-lived process
 * owners whose cwd would otherwise survive a destructive reset/remove.
 *
 * The waiter is registered before draining, so gate fairness prevents a new
 * shell or PTY from entering the gap. Every supplied path is drained because
 * linked worktrees can conflict through their Git common directory while
 * living in sibling filesystem paths.
 */
export async function acquireExclusiveWorkspaceMaintenance(
  state: ExclusiveWorkspaceMaintenanceState,
  workspaces: readonly string[],
  options: { readonly timeoutMs?: number } = {}
): Promise<WorkspaceRecoveryLease> {
  const normalized = [
    ...new Set(
      workspaces
        .filter((workspace) => workspace.trim().length > 0)
        .map((workspace) => path.resolve(workspace))
    ),
  ]
  if (normalized.length === 0) {
    throw new Error("At least one workspace path is required")
  }

  return state.workspaceRecoveryGate.acquireExclusiveAfterQuiesce(
    normalized,
    async () => {
      for (const workspace of normalized) {
        await Promise.all([
          state.shellSessions.closeSessionsForWorkspace(workspace),
          state.terminalPtys.shutdownForWorkspace(workspace),
        ])
      }
    },
    options
  )
}

export async function withExclusiveWorkspaceMaintenance<T>(
  state: ExclusiveWorkspaceMaintenanceState,
  workspaces: readonly string[],
  operation: () => Promise<T> | T,
  options: { readonly timeoutMs?: number } = {}
): Promise<T> {
  const lease = await acquireExclusiveWorkspaceMaintenance(
    state,
    workspaces,
    options
  )
  try {
    return await operation()
  } finally {
    lease.release()
  }
}
