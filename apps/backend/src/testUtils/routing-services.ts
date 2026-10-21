import { afterEach, vi } from "vitest"
import type { AppState } from "../appState"
import { AdmissionGate } from "../lifecycle/AdmissionGate"
import { openDatabase, type Db } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { AgentPermissionPolicy } from "../provider/agent-permission-policy"
import { ThreadTurnCoordinator } from "../provider/threadTurnCoordinator"
import { ChatDispatchStore } from "../services/chat-dispatch-store"
import type { RemoteAccessService } from "../remote/service"
import type { OrchestratorService } from "../services/orchestrator/service"

const databases: Db[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

/**
 * Explicit dependencies for route tests whose provider and thread persistence
 * are spies. Durable dispatch and concurrency suites supply their real stores.
 * Keep these doubles out of production rather than making AppState optional.
 */
export function routingTestServices(): Pick<
  AppState,
  | "agentPermissions"
  | "chatDispatches"
  | "threadTurnCoordinator"
  | "orchestrator"
  | "taintBackend"
> {
  const db = openDatabase(":memory:")
  databases.push(db)
  runMigrations(db)
  const agentPermissions = new AgentPermissionPolicy(db, {
    autoTrustWorkspaces: () => true,
  })
  // Routing-only fixtures omit workspace configuration. Trust-boundary suites
  // inject their own policy; these tests explicitly admit their mock workspace.
  vi.spyOn(agentPermissions, "evaluateTurnTrust").mockReturnValue({
    decision: "allow",
    source: "default",
  })
  const chatDispatches = new ChatDispatchStore(db)
  vi.spyOn(chatDispatches, "reserve").mockImplementation((input, persist) => {
    persist()
    const now = new Date().toISOString()
    return {
      kind: "created",
      record: {
        ...input,
        status: "pending",
        providerTurnId: null,
        attemptCount: 1,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        acceptedAt: null,
        completedAt: null,
        failedAt: null,
        recoveryCompletedAt: null,
      },
    }
  })
  const threadTurnCoordinator = new ThreadTurnCoordinator()
  // Mock providers do not accept or release shared reservation tokens.
  vi.spyOn(threadTurnCoordinator, "reserveTurn").mockImplementation(() =>
    Symbol("routing-test-turn")
  )
  return {
    agentPermissions,
    chatDispatches,
    threadTurnCoordinator,
    orchestrator: inertOrchestrator(),
    // A durability failure taints the backend; suites that assert it pass a spy.
    taintBackend: () => {},
  }
}

/**
 * An orchestrator with no team: turns pass through unchanged and nothing is
 * delegated. Tests of team behaviour pass a real `OrchestratorService`.
 */
export function inertOrchestrator(): OrchestratorService {
  return {
    prepareForTurn: async <T>(body: T) => body,
    assertDispatchAllowed: () => {},
    withInterruptedChildren: <T>(_threadId: string, interrupt: () => T) =>
      interrupt(),
    quiesceThread: async () => {},
    forgetThread: () => {},
    close: async () => {},
  } as unknown as OrchestratorService
}

/**
 * The request-lifecycle members every `buildApp` request passes through: an
 * open admission gate, taint and drain flags that are off, and remote access
 * that is turned off. Spread it first and override what a test exercises
 * (a real `RemoteAccessService`, a draining flag).
 */
export function routerLifecycleServices(): Pick<
  AppState,
  "requestAdmission" | "taintedRef" | "drainingRef" | "remoteAccess"
> {
  return {
    requestAdmission: new AdmissionGate(),
    taintedRef: () => false,
    drainingRef: () => false,
    remoteAccess: {
      enabled: () => false,
      environmentId: () => "test-environment",
      authenticate: () => null,
      noteClient: () => {},
    } as unknown as RemoteAccessService,
  }
}
