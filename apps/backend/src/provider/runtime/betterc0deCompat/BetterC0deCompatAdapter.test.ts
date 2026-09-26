import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { BetterC0deCompatAdapter } from "./BetterC0deCompatAdapter"
import type { ApprovalRequestId, ThreadId } from "../contracts"
import { CLEANUP_QUARANTINE_RETRY_WINDOW_MS } from "../CleanupQuarantine"
import { logger } from "../../../observability/logger"

function platformNodeCliPath(scriptPath: string): string {
  fs.chmodSync(scriptPath, 0o755)
  if (process.platform !== "win32") return scriptPath
  const cmdPath = scriptPath.replace(/\.cjs$/i, ".cmd")
  fs.writeFileSync(
    cmdPath,
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    "utf8"
  )
  return cmdPath
}

describe("BetterC0deCompatAdapter", () => {
  it("drains temporary metadata clients and rejects new probes during shutdown", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const close = vi.fn(async () => {})
    let finish!: (value: unknown) => void
    client.app.skills.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const serverConnector = vi.fn(async () => ({ url: "http://127.0.0.1:4096", external: true, close }))
    const adapter = new BetterC0deCompatAdapter({ clientFactory: (() => client) as never, serverConnector })
    const probing = adapter.availableSkills()
    await vi.waitFor(() => expect(finish).toBeDefined())
    let stopped = false
    const stopping = adapter.stopAll().then(() => { stopped = true })
    try {
      await new Promise((resolve) => setImmediate(resolve))
      expect(stopped).toBe(false)
      await expect(adapter.availableSkills({ force: true })).rejects.toThrow(/shutdown/i)
      expect(serverConnector).toHaveBeenCalledOnce()
    } finally {
      finish({ data: [] })
      await probing
      await stopping
      stream.close()
    }
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([{ id: 12 }, { id: "" }])("rejects malformed created session identifiers: %j", async (data) => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    client.session.create.mockResolvedValueOnce({ data })
    const close = vi.fn(async () => {})
    const adapter = new BetterC0deCompatAdapter({
      clientFactory: (() => client) as never,
      serverConnector: async () => ({ url: "http://127.0.0.1:4096", external: true, close }),
    })
    await expect(adapter.startSession({ threadId: "malformed" as ThreadId })).rejects.toThrow("invalid session ID")
    expect(adapter.hasSession("malformed" as ThreadId)).toBe(false)
    expect(close).toHaveBeenCalledOnce()
    stream.close()
  })

  it("bounds per-directory metadata and prevents invalidated work from refilling the cache", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      clientFactory: (() => client) as never,
      serverConnector: async () => ({ url: "http://127.0.0.1:4096", external: true, close: async () => {} }),
    })
    for (let index = 0; index < 70; index++) await adapter.availableSkills({ cwd: `/workspace/${index}` })
    const calls = client.app.skills.mock.calls.length
    await adapter.availableSkills({ cwd: "/workspace/0" })
    expect(client.app.skills).toHaveBeenCalledTimes(calls + 1)
    let finish!: (value: unknown) => void
    client.app.skills.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = adapter.availableSkills({ cwd: "/pending" })
    await vi.waitFor(() => expect(finish).toBeDefined())
    adapter.invalidateMetadata({ cwd: "/pending" })
    finish({ data: [{ name: "stale", location: "/old" }] })
    await pending
    client.app.skills.mockResolvedValueOnce({ data: [{ name: "fresh", location: "/new" }] })
    expect((await adapter.availableSkills({ cwd: "/pending" }))[0]?.name).toBe("fresh")
    stream.close()
  })

  it.each(["session", "all"])("cancels and drains a pending startup when stopping %s", async (stopKind) => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const close = vi.fn(async () => {})
    let connected!: (server: { url: string; external: boolean; close: typeof close }) => void
    const serverConnector = vi.fn(() => new Promise<{ url: string; external: boolean; close: typeof close }>((resolve) => { connected = resolve }))
    const adapter = new BetterC0deCompatAdapter({ clientFactory: (() => client) as never, serverConnector })
    const threadId = "pending-start" as ThreadId
    const starting = adapter.startSession({ threadId })
    const rejected = expect(starting).rejects.toThrow(/cancelled/i)
    await vi.waitFor(() => expect(serverConnector).toHaveBeenCalledOnce())
    const stopping = stopKind === "all" ? adapter.stopAll() : adapter.stopSession(threadId)
    connected({ url: "http://127.0.0.1:4096", external: false, close })
    await stopping
    await rejected
    expect(client.session.create).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    expect(adapter.hasSession(threadId)).toBe(false)
    stream.close()
  })

  it("does not send a prompt after stop while agent discovery is pending", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      clientFactory: (() => client) as never,
      serverConnector: async () => ({ url: "http://127.0.0.1:4096", external: true, close: async () => {} }),
    })
    const threadId = "stopped-discovery" as ThreadId
    await adapter.startSession({ threadId })
    let discovered!: (agents: never[]) => void
    vi.spyOn(adapter, "availableAgents").mockImplementation(() => new Promise((resolve) => { discovered = resolve }))
    const sending = adapter.sendTurn({ threadId, message: "inspect", modelId: "openai/gpt-5", history: [], chatMode: "ask" })
    const rejected = expect(sending).rejects.toThrow(/stopped|cancelled/i)
    await flushAsync()
    await adapter.stopSession(threadId)
    discovered([])
    await rejected
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    stream.close()
  })

  it("retains failed server cleanup after session startup failure", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const startFailure = new Error("session create failed")
    const cleanupFailure = new Error("server close failed")
    client.session.create.mockRejectedValueOnce(startFailure)
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const serverConnector = vi.fn(async () => ({
      url: "http://127.0.0.1:4096",
      external: false,
      close,
    }))
    const adapter = new BetterC0deCompatAdapter({
      binaryPath: "betterc0de",
      clientFactory: (() => client) as never,
      serverConnector,
    })

    await expect(
      adapter.startSession({
        threadId: "failed-session-start" as ThreadId,
        cwd: "/tmp/project",
      })
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [startFailure, cleanupFailure],
    })
    const quarantines = (
      adapter as unknown as {
        serverCleanupQuarantines: Map<unknown, unknown>
      }
    ).serverCleanupQuarantines
    expect(quarantines.size).toBe(1)

    await expect(
      adapter.startSession({
        threadId: "different-thread" as ThreadId,
        cwd: "/tmp/project",
      })
    ).rejects.toMatchObject({
      code: "BETTERC0DE_SERVER_CLEANUP_QUARANTINED",
      statusCode: 503,
    })
    expect(serverConnector).toHaveBeenCalledTimes(1)

    await expect(adapter.stopAll()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(3)
    expect(quarantines.size).toBe(0)
    stream.close()
  })

  it("re-attempts a quarantined server after the retry window and releases it only once the close is confirmed", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    client.session.create.mockRejectedValueOnce(new Error("session create failed"))
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("server close failed"))
    const serverConnector = vi.fn(async () => ({
      url: "http://127.0.0.1:4096",
      external: false,
      close,
    }))
    const adapter = new BetterC0deCompatAdapter({
      binaryPath: "betterc0de",
      clientFactory: (() => client) as never,
      serverConnector,
    })

    await expect(
      adapter.startSession({ threadId: "quarantine-ttl-a" as ThreadId, cwd: "/tmp/project" })
    ).rejects.toMatchObject({ name: "AggregateError" })
    await expect(
      adapter.startSession({ threadId: "quarantine-ttl-b" as ThreadId, cwd: "/tmp/project" })
    ).rejects.toMatchObject({ code: "BETTERC0DE_SERVER_CLEANUP_QUARANTINED" })
    const quarantines = (
      adapter as unknown as {
        serverCleanupQuarantines: Map<unknown, { firstFailedAt: number | null }>
      }
    ).serverCleanupQuarantines
    expect(quarantines.size).toBe(1)

    const error = vi.spyOn(logger, "error").mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(Date.now() + CLEANUP_QUARANTINE_RETRY_WINDOW_MS + 1)
      const expiredAt = Date.now()
      // Still failing after the window: not released on the timer, window
      // restarted, new sessions still refused — the process is unconfirmed.
      await expect(
        adapter.startSession({ threadId: "quarantine-ttl-c" as ThreadId, cwd: "/tmp/project" })
      ).rejects.toMatchObject({ code: "BETTERC0DE_SERVER_CLEANUP_QUARANTINED" })
      expect(quarantines.size).toBe(1)
      expect([...quarantines.values()][0]?.firstFailedAt).toBe(expiredAt)
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ attempts: 3 }),
        expect.stringContaining(
          "quarantined BetterC0de server still would not close after the retry window; keeping it quarantined"
        )
      )
      expect(serverConnector).toHaveBeenCalledTimes(1)

      close.mockResolvedValue(undefined)
      await expect(
        adapter.startSession({ threadId: "quarantine-ttl-d" as ThreadId, cwd: "/tmp/project" })
      ).resolves.toBeDefined()
      expect(quarantines.size).toBe(0)
    } finally {
      vi.useRealTimers()
      error.mockRestore()
    }
    stream.close()
    await adapter.stopAll().catch(() => {})
  })

  it("pins the unconfigured model fallback only for the short error TTL", async () => {
    const adapter = new BetterC0deCompatAdapter({
      binaryPath: "   ",
      clientFactory: (() => {
        throw new Error("must not be called while unconfigured")
      }) as never,
      serverConnector: vi.fn(async () => {
        throw new Error("must not connect while unconfigured")
      }),
    })

    await expect(adapter.availableModels()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: expect.any(String) })])
    )
    const cache = (
      adapter as unknown as { modelsCache: { error?: true } | null }
    ).modelsCache
    // "Not configured" flips the moment the user enters a URL; a fallback
    // pinned for the five-minute success TTL hid the real catalog that long.
    expect(cache?.error).toBe(true)
  })

  it("drops pending permissions and questions when the server disposes the session", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    await adapter.startSession({
      threadId: "disposed-session" as ThreadId,
      cwd: "/tmp/project",
    })
    const context = (
      adapter as unknown as {
        sessions: Map<
          string,
          {
            pendingPermissions: Map<string, unknown>
            pendingQuestions: Map<string, unknown>
          }
        >
        retireDisposedContext(context: unknown): void
      }
    )
    const session = context.sessions.get("disposed-session")!
    session.pendingPermissions.set("perm-1", { id: "perm-1" })
    session.pendingQuestions.set("q-1", { id: "q-1" })

    context.retireDisposedContext(session)

    expect(session.pendingPermissions.size).toBe(0)
    expect(session.pendingQuestions.size).toBe(0)
    expect(adapter.hasSession("disposed-session" as ThreadId)).toBe(false)
    stream.close()
  })

  it("retains failed server cleanup after temporary client creation failure", async () => {
    const clientFailure = new Error("client creation failed")
    const cleanupFailure = new Error("temporary server close failed")
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const serverConnector = vi.fn(async () => ({
      url: "http://127.0.0.1:4096",
      external: false,
      close,
    }))
    const adapter = new BetterC0deCompatAdapter({
      binaryPath: "betterc0de",
      clientFactory: vi.fn(async () => {
        throw clientFailure
      }),
      serverConnector,
    })

    await expect(
      adapter.availableSkills({ cwd: "/tmp/project", force: true })
    ).resolves.toEqual([])
    const quarantines = (
      adapter as unknown as {
        serverCleanupQuarantines: Map<unknown, unknown>
      }
    ).serverCleanupQuarantines
    expect(quarantines.size).toBe(1)

    await expect(
      adapter.startSession({
        threadId: "blocked-after-temp-client" as ThreadId,
        cwd: "/tmp/project",
      })
    ).rejects.toMatchObject({
      code: "BETTERC0DE_SERVER_CLEANUP_QUARANTINED",
      statusCode: 503,
    })
    expect(serverConnector).toHaveBeenCalledTimes(1)

    await expect(adapter.stopAll()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(3)
    expect(quarantines.size).toBe(0)
  })

  it("terminates a version probe that exceeds the combined output cap", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-noisy-version-")
    )
    const scriptPath = path.join(dir, "noisy-betterc0de.cjs")
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(Buffer.alloc(300 * 1024, 120));",
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
      "utf8"
    )
    try {
      const adapter = new BetterC0deCompatAdapter({
        binaryPath: platformNodeCliPath(scriptPath),
      })

      await expect(adapter.probeStatus({ cwd: dir })).resolves.toMatchObject({
        configured: false,
        installed: true,
        status: "error",
        message: "Failed to execute compatibility CLI health check.",
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("terminates server startup that exceeds the combined output cap", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-noisy-server-")
    )
    const scriptPath = path.join(dir, "noisy-server-betterc0de.cjs")
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "if (process.argv.includes('--version')) {",
        '  process.stdout.write("1.14.19\\n");',
        "  process.exit(0);",
        "}",
        "process.stderr.write(Buffer.alloc(300 * 1024, 120));",
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
      "utf8"
    )
    try {
      const adapter = new BetterC0deCompatAdapter({
        binaryPath: platformNodeCliPath(scriptPath),
      })

      await expect(adapter.probeStatus({ cwd: dir })).resolves.toMatchObject({
        configured: false,
        installed: true,
        status: "error",
        message: "Failed to execute compatibility CLI health check.",
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("probes BetterC0de compatibility external server status from connected upstream providers", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    client.provider.list.mockResolvedValue({
      data: { connected: ["openai", "anthropic"], all: [] },
    })
    const adapter = new BetterC0deCompatAdapter({
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })

    await expect(adapter.probeStatus({ cwd: "/tmp/project" })).resolves.toEqual(
      {
        configured: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated", type: "betterc0de" },
        message:
          "2 upstream providers connected through the configured compatibility server.",
      }
    )

    expect(client.provider.list).toHaveBeenCalled()
    expect(client.app.agents).toHaveBeenCalled()
    stream.close()
  })

  it("marks BetterC0de compatibility warning when no upstream providers are connected", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })

    await expect(adapter.probeStatus({ cwd: "/tmp/project" })).resolves.toEqual(
      {
        configured: false,
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown", type: "betterc0de" },
        message:
          "Connected to the configured compatibility server, but it did not report any connected upstream providers.",
      }
    )

    stream.close()
  })

  it("starts sessions through an external compatibility server with password auth", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const clientFactory = vi.fn(() => client)
    const close = vi.fn(async () => {})
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de-main",
      continuationKey: "betterc0de:instance:betterc0de-main",
      serverUrl: "http://127.0.0.1:4096",
      serverUsername: "alice",
      serverPassword: "secret",
      clientFactory: clientFactory as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close,
      })),
    })

    const session = await adapter.startSession({
      threadId: "thread-1" as ThreadId,
      cwd: "/tmp/project",
      runtimeMode: "read-only",
    })

    expect(clientFactory).toHaveBeenCalledWith(
      {
        baseUrl: "http://127.0.0.1:4096",
        directory: "/tmp/project",
        serverUsername: "alice",
        serverPassword: "secret",
      },
      expect.objectContaining({ providerKind: "betterc0de" })
    )
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "BetterC0de thread-1",
        permission: expect.arrayContaining([
          { permission: "question", pattern: "*", action: "allow" },
        ]),
      })
    )
    expect(session).toMatchObject({
      providerInstanceId: "betterc0de-main",
      providerThreadId: "oc-session-1",
      continuationKey: "betterc0de:instance:betterc0de-main",
      status: "ready",
      cwd: "/tmp/project",
    })

    stream.close()
    await adapter.stopAll()
  })

  it("retains failed sessions and propagates server close failures from stopAll", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const closeFailure = new Error("server close failed")
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(closeFailure)
      .mockResolvedValueOnce(undefined)
    const adapter = new BetterC0deCompatAdapter({
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close,
      })),
    })
    await adapter.startSession({
      threadId: "thread-close-failure" as ThreadId,
      cwd: "/tmp/project",
    })

    await expect(adapter.stopAll()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [closeFailure],
    })
    expect(adapter.hasSession("thread-close-failure" as ThreadId)).toBe(true)

    await expect(adapter.stopAll()).resolves.toBeUndefined()
    expect(adapter.hasSession("thread-close-failure" as ThreadId)).toBe(false)
    expect(close).toHaveBeenCalledTimes(2)
    stream.close()
  })

  it("treats an unexpected clean event-stream EOF as a terminal transport exit", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const close = vi.fn(async () => {})
    const adapter = new BetterC0deCompatAdapter({
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close,
      })),
    })
    const events: Array<{ type: string; message?: string }> = []
    adapter.subscribe((event) => events.push(event))
    await adapter.startSession({
      threadId: "thread-eof" as ThreadId,
      cwd: "/tmp/project",
    })

    stream.close()
    await flushAsync()

    expect(adapter.hasSession("thread-eof" as ThreadId)).toBe(false)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime.error",
        payload: expect.objectContaining({
          message: expect.stringContaining("ended unexpectedly"),
        }),
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: "session.exited" })
    )
    expect(close).toHaveBeenCalled()
  })

  it("does not expose event-subscription diagnostics in public events", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const privateDiagnostic =
      "connect C:\\private\\compat.json failed with token sk-sensitive"
    client.event.subscribe.mockRejectedValueOnce(new Error(privateDiagnostic))
    const adapter = new BetterC0deCompatAdapter({
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: vi.fn(async () => {}),
      })),
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    adapter.subscribe((event) => events.push(event))

    await adapter.startSession({
      threadId: "thread-subscribe-failure" as ThreadId,
      cwd: "/tmp/project",
    })
    await flushAsync()

    expect(JSON.stringify(events)).not.toContain(privateDiagnostic)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runtime.error",
          payload: {
            message: "BetterC0de compatibility event stream failed.",
            class: "transport_error",
          },
        }),
      ])
    )
  })

  it("retains unexpected-exit context until server cleanup succeeds", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const cleanupFailure = new Error("unexpected server close failed")
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const serverConnector = vi.fn(async () => ({
      url: "http://127.0.0.1:4096",
      external: false,
      close,
    }))
    const adapter = new BetterC0deCompatAdapter({
      binaryPath: "betterc0de",
      clientFactory: (() => client) as never,
      serverConnector,
    })
    await adapter.startSession({
      threadId: "unexpected-cleanup" as ThreadId,
      cwd: "/tmp/project",
    })

    stream.close()
    await flushAsync()
    const sessions = (adapter as unknown as { sessions: Map<string, unknown> })
      .sessions
    expect(adapter.hasSession("unexpected-cleanup" as ThreadId)).toBe(false)
    expect(sessions.has("unexpected-cleanup")).toBe(true)

    await expect(
      adapter.startSession({
        threadId: "blocked-after-unexpected" as ThreadId,
        cwd: "/tmp/project",
      })
    ).rejects.toMatchObject({
      code: "BETTERC0DE_SERVER_CLEANUP_QUARANTINED",
      statusCode: 503,
    })
    expect(serverConnector).toHaveBeenCalledTimes(1)

    await expect(adapter.stopAll()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(3)
    expect(sessions.has("unexpected-cleanup")).toBe(false)
  })

  it("merges local project policy without widening the session permission ceiling", async () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-betterc0de-policy-")
    )
    try {
      fs.writeFileSync(
        path.join(cwd, "betterc0de.jsonc"),
        [
          "{",
          '  "tools": { "webfetch": false },',
          '  "permission": {',
          '    "bash": { "npm test *": "allow" },',
          '    "edit": { "src/generated/*": "deny" }',
          "  }",
          "}",
        ].join("\n"),
        "utf8"
      )
      const stream = createPushStream<unknown>()
      const client = createFakeClient({ stream: stream.stream })
      const adapter = new BetterC0deCompatAdapter({
        providerInstanceId: "betterc0de-main",
        serverUrl: "http://127.0.0.1:4096",
        clientFactory: (() => client) as never,
        serverConnector: vi.fn(async () => ({
          url: "http://127.0.0.1:4096",
          external: true,
          close: async () => {},
        })),
      })

      await adapter.startSession({
        threadId: "thread-policy" as ThreadId,
        cwd,
        runtimeMode: "allow-edits",
      })

      expect(client.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          permission: expect.arrayContaining([
            { permission: "webfetch", pattern: "*", action: "deny" },
            // Project policy may narrow an allow-edits session, but execution
            // remains approval-gated and cannot be widened to auto-allow.
            { permission: "bash", pattern: "npm test *", action: "ask" },
            {
              permission: "edit",
              pattern: "src/generated/*",
              action: "deny",
            },
          ]),
        })
      )
      stream.close()
      await adapter.stopAll()
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("sends turns with parsed provider/model plus BetterC0de compatibility agent and variant options", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })

    await adapter.startSession({ threadId: "thread-2" as ThreadId })
    await adapter.sendTurn({
      threadId: "thread-2" as ThreadId,
      message: "Build this",
      modelId: "openai/gpt-5",
      modelSelection: {
        instanceId: "betterc0de",
        model: "openai/gpt-5",
        options: [
          { id: "agent", value: "build" },
          { id: "variant", value: "high" },
        ],
      },
      history: [],
    })

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      sessionID: "oc-session-1",
      model: { providerID: "openai", modelID: "gpt-5" },
      agent: "build",
      variant: "high",
      parts: [{ type: "text", text: "Build this" }],
    })

    stream.close()
    await adapter.stopAll()
  })

  it("seeds durable history only on the first turn of a fresh compatibility session", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    const threadId = "thread-history" as ThreadId
    const history = [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ]

    await adapter.startSession({ threadId })
    await adapter.sendTurn({
      threadId,
      message: "Build this",
      modelId: "openai/gpt-5",
      history,
    })
    await adapter.sendTurn({
      threadId,
      message: "Follow up",
      modelId: "openai/gpt-5",
      history,
    })

    const promptCalls = client.session.promptAsync.mock
      .calls as unknown as Array<
      [{ parts: Array<{ type: string; text?: string }> }]
    >
    const firstText = promptCalls[0]?.[0].parts[0]?.text
    expect(firstText).toEqual(
      expect.stringContaining("<conversation_history_json>")
    )
    expect(firstText).toEqual(expect.stringContaining("Earlier question"))
    expect(firstText).toEqual(expect.stringMatching(/Build this$/))
    expect(promptCalls[1]?.[0].parts[0]?.text).toBe("Follow up")

    stream.close()
    await adapter.stopAll()
  })

  it("does not expose rejected prompt diagnostics in public events", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const privateDiagnostic =
      "prompt failed at C:\\private\\compat.json with token sk-sensitive"
    client.session.promptAsync.mockRejectedValueOnce(
      new Error(privateDiagnostic)
    )
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    adapter.subscribe((event) => events.push(event))

    await adapter.startSession({ threadId: "thread-private-error" as ThreadId })
    await expect(
      adapter.sendTurn({
        threadId: "thread-private-error" as ThreadId,
        message: "Build this",
        modelId: "openai/gpt-5",
        history: [],
      })
    ).rejects.toThrow(privateDiagnostic)

    expect(JSON.stringify(events)).not.toContain(privateDiagnostic)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turn.aborted",
          payload: {
            reason: "BetterC0de compatibility provider turn failed.",
          },
        }),
      ])
    )
    stream.close()
    await adapter.stopAll()
  })

  it("passes structured attachments through as BetterC0de compatibility prompt file parts", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })

    await adapter.startSession({ threadId: "thread-image" as ThreadId })
    await adapter.sendTurn({
      threadId: "thread-image" as ThreadId,
      message: "Describe this",
      modelId: "anthropic/claude-sonnet-4-5",
      history: [],
      attachments: [
        {
          type: "file",
          filename: "screen.png",
          mediaType: "image/png",
          url: "data:image/png;base64,AAA",
        },
      ],
    })

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      sessionID: "oc-session-1",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
      parts: [
        { type: "text", text: "Describe this" },
        {
          type: "file",
          mime: "image/png",
          filename: "screen.png",
          url: "data:image/png;base64,AAA",
        },
      ],
    })

    stream.close()
    await adapter.stopAll()
  })

  it("maps BetterC0de compatibility SDK events into canonical runtime events and routes replies", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    const events: Array<{
      type: string
      payload?: unknown
      requestId?: string
    }> = []
    const unsubscribe = adapter.subscribe((event) => events.push(event))

    await adapter.startSession({ threadId: "thread-3" as ThreadId })
    await adapter.sendTurn({
      threadId: "thread-3" as ThreadId,
      message: "Hello",
      modelId: "openai/gpt-5",
      history: [],
    })

    stream.push({
      id: "evt-message",
      type: "message.updated",
      properties: {
        sessionID: "oc-session-1",
        info: { id: "assistant-1", role: "assistant" },
      },
    })
    stream.push({
      id: "evt-text",
      type: "message.part.updated",
      properties: {
        sessionID: "oc-session-1",
        time: Date.now(),
        part: {
          id: "text-1",
          sessionID: "oc-session-1",
          messageID: "assistant-1",
          type: "text",
          text: "Hello from BetterC0de",
          time: { start: Date.now(), end: Date.now() },
        },
      },
    })
    stream.push({
      id: "evt-tool",
      type: "message.part.updated",
      properties: {
        sessionID: "oc-session-1",
        time: Date.now(),
        part: {
          id: "tool-1",
          sessionID: "oc-session-1",
          messageID: "assistant-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "pwd" },
            title: "pwd",
            time: { start: Date.now() },
          },
        },
      },
    })
    stream.push({
      id: "evt-task-tool",
      type: "message.part.updated",
      properties: {
        sessionID: "oc-session-1",
        time: Date.now(),
        part: {
          id: "tool-task-1",
          sessionID: "oc-session-1",
          messageID: "assistant-1",
          type: "tool",
          callID: "call-task-1",
          tool: "task",
          state: {
            status: "running",
            input: {
              subagent_type: "code-reviewer",
              description: "Review provider runtime extraction",
              prompt: "Inspect the provider runtime code",
            },
            title: "Review provider runtime extraction",
            metadata: {
              sessionId: "oc-subagent-1",
              model: { providerID: "openai", modelID: "gpt-5" },
            },
            time: { start: Date.now() },
          },
        },
      },
    })
    stream.push({
      id: "evt-permission",
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "oc-session-1",
        permission: "bash",
        patterns: ["pwd"],
        metadata: { command: "pwd" },
      },
    })
    stream.push({
      id: "evt-question",
      type: "question.asked",
      properties: {
        id: "question-1",
        sessionID: "oc-session-1",
        questions: [
          {
            header: "Mode",
            question: "Choose mode",
            options: [{ label: "Build", description: "Execute" }],
          },
        ],
      },
    })
    stream.push({
      id: "evt-question-reject",
      type: "question.asked",
      properties: {
        id: "question-2",
        sessionID: "oc-session-1",
        questions: [
          {
            header: "Scope",
            question: "Choose scope",
            options: [{ label: "Skip", description: "Do not continue" }],
          },
        ],
      },
    })
    stream.push({
      id: "evt-idle",
      type: "session.status",
      properties: {
        sessionID: "oc-session-1",
        status: { type: "idle" },
      },
    })
    await flushAsync()

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "content.delta",
        "item.completed",
        "item.updated",
        "request.opened",
        "user-input.requested",
        "turn.completed",
      ])
    )
    const toolUpdate = events.find(
      (event) =>
        event.type === "item.updated" &&
        (event.payload as { itemType?: string } | undefined)?.itemType ===
          "command_execution"
    )
    expect(toolUpdate?.payload).toEqual(
      expect.objectContaining({
        itemType: "command_execution",
        status: "running",
        title: "pwd",
        detail: "pwd",
        input: { command: "pwd" },
        data: expect.objectContaining({
          toolName: "bash",
          input: { command: "pwd" },
        }),
      })
    )
    expect(
      events.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload as { itemType?: string } | undefined)?.itemType ===
            "collab_agent_tool_call"
      )?.payload
    ).toEqual(
      expect.objectContaining({
        itemType: "collab_agent_tool_call",
        status: "running",
        title: "Review provider runtime extraction",
        input: expect.objectContaining({
          subagent_type: "code-reviewer",
          description: "Review provider runtime extraction",
        }),
        data: expect.objectContaining({
          toolName: "task",
          metadata: {
            sessionId: "oc-subagent-1",
            model: { providerID: "openai", modelID: "gpt-5" },
          },
        }),
      })
    )
    expect(
      events.find((event) => event.type === "request.opened")?.payload
    ).toMatchObject({
      requestType: "command_execution_approval",
      detail: "pwd",
      args: { command: "pwd" },
    })

    await adapter.respondToRequest(
      "thread-3" as ThreadId,
      "perm-1" as ApprovalRequestId,
      { kind: "tool_approval", decision: "approve" }
    )
    await adapter.respondToRequest(
      "thread-3" as ThreadId,
      "question-1" as ApprovalRequestId,
      { kind: "user_input", answers: { "question-0-mode": "Build" } }
    )
    await adapter.respondToRequest(
      "thread-3" as ThreadId,
      "question-2" as ApprovalRequestId,
      { kind: "user_input_reject" }
    )

    expect(client.permission.reply).toHaveBeenCalledWith({
      requestID: "perm-1",
      reply: "once",
    })
    expect(client.question.reply).toHaveBeenCalledWith({
      requestID: "question-1",
      answers: [["Build"]],
    })
    expect(client.question.reject).toHaveBeenCalledWith({
      requestID: "question-2",
    })

    unsubscribe()
    stream.close()
    await adapter.stopAll()
  })

  it("maps BetterC0de session.next events into canonical text, reasoning, tool, and usage events", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    const events: Array<{ type: string; payload?: unknown; usage?: unknown }> =
      []
    const unsubscribe = adapter.subscribe((event) => events.push(event))

    await adapter.startSession({
      threadId: "thread-next" as ThreadId,
      cwd: "/tmp/project",
    })
    await adapter.sendTurn({
      threadId: "thread-next" as ThreadId,
      message: "Hello",
      modelId: "openai/gpt-5",
      history: [],
    })

    stream.push({
      id: "next-prompted",
      type: "session.next.prompted",
      properties: {
        timestamp: 1_700_000_000_000,
        sessionID: "oc-session-1",
        prompt: {
          text: "Hello",
          files: [{ uri: "file:///tmp/project/index.ts", mime: "text/plain" }],
          agents: [{ name: "build" }],
          references: [{ name: "main", kind: "git" }],
        },
      },
    })
    stream.push({
      id: "next-synthetic",
      type: "session.next.synthetic",
      properties: {
        timestamp: 1_700_000_000_000,
        sessionID: "oc-session-1",
        text: "Synthetic context",
      },
    })
    stream.push({
      id: "next-step-start",
      type: "session.next.step.started",
      properties: {
        timestamp: 1_700_000_000_000,
        sessionID: "oc-session-1",
        agent: "build",
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
        snapshot: "before",
      },
    })
    stream.push({
      id: "next-text-start",
      type: "session.next.text.started",
      properties: {
        timestamp: 1_700_000_000_005,
        sessionID: "oc-session-1",
      },
    })
    stream.push({
      id: "next-text",
      type: "session.next.text.delta",
      properties: {
        timestamp: 1_700_000_000_010,
        sessionID: "oc-session-1",
        delta: "Hello from next",
      },
    })
    stream.push({
      id: "next-reasoning-start",
      type: "session.next.reasoning.started",
      properties: {
        timestamp: 1_700_000_000_015,
        sessionID: "oc-session-1",
        reasoningID: "reason-1",
      },
    })
    stream.push({
      id: "next-reasoning",
      type: "session.next.reasoning.delta",
      properties: {
        timestamp: 1_700_000_000_020,
        sessionID: "oc-session-1",
        reasoningID: "reason-1",
        delta: "Thinking",
      },
    })
    stream.push({
      id: "next-tool-start",
      type: "session.next.tool.input.started",
      properties: {
        timestamp: 1_700_000_000_030,
        sessionID: "oc-session-1",
        callID: "call-next",
        name: "bash",
      },
    })
    stream.push({
      id: "next-tool-called",
      type: "session.next.tool.called",
      properties: {
        timestamp: 1_700_000_000_040,
        sessionID: "oc-session-1",
        callID: "call-next",
        tool: "bash",
        input: { command: "pwd" },
        provider: { executed: true, metadata: { source: "betterc0de" } },
      },
    })
    stream.push({
      id: "next-tool-success",
      type: "session.next.tool.success",
      properties: {
        timestamp: 1_700_000_000_050,
        sessionID: "oc-session-1",
        callID: "call-next",
        structured: { exitCode: 0 },
        content: [{ type: "text", text: "/tmp/project" }],
        provider: { executed: true, metadata: { status: "done" } },
      },
    })
    stream.push({
      id: "next-retry",
      type: "session.next.retried",
      properties: {
        timestamp: 1_700_000_000_055,
        sessionID: "oc-session-1",
        attempt: 2,
        error: {
          message: "rate limited",
          statusCode: 429,
          isRetryable: true,
        },
      },
    })
    stream.push({
      id: "next-compaction-start",
      type: "session.next.compaction.started",
      properties: {
        timestamp: 1_700_000_000_056,
        sessionID: "oc-session-1",
        reason: "auto",
      },
    })
    stream.push({
      id: "next-compaction-delta",
      type: "session.next.compaction.delta",
      properties: {
        timestamp: 1_700_000_000_057,
        sessionID: "oc-session-1",
        text: "summary chunk",
      },
    })
    stream.push({
      id: "next-compaction-end",
      type: "session.next.compaction.ended",
      properties: {
        timestamp: 1_700_000_000_058,
        sessionID: "oc-session-1",
        text: "final summary",
        include: "all",
      },
    })
    stream.push({
      id: "next-step-end",
      type: "session.next.step.ended",
      properties: {
        timestamp: 1_700_000_000_060,
        sessionID: "oc-session-1",
        finish: "stop",
        cost: 0.01,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 3,
          cache: { read: 4, write: 5 },
        },
      },
    })
    await flushAsync()

    expect(
      events.find((event) => event.type === "session.configured")?.payload
    ).toEqual({
      config: {
        agent: "build",
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
        snapshot: "before",
      },
    })
    expect(
      events.find(
        (event) =>
          event.type === "thread.metadata.updated" &&
          (
            event.payload as {
              metadata?: { betterc0de?: { prompt?: unknown } }
            }
          )?.metadata?.betterc0de?.prompt
      )?.payload
    ).toEqual({
      metadata: {
        betterc0de: {
          prompt: {
            text: "Hello",
            files: [
              { uri: "file:///tmp/project/index.ts", mime: "text/plain" },
            ],
            agents: [{ name: "build" }],
            references: [{ name: "main", kind: "git" }],
          },
        },
      },
    })
    expect(
      events.find(
        (event) =>
          event.type === "task.completed" &&
          (event.payload as { taskId?: string } | undefined)?.taskId ===
            "betterc0de-prompt:next-prompted"
      )?.payload
    ).toEqual({
      taskId: "betterc0de-prompt:next-prompted",
      status: "completed",
      summary: "Hello",
    })
    expect(
      events.find(
        (event) =>
          event.type === "task.completed" &&
          (event.payload as { taskId?: string } | undefined)?.taskId ===
            "betterc0de-synthetic:next-synthetic"
      )?.payload
    ).toEqual({
      taskId: "betterc0de-synthetic:next-synthetic",
      status: "completed",
      summary: "Synthetic context",
    })
    expect(
      events.find((event) => event.type === "content.delta")?.payload
    ).toEqual({
      streamKind: "assistant_text",
      delta: "Hello from next",
    })
    expect(
      events.find((event) => event.type === "reasoning.delta")?.payload
    ).toEqual({
      streamKind: "reasoning_text",
      delta: "Thinking",
    })
    expect(
      events.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload as { status?: string } | undefined)?.status ===
            "running"
      )?.payload
    ).toEqual(
      expect.objectContaining({
        itemType: "command_execution",
        status: "running",
        title: "Bash",
        detail: "pwd",
        input: { command: "pwd" },
        data: expect.objectContaining({
          toolName: "bash",
          provider: { executed: true, metadata: { source: "betterc0de" } },
        }),
      })
    )
    expect(
      events.find(
        (event) =>
          event.type === "item.completed" &&
          (event.payload as { itemType?: string } | undefined)?.itemType ===
            "command_execution"
      )?.payload
    ).toEqual(
      expect.objectContaining({
        itemType: "command_execution",
        status: "completed",
        output: "/tmp/project",
        data: expect.objectContaining({
          structured: { exitCode: 0 },
          provider: { executed: true, metadata: { status: "done" } },
        }),
      })
    )
    expect(
      events.find((event) => event.type === "runtime.warning")?.payload
    ).toEqual({
      message: "rate limited",
      detail: {
        attempt: 2,
        message: "rate limited",
        statusCode: 429,
        isRetryable: true,
      },
    })
    expect(
      events.find(
        (event) =>
          event.type === "task.completed" &&
          (event.payload as { taskId?: string } | undefined)?.taskId ===
            "betterc0de-compaction:oc-session-1"
      )?.payload
    ).toEqual(
      expect.objectContaining({
        taskId: "betterc0de-compaction:oc-session-1",
        status: "completed",
        summary: "final summary",
      })
    )
    expect(events.find((event) => event.type === "token.usage")?.usage).toEqual(
      {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 33,
        reasoningOutputTokens: 3,
        cachedInputTokens: 9,
        cacheReadTokens: 4,
        cacheCreationTokens: 5,
        totalCostUsd: 0.01,
      }
    )

    unsubscribe()
    stream.close()
    await adapter.stopAll()
  })

  it("maps BetterC0de session diffs, todos, idle, and removed parts into canonical events", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    const events: Array<{ type: string; payload?: unknown; turnId?: string }> =
      []
    const unsubscribe = adapter.subscribe((event) => events.push(event))

    await adapter.startSession({
      threadId: "thread-session-events" as ThreadId,
      cwd: "/tmp/project",
    })
    await adapter.sendTurn({
      threadId: "thread-session-events" as ThreadId,
      message: "Update files",
      modelId: "openai/gpt-5",
      history: [],
    })

    stream.push({
      id: "evt-message",
      type: "message.updated",
      properties: {
        sessionID: "oc-session-1",
        info: { id: "assistant-1", role: "assistant" },
      },
    })
    stream.push({
      id: "evt-part",
      type: "message.part.updated",
      properties: {
        sessionID: "oc-session-1",
        time: Date.now(),
        part: {
          id: "part-removed",
          sessionID: "oc-session-1",
          messageID: "assistant-1",
          type: "text",
          text: "initial",
        },
      },
    })
    stream.push({
      id: "evt-part-removed",
      type: "message.part.removed",
      properties: {
        sessionID: "oc-session-1",
        messageID: "assistant-1",
        partID: "part-removed",
      },
    })
    stream.push({
      id: "evt-stale-delta",
      type: "message.part.delta",
      properties: {
        sessionID: "oc-session-1",
        messageID: "assistant-1",
        partID: "part-removed",
        field: "text",
        delta: " stale",
      },
    })
    stream.push({
      id: "evt-diff",
      type: "session.diff",
      properties: {
        sessionID: "oc-session-1",
        diff: [
          {
            file: "src/index.ts",
            patch:
              "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new",
            additions: 1,
            deletions: 1,
            status: "modified",
          },
        ],
      },
    })
    stream.push({
      id: "evt-todos",
      type: "todo.updated",
      properties: {
        sessionID: "oc-session-1",
        todos: [
          {
            content: "Inspect BetterC0de compatibility events",
            status: "completed",
            priority: "high",
          },
          {
            content: "Implement canonical mapping",
            status: "in_progress",
            priority: "medium",
          },
        ],
      },
    })
    stream.push({
      id: "evt-idle",
      type: "session.idle",
      properties: {
        sessionID: "oc-session-1",
      },
    })
    await flushAsync()

    expect(
      events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload)
    ).toEqual([{ streamKind: "assistant_text", delta: "initial" }])
    expect(
      events.find((event) => event.type === "turn.diff.updated")?.payload
    ).toEqual({
      unifiedDiff:
        "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new",
      files: [{ path: "src/index.ts", additions: 1, deletions: 1 }],
    })
    expect(
      events.find((event) => event.type === "turn.plan.updated")?.payload
    ).toEqual({
      explanation: "BetterC0de compatibility task list updated.",
      plan: [
        {
          step: "Inspect BetterC0de compatibility events",
          status: "completed",
        },
        { step: "Implement canonical mapping", status: "in_progress" },
      ],
    })
    expect(
      events.find((event) => event.type === "turn.completed")?.payload
    ).toEqual({ state: "completed" })

    unsubscribe()
    stream.close()
    await adapter.stopAll()
  })

  it("maps BetterC0de session lifecycle events into state, metadata, usage, and exit events", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de-main",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    const unsubscribe = adapter.subscribe((event) => events.push(event))

    await adapter.startSession({
      threadId: "thread-session-lifecycle" as ThreadId,
      cwd: "/tmp/project",
    })

    const info = {
      id: "oc-session-1",
      slug: "session-one",
      projectID: "project-1",
      directory: "/tmp/project",
      title: "Provider parity",
      agent: "build",
      model: { id: "gpt-5", providerID: "openai", variant: "high" },
      version: "1.2.3",
      time: { created: 1, updated: 2 },
    }
    stream.push({
      id: "evt-session-created",
      type: "session.created",
      properties: {
        sessionID: "oc-session-1",
        info,
      },
    })
    stream.push({
      id: "evt-session-updated",
      type: "session.updated",
      properties: {
        sessionID: "oc-session-1",
        info: {
          ...info,
          tokens: {
            input: 10,
            output: 20,
            reasoning: 3,
            cache: { read: 4, write: 5 },
          },
        },
      },
    })
    stream.push({
      id: "evt-session-deleted",
      type: "session.deleted",
      properties: {
        sessionID: "oc-session-1",
        info,
      },
    })
    await flushAsync()

    expect(
      events.find((event) => event.type === "session.state.changed")?.payload
    ).toEqual({
      state: "ready",
      reason: "BetterC0de session created.",
      detail: expect.objectContaining({
        sessionId: "oc-session-1",
        title: "Provider parity",
        agent: "build",
      }),
    })
    expect(
      events.find((event) => event.type === "thread.metadata.updated")?.payload
    ).toEqual({
      name: "Provider parity",
      metadata: {
        betterc0de: expect.objectContaining({
          sessionId: "oc-session-1",
          directory: "/tmp/project",
          version: "1.2.3",
        }),
      },
    })
    expect(
      events.find((event) => event.type === "thread.token-usage.updated")
        ?.payload
    ).toEqual({
      usage: {
        usedTokens: 33,
        inputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 3,
        cachedInputTokens: 9,
      },
    })
    expect(
      events.find((event) => event.type === "session.exited")?.payload
    ).toEqual({
      reason: "BetterC0de session deleted.",
      recoverable: false,
      exitKind: "graceful",
    })
    // A deleted session is forgotten, not merely flagged "stopped": the hub
    // sees no session and starts fresh, and a direct turn is refused instead
    // of being sent to a session the server no longer has.
    expect(adapter.hasSession("thread-session-lifecycle" as ThreadId)).toBe(
      false
    )
    await expect(
      adapter.sendTurn({
        threadId: "thread-session-lifecycle" as ThreadId,
        message: "again",
        modelId: "openai/gpt-5",
        history: [],
      })
    ).rejects.toThrow("BetterC0de session not found")

    unsubscribe()
    stream.close()
    await adapter.stopAll()
  })

  it("maps BetterC0de compatibility infrastructure events into metadata, task, warning, and file-change events", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de-main",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    const unsubscribe = adapter.subscribe((event) => events.push(event))

    await adapter.startSession({
      threadId: "thread-infra" as ThreadId,
      cwd: "/tmp/project",
    })

    stream.push({
      id: "evt-server-connected",
      type: "server.connected",
      properties: {},
    })
    stream.push({
      id: "evt-tui-prompt",
      type: "tui.prompt.append",
      properties: { text: "draft prompt" },
    })
    stream.push({
      id: "evt-tui-command",
      type: "tui.command.execute",
      properties: { command: "session.compact" },
    })
    stream.push({
      id: "evt-tui-toast",
      type: "tui.toast.show",
      properties: {
        title: "Saved",
        message: "BetterC0de compatibility state saved",
        variant: "success",
      },
    })
    stream.push({
      id: "evt-tui-select",
      type: "tui.session.select",
      properties: { sessionID: "oc-session-selected" },
    })
    stream.push({
      id: "evt-install-updated",
      type: "installation.updated",
      properties: { version: "1.2.3" },
    })
    stream.push({
      id: "evt-install-available",
      type: "installation.update-available",
      properties: { version: "1.2.4" },
    })
    stream.push({
      id: "evt-browser-failed",
      type: "mcp.browser.open.failed",
      properties: { mcpName: "playwright", url: "https://example.com" },
    })
    stream.push({
      id: "evt-file-edited",
      type: "file.edited",
      properties: { file: "/tmp/project/src/index.ts" },
    })
    stream.push({
      id: "evt-branch",
      type: "vcs.branch.updated",
      properties: { branch: "feature/betterc0de" },
    })
    stream.push({
      id: "evt-workspace-status",
      type: "workspace.status",
      properties: { workspaceID: "ws-1", status: "connecting" },
    })
    stream.push({
      id: "evt-workspace-ready",
      type: "workspace.ready",
      properties: { name: "preview" },
    })
    stream.push({
      id: "evt-worktree-failed",
      type: "worktree.failed",
      properties: { message: "branch checkout failed" },
    })
    stream.push({
      id: "evt-pty-created",
      type: "pty.created",
      properties: {
        info: {
          id: "pty-1",
          title: "Dev server",
          command: "npm",
          args: ["run", "dev"],
          cwd: "/tmp/project",
          status: "running",
          pid: 123,
        },
      },
    })
    stream.push({
      id: "evt-pty-exited",
      type: "pty.exited",
      properties: { id: "pty-1", exitCode: 1 },
    })
    stream.push({
      id: "evt-command",
      type: "command.executed",
      properties: {
        sessionID: "oc-session-1",
        name: "test",
        arguments: "backend",
        messageID: "message-command",
      },
    })
    await flushAsync()

    expect(
      events.find((event) => event.type === "provider.metadata.changed")
        ?.payload
    ).toEqual({
      providerKind: "betterc0de",
      providerInstanceId: "betterc0de-main",
      metadataKind: "all",
      summary: "BetterC0de compatibility installation updated to 1.2.3.",
      details: "1.2.3",
      cwd: "/tmp/project",
    })
    expect(
      events.find(
        (event) =>
          event.type === "task.progress" &&
          (event.payload as { taskId?: string } | undefined)?.taskId ===
            "betterc0de-tui-prompt"
      )?.payload
    ).toEqual({
      taskId: "betterc0de-tui-prompt",
      description: "BetterC0de compatibility TUI prompt updated.",
      summary: "draft prompt",
    })
    expect(
      events.find(
        (event) =>
          event.type === "task.completed" &&
          (event.payload as { taskId?: string } | undefined)?.taskId ===
            "betterc0de-tui-command:evt-tui-command"
      )?.payload
    ).toEqual({
      taskId: "betterc0de-tui-command:evt-tui-command",
      status: "completed",
      summary: "BetterC0de compatibility TUI command: session.compact",
    })
    expect(
      events.find(
        (event) =>
          event.type === "task.completed" &&
          (event.payload as { taskId?: string } | undefined)?.taskId ===
            "betterc0de-tui-toast:evt-tui-toast"
      )?.payload
    ).toEqual({
      taskId: "betterc0de-tui-toast:evt-tui-toast",
      status: "completed",
      summary: "Saved: BetterC0de compatibility state saved",
    })
    expect(
      events.find(
        (event) =>
          event.type === "session.configured" &&
          (event.payload as { config?: { selectedSession?: string } })?.config
            ?.selectedSession === "oc-session-selected"
      )?.payload
    ).toEqual({ config: { selectedSession: "oc-session-selected" } })
    expect(
      events.find(
        (event) =>
          event.type === "runtime.warning" &&
          (
            event.payload as { message?: string } | undefined
          )?.message?.includes("1.2.4")
      )?.payload
    ).toEqual({
      message: "BetterC0de compatibility 1.2.4 is available.",
      detail: { version: "1.2.4" },
    })
    expect(
      events.find(
        (event) =>
          event.type === "runtime.warning" &&
          (
            event.payload as { message?: string } | undefined
          )?.message?.includes("MCP browser")
      )?.payload
    ).toEqual({
      message:
        "BetterC0de compatibility MCP browser open failed for playwright.",
      detail: { mcpName: "playwright", url: "https://example.com" },
    })
    expect(
      events.find(
        (event) =>
          event.type === "item.completed" &&
          (event.payload as { itemType?: string } | undefined)?.itemType ===
            "file_change"
      )?.payload
    ).toEqual(
      expect.objectContaining({
        itemType: "file_change",
        status: "completed",
        title: "File edited",
        detail: "/tmp/project/src/index.ts",
      })
    )
    expect(
      events.find(
        (event) =>
          event.type === "session.configured" &&
          (event.payload as { config?: { vcs?: { branch?: string } } })?.config
            ?.vcs?.branch === "feature/betterc0de"
      )?.payload
    ).toEqual({ config: { vcs: { branch: "feature/betterc0de" } } })
    expect(
      events.find(
        (event) =>
          event.type === "task.progress" &&
          (event.payload as { taskId?: string } | undefined)?.taskId ===
            "betterc0de-workspace:ws-1"
      )?.payload
    ).toEqual({
      taskId: "betterc0de-workspace:ws-1",
      description: "BetterC0de compatibility workspace connecting.",
      summary: "connecting",
    })
    expect(
      events.find(
        (event) =>
          event.type === "task.completed" &&
          (event.payload as { taskId?: string } | undefined)?.taskId ===
            "betterc0de-workspace:preview"
      )?.payload
    ).toEqual({
      taskId: "betterc0de-workspace:preview",
      status: "completed",
      summary: "BetterC0de compatibility workspace preview is ready.",
    })
    expect(
      events.find((event) => event.type === "runtime.error")?.payload
    ).toEqual({
      message: "branch checkout failed",
      class: "provider_error",
      detail: { message: "branch checkout failed" },
    })
    expect(
      events.find(
        (event) =>
          event.type === "task.started" &&
          (event.payload as { taskId?: string } | undefined)?.taskId ===
            "betterc0de-pty:pty-1"
      )?.payload
    ).toEqual({
      taskId: "betterc0de-pty:pty-1",
      taskType: "pty",
      description: "Dev server: npm run dev (running)",
    })
    expect(
      events.find(
        (event) =>
          event.type === "task.completed" &&
          (event.payload as { taskId?: string; status?: string } | undefined)
            ?.taskId === "betterc0de-pty:pty-1"
      )?.payload
    ).toEqual({
      taskId: "betterc0de-pty:pty-1",
      status: "failed",
      summary: "BetterC0de compatibility PTY exited with code 1.",
    })
    expect(
      events.find(
        (event) =>
          event.type === "item.completed" &&
          (event.payload as { itemType?: string; title?: string } | undefined)
            ?.title === "/test"
      )?.payload
    ).toEqual(
      expect.objectContaining({
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "/test",
        detail: "backend",
      })
    )

    unsubscribe()
    stream.close()
    await adapter.stopAll()
  })

  it("emits metadata invalidation when BetterC0de compatibility reports catalog updates", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de-main",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    const unsubscribe = adapter.subscribe((event) => events.push(event))

    await adapter.startSession({
      threadId: "thread-catalog" as ThreadId,
      cwd: "/tmp/project",
    })
    stream.push({
      id: "evt-catalog",
      type: "catalog.model.updated",
      properties: {
        model: {
          id: "gpt-5",
          apiID: "responses",
          providerID: "openai",
          name: "GPT-5",
          endpoint: { type: "aisdk", package: "@ai-sdk/openai" },
          variants: [],
          time: { released: Date.UTC(2026, 0, 1) },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 1_000_000, output: 32_000 },
        },
      },
    })
    await flushAsync()

    expect(
      events.find((event) => event.type === "provider.metadata.changed")
        ?.payload
    ).toEqual({
      providerKind: "betterc0de",
      providerInstanceId: "betterc0de-main",
      metadataKind: "models",
      summary: "BetterC0de model catalog changed.",
      cwd: "/tmp/project",
    })

    unsubscribe()
    stream.close()
    await adapter.stopAll()
  })

  it("emits tool metadata invalidation when BetterC0de compatibility reports MCP tool changes", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de-main",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    const unsubscribe = adapter.subscribe((event) => events.push(event))

    await adapter.startSession({
      threadId: "thread-tools" as ThreadId,
      cwd: "/tmp/project",
    })
    stream.push({
      id: "evt-mcp-tools",
      type: "mcp.tools.changed",
      properties: {
        server: "playwright",
      },
    })
    await flushAsync()

    expect(
      events.find((event) => event.type === "provider.metadata.changed")
        ?.payload
    ).toEqual({
      providerKind: "betterc0de",
      providerInstanceId: "betterc0de-main",
      metadataKind: "tools",
      summary: "BetterC0de compatibility MCP tools changed.",
      details: "playwright",
      cwd: "/tmp/project",
    })

    unsubscribe()
    stream.close()
    await adapter.stopAll()
  })

  it("invalidates BetterC0de compatibility metadata when watched config, skills, commands, or project metadata changes", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    const adapter = new BetterC0deCompatAdapter({
      providerInstanceId: "betterc0de-main",
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })
    const events: Array<{ type: string; payload?: unknown }> = []
    const unsubscribe = adapter.subscribe((event) => events.push(event))

    await adapter.startSession({
      threadId: "thread-watcher" as ThreadId,
      cwd: "/tmp/project",
    })

    const metadataPayloads = () =>
      events
        .filter((event) => event.type === "provider.metadata.changed")
        .map((event) => event.payload)

    stream.push({
      id: "evt-source-file",
      type: "file.watcher.updated",
      properties: {
        file: "/tmp/project/src/index.ts",
        event: "change",
      },
    })
    await flushAsync()
    expect(metadataPayloads()).toEqual([])

    stream.push({
      id: "evt-command-file",
      type: "file.watcher.updated",
      properties: {
        file: "/tmp/project/commands/frontend.md",
        event: "change",
      },
    })
    await flushAsync()
    expect(metadataPayloads().at(-1)).toEqual({
      providerKind: "betterc0de",
      providerInstanceId: "betterc0de-main",
      metadataKind: "slashCommands",
      summary: "BetterC0de compatibility slash commands changed.",
      details: "/tmp/project/commands/frontend.md",
      cwd: "/tmp/project",
    })

    stream.push({
      id: "evt-skill-file",
      type: "file.watcher.updated",
      properties: {
        file: "/tmp/project/.agents/skills/frontend/SKILL.md",
        event: "add",
      },
    })
    await flushAsync()
    expect(metadataPayloads().at(-1)).toEqual({
      providerKind: "betterc0de",
      providerInstanceId: "betterc0de-main",
      metadataKind: "skills",
      summary: "BetterC0de compatibility skills added.",
      details: "/tmp/project/.agents/skills/frontend/SKILL.md",
      cwd: "/tmp/project",
    })

    stream.push({
      id: "evt-config-file",
      type: "file.watcher.updated",
      properties: {
        file: "/tmp/project/betterc0de.jsonc",
        event: "change",
      },
    })
    await flushAsync()
    expect(metadataPayloads().at(-1)).toEqual({
      providerKind: "betterc0de",
      providerInstanceId: "betterc0de-main",
      metadataKind: "all",
      summary: "BetterC0de compatibility configuration changed.",
      details: "/tmp/project/betterc0de.jsonc",
      cwd: "/tmp/project",
    })

    stream.push({
      id: "evt-project",
      type: "project.updated",
      properties: {
        id: "project-1",
        worktree: "/tmp/project",
        commands: { start: "npm run dev" },
      },
    })
    await flushAsync()
    expect(metadataPayloads().at(-1)).toEqual({
      providerKind: "betterc0de",
      providerInstanceId: "betterc0de-main",
      metadataKind: "all",
      summary: "BetterC0de project metadata changed.",
      details: "/tmp/project",
      cwd: "/tmp/project",
    })

    const countBeforeOtherProject = metadataPayloads().length
    stream.push({
      id: "evt-other-project",
      type: "project.updated",
      properties: {
        id: "project-2",
        worktree: "/tmp/other-project",
      },
    })
    await flushAsync()
    expect(metadataPayloads()).toHaveLength(countBeforeOtherProject)

    unsubscribe()
    stream.close()
    await adapter.stopAll()
  })

  it("loads BetterC0de provider catalog, models, skills, and slash commands from provider inventory", async () => {
    const stream = createPushStream<unknown>()
    const client = createFakeClient({ stream: stream.stream })
    client.provider.list.mockResolvedValue({
      data: {
        connected: ["openai"],
        all: [
          {
            id: "openai",
            name: "OpenAI",
            source: "env",
            env: [],
            options: {},
            models: {
              "gpt-5": {
                id: "gpt-5",
                providerID: "openai",
                api: { id: "openai", url: "", npm: "" },
                name: "GPT-5",
                capabilities: {},
                cost: {},
                limit: { context: 1_000_000, output: 16_000 },
                status: "active",
                options: {},
                headers: {},
                release_date: "2026-01-01",
                variants: { medium: {}, high: {} },
              },
            },
          },
        ],
      },
    })
    client.v2.provider.list.mockResolvedValue({
      data: [
        {
          id: "openai",
          name: "OpenAI",
          enabled: { via: "env", name: "OPENAI_API_KEY" },
          env: ["OPENAI_API_KEY"],
          endpoint: {
            type: "aisdk",
            package: "@ai-sdk/openai",
            url: "https://api.openai.com/v1",
          },
        },
      ],
    })
    client.v2.model.list.mockResolvedValue({
      data: [
        {
          id: "gpt-5",
          apiID: "responses",
          providerID: "openai",
          name: "GPT-5 v2",
          endpoint: {
            type: "aisdk",
            package: "@ai-sdk/openai",
            url: "https://api.openai.com/v1",
          },
          capabilities: {
            attachment: true,
            tools: true,
            input: ["text", "image"],
            output: ["text"],
          },
          options: {
            headers: {},
            body: {},
            aisdk: { provider: {}, request: {} },
          },
          variants: [{ id: "medium" }, { id: "high" }, { id: "max" }],
          time: { released: Date.UTC(2026, 0, 1) },
          cost: [
            {
              input: 2,
              output: 8,
              cache: { read: 0.5, write: 1 },
            },
          ],
          status: "active",
          enabled: true,
          limit: { context: 1_000_000, input: 256_000, output: 32_000 },
        },
      ],
    })
    client.app.agents.mockResolvedValue({
      data: [
        {
          name: "build",
          mode: "primary",
          hidden: false,
          permission: [],
          options: {},
        },
      ],
    })
    client.app.skills.mockResolvedValue({
      data: [
        {
          name: "review",
          description: "Review code",
          location: "/skills/review",
          content: "",
        },
      ],
    })
    client.command.list.mockResolvedValue({
      data: [{ name: "test", description: "Run tests", hints: ["scope"] }],
    })
    client.tool.ids.mockResolvedValue({
      data: ["bash", "task", "task_status", "bash"],
    })
    client.tool.list.mockResolvedValue({
      data: [
        {
          id: "bash",
          description: "Run shell commands",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
        {
          id: "task",
          description: "Launch a subagent",
          parameters: {
            type: "object",
            properties: { subagent_type: { type: "string" } },
          },
        },
      ],
    })
    const adapter = new BetterC0deCompatAdapter({
      serverUrl: "http://127.0.0.1:4096",
      clientFactory: (() => client) as never,
      serverConnector: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      })),
    })

    await expect(adapter.availableModels()).resolves.toEqual([
      expect.objectContaining({
        slug: "openai/gpt-5",
        name: "GPT-5 v2",
        subProvider: "OpenAI",
        context: "1M",
        catalog: expect.objectContaining({
          providerId: "openai",
          modelId: "gpt-5",
          api: {
            id: "responses",
            package: "@ai-sdk/openai",
            url: "https://api.openai.com/v1",
          },
          releaseDate: "2026-01-01T00:00:00.000Z",
          status: "active",
          limit: { context: 1_000_000, input: 256_000, output: 32_000 },
          cost: { input: 2, output: 8, cache: { read: 0.5, write: 1 } },
          variants: {
            medium: {},
            high: {},
            max: {},
          },
        }),
        capabilities: expect.objectContaining({
          attachment: true,
          optionDescriptors: expect.arrayContaining([
            expect.objectContaining({ id: "variant", currentValue: "medium" }),
            expect.objectContaining({ id: "agent", currentValue: "build" }),
          ]),
        }),
      }),
    ])
    await expect(
      adapter.availableProviderCatalog({ cwd: "/tmp/project" })
    ).resolves.toEqual([
      {
        id: "openai",
        name: "OpenAI",
        source: "env",
        connected: true,
        enabled: true,
        enabledVia: "env",
        env: ["OPENAI_API_KEY"],
        endpoint: {
          type: "aisdk",
          package: "@ai-sdk/openai",
          url: "https://api.openai.com/v1",
        },
        modelCount: 1,
      },
    ])
    await expect(
      adapter.availableSkills({ cwd: "/tmp/project" })
    ).resolves.toEqual([
      expect.objectContaining({
        name: "review",
        path: "/skills/review",
        enabled: true,
      }),
    ])
    await expect(
      adapter.availableAgents({ cwd: "/tmp/project" })
    ).resolves.toEqual([
      expect.objectContaining({
        name: "build",
        displayName: "Build",
        mode: "primary",
        hidden: false,
      }),
    ])
    await expect(
      adapter.availableTools({ cwd: "/tmp/project" })
    ).resolves.toEqual([
      {
        id: "bash",
        displayName: "Bash",
        description: "Run shell commands",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        id: "task",
        displayName: "Task",
        description: "Launch a subagent",
        parameters: {
          type: "object",
          properties: { subagent_type: { type: "string" } },
        },
      },
      { id: "task_status", displayName: "Task Status" },
    ])
    expect(client.tool.list).toHaveBeenCalledWith({
      directory: "/tmp/project",
      provider: "openai",
      model: "gpt-5",
    })
    await expect(
      adapter.availableSlashCommands({ cwd: "/tmp/project" })
    ).resolves.toEqual([
      expect.objectContaining({
        name: "test",
        input: { hint: "scope" },
      }),
    ])

    stream.close()
  })
})

function createFakeClient(input: { readonly stream: AsyncIterable<unknown> }) {
  const asyncMock = (value: unknown) =>
    vi.fn(async (): Promise<unknown> => value)

  return {
    session: {
      create: asyncMock({ data: { id: "oc-session-1" } }),
      promptAsync: asyncMock({ data: {} }),
      abort: asyncMock({ data: true }),
      messages: asyncMock({ data: [] }),
      revert: asyncMock({ data: true }),
    },
    event: {
      subscribe: asyncMock({ stream: input.stream }),
    },
    permission: {
      reply: asyncMock({ data: true }),
    },
    question: {
      reply: asyncMock({ data: true }),
      reject: asyncMock({ data: true }),
    },
    provider: {
      list: asyncMock({ data: { all: [], connected: [] } }),
    },
    v2: {
      model: {
        list: asyncMock({ data: [] }),
      },
      provider: {
        list: asyncMock({ data: [] }),
      },
    },
    app: {
      agents: asyncMock({ data: [] }),
      skills: asyncMock({ data: [] }),
    },
    command: {
      list: asyncMock({ data: [] }),
    },
    tool: {
      list: asyncMock({ data: [] }),
      ids: asyncMock({ data: [] }),
    },
  }
}

function createPushStream<T>() {
  const values: T[] = []
  const waiters: Array<(value: IteratorResult<T>) => void> = []
  let closed = false

  return {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = values.shift()
            if (value !== undefined) {
              return Promise.resolve({ value, done: false })
            }
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => waiters.push(resolve))
          },
        }
      },
    },
    push(value: T) {
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else values.push(value)
    },
    close() {
      closed = true
      for (const waiter of waiters.splice(0)) {
        waiter({ value: undefined, done: true })
      }
    },
  }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}
