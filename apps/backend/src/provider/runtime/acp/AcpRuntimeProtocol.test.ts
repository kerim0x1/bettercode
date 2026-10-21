import { afterEach, describe, expect, it, vi } from "vitest"
import { AcpJsonRpcClient } from "./AcpJsonRpcClient"
import {
  ACP_PROTOCOL_VERSION,
  acpPromptCapabilities,
  createAcpRuntime,
  type AcpRuntime,
  type AcpRuntimeProfile,
} from "./AcpRuntimeBase"

/**
 * A spec-following ACP peer: `session/cancel` is a notification that ends the
 * pending `session/prompt` with `stopReason: "cancelled"`. With
 * `cancelAsRequestOnly` it ignores the notification and only honours the
 * (pre-spec) request form.
 */
function peerScript(options: {
  readonly protocolVersion: number
  readonly cancelAsRequestOnly?: boolean
}): string {
  return `
const protocolVersion = ${JSON.stringify(options.protocolVersion)};
const cancelAsRequestOnly = ${JSON.stringify(options.cancelAsRequestOnly === true)};
let pendingPrompt = null;
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const isRequest = message.id !== undefined;
    if (message.method === "session/cancel") {
      if (!isRequest && cancelAsRequestOnly) continue;
      if (pendingPrompt !== null) {
        send({ id: pendingPrompt, result: { stopReason: "cancelled", via: isRequest ? "request" : "notification" } });
        pendingPrompt = null;
      }
      if (isRequest) send({ id: message.id, result: null });
      continue;
    }
    if (!isRequest) continue;
    if (message.method === "initialize") { send({ id: message.id, result: { protocolVersion } }); continue; }
    if (message.method === "session/new") { send({ id: message.id, result: { sessionId: "s1" } }); continue; }
    if (message.method === "session/prompt") { pendingPrompt = message.id; continue; }
    send({ id: message.id, result: {} });
  }
});
`
}

/**
 * An agent that asks for permission as soon as a prompt arrives and finishes
 * the prompt only once it has the answer, echoing it back.
 */
function permissionPeerScript(): string {
  return `
let pendingPrompt = null;
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === "permission-1" && message.method === undefined) {
      send({ id: pendingPrompt, result: { stopReason: "end_turn", permission: message.result } });
      pendingPrompt = null;
      continue;
    }
    if (message.id === undefined) continue;
    if (message.method === "initialize") { send({ id: message.id, result: { protocolVersion: 1 } }); continue; }
    if (message.method === "session/new") { send({ id: message.id, result: { sessionId: "s1" } }); continue; }
    if (message.method === "session/prompt") {
      pendingPrompt = message.id;
      send({
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: { toolCallId: "tool-1", title: "Run tests", kind: "execute" },
          options: [{ optionId: "allow-once", kind: "allow_once" }],
        },
      });
      continue;
    }
    send({ id: message.id, result: {} });
  }
});
`
}

const runtimes: AcpRuntime[] = []

function runtime(script: string): AcpRuntime {
  const profile: AcpRuntimeProfile = {
    label: "Test Agent",
    buildSpawnInput: (_settings, cwd) => ({
      command: process.execPath,
      args: ["-e", script],
      cwd,
    }),
    clientCapabilities: {},
    auth: { strategy: "eager", methodId: "test_login" },
  }
  const created = createAcpRuntime(profile, {
    settings: {},
    cwd: process.cwd(),
    clientInfo: { name: "betterc0de-test", version: "1" },
  })
  runtimes.push(created)
  return created
}

afterEach(async () => {
  for (const created of runtimes.splice(0)) await created.close()
})

describe("ACP protocol handling", () => {
  it("cancels a prompt with the session/cancel notification", async () => {
    const agent = runtime(peerScript({ protocolVersion: ACP_PROTOCOL_VERSION }))
    await agent.start()
    const prompt = agent.prompt({ prompt: [{ type: "text", text: "long" }] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await agent.cancel()
    await expect(prompt).resolves.toEqual({
      stopReason: "cancelled",
      via: "notification",
    })
  })

  it("falls back to the request form for agents that ignore the notification", async () => {
    const agent = runtime(
      peerScript({
        protocolVersion: ACP_PROTOCOL_VERSION,
        cancelAsRequestOnly: true,
      })
    )
    await agent.start()
    const prompt = agent.prompt({ prompt: [{ type: "text", text: "long" }] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await agent.cancel()
    await expect(prompt).resolves.toEqual({
      stopReason: "cancelled",
      via: "request",
    })
  })

  it("holds the prompt's silence limit while the agent waits for a permission answer", async () => {
    const holdIdleTimeouts = AcpJsonRpcClient.prototype.holdIdleTimeouts
    let releases = 0
    const hold = vi
      .spyOn(AcpJsonRpcClient.prototype, "holdIdleTimeouts")
      .mockImplementation(function (this: AcpJsonRpcClient) {
        const release = holdIdleTimeouts.call(this)
        return () => {
          releases += 1
          release()
        }
      })
    try {
      const agent = runtime(permissionPeerScript())
      const pending: { answer?: (value: unknown) => void } = {}
      agent.onPermissionRequest(
        () =>
          new Promise((resolve) => {
            pending.answer = resolve
          })
      )
      await agent.start()
      const prompt = agent.prompt({ prompt: [{ type: "text", text: "test" }] })
      await vi.waitFor(() => expect(pending.answer).toBeDefined())
      expect(hold).toHaveBeenCalledTimes(1)
      expect(releases).toBe(0)

      pending.answer?.({
        outcome: { outcome: "selected", optionId: "allow-once" },
      })
      await expect(prompt).resolves.toEqual({
        stopReason: "end_turn",
        permission: {
          outcome: { outcome: "selected", optionId: "allow-once" },
        },
      })
      expect(releases).toBe(1)
    } finally {
      hold.mockRestore()
    }
  })

  it("does not start an agent just to cancel it", async () => {
    const agent = runtime(peerScript({ protocolVersion: ACP_PROTOCOL_VERSION }))
    await expect(agent.cancel()).resolves.toBeUndefined()
    expect((agent as unknown as { client: unknown }).client).toBeNull()
  })

  it("rejects an agent that speaks an older protocol with an upgrade hint", async () => {
    const agent = runtime(peerScript({ protocolVersion: 0 }))
    await expect(agent.start()).rejects.toThrow(
      /Agent Client Protocol v0, but BetterC0de needs v1/
    )
  })

  it("does not block an agent that answers with a newer protocol", async () => {
    const agent = runtime(
      peerScript({ protocolVersion: ACP_PROTOCOL_VERSION + 1 })
    )
    await expect(agent.start()).resolves.toMatchObject({ sessionId: "s1" })
  })

  it("reads the advertised prompt capabilities", () => {
    expect(
      acpPromptCapabilities({
        agentCapabilities: { promptCapabilities: { image: true } },
      })
    ).toEqual({ image: true, audio: false, embeddedContext: false })
    expect(acpPromptCapabilities({ protocolVersion: 1 }).image).toBe(false)
  })
})
