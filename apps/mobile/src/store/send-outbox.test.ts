import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatAttachment } from "@betterc0de/schema/chat-attachment"
import {
  PERMISSION_MODE_FAILED,
  PERMISSION_MODE_QUEUED,
} from "@betterc0de/schema/chat-controls"
import { httpContracts } from "@betterc0de/schema/http-contracts"
import { DEFAULT_MAX_REQUEST_BYTES } from "@/lib/compat"
import { setMaxRequestBytes } from "@/lib/request-limit"
import { requestBytes } from "@/lib/request-size"
import { createLiveApi } from "@/transport/live/api"
import { RemoteApiError } from "@/transport/live/http"
import type { ChatRequestBody, RemoteApi } from "@/transport/types"
import type { ChatThread, ModelOption } from "@/types/remote"
import { MESSAGE_TOO_LARGE, useAppStore } from "./app-store"
import { useComposerSettings } from "./composer-settings-store"

const selection: ModelOption = {
  key: "claude:sonnet",
  providerKind: "claude",
  providerInstanceId: "claude-1",
  providerLabel: "Claude",
  modelId: "sonnet",
  modelLabel: "Sonnet",
  capabilities: null,
}

function chat(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-1",
    title: "New Chat",
    projectName: "Project",
    projectPath: "/repo",
    messages: [],
    createdAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T08:00:00.000Z",
    ...overrides,
  }
}

/** A desktop whose `/chat/send` answers are scripted, one per call. */
function desktop(...answers: Array<Error | { turnId: string }>) {
  const bodies: ChatRequestBody[] = []
  const sendMessage = vi.fn(async (body: ChatRequestBody) => {
    bodies.push(body)
    const answer = answers.shift()
    if (!answer) throw new Error("unexpected send")
    if (answer instanceof Error) throw answer
    return { status: "streaming" as const, turnId: answer.turnId }
  })
  return { api: { sendMessage } as unknown as RemoteApi, bodies, sendMessage }
}

const refusal = (code: string, status = 409) =>
  new RemoteApiError(`desktop says ${code}`, status, code)
const timeout = () =>
  new RemoteApiError("The desktop did not answer in time.", 0, "timeout")

const store = () => useAppStore.getState()
const messages = () => store().messagesByThread["thread-1"] ?? []
const withoutHistory = ({ history: _history, ...body }: ChatRequestBody) => body

describe("sending messages through the outbox", () => {
  beforeEach(() => {
    store().reset()
    useComposerSettings.setState({ byThread: {} })
    useAppStore.setState({ threads: [chat()] })
  })

  it("keeps a failed message and resends the same request under the same id", async () => {
    const { api, bodies } = desktop(timeout(), { turnId: "turn-1" })

    expect(
      await store().send(api, "thread-1", "Fix the login", selection)
    ).toEqual({
      status: "failed",
      error: expect.stringContaining("did not answer"),
    })
    const [failed] = messages()
    expect(failed).toMatchObject({
      content: "Fix the login",
      dispatchStatus: "failed",
      dispatchFailed: true,
    })
    expect(store().outbox[failed!.id]).toMatchObject({
      retryable: true,
      error: expect.stringContaining("did not answer"),
    })
    // Nothing is left spinning for a turn that never started.
    expect(store().streamsByThread["thread-1"]).toBeUndefined()

    // The desktop names the chat meanwhile; the retry must not carry the
    // new title, or the desktop would take it for a different message.
    useAppStore.setState((state) => ({
      threads: state.threads.map((item) => ({ ...item, title: "Login fix" })),
    }))
    expect(await store().retrySend(api, failed!.id)).toEqual({ status: "sent" })

    expect(bodies).toHaveLength(2)
    expect(bodies[1]!.userMessageId).toBe(failed!.id)
    expect(withoutHistory(bodies[1]!)).toEqual(withoutHistory(bodies[0]!))
    expect(bodies[1]!.threadTitle).toBe("New Chat")
    expect(messages()).toEqual([
      expect.objectContaining({ id: failed!.id, dispatchStatus: "accepted" }),
    ])
    expect(store().outbox).toEqual({})
    expect(store().streamsByThread["thread-1"]).toMatchObject({
      running: true,
      turnId: "turn-1",
      providerKind: "claude",
    })
  })

  it("sends the chat's permission preset and mode with every message", async () => {
    useComposerSettings
      .getState()
      .update("thread-1", { permissionLevel: "bypass", chatMode: "plan" })
    const { api, bodies } = desktop({ turnId: "turn-1" })
    await store().send(api, "thread-1", "Plan the refactor", selection)
    expect(bodies[0]).toMatchObject({
      // The desktop runs its hooks and builds the system instruction.
      prepareTurn: true,
      threadId: "thread-1",
      message: "Plan the refactor",
      userMessageContent: "Plan the refactor",
      permissionLevel: "bypass",
      chatMode: "plan",
      providerKind: "claude",
      providerInstanceId: "claude-1",
      modelId: "sonnet",
      projectPath: "/repo",
      appMode: "agent",
    })
  })

  it("sends a request the desktop's chat contract accepts", async () => {
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: "streaming", turnId: "t1" }), {
          status: 200,
        })
    )
    const api = createLiveApi({
      baseUrl: "http://desktop.local:4321",
      token: "session",
      client: null,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    expect(await store().send(api, "thread-1", "Hello", selection)).toEqual({
      status: "sent",
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe("http://desktop.local:4321/api/v1/chat/send")
    const body: unknown = JSON.parse(String(init?.body))
    expect(() => httpContracts.chatSend.request.parse(body)).not.toThrow()
    expect(body).toMatchObject({
      userMessageId: messages()[0]!.id,
      permissionLevel: "ask-on-edit",
      chatMode: "agent",
    })
  })

  it("uses the desktop's defaults for a chat nobody configured", async () => {
    const { api, bodies } = desktop({ turnId: "turn-1" })
    await store().send(api, "thread-1", "Hello", selection)
    expect(bodies[0]).toMatchObject({
      permissionLevel: "ask-on-edit",
      chatMode: "agent",
    })
  })

  it.each([
    "dispatch_outcome_unknown",
    "dispatch_failed",
    "dispatch_reverted",
    "dispatch_id_conflict",
  ])("offers only Send as new after %s", async (code) => {
    const { api, bodies } = desktop(refusal(code), { turnId: "turn-2" })
    await store().send(api, "thread-1", "Run the tests", selection)
    const [failed] = messages()
    expect(store().outbox[failed!.id]?.retryable).toBe(false)
    await expect(store().retrySend(api, failed!.id)).rejects.toThrow()
    expect(bodies).toHaveLength(1)

    expect(await store().sendAgainAsNew(api, failed!.id)).toEqual({
      status: "sent",
    })
    expect(bodies[1]!.userMessageId).not.toBe(failed!.id)
    expect(bodies[1]!.message).toBe("Run the tests")
    expect(messages().map((message) => message.id)).toEqual([
      bodies[1]!.userMessageId,
    ])
    expect(store().outbox).toEqual({})
  })

  it("takes 'already being started' as sent: the desktop has the message", async () => {
    const { api } = desktop(refusal("dispatch_in_progress"))
    expect(await store().send(api, "thread-1", "Hi", selection)).toEqual({
      status: "sent",
    })
    expect(messages()[0]).toMatchObject({ dispatchStatus: "accepted" })
    expect(store().outbox).toEqual({})
    expect(store().streamsByThread["thread-1"]?.running).toBe(true)
  })

  it("marks a typed message failed when another turn is running", async () => {
    const { api } = desktop(refusal("turn_active"))
    expect(await store().send(api, "thread-1", "Hi", selection)).toMatchObject({
      status: "failed",
    })
    const [failed] = messages()
    expect(failed?.dispatchFailed).toBe(true)
    // Nothing was recorded, so the same request may go again.
    expect(store().outbox[failed!.id]?.retryable).toBe(true)
  })

  it("removes a failed message on request", async () => {
    const { api } = desktop(timeout())
    await store().send(api, "thread-1", "Hi", selection)
    const [failed] = messages()
    store().discardFailed(failed!.id)
    expect(messages()).toEqual([])
    expect(store().outbox).toEqual({})
  })

  it("keeps a message the desktop has not recorded when the chat reloads", async () => {
    const { api } = desktop(timeout())
    await store().send(api, "thread-1", "Hi", selection)
    const [failed] = messages()
    const listMessages = vi.fn(async () => [
      {
        id: "earlier",
        role: "assistant" as const,
        content: "Earlier reply",
        createdAt: "2026-09-24T08:00:00.000Z",
      },
    ])
    await store().loadMessages(
      { listMessages } as unknown as RemoteApi,
      "thread-1"
    )
    expect(messages().map((message) => message.id)).toEqual([
      "earlier",
      failed!.id,
    ])
  })

  it("sends everything but the history exactly as the first time", async () => {
    const { api, bodies } = desktop(timeout(), { turnId: "turn-1" })
    await store().send(api, "thread-1", "Second question", selection)
    const [failed] = messages()
    // A reply arrives from the desktop before the retry.
    useAppStore.setState((state) => ({
      messagesByThread: {
        "thread-1": [
          {
            id: "a1",
            role: "assistant",
            content: "Answer to the first question",
            createdAt: "2026-09-24T08:01:00.000Z",
          },
          ...(state.messagesByThread["thread-1"] ?? []),
        ],
      },
    }))
    await store().retrySend(api, failed!.id)
    expect(bodies[0]!.history).toEqual([])
    expect(bodies[1]!.history).toEqual([
      { role: "assistant", content: "Answer to the first question" },
    ])
  })
})

describe("sending queued messages", () => {
  const delivery = {
    messageId: "queued-1",
    createdAt: "2026-09-24T09:00:00.000Z",
    owner: "queue" as const,
    turnOptions: { thinkingMode: "high", fastMode: true },
  }

  beforeEach(() => {
    store().reset()
    useComposerSettings.setState({ byThread: {} })
    useAppStore.setState({ threads: [chat()] })
  })

  it("sends under the queued id, time and turn options", async () => {
    const { api, bodies } = desktop({ turnId: "turn-1" })
    expect(
      await store().send(api, "thread-1", "Next step", selection, delivery)
    ).toEqual({ status: "sent" })
    expect(bodies[0]).toMatchObject({
      userMessageId: "queued-1",
      userMessageCreatedAt: "2026-09-24T09:00:00.000Z",
      reasoningEffort: "high",
      fastMode: true,
    })
    expect(messages()).toEqual([
      expect.objectContaining({ id: "queued-1", dispatchStatus: "accepted" }),
    ])
  })

  it("leaves no trace when the chat turns out to be busy", async () => {
    const { api } = desktop(refusal("turn_active"))
    expect(
      await store().send(api, "thread-1", "Next step", selection, delivery)
    ).toEqual({ status: "busy" })
    expect(messages()).toEqual([])
    expect(store().outbox).toEqual({})
    expect(store().streamsByThread["thread-1"]).toBeUndefined()
  })

  it("leaves the chat but keeps its request when delivery is unknown", async () => {
    const { api, bodies } = desktop(timeout(), { turnId: "turn-1" })
    expect(
      await store().send(api, "thread-1", "Next step", selection, delivery)
    ).toMatchObject({ status: "failed" })
    // The queue shows the failure; the chat does not show it twice.
    expect(messages()).toEqual([])
    expect(store().outbox["queued-1"]).toMatchObject({ owner: "queue" })

    // Resuming the queue sends the same request again.
    useAppStore.setState((state) => ({
      threads: state.threads.map((item) => ({ ...item, title: "Renamed" })),
    }))
    await store().send(api, "thread-1", "Next step", selection, delivery)
    expect(withoutHistory(bodies[1]!)).toEqual(withoutHistory(bodies[0]!))
    expect(store().outbox).toEqual({})
  })

  it("forgets requests of queued messages the queue no longer holds", async () => {
    const { api } = desktop(timeout())
    await store().send(api, "thread-1", "Next step", selection, delivery)
    store().pruneQueueOutbox(new Set(["queued-1"]))
    expect(Object.keys(store().outbox)).toEqual(["queued-1"])
    store().pruneQueueOutbox(new Set())
    expect(store().outbox).toEqual({})
  })
})

describe("changing the permission preset", () => {
  const running = {
    turnId: "turn-1",
    content: "",
    reasoning: "",
    running: true,
    error: null,
    startedAt: "2026-09-24T09:00:00.000Z",
    providerKind: "codex",
    providerInstanceId: "codex-1",
  }

  beforeEach(() => {
    store().reset()
    useComposerSettings.setState({ byThread: {} })
    useAppStore.setState({ threads: [chat()] })
  })

  function api(answer: () => Promise<unknown>) {
    const setPermissionMode = vi.fn(answer)
    return {
      api: { setPermissionMode } as unknown as RemoteApi,
      setPermissionMode,
    }
  }

  it("saves the preset and switches the running turn's provider", async () => {
    useAppStore.setState({ streamsByThread: { "thread-1": running } })
    const { api: desktopApi, setPermissionMode } = api(async () => ({
      status: "acknowledged",
      applied: "live",
    }))
    expect(
      await store().changePermissionLevel(desktopApi, "thread-1", "allow-edits")
    ).toBeNull()
    expect(setPermissionMode).toHaveBeenCalledWith({
      threadId: "thread-1",
      permissionLevel: "allow-edits",
      providerKind: "codex",
      providerInstanceId: "codex-1",
    })
    expect(
      useComposerSettings.getState().settingsFor("thread-1")
    ).toMatchObject({ permissionLevel: "allow-edits" })
  })

  it("says when the running turn keeps its permissions until the next message", async () => {
    useAppStore.setState({ streamsByThread: { "thread-1": running } })
    const { api: desktopApi } = api(async () => ({
      status: "acknowledged",
      applied: "queued",
    }))
    expect(
      await store().changePermissionLevel(desktopApi, "thread-1", "read-only")
    ).toBe(PERMISSION_MODE_QUEUED)
  })

  it("says when the desktop could not switch the running turn", async () => {
    useAppStore.setState({ streamsByThread: { "thread-1": running } })
    const { api: desktopApi } = api(async () => {
      throw new RemoteApiError("boom", 500)
    })
    expect(
      await store().changePermissionLevel(desktopApi, "thread-1", "bypass")
    ).toBe(PERMISSION_MODE_FAILED)
    // The next message still carries the new preset.
    expect(
      useComposerSettings.getState().settingsFor("thread-1").permissionLevel
    ).toBe("bypass")
  })

  it("needs no notice outside a turn", async () => {
    useAppStore.setState({ selectedModels: { "thread-1": selection } })
    const { api: desktopApi, setPermissionMode } = api(async () => ({
      status: "failed",
      error: "no session",
    }))
    expect(
      await store().changePermissionLevel(desktopApi, "thread-1", "read-only")
    ).toBeNull()
    expect(setPermissionMode).toHaveBeenCalledWith(
      expect.objectContaining({ providerKind: "claude" })
    )
  })
})

describe("sending photos", () => {
  /** A JPEG attachment whose data URL carries `base64Chars` characters. */
  const photo = (base64Chars: number, index = 0): ChatAttachment => ({
    type: "file",
    filename: `photo-${index + 1}.jpg`,
    mediaType: "image/jpeg",
    url: `data:image/jpeg;base64,${"A".repeat(base64Chars)}`,
  })

  beforeEach(() => {
    store().reset()
    useComposerSettings.setState({ byThread: {} })
    useAppStore.setState({ threads: [chat()] })
  })

  afterEach(() => setMaxRequestBytes(DEFAULT_MAX_REQUEST_BYTES))

  it("sends the photos with the message, shows them in the chat, and resends them unchanged", async () => {
    const photos = [photo(4_000), photo(8_000, 1)]
    const { api, bodies } = desktop(timeout(), { turnId: "turn-1" })
    await store().send(
      api,
      "thread-1",
      "What is wrong here?",
      selection,
      undefined,
      photos
    )
    expect(bodies[0]!.attachments).toEqual(photos)
    const [failed] = messages()
    expect(failed).toMatchObject({ dispatchFailed: true, attachments: photos })

    await store().retrySend(api, failed!.id)
    expect(bodies[1]!.userMessageId).toBe(failed!.id)
    expect(bodies[1]!.attachments).toEqual(photos)
    expect(messages()[0]).toMatchObject({
      dispatchStatus: "accepted",
      attachments: photos,
    })
  })

  it("sends a request with photos that the desktop's chat contract accepts", async () => {
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: "streaming", turnId: "t1" }), {
          status: 200,
        })
    )
    const api = createLiveApi({
      baseUrl: "http://desktop.local:4321",
      token: "session",
      client: null,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    await store().send(api, "thread-1", "Look", selection, undefined, [
      photo(1_000),
    ])
    const body: unknown = JSON.parse(String(fetch.mock.calls[0]![1]?.body))
    expect(httpContracts.chatSend.request.parse(body)).toMatchObject({
      attachments: [expect.objectContaining({ mediaType: "image/jpeg" })],
    })
  })

  it("keeps the photos when a message is sent again as new", async () => {
    const photos = [photo(2_000)]
    const { api, bodies } = desktop(refusal("dispatch_failed"), {
      turnId: "turn-2",
    })
    await store().send(api, "thread-1", "Look", selection, undefined, photos)
    const [failed] = messages()
    await store().sendAgainAsNew(api, failed!.id)
    expect(bodies[1]!.userMessageId).not.toBe(failed!.id)
    expect(bodies[1]!.attachments).toEqual(photos)
  })

  it("refuses a message larger than the desktop accepts before anything is recorded", async () => {
    setMaxRequestBytes(50_000)
    const { api, sendMessage } = desktop({ turnId: "turn-1" })
    await expect(
      store().send(api, "thread-1", "Look", selection, undefined, [
        photo(60_000),
      ])
    ).rejects.toThrow(MESSAGE_TOO_LARGE)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(messages()).toEqual([])
    expect(store().outbox).toEqual({})
    expect(store().streamsByThread["thread-1"]).toBeUndefined()
  })

  it("leaves out the oldest history rather than send more than the desktop accepts", async () => {
    useAppStore.setState({
      messagesByThread: {
        "thread-1": [
          {
            id: "u1",
            role: "user",
            content: "x".repeat(30_000),
            createdAt: "2026-09-24T08:01:00.000Z",
          },
          {
            id: "a1",
            role: "assistant",
            content: "y".repeat(30_000),
            createdAt: "2026-09-24T08:02:00.000Z",
          },
        ],
      },
    })
    // Room for the message and its photo, and for one of the two replies.
    setMaxRequestBytes(100_000 + 45_000)
    const { api, bodies } = desktop({ turnId: "turn-1" })
    await store().send(api, "thread-1", "Look", selection, undefined, [
      photo(100_000),
    ])
    expect(bodies[0]!.history).toEqual([
      { role: "assistant", content: "y".repeat(30_000) },
    ])
    expect(requestBytes(bodies[0])).toBeLessThanOrEqual(145_000)
  })
})
