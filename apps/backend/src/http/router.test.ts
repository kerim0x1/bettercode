import { routingTestServices } from "../testUtils/routing-services"
import { beforeEach, describe, expect, it, vi } from "vitest"
import path from "node:path"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import {
  backendMetrics,
  HTTP_REQUEST_DURATION_MS,
  HTTP_REQUESTS_TOTAL,
} from "../observability/metrics"
import { checkpointRefForThreadTurn } from "@betterc0de/schema"
import * as git from "../services/git"
import { buildApp } from "./router"
import { recoverPendingCheckpointReverts } from "../services/checkpoint-revert-saga"
import {
  buildBetterC0deRuntimePluginInfo,
  buildBetterC0deRuntimePaths,
  writeRuntimeHeapSnapshot,
} from "./routes/runtime"
import {
  awaitApproval,
  getSessionPermission,
  setSessionPermission,
} from "../provider/permissions"
import { ThreadTurnCoordinator } from "../provider/threadTurnCoordinator"
import { workspaceRecoveryGate } from "../services/workspace-recovery-gate"
import { openDatabase } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { CheckpointRefCleanupStore } from "../checkpointing/CheckpointRefCleanupStore"
import { registerThreadActivityBroadcaster } from "../ws/threadActivityBroadcast"
import { OrchestratorService } from "../services/orchestrator/service"

vi.mock("../services/git", async () => {
  const actual =
    await vi.importActual<typeof import("../services/git")>("../services/git")
  return {
    ...actual,
    isRepo: vi.fn(actual.isRepo),
    restoreCheckpoint: vi.fn(actual.restoreCheckpoint),
    deleteCheckpointRefs: vi.fn(actual.deleteCheckpointRefs),
  }
})

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

function normalizeRuntimePaths<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === "string" && /[\\/]/.test(entry)
        ? entry.replace(/\\/g, "/").replace(/^[A-Za-z]:(?=\/)/, "")
        : entry,
    ])
  ) as T
}

function makeState(): AppState {
  return {
    ...routingTestServices(),
    providerRegistry: { all: () => [] },
    threads: { persistUserMessageForTurn: vi.fn() },
    db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
  } as unknown as AppState
}

describe("buildApp HTTP metrics", () => {
  it("enables model-selected delegation in an ordinary chat without creating a team chat or exposing instructions in history", async () => {
    const createThread = vi.fn()
    const persistUserMessageForTurn = vi.fn()
    const startTurn = vi.fn(() => ({
      turnId: "orchestration-admission",
      completion: Promise.resolve(),
    }))
    const orchestrator = new OrchestratorService({
      settings: () => ({ orchestrator_enabled: true, orchestrator_team: null }),
      allowed: () => true,
      load: () => null,
      persist: () => {},
      createThread,
      modelCatalog: async () => [
        {
          id: "astra",
          name: "Astra",
          role: "Assigned by main",
          providerKind: "codex",
          providerInstanceId: "openai-account",
          modelId: "gpt-6-astra",
        },
        {
          id: "sol",
          name: "Sol",
          role: "Assigned by main",
          providerKind: "codex",
          providerInstanceId: "openai-account",
          modelId: "gpt-6-sol",
        },
      ],
      readContextSource: (source) => ({
        source,
        title: "Source",
        body: "Plan",
        truncated: false,
      }),
      dispatch: async () => {},
      interrupt: async () => {},
      reportError: () => {},
    })
    const config = makeConfig()
    const app = buildApp(config, {
      ...makeState(),
      config,
      orchestrator,
      threads: { persistUserMessageForTurn },
      providerHub: { has: () => true, startTurn },
      providerSessionBindings: { getLatestForThreadProvider: () => null },
      projectProjections: { listAll: () => [{ path: process.cwd() }] },
      worktreeRegistry: { listAll: () => [] },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)
    try {
      const send = (orchestration: unknown) =>
        app.request("/api/v1/chat/send", {
          method: "POST",
          headers: {
            Authorization: "Bearer secret",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            threadId: "ordinary-chat",
            providerKind: "claude",
            providerInstanceId: "claude-main",
            modelId: "fable",
            message: "Implement the plan",
            chatMode: "agent",
            projectPath: process.cwd(),
            orchestration,
          }),
        })
      expect((await send({ enabled: true, providers: ["other"] })).status).toBe(
        400
      )
      expect(
        (await send({ enabled: true, providers: ["codex"], models: [] })).status
      ).toBe(400)
      expect(startTurn).not.toHaveBeenCalled()
      const models = [
        {
          providerKind: "codex",
          providerInstanceId: "openai-account",
          modelId: "gpt-6-astra",
        },
      ]
      const response = await send({
        enabled: true,
        providers: ["codex"],
        models,
      })
      expect(response.status, await response.clone().text()).toBe(200)
      expect(createThread).not.toHaveBeenCalled()
      expect(orchestrator.status("ordinary-chat")?.selectedModels).toEqual(
        models
      )
      expect(
        orchestrator
          .availableModels("ordinary-chat")
          .models.map((model) => model.modelId)
      ).toEqual(["gpt-6-astra"])
      expect(orchestrator.status("ordinary-chat")).toMatchObject({
        mode: "chat",
        allowedProviders: ["codex"],
        team: { main: { modelId: "fable" } },
      })
      expect(startTurn).toHaveBeenCalledWith(
        "claude",
        expect.objectContaining({
          threadId: "ordinary-chat",
          message: expect.stringContaining("spawn_agent"),
        }),
        expect.any(Object)
      )
      expect(persistUserMessageForTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ content: "Implement the plan" }),
        })
      )
    } finally {
      await orchestrator.close()
    }
  })

  it("exposes validated team start/status/stop only behind desktop authentication", async () => {
    const config = makeConfig()
    const orchestrator = new OrchestratorService({
      modelCatalog: async () => [],
      readContextSource: (source) => ({
        source,
        title: "Source",
        body: "Approved context",
        truncated: false,
      }),
      settings: () => ({
        orchestrator_enabled: true,
        orchestrator_team: {
          main: {
            providerKind: "claude",
            providerInstanceId: "claude",
            modelId: "fable-test",
          },
          members: [
            {
              id: "builder",
              name: "Builder",
              role: "Implement",
              providerKind: "codex",
              providerInstanceId: "codex",
              modelId: "astra-test",
            },
          ],
          maxConcurrent: 2,
          maxTasks: 12,
        },
      }),
      allowed: () => true,
      load: () => null,
      persist: () => {},
      createThread: () => {},
      dispatch: async () => {},
      interrupt: async () => {},
      reportError: () => {},
    })
    const app = buildApp(config, {
      ...makeState(),
      config,
      orchestrator,
      projectProjections: { listAll: () => [{ path: process.cwd() }] },
      worktreeRegistry: { listAll: () => [] },
      providerSessionBindings: { get: () => null },
    } as unknown as AppState)
    const request = (route: string, body: unknown, authenticated = true) =>
      app.request(`/api/v1/orchestrator/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authenticated ? { Authorization: "Bearer secret" } : {}),
        },
        body: JSON.stringify(body),
      })
    try {
      expect(
        (await request("start", { projectPath: process.cwd() }, false)).status
      ).toBe(401)
      expect((await request("start", { projectPath: 42 })).status).toBe(400)
      const started = await request("start", { projectPath: process.cwd() })
      expect(started.status, await started.clone().text()).toBe(200)
      const team = (await started.json()) as { threadId: string }
      const grantBody = {
        threadId: team.threadId,
        requestId: "context",
        recipient: { kind: "member", memberId: "builder" },
        content: { kind: "thread", threadId: "source" },
      }
      expect((await request("context/grant", grantBody, false)).status).toBe(
        401
      )
      expect(
        (
          await request("context/grant", {
            ...grantBody,
            recipient: { kind: "member", memberId: "missing" },
          })
        ).status
      ).toBe(400)
      const grant = await request("context/grant", grantBody)
      expect(grant.status).toBe(200)
      const context = (await grant.json()) as { id: string }
      expect(
        await (
          await request("context/read", {
            threadId: team.threadId,
            contextId: context.id,
          })
        ).json()
      ).toMatchObject({ body: "Approved context" })
      const status = await request("status", { threadId: team.threadId })
      expect(await status.json()).toMatchObject({
        threadId: team.threadId,
        status: "ready",
        jobs: [],
        context: [{ body: "", readBy: [] }],
      })
      expect(
        (
          await request("context/remove", {
            threadId: team.threadId,
            contextId: context.id,
          })
        ).status
      ).toBe(200)
      expect(
        (
          await request("context/read", {
            threadId: team.threadId,
            contextId: context.id,
          })
        ).status
      ).toBe(404)
      const stopped = await request("stop", { threadId: team.threadId })
      expect(await stopped.json()).toMatchObject({ status: "stopped" })
    } finally {
      await orchestrator.close()
    }
  })

  it.each(["drainingRef", "taintedRef"] as const)(
    "keeps CORS headers during %s without admitting work",
    async (flag) => {
      const app = buildApp(makeConfig(), { ...makeState(), [flag]: () => true })
      const origin = "http://localhost:5174"
      const preflight = await app.request("/api/v1/ws-port", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin)
      const response = await app.request("/api/v1/ws-port", {
        headers: { Origin: origin, Authorization: "Bearer secret" },
      })
      expect(response.status).toBe(503)
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin)
      expect(await response.json()).toEqual({ error: "service draining" })
      const untrusted = await app.request("/api/v1/ws-port", {
        headers: {
          Origin: "https://untrusted.example",
          Authorization: "Bearer secret",
        },
      })
      expect(untrusted.status).toBe(403)
      expect(untrusted.headers.get("Access-Control-Allow-Origin")).toBeNull()
    }
  )

  beforeEach(() => {
    backendMetrics.reset()
  })

  it("keeps the unauthenticated health response minimal", async () => {
    const app = buildApp(makeConfig(), makeState())

    const response = await app.request("/health")

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ status: "ok", db: "ok" })
  })

  it("returns an unhealthy status when SQLite liveness fails", async () => {
    const app = buildApp(makeConfig(), {
      ...makeState(),
      db: {
        prepare: () => ({
          get: () => {
            throw new Error("database unavailable")
          },
        }),
      },
    } as unknown as AppState)

    const response = await app.request("/health")

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      status: "error",
      db: "error",
    })
  })

  it("does not report an authenticated runtime as healthy when SQLite fails", async () => {
    const app = buildApp(makeConfig(), {
      ...makeState(),
      db: {
        prepare: () => ({
          get: () => {
            throw new Error("database unavailable")
          },
        }),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/runtime/health", {
      headers: { Authorization: "Bearer secret" },
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: "error", db: "error" })
  })

  it("records authenticated API request counters and durations", async () => {
    const app = buildApp(makeConfig(), makeState())

    const response = await app.request("/api/v1/runtime/health", {
      headers: { Authorization: "Bearer secret" },
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ status: "ok", db: "ok" })
    expect(backendMetrics.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "counter",
          name: HTTP_REQUESTS_TOTAL,
          attributes: {
            method: "GET",
            path: "/api/v1/runtime/health",
            status: "200",
            outcome: "success",
          },
          value: 1,
        }),
        expect.objectContaining({
          type: "timer",
          name: HTTP_REQUEST_DURATION_MS,
          attributes: {
            method: "GET",
            path: "/api/v1/runtime/health",
            status: "200",
          },
          count: 1,
        }),
      ])
    )
  })

  it("does not record unauthenticated requests rejected before the metrics middleware", async () => {
    const app = buildApp(makeConfig(), makeState())

    const response = await app.request("/api/v1/runtime/health")

    expect(response.status).toBe(401)
    expect(backendMetrics.snapshot()).toEqual([])
  })

  it("aggregates unique unmatched paths into one bounded HTTP metric label", async () => {
    const app = buildApp(makeConfig(), makeState())
    for (let index = 0; index < 25; index += 1) {
      const response = await app.request(`/api/v1/not-found-${index}`, {
        headers: { Authorization: "Bearer secret" },
      })
      expect(response.status).toBe(404)
    }

    const counters = backendMetrics
      .snapshot()
      .filter(
        (metric) =>
          metric.type === "counter" &&
          metric.name === HTTP_REQUESTS_TOTAL &&
          metric.attributes.status === "404"
      )
    expect(counters).toHaveLength(1)
    expect(counters[0]).toMatchObject({
      attributes: { path: "unmatched" },
      value: 25,
    })
  })

  it("rejects malformed provider credentials before writing auth state", async () => {
    const set = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      authStore: { set },
    } as unknown as AppState)

    const response = await app.request("/api/v1/providers/openai/credential", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "oauth" }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid credential" })
    expect(set).not.toHaveBeenCalled()
  })

  it("rejects authenticated requests from arbitrary browser origins", async () => {
    const app = buildApp(makeConfig(), makeState())

    const response = await app.request("/api/v1/runtime/health", {
      headers: {
        Authorization: "Bearer secret",
        Origin: "https://attacker.example",
      },
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "origin not allowed" })
  })

  it("does not trust an unrelated loopback port without the process bearer", async () => {
    const app = buildApp(makeConfig(), makeState())

    const response = await app.request("/api/v1/remote/bootstrap", {
      headers: {
        Origin: "http://127.0.0.1:5173",
        Host: "127.0.0.1:3773",
      },
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "origin not allowed" })
  })

  it("rejects oversized API bodies before route-level JSON parsing", async () => {
    const app = buildApp(makeConfig(), makeState())
    const response = await app.request("/api/v1/providers/openai/credential", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) }),
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "request body too large" })
  })

  it("supports packaged Electron and explicitly configured remote origins", async () => {
    const config = makeConfig()
    config.allowedOrigins = ["https://remote.example"]
    const app = buildApp(config, makeState())

    for (const origin of ["null", "file://", "https://remote.example"]) {
      const response = await app.request("/api/v1/runtime/health", {
        headers: { Authorization: "Bearer secret", Origin: origin },
      })
      expect(response.status, await response.clone().text()).toBe(200)
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin)
    }
  })

  it("returns sanitized runtime debug info for BetterC0de-style diagnostics", async () => {
    const config = makeConfig()
    const app = buildApp(config, {
      ...makeState(),
      config,
    } as unknown as AppState)

    const response = await app.request("/api/v1/runtime/debug-info", {
      headers: { Authorization: "Bearer secret" },
    })

    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as {
      app: Record<string, unknown>
      process: Record<string, unknown>
      paths: Record<string, unknown>
      betterc0de: Record<string, unknown>
      metrics: unknown[]
    }
    expect(body.app).toEqual(
      expect.objectContaining({
        name: "BetterC0de",
        backend: "node",
      })
    )
    expect(body.process).toEqual(
      expect.objectContaining({
        node: process.version,
        cwd: process.cwd(),
        memory: expect.objectContaining({ rss: expect.any(Number) }),
      })
    )
    expect(body.metrics).toEqual(expect.any(Array))
    expect(body.paths).toEqual(
      expect.objectContaining({
        dataDir: config.dataDir,
        dbPath: config.dbPath,
        settingsPath: config.settingsPath,
      })
    )
    expect(body.betterc0de).toEqual(
      expect.objectContaining({
        dbPathSource: "default",
        externalPlugins: "enabled",
        defaultPlugins: "enabled",
      })
    )
    expect(JSON.stringify(body)).not.toContain(config.authToken)
  })

  it("exposes authenticated local performance metrics", async () => {
    backendMetrics.incrementCounter("test_counter", { provider: "claude" })
    const app = buildApp(makeConfig(), makeState())

    const unauthorized = await app.request("/api/v1/runtime/metrics")
    expect(unauthorized.status).toBe(401)

    const response = await app.request("/api/v1/runtime/metrics", {
      headers: { Authorization: "Bearer secret" },
    })
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        collectedAt: expect.any(String),
        uptimeSeconds: expect.any(Number),
        memory: expect.objectContaining({ rss: expect.any(Number) }),
        metrics: expect.arrayContaining([
          expect.objectContaining({ name: "test_counter", value: 1 }),
        ]),
      })
    )
  })

  it("maps BetterC0de plugin runtime flags for debug info", () => {
    expect(
      buildBetterC0deRuntimePluginInfo({
        BetterC0de_PURE: "1",
        BetterC0de_DISABLE_DEFAULT_PLUGINS: "true",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      pureMode: true,
      defaultPluginsDisabled: true,
      externalPlugins: "disabled-by-pure",
      defaultPlugins: "disabled-by-env",
    })
    expect(
      buildBetterC0deRuntimePluginInfo({
        BetterC0de_PURE: "0",
        BetterC0de_DISABLE_DEFAULT_PLUGINS: "false",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      pureMode: false,
      defaultPluginsDisabled: false,
      externalPlugins: "enabled",
      defaultPlugins: "enabled",
    })
  })

  it("resolves BetterC0de database path overrides like betterc0de db path", () => {
    expect(
      normalizeRuntimePaths(
        buildBetterC0deRuntimePaths({
          XDG_CONFIG_HOME: "/tmp/config",
          XDG_DATA_HOME: "/tmp/data",
          XDG_STATE_HOME: "/tmp/state",
          XDG_CACHE_HOME: "/tmp/cache",
          BetterC0de_DB: "custom.db",
          BetterC0de_PLUGIN_META_FILE: "/tmp/plugin-meta.json",
        } as NodeJS.ProcessEnv)
      )
    ).toEqual({
      configDir: "/tmp/config/betterc0de",
      configDirSource: "default",
      dataDir: "/tmp/data/betterc0de",
      stateDir: "/tmp/state/betterc0de",
      cacheDir: "/tmp/cache/betterc0de",
      binDir: "/tmp/cache/betterc0de/bin",
      logDir: "/tmp/data/betterc0de/log",
      reposDir: "/tmp/data/betterc0de/repos",
      dbPath: "/tmp/data/betterc0de/custom.db",
      dbPathSource: "legacy",
      authPath: "/tmp/data/betterc0de/auth.json",
      mcpAuthPath: "/tmp/data/betterc0de/mcp-auth.json",
      pluginMetaPath: "/tmp/plugin-meta.json",
    })
    expect(
      normalizeRuntimePaths(
        buildBetterC0deRuntimePaths({
          XDG_CONFIG_HOME: "/tmp/config",
          XDG_DATA_HOME: "/tmp/data",
          XDG_STATE_HOME: "/tmp/state",
          XDG_CACHE_HOME: "/tmp/cache",
          BetterC0de_DB: "/tmp/betterc0de.db",
        } as NodeJS.ProcessEnv)
      )
    ).toEqual({
      configDir: "/tmp/config/betterc0de",
      configDirSource: "default",
      dataDir: "/tmp/data/betterc0de",
      stateDir: "/tmp/state/betterc0de",
      cacheDir: "/tmp/cache/betterc0de",
      binDir: "/tmp/cache/betterc0de/bin",
      logDir: "/tmp/data/betterc0de/log",
      reposDir: "/tmp/data/betterc0de/repos",
      dbPath: "/tmp/betterc0de.db",
      dbPathSource: "legacy",
      authPath: "/tmp/data/betterc0de/auth.json",
      mcpAuthPath: "/tmp/data/betterc0de/mcp-auth.json",
      pluginMetaPath: "/tmp/state/betterc0de/plugin-meta.json",
    })
    expect(
      normalizeRuntimePaths(
        buildBetterC0deRuntimePaths({
          XDG_CONFIG_HOME: "/tmp/config",
          XDG_DATA_HOME: "/tmp/data",
          XDG_STATE_HOME: "/tmp/state",
          XDG_CACHE_HOME: "/tmp/cache",
          BetterC0de_CONFIG_DIR: "/tmp/custom-betterc0de-config",
        } as NodeJS.ProcessEnv)
      )
    ).toEqual({
      configDir: "/tmp/custom-betterc0de-config",
      configDirSource: "legacy",
      dataDir: "/tmp/data/betterc0de",
      stateDir: "/tmp/state/betterc0de",
      cacheDir: "/tmp/cache/betterc0de",
      binDir: "/tmp/cache/betterc0de/bin",
      logDir: "/tmp/data/betterc0de/log",
      reposDir: "/tmp/data/betterc0de/repos",
      dbPath: "/tmp/data/betterc0de/betterc0de.db",
      dbPathSource: "default",
      authPath: "/tmp/data/betterc0de/auth.json",
      mcpAuthPath: "/tmp/data/betterc0de/mcp-auth.json",
      pluginMetaPath: "/tmp/state/betterc0de/plugin-meta.json",
    })
  })

  it("writes runtime heap snapshots into the configured logs directory", () => {
    const chmodSync = vi.fn()
    const mkdirSync = vi.fn()
    const readdirSync = vi.fn(() => [])
    const statSync = vi.fn(() => ({ size: 1234 }))
    const writeHeapSnapshot = vi.fn((path: string) => path)

    const result = writeRuntimeHeapSnapshot(
      { logsDir: "/tmp/betterc0de-test/logs" },
      {
        chmodSync,
        mkdirSync,
        now: () => new Date("2026-05-20T08:00:00.000Z"),
        pid: 42,
        readdirSync,
        statSync,
        writeHeapSnapshot,
      }
    )

    const expectedPath = path.join(
      "/tmp/betterc0de-test/logs",
      "heap-snapshots",
      "heap-42-2026-05-20T08-00-00-000Z.heapsnapshot"
    )

    expect(mkdirSync).toHaveBeenCalledWith(
      path.join("/tmp/betterc0de-test/logs", "heap-snapshots"),
      {
        recursive: true,
        mode: 0o700,
      }
    )
    expect(chmodSync).toHaveBeenNthCalledWith(
      1,
      path.join("/tmp/betterc0de-test/logs", "heap-snapshots"),
      0o700
    )
    expect(writeHeapSnapshot).toHaveBeenCalledWith(expectedPath)
    expect(chmodSync).toHaveBeenNthCalledWith(2, expectedPath, 0o600)
    expect(statSync).toHaveBeenCalledWith(expectedPath)
    expect(result).toEqual({ path: expectedPath, bytes: 1234 })
  })

  it("keeps heap snapshots disabled unless the local owner opts in", async () => {
    const config = makeConfig()
    const app = buildApp(config, {
      ...makeState(),
      config,
    } as unknown as AppState)

    const response = await app.request("/api/v1/runtime/heap-snapshot", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: "heap snapshots are disabled",
    })
  })

  it("does not let a remote session trigger an enabled heap snapshot", async () => {
    const config = { ...makeConfig(), runtimeHeapSnapshotsEnabled: true }
    const remoteSession = {
      id: "remote-session",
      label: "Phone",
      createdAt: "2026-05-20T08:00:00.000Z",
      lastSeenAt: "2026-05-20T08:00:00.000Z",
      expiresAt: "2026-06-20T08:00:00.000Z",
    }
    const remoteAccess = {
      enabled: () => true,
      authenticate: (token: string) =>
        token === "remote-token" ? remoteSession : null,
    }
    const app = buildApp(config, {
      ...makeState(),
      config,
      remoteAccess,
    } as unknown as AppState)

    const response = await app.request("/api/v1/runtime/heap-snapshot", {
      method: "POST",
      headers: {
        Cookie: "betterc0de_remote_session=remote-token",
      },
    })

    // The router's desktop-only allowlist refuses this before the route's
    // own local-owner guard (kept as defence in depth) is reached.
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: "This endpoint is only available to the desktop host.",
      code: "desktop_only",
    })
  })

  it("routes provider conversation rollback through the stored thread binding", async () => {
    const rollbackConversation = vi.fn().mockResolvedValue(true)
    const providerSessionBindings = {
      getLatestForThread: vi.fn(() => ({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        providerThreadId: "sdk-thread-1",
        resumeCursor: null,
        continuationKey: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
    }
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: { rollbackConversation },
      providerSessionBindings,
    } as unknown as AppState)

    const response = await app.request(
      "/api/v1/providers/rollback-conversation",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ threadId: "thread-1", numTurns: 2 }),
      }
    )

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ rolledBack: true })
    expect(rollbackConversation).toHaveBeenCalledWith(
      "claude",
      "thread-1",
      2,
      "claude-main",
      providerSessionBindings
    )
  })

  it("records checkpoint.revert.failed when rollback has no active provider session", async () => {
    const upsert = vi.fn()
    const providerSessionBindings = {
      getLatestForThread: vi.fn(() => null),
    }
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerSessionBindings,
      threadActivities: { upsert },
    } as unknown as AppState)

    const response = await app.request(
      "/api/v1/providers/rollback-conversation",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ threadId: "thread-1", numTurns: 1 }),
      }
    )

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ rolledBack: false })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: "thread-1",
        turn_id: null,
        provider_instance_id: null,
        kind: "checkpoint.revert.failed",
        tone: "error",
        summary: "Checkpoint revert failed",
        sequence: null,
        payload: expect.objectContaining({
          detail: expect.stringContaining("No active provider session"),
          numTurns: 1,
        }),
      })
    )
  })

  it("routes provider session inventory through hub bindings", async () => {
    const providerSessionBindings = { marker: "bindings" }
    const listSessions = vi.fn(async () => [
      {
        threadId: "thread-1",
        providerInstanceId: "claude-main",
        providerThreadId: "sdk-thread-1",
        resumeCursor: { sessionId: "sdk-thread-1" },
        continuationKey: "claude:home:/Users/example",
        status: "running",
        cwd: "/repo",
        activeTurnId: "turn-1",
        createdAt: 100,
        updatedAt: 200,
        providerKind: "claude",
        instanceId: "claude-main",
        driver: "claude",
        displayName: "Claude Main",
        runtimeMode: "full-access",
        active: true,
        persisted: true,
      },
    ])
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: { listSessions },
      providerSessionBindings,
    } as unknown as AppState)

    const response = await app.request("/api/v1/providers/sessions", {
      headers: { Authorization: "Bearer secret" },
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual([
      {
        threadId: "thread-1",
        providerInstanceId: "claude-main",
        providerThreadId: "sdk-thread-1",
        resumeCursor: { sessionId: "sdk-thread-1" },
        continuationKey: "claude:home:/Users/example",
        status: "running",
        cwd: "/repo",
        activeTurnId: "turn-1",
        createdAt: 100,
        updatedAt: 200,
        providerKind: "claude",
        instanceId: "claude-main",
        driver: "claude",
        displayName: "Claude Main",
        runtimeMode: "full-access",
        active: true,
        persisted: true,
      },
    ])
    expect(listSessions).toHaveBeenCalledWith(providerSessionBindings)
  })

  it("records failed hub approval responses as provider failure activities", async () => {
    const upsert = vi.fn()
    const respondToRequest = vi.fn(async () => {
      throw new Error(
        "failed at C:\\private\\provider.json with token sk-sensitive"
      )
    })
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: {
        has: vi.fn(() => true),
        respondToRequest,
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => ({
          providerInstanceId: "claude-main",
        })),
      },
      threadActivities: { upsert },
    } as unknown as AppState)
    const broadcast = vi.fn()
    const unregisterBroadcaster = registerThreadActivityBroadcaster({
      broadcast,
    })

    let response: Response
    try {
      response = await app.request("/api/v1/chat/approval", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          threadId: "thread-1",
          providerKind: "claude",
          requestId: "approval-1",
          decision: "approve",
        }),
      })
    } finally {
      unregisterBroadcaster()
    }

    // A provider-side failure is an upstream error, not a successful
    // acknowledgement; the body carries only the fixed public detail.
    expect(response.status).toBe(502)
    // The failed activity is written outside the provider event lane, so it
    // must be broadcast explicitly or live clients keep the request card.
    expect(broadcast).toHaveBeenCalledWith({
      channel: "thread.activity",
      data: expect.objectContaining({
        threadId: "thread-1",
        providerInstanceId: "claude-main",
        kind: "provider.approval.respond.failed",
        tone: "error",
        payload: expect.objectContaining({ requestId: "approval-1" }),
      }),
    })
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain("sk-sensitive")
    expect(await response.json()).toEqual({
      error: "Provider approval response failed.",
      code: "provider_request_failed",
    })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: "thread-1",
        provider_instance_id: "claude-main",
        kind: "provider.approval.respond.failed",
        tone: "error",
        summary: "Provider approval response failed",
        payload: expect.objectContaining({
          providerKind: "claude",
          providerInstanceId: "claude-main",
          requestId: "approval-1",
          detail: "Provider approval response failed.",
        }),
      })
    )
    expect(JSON.stringify(upsert.mock.calls)).not.toContain("provider.json")
    expect(JSON.stringify(upsert.mock.calls)).not.toContain("sk-sensitive")
    expect(
      upsert.mock.calls.some(
        ([activity]) => activity.kind === "approval.resolved"
      )
    ).toBe(false)
  })

  it("answers an unsupported plan approval with a non-2xx instead of a 200 failure", async () => {
    const upsert = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threadActivities: { upsert },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/plan-approval", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-1",
        providerKind: "openai",
        requestId: "plan-1",
        decision: "approve",
      }),
    })

    // Clients treated `200 {status:"failed"}` as an acknowledgement.
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Provider openai does not support plan approvals",
      code: "provider_request_unsupported",
    })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("records answered hub user input with the submitted answers", async () => {
    const upsert = vi.fn()
    const respondToRequest = vi.fn().mockResolvedValue(undefined)
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: {
        has: vi.fn(() => true),
        respondToRequest,
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => ({
          providerInstanceId: "claude-main",
        })),
      },
      threadActivities: { upsert },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/user-input", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-1",
        providerKind: "claude",
        requestId: "question-1",
        answers: { scope: "Backend" },
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ status: "acknowledged" })
    expect(respondToRequest).toHaveBeenCalledWith(
      "claude",
      "thread-1",
      "question-1",
      { kind: "user_input", answers: { scope: "Backend" } },
      "claude-main",
      expect.anything()
    )
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: "thread-1",
        provider_instance_id: "claude-main",
        kind: "user-input.resolved",
        payload: expect.objectContaining({
          providerKind: "claude",
          providerInstanceId: "claude-main",
          requestId: "question-1",
          decision: "answer",
          answers: { scope: "Backend" },
        }),
      })
    )
  })

  it("records rejected hub user input with an BetterC0de-style reject decision", async () => {
    const upsert = vi.fn()
    const respondToRequest = vi.fn().mockResolvedValue(undefined)
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: {
        has: vi.fn(() => true),
        respondToRequest,
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => ({
          providerInstanceId: "betterc0de-main",
        })),
      },
      threadActivities: { upsert },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/user-input/reject", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-1",
        providerKind: "betterc0de",
        requestId: "question-1",
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ status: "acknowledged" })
    expect(respondToRequest).toHaveBeenCalledWith(
      "betterc0de",
      "thread-1",
      "question-1",
      { kind: "user_input_reject" },
      "betterc0de-main",
      expect.anything()
    )
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: "thread-1",
        provider_instance_id: "betterc0de-main",
        kind: "user-input.resolved",
        payload: expect.objectContaining({
          providerKind: "betterc0de",
          providerInstanceId: "betterc0de-main",
          requestId: "question-1",
          decision: "reject",
        }),
      })
    )
  })

  it("defers source proposed plan implementation until the provider turn starts", async () => {
    const upsert = vi.fn()
    const recordPending = vi.fn()
    const persistUserMessageForTurn = vi.fn()
    const startTurn = vi.fn(
      (
        _kind: unknown,
        _input: unknown,
        options: { onAccepted?: (turnId: string) => void }
      ) => {
        options.onAccepted?.("admission-1")
        return {
          turnId: "admission-1",
          completion: Promise.resolve(),
        }
      }
    )
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: {
        has: vi.fn(() => true),
        startTurn,
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
      threads: { persistUserMessageForTurn },
      sourceProposedPlanImplementations: { recordPending },
      threadActivities: { upsert },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-implementation",
        providerKind: "claude",
        message: "Implement the proposed plan.",
        modelId: "claude-opus-4-7",
        userMessageId: "user-implementation-1",
        userMessageContent: "Implement the proposed plan.",
        userMessageCreatedAt: "2026-07-11T02:00:00.000Z",
        threadTitle: "Implementation",
        threadProjectName: "BetterC0de",
        threadCreatedAt: "2026-07-11T01:59:00.000Z",
        sourceProposedPlan: {
          threadId: "thread-plan",
          planId: "plan-1",
        },
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({
      status: "streaming",
      turnId: "admission-1",
    })
    expect(persistUserMessageForTurn).toHaveBeenCalledWith({
      thread_id: "thread-implementation",
      title: "Implementation",
      project_name: "BetterC0de",
      project_path: "",
      created_at: "2026-07-11T01:59:00.000Z",
      message: {
        message_id: "user-implementation-1",
        turn_id: null,
        role: "user",
        content: "Implement the proposed plan.",
        created_at: "2026-07-11T02:00:00.000Z",
        extra: {
          modelId: "claude-opus-4-7",
          providerKind: "claude",
        },
      },
    })
    expect(persistUserMessageForTurn.mock.invocationCallOrder[0]).toBeLessThan(
      startTurn.mock.invocationCallOrder[0] ?? 0
    )
    expect(startTurn).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        threadId: "thread-implementation",
        sourceProposedPlan: {
          threadId: "thread-plan",
          planId: "plan-1",
        },
      }),
      expect.objectContaining({
        bindings: expect.any(Object),
      })
    )
    expect(recordPending).toHaveBeenCalledWith({
      sourceProposedPlan: {
        threadId: "thread-plan",
        planId: "plan-1",
      },
      implementationThreadId: "thread-implementation",
      providerKind: "claude",
      providerInstanceId: null,
      acceptedTurnId: "admission-1",
    })
    expect(upsert).not.toHaveBeenCalled()
  })

  it("dispatches server-authoritative durable history and excludes the persisted current message", async () => {
    const durableHistory = [{ role: "assistant", content: "durable answer" }]
    const buildProviderHistory = vi.fn(() => durableHistory)
    const persistUserMessageForTurn = vi.fn()
    const startTurn = vi.fn(() => ({
      turnId: "authoritative-history-turn",
      completion: Promise.resolve(),
    }))
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threads: { persistUserMessageForTurn, buildProviderHistory },
      providerHub: { has: vi.fn(() => true), startTurn },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-authoritative-history",
        providerKind: "claude",
        message: "continue",
        modelId: "claude-opus-4-7",
        userMessageId: "current-user-message",
        history: [{ role: "assistant", content: "renderer spoof" }],
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(buildProviderHistory).toHaveBeenCalledWith(
      "thread-authoritative-history",
      { excludeMessageId: "current-user-message" }
    )
    expect(startTurn).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ history: durableHistory }),
      expect.any(Object)
    )
  })

  it("keeps new user and assistant history ephemeral when auto-save is disabled", async () => {
    const rendererHistory = [
      { role: "assistant", content: "ephemeral prior answer" },
    ]
    const persistUserMessageForTurn = vi.fn()
    const buildProviderHistory = vi.fn(() => [
      { role: "assistant", content: "durable history must not override UI" },
    ])
    const startTurn = vi.fn(() => ({
      turnId: "ephemeral-history-turn",
      completion: Promise.resolve(),
    }))
    const app = buildApp(makeConfig(), {
      ...makeState(),
      settings: { get: () => ({ auto_save_conversations: false }) },
      threads: { persistUserMessageForTurn, buildProviderHistory },
      providerHub: { has: vi.fn(() => true), startTurn },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-ephemeral-history",
        providerKind: "claude",
        message: "continue privately",
        modelId: "claude-opus-4-7",
        userMessageId: "ephemeral-user-message",
        history: rendererHistory,
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(persistUserMessageForTurn).not.toHaveBeenCalled()
    expect(buildProviderHistory).not.toHaveBeenCalled()
    expect(startTurn).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ history: rendererHistory }),
      expect.any(Object)
    )
  })

  it("fences chat dispatch while checkpoint recovery remains unfinished", async () => {
    const persistUserMessageForTurn = vi.fn()
    const startTurn = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      checkpointReverts: {
        hasBlockingRecovery: vi.fn(() => true),
        get: vi.fn(() => ({
          threadId: "thread-recovery-fenced",
          phase: "filesystem_restored",
        })),
      },
      threads: { persistUserMessageForTurn },
      providerHub: { has: vi.fn(() => true), startTurn },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-recovery-fenced",
        providerKind: "claude",
        message: "must wait for recovery",
        modelId: "claude-opus-4-7",
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: "checkpoint_recovery_pending",
    })
    expect(persistUserMessageForTurn).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("fails closed when durable provider history cannot be loaded", async () => {
    const fallbackHistory = [
      { role: "assistant", content: "renderer fallback" },
    ]
    const markDispatchMessageFailed = vi.fn()
    const startTurn = vi.fn(() => ({
      turnId: "fallback-history-turn",
      completion: Promise.resolve(),
    }))
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threads: {
        persistUserMessageForTurn: vi.fn(),
        markDispatchMessageFailed,
        buildProviderHistory: vi.fn(() => {
          throw new Error("database temporarily unavailable")
        }),
      },
      providerHub: { has: vi.fn(() => true), startTurn },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-fallback-history",
        providerKind: "claude",
        message: "continue",
        modelId: "claude-opus-4-7",
        userMessageId: "current-fallback-user",
        history: fallbackHistory,
      }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      code: "provider_history_unavailable",
    })
    expect(startTurn).not.toHaveBeenCalled()
    expect(markDispatchMessageFailed).toHaveBeenCalledWith(
      "thread-fallback-history",
      "current-fallback-user"
    )
  })

  it("removes orphaned tools from renderer fallback history", async () => {
    const startTurn = vi.fn(() => ({
      turnId: "sanitized-fallback-turn",
      completion: Promise.resolve(),
    }))
    const app = buildApp(makeConfig(), {
      ...makeState(),
      settings: { get: () => ({ auto_save_conversations: false }) },
      threads: {
        persistUserMessageForTurn: vi.fn(),
        buildProviderHistory: vi.fn(() => {
          throw new Error("database temporarily unavailable")
        }),
      },
      providerHub: { has: vi.fn(() => true), startTurn },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-sanitized-fallback",
        providerKind: "claude",
        message: "current message",
        modelId: "claude-opus-4-7",
        userMessageId: "current-sanitized-user",
        history: [
          {
            role: "assistant",
            content: "used a tool",
            tool_calls: [
              { id: "call-1", name: "Read", input: { path: "a.ts" } },
              { id: "call-1", name: "Duplicate", input: {} },
            ],
          },
          { role: "tool", tool_call_id: "call-1", content: "file body" },
          { role: "tool", tool_call_id: "orphan", content: "ignore me" },
        ],
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(startTurn).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        history: [
          {
            role: "assistant",
            content: "used a tool",
            tool_calls: [
              { id: "call-1", name: "Read", input: { path: "a.ts" } },
            ],
          },
          { role: "tool", tool_call_id: "call-1", content: "file body" },
        ],
      }),
      expect.any(Object)
    )
  })

  it("preserves a repeated prior user message in renderer fallback history", async () => {
    const startTurn = vi.fn(() => ({
      turnId: "repeated-fallback-turn",
      completion: Promise.resolve(),
    }))
    const app = buildApp(makeConfig(), {
      ...makeState(),
      settings: { get: () => ({ auto_save_conversations: false }) },
      threads: {
        persistUserMessageForTurn: vi.fn(),
        buildProviderHistory: vi.fn(() => {
          throw new Error("database temporarily unavailable")
        }),
      },
      providerHub: { has: vi.fn(() => true), startTurn },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-repeated-fallback",
        providerKind: "claude",
        message: "continue",
        modelId: "claude-opus-4-7",
        userMessageId: "current-repeated-user",
        history: [{ role: "user", content: "continue" }],
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(startTurn).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        history: [{ role: "user", content: "continue" }],
      }),
      expect.any(Object)
    )
  })

  it("marks a persisted user message failed and clears admission when hub dispatch rejects synchronously", async () => {
    const threadTurnCoordinator = new ThreadTurnCoordinator()
    const markDispatchMessageFailed = vi.fn()
    const recordPending = vi.fn()
    const clearPending = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threadTurnCoordinator,
      threads: {
        persistUserMessageForTurn: vi.fn(),
        buildProviderHistory: vi.fn(() => []),
        markDispatchMessageFailed,
      },
      providerHub: {
        has: vi.fn(() => true),
        startTurn: vi.fn(() => {
          throw new Error("provider rejected dispatch")
        }),
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
      sourceProposedPlanImplementations: { recordPending, clearPending },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-sync-rejection",
        providerKind: "claude",
        message: "must be marked failed",
        modelId: "claude-opus-4-7",
        userMessageId: "sync-rejected-user",
        sourceProposedPlan: { threadId: "plan-thread", planId: "plan-1" },
      }),
    })

    expect(response.status).toBe(500)
    expect(markDispatchMessageFailed).toHaveBeenCalledWith(
      "thread-sync-rejection",
      "sync-rejected-user"
    )
    expect(recordPending).not.toHaveBeenCalled()
    expect(clearPending).toHaveBeenCalledOnce()
    const replacement = threadTurnCoordinator.reserveTurn(
      "thread-sync-rejection",
      "retry"
    )
    expect(replacement).not.toBeNull()
  })

  it("marks a persisted user message failed when hub dispatch rejects asynchronously", async () => {
    const markDispatchMessageFailed = vi.fn()
    const clearPending = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threads: {
        persistUserMessageForTurn: vi.fn(),
        buildProviderHistory: vi.fn(() => []),
        markDispatchMessageFailed,
      },
      providerHub: {
        has: vi.fn(() => true),
        startTurn: vi.fn(
          (
            _kind: unknown,
            _input: unknown,
            options: { onAccepted?: (turnId: string) => void }
          ) => {
            options.onAccepted?.("async-rejection-admission")
            const completion = Promise.reject(
              new Error("provider rejected after admission")
            )
            return {
              turnId: "async-rejection-admission",
              completion,
              settled: completion,
            }
          }
        ),
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
      sourceProposedPlanImplementations: {
        recordPending: vi.fn(),
        clearPending,
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-async-rejection",
        providerKind: "claude",
        message: "must be marked after completion rejects",
        modelId: "claude-opus-4-7",
        userMessageId: "async-rejected-user",
        sourceProposedPlan: { threadId: "plan-thread", planId: "plan-1" },
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    await vi.waitFor(() => {
      expect(markDispatchMessageFailed).toHaveBeenCalledWith(
        "thread-async-rejection",
        "async-rejected-user"
      )
    })
    expect(clearPending).toHaveBeenCalledOnce()
    expect(clearPending).toHaveBeenCalledWith({
      implementationThreadId: "thread-async-rejection",
      providerKind: "claude",
      providerInstanceId: null,
      acceptedTurnId: "async-rejection-admission",
    })
  })

  it("marks a persisted user message failed when legacy dispatch rejects synchronously", async () => {
    const markDispatchMessageFailed = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threads: {
        persistUserMessageForTurn: vi.fn(),
        buildProviderHistory: vi.fn(() => []),
        markDispatchMessageFailed,
      },
      providerHub: { has: vi.fn(() => false) },
      providers: {
        resolveProviderKind: vi.fn(() => "openai"),
        assertCanDispatch: vi.fn(),
        dispatchTurn: vi.fn(() => {
          throw new Error("legacy provider rejected dispatch")
        }),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-legacy-rejection",
        providerKind: "openai",
        message: "must be marked failed",
        modelId: "gpt-5.5",
        userMessageId: "legacy-rejected-user",
      }),
    })

    expect(response.status).toBe(500)
    expect(markDispatchMessageFailed).toHaveBeenCalledWith(
      "thread-legacy-rejection",
      "legacy-rejected-user"
    )
  })

  it("does not dispatch a provider turn when the user message cannot persist", async () => {
    const startTurn = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threads: {
        persistUserMessageForTurn: vi.fn(() => {
          throw new Error("message database unavailable")
        }),
      },
      providerHub: {
        has: vi.fn(() => true),
        startTurn,
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-persistence-failure",
        providerKind: "claude",
        message: "must remain durable",
        modelId: "claude-opus-4-7",
      }),
    })

    expect(response.status).toBe(500)
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("rejects an occupied thread before persisting the next user message", async () => {
    const threadTurnCoordinator = new ThreadTurnCoordinator()
    expect(
      threadTurnCoordinator.reserveTurn("thread-busy", "existing-provider")
    ).not.toBeNull()
    const persistUserMessageForTurn = vi.fn()
    const startTurn = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threadTurnCoordinator,
      threads: { persistUserMessageForTurn },
      providerHub: {
        has: vi.fn(() => true),
        startTurn,
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-busy",
        providerKind: "claude",
        message: "must not become a ghost turn",
        modelId: "claude-opus-4-7",
        userMessageId: "busy-user-1",
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "turn_active" })
    )
    expect(persistUserMessageForTurn).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("validates provider readiness before persisting the user message", async () => {
    const persistUserMessageForTurn = vi.fn()
    const startTurn = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threads: { persistUserMessageForTurn },
      providerHub: {
        has: vi.fn(() => true),
        assertCanStartTurn: vi.fn(() => {
          throw Object.assign(new Error("Claude is not configured"), {
            statusCode: 400,
            code: "provider_not_configured",
          })
        }),
        startTurn,
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-unconfigured",
        providerKind: "claude",
        message: "must not persist",
        modelId: "claude-opus-4-7",
        userMessageId: "unconfigured-user-1",
      }),
    })

    expect(response.status).toBe(400)
    expect(persistUserMessageForTurn).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("rejects provider history that exceeds the shared UTF-8 byte budget", async () => {
    const persistUserMessageForTurn = vi.fn()
    const startTurn = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threads: { persistUserMessageForTurn },
      providerHub: {
        has: vi.fn(() => true),
        startTurn,
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-oversized-history",
        providerKind: "claude",
        message: "current turn",
        modelId: "claude-opus-4-7",
        history: [{ role: "assistant", content: "x".repeat(512 * 1024) }],
      }),
    })

    expect(response.status).toBe(400)
    expect(persistUserMessageForTurn).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("persists plugin-provider user messages without dispatching a backend turn", async () => {
    const persistUserMessageForTurn = vi.fn()
    const startTurn = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threads: { persistUserMessageForTurn },
      providerHub: { startTurn },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/persist-user", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-plugin",
        providerKind: "custom-plugin",
        message: "provider prompt",
        modelId: "plugin-model",
        userMessageId: "plugin-user-1",
        userMessageContent: "Visible plugin message",
        userMessageCreatedAt: "2026-07-11T03:00:00.000Z",
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ persisted: true })
    expect(persistUserMessageForTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: "thread-plugin",
        message: expect.objectContaining({
          message_id: "plugin-user-1",
          role: "user",
          content: "Visible plugin message",
        }),
      })
    )
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("keeps plugin-provider user messages ephemeral when auto-save is disabled", async () => {
    const persistUserMessageForTurn = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      settings: { get: () => ({ auto_save_conversations: false }) },
      threads: { persistUserMessageForTurn },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/persist-user", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-private-plugin",
        providerKind: "custom-plugin",
        message: "private plugin prompt",
        modelId: "plugin-model",
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ persisted: false })
    expect(persistUserMessageForTurn).not.toHaveBeenCalled()
  })

  it("lets the provider hub persist runtime context after validating the instance", async () => {
    const projectPath = process.cwd()
    const startTurn = vi.fn(() => ({
      turnId: "admission-1",
      completion: Promise.resolve(),
    }))
    const updateRuntimeContext = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: {
        has: vi.fn(() => true),
        startTurn,
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
        updateRuntimeContext,
      },
      projectProjections: {
        listAll: () => [{ path: projectPath }],
      },
      worktreeRegistry: { listAll: () => [] },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)

    const modelSelection = {
      instanceId: "claude-main",
      model: "claude-opus-4-7",
      options: [{ id: "reasoningEffort", value: "ultrathink" }],
    }
    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        message: "continue",
        modelId: "claude-opus-4-7",
        modelSelection,
        projectPath,
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(updateRuntimeContext).not.toHaveBeenCalled()
    expect(startTurn).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        providerInstanceId: "claude-main",
        threadId: "thread-1",
        projectPath,
        modelSelection,
      }),
      expect.objectContaining({
        bindings: expect.any(Object),
      })
    )
  })

  it("does not pre-persist hub runtime context when optional fields are omitted", async () => {
    const startTurn = vi.fn(() => ({
      turnId: "admission-1",
      completion: Promise.resolve(),
    }))
    const updateRuntimeContext = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: {
        has: vi.fn(() => true),
        startTurn,
      },
      providerSessionBindings: {
        getLatestForThreadProvider: vi.fn(() => null),
        updateRuntimeContext,
      },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        message: "continue",
        modelId: "claude-opus-4-7",
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(updateRuntimeContext).not.toHaveBeenCalled()
    expect(startTurn).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        providerInstanceId: "claude-main",
        threadId: "thread-1",
        projectPath: null,
        modelSelection: undefined,
      }),
      expect.objectContaining({
        bindings: expect.any(Object),
      })
    )
  })

  it("does not persist hub runtime context for cross-driver provider switches", async () => {
    const projectPath = process.cwd()
    const startTurn = vi.fn(() => ({
      turnId: "admission-1",
      completion: Promise.resolve(),
    }))
    const updateRuntimeContext = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      // No transcript in this routing fixture; provider handoff reads it before admission.
      threads: {
        persistUserMessageForTurn: vi.fn(),
        listMessages: vi.fn(() => []),
      },
      providerHub: {
        has: vi.fn(() => true),
        startTurn,
      },
      providerSessionBindings: {
        getThreadGeneration: vi.fn(() => 0),
        getLatestForThreadProvider: vi.fn(() => null),
        list: vi.fn(() => [
          {
            threadId: "thread-1",
            providerKind: "codex",
            providerInstanceId: "codex",
          },
        ]),
        updateRuntimeContext,
      },
      projectProjections: {
        listAll: () => [{ path: projectPath }],
      },
      worktreeRegistry: { listAll: () => [] },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)

    const response = await app.request("/api/v1/chat/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        message: "continue with claude",
        modelId: "claude-opus-4-7",
        projectPath,
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(updateRuntimeContext).not.toHaveBeenCalled()
    expect(startTurn).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        providerInstanceId: "claude-main",
        threadId: "thread-1",
      }),
      expect.objectContaining({
        bindings: expect.any(Object),
      })
    )
  })

  it("routes thread truncation through the thread service", async () => {
    const truncateAfterMessage = vi.fn(() => ({ deletedMessages: 3 }))
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threads: { truncateAfterMessage },
    } as unknown as AppState)

    const response = await app.request("/api/v1/threads/thread-1/truncate", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messageId: "msg-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ deletedMessages: 3 })
    expect(truncateAfterMessage).toHaveBeenCalledWith({
      thread_id: "thread-1",
      message_id: "msg-1",
      updated_at: "2026-01-01T00:00:00.000Z",
    })
  })

  it("keeps full thread saves and message upserts ephemeral when auto-save is disabled", async () => {
    const save = vi.fn()
    const upsertThreadMeta = vi.fn()
    const upsertMessage = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      settings: { get: () => ({ auto_save_conversations: false }) },
      threads: { save, upsertThreadMeta, upsertMessage },
    } as unknown as AppState)
    const headers = {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    }

    const fullSaveResponse = await app.request("/api/v1/threads", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "private-thread",
        title: "Private chat",
        projectName: "BetterC0de",
        projectPath: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        messages: [
          {
            id: "private-message",
            role: "user",
            content: "do not persist",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      }),
    })
    const messageResponse = await app.request(
      "/api/v1/threads/private-thread/messages",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "private-message-2",
          role: "assistant",
          content: "still ephemeral",
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      }
    )

    expect(fullSaveResponse.status).toBe(204)
    expect(messageResponse.status).toBe(204)
    expect(upsertThreadMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: "private-thread",
        title: "Private chat",
      })
    )
    expect(save).not.toHaveBeenCalled()
    expect(upsertMessage).not.toHaveBeenCalled()
  })

  it("persists full thread saves and message upserts while auto-save is enabled", async () => {
    const save = vi.fn()
    const upsertThreadMeta = vi.fn()
    const upsertMessage = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      settings: { get: () => ({ auto_save_conversations: true }) },
      threads: { save, upsertThreadMeta, upsertMessage },
    } as unknown as AppState)
    const headers = {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    }

    const fullSaveResponse = await app.request("/api/v1/threads", {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "durable-thread",
        title: "Durable chat",
        projectName: "BetterC0de",
        projectPath: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        messages: [],
      }),
    })
    const messageResponse = await app.request(
      "/api/v1/threads/durable-thread/messages",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "durable-message",
          role: "user",
          content: "persist this",
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      }
    )

    expect(fullSaveResponse.status).toBe(204)
    expect(messageResponse.status).toBe(204)
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: "durable-thread" })
    )
    expect(upsertThreadMeta).not.toHaveBeenCalled()
    expect(upsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: "durable-thread",
        message: expect.objectContaining({ message_id: "durable-message" }),
      })
    )
  })

  it("removes a thread worktree through the worktree service", async () => {
    const workspace = "/repo-remove-order"
    const sharedLease = await workspaceRecoveryGate.acquireShared(workspace)
    const removeForThread = vi.fn().mockResolvedValue(undefined)
    const hubTeardown = vi.fn(
      async (_threadId: string, operation: () => Promise<unknown>) =>
        operation()
    )
    const legacyTeardown = vi.fn(
      async (_threadId: string, operation: () => Promise<unknown>) => {
        // Provider teardown must begin before the exclusive workspace waiter.
        // Otherwise a provider turn that owns this shared lease deadlocks with
        // the destructive route waiting for that same provider to settle.
        expect(workspaceRecoveryGate.waitingLeaseCount()).toBe(0)
        sharedLease.release()
        return operation()
      }
    )
    const app = buildApp(makeConfig(), {
      ...makeState(),
      worktrees: {
        findForThread: vi.fn(() => ({
          base_repo_path: workspace,
          worktree_path: `${workspace}/worktree`,
        })),
        removeForThread,
      },
      providerHub: { withThreadTeardown: hubTeardown },
      providers: { withThreadTeardown: legacyTeardown },
    } as unknown as AppState)

    let response: Response
    try {
      response = await app.request("/api/v1/threads/thread-1/worktree/remove", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          deleteBranch: true,
          force: true,
        }),
      })
    } finally {
      sharedLease.release()
    }

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(removeForThread).toHaveBeenCalledWith("thread-1", {
      deleteBranch: true,
      force: true,
    })
    expect(hubTeardown).toHaveBeenCalledWith("thread-1", expect.any(Function))
    expect(legacyTeardown).toHaveBeenCalledWith(
      "thread-1",
      expect.any(Function)
    )
  })

  it("tears down all thread state under provider barriers before deletion", async () => {
    const workspace = "/repo-delete-order"
    const sharedLease = await workspaceRecoveryGate.acquireShared(workspace)
    const hubTeardown = vi.fn(
      async (_threadId: string, operation: () => Promise<unknown>) =>
        operation()
    )
    const legacyTeardown = vi.fn(
      async (_threadId: string, operation: () => Promise<unknown>) => {
        expect(workspaceRecoveryGate.waitingLeaseCount()).toBe(0)
        sharedLease.release()
        return operation()
      }
    )
    const forgetLegacyThread = vi.fn()
    const forgetCheckpointThread = vi.fn()
    const removeForThread = vi.fn().mockResolvedValue(undefined)
    const removeThreadLog = vi.fn().mockResolvedValue(undefined)
    const removeTranscriptRecovery = vi.fn()
    const deleteThread = vi.fn()
    setSessionPermission("thread-1", "bypass")
    const pendingApproval = awaitApproval("thread-1", "approval-delete")
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: { withThreadTeardown: hubTeardown },
      providers: {
        withThreadTeardown: legacyTeardown,
        forgetThread: forgetLegacyThread,
      },
      worktrees: {
        findForThread: vi.fn(() => ({
          base_repo_path: workspace,
          worktree_path: `${workspace}/worktree`,
        })),
        removeForThread,
      },
      providerEventLoggers: [{ removeThread: removeThreadLog }],
      transcriptRecoveryStore: { removeThread: removeTranscriptRecovery },
      checkpointReactor: { forgetThread: forgetCheckpointThread },
      threads: { delete: deleteThread },
    } as unknown as AppState)

    let response: Response
    try {
      response = await app.request("/api/v1/threads/thread-1", {
        method: "DELETE",
        headers: { Authorization: "Bearer secret" },
      })
    } finally {
      sharedLease.release()
    }

    expect(response.status).toBe(204)
    expect(hubTeardown).toHaveBeenCalledWith("thread-1", expect.any(Function))
    expect(legacyTeardown).toHaveBeenCalledWith(
      "thread-1",
      expect.any(Function)
    )
    expect(removeForThread).toHaveBeenCalledWith("thread-1", { force: true })
    expect(removeThreadLog).toHaveBeenCalledWith("thread-1")
    expect(removeTranscriptRecovery).toHaveBeenCalledWith("thread-1")
    expect(forgetLegacyThread).toHaveBeenCalledWith("thread-1")
    expect(forgetCheckpointThread).toHaveBeenCalledWith("thread-1")
    expect(deleteThread).toHaveBeenCalledWith("thread-1")
    await expect(pendingApproval).resolves.toBe("deny")
    expect(getSessionPermission("thread-1")).toBe("ask-on-edit")
    expect(removeForThread.mock.invocationCallOrder[0]).toBeLessThan(
      deleteThread.mock.invocationCallOrder[0] ?? 0
    )
    expect(removeThreadLog.mock.invocationCallOrder[0]).toBeLessThan(
      deleteThread.mock.invocationCallOrder[0] ?? 0
    )
  })

  it("resets a thread worktree through the worktree service", async () => {
    const workspace = "/repo-reset-order"
    const sharedLease = await workspaceRecoveryGate.acquireShared(workspace)
    const resetForThread = vi.fn().mockResolvedValue({
      worktreeId: "worktree-1",
      threadId: "thread-1",
      worktreePath: "/tmp/worktree",
      branch: "agent/thread/reset",
      baseBranch: "main",
      headSha: "abc123",
    })
    const hubTeardown = vi.fn(
      async (_threadId: string, operation: () => Promise<unknown>) =>
        operation()
    )
    const legacyTeardown = vi.fn(
      async (_threadId: string, operation: () => Promise<unknown>) => {
        expect(workspaceRecoveryGate.waitingLeaseCount()).toBe(0)
        sharedLease.release()
        return operation()
      }
    )
    const app = buildApp(makeConfig(), {
      ...makeState(),
      worktrees: {
        findForThread: vi.fn(() => ({
          base_repo_path: workspace,
          worktree_path: `${workspace}/worktree`,
        })),
        resetForThread,
      },
      providerHub: { withThreadTeardown: hubTeardown },
      providers: { withThreadTeardown: legacyTeardown },
    } as unknown as AppState)

    let response: Response
    try {
      response = await app.request("/api/v1/threads/thread-1/worktree/reset", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clean: false,
          updateSubmodules: false,
        }),
      })
    } finally {
      sharedLease.release()
    }

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({
      worktreeId: "worktree-1",
      threadId: "thread-1",
      worktreePath: "/tmp/worktree",
      branch: "agent/thread/reset",
      baseBranch: "main",
      headSha: "abc123",
    })
    expect(resetForThread).toHaveBeenCalledWith("thread-1", {
      clean: false,
      updateSubmodules: false,
    })
    expect(hubTeardown).toHaveBeenCalledWith("thread-1", expect.any(Function))
    expect(legacyTeardown).toHaveBeenCalledWith(
      "thread-1",
      expect.any(Function)
    )
  })

  it("reverts a thread checkpoint through the server-side authoritative flow", async () => {
    const turn1Ref = checkpointRefForThreadTurn("thread-1", 1)
    const turn2BaseRef = checkpointRefForThreadTurn("thread-1", 2)
    const turn2Ref = checkpointRefForThreadTurn("thread-1", 3)
    vi.mocked(git.isRepo).mockResolvedValue({ is_repo: true })
    vi.mocked(git.restoreCheckpoint).mockResolvedValue({
      restored: true,
      safetyRef: null,
      preview: null,
    })
    vi.mocked(git.restoreCheckpoint).mockClear()
    vi.mocked(git.deleteCheckpointRefs).mockResolvedValue()
    vi.mocked(git.deleteCheckpointRefs).mockClear()
    vi.mocked(git.deleteCheckpointRefs).mockClear()
    const rollbackConversation = vi.fn().mockResolvedValue(true)
    const hubMaintenance = vi.fn(
      async (_threadId: string, operation: () => Promise<unknown>) =>
        operation()
    )
    const legacyMaintenance = vi.fn(
      async (_threadId: string, operation: () => Promise<unknown>) =>
        operation()
    )
    const truncateAfterTurnCount = vi.fn(() => ({
      deletedMessages: 2,
      boundaryMessageId: "msg-a1",
    }))
    const providerSessionBindings = {
      getLatestForThread: vi.fn(() => ({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        providerThreadId: "sdk-thread-1",
        resumeCursor: null,
        continuationKey: null,
        cwd: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
    }
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: {
        rollbackConversation,
        withThreadMaintenance: hubMaintenance,
      },
      providers: { withThreadMaintenance: legacyMaintenance },
      providerSessionBindings,
      checkpointDiffs: {
        listCheckpointRefsByThread: vi.fn(() => [turn1Ref, turn2Ref]),
        latestTurnIndex: vi.fn(() => 2),
      },
      threads: { truncateAfterTurnCount },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)

    const response = await app.request(
      "/api/v1/threads/thread-1/checkpoint/revert",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnCount: 1,
          updatedAt: "2026-01-01T00:01:00.000Z",
        }),
      }
    )

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({
      reverted: true,
      rolledBackTurns: 1,
      deletedMessages: 2,
      boundaryMessageId: "msg-a1",
      // Pre-restore snapshot + lost-work preview. Null here because
      // git.restoreCheckpoint is mocked; the real values are covered by
      // services/git.test.ts.
      safetyRef: null,
      restorePreview: null,
    })
    expect(git.restoreCheckpoint).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRef: turn1Ref,
      fallbackToHead: false,
    })
    expect(rollbackConversation).toHaveBeenCalledWith(
      "claude",
      "thread-1",
      1,
      "claude-main",
      providerSessionBindings
    )
    expect(hubMaintenance).toHaveBeenCalledWith(
      "thread-1",
      expect.any(Function)
    )
    expect(legacyMaintenance).toHaveBeenCalledWith(
      "thread-1",
      expect.any(Function)
    )
    expect(git.deleteCheckpointRefs).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRefs: expect.arrayContaining([turn2BaseRef, turn2Ref]),
    })
    expect(truncateAfterTurnCount).toHaveBeenCalledWith({
      thread_id: "thread-1",
      turn_count: 1,
      stale_checkpoint_refs: expect.arrayContaining([turn2BaseRef, turn2Ref]),
      updated_at: "2026-01-01T00:01:00.000Z",
    })
    expect(truncateAfterTurnCount.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(git.deleteCheckpointRefs).mock.invocationCallOrder[0] ?? 0
    )
  })

  it("keeps the revert journal bounded and derives every stale ref for histories beyond 5k turns", async () => {
    const threadId = "thread-long-revert"
    const targetTurnCount = 1
    const currentTurnCount = 5_002
    const targetCheckpointRef = checkpointRefForThreadTurn(threadId, 1)
    const begin = vi.fn((input) => ({
      ...input,
      phase: "prepared" as const,
    }))
    const setPhase = vi.fn((operation, phase) => ({
      ...operation,
      phase,
    }))
    const deleteOperation = vi.fn()
    const truncateAfterTurnCount = vi.fn(() => ({
      deletedMessages: 10_002,
      boundaryMessageId: "message-target",
    }))
    const rollbackConversation = vi.fn().mockResolvedValue(true)
    vi.mocked(git.isRepo).mockResolvedValue({ is_repo: true })
    vi.mocked(git.restoreCheckpoint).mockResolvedValue({
      restored: true,
      safetyRef: null,
      preview: null,
    })
    vi.mocked(git.restoreCheckpoint).mockClear()
    vi.mocked(git.deleteCheckpointRefs).mockResolvedValue()
    vi.mocked(git.deleteCheckpointRefs).mockClear()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      checkpointReverts: {
        begin,
        setPhase,
        delete: deleteOperation,
      },
      providerHub: { rollbackConversation },
      providerSessionBindings: {
        getLatestForThread: vi.fn(() => ({
          threadId,
          providerKind: "claude",
          providerInstanceId: "claude-main",
          providerThreadId: "sdk-thread-long",
          resumeCursor: null,
          continuationKey: null,
          cwd: "/repo-long",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
      },
      checkpointDiffs: {
        listCheckpointRefsByThread: vi.fn(() => [targetCheckpointRef]),
        latestTurnIndex: vi.fn(() => currentTurnCount),
      },
      threads: { truncateAfterTurnCount },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)

    const response = await app.request(
      `/api/v1/threads/${threadId}/checkpoint/revert`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnCount: targetTurnCount,
          preserveFuture: true,
        }),
      }
    )

    expect(response.status, await response.clone().text()).toBe(200)
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        turnCount: targetTurnCount,
        currentTurnCount,
        staleCheckpointRefs: [],
        preserveFuture: false,
      })
    )
    const deletion = vi.mocked(git.deleteCheckpointRefs).mock.calls[0]?.[0]
    expect(deletion?.cwd).toBe("/repo-long")
    expect(deletion?.checkpointRefs).toHaveLength(10_002)
    expect(new Set(deletion?.checkpointRefs).size).toBe(10_002)
    expect(deletion?.checkpointRefs).toEqual(
      expect.arrayContaining([
        checkpointRefForThreadTurn(threadId, 2),
        checkpointRefForThreadTurn(threadId, 3),
        checkpointRefForThreadTurn(threadId, 10_002),
        checkpointRefForThreadTurn(threadId, 10_003),
      ])
    )
    expect(rollbackConversation).toHaveBeenCalledWith(
      "claude",
      threadId,
      5_001,
      "claude-main",
      expect.any(Object)
    )
    expect(deleteOperation).toHaveBeenCalledWith(threadId)
  })

  it("durably queues every stale ref with a retry attempt when direct cleanup fails", async () => {
    const threadId = "thread-cleanup-queue"
    const targetCheckpointRef = checkpointRefForThreadTurn(threadId, 1)
    const currentCheckpointRef = checkpointRefForThreadTurn(threadId, 3)
    const expectedStaleRefs = [
      checkpointRefForThreadTurn(threadId, 2),
      currentCheckpointRef,
    ]
    const database = openDatabase(":memory:")
    runMigrations(database)
    const cleanupStore = new CheckpointRefCleanupStore(database)
    const deleteOperation = vi.fn()
    const cleanupFailure = new Error("checkpoint namespace is locked")
    vi.mocked(git.isRepo).mockResolvedValue({ is_repo: true })
    vi.mocked(git.restoreCheckpoint).mockResolvedValue({
      restored: true,
      safetyRef: null,
      preview: null,
    })
    vi.mocked(git.restoreCheckpoint).mockClear()
    vi.mocked(git.deleteCheckpointRefs).mockRejectedValue(cleanupFailure)
    vi.mocked(git.deleteCheckpointRefs).mockClear()

    try {
      const app = buildApp(makeConfig(), {
        ...makeState(),
        checkpointReverts: {
          begin: vi.fn((input) => ({
            ...input,
            phase: "prepared" as const,
          })),
          setPhase: vi.fn((operation, phase) => ({
            ...operation,
            phase,
          })),
          delete: deleteOperation,
        },
        checkpointRefCleanupStore: cleanupStore,
        providerHub: {
          rollbackConversation: vi.fn().mockResolvedValue(true),
        },
        providerSessionBindings: {
          getLatestForThread: vi.fn(() => ({
            threadId,
            providerKind: "claude",
            providerInstanceId: "claude-main",
            providerThreadId: "sdk-thread-cleanup",
            resumeCursor: null,
            continuationKey: null,
            cwd: "/repo-cleanup",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })),
        },
        checkpointDiffs: {
          listCheckpointRefsByThread: vi.fn(() => [
            targetCheckpointRef,
            currentCheckpointRef,
          ]),
          latestTurnIndex: vi.fn(() => 2),
        },
        threads: {
          truncateAfterTurnCount: vi.fn(() => ({
            deletedMessages: 2,
            boundaryMessageId: "message-target",
          })),
        },
        threadActivities: { upsert: vi.fn() },
      } as unknown as AppState)

      const response = await app.request(
        `/api/v1/threads/${threadId}/checkpoint/revert`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer secret",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ turnCount: 1 }),
        }
      )

      expect(response.status, await response.clone().text()).toBe(200)
      const queued = cleanupStore.list(16)
      expect(queued).toHaveLength(expectedStaleRefs.length)
      expect(queued.map((entry) => entry.checkpointRef).sort()).toEqual(
        [...expectedStaleRefs].sort()
      )
      expect(queued.every((entry) => entry.attempts === 1)).toBe(true)
      expect(
        queued.every((entry) =>
          entry.lastError?.includes(cleanupFailure.message)
        )
      ).toBe(true)
      expect(deleteOperation).toHaveBeenCalledWith(threadId)
    } finally {
      database.close()
    }
  })

  it("retains the revert saga and returns 503 when stale refs cannot be durably queued", async () => {
    const threadId = "thread-cleanup-queue-failure"
    const targetCheckpointRef = checkpointRefForThreadTurn(threadId, 1)
    const currentCheckpointRef = checkpointRefForThreadTurn(threadId, 3)
    const deleteOperation = vi.fn()
    const setPhase = vi.fn((operation, phase) => ({
      ...operation,
      phase,
    }))
    const truncateAfterTurnCount = vi.fn(() => ({
      deletedMessages: 2,
      boundaryMessageId: "message-target",
    }))
    const enqueue = vi.fn(() => {
      throw new Error("cleanup database is read-only")
    })
    vi.mocked(git.isRepo).mockResolvedValue({ is_repo: true })
    vi.mocked(git.restoreCheckpoint).mockResolvedValue({
      restored: true,
      safetyRef: null,
      preview: null,
    })
    vi.mocked(git.restoreCheckpoint).mockClear()
    vi.mocked(git.deleteCheckpointRefs).mockRejectedValue(
      new Error("checkpoint namespace is locked")
    )
    vi.mocked(git.deleteCheckpointRefs).mockClear()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      checkpointReverts: {
        begin: vi.fn((input) => ({
          ...input,
          phase: "prepared" as const,
        })),
        setPhase,
        delete: deleteOperation,
      },
      checkpointRefCleanupStore: {
        enqueue,
        recordIntentFailure: vi.fn(),
      },
      providerHub: {
        rollbackConversation: vi.fn().mockResolvedValue(true),
      },
      providerSessionBindings: {
        getLatestForThread: vi.fn(() => ({
          threadId,
          providerKind: "claude",
          providerInstanceId: "claude-main",
          providerThreadId: "sdk-thread-cleanup-failure",
          resumeCursor: null,
          continuationKey: null,
          cwd: "/repo-cleanup-failure",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
      },
      checkpointDiffs: {
        listCheckpointRefsByThread: vi.fn(() => [
          targetCheckpointRef,
          currentCheckpointRef,
        ]),
        latestTurnIndex: vi.fn(() => 2),
      },
      threads: { truncateAfterTurnCount },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)

    const response = await app.request(
      `/api/v1/threads/${threadId}/checkpoint/revert`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ turnCount: 1 }),
      }
    )

    expect(response.status).toBe(503)
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        cwd: "/repo-cleanup-failure",
        checkpointRefs: expect.arrayContaining([
          checkpointRefForThreadTurn(threadId, 2),
          currentCheckpointRef,
        ]),
      })
    )
    expect(
      setPhase.mock.calls.some(([, phase]) => phase === "database_truncated")
    ).toBe(true)
    expect(truncateAfterTurnCount).toHaveBeenCalledOnce()
    expect(deleteOperation).not.toHaveBeenCalled()
  })

  it("fails turn-zero revert safely when the retained baseline ref is missing", async () => {
    const baselineRef = checkpointRefForThreadTurn("thread-zero", 0)
    vi.mocked(git.isRepo).mockResolvedValue({ is_repo: true })
    vi.mocked(git.restoreCheckpoint).mockResolvedValue({
      restored: false,
      safetyRef: null,
      preview: null,
    })
    vi.mocked(git.restoreCheckpoint).mockClear()
    const rollbackConversation = vi.fn()
    const truncateAfterTurnCount = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: { rollbackConversation },
      providerSessionBindings: {
        getLatestForThread: vi.fn(() => ({
          threadId: "thread-zero",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          providerThreadId: "sdk-thread-zero",
          resumeCursor: null,
          continuationKey: null,
          cwd: "/repo-zero",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
      },
      checkpointDiffs: {
        listCheckpointRefsByThread: vi.fn(() => [
          checkpointRefForThreadTurn("thread-zero", 1),
        ]),
        latestTurnIndex: vi.fn(() => 1),
      },
      threads: { truncateAfterTurnCount },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)

    const response = await app.request(
      "/api/v1/threads/thread-zero/checkpoint/revert",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ turnCount: 0 }),
      }
    )

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({
      reverted: false,
      reason: expect.stringContaining(
        "Filesystem checkpoint is unavailable for turn 0"
      ),
    })
    expect(git.restoreCheckpoint).toHaveBeenCalledWith({
      cwd: "/repo-zero",
      checkpointRef: baselineRef,
      fallbackToHead: false,
    })
    expect(rollbackConversation).not.toHaveBeenCalled()
    expect(truncateAfterTurnCount).not.toHaveBeenCalled()
  })

  it("queues the exclusive revert barrier before journaling and waits for overlapping mutations", async () => {
    vi.mocked(git.isRepo).mockResolvedValue({ is_repo: true })
    vi.mocked(git.restoreCheckpoint).mockResolvedValue({
      restored: false,
      safetyRef: null,
      preview: null,
    })
    const begin = vi.fn((input) => ({ ...input, phase: "prepared" as const }))
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerSessionBindings: {
        getLatestForThread: vi.fn(() => ({
          threadId: "thread-busy",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          providerThreadId: "sdk-thread-busy",
          resumeCursor: null,
          continuationKey: null,
          cwd: "/repo-busy",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
      },
      checkpointDiffs: {
        listCheckpointRefsByThread: vi.fn(() => []),
        latestTurnIndex: vi.fn(() => 0),
      },
      checkpointReverts: { begin, delete: vi.fn() },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)
    const sharedLease = await workspaceRecoveryGate.acquireShared("/repo-busy")
    try {
      const responsePromise = app.request(
        "/api/v1/threads/thread-busy/checkpoint/revert",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer secret",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ turnCount: 0 }),
        }
      )

      await vi.waitFor(() => {
        expect(workspaceRecoveryGate.waitingLeaseCount()).toBeGreaterThan(0)
      })
      expect(begin).not.toHaveBeenCalled()
      sharedLease.release()

      const response = await responsePromise
      expect(response.status, await response.clone().text()).toBe(200)
      expect(begin).toHaveBeenCalledOnce()
    } finally {
      sharedLease.release()
    }
  })

  it("recovers an ambiguous checkpoint rollback without applying it twice", async () => {
    const operation = {
      threadId: "thread-recovery",
      turnCount: 1,
      currentTurnCount: 2,
      updatedAt: "2026-01-01T00:01:00.000Z",
      cwd: "/repo",
      providerKind: "claude" as const,
      providerInstanceId: "claude-main",
      targetCheckpointRef: "refs/betterc0de/checkpoints/thread-recovery/1",
      currentCheckpointRef: "refs/betterc0de/checkpoints/thread-recovery/3",
      staleCheckpointRefs: ["refs/betterc0de/checkpoints/thread-recovery/3"],
      preserveFuture: false,
      phase: "provider_rollback_started" as const,
    }
    const setPhase = vi.fn((current, phase) => ({ ...current, phase }))
    const deleteOperation = vi.fn()
    const stopSession = vi.fn().mockResolvedValue(undefined)
    const rollbackConversation = vi.fn()
    const rotateGeneration = vi.fn(() => 2)
    const truncateAfterTurnCount = vi.fn(() => ({
      deletedMessages: 2,
      boundaryMessageId: "message-1",
    }))
    vi.mocked(git.deleteCheckpointRefs).mockResolvedValue()

    await recoverPendingCheckpointReverts({
      ...makeState(),
      checkpointReverts: {
        list: vi.fn(() => [operation]),
        setPhase,
        delete: deleteOperation,
      },
      providerHub: {
        withThreadMaintenance: async (
          _threadId: string,
          action: () => Promise<unknown>
        ) => action(),
        stopSession,
        rollbackConversation,
      },
      providers: {
        withThreadMaintenance: async (
          _threadId: string,
          action: () => Promise<unknown>
        ) => action(),
      },
      providerSessionBindings: { rotateGeneration },
      checkpointDiffs: {
        listCheckpointRefsByThread: vi.fn(() => operation.staleCheckpointRefs),
      },
      threads: { truncateAfterTurnCount },
    } as unknown as AppState)

    expect(rollbackConversation).not.toHaveBeenCalled()
    expect(stopSession).toHaveBeenCalledWith(
      "claude",
      "thread-recovery",
      "claude-main"
    )
    expect(rotateGeneration).toHaveBeenCalledWith(
      "thread-recovery",
      "claude-main"
    )
    expect(truncateAfterTurnCount).toHaveBeenCalledOnce()
    expect(deleteOperation).toHaveBeenCalledWith("thread-recovery")
  })

  it("resumes an ambiguous checkpoint rollback during an online retry", async () => {
    const targetCheckpointRef = checkpointRefForThreadTurn("thread-retry", 1)
    const currentCheckpointRef = checkpointRefForThreadTurn("thread-retry", 2)
    const operation = {
      threadId: "thread-retry",
      turnCount: 1,
      currentTurnCount: 2,
      updatedAt: "2026-01-01T00:01:00.000Z",
      cwd: "/repo",
      providerKind: "claude" as const,
      providerInstanceId: "claude-main",
      targetCheckpointRef,
      currentCheckpointRef,
      staleCheckpointRefs: [currentCheckpointRef],
      preserveFuture: false,
      phase: "provider_rollback_started" as const,
    }
    const setPhase = vi.fn((current, phase) => ({ ...current, phase }))
    const deleteOperation = vi.fn()
    const stopSession = vi.fn().mockResolvedValue(undefined)
    const rollbackConversation = vi.fn()
    const rotateGeneration = vi.fn(() => 2)
    const truncateAfterTurnCount = vi.fn(() => ({
      deletedMessages: 2,
      boundaryMessageId: "message-1",
    }))
    vi.mocked(git.isRepo).mockResolvedValue({ is_repo: true })
    vi.mocked(git.deleteCheckpointRefs).mockResolvedValue()

    const app = buildApp(makeConfig(), {
      ...makeState(),
      checkpointReverts: {
        begin: vi.fn(() => operation),
        setPhase,
        delete: deleteOperation,
      },
      providerHub: {
        withThreadMaintenance: async (
          _threadId: string,
          action: () => Promise<unknown>
        ) => action(),
        stopSession,
        rollbackConversation,
      },
      providers: {
        withThreadMaintenance: async (
          _threadId: string,
          action: () => Promise<unknown>
        ) => action(),
      },
      providerSessionBindings: {
        getLatestForThread: vi.fn(() => ({
          threadId: "thread-retry",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          providerThreadId: "sdk-thread-retry",
          resumeCursor: null,
          continuationKey: null,
          cwd: "/repo",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
        rotateGeneration,
      },
      checkpointDiffs: {
        listCheckpointRefsByThread: vi.fn(() => [
          targetCheckpointRef,
          currentCheckpointRef,
        ]),
        latestTurnIndex: vi.fn(() => 2),
      },
      threads: { truncateAfterTurnCount },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)

    const response = await app.request(
      "/api/v1/threads/thread-retry/checkpoint/revert",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnCount: 1,
          updatedAt: operation.updatedAt,
        }),
      }
    )

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({
      reverted: true,
      rolledBackTurns: 1,
      deletedMessages: 2,
      boundaryMessageId: "message-1",
      // Pre-restore snapshot + lost-work preview. Null here because
      // git.restoreCheckpoint is mocked; the real values are covered by
      // services/git.test.ts.
      safetyRef: null,
      restorePreview: null,
    })
    expect(rollbackConversation).not.toHaveBeenCalled()
    expect(stopSession).toHaveBeenCalledWith(
      "claude",
      "thread-retry",
      "claude-main"
    )
    expect(rotateGeneration).toHaveBeenCalledWith("thread-retry", "claude-main")
    expect(truncateAfterTurnCount).toHaveBeenCalledOnce()
    expect(deleteOperation).toHaveBeenCalledWith("thread-retry")
  })

  it("isolates failed checkpoint journals during startup recovery", async () => {
    const operation = (threadId: string) => ({
      threadId,
      turnCount: 1,
      currentTurnCount: 1,
      updatedAt: "2026-01-01T00:01:00.000Z",
      cwd: `/repo/${threadId}`,
      providerKind: "claude" as const,
      providerInstanceId: "claude-main",
      targetCheckpointRef: `refs/betterc0de/checkpoints/${threadId}/1`,
      currentCheckpointRef: `refs/betterc0de/checkpoints/${threadId}/1`,
      staleCheckpointRefs: [],
      preserveFuture: false,
      phase: "prepared" as const,
    })
    const first = operation("thread-broken")
    const second = operation("thread-healthy")
    const deleteOperation = vi.fn()
    vi.mocked(git.restoreCheckpoint).mockImplementation(async ({ cwd }) => {
      if (cwd === first.cwd) throw new Error("broken checkpoint repository")
      return { restored: true, safetyRef: null, preview: null }
    })

    await expect(
      recoverPendingCheckpointReverts({
        ...makeState(),
        checkpointReverts: {
          list: vi.fn(() => [first, second]),
          setPhase: vi.fn((current, phase) => ({ ...current, phase })),
          delete: deleteOperation,
        },
        providerHub: {
          withThreadMaintenance: async (
            _threadId: string,
            action: () => Promise<unknown>
          ) => action(),
        },
        providers: {
          withThreadMaintenance: async (
            _threadId: string,
            action: () => Promise<unknown>
          ) => action(),
        },
        checkpointDiffs: {
          listCheckpointRefsByThread: vi.fn(() => []),
        },
        threads: {
          truncateAfterTurnCount: vi.fn(() => ({
            deletedMessages: 0,
            boundaryMessageId: null,
          })),
        },
      } as unknown as AppState)
    ).resolves.toBeUndefined()

    expect(deleteOperation).not.toHaveBeenCalledWith("thread-broken")
    expect(deleteOperation).toHaveBeenCalledWith("thread-healthy")
  })

  it("ignores preserveFuture so Git refs cannot outlive their deleted read model", async () => {
    const turn1Ref = checkpointRefForThreadTurn("thread-1", 1)
    const turn2Ref = checkpointRefForThreadTurn("thread-1", 3)
    vi.mocked(git.isRepo).mockResolvedValue({ is_repo: true })
    vi.mocked(git.restoreCheckpoint).mockResolvedValue({
      restored: true,
      safetyRef: null,
      preview: null,
    })
    vi.mocked(git.deleteCheckpointRefs).mockResolvedValue()
    vi.mocked(git.deleteCheckpointRefs).mockClear()
    const rollbackConversation = vi.fn().mockResolvedValue(true)
    const truncateAfterTurnCount = vi.fn(() => ({
      deletedMessages: 2,
      boundaryMessageId: "msg-a1",
    }))
    const providerSessionBindings = {
      getLatestForThread: vi.fn(() => ({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        providerThreadId: "sdk-thread-1",
        resumeCursor: null,
        continuationKey: null,
        cwd: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
    }
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: { rollbackConversation },
      providerSessionBindings,
      checkpointDiffs: {
        listCheckpointRefsByThread: vi.fn(() => [turn1Ref, turn2Ref]),
        latestTurnIndex: vi.fn(() => 2),
      },
      threads: { truncateAfterTurnCount },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)

    const response = await app.request(
      "/api/v1/threads/thread-1/checkpoint/revert",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          turnCount: 1,
          preserveFuture: true,
          updatedAt: "2026-01-01T00:01:00.000Z",
        }),
      }
    )

    expect(response.status, await response.clone().text()).toBe(200)
    expect(git.deleteCheckpointRefs).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRefs: expect.arrayContaining([
        checkpointRefForThreadTurn("thread-1", 2),
        turn2Ref,
      ]),
    })
    expect(truncateAfterTurnCount).toHaveBeenCalledWith({
      thread_id: "thread-1",
      turn_count: 1,
      stale_checkpoint_refs: expect.arrayContaining([
        checkpointRefForThreadTurn("thread-1", 2),
        turn2Ref,
      ]),
      updated_at: "2026-01-01T00:01:00.000Z",
    })
  })

  it("discards the ambiguous provider session and completes when rollback is unavailable", async () => {
    const turn1Ref = checkpointRefForThreadTurn("thread-1", 1)
    const turn2Ref = checkpointRefForThreadTurn("thread-1", 3)
    vi.mocked(git.isRepo).mockResolvedValue({ is_repo: true })
    vi.mocked(git.restoreCheckpoint).mockResolvedValue({
      restored: true,
      safetyRef: null,
      preview: null,
    })
    vi.mocked(git.restoreCheckpoint).mockClear()
    vi.mocked(git.deleteCheckpointRefs).mockResolvedValue()
    vi.mocked(git.deleteCheckpointRefs).mockClear()
    const rollbackConversation = vi.fn().mockResolvedValue(false)
    const stopSession = vi.fn().mockResolvedValue(undefined)
    const rotateGeneration = vi.fn(() => 2)
    const truncateAfterTurnCount = vi.fn(() => ({
      deletedMessages: 2,
      boundaryMessageId: "message-target",
    }))
    const upsert = vi.fn()
    const providerSessionBindings = {
      getLatestForThread: vi.fn(() => ({
        threadId: "thread-1",
        providerKind: "claude",
        providerInstanceId: "claude-main",
        providerThreadId: "sdk-thread-1",
        resumeCursor: null,
        continuationKey: null,
        cwd: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      rotateGeneration,
    }
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: { rollbackConversation, stopSession },
      providerSessionBindings,
      checkpointDiffs: {
        listCheckpointRefsByThread: vi.fn(() => [turn1Ref, turn2Ref]),
        latestTurnIndex: vi.fn(() => 2),
      },
      threads: { truncateAfterTurnCount },
      threadActivities: { upsert },
    } as unknown as AppState)

    const response = await app.request(
      "/api/v1/threads/thread-1/checkpoint/revert",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ turnCount: 1 }),
      }
    )

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({
      reverted: true,
      rolledBackTurns: 1,
      deletedMessages: 2,
      boundaryMessageId: "message-target",
      // Pre-restore snapshot + lost-work preview. Null here because
      // git.restoreCheckpoint is mocked; the real values are covered by
      // services/git.test.ts.
      safetyRef: null,
      restorePreview: null,
    })
    expect(git.restoreCheckpoint).toHaveBeenCalledTimes(1)
    expect(git.restoreCheckpoint).toHaveBeenCalledWith({
      cwd: "/repo",
      checkpointRef: turn1Ref,
      fallbackToHead: false,
    })
    expect(stopSession).toHaveBeenCalledWith(
      "claude",
      "thread-1",
      "claude-main"
    )
    expect(rotateGeneration).toHaveBeenCalledWith("thread-1", "claude-main")
    expect(git.deleteCheckpointRefs).toHaveBeenCalledOnce()
    expect(truncateAfterTurnCount).toHaveBeenCalledOnce()
    expect(upsert).not.toHaveBeenCalled()
  })

  it("retains an ambiguous revert journal when provider session discard fails", async () => {
    const turn1Ref = checkpointRefForThreadTurn("thread-compensation", 1)
    const turn2Ref = checkpointRefForThreadTurn("thread-compensation", 2)
    vi.mocked(git.isRepo).mockResolvedValue({ is_repo: true })
    vi.mocked(git.restoreCheckpoint).mockResolvedValue({
      restored: true,
      safetyRef: null,
      preview: null,
    })
    vi.mocked(git.restoreCheckpoint).mockClear()
    const rollbackConversation = vi.fn().mockResolvedValue(false)
    const stopSession = vi
      .fn()
      .mockRejectedValue(new Error("provider process is still running"))
    const rotateGeneration = vi.fn()
    const truncateAfterTurnCount = vi.fn()
    const deleteOperation = vi.fn()
    let operationPhase = "prepared"
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerHub: { rollbackConversation, stopSession },
      providerSessionBindings: {
        getLatestForThread: vi.fn(() => ({
          threadId: "thread-compensation",
          providerKind: "claude",
          providerInstanceId: "claude-main",
          providerThreadId: "sdk-thread-compensation",
          resumeCursor: null,
          continuationKey: null,
          cwd: "/repo",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
        rotateGeneration,
      },
      checkpointDiffs: {
        listCheckpointRefsByThread: vi.fn(() => [turn1Ref, turn2Ref]),
        latestTurnIndex: vi.fn(() => 2),
      },
      checkpointReverts: {
        begin: vi.fn((input) => ({ ...input, phase: operationPhase })),
        setPhase: vi.fn((current, phase) => {
          operationPhase = phase
          return { ...current, phase }
        }),
        delete: deleteOperation,
      },
      threads: { truncateAfterTurnCount },
      threadActivities: { upsert: vi.fn() },
    } as unknown as AppState)

    const response = await app.request(
      "/api/v1/threads/thread-compensation/checkpoint/revert",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ turnCount: 1 }),
      }
    )

    expect(response.status).toBe(500)
    expect(operationPhase).toBe("provider_rollback_started")
    expect(stopSession).toHaveBeenCalledWith(
      "claude",
      "thread-compensation",
      "claude-main"
    )
    expect(rotateGeneration).not.toHaveBeenCalled()
    expect(truncateAfterTurnCount).not.toHaveBeenCalled()
    expect(deleteOperation).not.toHaveBeenCalled()
  })

  it("records checkpoint.revert.failed when server-side checkpoint revert has no session cwd", async () => {
    const upsert = vi.fn()
    const app = buildApp(makeConfig(), {
      ...makeState(),
      providerSessionBindings: {
        getLatestForThread: vi.fn(() => null),
      },
      threadActivities: { upsert },
    } as unknown as AppState)

    const response = await app.request(
      "/api/v1/threads/thread-1/checkpoint/revert",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ turnCount: 1 }),
      }
    )

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({
      reverted: false,
      rolledBackTurns: 0,
      deletedMessages: 0,
      boundaryMessageId: null,
      reason: expect.stringContaining("No active provider session"),
    })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: "thread-1",
        turn_id: null,
        kind: "checkpoint.revert.failed",
        tone: "error",
        payload: expect.objectContaining({
          detail: expect.stringContaining("No active provider session"),
          turnCount: 1,
        }),
      })
    )
  })
})

describe("thread recovery fencing and pagination", () => {
  it("allows recovery inspection but blocks unrelated thread mutations", async () => {
    const hasBlockingRecovery = vi.fn(() => true)
    const app = buildApp(makeConfig(), {
      ...makeState(),
      checkpointReverts: {
        hasBlockingRecovery,
        get: vi.fn(() => null),
        hasRecoveryRequired: vi.fn(() => true),
        listQuarantined: vi.fn(() => [
          {
            quarantineId: 1,
            threadId: "thread-1",
            phase: "prepared",
          },
        ]),
      },
    } as unknown as AppState)
    const headers = { Authorization: "Bearer secret" }

    const inspection = await app.request(
      "/api/v1/threads/thread-1/checkpoint-recovery",
      { headers }
    )
    expect(inspection.status).toBe(200)
    expect(await inspection.json()).toMatchObject({
      recoveryRequired: true,
      pending: null,
      quarantined: [expect.objectContaining({ threadId: "thread-1" })],
    })
    expect(hasBlockingRecovery).not.toHaveBeenCalled()

    const mutation = await app.request("/api/v1/threads/thread-1", {
      method: "DELETE",
      headers,
    })
    expect(mutation.status).toBe(409)
    expect(await mutation.json()).toMatchObject({
      code: "checkpoint_recovery_pending",
    })
    expect(hasBlockingRecovery).toHaveBeenCalledWith("thread-1")
  })

  it("returns an opaque stable cursor and validates pagination inputs", async () => {
    const thread = (id: string) => ({
      id,
      title: id,
      projectName: "Test",
      projectPath: "",
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
    })
    const listThreadsPage = vi
      .fn()
      .mockReturnValueOnce({
        items: [thread("thread-c"), thread("thread-b")],
        next: {
          updatedAt: "2026-01-01T00:00:03.000Z",
          threadId: "thread-b",
        },
      })
      .mockReturnValueOnce({
        items: [thread("thread-a")],
        next: null,
      })
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threads: { listThreadsPage },
    } as unknown as AppState)
    const headers = { Authorization: "Bearer secret" }

    const first = await app.request("/api/v1/threads?limit=2", { headers })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual([thread("thread-c"), thread("thread-b")])
    const cursor = first.headers.get("x-next-cursor")
    expect(cursor).toBeTruthy()
    expect(listThreadsPage).toHaveBeenNthCalledWith(1, {
      limit: 2,
      beforeUpdatedAt: undefined,
      beforeThreadId: undefined,
    })

    const second = await app.request(
      `/api/v1/threads?limit=2&cursor=${encodeURIComponent(cursor!)}`,
      { headers }
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual([thread("thread-a")])
    expect(listThreadsPage).toHaveBeenNthCalledWith(2, {
      limit: 2,
      beforeUpdatedAt: "2026-01-01T00:00:03.000Z",
      beforeThreadId: "thread-b",
    })

    expect(
      (await app.request("/api/v1/threads?limit=0", { headers })).status
    ).toBe(400)
    expect(
      (
        await app.request("/api/v1/threads?cursor=not-base64-json", {
          headers,
        })
      ).status
    ).toBe(400)
    expect(listThreadsPage).toHaveBeenCalledTimes(2)
  })

  it("paginates thread activities with an opaque compound cursor", async () => {
    const listByThreadPage = vi
      .fn()
      .mockReturnValueOnce({
        items: [
          {
            activity_id: "activity-old",
            thread_id: "thread-1",
            turn_id: "turn-1",
            provider_instance_id: "codex",
            kind: "tool.completed",
            tone: "tool",
            summary: "Completed",
            payload: { ok: true },
            sequence: 9,
            created_at: "2026-07-23T00:00:01.000Z",
          },
          {
            activity_id: "activity-new",
            thread_id: "thread-1",
            turn_id: "turn-1",
            provider_instance_id: "codex",
            kind: "tool.started",
            tone: "tool",
            summary: "Started",
            payload: {},
            sequence: 10,
            created_at: "2026-07-23T00:00:02.000Z",
          },
        ],
        next: {
          sequence: 9,
          createdAt: "2026-07-23T00:00:01.000Z",
          activityId: "activity-old",
        },
      })
      .mockReturnValueOnce({ items: [], next: null })
      .mockReturnValueOnce({ items: [], next: null })
    const app = buildApp(makeConfig(), {
      ...makeState(),
      threadActivities: { listByThreadPage },
    } as unknown as AppState)
    const headers = { Authorization: "Bearer secret" }

    const first = await app.request(
      "/api/v1/threads/thread-1/activities?limit=2",
      { headers }
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual([
      expect.objectContaining({
        id: "activity-old",
        sequence: 9,
        providerInstanceId: "codex",
      }),
      expect.objectContaining({ id: "activity-new", sequence: 10 }),
    ])
    const cursor = first.headers.get("x-next-cursor")
    expect(cursor).toBeTruthy()
    expect(listByThreadPage).toHaveBeenNthCalledWith(1, "thread-1", {
      limit: 2,
      before: undefined,
      beforeSequence: undefined,
    })

    const second = await app.request(
      `/api/v1/threads/thread-1/activities?limit=2&cursor=${encodeURIComponent(cursor!)}`,
      { headers }
    )
    expect(second.status).toBe(200)
    expect(listByThreadPage).toHaveBeenNthCalledWith(2, "thread-1", {
      limit: 2,
      before: {
        sequence: 9,
        createdAt: "2026-07-23T00:00:01.000Z",
        activityId: "activity-old",
      },
      beforeSequence: undefined,
    })

    const legacy = await app.request(
      "/api/v1/threads/thread-1/activities?beforeSequence=9",
      { headers }
    )
    expect(legacy.status).toBe(200)
    expect(listByThreadPage).toHaveBeenNthCalledWith(3, "thread-1", {
      limit: undefined,
      before: undefined,
      beforeSequence: 9,
    })

    for (const path of [
      "/api/v1/threads/thread-1/activities?limit=0",
      "/api/v1/threads/thread-1/activities?beforeSequence=-1",
      "/api/v1/threads/thread-1/activities?cursor=not-base64-json",
      `/api/v1/threads/thread-1/activities?cursor=${encodeURIComponent(cursor!)}&beforeSequence=9`,
    ]) {
      expect((await app.request(path, { headers })).status).toBe(400)
    }
    expect(listByThreadPage).toHaveBeenCalledTimes(3)
  })
})

describe("bootstrap rate limiting", () => {
  // A non-loopback peer: every device behind one tunnel or reverse proxy
  // arrives from this same address.
  const tunnelPeer = { incoming: { socket: { remoteAddress: "198.51.100.7" } } }
  const bootstrapUrl = "http://203.0.113.9:3773/api/v1/remote/bootstrap"

  const probeFrom =
    (app: ReturnType<typeof buildApp>) =>
    (session?: string, headers: Record<string, string> = {}) =>
      app.request(
        bootstrapUrl,
        {
          headers: session
            ? { ...headers, Cookie: `betterc0de_remote_session=${session}` }
            : headers,
        },
        tunnelPeer
      )

  it("gives each presented session a burst of 30 so one device cannot lock out the tunnel", async () => {
    // Frozen clock: the session bucket refills one token per second, so a
    // slow machine could otherwise admit a 31st request.
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const probe = probeFrom(buildApp(makeConfig(), makeState()))

      for (let index = 0; index < 30; index += 1) {
        expect((await probe("device-a")).status, `device-a #${index}`).not.toBe(
          429
        )
      }
      expect((await probe("device-a")).status).toBe(429)
      // Another device behind the same address is unaffected, and so is an
      // anonymous probe from that address.
      expect((await probe("device-b")).status).not.toBe(429)
      expect((await probe()).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops a throttled device from draining the peer bucket shared with other devices", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const probe = probeFrom(buildApp(makeConfig(), makeState()))

      // 700 requests would empty the 600-token peer bucket if every refused
      // session request still cost a peer token.
      for (let index = 0; index < 700; index += 1) {
        await probe("device-a")
      }
      expect((await probe("device-a")).status).toBe(429)
      // (A presented credential over plaintext is refused with 426 — the
      // point is that it is the transport check answering, not the limiter.)
      expect((await probe("device-b")).status).not.toBe(429)
      expect((await probe()).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it("classifies loopback by the forwarded client only behind a trusted proxy", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const loopbackPeer = {
        incoming: { socket: { remoteAddress: "127.0.0.1" } },
      }
      const loopbackUrl = "http://127.0.0.1:3773/api/v1/remote/bootstrap"
      const forwarded = { "X-Forwarded-For": "203.0.113.9" }

      // Same-host reverse proxy: the TCP peer is loopback, the client is
      // not. With the proxy trusted the forwarded address decides, so the
      // request is throttled like any other remote one.
      const proxied = buildApp(
        { ...makeConfig(), trustProxyHeaders: true },
        makeState()
      )
      for (let index = 0; index < 600; index += 1) {
        await proxied.request(loopbackUrl, { headers: forwarded }, loopbackPeer)
      }
      const throttled = await proxied.request(
        loopbackUrl,
        { headers: forwarded },
        loopbackPeer
      )
      expect(throttled.status).toBe(429)

      // Proxy not trusted: the header is ignored and the loopback peer is
      // never throttled, whatever the header claims.
      const direct = buildApp(makeConfig(), makeState())
      for (let index = 0; index < 700; index += 1) {
        const response = await direct.request(
          loopbackUrl,
          { headers: forwarded },
          loopbackPeer
        )
        expect(response.status, `ignored header #${index}`).toBe(200)
      }

      // A loopback TCP peer whose Host is a DNS name is not the renderer,
      // even when that name begins with 127.0.0.1.
      const rebound = buildApp(makeConfig(), makeState())
      const reboundUrl = "http://127.0.0.1.nip.io:3773/api/v1/remote/bootstrap"
      for (let index = 0; index < 600; index += 1) {
        await rebound.request(reboundUrl, {}, loopbackPeer)
      }
      expect((await rebound.request(reboundUrl, {}, loopbackPeer)).status).toBe(
        429
      )

      // A remote TCP peer cannot become loopback by naming localhost.
      const hostOnly = buildApp(makeConfig(), makeState())
      for (let index = 0; index < 600; index += 1) {
        await hostOnly.request(
          "http://localhost:3773/api/v1/remote/bootstrap",
          {},
          tunnelPeer
        )
      }
      expect(
        (
          await hostOnly.request(
            "http://localhost:3773/api/v1/remote/bootstrap",
            {},
            tunnelPeer
          )
        ).status
      ).toBe(429)
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives anonymous probes a much larger per-peer budget and never throttles loopback", async () => {
    // Frozen clock: the bucket refills 10 tokens/s and 600 requests take
    // longer than 100 ms, so real time would admit the 601st probe.
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const app = buildApp(makeConfig(), makeState())
      for (let index = 0; index < 600; index += 1) {
        const response = await app.request(bootstrapUrl, {}, tunnelPeer)
        expect(response.status, `anonymous #${index}`).toBe(200)
      }
      expect((await app.request(bootstrapUrl, {}, tunnelPeer)).status).toBe(429)

      for (let index = 0; index < 700; index += 1) {
        const response = await app.request("/api/v1/remote/bootstrap")
        expect(response.status, `loopback #${index}`).toBe(200)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
