import type { Hono } from "hono"
import { createHash } from "node:crypto"
import path from "node:path"
import type {
  GitHunkActionInput,
  GitHunkActionResult,
} from "@betterc0de/schema"
import * as git from "../../services/git"
import { listPullRequests } from "../../services/github-pull-requests"
import {
  detectOpenTargets,
  launchOpenTarget,
  SHELL_TARGET_IDS,
  TARGET_IDS,
} from "../../services/openTargets"
import { resolveRequestIdentity } from "../../remote/http"
import { remoteTerminalRefusal } from "../remoteTerminalPolicy"
import { contractJson, handleHttpContract } from "../contracts"
import type { AppState } from "../../appState"
import { withCheckpointRecoveryMutation } from "../checkpointRecoveryFence"
import { HttpError } from "../errors"
import { withGitMutationLock } from "../../services/git-mutation-lock"
import { resolveApprovedWorkspaceRoot } from "./workspace"

const hunkOperationLocks = new Map<string, Promise<void>>()

/**
 * Every route here answers with its shared contract
 * (`@betterc0de/schema/http-contracts`): the request is parsed with the
 * contract's schema and the response validated before it is sent, so the
 * renderer and the phone read the same shapes the backend writes.
 */
export function registerGitRoutes(api: Hono, state: AppState): void {
  // `resolveApprovedWorkspaceRoot` throws a nominal HttpError
  // (`workspace_not_registered`); parseAndHandle surfaces it unchanged.
  const confineCwd = async <T extends { cwd?: string | null }>(
    body: T
  ): Promise<T> => {
    const requested = typeof body.cwd === "string" ? body.cwd.trim() : ""
    if (!requested) return body
    const cwd = await resolveApprovedWorkspaceRoot(state, requested)
    return { ...body, cwd }
  }
  const mutate =
    <T extends { cwd: string }, R>(handler: (body: T) => R) =>
    async (body: T): Promise<Awaited<R>> => {
      const confined = await confineCwd(body)
      state.agentPermissions.assertWorkspaceTrusted({
        workspacePath: confined.cwd,
        operation: "Git mutation",
      })
      // Mutations on one checkout run one at a time (Git's index.lock is a
      // failure, not a queue); the recovery fence inside is a shared lease.
      return await withGitMutationLock(confined.cwd, () =>
        withCheckpointRecoveryMutation<Awaited<R>>(
          state,
          { workspaces: [confined.cwd] },
          () => Promise.resolve(handler(confined))
        )
      )
    }
  const read =
    <T extends { cwd?: string | null }, R>(handler: (body: T) => R) =>
    async (body: T): Promise<Awaited<R>> => {
      const confined = await confineCwd(body)
      return await handler(confined)
    }
  api.post("/git/status", (c) =>
    handleHttpContract(
      c,
      "gitStatus",
      read((b) => git.status(b.cwd)),
      {
        operation: "git status",
      }
    )
  )
  api.post("/git/profile", (c) =>
    handleHttpContract(
      c,
      "gitProfile",
      read((b) => git.userProfile(b.cwd)),
      { operation: "git profile" }
    )
  )
  api.post("/git/branches", (c) =>
    handleHttpContract(
      c,
      "gitBranches",
      read((b) => git.listBranches(b.cwd)),
      { operation: "git branches" }
    )
  )
  api.post("/git/commit", (c) =>
    handleHttpContract(
      c,
      "gitCommit",
      mutate((b) => git.commit(b.cwd, b.message)),
      { operation: "git commit" }
    )
  )
  api.post("/git/push", (c) =>
    handleHttpContract(
      c,
      "gitPush",
      mutate((b) =>
        git.push(b.cwd, {
          setUpstream: b.setUpstream,
          branch: b.branch,
          remote: b.remote,
        })
      ),
      { operation: "git push" }
    )
  )
  api.post("/git/fetch", (c) =>
    handleHttpContract(
      c,
      "gitFetch",
      mutate((b) => git.fetchRemote(b.cwd)),
      { operation: "git fetch" }
    )
  )
  api.post("/git/pull", (c) =>
    handleHttpContract(
      c,
      "gitPull",
      mutate((b) => git.pull(b.cwd)),
      { operation: "git pull" }
    )
  )
  api.post("/git/discard", (c) =>
    handleHttpContract(
      c,
      "gitDiscard",
      mutate(async (b) => {
        await git.discard(b.cwd, b.path)
        return { ok: true as const }
      }),
      { operation: "git discard" }
    )
  )
  // Which external tools are installed on this machine (VS Code, Cursor,
  // Terminal, …). Detection is async, cached, deadline-bounded, and explicit
  // refresh requests are single-flighted and rate-limited.
  api.get("/git/open-targets", async (c) =>
    contractJson(c, "gitOpenTargets", {
      targets: await detectOpenTargets({
        refresh: c.req.query("refresh") === "true",
      }),
    })
  )
  // Launching an external tool on a directory is not a Git mutation and does
  // not need workspace trust: the user is opening their own folder in their
  // own editor, which an untrusted (or not-yet-trusted) workspace must still
  // allow. It is confined to registered roots, holds the recovery fence so a
  // checkpoint restore cannot race the launch, and the target id must be one
  // we know how to spawn.
  const launch =
    <T extends { cwd: string }, R>(handler: (body: T) => R) =>
    async (body: T): Promise<Awaited<R>> => {
      const confined = await confineCwd(body)
      return await withCheckpointRecoveryMutation<Awaited<R>>(
        state,
        { workspaces: [confined.cwd] },
        () => Promise.resolve(handler(confined))
      )
    }
  api.post("/git/open-editor", (c) =>
    handleHttpContract(
      c,
      "gitOpenEditor",
      async (b) => {
        // `launchOpenTarget` also rejects unknown ids, but only after
        // stat-ing the project directory; refuse first so a bad id is a
        // plain 400 with no filesystem work.
        if (!TARGET_IDS.has(b.editor)) {
          throw new HttpError(
            400,
            `unknown open target: ${b.editor}`,
            "open_target_unknown"
          )
        }
        // Every target puts a window on the desktop host's screen — one a
        // paired device cannot see. Terminal-like targets (Terminal, Git
        // Bash, WSL) additionally start an interactive shell on the host,
        // so they follow the owner's terminal grant like every other shell
        // a remote session gets. Editors and Explorer serve nobody at the
        // remote end and are desktop-only: "full" remote access is the
        // user's coding workflow, not driving the host desktop.
        const identity = resolveRequestIdentity(
          c,
          state.config,
          state.remoteAccess
        )
        if (identity?.kind === "remote") {
          if (!SHELL_TARGET_IDS.has(b.editor)) {
            throw new HttpError(
              403,
              "Opening host applications is only available on the desktop.",
              "desktop_only"
            )
          }
          const refused = remoteTerminalRefusal(
            c,
            state.config,
            identity,
            state.settings
          )
          if (refused) throw new HttpError(403, refused.error, refused.code)
        }
        return launch<{ cwd: string }, Promise<{ ok: true }>>((confined) =>
          launchOpenTarget(b.editor, confined.cwd)
        )({ cwd: b.path })
      },
      { operation: "git open-editor" }
    )
  )
  api.post("/git/init", (c) =>
    handleHttpContract(
      c,
      "gitInit",
      mutate((b) => git.gitInit(b.cwd)),
      { operation: "git init" }
    )
  )
  api.post("/git/is-repo", (c) =>
    handleHttpContract(
      c,
      "gitIsRepo",
      read((b) => git.isRepo(b.cwd)),
      {
        operation: "git is-repo",
      }
    )
  )
  api.post("/git/diff", (c) =>
    handleHttpContract(
      c,
      "gitDiff",
      read((b) => git.diff(b.cwd)),
      {
        operation: "git diff",
      }
    )
  )
  api.post("/git/diff-staged", (c) =>
    handleHttpContract(
      c,
      "gitDiffStaged",
      read((b) => git.diffStaged(b.cwd)),
      { operation: "git diff-staged" }
    )
  )
  api.post("/git/remotes", (c) =>
    handleHttpContract(
      c,
      "gitRemotes",
      read((b) => git.listRemotes(b.cwd)),
      { operation: "git remotes" }
    )
  )
  api.post("/git/pull-requests", (c) =>
    handleHttpContract(
      c,
      "gitPullRequests",
      read((b) => listPullRequests(b.cwd)),
      { operation: "git pull requests" }
    )
  )
  api.post("/git/remotes/add", (c) =>
    handleHttpContract(
      c,
      "gitRemoteAdd",
      mutate(async (b) => {
        await git.addRemote(b.cwd, b.name, b.url)
        return { ok: true as const }
      }),
      { operation: "git remotes/add" }
    )
  )
  api.post("/git/stage", (c) =>
    handleHttpContract(
      c,
      "gitStage",
      mutate(async (b) => {
        await git.stage(b.cwd, b.paths)
        return { ok: true as const }
      }),
      { operation: "git stage" }
    )
  )
  api.post("/git/unstage", (c) =>
    handleHttpContract(
      c,
      "gitUnstage",
      mutate(async (b) => {
        await git.unstage(b.cwd, b.paths)
        return { ok: true as const }
      }),
      { operation: "git unstage" }
    )
  )
  api.post("/git/stage-all", (c) =>
    handleHttpContract(
      c,
      "gitStageAll",
      mutate(async (b) => {
        await git.stageAll(b.cwd)
        return { ok: true as const }
      }),
      { operation: "git stage-all" }
    )
  )
  api.post("/git/unstage-all", (c) =>
    handleHttpContract(
      c,
      "gitUnstageAll",
      mutate(async (b) => {
        await git.unstageAll(b.cwd)
        return { ok: true as const }
      }),
      { operation: "git unstage-all" }
    )
  )
  api.post("/git/hunks/apply", (c) =>
    handleHttpContract(
      c,
      "gitHunkApply",
      mutate((body) => applyHunkWithReceipt(state, body)),
      { operation: "git hunk apply" }
    )
  )
  api.post("/git/log", (c) =>
    handleHttpContract(
      c,
      "gitLog",
      read((b) => git.log(b.cwd, b.count)),
      {
        operation: "git log",
      }
    )
  )
  api.post("/git/checkout", (c) =>
    handleHttpContract(
      c,
      "gitCheckout",
      mutate(async (b) => {
        await git.checkout(b.cwd, b.branch, b.create)
        return { ok: true as const }
      }),
      { operation: "git checkout" }
    )
  )
  api.post("/git/branch/rename", (c) =>
    handleHttpContract(
      c,
      "gitBranchRename",
      mutate(async (b) => {
        await git.renameBranch(b.cwd, b.oldName, b.newName)
        return { ok: true as const }
      }),
      { operation: "git branch rename" }
    )
  )
  api.post("/git/stash", (c) =>
    handleHttpContract(
      c,
      "gitStash",
      mutate(async (b) => {
        await git.stash(b.cwd, b.message)
        return { ok: true as const }
      }),
      { operation: "git stash" }
    )
  )
  api.post("/git/stash-pop", (c) =>
    handleHttpContract(
      c,
      "gitStashPop",
      mutate(async (b) => {
        await git.stashPop(b.cwd)
        return { ok: true as const }
      }),
      { operation: "git stash-pop" }
    )
  )
  api.post("/git/worktrees", (c) =>
    handleHttpContract(
      c,
      "gitWorktrees",
      read((b) => git.listWorktrees(b.cwd)),
      { operation: "git worktrees" }
    )
  )
  api.post("/git/worktrees/create", (c) =>
    handleHttpContract(
      c,
      "gitWorktreeCreate",
      mutate(async (b) => {
        await resolveApprovedWorkspaceRoot(
          state,
          path.dirname(path.resolve(b.cwd, b.worktreePath))
        )
        return git.createWorktree(b.cwd, b.worktreePath, b.branch, b.baseBranch)
      }),
      { operation: "git worktree create" }
    )
  )
  api.post("/git/worktrees/remove", (c) =>
    handleHttpContract(
      c,
      "gitWorktreeRemove",
      mutate(async (b) => {
        await resolveApprovedWorkspaceRoot(
          state,
          path.resolve(b.cwd, b.worktreePath)
        )
        await git.removeWorktree(b.cwd, b.worktreePath, { force: b.force })
        return { ok: true as const }
      }),
      { operation: "git worktree remove" }
    )
  )
  api.post("/git/worktrees/prune", (c) =>
    handleHttpContract(
      c,
      "gitWorktreePrune",
      mutate(async (b) => {
        await git.pruneWorktrees(b.cwd)
        return { ok: true as const }
      }),
      { operation: "git worktree prune" }
    )
  )
  api.post("/git/checkpoints/capture", (c) =>
    handleHttpContract(
      c,
      "gitCheckpointCapture",
      async () => {
        throw new HttpError(
          410,
          "Raw checkpoint captures are disabled; checkpoints are owned by the provider turn lifecycle.",
          "checkpoint_capture_requires_turn_lifecycle"
        )
      },
      { operation: "git checkpoint capture" }
    )
  )
  api.post("/git/checkpoints/has", (c) =>
    handleHttpContract(
      c,
      "gitCheckpointHas",
      read(async (b) => ({ exists: await git.hasCheckpointRef(b) })),
      { operation: "git checkpoint has" }
    )
  )
  api.post("/git/checkpoints/restore", (c) =>
    handleHttpContract(
      c,
      "gitCheckpointRestore",
      async () => {
        throw new HttpError(
          410,
          "Raw checkpoint restores are disabled; use the thread checkpoint revert workflow.",
          "checkpoint_restore_requires_thread_saga"
        )
      },
      { operation: "git checkpoint restore" }
    )
  )
  api.post("/git/checkpoints/diff", (c) =>
    handleHttpContract(
      c,
      "gitCheckpointDiff",
      read((b) => git.diffCheckpoints(b)),
      { operation: "git checkpoint diff" }
    )
  )
  api.post("/git/checkpoints/delete", (c) =>
    handleHttpContract(
      c,
      "gitCheckpointDelete",
      async () => {
        throw new HttpError(
          410,
          "Raw checkpoint deletion is disabled; use the checkpoint cleanup workflow.",
          "checkpoint_delete_requires_cleanup_saga"
        )
      },
      { operation: "git checkpoint delete" }
    )
  )
}

async function applyHunkWithReceipt(
  state: AppState,
  body: GitHunkActionInput
): Promise<GitHunkActionResult> {
  const operationId = body.operationId?.trim()
  const receiptStore = state.receiptStore
  if (!operationId || !receiptStore || body.dryRun) {
    return git.applyHunk(body)
  }

  const commandId = `git-hunk:${operationId}`
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        cwd: body.cwd,
        path: body.path,
        source: body.source,
        action: body.action,
        patch: body.patch.replace(/\r\n?/g, "\n"),
        expectedPatchId: body.expectedPatchId ?? null,
      })
    )
    .digest("hex")
  return withHunkOperationLock(commandId, async () => {
    const existing = receiptStore.find(commandId)
    if (existing) {
      return recoverHunkOperation(state, body, {
        commandId,
        requestHash,
        existing,
      })
    }

    try {
      receiptStore.insert({
        command_id: commandId,
        status: "prepared",
        result_json: null,
        request_hash: requestHash,
        created_at: new Date().toISOString(),
      })
    } catch {
      const concurrent = receiptStore.find(commandId)
      if (concurrent) {
        return recoverHunkOperation(state, body, {
          commandId,
          requestHash,
          existing: concurrent,
        })
      }
      throw new Error("The hunk operation receipt could not be prepared.")
    }

    const result = await git.applyHunk(body)
    receiptStore.complete({
      commandId,
      requestHash,
      resultJson: JSON.stringify(result),
    })
    return result
  })
}

async function withHunkOperationLock<T>(
  commandId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = hunkOperationLocks.get(commandId) ?? Promise.resolve()
  let release = (): void => undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  hunkOperationLocks.set(commandId, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (hunkOperationLocks.get(commandId) === tail) {
      hunkOperationLocks.delete(commandId)
    }
  }
}

async function recoverHunkOperation(
  state: AppState,
  body: GitHunkActionInput,
  input: {
    readonly commandId: string
    readonly requestHash: string
    readonly existing: {
      readonly request_hash: string | null
      readonly status: string
      readonly result_json: string | null
    }
  }
): Promise<GitHunkActionResult> {
  if (input.existing.request_hash !== input.requestHash) {
    throw Object.assign(
      new Error("This hunk operation id is bound to a different request."),
      { statusCode: 409, code: "git_hunk_operation_conflict" }
    )
  }
  if (input.existing.status === "completed" && input.existing.result_json) {
    return {
      ...(JSON.parse(input.existing.result_json) as GitHunkActionResult),
      replayed: true,
    }
  }
  if (input.existing.status !== "prepared") {
    throw Object.assign(
      new Error("This hunk operation did not complete successfully."),
      { statusCode: 409, code: "git_hunk_operation_incomplete" }
    )
  }

  const operationState = await git.inspectHunkActionState(body)
  if (operationState === "conflict") {
    throw Object.assign(
      new Error(
        "This prepared hunk operation no longer has a provable workspace state. Refresh the diff before retrying."
      ),
      { statusCode: 409, code: "git_hunk_operation_ambiguous" }
    )
  }
  const result =
    operationState === "pending"
      ? await git.applyHunk(body)
      : {
          ok: true as const,
          action: body.action,
          patchId: git.gitHunkPatchId(body.patch),
          applied: true,
        }
  state.receiptStore.complete({
    commandId: input.commandId,
    requestHash: input.requestHash,
    resultJson: JSON.stringify(result),
  })
  return {
    ...result,
    ...(operationState === "applied" ? { replayed: true } : {}),
  }
}
