import type { Hono } from "hono"
import type { AppState } from "../../appState"
import { requestIdentity } from "../../remote/http"
import { handleHttpContract } from "../contracts"
import { resolveApprovedWorkspaceRoot } from "../../services/workspace/authorization"
import { interruptChatTurn } from "../../services/chat/sessions"

export function registerOrchestratorRoutes(api: Hono, state: AppState): void {
  api.use("/orchestrator/*", async (c, next) => {
    if (requestIdentity(c, state.config, state)?.kind !== "local")
      return c.json({ error: "Only the desktop host can manage teams." }, 403)
    return next()
  })
  const service = () => state.orchestrator
  api.post("/orchestrator/start", (c) =>
    handleHttpContract(
      c,
      "orchestratorStart",
      async (body) =>
        service().start(
          await resolveApprovedWorkspaceRoot(state, body.projectPath)
        ),
      { operation: "orchestrator-start" }
    )
  )
  api.post("/orchestrator/status", (c) =>
    handleHttpContract(
      c,
      "orchestratorStatus",
      async (body) => service().status(body.threadId, false),
      { operation: "orchestrator-status" }
    )
  )
  api.post("/orchestrator/context/grant", (c) =>
    handleHttpContract(
      c,
      "orchestratorContextGrant",
      async (body) => service().grantContext(body),
      { operation: "orchestrator-context-grant" }
    )
  )
  api.post("/orchestrator/context/read", (c) =>
    handleHttpContract(
      c,
      "orchestratorContextRead",
      async (body) => service().inspectContext(body.threadId, body.contextId),
      { operation: "orchestrator-context-read" }
    )
  )
  api.post("/orchestrator/context/remove", (c) =>
    handleHttpContract(
      c,
      "orchestratorContextRemove",
      async (body) => {
        service().removeContext(body.threadId, body.contextId)
        return { removed: true as const }
      },
      { operation: "orchestrator-context-remove" }
    )
  )
  api.post("/orchestrator/stop", (c) =>
    handleHttpContract(
      c,
      "orchestratorStop",
      async (body) => {
        const session = await service().stop(body.threadId)
        const binding = state.providerSessionBindings.get(
          session.threadId,
          session.team.main.providerInstanceId
        )
        if (
          binding?.activeTurnId ||
          state.threadTurnCoordinator.activeOwner(session.threadId)
        )
          await interruptChatTurn(state, {
            threadId: session.threadId,
            providerKind: session.team.main.providerKind,
            providerInstanceId: session.team.main.providerInstanceId,
          })
        return session
      },
      { operation: "orchestrator-stop" }
    )
  )
}
