import type { Context, Hono } from "hono"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { requestIdentity } from "../../remote/http"
import type { RemoteProviderTurnReservation } from "../../remote/providerTurnOwnership"
import { resolveAutoCompactionDecisionForThread } from "../../services/chat/automatic-compaction"
import { dispatchChatTurn } from "../../services/chat/dispatch"
import {
  resolveApprovedWorkspaceRoot,
  resolveChatWorkspaceRoot,
} from "../../services/workspace/authorization"
import { controlThreadGoal } from "../../services/chat/goal-runtime"
import { registerChatAutonomyRoutes } from "./chat-autonomy"
import { registerChatResumeRoutes } from "./chat-resume"
import { persistDispatchUserMessage } from "../../services/chat/dispatch-lifecycle"
import { preparedTurnTokensFor } from "../../services/chat/prepared-turns"
import { withThreadPermissionLevel } from "../../services/chat/thread-settings"
import {
  buildPreparedTurnInstruction,
  runMessageSendHooks,
} from "../../services/chat/turn-preparation"
import {
  capRemoteChatPermissions,
  DESKTOP_PERMISSION_ACCESS,
  rejectChatInput,
  respondToChatApproval,
  respondToChatInput,
  respondToChatPlan,
  updateChatPermissionMode,
  withChatRecoveryMutation,
  type RemotePermissionAccess,
} from "../../services/chat/requests"
import { remoteTerminalRefusal } from "../remoteTerminalPolicy"
import {
  interruptChatTurn,
  rotateChatSession,
} from "../../services/chat/sessions"
import { steerChatTurn } from "../../services/chat/steer"
import { handleHttpContract } from "../contracts"

function reserveRemoteProviderTurn(
  state: AppState,
  c: Context
): RemoteProviderTurnReservation | null {
  if (!state.remoteProviderTurns) return null
  const identity = requestIdentity(c, state.config, state)
  const session = identity?.kind === "remote" ? identity.session : null
  if (!session) return null
  return state.remoteProviderTurns.reserve({
    sessionId: session.id,
    generation: session.createdAt,
    expiresAt: session.expiresAt,
  })
}

/**
 * The caller's standing with the permission system (see
 * `RemotePermissionAccess`). Only a paired device is limited: it may use
 * bypass only with the desktop owner's terminal grant on a full session —
 * the same check `/shell/run` applies, so the grant cannot be routed around
 * by asking the agent to run the command instead.
 */
export function permissionAccess(
  state: AppState,
  c: Context
): RemotePermissionAccess {
  const identity = requestIdentity(c, state.config, state)
  if (identity?.kind !== "remote") return DESKTOP_PERMISSION_ACCESS
  return {
    remote: true,
    mayBypass:
      remoteTerminalRefusal(c, state.config, identity, state.settings) === null,
  }
}

/**
 * Text generation runs a provider CLI in the caller's folder. A paired
 * device may only name a registered workspace, as for every other route
 * that works in a folder; the desktop's own requests keep their folder.
 */
async function textGenerationCwd(
  state: AppState,
  c: Context,
  cwd: string | null | undefined
): Promise<string | null> {
  if (!cwd || requestIdentity(c, state.config, state)?.kind !== "remote")
    return cwd ?? null
  return resolveApprovedWorkspaceRoot(state, cwd)
}

export function registerChatRoutes(api: Hono, state: AppState): void {
  api.post("/chat/goal", (c) =>
    handleHttpContract(
      c,
      "chatGoal",
      async (body) =>
        controlThreadGoal(
          state,
          capRemoteChatPermissions(
            withThreadPermissionLevel(state, body),
            permissionAccess(state, c)
          ),
          () => reserveRemoteProviderTurn(state, c)
        ),
      { operation: "chat goal" }
    )
  )
  registerChatAutonomyRoutes(api, state, {
    permissionAccess: (c) => permissionAccess(state, c),
    reserveRemoteTurn: (c) => reserveRemoteProviderTurn(state, c),
  })
  registerChatResumeRoutes(api, state, {
    permissionAccess: (c) => permissionAccess(state, c),
    reserveRemoteTurn: (c) => reserveRemoteProviderTurn(state, c),
  })
  // The user message of a turn a provider plugin runs in the desktop
  // process. With `prepareTurn` the desktop leaves the turn's preparation
  // to the backend, as for `/chat/send`: the hooks run before the message
  // is recorded, and the instruction comes back for the plugin.
  api.post("/chat/persist-user", (c) =>
    handleHttpContract(
      c,
      "chatPersistUser",
      async (body) => {
        if (!body.prepare_turn) {
          return withChatRecoveryMutation(
            state,
            body.thread_id,
            () => {
              const messageId = persistDispatchUserMessage(state, body)
              return { persisted: messageId !== null }
            },
            body.project_path
          )
        }
        if (requestIdentity(c, state.config, state)?.kind !== "local") {
          throw new HttpError(
            403,
            "Only the desktop host runs provider plugins.",
            "plugin_turn_desktop_only"
          )
        }
        const prepared = {
          ...body,
          project_path: await resolveChatWorkspaceRoot(
            state,
            body.thread_id,
            body.project_path
          ),
        }
        await runMessageSendHooks(state, prepared)
        const result = await withChatRecoveryMutation(
          state,
          body.thread_id,
          () => {
            const messageId = persistDispatchUserMessage(state, body)
            return { persisted: messageId !== null }
          },
          body.project_path
        )
        const systemInstruction = await buildPreparedTurnInstruction(
          state,
          prepared
        )
        // The hooks ran for this message: if the plugin fails, the desktop
        // sends it through `/chat/send` with this token, and they do not
        // run a second time (services/chat/prepared-turns.ts).
        const preparedTurnToken = preparedTurnTokensFor(state).issue(body)
        return {
          ...result,
          systemInstruction,
          ...(preparedTurnToken ? { preparedTurnToken } : {}),
        }
      },
      { operation: "chat persist user" }
    )
  )

  api.post("/chat/send", (c) =>
    handleHttpContract(
      c,
      "chatSend",
      async (parsedBody) => {
        // The token stays out of the turn (and its retry fingerprint).
        const { prepared_turn_token: preparedTurnToken, ...sendBody } =
          parsedBody
        const local = requestIdentity(c, state.config, state)?.kind === "local"
        if (sendBody.orchestration?.enabled && !local)
          throw new HttpError(
            403,
            "Only the desktop host can configure orchestration."
          )
        // A provider plugin's fallback: `/chat/persist-user` already ran
        // this message's hooks. The token is spent whoever presents it, and
        // only the desktop's own send skips them.
        const hooksRan =
          preparedTurnTokensFor(state).consume(preparedTurnToken, sendBody) &&
          local
        return dispatchChatTurn(
          state,
          capRemoteChatPermissions(
            withThreadPermissionLevel(state, sendBody),
            permissionAccess(state, c)
          ),
          () => reserveRemoteProviderTurn(state, c),
          undefined,
          { messageHooks: !hooksRan }
        )
      },
      { operation: "chat send" }
    )
  )

  api.post("/chat/interrupt", (c) =>
    handleHttpContract(
      c,
      "chatInterrupt",
      async (body) => interruptChatTurn(state, body),
      { operation: "chat interrupt" }
    )
  )

  // A message for the running turn (services/chat/steer.ts). Paired devices
  // may steer wherever they may send; read-only sessions cannot post.
  api.post("/chat/steer", (c) =>
    handleHttpContract(
      c,
      "chatSteer",
      async (body) => steerChatTurn(state, body),
      { operation: "chat steer" }
    )
  )

  api.post("/chat/compaction/decision", (c) =>
    handleHttpContract(
      c,
      "chatCompactionDecision",
      async (body) => {
        const cwd =
          body.cwd ??
          state.threads.getThreadProjectPath?.(body.threadId) ??
          null
        const approvedCwd =
          cwd && requestIdentity(c, state.config, state)?.kind === "remote"
            ? await resolveApprovedWorkspaceRoot(state, cwd)
            : cwd
        const resolved = await resolveAutoCompactionDecisionForThread(state, {
          threadId: body.threadId,
          cwd: approvedCwd,
          incomingContent: body.incomingContent,
          usage: body.usage,
          modelLimits: body.modelLimits,
          // This compatibility endpoint remains read-only. Its provider-native
          // hint is advisory; `/chat/send` itself accepts that opt-out only
          // from server-observed provider usage.
          trustClientNativeCompactionHint: true,
        })
        return resolved.decision
      },
      { operation: "chat automatic compaction decision" }
    )
  )

  api.post("/chat/session/rotate", (c) =>
    handleHttpContract(
      c,
      "chatSessionRotate",
      async (body) => rotateChatSession(state, body),
      { operation: "chat session rotate" }
    )
  )

  api.post("/chat/title", (c) =>
    handleHttpContract(
      c,
      "chatTitle",
      async (body) => state.chatHelpers.generateTitle(body.userMessage),
      { operation: "chat title" }
    )
  )

  api.post("/chat/questions", (c) =>
    handleHttpContract(
      c,
      "chatQuestions",
      async (body) => state.chatHelpers.extractQuestions(body.text),
      { operation: "chat questions" }
    )
  )

  api.post("/chat/text-generation/commit-message", (c) =>
    handleHttpContract(
      c,
      "generateCommitMessage",
      async (body) =>
        state.chatHelpers.generateCommitMessage({
          ...body,
          cwd: await textGenerationCwd(state, c, body.cwd),
        }),
      { operation: "chat text-generation commit-message" }
    )
  )

  api.post("/chat/text-generation/pr-content", (c) =>
    handleHttpContract(
      c,
      "generatePrContent",
      async (body) =>
        state.chatHelpers.generatePrContent({
          ...body,
          cwd: await textGenerationCwd(state, c, body.cwd),
        }),
      { operation: "chat text-generation pr-content" }
    )
  )

  api.post("/chat/text-generation/branch-name", (c) =>
    handleHttpContract(
      c,
      "generateBranchName",
      async (body) =>
        state.chatHelpers.generateBranchName({
          ...body,
          cwd: await textGenerationCwd(state, c, body.cwd),
        }),
      { operation: "chat text-generation branch-name" }
    )
  )

  api.post("/chat/text-generation/thread-context-summary", (c) =>
    handleHttpContract(
      c,
      "generateThreadContextSummary",
      async (body) =>
        state.chatHelpers.generateThreadContextSummary({
          ...body,
          cwd: await textGenerationCwd(state, c, body.cwd),
        }),
      { operation: "chat text-generation thread-context-summary" }
    )
  )

  api.post("/chat/text-generation/skill-content", (c) =>
    handleHttpContract(
      c,
      "generateSkillContent",
      async (body) =>
        state.chatHelpers.generateSkillContent({
          ...body,
          cwd: await textGenerationCwd(state, c, body.cwd),
        }),
      { operation: "chat text-generation skill-content" }
    )
  )

  // Approval round-trip: renderer replies after the user clicks Approve /
  // Deny in the approval dialog. The adapter forwards it as a JSON-RPC
  // response to the provider's `item/*/requestApproval` request.
  api.post("/chat/approval", (c) =>
    handleHttpContract(
      c,
      "chatApproval",
      async (body) =>
        respondToChatApproval(state, body, permissionAccess(state, c)),
      { operation: "chat approval" }
    )
  )

  // Plan-approval round-trip: renderer replies after the user approves a
  // proposed plan (optionally switching to acceptEdits for same-turn
  // implementation) or sends it back with feedback. Hub providers only —
  // legacy adapters never open plan_approval requests.
  api.post("/chat/plan-approval", (c) =>
    handleHttpContract(
      c,
      "chatPlanApproval",
      async (body) => respondToChatPlan(state, body),
      { operation: "chat plan-approval" }
    )
  )

  // Live presets also settle pending hub approvals. Native provider policy
  // changes that cannot apply mid-turn are reported as queued.
  api.post("/chat/permission-mode", (c) =>
    handleHttpContract(
      c,
      "chatPermissionMode",
      async (body) =>
        updateChatPermissionMode(state, body, permissionAccess(state, c)),
      { operation: "chat permission-mode" }
    )
  )

  // User-input round-trip: renderer replies to a `user_input_requested`
  // prompt. `answers` is keyed by question id so providers can preserve
  // option metadata instead of relying on positional arrays.
  api.post("/chat/user-input", (c) =>
    handleHttpContract(
      c,
      "chatUserInput",
      async (body) => respondToChatInput(state, body),
      { operation: "chat user-input" }
    )
  )

  api.post("/chat/user-input/reject", (c) =>
    handleHttpContract(
      c,
      "chatUserInputReject",
      async (body) => rejectChatInput(state, body),
      { operation: "chat user-input reject" }
    )
  )
}
