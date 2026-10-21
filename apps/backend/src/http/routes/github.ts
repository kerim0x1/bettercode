import type { Hono } from "hono"
import type { AppState } from "../../appState"
import * as git from "../../services/git"
import {
  commentOnPullRequest,
  compareBranch,
  createPullRequest,
  mergePullRequest,
  preparePullRequestBranch,
  readPullRequestDetail,
  readPullRequestDiff,
  readPullRequestOverview,
  readRepositoryInfo,
  reviewPullRequest,
  setPullRequestState,
} from "../../services/github-pull-request-actions"
import {
  listPullRequestWatches,
  pullRequestWatchStore,
  setPullRequestWatch,
} from "../../services/github-pull-request-watch"
import { withGitMutationLock } from "../../services/git-mutation-lock"
import {
  recoveryWorkspacesForThread,
  withCheckpointRecoveryMutation,
} from "../checkpointRecoveryFence"
import { contractJson, handleHttpContract } from "../contracts"
import { HttpError } from "../errors"
import { resolveApprovedWorkspaceRoot } from "./workspace"

/**
 * Pull requests through the user's GitHub CLI (`services/github-*`), with
 * their shared contracts (`@betterc0de/schema/http-contracts`). Every `cwd`
 * is confined to a registered workspace root. Changing a pull request
 * (create, comment, review, merge, close, check out) needs the workspace to
 * be trusted, like a Git mutation; reads do not. The wake-up routes are for
 * the desktop host only (`remote/http.ts`).
 */
export function registerGitHubRoutes(api: Hono, state: AppState): void {
  const confine = async <T extends { cwd: string }>(body: T): Promise<T> => ({
    ...body,
    cwd: await resolveApprovedWorkspaceRoot(state, body.cwd.trim()),
  })
  const read =
    <T extends { cwd: string }, R>(handler: (body: T) => Promise<R>) =>
    async (body: T): Promise<R> =>
      handler(await confine(body))
  const change =
    <T extends { cwd: string }, R>(handler: (body: T) => Promise<R>) =>
    async (body: T): Promise<R> => {
      const confined = await confine(body)
      state.agentPermissions.assertWorkspaceTrusted({
        workspacePath: confined.cwd,
        operation: "GitHub pull request",
      })
      return handler(confined)
    }

  api.post("/github/repository", (c) =>
    handleHttpContract(
      c,
      "githubRepository",
      read((b) => readRepositoryInfo(b.cwd, { refresh: true })),
      { operation: "github repository" }
    )
  )
  api.post("/github/pull-requests/overview", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestOverview",
      async (b) => {
        // Folders that are no longer registered are left out, not refused:
        // the page lists whatever projects still resolve.
        const confined = await Promise.all(
          [...new Set(b.cwds.map((cwd) => cwd.trim()))].map((cwd) =>
            resolveApprovedWorkspaceRoot(state, cwd).catch(() => null)
          )
        )
        const cwds = [
          ...new Set(confined.filter((cwd): cwd is string => cwd !== null)),
        ]
        if (cwds.length === 0) return { viewerLogin: null, repositories: [] }
        return readPullRequestOverview(cwds, { refresh: b.refresh })
      },
      { operation: "github pull request overview" }
    )
  )
  api.post("/github/pull-requests/compare", (c) =>
    handleHttpContract(
      c,
      "githubBranchCompare",
      read((b) => compareBranch(b)),
      { operation: "github branch compare" }
    )
  )
  api.post("/github/pull-requests/create", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestCreate",
      change((b) => createPullRequest(b)),
      { operation: "github pull request create" }
    )
  )
  api.post("/github/pull-requests/detail", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestDetail",
      read((b) => readPullRequestDetail(b.cwd, b.number)),
      { operation: "github pull request detail" }
    )
  )
  api.post("/github/pull-requests/diff", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestDiff",
      read((b) => readPullRequestDiff(b.cwd, b.number)),
      { operation: "github pull request diff" }
    )
  )
  api.post("/github/pull-requests/comment", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestComment",
      change((b) => commentOnPullRequest(b)),
      { operation: "github pull request comment" }
    )
  )
  api.post("/github/pull-requests/review", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestReview",
      change((b) => reviewPullRequest(b)),
      { operation: "github pull request review" }
    )
  )
  api.post("/github/pull-requests/merge", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestMerge",
      change((b) => mergePullRequest(b)),
      { operation: "github pull request merge" }
    )
  )
  api.post("/github/pull-requests/state", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestState",
      change((b) => setPullRequestState(b)),
      { operation: "github pull request state" }
    )
  )
  // "Work on this PR": the pull request's branch checked out in a new
  // worktree for the chat, through the same worktree manager as any chat
  // worktree, or the project folder itself when it already has the branch.
  api.post("/github/pull-requests/work", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestWork",
      change(async (b) =>
        withGitMutationLock(b.cwd, () =>
          withCheckpointRecoveryMutation(
            state,
            {
              threadIds: [b.threadId],
              workspaces: [
                b.cwd,
                ...recoveryWorkspacesForThread(state, b.threadId),
              ],
            },
            async () => {
              const checkout = await preparePullRequestBranch(b.cwd, b.number)
              const checkedOut = (await git.listWorktrees(b.cwd)).find(
                (worktree) => worktree.branch === checkout.branch
              )
              if (checkedOut) {
                // A branch can be checked out once; work where it already is,
                // when that folder is one the app may use.
                const path = await resolveApprovedWorkspaceRoot(
                  state,
                  checkedOut.path
                ).catch(() => null)
                if (!path) {
                  throw new HttpError(
                    409,
                    `The branch ${checkout.branch} is already checked out in ${checkedOut.path}. Open that folder to work on this pull request.`,
                    "github_branch_checked_out"
                  )
                }
                return {
                  mode: "project" as const,
                  path,
                  branch: checkout.branch,
                  baseBranch: checkout.baseBranch,
                  worktreeId: null,
                  headSha: checkout.headSha,
                  crossRepository: checkout.crossRepository,
                }
              }
              const worktree = await state.worktrees.createForThread({
                threadId: b.threadId,
                baseRepoPath: b.cwd,
                baseBranch: checkout.baseBranch,
                firstMessage: null,
                existingBranch: checkout.branch,
              })
              if (checkout.crossRepository) {
                // A fork's code is a stranger's: its hooks, MCP servers and
                // formatter commands must not run until the user has read it
                // and trusts the folder, even with automatic trust on.
                state.agentPermissions.setWorkspaceTrust({
                  workspacePath: worktree.worktreePath,
                  state: "untrusted",
                })
              }
              return {
                mode: "worktree" as const,
                path: worktree.worktreePath,
                branch: worktree.branch,
                baseBranch: worktree.baseBranch,
                worktreeId: worktree.worktreeId,
                headSha: worktree.headSha,
                crossRepository: checkout.crossRepository,
              }
            }
          )
        )
      ),
      { operation: "github pull request work" }
    )
  )

  // Wake-ups (desktop only, see remote/http.ts).
  api.get("/github/pull-requests/watch", (c) =>
    contractJson(c, "githubPullRequestWatchList", listPullRequestWatches(state))
  )
  api.post("/github/pull-requests/watch", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestWatchSet",
      async (b) =>
        withCheckpointRecoveryMutation(
          state,
          {
            threadIds: [b.threadId],
            workspaces: recoveryWorkspacesForThread(state, b.threadId),
          },
          async () => ({
            watch: setPullRequestWatch(state, b.threadId, b.enabled),
          })
        ),
      { operation: "github pull request watch" }
    )
  )
  api.post("/github/pull-requests/watch/claim", (c) =>
    handleHttpContract(
      c,
      "githubPullRequestWatchClaim",
      async (b) => ({ notice: pullRequestWatchStore(state).claim(b.noticeId) }),
      { operation: "github pull request watch claim" }
    )
  )
}
