import path from "node:path"
import { closeShellSessionsForWorkspace } from "./shell"
import { shutdownTerminalPtySessionsForWorkspace } from "./terminalPty"
import {
  workspaceRecoveryGate,
  type WorkspaceRecoveryLease,
} from "./workspace-recovery-gate"

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

  return workspaceRecoveryGate.acquireExclusiveAfterQuiesce(
    normalized,
    async () => {
      for (const workspace of normalized) {
        await Promise.all([
          closeShellSessionsForWorkspace(workspace),
          shutdownTerminalPtySessionsForWorkspace(workspace),
        ])
      }
    },
    options
  )
}

export async function withExclusiveWorkspaceMaintenance<T>(
  workspaces: readonly string[],
  operation: () => Promise<T> | T,
  options: { readonly timeoutMs?: number } = {}
): Promise<T> {
  const lease = await acquireExclusiveWorkspaceMaintenance(workspaces, options)
  try {
    return await operation()
  } finally {
    lease.release()
  }
}
