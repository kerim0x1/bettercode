import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLiveApi } from "@/transport/live/api"
import type { ChatThread } from "@/types/remote"
import type { ThreadActivity } from "@/types/remote"
import { RemoteApiError } from "@/transport/live/http"
import type { RemoteApi } from "@/transport/types"
import {
  interruptTarget,
  pendingRequestsFromActivities,
  shouldClearCompletedStream,
  useAppStore,
} from "./app-store"

function activity(
  kind: string,
  payload: Record<string, unknown>,
  sequence: number
): ThreadActivity {
  return {
    id: `${kind}-${sequence}`,
    threadId: "thread-1",
    kind,
    tone: "info",
    summary: kind,
    payload,
    sequence,
    createdAt: `2026-07-21T10:00:0${sequence}.000Z`,
  }
}

/** The paired-desktop API over the test's stubbed `fetch`. */
function liveApi(baseUrl: string) {
  return createLiveApi({ baseUrl, token: "session", client: null })
}

describe("mobile app runtime state", () => {
  afterEach(() => vi.unstubAllGlobals())
  it("does not reopen a resolved request when activity sequences are reordered", () => {
    expect(
      pendingRequestsFromActivities([
        activity(
          "plan-approval.requested",
          { requestId: "plan", planMarkdown: "# Plan" },
          2
        ),
        activity(
          "plan-approval.resolved",
          { requestId: "plan", decision: "approve" },
          1
        ),
      ])
    ).toEqual([])
  })
  beforeEach(() => useAppStore.getState().reset())

  it.each([
    "refreshThreads",
    "refreshProjects",
    "loadMessages",
    "loadActivities",
  ] as const)(
    "ignores an old host's delayed %s after reset",
    async (method) => {
      let respond!: (response: Response) => void
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              respond = resolve
            })
        )
      )
      const profile = liveApi("https://old.test")
      const loading = useAppStore.getState()[method](profile, "thread-1")
      useAppStore.getState().reset()
      useAppStore.setState({
        threads: [{ ...goalThread(), title: "New host" }],
        error: "New host error",
      })
      const current = useAppStore.getState()
      respond(new Response(JSON.stringify([]), { status: 200 }))
      await loading
      expect(useAppStore.getState()).toBe(current)
    }
  )

  it.each([200, 500])(
    "does not revive an old dispatch after reset (HTTP %i)",
    async (status) => {
      useAppStore.setState({ threads: [goalThread()] })
      let respond!: (response: Response) => void
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              respond = resolve
            })
        )
      )
      const sending = useAppStore
        .getState()
        .send(liveApi("https://old.test"), "thread-1", "hello", {
          modelId: "model",
          providerKind: "codex",
          providerInstanceId: "codex",
        } as Parameters<ReturnType<typeof useAppStore.getState>["send"]>[3])
      useAppStore.getState().reset()
      const current = useAppStore.getState()
      respond(
        new Response(
          JSON.stringify(
            status === 200
              ? { status: "streaming", turnId: "old-turn" }
              : { error: "Old failure" }
          ),
          { status }
        )
      )
      await sending
      expect(useAppStore.getState()).toBe(current)
    }
  )

  it("rejects a chat created under a previous session without publishing it", async () => {
    let respond!: (response: Response) => void
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve
          })
      )
    )
    const creating = useAppStore
      .getState()
      .createThread(liveApi("https://old.test"), { name: "Old", path: "/old" })
    useAppStore.getState().reset()
    respond(new Response(null, { status: 204 }))
    await expect(creating).rejects.toThrow("session changed")
    expect(useAppStore.getState().threads).toEqual([])
  })

  it.each(["item.updated", "item.completed", "tool.started"])(
    "ends reasoning when a tool first arrives as %s",
    (type) => {
      const send = (eventType: string, payload: Record<string, unknown>) =>
        useAppStore.getState().applyFrame({
          channel: "provider.runtimeEvent",
          data: {
            type: eventType,
            threadId: "thread-1",
            providerKind: "grok-cli",
            payload,
          },
        })
      send("reasoning.delta", { delta: "Inspect workspace" })
      expect(
        useAppStore.getState().streamsByThread["thread-1"]?.isReasoning
      ).toBe(true)
      send(type, {
        itemId: "shell-1",
        toolId: "shell-1",
        itemType: "command_execution",
      })
      expect(useAppStore.getState().streamsByThread["thread-1"]).toMatchObject({
        isReasoning: false,
        running: true,
        reasoning: "Inspect workspace",
      })
      send("reasoning.delta", { delta: "Next decision" })
      send("item.completed", {
        itemId: "shell-1",
        itemType: "command_execution",
      })
      expect(
        useAppStore.getState().streamsByThread["thread-1"]?.isReasoning
      ).toBe(true)
      send("content.delta", { delta: "Answer" })
      expect(
        useAppStore.getState().streamsByThread["thread-1"]?.isReasoning
      ).toBe(false)
      send("reasoning.delta", { delta: "Last thought" })
      send("turn.completed", {})
      expect(useAppStore.getState().streamsByThread["thread-1"]).toMatchObject({
        isReasoning: false,
        running: false,
      })
    }
  )

  it("starts the next turn from a clean stream", () => {
    const send = (eventType: string, payload: Record<string, unknown> = {}) =>
      useAppStore.getState().applyFrame({
        channel: "provider.runtimeEvent",
        data: {
          type: eventType,
          threadId: "thread-1",
          providerKind: "codex",
          payload,
        },
      })
    send("turn.started", { turn_id: "turn-1" })
    send("content.delta", { delta: "First reply" })
    send("turn_error", { error: "boom" })
    expect(useAppStore.getState().streamsByThread["thread-1"]).toMatchObject({
      running: false,
      content: "First reply",
      error: "boom",
    })

    send("turn.started", { turn_id: "turn-2" })
    expect(useAppStore.getState().streamsByThread["thread-1"]).toMatchObject({
      turnId: "turn-2",
      running: true,
      content: "",
      reasoning: "",
      error: null,
    })
    send("content.delta", { delta: "Second" })
    expect(useAppStore.getState().streamsByThread["thread-1"]?.content).toBe(
      "Second"
    )
  })

  it("applies a provider-assigned title live", () => {
    useAppStore.setState({ threads: [{ ...goalThread(), title: "New Chat" }] })
    useAppStore.getState().applyFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "thread.metadata.updated",
        thread_id: "thread-1",
        payload: { providerKind: "codex", name: "  Fix the login flow  " },
      },
    })
    expect(useAppStore.getState().threads[0]?.title).toBe("Fix the login flow")
    expect(useAppStore.getState().streamsByThread).toEqual({})
  })

  it("keeps a finished stream until the reply is in the reloaded messages", () => {
    const stream = {
      turnId: "turn-1",
      content: "The answer",
      reasoning: "",
      running: false,
      error: null,
      startedAt: "2026-09-14T10:00:00.000Z",
    }
    const user = {
      id: "u",
      role: "user" as const,
      content: "Q",
      createdAt: "2026-09-14T09:59:00.000Z",
    }
    const reply = {
      id: "a",
      role: "assistant" as const,
      content: "The answer",
      createdAt: "2026-09-14T10:00:05.000Z",
    }
    const older = {
      id: "o",
      role: "assistant" as const,
      content: "Old",
      createdAt: "2026-09-14T09:00:00.000Z",
    }

    expect(shouldClearCompletedStream(undefined, [reply])).toBe(false)
    expect(
      shouldClearCompletedStream({ ...stream, running: true }, [reply])
    ).toBe(false)
    // Persistence has not caught up: the streamed text is the only copy.
    expect(shouldClearCompletedStream(stream, [user, older])).toBe(false)
    expect(shouldClearCompletedStream(stream, [user, older, reply])).toBe(true)
    // Nothing streamed, nothing to lose.
    expect(shouldClearCompletedStream({ ...stream, content: "" }, [user])).toBe(
      true
    )
  })

  it("does not create an empty stream for metadata-only events", () => {
    useAppStore.getState().applyFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "provider.metadata.changed",
        thread_id: "thread-1",
        payload: { providerKind: "codex" },
      },
    })

    expect(useAppStore.getState().streamsByThread["thread-1"]).toBeUndefined()
  })

  it("reconstructs and resolves durable plan approvals", () => {
    const requested = activity(
      "plan-approval.requested",
      {
        requestId: "plan-1",
        providerKind: "claude",
        planMarkdown: "## Umsetzung\n\n- Mobile testen",
      },
      1
    )
    expect(pendingRequestsFromActivities([requested])).toMatchObject([
      {
        id: "plan-1",
        kind: "plan",
        detail: "## Umsetzung\n\n- Mobile testen",
      },
    ])

    const resolved = activity(
      "plan-approval.resolved",
      { requestId: "plan-1", decision: "approve" },
      2
    )
    expect(pendingRequestsFromActivities([requested, resolved])).toEqual([])
  })

  it("applies native goal accounting and clears without creating a running stream", () => {
    useAppStore.setState({ threads: [goalThread()] })
    useAppStore.getState().applyFrame(
      goalFrame({
        goal: {
          objective: "Finish migration",
          status: "blocked",
          tokensUsed: 321,
          createdAt: 1789400000,
          updatedAt: 1789400100,
          timeUsedSeconds: 42,
        },
      })
    )
    expect(useAppStore.getState().threads[0]?.goal).toMatchObject({
      status: "blocked",
      tokens: 321,
      timeUsedSeconds: 42,
    })
    expect(useAppStore.getState().streamsByThread).toEqual({})
    useAppStore.getState().applyFrame(goalFrame(null))
    expect(useAppStore.getState().threads[0]?.goal).toBeNull()
  })

  it("does not resurrect a cleared goal when a slow thread snapshot arrives", async () => {
    useAppStore.setState({ threads: [goalThread()] })
    let respond!: (response: Response) => void
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve
          })
      )
    )
    const loading = useAppStore
      .getState()
      .refreshThreads(liveApi("http://localhost:4321"))
    useAppStore.getState().applyFrame(goalFrame(null))
    respond(
      new Response(
        JSON.stringify([
          {
            ...goalThread(),
            goal: {
              objective: "Old goal",
              status: "active",
              startedAt: 1000,
              updatedAt: 2000,
            },
          },
        ]),
        { status: 200 }
      )
    )
    await loading
    expect(useAppStore.getState().threads[0]?.goal).toBeNull()
  })

  it("sends goal controls while a turn runs without adding fake chat messages or clearing its stream", async () => {
    useAppStore.setState({
      threads: [goalThread()],
      streamsByThread: {
        "thread-1": {
          turnId: "active-turn",
          content: "Still working",
          reasoning: "",
          running: true,
          error: null,
          startedAt: "now",
        },
      },
    })
    const fetch = vi.fn(
      async (_url: unknown) =>
        new Response(
          JSON.stringify({
            goal: {
              id: "goal",
              source: "betterc0de",
              objective: "Task",
              status: "paused",
              startedAt: 1000,
              updatedAt: 2000,
            },
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal("fetch", fetch)
    await useAppStore
      .getState()
      .send(liveApi("http://localhost:4321"), "thread-1", "/goal pause", {
        key: "test",
        modelId: "test",
        providerKind: "codex",
        providerInstanceId: "codex",
      } as Parameters<ReturnType<typeof useAppStore.getState>["send"]>[3])
    expect(fetch.mock.calls[0]?.[0]).toContain("/chat/goal")
    expect(useAppStore.getState().threads[0]?.goal?.status).toBe("paused")
    expect(useAppStore.getState().messagesByThread["thread-1"]).toBeUndefined()
    expect(useAppStore.getState().streamsByThread["thread-1"]?.content).toBe(
      "Still working"
    )
  })

  it.each(["claude", "grok_cli", "codex"])(
    "keeps the selected %s model for goal creation and continuation",
    async (providerKind) => {
      useAppStore.setState({ threads: [goalThread()] })
      const fetch = vi.fn(
        async (_url: unknown, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              goal: {
                id: "goal",
                source: "betterc0de",
                objective: "Fix My UI",
                status: "active",
                startedAt: 1000,
                updatedAt: 2000,
              },
            }),
            { status: 200 }
          )
      )
      vi.stubGlobal("fetch", fetch)
      for (const command of ["/goal Fix My UI", "/goal continue"]) {
        await useAppStore
          .getState()
          .send(liveApi("http://localhost:4321"), "thread-1", command, {
            key: "selected",
            modelId: "selected-model",
            providerKind,
            providerInstanceId: "selected-instance",
          } as Parameters<ReturnType<typeof useAppStore.getState>["send"]>[3])
        expect(fetch.mock.calls.at(-1)?.[0]).toContain("/chat/goal")
        expect(
          JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))
        ).toMatchObject({
          message: command,
          modelId: "selected-model",
          providerKind,
          providerInstanceId: "selected-instance",
          projectPath: "/repo",
        })
      }
      expect(
        useAppStore.getState().messagesByThread["thread-1"]
      ).toBeUndefined()
      expect(useAppStore.getState().streamsByThread["thread-1"]).toBeUndefined()
    }
  )
})

function goalThread(): ChatThread {
  return {
    id: "thread-1",
    title: "Thread",
    projectName: "Project",
    projectPath: "/repo",
    messages: [],
    createdAt: "2026-09-14T00:00:00Z",
    updatedAt: "2026-09-14T00:00:00Z",
    goal: null,
  }
}
function goalFrame(goal: unknown) {
  return {
    channel: "provider.runtimeEvent",
    data: {
      event_type: "thread.metadata.updated",
      thread_id: "thread-1",
      payload: { providerKind: "codex", metadata: { goal } },
    },
  }
}

describe("mobile app store fixes", () => {
  beforeEach(() => useAppStore.getState().reset())

  const thread = (id: string, updatedAt: string): ChatThread => ({
    ...goalThread(),
    id,
    title: id,
    updatedAt,
  })

  function fakeApi(overrides: Partial<RemoteApi>): RemoteApi {
    return overrides as RemoteApi
  }

  it("pages through all chats instead of stopping at the first hundred", async () => {
    const pages: Record<
      string,
      { threads: ChatThread[]; nextCursor: string | null }
    > = {
      first: {
        threads: [
          thread("a", "2026-09-20T00:00:03Z"),
          thread("b", "2026-09-20T00:00:02Z"),
        ],
        nextCursor: "c1",
      },
      c1: { threads: [thread("c", "2026-09-20T00:00:01Z")], nextCursor: null },
    }
    const api = fakeApi({
      listThreadsPage: vi.fn(async (cursor) => pages[cursor ?? "first"]!),
    })
    await useAppStore.getState().refreshThreads(api)
    expect(useAppStore.getState().nextThreadsCursor).toBe("c1")
    await useAppStore.getState().loadMoreThreads(api)
    expect(useAppStore.getState().threads.map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ])
    expect(useAppStore.getState().nextThreadsCursor).toBeNull()

    // A refresh of the first page keeps the chats from later pages.
    pages.first = { ...pages.first!, nextCursor: "c1" }
    await useAppStore.getState().refreshThreads(api)
    expect(useAppStore.getState().threads.map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("fetches a chat that is not in the loaded pages", async () => {
    const getThread = vi.fn(async (id: string) =>
      id === "far" ? thread("far", "2020-01-01T00:00:00Z") : null
    )
    const api = fakeApi({ getThread })
    expect(await useAppStore.getState().ensureThread(api, "far")).toMatchObject(
      { id: "far" }
    )
    expect(useAppStore.getState().threads.map((item) => item.id)).toEqual([
      "far",
    ])
    expect(await useAppStore.getState().ensureThread(api, "far")).toMatchObject(
      { id: "far" }
    )
    expect(getThread).toHaveBeenCalledOnce()
    expect(await useAppStore.getState().ensureThread(api, "gone")).toBeNull()
  })

  it("loads the newest messages first and earlier ones on request", async () => {
    const message = (sequence: number) => ({
      id: `m-${sequence}`,
      role: "user" as const,
      content: String(sequence),
      createdAt: "2026-09-20T00:00:00Z",
      sequence,
    })
    const all = Array.from({ length: 250 }, (_, index) => message(index))
    const listMessages = vi.fn(
      async (
        _threadId: string,
        options?: { limit?: number; beforeSequence?: number }
      ) => {
        const before = options?.beforeSequence ?? Infinity
        const eligible = all.filter((item) => item.sequence < before)
        return eligible.slice(-(options?.limit ?? eligible.length))
      }
    )
    const api = fakeApi({ listMessages })
    await useAppStore.getState().loadMessages(api, "thread-1")
    expect(useAppStore.getState().messagesByThread["thread-1"]).toHaveLength(
      200
    )
    expect(useAppStore.getState().earlierMessagesByThread["thread-1"]).toBe(
      true
    )
    await useAppStore.getState().loadEarlierMessages(api, "thread-1")
    const loaded = useAppStore.getState().messagesByThread["thread-1"]!
    expect(loaded.map((item) => item.id)).toEqual(all.map((item) => item.id))
    expect(useAppStore.getState().earlierMessagesByThread["thread-1"]).toBe(
      false
    )
    expect(listMessages).toHaveBeenLastCalledWith("thread-1", {
      limit: 200,
      beforeSequence: 50,
    })

    // Reloading the newest page keeps the earlier page the user opened.
    await useAppStore.getState().loadMessages(api, "thread-1")
    expect(useAppStore.getState().messagesByThread["thread-1"]).toHaveLength(
      250
    )
  })

  it("records why the chat list could not load", async () => {
    const api = fakeApi({
      listThreadsPage: vi.fn(async () => {
        throw new RemoteApiError("fetch failed", 0, "network")
      }),
    })
    await expect(useAppStore.getState().refreshThreads(api)).rejects.toThrow()
    expect(useAppStore.getState().threadsError).toContain(
      "same network or tailnet"
    )
    expect(useAppStore.getState().loadingThreads).toBe(false)
  })

  it("stops the agent that runs the turn, not the one now shown in the picker", () => {
    const picker = {
      key: "k",
      providerKind: "codex",
      providerInstanceId: "codex-1",
      providerLabel: "Codex",
      modelId: "m",
      modelLabel: "M",
      capabilities: null,
    }
    const running = {
      turnId: "t",
      content: "",
      reasoning: "",
      running: true,
      error: null,
      startedAt: "now",
      providerKind: "claude",
      providerInstanceId: "claude-1",
    }
    const chat = {
      ...goalThread(),
      session: { providerKind: "cursor", providerInstanceId: "cursor-1" },
    }
    expect(interruptTarget(running, chat, picker)).toEqual({
      providerKind: "claude",
      providerInstanceId: "claude-1",
    })
    expect(interruptTarget(undefined, chat, picker)).toEqual({
      providerKind: "cursor",
      providerInstanceId: "cursor-1",
    })
    expect(interruptTarget(undefined, goalThread(), picker)).toEqual({
      providerKind: "codex",
      providerInstanceId: "codex-1",
    })
    expect(interruptTarget(undefined, goalThread(), undefined)).toBeNull()
  })

  it("remembers the provider a turn started with", () => {
    useAppStore.getState().applyFrame({
      channel: "provider.runtimeEvent",
      data: {
        event_type: "turn_started",
        thread_id: "thread-1",
        turn_id: "t1",
        providerKind: "claude",
        providerInstanceId: "claude-1",
      },
    })
    expect(useAppStore.getState().streamsByThread["thread-1"]).toMatchObject({
      providerKind: "claude",
      providerInstanceId: "claude-1",
    })
  })

  it("recognises the finished reply by its turn even when the phone's clock is ahead", () => {
    const stream = {
      turnId: "turn-2",
      content: "Answer",
      reasoning: "",
      running: false,
      error: null,
      // The phone's clock runs ten minutes ahead of the desktop's.
      startedAt: "2026-09-14T10:10:00.000Z",
    }
    const earlier = {
      id: "a1",
      role: "assistant" as const,
      content: "Old",
      createdAt: "2026-09-14T09:00:00.000Z",
      turnId: "turn-1",
    }
    const reply = {
      id: "a2",
      role: "assistant" as const,
      content: "Answer",
      createdAt: "2026-09-14T10:00:05.000Z",
      turnId: "turn-2",
    }
    expect(shouldClearCompletedStream(stream, [earlier])).toBe(false)
    expect(shouldClearCompletedStream(stream, [earlier, reply])).toBe(true)
  })
})
