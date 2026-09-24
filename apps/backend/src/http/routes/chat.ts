import type { Context, Hono } from "hono"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { requestIdentity } from "../../remote/http"
import type { RemoteProviderTurnReservation } from "../../remote/providerTurnOwnership"
import { resolveAutoCompactionDecisionForThread } from "../../services/chat/automatic-compaction"
import { dispatchChatTurn } from "../../services/chat/dispatch"
import { resolveApprovedWorkspaceRoot } from "../../services/workspace/authorization"
import { controlThreadGoal } from "../../services/chat/goal-runtime"
import { persistDispatchUserMessage } from "../../services/chat/dispatch-lifecycle"
import {
  rejectChatInput,
  respondToChatApproval,
  respondToChatInput,
  respondToChatPlan,
  updateChatPermissionMode,
  withChatRecoveryMutation,
} from "../../services/chat/requests"
import {
  interruptChatTurn,
  rotateChatSession,
} from "../../services/chat/sessions"
import { handleHttpContract } from "../contracts"
import { parseAndHandle } from "../routeHelpers"
import {
  chatAutoCompactionDecisionSchema,
  chatGenerateBranchNameSchema,
  chatGenerateCommitMessageSchema,
  chatGeneratePrContentSchema,
  chatGenerateSkillContentSchema,
  chatGenerateThreadContextSummarySchema,
  chatQuestionsSchema,
  chatRotateSessionSchema,
  chatTitleSchema,
} from "../validation"

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
        controlThreadGoal(state, body, () =>
          reserveRemoteProviderTurn(state, c)
        ),
      { operation: "chat goal" }
    )
  )
  api.post("/chat/persist-user", (c) =>
    handleHttpContract(
      c,
      "chatPersistUser",
      async (body) => {
        return withChatRecoveryMutation(
          state,
          body.thread_id,
          () => {
            const messageId = persistDispatchUserMessage(state, body)
            return { persisted: messageId !== null }
          },
          body.project_path
        )
      },
      { operation: "chat persist user" }
    )
  )

  api.post("/chat/send", (c) =>
    handleHttpContract(
      c,
      "chatSend",
      async (parsedBody) => {
        if (
          parsedBody.orchestration?.enabled &&
          requestIdentity(c, state.config, state)?.kind !== "local"
        )
          throw new HttpError(
            403,
            "Only the desktop host can configure orchestration."
          )
        return dispatchChatTurn(state, parsedBody, () =>
          reserveRemoteProviderTurn(state, c)
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

  api.post("/chat/compaction/decision", (c) =>
    parseAndHandle(
      c,
      chatAutoCompactionDecisionSchema,
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
    parseAndHandle(
      c,
      chatRotateSessionSchema,
      async (body) => rotateChatSession(state, body),
      { operation: "chat session rotate" }
    )
  )

  api.post("/chat/title", (c) =>
    parseAndHandle(
      c,
      chatTitleSchema,
      async (body) => state.chatHelpers.generateTitle(body.userMessage),
      { operation: "chat title" }
    )
  )

  api.post("/chat/questions", (c) =>
    parseAndHandle(
      c,
      chatQuestionsSchema,
      async (body) => state.chatHelpers.extractQuestions(body.text),
      { operation: "chat questions" }
    )
  )

  api.post("/chat/text-generation/commit-message", (c) =>
    parseAndHandle(
      c,
      chatGenerateCommitMessageSchema,
      async (body) =>
        state.chatHelpers.generateCommitMessage({
          ...body,
          cwd: await textGenerationCwd(state, c, body.cwd),
        }),
      { operation: "chat text-generation commit-message" }
    )
  )

  api.post("/chat/text-generation/pr-content", (c) =>
    parseAndHandle(
      c,
      chatGeneratePrContentSchema,
      async (body) =>
        state.chatHelpers.generatePrContent({
          ...body,
          cwd: await textGenerationCwd(state, c, body.cwd),
        }),
      { operation: "chat text-generation pr-content" }
    )
  )

  api.post("/chat/text-generation/branch-name", (c) =>
    parseAndHandle(
      c,
      chatGenerateBranchNameSchema,
      async (body) =>
        state.chatHelpers.generateBranchName({
          ...body,
          cwd: await textGenerationCwd(state, c, body.cwd),
        }),
      { operation: "chat text-generation branch-name" }
    )
  )

  api.post("/chat/text-generation/thread-context-summary", (c) =>
    parseAndHandle(
      c,
      chatGenerateThreadContextSummarySchema,
      async (body) =>
        state.chatHelpers.generateThreadContextSummary({
          ...body,
          cwd: await textGenerationCwd(state, c, body.cwd),
        }),
      { operation: "chat text-generation thread-context-summary" }
    )
  )

  api.post("/chat/text-generation/skill-content", (c) =>
    parseAndHandle(
      c,
      chatGenerateSkillContentSchema,
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
      async (body) => respondToChatApproval(state, body),
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
      async (body) => updateChatPermissionMode(state, body),
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
