import { afterEach, describe, expect, it, vi } from "vitest"
import { SEND_TIMEOUT_MS, createLiveApi, pairMobile } from "./api"
import { RemoteApiError, type HttpConnection } from "./http"

const PHONE = {
  name: "betterc0de-remote",
  version: "0.1.0-beta.3",
  platform: "android",
}
const SESSION = {
  id: "s",
  label: "phone",
  createdAt: "2026-09-05T00:00:00.000Z",
  lastSeenAt: "2026-09-05T00:00:00.000Z",
  expiresAt: "2027-09-05T00:00:00.000Z",
}
const THREAD = {
  id: "t",
  title: "Hello",
  projectName: "Repo",
  projectPath: "/repo",
  messages: [],
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z",
}

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn()
  for (const response of responses) fetchMock.mockResolvedValueOnce(response)
  return fetchMock
}

function connection(fetchMock: ReturnType<typeof vi.fn>): HttpConnection {
  return {
    baseUrl: "http://localhost:4321",
    token: "session",
    client: PHONE,
    fetch: fetchMock as unknown as typeof fetch,
  }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init })

afterEach(() => vi.unstubAllGlobals())

describe("mobile HTTP contracts", () => {
  it.each([null, {}, { authenticated: true, session: { id: "session" } }])(
    "rejects malformed successful pairing and session responses: %j",
    async (payload) => {
      const fetchMock = vi.fn(async () => json(payload))
      await expect(
        pairMobile(
          "http://localhost:4321",
          "one-time",
          "Phone",
          PHONE,
          fetchMock as unknown as typeof fetch
        )
      ).rejects.toThrow("Invalid backend pairing response")
      await expect(
        createLiveApi(connection(fetchMock)).bootstrap()
      ).rejects.toThrow("Invalid backend session response")
    }
  )

  it("accepts pairing and session metadata from desktops with and without a protocol block", async () => {
    const protocol = { apiVersion: 2, minClientVersion: "0.1.0-beta.1" }
    const session = {
      enabled: true,
      authenticated: true,
      authentication: "remote",
      environmentId: "desktop",
      session: SESSION,
    }
    const fetchMock = stubFetch(
      json({
        ...session,
        tokenType: "Bearer",
        sessionToken: "session",
        protocol,
      }),
      json(session)
    )
    expect(
      await pairMobile(
        "http://localhost:4321",
        "one-time",
        "Phone",
        PHONE,
        fetchMock as unknown as typeof fetch
      )
    ).toMatchObject({ sessionToken: "session", protocol })
    expect(await createLiveApi(connection(fetchMock)).bootstrap()).toEqual({
      ...session,
      protocol: null,
    })
  })

  it("identifies the app on every request", async () => {
    const fetchMock = stubFetch(json([]))
    await createLiveApi(connection(fetchMock)).listProjects()
    const [, init] = fetchMock.mock.calls[0]!
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer session",
      "X-BetterC0de-Client": "betterc0de-remote/0.1.0-beta.3 (android)",
    })
  })

  it("pages through chats with the desktop's cursor", async () => {
    const fetchMock = stubFetch(
      json([THREAD], { headers: { "X-Next-Cursor": "next-page" } }),
      json([{ ...THREAD, id: "t2" }])
    )
    const api = createLiveApi(connection(fetchMock))
    expect(await api.listThreadsPage()).toEqual({
      threads: [expect.objectContaining({ id: "t" })],
      nextCursor: "next-page",
    })
    expect(await api.listThreadsPage("next-page")).toEqual({
      threads: [expect.objectContaining({ id: "t2" })],
      nextCursor: null,
    })
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "http://localhost:4321/api/v1/threads?cursor=next-page"
    )
  })

  it("asks for a page of earlier messages", async () => {
    const fetchMock = stubFetch(json([]))
    await createLiveApi(connection(fetchMock)).listMessages("t 1", {
      limit: 200,
      beforeSequence: 40,
    })
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://localhost:4321/api/v1/threads/t%201/messages?limit=200&beforeSequence=40"
    )
  })

  it("reads one chat, and a missing chat as null", async () => {
    const fetchMock = stubFetch(
      json(THREAD),
      json(
        { error: "thread not found", code: "thread_not_found" },
        { status: 404 }
      )
    )
    const api = createLiveApi(connection(fetchMock))
    expect(await api.getThread("t")).toMatchObject({ id: "t", title: "Hello" })
    expect(await api.getThread("missing")).toBeNull()
  })

  it("carries the desktop's reason, retry delay and minimum version on refusals", async () => {
    const fetchMock = stubFetch(
      json(
        {
          error:
            "This version of BetterC0de Remote is too old for this desktop. Update the app.",
          code: "client_update_required",
          minClientVersion: "0.2.0",
        },
        { status: 426 }
      ),
      json(
        { error: "slow down", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": "7" } }
      )
    )
    const api = createLiveApi(connection(fetchMock))
    await expect(api.listProjects()).rejects.toMatchObject({
      status: 426,
      code: "client_update_required",
      details: { minClientVersion: "0.2.0" },
    })
    await expect(api.listProjects()).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      details: { retryAfterMs: 7000 },
    })
  })

  it("reports a network failure and a timeout as their own codes", async () => {
    const offline = vi
      .fn()
      .mockRejectedValue(new TypeError("Network request failed"))
    await expect(
      createLiveApi(connection(offline)).listProjects()
    ).rejects.toEqual(expect.objectContaining({ status: 0, code: "network" }))
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          )
        })
    )
    vi.useFakeTimers()
    try {
      const pending = createLiveApi(connection(hanging)).listProjects()
      const assertion = expect(pending).rejects.toBeInstanceOf(RemoteApiError)
      await vi.advanceTimersByTimeAsync(20_000)
      await assertion
      await expect(pending).rejects.toMatchObject({ code: "timeout" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits as long as the desktop does for a message to start", async () => {
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          )
        })
    )
    vi.useFakeTimers()
    try {
      let settled = false
      const pending = createLiveApi(connection(hanging))
        .sendMessage({ threadId: "t", message: "hello", modelId: "model" })
        .finally(() => {
          settled = true
        })
      const assertion = expect(pending).rejects.toMatchObject({
        code: "timeout",
      })
      // Compacting a long chat first can take the desktop minutes.
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("switches a chat's permission preset through the shared contract", async () => {
    const fetchMock = stubFetch(
      json({ status: "acknowledged", applied: "queued" })
    )
    await expect(
      createLiveApi(connection(fetchMock)).setPermissionMode({
        threadId: "t",
        providerKind: "claude",
        providerInstanceId: null,
        permissionLevel: "read-only",
      })
    ).resolves.toEqual({ status: "acknowledged", applied: "queued" })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://localhost:4321/api/v1/chat/permission-mode")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({
      threadId: "t",
      providerKind: "claude",
      providerInstanceId: null,
      permissionLevel: "read-only",
    })
  })

  it("renames and deletes a chat through the shared contracts", async () => {
    const renamed = {
      threadId: "t",
      title: "Release notes",
      updatedAt: "2026-09-24T10:00:00.000Z",
    }
    const fetchMock = stubFetch(
      json(renamed),
      new Response(null, { status: 204 })
    )
    const api = createLiveApi(connection(fetchMock))
    await expect(api.renameThread("t", "Release notes")).resolves.toEqual(
      renamed
    )
    await expect(api.deleteThread("t")).resolves.toBeUndefined()
    const [renameUrl, renameInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(renameUrl).toBe("http://localhost:4321/api/v1/threads/t/title")
    expect(renameInit.method).toBe("POST")
    expect(JSON.parse(String(renameInit.body))).toEqual({
      title: "Release notes",
    })
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ]
    expect(deleteUrl).toBe("http://localhost:4321/api/v1/threads/t")
    expect(deleteInit.method).toBe("DELETE")
  })

  it("rejects malformed thread responses", async () => {
    const fetchMock = stubFetch(json([{ id: "t" }]))
    await expect(
      createLiveApi(connection(fetchMock)).listThreadsPage()
    ).rejects.toThrow("Invalid backend response")
  })

  it("does not retry an accepted dispatch with an invalid reply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{"status":"streaming"}', { status: 200 })
      )
    await expect(
      createLiveApi(connection(fetchMock)).sendMessage({
        threadId: "t",
        message: "hello",
        modelId: "model",
      })
    ).rejects.toThrow("Invalid backend response")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("accepts empty 204 thread writes", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }))
    await expect(
      createLiveApi(connection(fetchMock)).createThread(THREAD)
    ).resolves.toBeUndefined()
  })
})
