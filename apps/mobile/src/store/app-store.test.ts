import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatThread, ConnectionProfile } from "@/types/remote"
import type { ThreadActivity } from "@/types/remote"
import {
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
      const profile = {
        baseUrl: "https://old.test",
        sessionToken: "old",
      } as ConnectionProfile
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
        .send(
          {
            baseUrl: "https://old.test",
            sessionToken: "old",
          } as ConnectionProfile,
          "thread-1",
          "hello",
          {
            modelId: "model",
            providerKind: "codex",
            providerInstanceId: "codex",
          } as Parameters<ReturnType<typeof useAppStore.getState>["send"]>[3]
        )
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
      .createThread(
        {
          baseUrl: "https://old.test",
          sessionToken: "old",
        } as ConnectionProfile,
        { name: "Old", path: "/old" }
      )
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
    const loading = useAppStore.getState().refreshThreads({
      baseUrl: "http://localhost:4321",
      sessionToken: "session",
    } as ConnectionProfile)
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
      .send(
        {
          baseUrl: "http://localhost:4321",
          sessionToken: "session",
        } as ConnectionProfile,
        "thread-1",
        "/goal pause",
        {
          key: "test",
          modelId: "test",
          providerKind: "codex",
          providerInstanceId: "codex",
        } as Parameters<ReturnType<typeof useAppStore.getState>["send"]>[3]
      )
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
          .send(
            {
              baseUrl: "http://localhost:4321",
              sessionToken: "session",
            } as ConnectionProfile,
            "thread-1",
            command,
            {
              key: "selected",
              modelId: "selected-model",
              providerKind,
              providerInstanceId: "selected-instance",
            } as Parameters<ReturnType<typeof useAppStore.getState>["send"]>[3]
          )
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
