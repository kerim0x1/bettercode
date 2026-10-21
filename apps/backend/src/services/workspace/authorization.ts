import fs from "node:fs/promises"
import path from "node:path"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { isScratchWorkspacePath } from "../scratchWorkspace"

type WorkspaceRegistryState = Pick<
  AppState,
  "db" | "config" | "projectProjections" | "threads" | "worktreeRegistry"
>
interface RootRegistry {
  revision: number | null
  roots: Promise<Map<string, string[]>>
}
const rootRegistries = new WeakMap<WorkspaceRegistryState, RootRegistry>()
// A folder picker may inspect a project before its first thread is persisted.
// These explicit opens last for this backend's lifetime; durable threads remain
// the source of registered roots after restart.
const openedRoots = new WeakMap<WorkspaceRegistryState, Set<string>>()

export async function openWorkspaceRoot(
  state: WorkspaceRegistryState & Pick<AppState, "agentPermissions">,
  workspacePath: string
): Promise<{ path: string }> {
  if (!path.isAbsolute(workspacePath)) {
    throw new HttpError(
      400,
      "Choose an absolute workspace folder path.",
      "invalid_workspace_path"
    )
  }
  const canonical = await fs.realpath(workspacePath).catch(() => null)
  if (!canonical || !(await fs.stat(canonical)).isDirectory()) {
    throw new HttpError(
      400,
      "The selected workspace folder is unavailable.",
      "workspace_unavailable"
    )
  }
  // Preserves an explicit untrusted decision. Registration allows metadata
  // reads; the permission policy continues to gate tools and mutations.
  if (!state.agentPermissions) {
    throw new HttpError(
      503,
      "Workspace permission service is unavailable.",
      "permissions_unavailable"
    )
  }
  state.agentPermissions.ensureWorkspaceTrusted(canonical)
  const roots = openedRoots.get(state) ?? new Set<string>()
  roots.add(canonical)
  openedRoots.set(state, roots)
  rootRegistries.delete(state)
  return { path: canonical }
}

function registryRevision(state: WorkspaceRegistryState): number | null {
  if (!state.db) return null
  return (
    state.db
      .prepare(
        "SELECT version FROM backend_read_revisions WHERE name = 'workspaces'"
      )
      .get() as { version: number }
  ).version
}

async function loadRegisteredRoots(
  state: WorkspaceRegistryState
): Promise<Map<string, string[]>> {
  const approved = new Set<string>()
  for (const opened of openedRoots.get(state) ?? []) approved.add(opened)
  for (const project of state.projectProjections?.listAll?.() ?? []) {
    if (project.path?.trim()) approved.add(project.path)
  }
  for (const project of (state.threads?.listProjects?.() ?? []) as Array<{
    path?: string
  }>) {
    if (project.path?.trim()) approved.add(project.path)
  }
  for (const worktree of state.worktreeRegistry?.listAll?.() ?? []) {
    if (worktree.state === "ready" && worktree.worktree_path?.trim())
      approved.add(worktree.worktree_path)
  }
  const roots = new Map<string, string[]>()
  const remaining = approved.values()
  // Bound filesystem fan-out while sharing the rebuild across simultaneous reads.
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (
        let entry = remaining.next();
        !entry.done;
        entry = remaining.next()
      ) {
        const canonical = await fs
          .realpath(path.resolve(entry.value))
          .catch(() => null)
        if (!canonical) continue
        const key = canonicalWorkspaceKey(canonical)
        const paths = roots.get(key) ?? []
        paths.push(entry.value)
        roots.set(key, paths)
      }
    })
  )
  return roots
}

export async function resolveApprovedWorkspaceRoot(
  state: WorkspaceRegistryState,
  requestedRoot: string
): Promise<string> {
  const requested = await fs
    .realpath(path.resolve(requestedRoot))
    .catch(() => null)
  if (!requested)
    throw new HttpError(
      403,
      "workspace root is unavailable",
      "workspace_unavailable"
    )
  if (
    state.config?.dataDir &&
    isScratchWorkspacePath(state.config.dataDir, requested)
  )
    return requested

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revision = registryRevision(state)
    let registry = rootRegistries.get(state)
    if (
      !registry ||
      revision === null ||
      registry.revision !== revision ||
      attempt > 0
    ) {
      registry = { revision, roots: loadRegisteredRoots(state) }
      rootRegistries.set(state, registry)
    }
    const roots = await registry.roots
    for (let ancestor = requested; ; ancestor = path.dirname(ancestor)) {
      for (const candidate of roots.get(canonicalWorkspaceKey(ancestor)) ??
        []) {
        // Cache membership only. A moved root/junction must be checked on every
        // request, and a concurrent unregister invalidates this result.
        const canonical = await fs
          .realpath(path.resolve(candidate))
          .catch(() => null)
        if (
          canonical &&
          canonicalWorkspaceKey(canonical) ===
            canonicalWorkspaceKey(ancestor) &&
          registryRevision(state) === revision
        ) {
          return requested
        }
      }
      if (path.dirname(ancestor) === ancestor) break
    }
  }
  // Nominal HttpError with a public message: every catcher (parseAndHandle,
  // app.onError, the hand-written shell routes) surfaces it as
  // `403 { error, code: "workspace_not_registered" }` without local mapping.
  throw new HttpError(
    403,
    "workspace root is not registered",
    "workspace_not_registered"
  )
}

/**
 * Resolve the only workspace a chat turn may use. A ready thread worktree is
 * authoritative over the thread's base project, followed by the durable
 * thread project and finally an existing provider-session cwd. The caller may
 * omit the root and inherit that binding, but may never switch an existing
 * thread to another registered project through `/chat/send`.
 */
export async function resolveChatWorkspaceRoot(
  state: AppState,
  threadId: string,
  requestedRoot?: string | null
): Promise<string | null> {
  const worktree =
    state.worktrees?.findForThread?.(threadId) ??
    state.worktreeRegistry?.findByThread?.(threadId) ??
    null
  const readyWorktreePath =
    worktree?.state?.trim().toLowerCase() === "ready"
      ? worktree.worktree_path?.trim()
      : null
  const threadProjectPath =
    state.threads?.getThreadProjectPath?.(threadId)?.trim() || null
  const providerWorkspace =
    state.providerSessionBindings
      ?.getLatestForThread?.(threadId)
      ?.cwd?.trim() || null
  const boundRoot =
    readyWorktreePath || threadProjectPath || providerWorkspace || null
  const requested = requestedRoot?.trim() || null

  if (!requested) {
    return boundRoot
      ? await resolveApprovedWorkspaceRoot(state, boundRoot)
      : null
  }

  const canonicalRequested = await resolveApprovedWorkspaceRoot(
    state,
    requested
  )
  if (!boundRoot) return canonicalRequested

  const canonicalBound = await resolveApprovedWorkspaceRoot(state, boundRoot)
  if (
    canonicalWorkspaceKey(canonicalRequested) !==
    canonicalWorkspaceKey(canonicalBound)
  ) {
    throw new HttpError(
      403,
      "The requested workspace does not match this thread's registered workspace.",
      "workspace_binding_mismatch"
    )
  }
  return canonicalBound
}

function canonicalWorkspaceKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value
}
