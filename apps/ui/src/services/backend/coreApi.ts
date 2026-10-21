import type { ThreadSettingsPatch } from "@betterc0de/schema"
import type {
  DeepgramAccessToken,
  ProjectSummary,
  ProviderUsageReport,
  RuntimeDebugInfo,
  RuntimeHeapSnapshotResult,
  ThreadActivityFullOutput,
  ThreadCheckpointSummary,
  ThreadDiffsPage,
  ThreadMessageSearchResult,
  ThreadUsageStats,
} from "@betterc0de/schema/http-contracts"
import { invokeContract } from "./contracts"
import { getConfig } from "./runtime"

// Every call goes through its shared contract
// (`@betterc0de/schema/http-contracts`): the request is checked before it is
// sent and the response validated before a caller sees it. The read models
// are defined once, in `@betterc0de/schema`, and re-exported here.
export type {
  DeepgramAccessToken,
  ProjectSummary,
  ProviderUsageReport,
  RuntimeCompatDebugInfo,
  RuntimeDebugInfo,
  RuntimeHeapSnapshotResult,
  ThreadActivityFullOutput,
  ThreadCheckpointSummary,
  ThreadDiffsPage,
  ThreadMessageSearchHit,
  ThreadMessageSearchResult,
  ThreadUsageStats,
  UsageDailyPoint,
  UsageEntry,
  UsageInsight,
  UsageLimit,
  UsageList,
  UsagePricing,
  UsageProviderId,
  UsageStatus,
  UsageSummary,
} from "@betterc0de/schema/http-contracts"

export type SettingsResponse = Record<string, unknown>

export const getSettings = () => invokeContract("getSettings")

export const getWsPort = async () => {
  const config = getConfig()
  if (config.port && config.port !== 3773) return config.port
  return invokeContract("wsPort").catch(() => config.port || 3773)
}

export const updateSettings = (patch: Record<string, unknown>) =>
  invokeContract("updateSettings", {
    args: { patch },
    method: "PATCH",
    body: { patch },
  })

/**
 * The user's rules (`rules.md`), to read: how a paired browser shows them.
 * A read-only session gets a 403 (`remote_read_only`), which the caller
 * explains, so it is not logged as a failure.
 */
export const getUserRules = (): Promise<{ content: string }> =>
  invokeContract("getUserRules", { silentStatuses: [403] })

export const createDeepgramAccessToken = (): Promise<DeepgramAccessToken> =>
  invokeContract("deepgramToken")

export const getRuntimeDebugInfo = (): Promise<RuntimeDebugInfo> =>
  invokeContract("runtimeDebugInfo")

export const writeRuntimeHeapSnapshot =
  (): Promise<RuntimeHeapSnapshotResult> =>
    invokeContract("runtimeHeapSnapshot")

export const saveThread = (thread: unknown) =>
  invokeContract("saveThread", {
    args: { thread },
    method: "POST",
    body: thread,
  })

export const upsertThreadMeta = (thread: unknown) =>
  invokeContract("updateThread", {
    id: (thread as { id: string }).id,
    args: { thread },
    method: "PATCH",
    body: thread,
  })

/**
 * Changes a chat's own settings kept by the backend (permission level,
 * model selection, orchestration); `null` clears a key. Nothing else of
 * the chat changes.
 */
export const updateThreadSettings = (
  threadId: string,
  settings: ThreadSettingsPatch
) =>
  invokeContract("updateThread", {
    id: threadId,
    args: { threadId, settings },
    method: "PATCH",
    body: { settings },
    // A chat the backend has not stored yet is retried by the caller.
    silentStatuses: [404],
  })

export const saveThreadMessage = (threadId: string, message: unknown) =>
  invokeContract("saveMessage", {
    id: threadId,
    args: { threadId, message },
    method: "POST",
    body: message,
  })

export const truncateThreadMessages = (
  threadId: string,
  messageId: string
): Promise<{ deletedMessages: number }> =>
  invokeContract("truncateThread", {
    id: threadId,
    body: { messageId, updatedAt: new Date().toISOString() },
  })

export const revertThreadCheckpoint = (
  threadId: string,
  turnCount: number,
  options: { preserveFuture?: boolean } = {}
): Promise<{
  reverted: boolean
  rolledBackTurns: number
  deletedMessages: number
  boundaryMessageId: string | null
  reason?: string
}> =>
  invokeContract("revertThreadCheckpoint", {
    id: threadId,
    body: {
      turnCount,
      updatedAt: new Date().toISOString(),
      preserveFuture: options.preserveFuture ?? false,
    },
  })

export interface ThreadWorktreeCreateResult {
  worktreeId: string
  threadId: string
  worktreePath: string
  branch: string
  baseBranch: string
  headSha: string | null
}

export const createThreadWorktree = (
  threadId: string,
  input: {
    baseRepoPath: string
    baseBranch?: string
    firstMessage?: string | null
  }
): Promise<ThreadWorktreeCreateResult> =>
  invokeContract("createThreadWorktree", { id: threadId, body: input })

export const removeThreadWorktree = (
  threadId: string,
  input: {
    deleteBranch?: boolean
    force?: boolean
  } = {}
): Promise<{ ok: true }> =>
  invokeContract("removeThreadWorktree", { id: threadId, body: input })

export const resetThreadWorktree = (
  threadId: string,
  input: {
    clean?: boolean
    updateSubmodules?: boolean
  } = {}
): Promise<ThreadWorktreeCreateResult> =>
  invokeContract("resetThreadWorktree", { id: threadId, body: input })

export const loadThreads = () => invokeContract("listThreads")

export const loadThreadStats = (
  options: {
    days?: number
    projectPath?: string | null
  } = {}
): Promise<ThreadUsageStats> => {
  const params = new URLSearchParams()
  if (typeof options.days === "number" && Number.isFinite(options.days)) {
    params.set("days", String(options.days))
  }
  if (options.projectPath?.trim()) {
    params.set("projectPath", options.projectPath.trim())
  }
  const query = params.toString()
  return invokeContract("threadStats", { query: query ? `?${query}` : "" })
}

/** Usage read from each provider CLI's own local store. */
export const loadProviderUsage = (
  options: { refresh?: boolean } = {}
): Promise<ProviderUsageReport[]> =>
  invokeContract("providerUsage", {
    query: options.refresh ? "?refresh=1" : "",
  })

/**
 * One page of a thread's transcript. With `limit` or `beforeSequence` the
 * backend returns the newest rows before the cursor (oldest first), and each
 * row carries its storage `sequence` so the next older page can be asked for.
 * `light` leaves out diff text and large inline `data:` attachments (flagged
 * `textOmitted` / `dataOmitted`); `loadMessage` returns one message in full.
 */
export interface MessagePageRequest {
  readonly limit?: number
  readonly beforeSequence?: number
  readonly light?: boolean
}

export function messagePageQuery(page: MessagePageRequest | undefined): string {
  if (!page) return ""
  const params = new URLSearchParams()
  if (page.limit !== undefined) params.set("limit", String(page.limit))
  if (page.beforeSequence !== undefined) {
    params.set("beforeSequence", String(page.beforeSequence))
  }
  if (page.light) params.set("light", "1")
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** Without `page` this keeps the legacy behaviour: the newest 1,000 rows. */
export const loadMessages = (threadId: string, page?: MessagePageRequest) =>
  invokeContract("listMessages", {
    id: threadId,
    query: messagePageQuery(page),
  })

/** One message with its diff text and attachment data. */
export const loadMessage = (threadId: string, messageId: string) =>
  invokeContract("getMessage", { id: threadId, params: { messageId } })

/**
 * Find in chat over the stored messages of one thread: the matching
 * messages oldest first, with every match counted. `beforeSequence` limits
 * it to the messages older than the ones the renderer holds.
 */
export const searchThreadMessages = (
  threadId: string,
  request: {
    query: string
    caseSensitive?: boolean
    beforeSequence?: number
    signal?: AbortSignal
  }
): Promise<ThreadMessageSearchResult> => {
  const params = new URLSearchParams({ q: request.query })
  if (request.caseSensitive) params.set("caseSensitive", "1")
  if (request.beforeSequence !== undefined) {
    params.set("beforeSequence", String(request.beforeSequence))
  }
  return invokeContract("searchThreadMessages", {
    id: threadId,
    query: `?${params.toString()}`,
    ...(request.signal ? { signal: request.signal } : {}),
  })
}

export const loadThreadDiffs = (threadId: string): Promise<ThreadDiffsPage> =>
  invokeContract("threadDiffs", { id: threadId })

/**
 * Body-free checkpoint summary: the newest turn the thread can be restored
 * from. Use this instead of `loadThreadDiffs` when no diff text is needed.
 */
export const loadThreadCheckpointSummary = (
  threadId: string
): Promise<ThreadCheckpointSummary> =>
  invokeContract("threadCheckpointSummary", {
    id: threadId,
    query: "?summary=1",
  })

/**
 * `GET /threads/:id/activities/:activityId/output`: the whole output of a
 * tool activity whose stored payload carries a cut copy
 * (`outputTruncated`), read back from the provider journal while the
 * journal still retains the event.
 *
 * Rejects with an `HttpError` whose `code` says why there is nothing to show:
 * `activity_not_found`, `activity_output_not_found` (not a tool call, or no
 * output) or `activity_output_not_retained` (journal retention ran out). A
 * 404 is an expected answer here, so it is not logged as a backend error.
 */
export const loadThreadActivityOutput = (
  threadId: string,
  activityId: string,
  options: { signal?: AbortSignal } = {}
): Promise<ThreadActivityFullOutput> =>
  invokeContract("threadActivityOutput", {
    id: threadId,
    params: { activityId },
    silentStatuses: [404],
    ...(options.signal ? { signal: options.signal } : {}),
  })

export const deleteThreadDb = (threadId: string): Promise<void> =>
  invokeContract("deleteThread", { id: threadId })

/** The projects the desktop knows: opened workspaces, or from older data, chats. */
export const listProjects = (): Promise<ProjectSummary[]> =>
  invokeContract("listProjects")
