import { describe, expect, it } from "vitest"
import { createAcpRuntime, type AcpRuntimeProfile } from "./AcpRuntimeBase"

function peerScript(typed: boolean): string {
  return `
const typed = ${JSON.stringify(typed)};
const model = "composer[fast]";
const modelOption = (currentValue) => ({
  id: "model", name: "Model", type: "select", currentValue,
  options: [{ value: model, name: "Composer Fast" }],
});
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    let result = {};
    let error;
    if (request.method === "initialize") result = { protocolVersion: 1 };
    if (request.method === "session/new") {
      result = typed
        ? { sessionId: "s1", models: { currentModelId: model, availableModels: [{ modelId: model, name: "Composer Fast" }] } }
        : { sessionId: "s1", configOptions: [modelOption(model)] };
    }
    if (request.method === "session/set_config_option" || request.method === "session/set_model") {
      const value = request.params.value ?? request.params.modelId;
      if (value !== model) error = { code: -32602, message: "wrong model value" };
      else result = { configOptions: [modelOption(value)] };
    }
    if (request.method === "session/prompt") {
      result = { stopReason: "end_turn" };
      if (!typed) process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", method: "session/update",
        params: { sessionId: "s1", update: {
          sessionUpdate: "config_option_update",
          configOptions: [modelOption(model), {
            id: "effort", name: "Effort", type: "select", currentValue: "high",
            options: [{ value: "high", name: "High" }],
          }],
        } },
      }) + "\\n");
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }) + "\\n");
  }
});
`
}

function runtime(typed: boolean) {
  const profile: AcpRuntimeProfile = {
    label: "Cursor",
    buildSpawnInput: (_settings, cwd) => ({
      command: process.execPath,
      args: ["-e", peerScript(typed)],
      cwd,
    }),
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      session: { configOptions: { boolean: {} } },
    },
    auth: { strategy: "eager", methodId: "cursor_login" },
  }
  return createAcpRuntime(profile, {
    settings: {},
    cwd: process.cwd(),
    clientInfo: {
      name: "betterc0de-test",
      title: "BetterC0de Test",
      version: "1",
    },
  })
}

describe("ACP model selection", () => {
  it("sends the exact advertised model option, including brackets", async () => {
    const agent = runtime(false)
    try {
      await agent.start()
      await expect(agent.setModel("composer[fast]")).resolves.toBeUndefined()
      expect(agent.getConfigOptions()[0]).toMatchObject({
        id: "model",
        currentValue: "composer[fast]",
      })
      await expect(agent.setModel("withdrawn-model")).rejects.toThrow(
        /did not advertise model/
      )
      await agent.prompt({ prompt: [{ type: "text", text: "continue" }] })
      expect(agent.getConfigOptions().map((option) => option.id)).toEqual([
        "model",
        "effort",
      ])
    } finally {
      await agent.close()
    }
  })

  it("uses the legacy ACP model method when only typed models are listed", async () => {
    const agent = runtime(true)
    try {
      await agent.start()
      await expect(agent.setModel("composer[fast]")).resolves.toBeUndefined()
      await expect(
        agent.prompt({ prompt: [{ type: "text", text: "hello" }] })
      ).resolves.toEqual({
        stopReason: "end_turn",
      })
    } finally {
      await agent.close()
    }
  })
})
