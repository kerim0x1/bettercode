import { randomUUID, createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Db } from "../persistence/db"
import type { EventStore } from "../persistence/eventStore"
import type {
  WorktreeRegistryQuery,
  WorktreeRegistryEntry,
} from "../persistence/projections"
import {
  createWorktree as gitCreateWorktree,
  removeWorktree as gitRemoveWorktree,
  resetWorktree as gitResetWorktree,
  pruneWorktrees as gitPruneWorktrees,
  listWorktrees as gitListWorktrees,
  headSha as gitHeadSha,
  deleteBranch as gitDeleteBranch,
} from "./git"
import { logger } from "../observability/logger"

/**
 * Per-thread worktree lifecycle state. Persisted both in the
 * `worktree_registry` row (single source of truth for cross-thread conflict
 * checks) and denormalised into `projection_threads.worktree_state` so
 * renderer list queries don't need a join.
 *
 * Transitions:
 *   pending → creating → ready → committing → pushed → pr_open → merged|abandoned
 *   ready → abandoned (thread deleted before first commit)
 *
 * `none` is the legacy value for threads created before migration 11 — they
 * run in the shared project workspace without worktree isolation.
 */
export type WorktreeState =
  | "none"
  | "pending"
  | "creating"
  | "removing"
  | "ready"
  | "committing"
  | "pushed"
  | "pr_open"
  | "merged"
  | "abandoned"

export interface WorktreeCreateOptions {
  threadId: string
  /** Absolute path to the main-repo working copy. Must be a git repo. */
  baseRepoPath: string
  /** Branch name to fork from. Must already exist in `baseRepoPath`. */
  baseBranch: string
  /** Any free-form human-ish string — used to slugify the branch name. */
  firstMessage?: string | null
}

export interface WorktreeCreateResult {
  worktreeId: string
  threadId: string
  worktreePath: string
  branch: string
  baseBranch: string
  headSha: string | null
}

export type WorktreeResetResult = WorktreeCreateResult

/** Matches the branch-name convention from the plan's Objective 1:
 *  `agent/<thread-id>/<short-description>`. Slugs are lower-kebab,
 *  alphanumeric + dash, max 30 chars, deduplicated from the thread id so
 *  two threads with identical first-messages still produce distinct branches.
 */
export function buildBranchName(
  threadId: string,
  firstMessage: string | undefined | null
): string {
  const slug = slugifyMessage(firstMessage ?? "")
  const shortId = shortThreadId(threadId)
  return slug ? `agent/${shortId}/${slug}` : `agent/${shortId}/turn`
}

export function slugifyMessage(raw: string): string {
  return (
    raw
      .toLowerCase()
      .normalize("NFKD")
      // Strip Unicode combining diacritical marks so "café" → "cafe"
      // and "über" → "uber" instead of the ugly "u-ber" we'd get if the
      // combining diaeresis were replaced by a dash.
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/g, "")
  )
}

export function shortThreadId(threadId: string): string {
  // Preserve existing UUID paths while keeping arbitrary API identifiers out
  // of filesystem and Git path syntax. Registry/disk checks reject collisions.
  const compact = threadId.replace(/-/g, "")
  const short = compact.slice(0, 8)
  if (
    /^[a-zA-Z0-9]+$/.test(compact) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(short)
  ) {
    return short
  }
  return createHash("sha256").update(threadId).digest("hex").slice(0, 8)
}

/**
 * Computes the on-disk location for a given `(baseRepoPath, threadId)` pair.
 * Stored OUTSIDE the main repo to avoid git's "nested worktree" warnings
 * and to keep `.gitignore` clean. Grouped by a short hash of the base repo
 * so multiple projects can coexist under `~/.betterc0de/worktrees/`.
 */
export function computeWorktreePath(
  baseRepoPath: string,
  threadId: string
): string {
  const home = os.homedir()
  const projectHash = createHash("sha256")
    .update(path.resolve(baseRepoPath))
    .digest("hex")
    .slice(0, 8)
  return path.join(
    home,
    ".betterc0de",
    "worktrees",
    projectHash,
    shortThreadId(threadId)
  )
}

const WORKTREE_EVENT_STREAM_KIND = "worktree"

export class WorktreeManager {
  constructor(
    private readonly db: Db,
    private readonly eventStore: EventStore,
    private readonly registry: WorktreeRegistryQuery
  ) {}

  /**
   * Allocate + materialise a worktree for `threadId`.
   *
   * Hard pre-conditions:
   *  - `baseRepoPath` must be a git work-tree (caller's responsibility).
   *  - `baseBranch` must exist in that repo.
   *  - The chosen branch name must not already be checked out in another
   *    worktree. If it is, we abort with a descriptive error rather than
   *    silently overwrite — matches the Objective 1 rule.
   *
   * Post-conditions on success:
   *  - `worktree_registry` has a row in state `ready`.
   *  - `projection_threads` columns `worktree_path / branch / base_branch /
   *    worktree_state` reflect the new worktree.
   *  - A `WorktreeCreated` event is appended to `orchestration_events`.
   */
  async createForThread(
    opts: WorktreeCreateOptions
  ): Promise<WorktreeCreateResult> {
    const { threadId, baseRepoPath, baseBranch, firstMessage } = opts
    if (!threadId || !baseRepoPath || !baseBranch) {
      throw new Error(
        "createForThread: threadId, baseRepoPath, baseBranch are required"
      )
    }

    const existing = this.registry.findByThread(threadId)
    if (existing) {
      if (existing.state === "removing") {
        throw Object.assign(
          new Error(
            `Worktree for thread '${threadId}' is still being removed; retry removal first.`
          ),
          { statusCode: 409, code: "worktree_removal_pending" }
        )
      }
      const recovered = await this.recoverExistingCreation(existing)
      if (recovered) return recovered
    }

    const branch = await this.allocateUniqueBranch(threadId, firstMessage)
    const worktreePath = computeWorktreePath(baseRepoPath, threadId)

    if (this.registry.findByPath(worktreePath)) {
      throw new Error(`worktree path already registered: ${worktreePath}`)
    }
    if (fs.existsSync(worktreePath)) {
      // A stale on-disk directory not in the registry (e.g. a previous crash
      // before the row was written). Refuse rather than clobber.
      throw new Error(
        `worktree path already exists on disk but is not registered: ${worktreePath}. ` +
          `Remove it manually or run prune.`
      )
    }

    // Ensure the parent dir exists — git itself won't mkdir -p for us.
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true })

    const worktreeId = randomUUID()
    const now = new Date().toISOString()

    // Insert registry row FIRST in `creating` state. If the shell-out fails,
    // we delete the row in the catch; if it succeeds, we transition to
    // `ready`. This ordering guarantees no two concurrent calls can claim
    // the same branch.
    this.registry.insert({
      worktree_id: worktreeId,
      thread_id: threadId,
      worktree_path: worktreePath,
      branch,
      base_branch: baseBranch,
      base_repo_path: path.resolve(baseRepoPath),
      state: "creating",
      delete_branch_on_remove: 0,
      created_at: now,
      updated_at: now,
    })

    try {
      await gitCreateWorktree(baseRepoPath, worktreePath, branch, baseBranch)
    } catch (err) {
      let materializationVerifiedAbsent = false
      try {
        materializationVerifiedAbsent =
          !(await this.isRegisteredWithGit(baseRepoPath, worktreePath)) &&
          !fs.existsSync(worktreePath)
      } catch (verificationError) {
        logger.warn(
          {
            threadId,
            verificationError:
              verificationError instanceof Error
                ? verificationError.message
                : String(verificationError),
          },
          "worktree create failure could not be reconciled; retaining reservation"
        )
      }
      if (materializationVerifiedAbsent) {
        this.registry.delete(worktreeId)
      }
      const message = err instanceof Error ? err.message : String(err)
      logger.error(
        {
          threadId,
          baseRepoPath,
          baseBranch,
          branch,
          worktreePath,
          err: message,
        },
        "worktree create failed"
      )
      throw new Error(`git worktree add failed: ${message}`)
    }

    const headSha = await gitHeadSha(worktreePath)

    // Transition registry → ready, update thread projection, append event.
    this.db.transaction(() => {
      this.registry.updateState(worktreeId, "ready", new Date().toISOString())
      this.writeThreadMetadata(threadId, {
        envMode: "worktree",
        worktreePath,
        branch,
        baseBranch,
        worktreeState: "ready",
      })
      this.appendEvent(threadId, "WorktreeCreated", {
        thread_id: threadId,
        worktree_id: worktreeId,
        worktree_path: worktreePath,
        branch,
        base_branch: baseBranch,
        base_repo_path: path.resolve(baseRepoPath),
        head_sha: headSha,
      })
    })()

    logger.info(
      { threadId, branch, worktreePath, baseBranch },
      "worktree created"
    )

    return {
      worktreeId,
      threadId,
      worktreePath,
      branch,
      baseBranch,
      headSha,
    }
  }

  /**
   * Tear down the worktree for `threadId`.
   *
   * `deleteBranch: true` additionally removes the branch ref — safe ONLY
   * when the branch isn't referenced by an open PR. Defaults to `false`
   * so the branch survives worktree removal (re-creatable from its ref).
   */
  async removeForThread(
    threadId: string,
    opts: { deleteBranch?: boolean; force?: boolean } = {}
  ): Promise<void> {
    const entry = this.registry.findByThread(threadId)
    if (!entry) return

    const deleteBranch =
      entry.delete_branch_on_remove === 1 || opts.deleteBranch === true
    this.registry.markRemoving(
      entry.worktree_id,
      deleteBranch,
      new Date().toISOString()
    )

    let physicallyRemoved = false
    try {
      await gitRemoveWorktree(entry.base_repo_path, entry.worktree_path, {
        force: opts.force ?? true,
      })
      physicallyRemoved = true
    } catch (err) {
      // The worktree might already be gone (user `rm -rf`'d it, crash
      // cleanup, etc.). Prune so the git admin state stays consistent.
      logger.warn(
        { threadId, err: err instanceof Error ? err.message : String(err) },
        "worktree remove failed; attempting prune"
      )
      try {
        await gitPruneWorktrees(entry.base_repo_path)
      } catch {
        /* best-effort */
      }
      physicallyRemoved =
        !(await this.isRegisteredWithGit(
          entry.base_repo_path,
          entry.worktree_path
        )) && !fs.existsSync(entry.worktree_path)
      if (!physicallyRemoved) {
        throw Object.assign(
          new Error(
            `Worktree removal failed and the worktree is still present: ${
              err instanceof Error ? err.message : String(err)
            }`
          ),
          { statusCode: 409, code: "worktree_removal_incomplete" }
        )
      }
    }

    if (deleteBranch) {
      try {
        await gitDeleteBranch(entry.base_repo_path, entry.branch, true)
      } catch (err) {
        throw Object.assign(
          new Error(
            `Worktree was removed, but branch '${entry.branch}' could not be deleted: ${
              err instanceof Error ? err.message : String(err)
            }`
          ),
          {
            statusCode: 409,
            code: "worktree_branch_cleanup_incomplete",
            physicallyRemoved,
          }
        )
      }
    }

    this.db.transaction(() => {
      this.writeThreadMetadata(threadId, {
        envMode: "local",
        worktreePath: null,
        branch: null,
        baseBranch: null,
        worktreeState: "abandoned",
      })
      this.appendEvent(threadId, "WorktreeRemoved", {
        thread_id: threadId,
        worktree_id: entry.worktree_id,
        branch: entry.branch,
        deleted_branch: deleteBranch,
      })
      this.registry.delete(entry.worktree_id)
    })()

    logger.info({ threadId, branch: entry.branch }, "worktree removed")
  }

  /**
   * Hard-reset the isolated worktree for a thread back to its base branch.
   * This mirrors the compatibility source's workspace reset semantics while refusing to touch
   * the primary repository workspace.
   */
  async resetForThread(
    threadId: string,
    opts: { clean?: boolean; updateSubmodules?: boolean } = {}
  ): Promise<WorktreeResetResult> {
    const entry = this.registry.findByThread(threadId)
    if (!entry) {
      throw Object.assign(
        new Error("No isolated worktree is registered for this thread"),
        { statusCode: 404 }
      )
    }

    const baseRepoPath = path.resolve(entry.base_repo_path)
    const worktreePath = path.resolve(entry.worktree_path)
    if (canonicalPath(baseRepoPath) === canonicalPath(worktreePath)) {
      throw Object.assign(new Error("Cannot reset the primary workspace"), {
        statusCode: 400,
      })
    }

    await gitResetWorktree(baseRepoPath, worktreePath, entry.base_branch, {
      clean: opts.clean ?? true,
      updateSubmodules: opts.updateSubmodules ?? true,
    })

    const headSha = await gitHeadSha(worktreePath)
    this.db.transaction(() => {
      this.registry.updateState(
        entry.worktree_id,
        "ready",
        new Date().toISOString()
      )
      this.writeThreadMetadata(threadId, {
        envMode: "worktree",
        worktreePath: entry.worktree_path,
        branch: entry.branch,
        baseBranch: entry.base_branch,
        worktreeState: "ready",
      })
      this.appendEvent(threadId, "WorktreeReset", {
        thread_id: threadId,
        worktree_id: entry.worktree_id,
        worktree_path: entry.worktree_path,
        branch: entry.branch,
        base_branch: entry.base_branch,
        head_sha: headSha,
        clean: opts.clean ?? true,
        update_submodules: opts.updateSubmodules ?? true,
      })
    })()

    logger.info(
      { threadId, branch: entry.branch, worktreePath: entry.worktree_path },
      "worktree reset"
    )

    return {
      worktreeId: entry.worktree_id,
      threadId: entry.thread_id,
      worktreePath: entry.worktree_path,
      branch: entry.branch,
      baseBranch: entry.base_branch,
      headSha,
    }
  }

  /** All currently-registered worktrees across all threads. */
  listActive(): WorktreeRegistryEntry[] {
    return this.registry.listAll()
  }

  /** Lookup for a specific thread, or null if the thread has no worktree. */
  findForThread(threadId: string): WorktreeRegistryEntry | null {
    return this.registry.findByThread(threadId)
  }

  /** True when `branch` is NOT checked out in any registered worktree. */
  isBranchAvailable(branch: string): boolean {
    return this.registry.findByBranch(branch) === null
  }

  /**
   * Transition a worktree's lifecycle state. No-ops silently if no worktree
   * is registered for the thread — callers don't need to guard.
   */
  async transitionState(
    threadId: string,
    newState: WorktreeState
  ): Promise<void> {
    const entry = this.registry.findByThread(threadId)
    if (!entry || entry.state === newState) return

    const now = new Date().toISOString()
    this.db.transaction(() => {
      this.registry.updateState(entry.worktree_id, newState, now)
      this.writeThreadMetadata(threadId, { worktreeState: newState })
      this.appendEvent(threadId, "WorktreeStateChanged", {
        thread_id: threadId,
        worktree_id: entry.worktree_id,
        from: entry.state,
        to: newState,
      })
    })()
  }

  /**
   * Reconciles registry rows against what git reports. Useful on backend
   * boot: registry entries whose on-disk worktrees vanished get cleaned up
   * so stale state doesn't block re-creation.
   */
  async reconcile(baseRepoPath: string): Promise<{ removed: number }> {
    let removed = 0
    const resolvedBaseRepoPath = path.resolve(baseRepoPath)
    let worktrees: Awaited<ReturnType<typeof gitListWorktrees>>
    try {
      worktrees = await gitListWorktrees(resolvedBaseRepoPath)
    } catch (err) {
      logger.warn(
        {
          baseRepoPath: resolvedBaseRepoPath,
          err: err instanceof Error ? err.message : String(err),
        },
        "worktree reconcile could not list repository worktrees"
      )
      return { removed }
    }

    const livePaths = new Set(worktrees.map((w) => path.resolve(w.path)))
    for (const entry of this.registry.listAll()) {
      if (entry.base_repo_path !== resolvedBaseRepoPath) continue
      try {
        const isLive = livePaths.has(path.resolve(entry.worktree_path))
        if (entry.state === "removing") {
          // removeForThread reads the durable branch-deletion intent. This
          // also completes the phase where Git already removed the worktree
          // but the process exited before deleting the branch or registry row.
          await this.removeForThread(entry.thread_id, { force: true })
          removed += 1
          continue
        }
        if (isLive && entry.state === "creating") {
          await this.recoverExistingCreation(entry)
          continue
        }
        if (!isLive && !fs.existsSync(entry.worktree_path)) {
          this.db.transaction(() => {
            this.writeThreadMetadata(entry.thread_id, {
              envMode: "local",
              worktreePath: null,
              branch: null,
              baseBranch: null,
              worktreeState: "abandoned",
            })
            this.appendEvent(entry.thread_id, "WorktreeReconciledMissing", {
              thread_id: entry.thread_id,
              worktree_id: entry.worktree_id,
              prior_state: entry.state,
            })
            this.registry.delete(entry.worktree_id)
          })()
          removed += 1
        }
      } catch (err) {
        logger.warn(
          {
            baseRepoPath: resolvedBaseRepoPath,
            threadId: entry.thread_id,
            worktreeId: entry.worktree_id,
            err: err instanceof Error ? err.message : String(err),
          },
          "worktree reconcile entry failed; continuing with remaining entries"
        )
      }
    }
    return { removed }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async allocateUniqueBranch(
    threadId: string,
    firstMessage: string | undefined | null
  ): Promise<string> {
    const candidate = buildBranchName(threadId, firstMessage)
    if (this.isBranchAvailable(candidate)) return candidate

    // A registered collision. Append a short random suffix. We don't
    // iterate-and-retry more than once because the short-thread-id prefix
    // normally distinguishes UUIDs; registry constraints reject collisions.
    const suffix = randomUUID().replace(/-/g, "").slice(0, 4)
    return `${candidate}-${suffix}`
  }

  // The chat's env mode follows its worktree here, where the worktree is
  // made and removed, instead of relying on the client that asked to also
  // write it back: a paired phone creates worktrees without writing the
  // chat's whole metadata.
  private writeThreadMetadata(
    threadId: string,
    patch: {
      envMode?: "local" | "worktree"
      worktreePath?: string | null
      branch?: string | null
      baseBranch?: string | null
      worktreeState?: WorktreeState
    }
  ): void {
    const fields: string[] = []
    const values: Array<string | null> = []
    if (patch.envMode !== undefined) {
      fields.push("env_mode = ?")
      values.push(patch.envMode)
    }
    if (patch.worktreePath !== undefined) {
      fields.push("worktree_path = ?")
      values.push(patch.worktreePath)
    }
    if (patch.branch !== undefined) {
      fields.push("branch = ?")
      values.push(patch.branch)
    }
    if (patch.baseBranch !== undefined) {
      fields.push("base_branch = ?")
      values.push(patch.baseBranch)
    }
    if (patch.worktreeState !== undefined) {
      fields.push("worktree_state = ?")
      values.push(patch.worktreeState)
    }
    if (fields.length === 0) return
    fields.push("updated_at = ?")
    values.push(new Date().toISOString())
    values.push(threadId)

    // Prepared on the fly on purpose: this runs once per worktree lifecycle
    // change, not per turn, so re-planning one of the 16 field combinations
    // costs nothing measurable. (better-sqlite3 does NOT cache prepares — a
    // hot path must hold its Statement in a field instead.)
    this.db
      .prepare(
        `UPDATE projection_threads SET ${fields.join(", ")} WHERE thread_id = ?`
      )
      .run(...values)
  }

  private appendEvent(
    threadId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): void {
    try {
      // EventStore.append is synchronous. This method participates in the
      // caller's SQLite transaction, so failures must propagate and roll the
      // registry/projection mutation back with the event append.
      this.eventStore.append([
        {
          event_id: randomUUID(),
          aggregate_kind: WORKTREE_EVENT_STREAM_KIND,
          stream_id: threadId,
          stream_version:
            this.eventStore.latestStreamVersion(
              WORKTREE_EVENT_STREAM_KIND,
              threadId
            ) + 1,
          event_type: eventType,
          occurred_at: new Date().toISOString(),
          command_id: null,
          causation_event_id: null,
          correlation_id: null,
          actor_kind: "system",
          payload_json: JSON.stringify(payload),
          metadata_json: "{}",
        },
      ])
    } catch (err) {
      // Log with context, then rethrow: the append shares the caller's
      // transaction, so the registry/projection mutation rolls back with it
      // rather than leaving a worktree row without its lifecycle event.
      logger.error(
        {
          threadId,
          eventType,
          err: err instanceof Error ? err.message : String(err),
        },
        "worktree event append failed"
      )
      throw err
    }
  }

  private async recoverExistingCreation(
    existing: WorktreeRegistryEntry
  ): Promise<WorktreeCreateResult | null> {
    const materialized = await this.isRegisteredWithGit(
      existing.base_repo_path,
      existing.worktree_path
    )
    if (!materialized) {
      if (fs.existsSync(existing.worktree_path)) {
        throw Object.assign(
          new Error(
            `Worktree '${existing.worktree_path}' exists but Git does not recognize it; manual recovery is required.`
          ),
          { statusCode: 409, code: "worktree_recovery_required" }
        )
      }
      this.registry.delete(existing.worktree_id)
      return null
    }

    const headSha = await gitHeadSha(existing.worktree_path)
    if (existing.state === "creating") {
      this.db.transaction(() => {
        this.registry.updateState(
          existing.worktree_id,
          "ready",
          new Date().toISOString()
        )
        this.writeThreadMetadata(existing.thread_id, {
          worktreePath: existing.worktree_path,
          branch: existing.branch,
          baseBranch: existing.base_branch,
          worktreeState: "ready",
        })
        this.appendEvent(existing.thread_id, "WorktreeCreationRecovered", {
          thread_id: existing.thread_id,
          worktree_id: existing.worktree_id,
          worktree_path: existing.worktree_path,
          branch: existing.branch,
          base_branch: existing.base_branch,
          head_sha: headSha,
        })
      })()
    }
    return {
      worktreeId: existing.worktree_id,
      threadId: existing.thread_id,
      worktreePath: existing.worktree_path,
      branch: existing.branch,
      baseBranch: existing.base_branch,
      headSha,
    }
  }

  private async isRegisteredWithGit(
    baseRepoPath: string,
    worktreePath: string
  ): Promise<boolean> {
    const expected = canonicalPath(worktreePath)
    return (await gitListWorktrees(baseRepoPath)).some(
      (worktree) => canonicalPath(worktree.path) === expected
    )
  }
}

function canonicalPath(input: string): string {
  try {
    return fs.realpathSync.native(input)
  } catch {
    return path.resolve(input)
  }
}
