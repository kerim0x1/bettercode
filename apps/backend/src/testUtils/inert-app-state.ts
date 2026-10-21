import { WorkspaceRecoveryGate } from "../services/workspace-recovery-gate"

/**
 * Inert collaborators for route and service tests whose `AppState` doubles
 * name only what a test exercises.
 *
 * Production code no longer tolerates a missing `AppState` member: the
 * checkpoint recovery fence, the workspace registry, the chat workspace
 * binding, the automatic-compaction preflight, the revert saga and the
 * terminal channels used to skip a lookup when a member or method was absent
 * (`state.worktrees?.findForThread?.(…)`), which turned a wiring regression
 * into a silent no-op. Each of those modules now takes a narrow, required
 * dependency type instead.
 *
 * A test double that omits those members gets them here, with the answers
 * the old guards produced for a missing member: no blocking recovery and an
 * unjournaled revert, no worktree, no binding, no registered project, no
 * message, auto-save on, a config without a data directory, a registry
 * revision that is never cached, maintenance that just runs the operation,
 * no terminal and no shell command, and a workspace recovery gate of the
 * state's own that nothing else holds a lease on.
 * What a test supplies always wins; a member that is a class instance (a
 * real `ThreadService`, `ThreadTurnCoordinator`, …) is taken as complete.
 *
 * The fill happens in place, so a test that keeps a reference to its state
 * or to one of its member objects keeps seeing the same object; a test that
 * holds a lease to exercise the recovery fence takes it on
 * `state.workspaceRecoveryGate` after the fill.
 */
type Members = Record<string, object | (() => void)>

function inertMembers(): Members {
  return {
    // `config.dataDir` undefined: no scratch workspace is approved or created.
    config: {},
    // A null revision: the workspace-root registry is rebuilt on every read.
    db: { prepare: () => ({ get: () => ({ version: null }) }) },
    checkpointReverts: {
      hasBlockingRecovery: () => false,
      blockingThreadForCwd: () => null,
      list: () => [],
      get: () => null,
      begin: (input: Record<string, unknown>) => ({
        ...input,
        phase: "prepared",
      }),
      setPhase: (operation: Record<string, unknown>, phase: string) => ({
        ...operation,
        phase,
      }),
      delete: () => {},
    },
    checkpointTurnSlots: { reconcileThread: () => {} },
    projectProjections: { listAll: () => [] },
    threads: {
      listProjects: () => [],
      getThreadProjectPath: () => null,
      listMessages: () => [],
      // No chat has settings of its own: requests keep their own levels.
      getThreadSettings: () => null,
    },
    worktrees: { findForThread: () => null },
    worktreeRegistry: { listAll: () => [], findByThread: () => null },
    providerSessionBindings: {
      getLatestForThread: () => null,
      list: () => [],
    },
    threadActivities: { latestByThreadKind: () => null, upsert: () => {} },
    providerHub: {
      withThreadMaintenance: (_threadId: string, operation: () => unknown) =>
        operation(),
    },
    threadTurnCoordinator: {
      withMaintenance: (_threadId: string, operation: () => unknown) =>
        operation(),
    },
    settings: { get: () => ({}) },
    taintBackend: () => {},
    // No terminal was opened: ending a workspace's or an owner's is a no-op.
    terminalPtys: {
      shutdownForWorkspace: async () => 0,
      shutdownForOwner: async () => 0,
      shutdownForClientInstance: async () => 0,
      activeSessionCount: () => 0,
    },
    // No shell command was started: ending a workspace's, an owner's or a
    // renderer's commands is a no-op.
    shellSessions: {
      closeSessionsForWorkspace: async () => 0,
      closeSessionsForOwner: async () => 0,
      closeSessionsForClientInstance: async () => 0,
      activeSessionCount: () => 0,
      abortSession: () => false,
    },
    // A real gate per state: a workspace mutation's lease is granted at once
    // unless the test itself holds a conflicting one.
    workspaceRecoveryGate: new WorkspaceRecoveryGate(),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/**
 * Fills the members (and the methods of plain-object members) that `state`
 * leaves out with inert ones, in place, and returns `state`.
 */
export function withInertAppState<T>(state: T): T {
  if (!isPlainObject(state)) return state
  const target = state as Record<string, unknown>
  for (const [key, inert] of Object.entries(inertMembers())) {
    const current = target[key]
    if (current === undefined) {
      target[key] = inert
      continue
    }
    if (!isPlainObject(inert) || !isPlainObject(current)) continue
    for (const [method, implementation] of Object.entries(inert)) {
      if (!(method in current)) current[method] = implementation
    }
  }
  return state
}

/**
 * `fn` with its `index`-th argument (an `AppState` double) passed through
 * `withInertAppState` first: `const buildApp = withInertStateArgument(
 * buildRouterApp, 1)` covers every app a test file builds.
 */
export function withInertStateArgument<A extends unknown[], R>(
  fn: (...args: A) => R,
  index: number
): (...args: A) => R {
  return (...args: A) => {
    withInertAppState(args[index])
    return fn(...args)
  }
}
