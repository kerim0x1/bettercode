import { beforeEach, describe, expect, it, vi } from "vitest"
import { WS_METHODS } from "@betterc0de/schema"
import { TERMINAL_METHODS } from "@betterc0de/schema/remote-terminal"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import {
  backendMetrics,
  RPC_REQUEST_DURATION_MS,
  RPC_REQUESTS_TOTAL,
} from "../observability/metrics"
import { createWsRpcHandler } from "./rpc"
import type { WsConnection } from "./server"
import { RemoteTerminalChannel } from "./terminalChannel"

const LOCAL_PRINCIPAL = { kind: "local" as const }

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

function makeState() {
  const instanceSnapshot = {
    instanceId: "codex",
    driver: "codex",
    displayName: "Codex",
    enabled: true,
    environment: [],
    config: { binaryPath: "codex", homePath: "/Users/example/.codex" },
    configured: true,
    capabilities: {
      supportsStreaming: true,
      supportsTools: true,
      supportsApprovals: true,
      supportsResume: true,
      managesOwnLifecycle: true,
    },
  }
  const models = [{ slug: "gpt-5.3-codex", name: "Codex 5.3", context: "1M" }]

  return {
    providerHub: {
      listInstances: vi.fn(() => [instanceSnapshot]),
      modelsForInstance: vi.fn(async (instanceId: string) =>
        instanceId === "codex" ? models : []
      ),
      getInstance: vi.fn((instanceId: string) =>
        instanceId === "codex"
          ? {
              ...instanceSnapshot,
              provider: "codex",
              adapter: {
                availableModels: vi.fn(async () => models),
              },
            }
          : null
      ),
    },
    threadActivities: {
      listByThreadPage: vi.fn((threadId: string) => ({
        items: [
          {
            activity_id: "activity-1",
            thread_id: threadId,
            turn_id: "turn-1",
            kind: "tool.started",
            tone: "tool",
            summary: "exec_command: npm test",
            payload: { toolName: "exec_command" },
            sequence: 42,
            created_at: "2026-05-11T00:00:00.000Z",
          },
        ],
        next: {
          sequence: 42,
          createdAt: "2026-05-11T00:00:00.000Z",
          activityId: "activity-1",
        },
      })),
    },
  } as unknown as AppState
}

describe("createWsRpcHandler", () => {
  beforeEach(() => {
    backendMetrics.reset()
  })

  it("exposes server config and provider instance read models", async () => {
    const state = makeState()
    const handler = createWsRpcHandler(state, makeConfig())

    await expect(
      handler(WS_METHODS.serverGetConfig, {}, LOCAL_PRINCIPAL)
    ).resolves.toMatchObject({
      host: "127.0.0.1",
      port: 3773,
      dataDir: "/tmp/betterc0de-test",
      providerInstances: [{ instanceId: "codex", driver: "codex" }],
    })

    await expect(
      handler(WS_METHODS.providersListInstances, {}, LOCAL_PRINCIPAL)
    ).resolves.toMatchObject([
      { instanceId: "codex", displayName: "Codex", configured: true },
    ])
    await expect(
      handler(
        WS_METHODS.providersModelsForInstance,
        { instanceId: "codex" },
        LOCAL_PRINCIPAL
      )
    ).resolves.toEqual([
      { slug: "gpt-5.3-codex", name: "Codex 5.3", context: "1M" },
    ])
  })

  it("maps durable thread activities to the renderer wire shape", async () => {
    const state = makeState()
    const handler = createWsRpcHandler(state, makeConfig())

    await expect(
      handler(
        WS_METHODS.threadsListActivities,
        { threadId: "thread-1" },
        LOCAL_PRINCIPAL
      )
    ).resolves.toEqual([
      {
        id: "activity-1",
        threadId: "thread-1",
        turnId: "turn-1",
        providerInstanceId: null,
        kind: "tool.started",
        tone: "tool",
        summary: "exec_command: npm test",
        payload: { toolName: "exec_command" },
        sequence: 42,
        createdAt: "2026-05-11T00:00:00.000Z",
      },
    ])
    expect(state.threadActivities.listByThreadPage).toHaveBeenCalledWith(
      "thread-1",
      {
        limit: undefined,
        before: undefined,
        beforeSequence: undefined,
      }
    )
  })

  it("validates activity pagination and optionally returns a next cursor", async () => {
    const state = makeState()
    const handler = createWsRpcHandler(state, makeConfig())

    const first = (await handler(
      WS_METHODS.threadsListActivities,
      { threadId: "thread-1", limit: 25, includePage: true },
      LOCAL_PRINCIPAL
    )) as {
      items: Array<{ id: string }>
      nextCursor: string | null
    }
    expect(first.items).toEqual([expect.objectContaining({ id: "activity-1" })])
    expect(first.nextCursor).toEqual(expect.any(String))

    await expect(
      handler(
        WS_METHODS.threadsListActivities,
        {
          threadId: "thread-1",
          limit: 25,
          cursor: first.nextCursor,
        },
        LOCAL_PRINCIPAL
      )
    ).resolves.toEqual([expect.objectContaining({ id: "activity-1" })])
    expect(state.threadActivities.listByThreadPage).toHaveBeenLastCalledWith(
      "thread-1",
      {
        limit: 25,
        before: {
          sequence: 42,
          createdAt: "2026-05-11T00:00:00.000Z",
          activityId: "activity-1",
        },
        beforeSequence: undefined,
      }
    )

    for (const params of [
      { threadId: "thread-1", limit: 0 },
      { threadId: "thread-1", limit: "25" },
      { threadId: "thread-1", beforeSequence: -1 },
      { threadId: "thread-1", cursor: "not-base64-json" },
      { threadId: "thread-1", includePage: "yes" },
      {
        threadId: "thread-1",
        cursor: first.nextCursor,
        beforeSequence: 42,
      },
    ]) {
      await expect(
        handler(WS_METHODS.threadsListActivities, params, LOCAL_PRINCIPAL)
      ).rejects.toMatchObject({
        code: "INVALID_ACTIVITY_PAGINATION",
        statusCode: 400,
      })
    }
  })

  it("rejects unknown methods", async () => {
    const handler = createWsRpcHandler(makeState(), makeConfig())

    await expect(
      handler("missing.method", {}, LOCAL_PRINCIPAL)
    ).rejects.toThrow("Unknown RPC method")
  })

  it("withholds the host data directory from a full-access remote session", async () => {
    const handler = createWsRpcHandler(makeState(), makeConfig())
    const principal = {
      kind: "remote" as const,
      sessionId: "full-session",
      accessLevel: "full" as const,
      expiresAt: Date.now() + 60_000,
    }

    const config = (await handler(
      WS_METHODS.serverGetConfig,
      {},
      principal
    )) as Record<string, unknown>

    expect(config).toMatchObject({ host: "127.0.0.1", port: 3773 })
    expect(config).not.toHaveProperty("dataDir")
    expect(JSON.stringify(config)).not.toContain("/tmp/betterc0de-test")
  })

  it("restricts read-only remote sessions to the monitoring allowlist", async () => {
    const state = makeState()
    const handler = createWsRpcHandler(state, makeConfig())
    const principal = {
      kind: "remote" as const,
      sessionId: "read-only-session",
      accessLevel: "read_only" as const,
      expiresAt: Date.now() + 60_000,
    }

    // serverGetConfig is deliberately NOT in the read-only allowlist (it
    // exposes the auth-relevant backend config), so it must fail closed.
    await expect(
      handler(WS_METHODS.serverGetConfig, {}, principal)
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "REMOTE_READ_ONLY",
    })
    await expect(
      handler(
        WS_METHODS.threadsListActivities,
        { threadId: "thread-1" },
        principal
      )
    ).resolves.toMatchObject([{ id: "activity-1" }])
  })

  it("records RPC success and failure metrics", async () => {
    const handler = createWsRpcHandler(makeState(), makeConfig())

    await handler(WS_METHODS.serverGetConfig, {}, LOCAL_PRINCIPAL)
    await expect(
      handler("missing.method", {}, LOCAL_PRINCIPAL)
    ).rejects.toThrow("Unknown RPC method")

    expect(backendMetrics.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "counter",
          name: RPC_REQUESTS_TOTAL,
          attributes: {
            method: WS_METHODS.serverGetConfig,
            outcome: "success",
          },
          value: 1,
        }),
        expect.objectContaining({
          type: "counter",
          name: RPC_REQUESTS_TOTAL,
          attributes: { method: "unknown", outcome: "failure" },
          value: 1,
        }),
        expect.objectContaining({
          type: "timer",
          name: RPC_REQUEST_DURATION_MS,
          attributes: { method: WS_METHODS.serverGetConfig },
          count: 1,
        }),
      ])
    )
  })

  it("gives the terminal's methods to the terminal, which says itself who gets one", async () => {
    const state = makeState() as unknown as AppState
    const terminals = new RemoteTerminalChannel({
      state,
      terminalGranted: () => true,
    })
    const handler = createWsRpcHandler(state, makeConfig(), terminals)
    const connection: WsConnection = {
      send: () => undefined,
      bufferedAmount: () => 0,
      isOpen: () => true,
      onClose: () => () => undefined,
    }
    const remote = (accessLevel: "full" | "read_only") => ({
      kind: "remote" as const,
      sessionId: "phone-1",
      accessLevel,
      expiresAt: Date.now() + 60_000,
    })

    await expect(
      handler(TERMINAL_METHODS.list, {}, LOCAL_PRINCIPAL, connection)
    ).rejects.toMatchObject({ code: "remote_terminal_only" })
    // Not the general read-only refusal: the terminal's own reason.
    await expect(
      handler(TERMINAL_METHODS.list, {}, remote("read_only"), connection)
    ).rejects.toMatchObject({ code: "remote_terminal_disabled" })
    await expect(
      handler(TERMINAL_METHODS.list, {}, remote("full"), connection)
    ).resolves.toEqual({ terminals: [] })
    // Without a socket there is no terminal to speak of.
    await expect(
      handler(TERMINAL_METHODS.list, {}, remote("full"))
    ).rejects.toThrow("Unknown RPC method")
  })
})
