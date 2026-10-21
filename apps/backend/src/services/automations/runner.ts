import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { chatSendSchema, type AutomationRunLocation } from "@betterc0de/schema"
import type { AppState } from "../../appState"
import { HttpError } from "../../errors"
import { withCheckpointRecoveryMutation } from "../checkpoint-recovery-fence"
import { dispatchChatTurn } from "../chat/dispatch"
import { runMessageSendHooks } from "../chat/turn-preparation"
import * as git from "../git"
import type { AutomationRunner } from "./service"

/**
 * How an automation run reaches a provider: the same server-side path goals
 * and Autonomous Work use (`dispatchChatTurn`), with a chat of its own.
 *
 * 1. The project folder must still exist and be explicitly trusted.
 * 2. A new chat is created, titled "<name> · <date>".
 * 3. For "a new worktree per run", a worktree is created for that chat from
 *    the project's current branch, under the same recovery fence as the
 *    chat's own worktree button. It is a checkout of the project the user
 *    trusted for this automation, so it is trusted too.
 * 4. The user's "on message send" hooks run once, as for a message they
 *    type, and the turn starts with the automation's provider, model,
 *    reasoning level and permission preset, in Agent mode, with the turn
 *    prepared by the backend (rules, skills, MCP servers).
 */

function assertAvailable(state: AppState): void {
  if (state.taintedRef() || state.drainingRef()) {
    throw new Error("The backend is stopping. The run did not start.")
  }
}

/**
 * The canonical folder of an automation's project. Refused when it is gone,
 * when it was not trusted explicitly (`workspace_untrusted`: the desktop
 * offers the trust prompt), or when a worktree run has no Git repository.
 */
export async function resolveAutomationProject(
  state: Pick<AppState, "agentPermissions">,
  projectPath: string,
  runLocation: AutomationRunLocation
): Promise<string> {
  if (!path.isAbsolute(projectPath)) {
    throw new HttpError(
      400,
      "Choose the project folder.",
      "automation_project_invalid"
    )
  }
  const canonical = await fs.realpath(projectPath).catch(() => null)
  const isDirectory = canonical
    ? await fs.stat(canonical).then(
        (stats) => stats.isDirectory(),
        () => false
      )
    : false
  if (!canonical || !isDirectory) {
    throw new HttpError(
      400,
      "The project folder does not exist.",
      "automation_project_missing"
    )
  }
  const trust = state.agentPermissions.getWorkspaceTrust(canonical)
  if (trust.state !== "trusted" || !trust.explicit) {
    throw new HttpError(
      403,
      "Trust this project before an automation runs in it.",
      "workspace_untrusted"
    )
  }
  if (runLocation === "worktree" && !(await git.isRepo(canonical)).is_repo) {
    throw new HttpError(
      400,
      "A new worktree per run needs a Git repository.",
      "automation_not_git_repository"
    )
  }
  return canonical
}

export function createAutomationRunner(state: AppState): AutomationRunner {
  return {
    async start(request) {
      const { automation, threadId } = request
      assertAvailable(state)
      if (state.settings.get().auto_save_conversations === false) {
        throw new Error(
          "Conversation auto-save is off. Turn it on in Settings → General so automation runs keep their chats."
        )
      }
      const root = await resolveAutomationProject(
        state,
        automation.projectPath,
        automation.runLocation
      )
      const projectName = path.basename(root)
      state.threads.upsertThreadMeta({
        thread_id: threadId,
        title: request.title,
        project_name: projectName,
        project_path: root,
        parent_thread_id: null,
        codex_thread_id: null,
        created_at: request.createdAt,
        updated_at: request.createdAt,
      })
      request.onChatCreated()

      let workspace = root
      if (automation.runLocation === "worktree") {
        state.agentPermissions.assertWorkspaceTrusted({
          workspacePath: root,
          operation: "create an automation worktree",
        })
        const created = await withCheckpointRecoveryMutation(
          state,
          { threadIds: [threadId], workspaces: [root] },
          async () => {
            const baseBranch = (await git.listBranches(root)).current.trim()
            if (!baseBranch) {
              throw new Error("The project's current branch could not be read.")
            }
            return state.worktrees.createForThread({
              threadId,
              baseRepoPath: root,
              baseBranch,
              firstMessage: automation.name,
            })
          }
        )
        workspace = created.worktreePath
        state.agentPermissions.setWorkspaceTrust({
          workspacePath: workspace,
          state: "trusted",
        })
      }

      assertAvailable(state)
      const body = chatSendSchema.parse({
        threadId,
        providerKind: automation.providerKind,
        providerInstanceId: automation.providerInstanceId,
        modelId: automation.modelId,
        modelSelection: automation.modelSelection,
        reasoningEffort: automation.reasoningEffort,
        projectPath: workspace,
        chatMode: "agent",
        appMode: "agent",
        permissionLevel: automation.permissionLevel,
        prepareTurn: true,
        message: request.message,
        userMessageId: randomUUID(),
        userMessageContent: request.displayMessage,
        userMessageCreatedAt: request.createdAt,
        threadTitle: request.title,
        threadProjectName: projectName,
        threadCreatedAt: request.createdAt,
      })
      // Once for the run, as for a message typed in the chat; the turn
      // below is started with turn hooks, which do not run them again.
      await runMessageSendHooks(state, body)
      const turn: { settled?: Promise<void> } = {}
      await dispatchChatTurn(state, body, () => null, {
        guard: () => assertAvailable(state),
        started: (started) => {
          turn.settled = started.settled
        },
      })
      return { settled: turn.settled ?? Promise.resolve() }
    },
  }
}
