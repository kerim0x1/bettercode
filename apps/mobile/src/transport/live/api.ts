import {
  httpContracts,
  requestHttpContract,
  type HttpContractName,
  type HttpContractRequest,
} from "@betterc0de/schema/http-contracts"
import type { RemoteClientInfo } from "@betterc0de/schema/remote-protocol"
import { relativePathWithinRoot } from "@/lib/endpoint"
import {
  parseRemoteBootstrap,
  parseRemotePairResponse,
} from "@/lib/remote-session"
import type {
  DirectoryResult,
  FileSearchResult,
  ProjectSummary,
  ProviderInstance,
  RemotePairResponse,
  RemoteStatus,
  ThreadDiffs,
} from "@/types/remote"
import type { FileContent, RemoteApi } from "../types"
import {
  RemoteApiError,
  httpJson,
  httpRequest,
  type HttpConnection,
  type RequestOptions,
} from "./http"

/** How long a message may take the desktop to start (the desktop's own limit). */
export const SEND_TIMEOUT_MS = 210_000

export async function pairMobile(
  baseUrl: string,
  credential: string,
  label: string,
  client: RemoteClientInfo | null,
  fetchImpl?: typeof fetch
): Promise<RemotePairResponse> {
  return parseRemotePairResponse(
    await httpJson<unknown>(
      { baseUrl, token: null, client, fetch: fetchImpl },
      "/remote/mobile/pair",
      { method: "POST", body: { credential, label } }
    )
  )
}

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined
  )
  if (entries.length === 0) return ""
  return `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`
}

/** The paired desktop, over HTTP. */
export function createLiveApi(connection: HttpConnection): RemoteApi {
  const call = <T>(path: string, options: RequestOptions = {}) =>
    httpJson<T>(connection, path, options)
  const contract = <K extends HttpContractName>(
    name: K,
    options: {
      body?: HttpContractRequest<K>
      id?: string
      query?: string
      timeoutMs?: number
    } = {}
  ) =>
    requestHttpContract(
      name,
      ({ path, method, body }) =>
        call<unknown>(path, { method, body, timeoutMs: options.timeoutMs }),
      options
    )

  return {
    bootstrap: async () =>
      parseRemoteBootstrap(await call<unknown>("/remote/bootstrap")),
    status: () => call<RemoteStatus>("/remote/status"),
    logout: () =>
      call<{ loggedOut: boolean }>("/remote/logout", { method: "POST" }),

    listThreadsPage: async (cursor) => {
      const response = await httpRequest<unknown>(
        connection,
        `/threads${query({ cursor: cursor ?? undefined })}`
      )
      let threads
      try {
        threads = httpContracts.listThreads.response.parse(response.data)
      } catch {
        throw new Error("Invalid backend response for GET /threads")
      }
      return {
        threads,
        nextCursor: response.headers.get("X-Next-Cursor") || null,
      }
    },
    getThread: async (threadId) => {
      try {
        return await contract("getThread", { id: threadId })
      } catch (error) {
        if (error instanceof RemoteApiError && error.status === 404) return null
        throw error
      }
    },
    listMessages: (threadId, options = {}) =>
      contract("listMessages", {
        id: threadId,
        query: query({
          limit: options.limit,
          beforeSequence: options.beforeSequence,
        }),
      }),
    listActivities: (threadId) => contract("listActivities", { id: threadId }),
    listDiffs: (threadId) =>
      call<ThreadDiffs>(`/threads/${encodeURIComponent(threadId)}/diffs`),
    listProjects: () => call<ProjectSummary[]>("/projects"),
    createThread: (thread) => contract("saveThread", { body: thread }),
    listProviderInstances: (cwd) =>
      call<ProviderInstance[]>(
        `/providers/instances${query({ cwd: cwd || undefined })}`
      ),

    goal: (body) => contract("chatGoal", { body }),
    // As on the desktop: compacting or handing a chat over to another
    // provider can take the desktop up to 180 s before the turn starts.
    sendMessage: (body) =>
      contract("chatSend", { body, timeoutMs: SEND_TIMEOUT_MS }),
    interrupt: (body) => contract("chatInterrupt", { body }),
    setPermissionMode: (body) => contract("chatPermissionMode", { body }),
    respondApproval: (body) => contract("chatApproval", { body }),
    respondPlan: (body) => contract("chatPlanApproval", { body }),
    respondUserInput: (body) => contract("chatUserInput", { body }),
    rejectUserInput: (body) => contract("chatUserInputReject", { body }),

    listDirectory: (path, showHidden = false) =>
      call<DirectoryResult>("/filesystem/list", {
        method: "POST",
        body: { path, showHidden },
      }),
    searchFiles: (root, needle, limit = 200) =>
      call<FileSearchResult>("/filesystem/search", {
        method: "POST",
        body: { root, query: needle, limit },
      }),
    readFile: (root, absolutePath) =>
      call<FileContent>("/workspace/read", {
        method: "POST",
        body: {
          cwd: root,
          relativePath: relativePathWithinRoot(root, absolutePath),
        },
      }),
  }
}
