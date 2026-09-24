import type {
  ChatThread,
  ConnectionProfile,
  DirectoryResult,
  FileSearchResult,
  ProjectSummary,
  ProviderInstance,
  RemotePairResponse,
  RemoteStatus,
  ThreadDiffs,
} from "@/types/remote"
import {
  requestHttpContract,
  type HttpContractName,
  type HttpContractRequest,
} from "@betterc0de/schema/http-contracts"
import { normalizeBaseUrl, relativePathWithinRoot } from "./endpoint"
import { parseRemoteBootstrap, parseRemotePairResponse } from "./remote-session"

const REQUEST_TIMEOUT_MS = 20_000

export class RemoteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
  }
}

export async function pairMobile(
  baseUrl: string,
  credential: string,
  label: string
): Promise<RemotePairResponse> {
  return parseRemotePairResponse(
    await request<unknown>(baseUrl, null, "/remote/mobile/pair", {
      method: "POST",
      body: { credential, label },
    })
  )
}

export function remoteApi(profile: ConnectionProfile) {
  const call = <T>(path: string, options: RequestOptions = {}): Promise<T> =>
    request<T>(profile.baseUrl, profile.sessionToken, path, options)
  const contract = <K extends HttpContractName>(
    name: K,
    options: { body?: HttpContractRequest<K>; id?: string } = {}
  ) =>
    requestHttpContract(
      name,
      ({ path, method, body }) => call<unknown>(path, { method, body }),
      options
    )

  return {
    bootstrap: async () =>
      parseRemoteBootstrap(await call<unknown>("/remote/bootstrap")),
    status: () => call<RemoteStatus>("/remote/status"),
    health: () => call<Record<string, unknown>>("/runtime/health"),
    logout: () =>
      call<{ loggedOut: boolean }>("/remote/logout", { method: "POST" }),
    listThreads: () => contract("listThreads"),
    listMessages: (threadId: string) =>
      contract("listMessages", { id: threadId }),
    listActivities: (threadId: string) =>
      contract("listActivities", { id: threadId }),
    listDiffs: (threadId: string) =>
      call<ThreadDiffs>(`/threads/${encodeURIComponent(threadId)}/diffs`),
    listProjects: () => call<ProjectSummary[]>("/projects"),
    createThread: (thread: ChatThread) =>
      contract("saveThread", { body: thread }),
    getSettings: () => contract("getSettings"),
    updateSettings: (patch: Record<string, unknown>) =>
      contract("updateSettings", { body: { patch } }),
    listProviderInstances: (cwd?: string | null) =>
      call<ProviderInstance[]>(
        `/providers/instances${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`
      ),
    goal: (body: Record<string, unknown>) => contract("chatGoal", { body }),
    sendMessage: (body: Record<string, unknown>) =>
      contract("chatSend", {
        body,
      }),
    interrupt: (body: {
      providerKind: string
      providerInstanceId?: string | null
      threadId: string
    }) =>
      contract("chatInterrupt", {
        body,
      }),
    respondApproval: (body: Record<string, unknown>) =>
      contract("chatApproval", {
        body,
      }),
    respondPlan: (body: Record<string, unknown>) =>
      contract("chatPlanApproval", {
        body,
      }),
    respondUserInput: (body: Record<string, unknown>) =>
      contract("chatUserInput", {
        body,
      }),
    rejectUserInput: (body: Record<string, unknown>) =>
      contract("chatUserInputReject", {
        body,
      }),
    listDirectory: (path: string, showHidden = false) =>
      call<DirectoryResult>("/filesystem/list", {
        method: "POST",
        body: { path, showHidden },
      }),
    searchFiles: (root: string, query: string, limit = 200) =>
      call<FileSearchResult>("/filesystem/search", {
        method: "POST",
        body: { root, query, limit },
      }),
    readFile: (root: string, absolutePath: string) =>
      call<{ content: string; path: string }>("/workspace/read", {
        method: "POST",
        body: {
          cwd: root,
          relativePath: relativePathWithinRoot(root, absolutePath),
        },
      }),
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?: unknown
  signal?: AbortSignal
}

async function request<T>(
  baseUrl: string,
  token: string | null,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${normalizeBaseUrl(baseUrl)}/api/v1${path.startsWith("/") ? path : `/${path}`}`,
      {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      }
    )
    if (response.status === 204) return undefined as T
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!response.ok) {
      const message =
        typeof payload?.error === "string"
          ? payload.error
          : `Desktop request failed (${response.status}).`
      throw new RemoteApiError(
        message,
        response.status,
        typeof payload?.code === "string" ? payload.code : undefined
      )
    }
    return payload as T
  } catch (error) {
    if (error instanceof RemoteApiError) throw error
    if (controller.signal.aborted) {
      throw new RemoteApiError(
        "The desktop did not answer in time.",
        0,
        "timeout"
      )
    }
    throw new RemoteApiError(
      error instanceof Error ? error.message : "The desktop is unreachable.",
      0,
      "network"
    )
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
  }
}
