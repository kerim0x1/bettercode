import { buildApprovalDecisionOutput } from "./permission-commands"
import {
  buildPendingApprovalsThreadOutput,
  buildPendingUserInputsThreadOutput,
  buildSessionStatusOutput,
  buildThreadTodosOutput,
  buildUserInputAnswerOutput,
  buildUserInputRejectOutput,
} from "./request-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"

/** Pending approvals, user-input questions, todos and session status. */
export const REQUEST_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: [
        "approvals",
        "approval-list",
        "permission-list",
        "permission.list",
        "permissions-pending",
        "permission.prompt.fullscreen",
        "permission-fullscreen",
      ],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildPendingApprovalsThreadOutput(threadId)
      },
    },
    {
      names: [
        "approve",
        "approval-approve",
        "permission-approve",
        "permission.reply",
        "permission.respond",
      ],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildApprovalDecisionOutput(
          threadId,
          args[0],
          "approve"
        )
      },
    },
    {
      names: ["deny", "reject", "approval-deny", "permission-deny"],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildApprovalDecisionOutput(
          threadId,
          args[0],
          "deny"
        )
      },
    },
    {
      names: [
        "questions",
        "question-list",
        "question.list",
        "user-inputs",
        "user-input-list",
      ],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildPendingUserInputsThreadOutput(threadId)
      },
    },
    {
      names: [
        "answer",
        "question-reply",
        "question.reply",
        "user-input-answer",
      ],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildUserInputAnswerOutput(threadId, args)
      },
    },
    {
      names: [
        "reject-question",
        "question-reject",
        "question.reject",
        "user-input-reject",
      ],
      run: async (run) => {
        const { args, threadId } = run
        run.output = await buildUserInputRejectOutput(threadId, args[0])
      },
    },
    {
      names: ["todos", "todo", "tasks", "session.todo"],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildThreadTodosOutput(threadId)
      },
    },
    {
      names: [
        "session-status",
        "session.status",
        "status.session",
        "thread-status",
      ],
      run: async (run) => {
        const { threadId } = run
        run.output = await buildSessionStatusOutput(threadId)
      },
    },
  ]
