import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OpenCodeAdapter } from "./OpenCodeAdapter"
import { OPENCODE_CLI_PROFILE } from "../betterc0deCompat/OpenCodeCompatProfile"
import type { ThreadId } from "../contracts"

afterEach(() => {
  vi.restoreAllMocks()
})

function asyncMock(value: unknown) {
  return vi.fn(async (): Promise<unknown> => value)
}

function fakeClient(input: { readonly stream: AsyncIterable<unknown> }) {
  return {
    session: {
      create: asyncMock({ data: { id: "ses_opencode_1" } }),
      promptAsync: asyncMock({ data: {} }),
      abort: asyncMock({ data: true }),
      messages: asyncMock({ data: [] }),
      revert: asyncMock({ data: true }),
    },
    event: { subscribe: asyncMock({ stream: input.stream }) },
    permission: { reply: asyncMock({ data: true }) },
    question: {
      reply: asyncMock({ data: true }),
      reject: asyncMock({ data: true }),
    },
    provider: {
      // v1 provider inventory (authoritative for connected providers).
      list: asyncMock({
        data: {
          all: [
            {
              id: "opencode",
              name: "OpenCode Zen",
              source: "custom",
              env: ["OPENCODE_API_KEY"],
              models: {
                "big-pickle": {
                  id: "big-pickle",
                  providerID: "opencode",
                  name: "Big Pickle",
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
                  limit: { context: 200_000, output: 8_192 },
                  status: "active",
                  variants: {},
                },
              },
            },
          ],
          connected: ["opencode"],
        },
      }),
    },
    v2: {
      model: {
        // The adapter receives the already-unwrapped array from the HTTP
        // client; each model still uses the current opencode nested-api shape.
        list: asyncMock({
          data: [
            {
              id: "big-pickle",
              providerID: "opencode",
              name: "Big Pickle (v2)",
              api: {
                id: "big-pickle",
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: "https://opencode.ai/zen/v1",
              },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants: [],
              time: { released: Date.UTC(2025, 9, 17) },
              cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
              status: "active",
              enabled: true,
              limit: { context: 200_000, output: 8_192 },
            },
          ],
        }),
      },
      provider: {
        list: asyncMock({
          data: [
            {
              id: "opencode",
              name: "OpenCode Zen",
              api: {
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: "https://opencode.ai/zen/v1",
              },
            },
          ],
        }),
      },
    },
    app: {
      agents: asyncMock({ data: [] }),
      skills: asyncMock({ data: [] }),
    },
    command: { list: asyncMock({ data: [] }) },
    tool: { list: asyncMock({ data: [] }), ids: asyncMock({ data: [] }) },
  }
}

function pushStream<T>() {
  const values: T[] = []
  const waiters: Array<(value: IteratorResult<T>) => void> = []
  let closed = false
  return {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = values.shift()
            if (value !== undefined) return Promise.resolve({ value, done: false })
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

describe("OpenCodeAdapter", () => {
  it("uses the opencode provider kind and display name", () => {
    const adapter = new OpenCodeAdapter()
    expect(adapter.provider).toBe("opencode_cli")
    expect(adapter.displayName).toBe("OpenCode")
    expect(OPENCODE_CLI_PROFILE.providerKind).toBe("opencode_cli")
  })

  it("requires a configured binary or server URL", () => {
    expect(new OpenCodeAdapter({ binaryPath: "" }).isConfigured()).toBe(false)
    expect(new OpenCodeAdapter({ binaryPath: "opencode" }).isConfigured()).toBe(
      true
    )
    expect(
      new OpenCodeAdapter({ serverUrl: "http://127.0.0.1:4096" }).isConfigured()
    ).toBe(true)
  })

  it("flattens v1 providers with v2 model metadata using the opencode slug format", async () => {
    const stream = pushStream<unknown>()
    const client = fakeClient({ stream: stream.stream })
    const adapter = new OpenCodeAdapter({
      clientFactory: (() => client) as never,
      serverConnector: async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      }),
    })

    const models = await adapter.availableModels()
    expect(models.map((model) => model.slug)).toContain("opencode/big-pickle")
    const model = models.find((m) => m.slug === "opencode/big-pickle")
    expect(model?.name).toBe("Big Pickle (v2)")
    expect(model?.catalog?.api?.id).toBe("big-pickle")
    expect(model?.catalog?.api?.url).toBe("https://opencode.ai/zen/v1")

    stream.close()
    await adapter.stopAll()
  })

  it("starts a session and streams a v1 message turn", async () => {
    const stream = pushStream<unknown>()
    const client = fakeClient({ stream: stream.stream })
    const adapter = new OpenCodeAdapter({
      providerInstanceId: "opencode-cli",
      continuationKey: "opencode-cli:instance:opencode-cli",
      clientFactory: (() => client) as never,
      serverConnector: async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      }),
    })
    const events: Array<{ type: string; providerKind?: string }> = []
    const unsubscribe = adapter.subscribe((event) =>
      events.push({ type: event.type, providerKind: event.providerKind })
    )
    const threadId = "thread-opencode" as ThreadId

    const session = await adapter.startSession({
      threadId,
      cwd: os.tmpdir(),
      modelSelection: { instanceId: "opencode-cli", model: "opencode/big-pickle" },
    })
    expect(session.providerThreadId).toBe("ses_opencode_1")
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("OpenCode") })
    )

    await adapter.sendTurn({
      threadId,
      message: "hello",
      modelId: "opencode/big-pickle",
      history: [],
    })
    await flushAsync()

    stream.push({
      id: "evt-2",
      type: "message.updated",
      properties: {
        info: {
          id: "msg-assistant",
          role: "assistant",
          sessionID: "ses_opencode_1",
        },
      },
    })
    stream.push({
      id: "evt-1",
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: "ses_opencode_1",
          messageID: "msg-assistant",
          type: "text",
          text: "hi there",
        },
      },
    })
    await flushAsync()

    const delta = events.find((event) => event.type === "content.delta")
    expect(delta).toBeDefined()
    expect(events.every((event) => event.providerKind === "opencode_cli")).toBe(
      true
    )
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "ses_opencode_1",
        model: { providerID: "opencode", modelID: "big-pickle" },
      })
    )

    unsubscribe()
    stream.close()
    await adapter.stopAll()
  })

  it("maps v1 permission and question requests to OpenCode reply endpoints", async () => {
    const stream = pushStream<unknown>()
    const client = fakeClient({ stream: stream.stream })
    const adapter = new OpenCodeAdapter({
      providerInstanceId: "opencode-cli",
      clientFactory: (() => client) as never,
      serverConnector: async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close: async () => {},
      }),
    })
    const threadId = "thread-permission" as ThreadId
    await adapter.startSession({ threadId, cwd: os.tmpdir() })

    stream.push({
      id: "evt-perm",
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: "ses_opencode_1",
        permission: "bash",
        patterns: ["rm -rf /"],
        metadata: {},
      },
    })
    await flushAsync()

    await adapter.respondToRequest(threadId, "per_1" as never, {
      kind: "tool_approval",
      decision: "approve",
    })
    expect(client.permission.reply).toHaveBeenCalledWith({
      requestID: "per_1",
      reply: "once",
    })

    stream.close()
    await adapter.stopAll()
  })

  it("parses the opencode server-ready line from stdout", () => {
    const readyLine = "opencode server listening on http://127.0.0.1:4199"
    const match = readyLine.match(OPENCODE_CLI_PROFILE.serverReadyUrlPattern)
    expect(match?.[1]).toBe("http://127.0.0.1:4199")
    expect(
      OPENCODE_CLI_PROFILE.serverReadyPrefixes.some((prefix) =>
        readyLine.startsWith(prefix)
      )
    ).toBe(true)
  })

  it("serves the opencode serve argv and has no config-content override", () => {
    expect(OPENCODE_CLI_PROFILE.serveArgs(4199, "127.0.0.1")).toEqual([
      "serve",
      "--hostname=127.0.0.1",
      "--port=4199",
    ])
    expect(OPENCODE_CLI_PROFILE.configContentEnv).toEqual([])
    expect(OPENCODE_CLI_PROFILE.minimumVersion).toBeNull()
    expect(OPENCODE_CLI_PROFILE.v2Envelope).toBe(true)
    expect(OPENCODE_CLI_PROFILE.v2NestedApi).toBe(true)
  })

  it("reports the opencode brand in probe errors when the binary is missing", async () => {
    const adapter = new OpenCodeAdapter({
      binaryPath: path.join(os.tmpdir(), "definitely-missing-opencode-binary"),
    })
    const status = await adapter.probeStatus()
    expect(status.status).toBe("error")
    expect(status.message).toContain("OpenCode")
  })

  it("does not gate on a minimum version (opencode has no floor)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-version-"))
    const scriptPath = path.join(dir, "fake-opencode.cjs")
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env node",
        'if (process.argv.includes("--version")) { process.stdout.write("0.0.1\\n"); process.exit(0); }',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8"
    )
    try {
      const adapter = new OpenCodeAdapter({
        binaryPath: process.execPath,
        serverConnector: async () => ({
          url: "http://127.0.0.1:4096",
          external: true,
          close: async () => {},
        }),
      })
      // The version probe runs `node --version` (valid), and the inventory
      // call uses the injected connector. The point is that no minimum-version
      // rejection happens for the opencode profile.
      const status = await adapter.probeStatus()
      expect(status.installed).toBe(true)
      expect(status.message ?? "").not.toContain("too old")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
