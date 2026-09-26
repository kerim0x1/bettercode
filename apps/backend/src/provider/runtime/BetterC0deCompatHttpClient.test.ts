import { afterEach, describe, expect, it, vi } from "vitest"
import { createBetterC0deCompatHttpClient } from "./BetterC0deCompatHttpClient"

interface TestClient {
  readonly session: {
    prompt(
      input: Record<string, unknown>,
      options?: { readonly signal?: AbortSignal }
    ): Promise<unknown>
    delete(
      input: Record<string, unknown>,
      options?: { readonly signal?: AbortSignal }
    ): Promise<unknown>
  }
  readonly event: {
    subscribe(
      input?: Record<string, unknown>,
      options?: { readonly signal?: AbortSignal }
    ): Promise<{ readonly stream: AsyncIterable<unknown> }>
  }
}

function client(): TestClient {
  return createBetterC0deCompatHttpClient<TestClient>({
    baseUrl: "http://127.0.0.1:4096",
    directory: "/workspace",
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("BetterC0deCompatHttpClient bounds", () => {
  it("keeps split CRLF sequences within a single multiline SSE frame", async () => {
    const chunks = ['data: {"type":\r', '\ndata: "test"}\r', '\n\r\n']
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift()
        if (chunk === undefined) controller.close()
        else controller.enqueue(new TextEncoder().encode(chunk))
      },
    }))))
    const { stream } = await client().event.subscribe()
    const events = []
    for await (const event of stream) events.push(event)
    expect(events).toEqual([{ type: "test" }])
  })

  it("counts empty SSE data lines toward the frame budget", async () => {
    const chunk = new TextEncoder().encode("data:\n".repeat(1024))
    let remaining = 180
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(chunk)
        else controller.close()
      },
    }))))
    const { stream } = await client().event.subscribe()
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(/frame exceeded/i)
  })

  it("rejects oversized JSON responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(8 * 1024 * 1024 + 1)))
    )

    await expect(
      client().session.prompt({ sessionID: "session-1", parts: [] })
    ).rejects.toThrow(/response exceeded/i)
  })

  it("forwards cancellation and supports explicit session cleanup", async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url: String(url) })
        if (init?.signal?.aborted) throw init.signal.reason
        return new Response("{}", { status: 200 })
      })
    )
    const abort = new AbortController()

    await client().session.delete(
      { sessionID: "session-1" },
      { signal: abort.signal }
    )

    expect(calls).toEqual([
      {
        method: "DELETE",
        url: expect.stringContaining("/session/session-1"),
      },
    ])
  })

  it("rejects a 2xx response whose body is not JSON instead of handing back the text", async () => {
    // A caller reading `data.id` off a string got `undefined` and failed one
    // step later with no hint the server sent an HTML error page.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>gateway timeout</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
      )
    )

    await expect(
      client().session.prompt({ sessionID: "session-1", parts: [] })
    ).rejects.toThrow(/returned a 200 response that was not JSON/)
  })

  it("parses a JSON 2xx body into data and treats an empty body as no data", async () => {
    const bodies = ['{"id":"session-9","parts":[]}', "", "   "]
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bodies.shift() ?? "", { status: 200 }))
    )

    await expect(
      client().session.prompt({ sessionID: "session-9", parts: [] })
    ).resolves.toEqual({ data: { id: "session-9", parts: [] } })
    await expect(
      client().session.delete({ sessionID: "session-9" })
    ).resolves.toEqual({ data: undefined })
    await expect(
      client().session.delete({ sessionID: "session-9" })
    ).resolves.toEqual({ data: undefined })
  })

  it("keeps the parsed error body on a non-2xx response and falls back to the raw text", async () => {
    const bodies = ['{"error":"not found"}', "plain text failure"]
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(bodies.shift() ?? "", {
            status: 404,
            statusText: "Not Found",
          })
      )
    )

    await expect(
      client().session.prompt({ sessionID: "missing", parts: [] })
    ).rejects.toMatchObject({
      message: "Not Found",
      response: { status: 404 },
      data: { error: "not found" },
      body: { error: "not found" },
    })
    await expect(
      client().session.prompt({ sessionID: "missing", parts: [] })
    ).rejects.toMatchObject({
      response: { status: 404 },
      data: undefined,
      body: "plain text failure",
    })
  })

  it("rejects an oversized SSE frame", async () => {    const encoded = new TextEncoder().encode(
      `data: ${"x".repeat(1024 * 1024 + 1)}\n\n`
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded)
            controller.close()
          },
        })
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      })
    )
    const subscription = await client().event.subscribe()
    const iterator = subscription.stream[Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toThrow(/frame exceeded/i)
  })

  it("returns the bare v2 list payload for the legacy compatibility shape", async () => {
    let requestedUrl = ""
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        requestedUrl = String(url)
        return new Response(JSON.stringify([{ id: "gpt-5" }]), { status: 200 })
      })
    )
    const legacy = createBetterC0deCompatHttpClient<{
      readonly v2: {
        readonly model: {
          list(parameters?: unknown): Promise<{ readonly data?: unknown }>
        }
      }
    }>({ baseUrl: "http://127.0.0.1:4096", directory: "/workspace" })

    await expect(legacy.v2.model.list()).resolves.toEqual({
      data: [{ id: "gpt-5" }],
    })
    expect(requestedUrl).toContain("/api/model")
  })

  it("unwraps the opencode v2 { location, data } envelope when enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              location: { directory: "/workspace" },
              data: [{ id: "gpt-5", api: { id: "responses", type: "aisdk" } }],
            }),
            { status: 200 }
          )
      )
    )
    const opencode = createBetterC0deCompatHttpClient<{
      readonly v2: {
        readonly model: {
          list(parameters?: unknown): Promise<{ readonly data?: unknown }>
        }
        readonly provider: {
          list(parameters?: unknown): Promise<{ readonly data?: unknown }>
        }
      }
    }>({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/workspace",
      v2Envelope: true,
    })

    await expect(opencode.v2.model.list()).resolves.toEqual({
      data: [{ id: "gpt-5", api: { id: "responses", type: "aisdk" } }],
    })
    await expect(opencode.v2.provider.list()).resolves.toEqual({
      data: [{ id: "gpt-5", api: { id: "responses", type: "aisdk" } }],
    })
  })
})
