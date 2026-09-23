import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { CodexSessionRuntime } from "./CodexSessionRuntime"
import { CodexServerResponseRefusedError } from "./rpc"

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
  readonly logPath: string
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de fake codex-"))
  const binaryPath = path.join(dir, "fake-codex.cjs")
  const logPath = path.join(dir, "rpc.log")
  fs.writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = process.env.FAKE_CODEX_LOG;
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function log(message) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(message) + "\\n", "utf8");
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line) return;
  const message = JSON.parse(line);
  if (message.id === "server-approval-1" && !message.method) {
    log({ method: "server-approval-response", params: message.result ?? message.error ?? {} });
    return;
  }
  if (message.id === "server-input-1" && !message.method) {
    log({ method: "server-input-response", params: message.result ?? message.error ?? {} });
    return;
  }
  if (message.id === "server-permission-1" && !message.method) {
    log({ method: "server-permission-response", params: message.result ?? message.error ?? {} });
    return;
  }
  if (message.id === "server-elicitation-1" && !message.method) {
    log({ method: "server-elicitation-response", params: message.result ?? message.error ?? {} });
    return;
  }
  if (message.id === undefined || !message.method) return;
  log({ method: message.method, params: message.params ?? {} });
  if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "provider-thread-1" } } });
    return;
  }
  if (message.method === "turn/start") {
    if (process.env.FAKE_CODEX_REQUEST_KIND === "approval") {
      send({
        jsonrpc: "2.0",
        id: "server-approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          approvalId: "approval-1",
          itemId: "cmd-1",
          command: "npm test",
          cwd: "/repo",
        },
      });
    }
    if (process.env.FAKE_CODEX_REQUEST_KIND === "user-input") {
      send({
        jsonrpc: "2.0",
        id: "server-input-1",
        method: "item/tool/requestUserInput",
        params: {
          requestId: "question-1",
          itemId: "question-1",
          questions: [{ id: process.env.FAKE_CODEX_QUESTION_ID || "scope", question: "Which scope?", options: ["Backend"] }],
        },
      });
    }
    if (process.env.FAKE_CODEX_REQUEST_KIND === "permissions") {
      send({
        jsonrpc: "2.0",
        id: "server-permission-1",
        method: "item/permissions/requestApproval",
        params: {
          itemId: "permission-1",
          turnId: "turn-1",
          threadId: "provider-thread-1",
          cwd: "/repo",
          reason: "Need write access",
          permissions: { fileSystem: { write: ["/repo"] } },
        },
      });
    }
    if (process.env.FAKE_CODEX_REQUEST_KIND === "elicitation") {
      send({
        jsonrpc: "2.0",
        id: "server-elicitation-1",
        method: "mcpServer/elicitation/request",
        params: {
          mode: "form",
          serverName: "github",
          threadId: "provider-thread-1",
          turnId: "turn-1",
          message: "Select repository",
          requestedSchema: {
            type: "object",
            properties: {
              repo: {
                type: "string",
                title: "Repository",
                description: "Which repository should be used?",
              },
            },
          },
        },
      });
    }
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/rollback") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { thread: { id: message.params.threadId, turns: [] } },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
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

async function waitForRpcLog(
  logPath: string,
  predicate: (entry: {
    method: string
    params: Record<string, unknown>
  }) => boolean
): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    const entries = readRpcLog(logPath)
    if (entries.some(predicate)) return entries
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return readRpcLog(logPath)
}

describe("CodexSessionRuntime", () => {
  it("does not expose native spawn diagnostics in provider events", () => {
    const runtime = new CodexSessionRuntime({ binaryPath: "codex" })
    const events: Array<{ kind: string; error?: string }> = []
    const state = runtime as unknown as {
      rpc: { emit(event: string, error: Error): void }
      wireRpcListeners(): void
    }
    runtime.on("event", (event) => events.push(event))
    state.wireRpcListeners()

    state.rpc.emit(
      "child-error",
      new Error("ENOENT C:\\private\\codex.exe token sk-sensitive")
    )

    expect(events).toContainEqual({
      kind: "spawn-error",
      error: "Codex provider process could not be started.",
    })
    expect(JSON.stringify(events)).not.toContain("C:\\private\\codex.exe")
    expect(JSON.stringify(events)).not.toContain("sk-sensitive")
  })

  it("reports a pipe error on a running process as a lost connection, not a failed start", () => {
    const runtime = new CodexSessionRuntime({ binaryPath: "codex" })
    const events: Array<{ kind: string; error?: string }> = []
    const state = runtime as unknown as {
      rpc: { emit(event: string, error: Error): void }
      spawned: boolean
      wireRpcListeners(): void
    }
    runtime.on("event", (event) => events.push(event))
    state.wireRpcListeners()
    state.spawned = true

    state.rpc.emit("child-error", new Error("EPIPE C:\\private\\pipe"))

    expect(events).toEqual([
      { kind: "child-error", error: "Codex provider connection lost." },
    ])
    expect(JSON.stringify(events)).not.toContain("C:\\private")
  })

  it("does not report a lost connection for a pipe error raised while closing", async () => {
    const runtime = new CodexSessionRuntime({ binaryPath: "codex" })
    const events: Array<{ kind: string; error?: string }> = []
    const state = runtime as unknown as {
      rpc: {
        emit(event: string, payload: unknown): void
        close(): Promise<void>
      }
      spawned: boolean
      wireRpcListeners(): void
    }
    runtime.on("event", (event) => events.push(event))
    state.wireRpcListeners()
    state.spawned = true
    // A write caught mid-teardown errors with EPIPE before the exit lands.
    state.rpc.close = async () => {
      state.rpc.emit("child-error", new Error("EPIPE"))
      state.rpc.emit("exit", { code: null, signal: "SIGKILL" })
    }

    await runtime.close()

    // One terminal, the exit — not "connection lost" on top of it.
    expect(events.map((event) => event.kind)).toEqual(["child-exit"])
  })

  it("names a refused approval reply instead of a generic lost connection", () => {
    const runtime = new CodexSessionRuntime({ binaryPath: "codex" })
    const events: Array<{ kind: string; error?: string }> = []
    const state = runtime as unknown as {
      rpc: { emit(event: string, error: Error): void }
      spawned: boolean
      wireRpcListeners(): void
    }
    runtime.on("event", (event) => events.push(event))
    state.wireRpcListeners()
    state.spawned = true

    state.rpc.emit(
      "child-error",
      new CodexServerResponseRefusedError(
        "item/commandExecution/requestApproval",
        9
      )
    )

    expect(events).toEqual([
      {
        kind: "child-error",
        error:
          "Codex did not receive the reply to its approval request because its input backlog is full; the turn was stopped.",
      },
    ])
  })

  it("forwards provider conversation rollback to Codex thread/rollback", async () => {
    const fake = makeFakeCodexBinary()
    const runtime = new CodexSessionRuntime({
      binaryPath: fake.binaryPath,
      cwd: fake.dir,
      env: { FAKE_CODEX_LOG: fake.logPath },
    })

    try {
      await runtime.start({
        cwd: fake.dir,
        clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      })

      await runtime.rollbackThread(2)

      expect(readRpcLog(fake.logPath)).toEqual(
        expect.arrayContaining([
          {
            method: "thread/rollback",
            params: { threadId: "provider-thread-1", numTurns: 2 },
          },
        ])
      )
    } finally {
      await runtime.close().catch(() => {})
      // fs.rmSync ignores maxRetries/retryDelay for EBUSY on Windows (Node 22):
      // it throws at once while a just-killed fake CLI still holds the directory
      // as its working directory. fs.promises.rm retries as configured.
      await fs.promises.rm(fake.dir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      })
    }
  })

  it("forwards BetterC0de thread and turn policies to Codex", async () => {
    const fake = makeFakeCodexBinary()
    const runtime = new CodexSessionRuntime({
      binaryPath: fake.binaryPath,
      cwd: fake.dir,
      env: { FAKE_CODEX_LOG: fake.logPath },
    })

    try {
      await runtime.start({
        cwd: fake.dir,
        clientInfo: { name: "test", title: "Test", version: "0.0.0" },
        model: "gpt-5.5",
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        serviceTier: "fast",
      })

      await runtime.sendTurn({
        model: "gpt-5.5",
        message: "Plan it",
        images: [
          {
            url: "data:image/png;base64,aW1hZ2U=",
            detail: "original",
          },
        ],
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "readOnly" },
        effort: "medium",
        serviceTier: "fast",
      })

      expect(readRpcLog(fake.logPath)).toEqual(
        expect.arrayContaining([
          {
            method: "thread/start",
            params: {
              cwd: fake.dir,
              model: "gpt-5.5",
              approvalPolicy: "untrusted",
              sandbox: "read-only",
              serviceTier: "fast",
            },
          },
          {
            method: "turn/start",
            params: expect.objectContaining({
              threadId: "provider-thread-1",
              model: "gpt-5.5",
              approvalPolicy: "untrusted",
              sandboxPolicy: { type: "readOnly" },
              effort: "medium",
              serviceTier: "fast",
              input: [
                { type: "text", text: "Plan it" },
                {
                  type: "image",
                  url: "data:image/png;base64,aW1hZ2U=",
                  detail: "original",
                },
              ],
            }),
          },
        ])
      )
    } finally {
      await runtime.close().catch(() => {})
      await fs.promises.rm(fake.dir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      })
    }
  })

  it.each([
    { enabled: true, resume: false },
    { enabled: false, resume: false },
    { enabled: true, resume: true },
    { enabled: false, resume: true },
  ])(
    "overrides code-search configuration on start and resume (%j)",
    async ({ enabled, resume }) => {
      const fake = makeFakeCodexBinary()
      const runtime = new CodexSessionRuntime({
        binaryPath: fake.binaryPath,
        cwd: fake.dir,
        env: { FAKE_CODEX_LOG: fake.logPath },
      })
      try {
        await runtime.start({
          cwd: fake.dir,
          clientInfo: { name: "test", title: "Test", version: "0.0.0" },
          storedProviderThreadId: resume ? "stored-thread" : null,
          codeSearchServer: enabled
            ? {
                type: "http",
                url: "http://127.0.0.1:12345/mcp",
                headers: { Authorization: "Bearer scoped" },
              }
            : null,
        })
        expect(readRpcLog(fake.logPath)).toContainEqual({
          method: resume ? "thread/resume" : "thread/start",
          params: expect.objectContaining({
            config: {
              "mcp_servers.betterc0de_code_search": enabled
                ? {
                    enabled: true,
                    url: "http://127.0.0.1:12345/mcp",
                    http_headers: { Authorization: "Bearer scoped" },
                  }
                : { enabled: false, url: "http://127.0.0.1:9/mcp" },
            },
          }),
        })
        expect(fs.existsSync(path.join(fake.dir, "config.toml"))).toBe(false)
      } finally {
        await runtime.close()
        await fs.promises.rm(fake.dir, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 50,
        })
      }
    }
  )

  it.each([false, true])(
    "overrides coordinator tools on start/resume without changing code-search settings (resume=%s)",
    async (resume) => {
      const fake = makeFakeCodexBinary()
      const runtime = new CodexSessionRuntime({
        binaryPath: fake.binaryPath,
        cwd: fake.dir,
        env: { FAKE_CODEX_LOG: fake.logPath },
      })
      try {
        await runtime.start({
          cwd: fake.dir,
          clientInfo: { name: "test", title: "Test", version: "0" },
          storedProviderThreadId: resume ? "saved" : null,
          orchestratorServer: {
            type: "http",
            url: "http://127.0.0.1:12345/mcp",
            headers: { Authorization: "Bearer team" },
          },
          codeSearchServer: null,
        })
        expect(readRpcLog(fake.logPath)).toContainEqual({
          method: resume ? "thread/resume" : "thread/start",
          params: expect.objectContaining({
            config: {
              "mcp_servers.betterc0de_orchestrator": {
                enabled: true,
                url: "http://127.0.0.1:12345/mcp",
                http_headers: { Authorization: "Bearer team" },
              },
              "mcp_servers.betterc0de_code_search": {
                enabled: false,
                url: "http://127.0.0.1:9/mcp",
              },
            },
          }),
        })
        expect(fs.existsSync(path.join(fake.dir, "config.toml"))).toBe(false)
      } finally {
        await runtime.close()
        await fs.promises.rm(fake.dir, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 50,
        })
      }
    }
  )

  it("emits approval resolution notifications after responding", async () => {
    const fake = makeFakeCodexBinary()
    const runtime = new CodexSessionRuntime({
      binaryPath: fake.binaryPath,
      cwd: fake.dir,
      env: {
        FAKE_CODEX_LOG: fake.logPath,
        FAKE_CODEX_REQUEST_KIND: "approval",
      },
    })
    const events: Array<{
      method?: string
      requestId?: string
      params?: unknown
      kind: string
    }> = []
    runtime.on("event", (event) => events.push(event))

    try {
      await runtime.start({
        cwd: fake.dir,
        clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      })
      await runtime.sendTurn({ message: "Run tests" })

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "server-request",
            method: "item/commandExecution/requestApproval",
            requestId: "approval-1",
          }),
        ])
      )

      expect(() =>
        runtime.respondToRequest("approval-1", {
          kind: "user_input",
          answers: { scope: "Backend" },
        })
      ).toThrow(/stale pending/i)
      runtime.respondToRequest("approval-1", {
        kind: "tool_approval",
        decision: "approve",
      })

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "notification",
            method: "item/requestApproval/decision",
            requestId: "approval-1",
            params: expect.objectContaining({
              requestId: "approval-1",
              decision: "approve",
            }),
          }),
        ])
      )
      const rpcLog = await waitForRpcLog(
        fake.logPath,
        (entry) => entry.method === "server-approval-response"
      )
      expect(rpcLog).toEqual(
        expect.arrayContaining([
          {
            method: "server-approval-response",
            params: { decision: "accept" },
          },
        ])
      )
    } finally {
      await runtime.close().catch(() => {})
      await fs.promises.rm(fake.dir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      })
    }
  })

  it.each([
    {
      answers: { scope: "Backend" },
      expectedAnswers: { scope: { answers: ["Backend"] } },
    },
    {
      answers: JSON.parse('{"__proto__":"Backend"}') as Record<string, unknown>,
      expectedAnswers: JSON.parse('{"__proto__":{"answers":["Backend"]}}'),
    },
  ])(
    "emits user-input answered notifications and preserves question IDs (%j)",
    async ({ answers, expectedAnswers }) => {
      const fake = makeFakeCodexBinary()
      const runtime = new CodexSessionRuntime({
        binaryPath: fake.binaryPath,
        cwd: fake.dir,
        env: {
          FAKE_CODEX_LOG: fake.logPath,
          FAKE_CODEX_REQUEST_KIND: "user-input",
          FAKE_CODEX_QUESTION_ID: Object.keys(answers)[0],
        },
      })
      const events: Array<{
        method?: string
        requestId?: string
        params?: unknown
        kind: string
      }> = []
      runtime.on("event", (event) => events.push(event))

      try {
        await runtime.start({
          cwd: fake.dir,
          clientInfo: { name: "test", title: "Test", version: "0.0.0" },
        })
        await runtime.sendTurn({ message: "Ask a question" })

        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "server-request",
              method: "item/tool/requestUserInput",
              requestId: "question-1",
            }),
          ])
        )

        expect(() =>
          runtime.respondToRequest("question-1", {
            kind: "tool_approval",
            decision: "approve",
          })
        ).toThrow(/stale pending/i)
        runtime.respondToRequest("question-1", {
          kind: "user_input",
          answers,
        })

        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "notification",
              method: "item/tool/requestUserInput/answered",
              requestId: "question-1",
              params: expect.objectContaining({
                requestId: "question-1",
                answers: expectedAnswers,
              }),
            }),
          ])
        )
        const rpcLog = await waitForRpcLog(
          fake.logPath,
          (entry) => entry.method === "server-input-response"
        )
        expect(rpcLog).toEqual(
          expect.arrayContaining([
            {
              method: "server-input-response",
              params: { answers: expectedAnswers },
            },
          ])
        )
      } finally {
        await runtime.close().catch(() => {})
        await fs.promises.rm(fake.dir, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 50,
        })
      }
    }
  )

  it("grants permission-profile requests with the requested profile", async () => {
    const fake = makeFakeCodexBinary()
    const runtime = new CodexSessionRuntime({
      binaryPath: fake.binaryPath,
      cwd: fake.dir,
      env: {
        FAKE_CODEX_LOG: fake.logPath,
        FAKE_CODEX_REQUEST_KIND: "permissions",
      },
    })
    const events: Array<{
      method?: string
      requestId?: string
      params?: unknown
      kind: string
    }> = []
    runtime.on("event", (event) => events.push(event))

    try {
      await runtime.start({
        cwd: fake.dir,
        clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      })
      await runtime.sendTurn({ message: "Need permission" })

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "server-request",
            method: "item/permissions/requestApproval",
            requestId: "permission-1",
          }),
        ])
      )

      runtime.respondToRequest("permission-1", {
        kind: "tool_approval",
        decision: "approve",
      })

      const rpcLog = await waitForRpcLog(
        fake.logPath,
        (entry) => entry.method === "server-permission-response"
      )
      const permissionResponse = rpcLog.find(
        (entry) => entry.method === "server-permission-response"
      )
      expect(permissionResponse).toEqual({
        method: "server-permission-response",
        params: {
          permissions: {},
          scope: "turn",
          strictAutoReview: true,
        },
      })
    } finally {
      await runtime.close().catch(() => {})
      await fs.promises.rm(fake.dir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      })
    }
  })

  it("answers MCP elicitation requests with accepted content", async () => {
    const fake = makeFakeCodexBinary()
    const runtime = new CodexSessionRuntime({
      binaryPath: fake.binaryPath,
      cwd: fake.dir,
      env: {
        FAKE_CODEX_LOG: fake.logPath,
        FAKE_CODEX_REQUEST_KIND: "elicitation",
      },
    })
    const events: Array<{
      method?: string
      requestId?: string
      params?: unknown
      kind: string
    }> = []
    runtime.on("event", (event) => events.push(event))

    try {
      await runtime.start({
        cwd: fake.dir,
        clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      })
      await runtime.sendTurn({ message: "Ask MCP" })

      const request = events.find(
        (event) => event.method === "mcpServer/elicitation/request"
      )
      expect(request).toMatchObject({
        kind: "server-request",
        method: "mcpServer/elicitation/request",
      })
      expect(request?.requestId).toBeTruthy()

      runtime.respondToRequest(request!.requestId!, {
        kind: "user_input",
        answers: { repo: "BetterC0de" },
      })

      const rpcLog = await waitForRpcLog(
        fake.logPath,
        (entry) => entry.method === "server-elicitation-response"
      )
      expect(rpcLog).toEqual(
        expect.arrayContaining([
          {
            method: "server-elicitation-response",
            params: {
              action: "accept",
              content: { repo: "BetterC0de" },
            },
          },
        ])
      )
    } finally {
      await runtime.close().catch(() => {})
      await fs.promises.rm(fake.dir, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      })
    }
  })
})
