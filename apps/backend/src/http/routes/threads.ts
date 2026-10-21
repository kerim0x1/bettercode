import type { Context, Hono, Next } from "hono"
import { CHAT_FIND_QUERY_MAX_LENGTH } from "@betterc0de/schema"
import fs from "node:fs/promises"
import path from "node:path"
import type { AppState } from "../../appState"
import { logger } from "../../observability/logger"
import {
  decodeThreadActivityCursor,
  encodeThreadActivityCursor,
} from "../../persistence/projections"
import { boundThreadActivity } from "../../provider/activity-projection"
import { readThreadActivityFullOutput } from "../../provider/activity-projection/full-output"
import {
  cancelPendingApprovals,
  forgetSessionPermission,
} from "../../provider/permissions"
import { clearSessionRules } from "../../provider/session-permission-rules"
import * as git from "../../services/git"
import { deleteThreadCheckpointRefs } from "../../services/git"
import { threadGoals } from "../../services/chat/goal-registry"
import { threadAutonomyRuns } from "../../services/chat/autonomy-registry"
import { chatResumes } from "../../services/chat/resume-registry"
import { assertThreadSettingsPatchAllowed } from "../../services/chat/thread-settings"
import {
  parseThreadMessageUpsertRequest,
  parseThreadMetaUpsertRequest,
  parseThreadSaveRequest,
  parseThreadTruncateRequest,
} from "../../services/threads"
import {
  assertThreadRecoveryComplete,
  recoveryWorkspacesForThread,
  withCheckpointRecoveryExclusiveMutation,
  withCheckpointRecoveryMutation,
} from "../checkpointRecoveryFence"
import { requestIdentity } from "../../remote/http"
import { contractJson, contractResult, handleHttpContract } from "../contracts"
import { HttpError } from "../errors"
import {
  broadcastThreadMetadata,
  broadcastThreadSettings,
} from "../../ws/threadActivityBroadcast"
import {
  latestCheckpointTurnCount,
  revertThreadCheckpoint,
  withCheckpointMaintenance,
} from "../../services/checkpoint-revert-saga"
import { permissionAccess } from "./chat"
import { resolveApprovedWorkspaceRoot } from "./workspace"

async function resolveThreadWorktreeMutationRoots(
  state: AppState,
  threadId: string
): Promise<string[]> {
  const entry =
    state.worktrees.findForThread(threadId) ??
    state.worktreeRegistry.findByThread(threadId) ??
    null
  if (!entry) return []

  const rawBaseRepoPath = entry.base_repo_path?.trim()
  const rawWorktreePath = entry.worktree_path?.trim()
  if (
    !rawBaseRepoPath ||
    !path.isAbsolute(rawBaseRepoPath) ||
    !rawWorktreePath ||
    !path.isAbsolute(rawWorktreePath)
  ) {
    throw new HttpError(
      403,
      "The registered worktree roots are invalid.",
      "worktree_root_invalid"
    )
  }
  const [baseRepoPath, resolvedWorktreePath] = await Promise.all(
    [rawBaseRepoPath, rawWorktreePath].map(async (registeredRoot) => {
      const resolved = path.resolve(registeredRoot)
      return await fs.realpath(resolved).catch(() => resolved)
    })
  )
  return [...new Set([baseRepoPath, resolvedWorktreePath])]
}

function assertWorktreeMutationTrusted(
  state: AppState,
  workspaceRoots: readonly string[],
  operation: string
): void {
  for (const workspacePath of workspaceRoots) {
    state.agentPermissions.assertWorkspaceTrusted({
      workspacePath,
      operation,
    })
  }
}

function shouldAutoSaveConversations(state: AppState): boolean {
  try {
    return state.settings.get().auto_save_conversations !== false
  } catch (error) {
    logger.warn(
      { error },
      "settings unavailable; conversation persistence disabled for request"
    )
    return false
  }
}

export function registerThreadsRoutes(api: Hono, state: AppState): void {
  const checkpointRecoveryFence = async (c: Context, next: Next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next()
    const path = c.req.path
    if (
      path.endsWith("/checkpoint/revert") ||
      path.endsWith("/checkpoint-recovery/resolve")
    ) {
      return next()
    }
    const threadId = c.req.param("id")
    if (threadId) assertThreadRecoveryComplete(state, threadId)
    return next()
  }
  api.use("/threads/:id", checkpointRecoveryFence)
  api.use("/threads/:id/*", checkpointRecoveryFence)

  api.get("/threads", (c) => {
    const cursor = decodeThreadListCursor(c.req.query("cursor"))
    if (cursor === false) {
      return c.json({ error: "invalid thread pagination cursor" }, 400)
    }
    const limit = optionalThreadPageLimit(c.req.query("limit"))
    if (limit === false) {
      return c.json(
        { error: "thread pagination limit must be an integer from 1 to 200" },
        400
      )
    }
    const page = state.threads.listThreadsPage({
      limit,
      beforeUpdatedAt: cursor?.updatedAt,
      beforeThreadId: cursor?.threadId,
    })
    if (page.next) {
      c.header(
        "X-Next-Cursor",
        Buffer.from(JSON.stringify(page.next), "utf8").toString("base64url")
      )
      c.header("Access-Control-Expose-Headers", "X-Next-Cursor")
    }
    return contractJson(c, "listThreads", page.items)
  })

  api.get("/threads/stats", (c) => {
    const rawDays = c.req.query("days")
    const days =
      rawDays === undefined || rawDays.trim() === ""
        ? undefined
        : Number(rawDays)
    return contractResult(
      c,
      "threadStats",
      state.threads.stats({
        // Whole days in [1, 3650]: the window is a SQL date comparison and
        // a cache key, so 0, negatives, fractions and huge values are noise.
        days:
          days !== undefined && Number.isFinite(days)
            ? Math.min(3_650, Math.max(1, Math.trunc(days)))
            : undefined,
        projectPath: c.req.query("projectPath") ?? null,
      })
    )
  })

  // After `/threads/stats`, so that path is never read as a thread id.
  api.get("/threads/:id", (c) => {
    const thread = state.threads.getThreadSummary(c.req.param("id"))
    if (!thread) {
      return c.json(
        { error: "thread not found", code: "thread_not_found" },
        404
      )
    }
    return contractJson(c, "getThread", thread)
  })

  api.post("/threads", (c) =>
    handleHttpContract(
      c,
      "saveThread",
      async (parsed) => {
        // The schema validates structure; parseThreadSaveRequest does the
        // additional contract conversion to ThreadSaveRequest. zod has
        // already filled defaults so the parsers see the same field set
        // they used to see in the raw body.
        const req = parseThreadSaveRequest(parsed)
        // Registered roots are derived from saved threads, so a saved
        // project path *is* a registration. A paired device may work in
        // the workspaces the desktop opened, never open one of its own.
        if (
          req.project_path &&
          requestIdentity(c, state.config, state)?.kind === "remote"
        ) {
          await resolveApprovedWorkspaceRoot(state, req.project_path)
        }
        await withCheckpointRecoveryMutation(
          state,
          {
            threadIds: [req.thread_id],
            workspaces: [
              ...(req.project_path ? [req.project_path] : []),
              ...recoveryWorkspacesForThread(state, req.thread_id),
            ],
          },
          () => {
            if (!shouldAutoSaveConversations(state)) {
              state.threads.upsertThreadMeta(req)
            } else {
              state.threads.save(req)
            }
          }
        )
        return undefined
      },
      { operation: "thread save" }
    )
  )

  api.patch("/threads/:id", (c) =>
    handleHttpContract(
      c,
      "updateThread",
      async (parsed, ctx) => {
        const threadId = ctx.req.param("id")!
        // `{ settings }` alone: the chat's own settings, nothing else. A
        // paired device keeps the limits it has for a turn.
        if ("settings" in parsed) {
          assertThreadSettingsPatchAllowed(
            parsed.settings,
            permissionAccess(state, ctx)
          )
          const settings = await withCheckpointRecoveryMutation(
            state,
            {
              threadIds: [threadId],
              workspaces: recoveryWorkspacesForThread(state, threadId),
            },
            () => state.threads.updateThreadSettings(threadId, parsed.settings)
          )
          // Every other open client follows the change at once.
          broadcastThreadSettings({ threadId, settings })
          return undefined
        }
        const req = parseThreadMetaUpsertRequest(threadId, parsed)
        await withCheckpointRecoveryMutation(
          state,
          {
            threadIds: [threadId],
            workspaces: recoveryWorkspacesForThread(state, threadId),
          },
          () => state.threads.upsertThreadMeta(req)
        )
        return undefined
      },
      { operation: "thread meta upsert" }
    )
  )

  // A rename changes the title and nothing else, and every client hears it:
  // clients keep their own copy of a chat's metadata and write all of it
  // back (PATCH above), so a title changed elsewhere would otherwise be
  // overwritten by the next such write.
  api.post("/threads/:id/title", (c) =>
    handleHttpContract(
      c,
      "renameThread",
      async (parsed, ctx) => {
        const threadId = ctx.req.param("id")!
        if (!state.threads.hasThread(threadId)) {
          throw new HttpError(404, "thread not found", "thread_not_found")
        }
        const updatedAt = new Date().toISOString()
        await withCheckpointRecoveryMutation(
          state,
          {
            threadIds: [threadId],
            workspaces: recoveryWorkspacesForThread(state, threadId),
          },
          () =>
            state.threads.updateThreadTitle(threadId, parsed.title, updatedAt)
        )
        const update = { threadId, title: parsed.title, updatedAt }
        broadcastThreadMetadata(update)
        return update
      },
      { operation: "thread rename" }
    )
  )

  // Find in chat over the stored messages, for the part of a long chat the
  // renderer has not loaded (`?beforeSequence=`). Read-only, so a paired
  // device may search any chat it can read. Registered before
  // `/messages/:messageId`, which would otherwise take "search" as an id.
  api.get("/threads/:id/messages/search", (c) => {
    const query = c.req.query("q") ?? ""
    if (!query.trim() || query.length > CHAT_FIND_QUERY_MAX_LENGTH) {
      return c.json(
        {
          error: `q must be 1 to ${CHAT_FIND_QUERY_MAX_LENGTH} characters`,
          code: "invalid_search_query",
        },
        400
      )
    }
    return contractResult(
      c,
      "searchThreadMessages",
      state.threads.searchMessages(c.req.param("id"), {
        query,
        caseSensitive: queryFlag(c.req.query("caseSensitive")),
        beforeSequence: optionalQueryInteger(c.req.query("beforeSequence")),
        limit: optionalQueryInteger(c.req.query("limit")),
      })
    )
  })

  // `light=1` leaves out diff text and inline `data:` attachment payloads
  // (flagged `textOmitted` / `dataOmitted`); the route below returns one
  // message in full when the renderer actually shows one of them.
  api.get("/threads/:id/messages", (c) =>
    contractJson(
      c,
      "listMessages",
      state.threads.listMessages(c.req.param("id"), {
        limit: optionalQueryInteger(c.req.query("limit")),
        beforeSequence: optionalQueryInteger(c.req.query("beforeSequence")),
        ...(queryFlag(c.req.query("light")) ? { light: true } : {}),
      })
    )
  )

  api.get("/threads/:id/messages/:messageId", (c) => {
    const message = state.threads.getMessageView(
      c.req.param("id"),
      c.req.param("messageId")
    )
    if (!message) {
      return c.json(
        { error: "message not found", code: "message_not_found" },
        404
      )
    }
    return contractJson(c, "getMessage", message)
  })

  api.post("/threads/:id/activities/model-switch", (c) =>
    handleHttpContract(
      c,
      "saveModelSwitchActivity",
      async (body, context) => {
        if (body.activityId.startsWith("orchestrator:"))
          throw new HttpError(400, "Reserved activity ID.")
        const threadId = context.req.param("id")!
        // The activity id is client-chosen and the store upserts by id: an
        // id that already belongs to another thread must not be moved here.
        const owner = activityThreadOwner(state, body.activityId)
        if (owner !== null && owner !== threadId) {
          throw new HttpError(
            409,
            "This activity id belongs to a different thread.",
            "activity_thread_mismatch"
          )
        }
        const activity = {
          activity_id: body.activityId,
          thread_id: threadId,
          turn_id: null,
          provider_instance_id: null,
          kind: "session.model.switched",
          tone: "info" as const,
          summary: `Model switched from ${body.fromModelId} to ${body.toModelId}.`,
          payload: {
            fromModelId: body.fromModelId,
            toModelId: body.toModelId,
          },
          sequence: null,
          created_at: body.createdAt,
        }
        state.threadActivities.upsert(activity)
        return {
          id: activity.activity_id,
          threadId: activity.thread_id,
          turnId: activity.turn_id,
          providerInstanceId: activity.provider_instance_id,
          kind: activity.kind,
          tone: activity.tone,
          summary: activity.summary,
          payload: activity.payload,
          sequence: activity.sequence,
          createdAt: activity.created_at,
        }
      },
      { operation: "thread model switch activity" }
    )
  )

  api.get("/threads/:id/activities", (c) => {
    const cursor = decodeThreadActivityCursor(c.req.query("cursor"))
    if (cursor === false) {
      return c.json({ error: "invalid activity pagination cursor" }, 400)
    }
    const limit = optionalActivityPageLimit(c.req.query("limit"))
    if (limit === false) {
      return c.json(
        {
          error: "activity pagination limit must be an integer from 1 to 1000",
        },
        400
      )
    }
    const beforeSequence = optionalActivityBeforeSequence(
      c.req.query("beforeSequence")
    )
    if (beforeSequence === false) {
      return c.json(
        {
          error: "activity beforeSequence must be a non-negative safe integer",
        },
        400
      )
    }
    if (cursor && beforeSequence !== undefined) {
      return c.json(
        {
          error: "activity cursor and beforeSequence cannot be used together",
        },
        400
      )
    }

    const page = state.threadActivities.listByThreadPage(c.req.param("id"), {
      limit,
      before: cursor ?? undefined,
      beforeSequence,
    })
    if (page.next) {
      c.header("X-Next-Cursor", encodeThreadActivityCursor(page.next))
      c.header("Access-Control-Expose-Headers", "X-Next-Cursor")
    }
    return contractJson(
      c,
      "listActivities",
      // Rows stored before tool output (and approval input) was bounded at
      // projection are bounded on the way out; current rows are already
      // within budget.
      page.items.map(boundThreadActivity).map((activity) => ({
        id: activity.activity_id,
        threadId: activity.thread_id,
        turnId: activity.turn_id,
        providerInstanceId: activity.provider_instance_id ?? null,
        kind: activity.kind,
        tone: activity.tone,
        summary: activity.summary,
        payload: activity.payload,
        sequence: activity.sequence ?? null,
        createdAt: activity.created_at,
      }))
    )
  })

  // The whole output of a tool activity whose payload carries a cut copy
  // (`outputTruncated`), read back from the provider runtime journal while
  // the journal still retains the event. `truncated` means the journal had
  // to bound the event itself, so even this copy is incomplete.
  api.get("/threads/:id/activities/:activityId/output", (c) => {
    const result = readThreadActivityFullOutput(
      { activities: state.threadActivities, events: state.eventStore },
      c.req.param("id"),
      c.req.param("activityId")
    )
    switch (result.status) {
      case "found":
        return contractResult(c, "threadActivityOutput", {
          activityId: result.activityId,
          output: result.output,
          truncated: result.truncated,
          bytes: result.bytes,
        })
      case "not_found":
        return c.json(
          { error: "activity not found", code: "activity_not_found" },
          404
        )
      case "no_output":
        return c.json(
          {
            error: "This activity has no tool output.",
            code: "activity_output_not_found",
          },
          404
        )
      case "not_retained":
        return c.json(
          {
            error: "The full output of this tool call is no longer retained.",
            code: "activity_output_not_retained",
          },
          404
        )
    }
  })

  api.get("/threads/:id/diffs", (c) => {
    const threadId = c.req.param("id")
    // `summary=1` answers "how far can this thread be restored?" from the
    // checkpoint refs and turn index alone, without materialising any diff
    // body. `/undo` and other counters use it instead of the full pages.
    if (c.req.query("summary") === "1") {
      return contractResult(c, "threadCheckpointSummary", {
        threadId,
        currentTurnCount: latestCheckpointTurnCount(state, threadId),
      })
    }
    const pageSize = Math.min(
      MAX_DIFF_PAGE_LIMIT,
      Math.max(
        1,
        optionalQueryInteger(c.req.query("limit")) ?? MAX_DIFF_PAGE_LIMIT
      )
    )
    const turnDiffs = state.checkpointDiffs.listTurnDiffsByThread(threadId, {
      limit: pageSize,
      beforeTurnIndex: optionalQueryInteger(c.req.query("beforeTurnIndex")),
    })
    const checkpointDiffs = state.checkpointDiffs.listCheckpointDiffsByThread(
      threadId,
      {
        limit: pageSize,
        beforeId: optionalQueryInteger(c.req.query("beforeCheckpointId")),
      }
    )
    // Pages are returned oldest-first; a full page means older rows may
    // remain, so hand back the cursor for the next (older) page.
    const fullPage = (count: number) => count >= pageSize
    return contractResult(c, "threadDiffs", {
      turnDiffs: turnDiffs.map((diff) => ({
        threadId: diff.thread_id,
        turnIndex: diff.turn_index,
        diffText: diff.diff_text,
        filesChanged: diff.files_changed,
        insertions: diff.insertions,
        deletions: diff.deletions,
        createdAt: diff.created_at,
      })),
      checkpointDiffs: checkpointDiffs.map((diff) => ({
        id: diff.id,
        threadId: diff.thread_id,
        turnId: diff.turn_id,
        checkpointRef: diff.checkpoint_ref,
        diffContent: diff.diff_content,
        createdAt: diff.created_at,
      })),
      nextBeforeTurnIndex:
        turnDiffs.length > 0 && fullPage(turnDiffs.length)
          ? turnDiffs[0]!.turn_index
          : null,
      nextBeforeCheckpointId:
        checkpointDiffs.length > 0 && fullPage(checkpointDiffs.length)
          ? checkpointDiffs[0]!.id
          : null,
    })
  })

  api.get("/threads/:id/checkpoint-recovery", (c) => {
    const threadId = c.req.param("id")
    const store = state.checkpointReverts
    const pending = store?.get(threadId) ?? null
    return contractResult(c, "threadCheckpointRecovery", {
      recoveryRequired:
        store && typeof store.hasRecoveryRequired === "function"
          ? store.hasRecoveryRequired(threadId)
          : false,
      pending,
      quarantined:
        store && typeof store.listQuarantined === "function"
          ? store.listQuarantined(threadId)
          : [],
    })
  })

  api.post("/threads/:id/checkpoint-recovery/resolve", (c) =>
    handleHttpContract(
      c,
      "resolveThreadCheckpointRecovery",
      async (_parsed, ctx) => {
        const threadId = ctx.req.param("id")!
        const store = state.checkpointReverts
        if (store && typeof store.resolveQuarantine === "function") {
          store.resolveQuarantine(threadId)
        }
        return { ok: true as const }
      },
      { operation: "checkpoint recovery quarantine resolve" }
    )
  )

  api.post("/threads/:id/messages", (c) =>
    handleHttpContract(
      c,
      "saveMessage",
      async (parsed, ctx) => {
        const threadId = ctx.req.param("id")!
        const req = parseThreadMessageUpsertRequest(threadId, parsed)
        await withCheckpointRecoveryMutation(
          state,
          {
            threadIds: [threadId],
            workspaces: recoveryWorkspacesForThread(state, threadId),
          },
          () => {
            if (shouldAutoSaveConversations(state)) {
              state.threads.upsertMessage(req)
            }
          }
        )
        return undefined
      },
      { operation: "thread message upsert" }
    )
  )

  api.post("/threads/:id/truncate", (c) =>
    handleHttpContract(
      c,
      "truncateThread",
      async (parsed) => {
        const threadId = c.req.param("id")
        const req = parseThreadTruncateRequest(threadId, parsed)
        return withCheckpointRecoveryMutation(
          state,
          {
            threadIds: [threadId],
            workspaces: recoveryWorkspacesForThread(state, threadId),
          },
          () =>
            withCheckpointMaintenance(state, threadId, () =>
              state.threads.truncateAfterMessage(req)
            )
        )
      },
      { operation: "thread truncate" }
    )
  )

  api.post("/threads/:id/checkpoint/revert", (c) =>
    handleHttpContract(
      c,
      "revertThreadCheckpoint",
      async (parsed) => {
        const threadId = c.req.param("id")
        return withCheckpointMaintenance(state, threadId, () =>
          revertThreadCheckpoint({
            state,
            threadId,
            turnCount: parsed.turnCount,
            updatedAt: parsed.updatedAt ?? new Date().toISOString(),
            preserveFuture: parsed.preserveFuture,
          })
        )
      },
      { operation: "thread checkpoint revert" }
    )
  )

  api.post("/threads/:id/worktree", (c) =>
    handleHttpContract(
      c,
      "createThreadWorktree",
      async (parsed) => {
        const threadId = c.req.param("id")
        const baseRepoPath = await resolveApprovedWorkspaceRoot(
          state,
          parsed.baseRepoPath
        )
        assertWorktreeMutationTrusted(
          state,
          [baseRepoPath],
          "create a thread worktree"
        )
        return withCheckpointRecoveryMutation(
          state,
          {
            threadIds: [threadId],
            workspaces: [
              baseRepoPath,
              ...recoveryWorkspacesForThread(state, threadId),
            ],
          },
          async () => {
            const baseBranch =
              parsed.baseBranch?.trim() ||
              (await git.listBranches(baseRepoPath)).current
            if (!baseBranch) {
              throw Object.assign(
                new Error("Unable to resolve base branch for worktree"),
                { statusCode: 400 }
              )
            }
            return state.worktrees.createForThread({
              threadId,
              baseRepoPath,
              baseBranch,
              firstMessage: parsed.firstMessage ?? null,
            })
          }
        )
      },
      { operation: "thread worktree create" }
    )
  )

  api.post("/threads/:id/worktree/remove", (c) =>
    handleHttpContract(
      c,
      "removeThreadWorktree",
      async (parsed) => {
        const threadId = c.req.param("id")
        const workspaceRoots = await resolveThreadWorktreeMutationRoots(
          state,
          threadId
        )
        assertWorktreeMutationTrusted(
          state,
          workspaceRoots,
          "remove a thread worktree"
        )
        await withThreadTeardown(state, threadId, () =>
          withCheckpointRecoveryExclusiveMutation(
            state,
            {
              threadIds: [threadId],
              workspaces: recoveryWorkspacesForThread(state, threadId),
            },
            () =>
              state.worktrees.removeForThread(threadId, {
                deleteBranch: parsed.deleteBranch,
                force: parsed.force,
              })
          )
        )
        return { ok: true as const }
      },
      { operation: "thread worktree remove" }
    )
  )

  api.post("/threads/:id/worktree/reset", (c) =>
    handleHttpContract(
      c,
      "resetThreadWorktree",
      async (parsed) => {
        const threadId = c.req.param("id")
        const workspaceRoots = await resolveThreadWorktreeMutationRoots(
          state,
          threadId
        )
        assertWorktreeMutationTrusted(
          state,
          workspaceRoots,
          "reset a thread worktree"
        )
        return withThreadTeardown(state, threadId, () =>
          withCheckpointRecoveryExclusiveMutation(
            state,
            {
              threadIds: [threadId],
              workspaces: recoveryWorkspacesForThread(state, threadId),
            },
            () =>
              state.worktrees.resetForThread(threadId, {
                clean: parsed.clean,
                updateSubmodules: parsed.updateSubmodules,
              })
          )
        )
      },
      { operation: "thread worktree reset" }
    )
  )

  api.delete("/threads/:id", async (c) => {
    const threadId = c.req.param("id")
    await withThreadTeardown(state, threadId, () =>
      withCheckpointRecoveryExclusiveMutation(
        state,
        {
          threadIds: [threadId],
          workspaces: recoveryWorkspacesForThread(state, threadId),
        },
        async () => {
          await state.checkpointReactor.forgetThread(threadId)
          const projectPath = state.threads.getThreadProjectPath?.(threadId)
          if (projectPath) {
            await deleteThreadCheckpointRefs(projectPath, threadId)
          }
          await state.worktrees.removeForThread(threadId, { force: true })
          await Promise.all(
            state.providerEventLoggers.map((eventLogger) =>
              eventLogger.removeThread(threadId)
            )
          )
          state.transcriptRecoveryStore.removeThread(threadId)
          cancelPendingApprovals(threadId)
          forgetSessionPermission(threadId)
          clearSessionRules(threadId)
          state.providers.forgetThread(threadId)
          threadGoals.get(state)?.forgetThread(threadId)
          threadAutonomyRuns.get(state)?.forgetThread(threadId)
          chatResumes.get(state)?.forgetThread(threadId)
          state.threads.delete(threadId)
          state.orchestrator.forgetThread(threadId)
        }
      )
    )
    return c.body(null, 204)
  })
}

/**
 * Which thread an activity id is currently stored under, or `null` when it is
 * unknown. The activity store exposes no lookup by id (persistence is
 * off-limits for this change), so this is the one read model query the route
 * runs itself. A state without a database (unit tests) has nothing to
 * conflict with.
 */
function activityThreadOwner(
  state: AppState,
  activityId: string
): string | null {
  const db = state.db as
    | { prepare?: (sql: string) => { get: (...args: unknown[]) => unknown } }
    | undefined
  if (!db || typeof db.prepare !== "function") return null
  const row = db
    .prepare(
      "SELECT thread_id FROM projection_thread_activities WHERE activity_id = ?"
    )
    .get(activityId) as { thread_id?: unknown } | undefined
  return typeof row?.thread_id === "string" ? row.thread_id : null
}

/**
 * Upper bound (and default) for one `/threads/:id/diffs` page per list. Each
 * row can carry a large diff body, so callers that only need counts use the
 * `summary=1` view and callers that need history page with the cursors.
 */
const MAX_DIFF_PAGE_LIMIT = 500

/** `1` / `true` turn a boolean query flag on; anything else leaves it off. */
function queryFlag(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase()
  return value === "1" || value === "true"
}

function optionalQueryInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function optionalThreadPageLimit(
  raw: string | undefined
): number | undefined | false {
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 1 && value <= 200
    ? value
    : false
}

function optionalActivityPageLimit(
  raw: string | undefined
): number | undefined | false {
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000
    ? value
    : false
}

function optionalActivityBeforeSequence(
  raw: string | undefined
): number | undefined | false {
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : false
}

function decodeThreadListCursor(
  raw: string | undefined
): { updatedAt: string; threadId: string } | null | false {
  if (raw === undefined || raw.trim() === "") return null
  if (raw.length > 2_048) return false
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    ) as { updatedAt?: unknown; threadId?: unknown }
    if (
      typeof parsed.updatedAt !== "string" ||
      parsed.updatedAt.length === 0 ||
      parsed.updatedAt.length > 128 ||
      typeof parsed.threadId !== "string" ||
      parsed.threadId.length === 0 ||
      parsed.threadId.length > 1_024
    ) {
      return false
    }
    return { updatedAt: parsed.updatedAt, threadId: parsed.threadId }
  } catch {
    return false
  }
}

async function withThreadTeardown<T>(
  state: AppState,
  threadId: string,
  operation: () => Promise<T>
): Promise<T> {
  await state.orchestrator.quiesceThread(threadId)
  // Outermost first: the cross-provider thread token, then the hub, then the
  // direct-API service, each refusing new work on the thread while it runs.
  return state.threadTurnCoordinator.withTeardown(threadId, () =>
    state.providerHub.withThreadTeardown(threadId, () =>
      state.providers.withThreadTeardown(threadId, operation)
    )
  )
}
