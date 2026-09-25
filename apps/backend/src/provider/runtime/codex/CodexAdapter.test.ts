import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CODEX_CLI_DEFAULT_MODEL_ID,
  CodexAdapter,
  nativeCodexModelId,
  parseCodexModelListResponse,
} from "./CodexAdapter"
import { CodexSessionRuntime } from "./CodexSessionRuntime"
import { CodexRpcClient } from "./rpc"
import type { ThreadId } from "../contracts"

const tempRoots: string[] = []
const sessionAdapters: CodexAdapter[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

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

function makeFakeCodexBinary(): {
  readonly dir: string
  readonly binaryPath: string
} {
  const dir = makeTempDir("betterc0de fake codex models-")
  const binaryPath = path.join(dir, "fake-codex.cjs")
  fs.writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const readline = require("node:readline");
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line) return;
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  if (message.version !== 2) {
    sendError(message.id, -32600, "missing app-server protocol version");
    return;
  }
  if (message.method === "initialize") {
    send(message.id, { userAgent: "codex/9.9.9" });
    return;
  }
  if (message.method === "account/read") {
    if (!message.params || message.params.refreshToken !== false) {
      sendError(message.id, -32602, "account/read requires refreshToken");
      return;
    }
    if (process.env.FAKE_CODEX_UNAUTH === "1") {
      send(message.id, { account: null, requiresOpenaiAuth: true });
      return;
    }
    send(message.id, {
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    });
    return;
  }
  if (message.method === "model/list") {
    if (message.params && message.params.cursor === "page-2") {
      send(message.id, {
        data: [
          {
            model: "gpt-second",
            displayName: "gpt-second",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
            defaultReasoningEffort: "medium",
            additionalSpeedTiers: [],
          },
        ],
      });
      return;
    }
    send(message.id, {
      data: [
        {
          model: "gpt-live",
          displayName: "gpt-live",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "xhigh" },
            {
              reasoningEffort: "max",
              description: "Maximum reasoning from live metadata",
            },
            { reasoningEffort: "ultra" },
          ],
          defaultReasoningEffort: "xhigh",
          additionalSpeedTiers: ["fast"],
        },
      ],
      nextCursor: "page-2",
    });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send(message.id, { thread: { id: "fake-thread-1" } });
    return;
  }
  if (message.method === "skills/list") {
    const cwd = message.params && Array.isArray(message.params.cwds) ? message.params.cwds[0] : process.cwd();
    if (typeof cwd === "string" && cwd.includes("no-matching-cwd")) {
      send(message.id, {
        data: [
          {
            cwd: "/other/repo",
            skills: [
              {
                name: "fallback-review",
                path: "/skills/fallback-review/SKILL.md",
                enabled: true,
                description: "Review from fallback cwd",
              },
            ],
          },
          {
            cwd: "/another/repo",
            skills: [
              {
                name: "fallback-tests",
                path: "/skills/fallback-tests/SKILL.md",
                enabled: false,
                scope: "project",
              },
            ],
          },
        ],
      });
      return;
    }
    send(message.id, {
      data: [
        {
          cwd,
          skills: [
            {
              name: "review-follow-up",
              path: "/skills/review-follow-up/SKILL.md",
              enabled: true,
              description: "Review follow-up details",
              scope: "user",
              interface: {
                displayName: "Review Follow-up",
                shortDescription: "Inspect review comments",
              },
            },
            {
              name: "disabled-skill",
              path: "/skills/disabled-skill/SKILL.md",
              enabled: false,
              shortDescription: "Top-level short description wins",
              interface: {
                displayName: "Disabled Skill",
                shortDescription: "Interface short description",
              },
            },
            {
              name: "",
              path: "/skills/ignored/SKILL.md",
              enabled: true,
            },
          ],
        },
        {
          cwd: "/other/repo",
          skills: [
            {
              name: "other-repo-skill",
              path: "/skills/other-repo-skill/SKILL.md",
              enabled: true,
            },
          ],
        },
      ],
    });
    return;
  }
  send(message.id, {});
});
`,
    "utf8"
  )
  return { dir, binaryPath: platformNodeCliPath(binaryPath) }
}

function makeExitingCodexBinary(): {
  readonly dir: string
  readonly binaryPath: string
} {
  const dir = makeTempDir("betterc0de-exiting-codex-")
  const binaryPath = path.join(dir, "exiting-codex.cjs")
  fs.writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
process.exit(0);
`,
    "utf8"
  )
  return { dir, binaryPath: platformNodeCliPath(binaryPath) }
}

function makeUnexpectedExitCodexBinary(): {
  readonly dir: string
  readonly binaryPath: string
} {
  const dir = makeTempDir("betterc0de-unexpected-exit-codex-")
  const binaryPath = path.join(dir, "unexpected-exit-codex.cjs")
  fs.writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const readline = require("node:readline");
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line) return;
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  if (message.method === "initialize") {
    send(message.id, { userAgent: "codex/9.9.9" });
    return;
  }
  if (message.method === "thread/start") {
    send(message.id, { thread: { id: "unexpected-provider-thread" } });
    setTimeout(() => process.exit(23), 50);
    return;
  }
  send(message.id, {});
});
`,
    "utf8"
  )
  return { dir, binaryPath: platformNodeCliPath(binaryPath) }
}

function makeFakeCodexSessionBinary(): {
  readonly dir: string
  readonly binaryPath: string
  readonly logPath: string
} {
  const dir = makeTempDir("betterc0de-fake-codex-session-")
  const binaryPath = path.join(dir, "fake-codex-session.cjs")
  const logPath = path.join(dir, "rpc.log")
  fs.writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = process.env.FAKE_CODEX_LOG;
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function log(message) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(message) + "\\n", "utf8");
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line) return;
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  log({ method: message.method, params: message.params ?? {} });
  if (message.method === "initialize") {
    send(message.id, { userAgent: "codex/9.9.9" });
    return;
  }
  if (message.method === "thread/start") {
    send(message.id, { thread: { id: "provider-thread-1" } });
    return;
  }
  if (message.method === "turn/start") {
    send(message.id, { turn: { id: "turn-1" } });
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "item/output/textDelta",
      params: {
        threadId: "provider-thread-1",
        turnId: "turn-1",
        delta: "hi",
      },
    }) + "\\n");
    return;
  }
  send(message.id, {});
});
`,
    "utf8"
  )
  return { dir, binaryPath: platformNodeCliPath(binaryPath), logPath }
}

function readRpcLog(
  logPath: string
): Array<{ method: string; params: Record<string, unknown> }> {
  if (!fs.existsSync(logPath)) return []
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { method: string; params: Record<string, unknown> }
    )
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500
): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition was not met before timeout")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  await Promise.allSettled(
    sessionAdapters.splice(0).map((adapter) => adapter.stopAll())
  )
  while (tempRoots.length > 0) {
    // fs.rmSync ignores maxRetries/retryDelay for EBUSY on Windows (Node 22):
    // it throws at once while a just-killed fake CLI still holds the directory
    // as its working directory. fs.promises.rm retries as configured.
    await fs.promises.rm(tempRoots.pop()!, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    })
  }
})

describe("CodexAdapter", () => {
  it.each([false, true])(
    "cleans up startup when thread persistence fails (cleanup retry: %s)",
    async (retryCleanup) => {
      const fake = makeFakeCodexBinary()
      const persistFailure = new Error("binding write failed")
      const cleanupFailure = new Error("runtime close failed")
      const originalClose = CodexSessionRuntime.prototype.close
      const startSpy = vi.spyOn(CodexSessionRuntime.prototype, "start")
      const closeSpy = vi.spyOn(CodexSessionRuntime.prototype, "close")
      if (retryCleanup) {
        closeSpy.mockImplementationOnce(async function (
          this: CodexSessionRuntime
        ) {
          await originalClose.call(this)
          throw cleanupFailure
        })
      }
      const adapter = new CodexAdapter({
        providerInstanceId: "codex",
        continuationKey: "codex",
        binaryPath: fake.binaryPath,
        clientInfo: { name: "test", title: "Test", version: "0.0.0" },
        getStoredProviderThreadId: () => null,
        persistProviderThreadId: () => {
          throw persistFailure
        },
      })
      sessionAdapters.push(adapter)
      try {
        const startup = adapter.startSession({
          threadId: "failed-binding" as ThreadId,
          cwd: fake.dir,
        })
        if (retryCleanup) {
          await expect(startup).rejects.toMatchObject({
            code: "CODEX_STARTUP_CLEANUP_FAILED",
            errors: [persistFailure, cleanupFailure],
          })
        } else {
          await expect(startup).rejects.toBe(persistFailure)
        }
        expect(closeSpy).toHaveBeenCalledTimes(1)
        expect(await adapter.listSessions()).toEqual([])
        await adapter.stopAll()
        expect(closeSpy).toHaveBeenCalledTimes(retryCleanup ? 2 : 1)
      } finally {
        for (const runtime of startSpy.mock.contexts)
          await originalClose.call(runtime)
        startSpy.mockRestore()
        closeSpy.mockRestore()
      }
    }
  )

  it.each([
    { cursorMode: "repeated", maxRequests: 2 },
    { cursorMode: "unending", maxRequests: 100 },
  ])(
    "stops a model probe with $cursorMode pagination cursors",
    async ({ cursorMode, maxRequests }) => {
      const fake = makeFakeCodexBinary()
      const originalCall = CodexRpcClient.prototype.call
      let modelRequests = 0
      const callSpy = vi
        .spyOn(CodexRpcClient.prototype, "call")
        .mockImplementation(function (
          this: CodexRpcClient,
          method,
          params,
          timeoutMs
        ) {
          if (method !== "model/list")
            return originalCall.call(this, method, params, timeoutMs)
          modelRequests += 1
          if (modelRequests > maxRequests)
            return Promise.reject(
              new Error("test prevents unbounded pagination")
            )
          return Promise.resolve({
            data: [{ model: "repeated-model" }],
            nextCursor:
              cursorMode === "repeated"
                ? "same-cursor"
                : `cursor-${modelRequests}`,
          })
        })
      const closeSpy = vi.spyOn(CodexRpcClient.prototype, "close")
      const adapter = new CodexAdapter({
        providerInstanceId: "codex",
        continuationKey: "codex",
        binaryPath: fake.binaryPath,
        clientInfo: { name: "test", title: "Test", version: "0.0.0" },
        getStoredProviderThreadId: () => null,
        persistProviderThreadId: () => {},
      })
      sessionAdapters.push(adapter)
      try {
        expect(await adapter.availableModels()).toEqual([])
        expect(modelRequests).toBe(maxRequests)
        expect(closeSpy).toHaveBeenCalledTimes(1)
      } finally {
        callSpy.mockRestore()
        closeSpy.mockRestore()
      }
    }
  )

  it("keeps prototype-named live reasoning efforts as string labels", () => {
    const models = parseCodexModelListResponse({
      data: [
        {
          model: "custom-model",
          supportedReasoningEfforts: ["constructor", "__proto__", "toString"],
        },
      ],
    })
    expect(models[0].capabilities?.optionDescriptors?.[0]).toMatchObject({
      options: [
        { id: "constructor", label: "constructor" },
        { id: "__proto__", label: "__proto__" },
        { id: "toString", label: "toString" },
      ],
    })
  })

  it("detects orchestration capability changes without restarting unchanged sessions", async () => {
    const fake = makeFakeCodexBinary()
    let enabled = false
    const descriptor = {
      type: "http" as const,
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer team" },
    }
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      clientInfo: { name: "test", title: "Test", version: "0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
      resolveOrchestratorServer: async () => (enabled ? descriptor : null),
    })
    sessionAdapters.push(adapter)
    const input = { threadId: "existing" as ThreadId, cwd: fake.dir }
    await adapter.startSession(input)
    expect(await adapter.needsSessionConfigurationRefresh(input)).toBe(false)
    enabled = true
    expect(await adapter.needsSessionConfigurationRefresh(input)).toBe(true)
    await adapter.stopSession(input.threadId)
    await adapter.startSession({
      ...input,
      resumeCursor: { providerThreadId: "fake-thread-1" },
    })
    expect(await adapter.needsSessionConfigurationRefresh(input)).toBe(false)
    enabled = false
    expect(await adapter.needsSessionConfigurationRefresh(input)).toBe(true)
  })
  it("retains failed probe cleanup and blocks session starts until retry succeeds", async () => {
    const fake = makeFakeCodexBinary()
    const cleanupFailure = new Error("probe close failed")
    const originalClose = CodexRpcClient.prototype.close
    const closeSpy = vi
      .spyOn(CodexRpcClient.prototype, "close")
      .mockImplementationOnce(async function (this: CodexRpcClient) {
        await originalClose.call(this)
        throw cleanupFailure
      })
      .mockImplementationOnce(async function (this: CodexRpcClient) {
        await originalClose.call(this)
        throw cleanupFailure
      })
      .mockImplementation(async function (this: CodexRpcClient) {
        await originalClose.call(this)
      })
    const startSpy = vi.spyOn(CodexSessionRuntime.prototype, "start")
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    sessionAdapters.push(adapter)

    try {
      await expect(adapter.probeStatus({ cwd: fake.dir })).rejects.toBe(
        cleanupFailure
      )
      const quarantines = (
        adapter as unknown as {
          probeCleanupQuarantines: Map<unknown, unknown>
        }
      ).probeCleanupQuarantines
      expect(quarantines.size).toBe(1)

      await expect(
        adapter.startSession({
          threadId: "blocked-by-probe" as ThreadId,
          cwd: fake.dir,
        })
      ).rejects.toMatchObject({
        code: "CODEX_STARTUP_CLEANUP_QUARANTINED",
        statusCode: 503,
      })
      expect(startSpy).not.toHaveBeenCalled()

      await expect(adapter.stopAll()).resolves.toBeUndefined()
      expect(closeSpy).toHaveBeenCalledTimes(3)
      expect(quarantines.size).toBe(0)
    } finally {
      startSpy.mockRestore()
      closeSpy.mockRestore()
    }
  })

  it("allows only one startup at a time so cleanup survivors stay bounded", async () => {
    const startFailure = new Error("first startup failed")
    let rejectStart: ((error: Error) => void) | undefined
    const startSpy = vi
      .spyOn(CodexSessionRuntime.prototype, "start")
      .mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectStart = reject
          })
      )
    const closeSpy = vi
      .spyOn(CodexSessionRuntime.prototype, "close")
      .mockResolvedValue(undefined)
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: "codex",
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    sessionAdapters.push(adapter)

    try {
      const first = adapter.startSession({
        threadId: "first-start" as ThreadId,
        cwd: process.cwd(),
      })
      await waitFor(() => startSpy.mock.calls.length === 1)

      await expect(
        adapter.startSession({
          threadId: "concurrent-start" as ThreadId,
          cwd: process.cwd(),
        })
      ).rejects.toMatchObject({
        code: "CODEX_STARTUP_IN_PROGRESS",
        statusCode: 503,
      })
      expect(startSpy).toHaveBeenCalledTimes(1)

      rejectStart?.(startFailure)
      await expect(first).rejects.toBe(startFailure)
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      startSpy.mockRestore()
      closeSpy.mockRestore()
    }
  })

  it("retains and retries cleanup when a failed startup runtime survives", async () => {
    const startFailure = new Error("runtime start failed")
    const cleanupFailure = new Error("startup runtime close failed")
    const startSpy = vi
      .spyOn(CodexSessionRuntime.prototype, "start")
      .mockRejectedValue(startFailure)
    const closeSpy = vi
      .spyOn(CodexSessionRuntime.prototype, "close")
      .mockRejectedValueOnce(cleanupFailure)
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: "codex",
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    sessionAdapters.push(adapter)

    try {
      await expect(
        adapter.startSession({
          threadId: "failed-start" as ThreadId,
          cwd: process.cwd(),
        })
      ).rejects.toMatchObject({
        name: "AggregateError",
        code: "CODEX_STARTUP_CLEANUP_FAILED",
        statusCode: 503,
        errors: [startFailure, cleanupFailure],
      })
      const quarantines = (
        adapter as unknown as {
          startupCleanupQuarantines: Map<string, Set<unknown>>
        }
      ).startupCleanupQuarantines
      expect(quarantines.get("failed-start")?.size).toBe(1)

      await expect(
        adapter.startSession({
          threadId: "different-thread" as ThreadId,
          cwd: process.cwd(),
        })
      ).rejects.toMatchObject({
        code: "CODEX_STARTUP_CLEANUP_QUARANTINED",
        statusCode: 503,
      })
      expect(startSpy).toHaveBeenCalledTimes(1)
      expect(quarantines.get("failed-start")?.size).toBe(1)

      await expect(adapter.stopAll()).resolves.toBeUndefined()
      expect(closeSpy).toHaveBeenCalledTimes(3)
      expect(quarantines.has("failed-start")).toBe(false)
    } finally {
      startSpy.mockRestore()
      closeSpy.mockRestore()
    }
  })

  it("retains and retries a failed close after an unexpected runtime exit", async () => {
    const fake = makeUnexpectedExitCodexBinary()
    const closeFailure = new Error("runtime close failed")
    const closeSpy = vi
      .spyOn(CodexSessionRuntime.prototype, "close")
      .mockRejectedValueOnce(closeFailure)
      .mockRejectedValueOnce(closeFailure)
      .mockResolvedValueOnce(undefined)
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    sessionAdapters.push(adapter)

    try {
      await adapter.startSession({
        threadId: "unexpected-exit" as ThreadId,
        cwd: fake.dir,
      })
      await waitFor(() => closeSpy.mock.calls.length >= 1, 2_000)
      const sessions = (
        adapter as unknown as { sessions: Map<string, unknown> }
      ).sessions
      expect(sessions.has("unexpected-exit")).toBe(true)
      expect(adapter.hasSession("unexpected-exit" as ThreadId)).toBe(false)

      await expect(
        adapter.startSession({
          threadId: "unexpected-exit" as ThreadId,
          cwd: fake.dir,
        })
      ).rejects.toMatchObject({
        code: "CODEX_SESSION_CLEANUP_QUARANTINED",
        statusCode: 503,
      })
      expect(sessions.has("unexpected-exit")).toBe(true)

      await expect(adapter.stopAll()).resolves.toBeUndefined()
      expect(closeSpy).toHaveBeenCalledTimes(3)
      expect(sessions.has("unexpected-exit")).toBe(false)
    } finally {
      closeSpy.mockRestore()
    }
  })

  it("aggregates stopAll failures after attempting every session", async () => {
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: "codex",
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    const sessions = (adapter as unknown as { sessions: Map<string, unknown> })
      .sessions
    sessions.set("thread-stop-a", {})
    sessions.set("thread-stop-b", {})
    const failure = new Error("stop failed")
    const stopSession = vi
      .spyOn(adapter, "stopSession")
      .mockImplementation(async (threadId) => {
        if (threadId === ("thread-stop-a" as ThreadId)) throw failure
      })

    await expect(adapter.stopAll()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [failure],
    })
    expect(stopSession).toHaveBeenCalledTimes(2)
  })

  it("probes Codex app-server account status and exposes ChatGPT auth metadata", async () => {
    const fake = makeFakeCodexBinary()
    expect(fake.binaryPath).toContain(" ")
    const repoPath = makeTempDir("betterc0de-codex-repo-")
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    await expect(adapter.probeStatus({ cwd: repoPath })).resolves.toEqual({
      configured: true,
      installed: true,
      version: "9.9.9",
      status: "ready",
      auth: {
        status: "authenticated",
        type: "chatgpt",
        label: "ChatGPT Pro 20x Subscription",
        email: "user@example.com",
      },
    })
  })

  it("reports BetterC0de Codex unauthenticated app-server status", async () => {
    const fake = makeFakeCodexBinary()
    const repoPath = makeTempDir("betterc0de-codex-repo-")
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      environment: [{ name: "FAKE_CODEX_UNAUTH", value: "1" }],
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    await expect(adapter.probeStatus({ cwd: repoPath })).resolves.toEqual({
      configured: false,
      installed: true,
      version: "9.9.9",
      status: "error",
      auth: { status: "unauthenticated" },
      message:
        "Codex CLI is not authenticated. Run `codex login` and try again.",
    })
  })

  it("reports Codex as missing for a configured path that does not exist", async () => {
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: path.join(
        makeTempDir("betterc0de missing codex-"),
        "missing-codex.cmd"
      ),
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    await expect(adapter.probeStatus()).resolves.toEqual({
      configured: false,
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Codex CLI (`codex`) is not installed or not on PATH.",
    })
  })

  it("keeps authenticated Codex selectable when the app-server metadata probe exits before initialize", async () => {
    const fake = makeExitingCodexBinary()
    const homePath = makeTempDir("betterc0de-codex-home-")
    const repoPath = makeTempDir("betterc0de-codex-repo-")
    fs.writeFileSync(
      path.join(homePath, "auth.json"),
      '{"token":"test"}\n',
      "utf8"
    )
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: `codex:home:${homePath}`,
      binaryPath: fake.binaryPath,
      homePath,
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const status = await adapter.probeStatus({ cwd: repoPath })

    expect(status).toMatchObject({
      configured: true,
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "authenticated" },
    })
    expect(status.message).toContain(
      "Codex CLI is authenticated, but the app-server metadata probe failed"
    )
    expect(status.message).not.toContain(
      "codex child exited before responding to initialize"
    )
  })

  it("uses provider instance OPENAI_API_KEY environment for Codex metadata probes", async () => {
    const fake = makeFakeCodexBinary()
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      environment: [{ name: "OPENAI_API_KEY", value: "test-key" }],
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    expect(
      (await adapter.availableModels()).map((model) => model.slug)
    ).toEqual(["gpt-live", "gpt-second"])
  })

  it("loads live Codex models through model/list pagination", async () => {
    const fake = makeFakeCodexBinary()
    const homePath = makeTempDir("betterc0de-codex-home-")
    fs.writeFileSync(
      path.join(homePath, "auth.json"),
      '{"token":"test"}\n',
      "utf8"
    )
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: `codex:home:${homePath}`,
      binaryPath: fake.binaryPath,
      homePath,
      customModels: ["custom-live"],
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const models = await adapter.availableModels()
    const live = models.find((model) => model.slug === "gpt-live")
    const custom = models.find((model) => model.slug === "custom-live")
    const descriptors = live?.capabilities?.optionDescriptors ?? []
    const reasoning = descriptors.find(
      (descriptor) =>
        descriptor.type === "select" && descriptor.id === "reasoningEffort"
    )

    expect(models.map((model) => model.slug)).toEqual([
      "gpt-live",
      "gpt-second",
      "custom-live",
    ])
    expect(live?.name).toBe("gpt-live")
    expect(reasoning?.type === "select" ? reasoning.options : []).toEqual([
      { id: "low", label: "Low" },
      { id: "xhigh", label: "Extra High", isDefault: true },
      {
        id: "max",
        label: "Max",
        description: "Maximum reasoning from live metadata",
      },
      { id: "ultra", label: "Ultra" },
    ])
    expect(
      reasoning?.type === "select" ? reasoning.currentValue : undefined
    ).toBe("xhigh")
    expect(
      descriptors.some(
        (descriptor) =>
          descriptor.type === "boolean" && descriptor.id === "fastMode"
      )
    ).toBe(true)
    expect(custom?.isCustom).toBe(true)
    expect(custom?.capabilities).toBeNull()
  })

  it("keeps the last successful model catalog when a forced refresh fails", async () => {
    const fake = makeFakeCodexBinary()
    const homePath = makeTempDir("betterc0de-codex-cached-models-")
    fs.writeFileSync(
      path.join(homePath, "auth.json"),
      '{"token":"test"}\n',
      "utf8"
    )
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: `codex:home:${homePath}`,
      binaryPath: fake.binaryPath,
      homePath,
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    const before = await adapter.availableModels()
    expect(before[0].capabilities).not.toBeNull()
    const call = vi
      .spyOn(CodexRpcClient.prototype, "call")
      .mockRejectedValue(new Error("metadata probe unavailable"))
    try {
      adapter.invalidateMetadata()
      expect(await adapter.availableModels({ force: true })).toEqual(before)
    } finally {
      call.mockRestore()
    }
  })

  it("offers no invented models before the CLI has returned a catalog", async () => {
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: path.join(makeTempDir("betterc0de-codex-missing-"), "codex"),
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const models = await adapter.availableModels()

    expect(models).toEqual([])
    // The reserved selector is no longer offered in the fallback list, but
    // persisted selections of it must still translate to "no explicit model".
    expect(nativeCodexModelId(CODEX_CLI_DEFAULT_MODEL_ID)).toBeNull()
    expect(nativeCodexModelId("gpt-live")).toBe("gpt-live")
  })

  it("preserves explicit live model names and reasoning metadata", () => {
    const models = parseCodexModelListResponse({
      data: [
        {
          model: "provider-defined-model",
          displayName: "Provider Defined Display Name",
          supportedReasoningEfforts: [
            { reasoningEffort: "max", description: "Live maximum" },
            { reasoningEffort: "ultra" },
          ],
          defaultReasoningEffort: "max",
          additionalSpeedTiers: ["fast"],
        },
      ],
    })

    expect(models).toEqual([
      expect.objectContaining({
        slug: "provider-defined-model",
        name: "Provider Defined Display Name",
        capabilities: {
          attachment: true,
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [
                {
                  id: "max",
                  label: "Max",
                  description: "Live maximum",
                  isDefault: true,
                },
                { id: "ultra", label: "Ultra" },
              ],
              currentValue: "max",
            },
            { id: "fastMode", label: "Fast Mode", type: "boolean" },
          ],
        },
      }),
    ])
  })

  it("loads provider skills from Codex skills/list for the requested cwd", async () => {
    const fake = makeFakeCodexBinary()
    const homePath = makeTempDir("betterc0de-codex-home-")
    const repoPath = makeTempDir("betterc0de-codex-repo-")
    fs.writeFileSync(
      path.join(homePath, "auth.json"),
      '{"token":"test"}\n',
      "utf8"
    )
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: `codex:home:${homePath}`,
      binaryPath: fake.binaryPath,
      homePath,
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const skills = await adapter.availableSkills({ cwd: repoPath })

    expect(skills).toEqual([
      {
        name: "review-follow-up",
        path: "/skills/review-follow-up/SKILL.md",
        enabled: true,
        description: "Review follow-up details",
        scope: "user",
        displayName: "Review Follow-up",
        shortDescription: "Inspect review comments",
      },
      {
        name: "disabled-skill",
        path: "/skills/disabled-skill/SKILL.md",
        enabled: false,
        displayName: "Disabled Skill",
        shortDescription: "Top-level short description wins",
      },
    ])
  })

  it("falls back to all Codex skills when skills/list has no cwd match", async () => {
    const fake = makeFakeCodexBinary()
    const homePath = makeTempDir("betterc0de-codex-home-")
    const repoPath = makeTempDir("no-matching-cwd-")
    fs.writeFileSync(
      path.join(homePath, "auth.json"),
      '{"token":"test"}\n',
      "utf8"
    )
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: `codex:home:${homePath}`,
      binaryPath: fake.binaryPath,
      homePath,
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    expect(await adapter.availableSkills({ cwd: repoPath })).toEqual([
      {
        name: "fallback-review",
        path: "/skills/fallback-review/SKILL.md",
        enabled: true,
        description: "Review from fallback cwd",
      },
      {
        name: "fallback-tests",
        path: "/skills/fallback-tests/SKILL.md",
        enabled: false,
        scope: "project",
      },
    ])
  })

  it("maps BetterC0de plan/read-only mode to Codex native sandbox policies", async () => {
    const fake = makeFakeCodexSessionBinary()
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      environment: [{ name: "FAKE_CODEX_LOG", value: fake.logPath }],
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    sessionAdapters.push(adapter)

    await adapter.sendTurn({
      threadId: "thread-1",
      message: "Make a plan",
      modelId: "gpt-5.5",
      history: [],
      projectPath: fake.dir,
      permissionLevel: "bypass",
      chatMode: "plan",
      reasoningEffort: "medium",
      fastMode: true,
    })

    expect(readRpcLog(fake.logPath)).toEqual(
      expect.arrayContaining([
        {
          method: "thread/start",
          params: expect.objectContaining({
            cwd: fake.dir,
            model: "gpt-5.5",
            approvalPolicy: "untrusted",
            sandbox: "read-only",
          }),
        },
        {
          method: "turn/start",
          params: expect.objectContaining({
            threadId: "provider-thread-1",
            model: "gpt-5.5",
            approvalPolicy: "untrusted",
            sandboxPolicy: { type: "readOnly" },
            collaborationMode: expect.objectContaining({ mode: "plan" }),
          }),
        },
      ])
    )
  })

  it("passes image attachments through Codex native turn input", async () => {
    const fake = makeFakeCodexSessionBinary()
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      environment: [{ name: "FAKE_CODEX_LOG", value: fake.logPath }],
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    sessionAdapters.push(adapter)

    await adapter.sendTurn({
      threadId: "thread-image",
      message: "Inspect this image",
      modelId: "gpt-5.5",
      history: [],
      projectPath: fake.dir,
      attachments: [
        {
          type: "file",
          filename: "layout.png",
          mediaType: "image/png",
          url: "data:image/png;base64,aW1hZ2U=",
        },
      ],
    })

    const turn = readRpcLog(fake.logPath).find(
      (entry) => entry.method === "turn/start"
    )
    expect(turn?.params.input).toEqual([
      { type: "text", text: "Inspect this image" },
      { type: "image", url: "data:image/png;base64,aW1hZ2U=" },
    ])
  })

  it("does not pass renderer-local blob image URLs to Codex", async () => {
    const fake = makeFakeCodexSessionBinary()
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      environment: [{ name: "FAKE_CODEX_LOG", value: fake.logPath }],
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    sessionAdapters.push(adapter)

    await adapter.sendTurn({
      threadId: "thread-blob-image",
      message: "Inspect this image",
      modelId: "gpt-5.5",
      history: [],
      projectPath: fake.dir,
      attachments: [
        {
          type: "file",
          filename: "renderer-only.png",
          mediaType: "image/png",
          url: "blob:http://localhost/renderer-only",
        },
      ],
    })

    const turn = readRpcLog(fake.logPath).find(
      (entry) => entry.method === "turn/start"
    )
    expect(turn?.params.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("renderer-only.png"),
      },
    ])
  })

  it("writes provider-native observability records when enabled", async () => {
    const fake = makeFakeCodexSessionBinary()
    const nativeEvents: Array<{
      event?: {
        provider?: string
        providerInstanceId?: string
        threadId?: string
        providerThreadId?: string
        method?: string
      }
    }> = []
    const nativeThreadIds: Array<string | null> = []
    const adapter = new CodexAdapter({
      providerInstanceId: "codex-work",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      environment: [{ name: "FAKE_CODEX_LOG", value: fake.logPath }],
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      nativeEventLogger: {
        filePath: "memory://codex-native-events",
        write: (event, threadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number])
          nativeThreadIds.push(threadId ?? null)
        },
        flush: async () => {},
        removeThread: async () => {},
        close: () => {},
      },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    sessionAdapters.push(adapter)

    await adapter.sendTurn({
      threadId: "thread-native-log",
      message: "hello",
      modelId: "gpt-5.5",
      history: [],
      projectPath: fake.dir,
      reasoningEffort: "medium",
    })

    await waitFor(() =>
      nativeEvents.some(
        (record) => record.event?.method === "item/output/textDelta"
      )
    )

    expect(
      nativeEvents.some((record) => record.event?.provider === "codex")
    ).toBe(true)
    expect(
      nativeEvents.some(
        (record) => record.event?.providerInstanceId === "codex-work"
      )
    ).toBe(true)
    expect(
      nativeEvents.some(
        (record) => record.event?.providerThreadId === "provider-thread-1"
      )
    ).toBe(true)
    expect(
      nativeThreadIds.every((threadId) => threadId === "thread-native-log")
    ).toBe(true)
  })

  it("prefers an explicit recovery resume cursor over stored Codex thread ids", async () => {
    const fake = makeFakeCodexSessionBinary()
    const adapter = new CodexAdapter({
      providerInstanceId: "codex",
      continuationKey: "codex",
      binaryPath: fake.binaryPath,
      environment: [{ name: "FAKE_CODEX_LOG", value: fake.logPath }],
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      getStoredProviderThreadId: () => "stored-thread",
      persistProviderThreadId: () => {},
    })
    sessionAdapters.push(adapter)

    await adapter.startSession({
      threadId: "thread-1" as ThreadId,
      cwd: fake.dir,
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.5",
        options: [{ id: "fastMode", value: true }],
      },
      resumeCursor: { providerThreadId: "cursor-thread" },
      runtimeMode: "full-access",
    })

    expect(readRpcLog(fake.logPath)).toEqual(
      expect.arrayContaining([
        {
          method: "thread/resume",
          params: expect.objectContaining({
            threadId: "cursor-thread",
            cwd: fake.dir,
            model: "gpt-5.5",
          }),
        },
      ])
    )
    expect(
      readRpcLog(fake.logPath).some((entry) => entry.method === "thread/start")
    ).toBe(false)
  })
})
