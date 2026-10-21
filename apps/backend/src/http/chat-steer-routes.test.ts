import { describe, expect, it, vi } from "vitest"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import { buildApp as buildAppUnfilled } from "./router"
import { routerLifecycleServices } from "../testUtils/routing-services"
import { withInertStateArgument } from "../testUtils/inert-app-state"

// Doubles name only what a test exercises; the rest is filled in inert.
const buildApp = withInertStateArgument(buildAppUnfilled, 1)

function makeConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 3773,
    dataDir: "/tmp/betterc0de-test",
    dbPath: "/tmp/betterc0de-test/betterc0de.db",
    settingsPath: "/tmp/betterc0de-test/settings.json",
    authPath: "/tmp/betterc0de-test/auth.json",
    logsDir: "/tmp/betterc0de-test/logs",
    providerLogsDir: "/tmp/betterc0de-test/logs/provider",
    providerEventLogPath: "/tmp/betterc0de-test/logs/provider/events.log",
    authToken: "secret",
  }
}

function makeState(adapter: Record<string, unknown> | null) {
  const persistSteeredUserMessage = vi.fn()
  const state = {
    ...routerLifecycleServices(),
    providerRegistry: { all: () => [] },
    providers: {
      withThreadMaintenance: async (_threadId: string, run: () => unknown) =>
        run(),
    },
    threads: {
      hasThread: vi.fn(() => true),
      persistSteeredUserMessage,
    },
    chatDispatches: {
      getActiveForThread: vi.fn(() => ({ messageId: "turn-user" })),
    },
    providerHub: {
      resolve: vi.fn(() => adapter),
      withThreadMaintenance: async (_threadId: string, run: () => unknown) =>
        run(),
    },
  } as unknown as AppState
  return { state, persistSteeredUserMessage }
}

const image = {
  type: "file",
  filename: "screen.png",
  mediaType: "image/png",
  url: "data:image/png;base64,aGVsbG8=",
}
const element = {
  type: "browser-element",
  filename: "<button> Buy",
  mediaType: "application/vnd.betterc0de.browser-element+json",
  url: "data:application/vnd.betterc0de.browser-element+json,%7B%7D",
}

function steer(state: AppState, body: Record<string, unknown> = {}) {
  return buildApp(makeConfig(), state).request("/api/v1/chat/steer", {
    method: "POST",
    headers: {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      threadId: "thread-1",
      providerKind: "codex",
      providerInstanceId: "codex",
      message: "Keep the public API",
      userMessageId: "queued-1",
      userMessageContent: "Keep the public API",
      userMessageCreatedAt: "2026-10-20T10:00:05.000Z",
      modelId: "gpt-5.5-codex",
      attachments: [image, element],
      ...body,
    }),
  })
}

describe("/chat/steer", () => {
  it("puts the message into the running turn and stores it in front of the turn's answer", async () => {
    const steerTurn = vi.fn(async () => ({
      status: "steered" as const,
      turnId: "turn-1",
    }))
    const { state, persistSteeredUserMessage } = makeState({
      hasSession: () => true,
      steerTurn,
    })

    const response = await steer(state)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "steered" })
    expect(steerTurn).toHaveBeenCalledWith({
      threadId: "thread-1",
      message: "Keep the public API",
      attachments: [image],
    })
    expect(persistSteeredUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: "thread-1",
        message: expect.objectContaining({
          message_id: "queued-1",
          role: "user",
          content: "Keep the public API",
          created_at: "2026-10-20T10:00:05.000Z",
          extra: expect.objectContaining({
            attachments: [image, element],
          }),
        }),
      }),
      "turn-user"
    )
  })

  it("stores nothing when the provider cannot take input mid-turn", async () => {
    const { state, persistSteeredUserMessage } = makeState({
      hasSession: () => true,
    })

    const response = await steer(state)

    expect(await response.json()).toEqual({ status: "unsupported" })
    expect(persistSteeredUserMessage).not.toHaveBeenCalled()
  })

  it("answers unsupported for providers outside the hub, such as plugins", async () => {
    const { state } = makeState(null)

    const response = await steer(state, { providerKind: "my-plugin" })

    expect(await response.json()).toEqual({ status: "unsupported" })
    expect(state.providerHub.resolve).not.toHaveBeenCalled()
  })

  it("reports a chat without a running session and leaves the message to the queue", async () => {
    const steerTurn = vi.fn()
    const { state, persistSteeredUserMessage } = makeState({
      hasSession: () => false,
      steerTurn,
    })

    const response = await steer(state)

    expect(await response.json()).toEqual({ status: "not_running" })
    expect(steerTurn).not.toHaveBeenCalled()
    expect(persistSteeredUserMessage).not.toHaveBeenCalled()
  })

  it("refuses a request without a message", async () => {
    const { state } = makeState({ hasSession: () => true, steerTurn: vi.fn() })

    const response = await steer(state, { message: "   " })

    expect(response.status).toBe(400)
  })
})
