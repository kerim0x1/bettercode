import { invokeContract } from "./contracts"
import { getConfig, invoke } from "./runtime"

export type SettingsResponse = Record<string, unknown>

export const getSettings = () => invokeContract("getSettings")

export const getWsPort = async () => {
  const config = getConfig()
  if (config.port && config.port !== 3773) return config.port
  return invoke<number>("/ws-port").catch(() => config.port || 3773)
}

export const updateSettings = (patch: Record<string, unknown>) =>
  invokeContract("updateSettings", {
    args: { patch },
    method: "PATCH",
    body: { patch },
  })

export const createDeepgramAccessToken = () =>
  invoke<{ accessToken: string; expiresIn: number }>(
    "/settings/deepgram-token",
    { method: "POST" }
  )

export interface RuntimeDebugInfo {
  app: {
    name: string
    version: string
    backend: string
    startedAt: number
    uptimeSeconds: number
  }
  system: {
    platform: string
    arch: string
    release: string
    type: string
    hostname: string
  }
  process: {
    pid: number
    node: string
    versions: {
      node: string
      v8?: string
      uv?: string
      modules?: string
    }
    cwd: string
  }
  terminal: {
    term: string | null
    program: string | null
    shell: string | null
  }
  envOverrides: {
    betterc0deHome: "set" | "unset"
    betterc0deDataDir: "set" | "unset"
  }
  paths: {
    dataDir: string
    dbPath: string
    settingsPath: string
    authPath: string
    logsDir: string
    providerLogsDir: string
    providerEventLogPath: string
  }
  database: {
    path: string
  }
  betterc0de?: RuntimeCompatDebugInfo
}

export interface RuntimeCompatDebugInfo {
  configDir: string
  configDirSource: "default" | "BETTERC0DE_CONFIG_DIR" | "legacy"
  dataDir: string
  stateDir: string
  cacheDir: string
  binDir: string
  logDir: string
  reposDir: string
  dbPath: string
  dbPathSource: "default" | "BETTERC0DE_DB" | "legacy"
  authPath: string
  mcpAuthPath: string
  pluginMetaPath: string
  pureMode?: boolean
  defaultPluginsDisabled?: boolean
  externalPlugins?: "enabled" | "disabled-by-pure"
  defaultPlugins?: "enabled" | "disabled-by-env"
}

export const getRuntimeDebugInfo = () =>
  invoke<RuntimeDebugInfo>("/runtime/debug-info")

export interface RuntimeHeapSnapshotResult {
  path: string
  bytes: number
}

export const writeRuntimeHeapSnapshot = () =>
  invoke<RuntimeHeapSnapshotResult>("/runtime/heap-snapshot", {
    method: "POST",
  })

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

export const saveThreadMessage = (threadId: string, message: unknown) =>
  invokeContract("saveMessage", {
    id: threadId,
    args: { threadId, message },
    method: "POST",
    body: message,
  })

export const truncateThreadMessages = (threadId: string, messageId: string) =>
  invoke<{ deletedMessages: number }>(`/threads/${threadId}/truncate`, {
    args: { threadId, messageId },
    method: "POST",
    body: { messageId, updatedAt: new Date().toISOString() },
  })

export const revertThreadCheckpoint = (
  threadId: string,
  turnCount: number,
  options: { preserveFuture?: boolean } = {}
) =>
  invoke<{
    reverted: boolean
    rolledBackTurns: number
    deletedMessages: number
    boundaryMessageId: string | null
    reason?: string
  }>(`/threads/${threadId}/checkpoint/revert`, {
    args: { threadId, turnCount },
    method: "POST",
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
) =>
  invoke<ThreadWorktreeCreateResult>(`/threads/${threadId}/worktree`, {
    args: { threadId, ...input },
    method: "POST",
    body: input,
  })

export const removeThreadWorktree = (
  threadId: string,
  input: {
    deleteBranch?: boolean
    force?: boolean
  } = {}
) =>
  invoke<{ ok: true }>(`/threads/${threadId}/worktree/remove`, {
    args: { threadId, ...input },
    method: "POST",
    body: input,
  })

export const resetThreadWorktree = (
  threadId: string,
  input: {
    clean?: boolean
    updateSubmodules?: boolean
  } = {}
) =>
  invoke<ThreadWorktreeCreateResult>(`/threads/${threadId}/worktree/reset`, {
    args: { threadId, ...input },
    method: "POST",
    body: input,
  })

export const loadThreads = () => invokeContract("listThreads")

export interface ThreadUsageStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        reasoning: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  providerUsage?: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        reasoning: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  dailyUsage?: Array<{
    date: string
    provider: string
    tokens: number
    cost: number
  }>
  dateRange: {
    earliest: string | null
    latest: string | null
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

export const loadThreadStats = (
  options: {
    days?: number
    projectPath?: string | null
  } = {}
) => {
  const params = new URLSearchParams()
  if (typeof options.days === "number" && Number.isFinite(options.days)) {
    params.set("days", String(options.days))
  }
  if (options.projectPath?.trim()) {
    params.set("projectPath", options.projectPath.trim())
  }
  const query = params.toString()
  return invoke<ThreadUsageStats>(`/threads/stats${query ? `?${query}` : ""}`)
}

export type UsageProviderId = "claude" | "codex" | "grok"
export type UsageStatus = "ready" | "partial" | "unavailable" | "error"

export interface UsageDailyPoint {
  date: string
  tokens: number
  messages: number
  sessions: number
}

export interface UsageEntry {
  id: string
  label: string
  value: number
  share?: number
  cost?: number
}

export interface UsagePricing {
  currency: "USD"
  total: number
  breakdown: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  pricedTokens: number
  unpricedTokens: number
  unpricedModels: string[]
  hasOverrides: boolean
  notes: string[]
}

export interface UsageList {
  id: string
  title: string
  unit: string
  entries: UsageEntry[]
}

export interface UsageInsight {
  id: string
  label: string
  value: string
  hint?: string
}

export interface UsageLimit {
  id: string
  label: string
  usedPercent: number
  resetsAt: string | null
  resetLabel: string | null
}

export interface UsageSummary {
  totalTokens: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
  peakDayTokens: number
  peakDayDate: string | null
  longestSessionMs: number
  currentStreakDays: number
  longestStreakDays: number
  sessions: number
  messages: number
  activeDays: number
  firstActivity: string | null
  lastActivity: string | null
  cost: number | null
}

export interface ProviderUsageReport {
  provider: UsageProviderId
  label: string
  status: UsageStatus
  installed: boolean
  authenticated: boolean
  version: string | null
  plan: string | null
  source: string
  fetchedAt: string
  scannedMs: number
  summary: UsageSummary
  daily: UsageDailyPoint[]
  pricing: UsagePricing | null
  pricesFile: string | null
  models: UsageEntry[]
  insights: UsageInsight[]
  lists: UsageList[]
  limits: UsageLimit[]
  limitsObservedAt: string | null
  limitNotes: string[]
  notes: string[]
  error?: string
}

/** Usage read from each provider CLI's own local store. */
export const loadProviderUsage = (options: { refresh?: boolean } = {}) =>
  invoke<ProviderUsageReport[]>(
    `/usage/providers${options.refresh ? "?refresh=1" : ""}`
  )

export const loadMessages = (threadId: string) =>
  invokeContract("listMessages", { id: threadId })

export const loadThreadDiffs = (threadId: string) =>
  invoke<{
    turnDiffs: Array<{
      threadId: string
      turnIndex: number
      diffText: string
      filesChanged: number
      insertions: number
      deletions: number
      createdAt: string
    }>
    checkpointDiffs: Array<{
      id: number
      threadId: string
      turnId: string
      checkpointRef: string
      diffContent: string
      createdAt: string
    }>
  }>(`/threads/${threadId}/diffs`)

export const deleteThreadDb = (threadId: string) =>
  invoke<void>(`/threads/${threadId}`, {
    args: { threadId },
    method: "DELETE",
  })

export const listProjects = () => invoke<unknown[]>("/projects")
