import { describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type {
  PortableMcpServer,
  PortableMcpServerResolver,
} from "../runtime/cursor/AcpMcpServers"
import {
  DirectMcpToolSession,
  connectDirectMcpClient,
  directMcpEnabledForMode,
  directMcpToolsForAnthropic,
  directMcpToolsForOpenAi,
  type DirectMcpClient,
} from "./direct-mcp-tools"

const STDIO_SERVER: PortableMcpServer = {
  id: "project-files",
  name: "Project Files",
  transport: "stdio",
  command: "project-mcp",
  args: ["--stdio"],
  env: { PROJECT_TOKEN: "configured-secret" },
}

function fakeClient(input: {
  tools?: Array<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
  }>
  result?: unknown
  listError?: Error
  callError?: Error
}) {
  const listTools = vi.fn(async () => {
    if (input.listError) throw input.listError
    return {
      tools: input.tools ?? [
        {
          name: "read_document",
          description: "Read one document.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    }
  })
  const callTool = vi.fn(async () => {
    if (input.callError) throw input.callError
    return (
      input.result ?? {
        content: [{ type: "text", text: "document body" }],
      }
    )
  })
  const close = vi.fn(async () => undefined)
  return {
    client: { listTools, callTool, close } satisfies DirectMcpClient,
    listTools,
    callTool,
    close,
  }
}

describe("DirectMcpToolSession", () => {
  it("advertises namespaced JSON-schema tools and executes the original name", async () => {
    const fake = fakeClient({
      tools: [
        {
          name: "read_document",
          description: "Read using configured-secret.",
          inputSchema: {
            type: "object",
            properties: {
              path: {
                type: "string",
                default: "configured-secret",
              },
            },
            required: ["path"],
          },
        },
      ],
    })
    const resolver: PortableMcpServerResolver = async () => [STDIO_SERVER]
    const controller = new AbortController()
    const session = await DirectMcpToolSession.open({
      cwd: "/project",
      signal: controller.signal,
      resolver,
      clientFactory: async () => fake.client,
    })

    const [definition] = session.definitions()
    expect(definition?.name).toMatch(
      /^mcp__Project_Files__read_document_[a-f0-9]{10}$/
    )
    expect(definition?.name.length).toBeLessThanOrEqual(64)
    expect(definition?.inputSchema).toEqual({
      type: "object",
      properties: {
        path: { type: "string", default: "[REDACTED]" },
      },
      required: ["path"],
    })
    expect(definition?.description).not.toContain("configured-secret")
    expect(directMcpToolsForOpenAi(session)[0]).toMatchObject({
      type: "function",
      function: {
        name: definition?.name,
        parameters: definition?.inputSchema,
      },
    })
    expect(directMcpToolsForAnthropic(session)[0]).toMatchObject({
      name: definition?.name,
      input_schema: definition?.inputSchema,
    })

    const result = await session.execute(
      definition?.name ?? "",
      { path: "README.md" },
      {
        signal: controller.signal,
        limits: { maxLines: 50, maxBytes: 2_000 },
      }
    )
    expect(result).toEqual({ output: "document body" })
    expect(fake.callTool).toHaveBeenCalledWith(
      { name: "read_document", arguments: { path: "README.md" } },
      expect.objectContaining({
        signal: controller.signal,
        timeout: expect.any(Number),
      })
    )

    await session.close()
    await session.close()
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it("keeps duplicate server/tool labels collision-free", async () => {
    const first = fakeClient({
      tools: [
        {
          name: "lookup",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    })
    const second = fakeClient({
      tools: [
        {
          name: "lookup",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    })
    let index = 0
    const session = await DirectMcpToolSession.open({
      cwd: "/project",
      signal: new AbortController().signal,
      resolver: async () => [
        { ...STDIO_SERVER, id: "one", name: "Same" },
        { ...STDIO_SERVER, id: "two", name: "Same" },
      ],
      clientFactory: async () => (index++ === 0 ? first.client : second.client),
    })

    const names = session.definitions().map((tool) => tool.name)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    expect(names.every((name) => /^mcp__/.test(name))).toBe(true)
    await session.close()
  })

  it("closes failed discoveries and every successful connection", async () => {
    const failed = fakeClient({
      listError: new Error("stderr contained SECRET_VALUE"),
    })
    const successful = fakeClient({})
    let index = 0
    const session = await DirectMcpToolSession.open({
      cwd: "/project",
      signal: new AbortController().signal,
      resolver: async () => [
        { ...STDIO_SERVER, id: "bad" },
        { ...STDIO_SERVER, id: "good" },
      ],
      clientFactory: async () =>
        index++ === 0 ? failed.client : successful.client,
    })

    expect(session.definitions()).toHaveLength(1)
    expect(failed.close).toHaveBeenCalledTimes(1)
    expect(successful.close).not.toHaveBeenCalled()
    await session.close()
    expect(successful.close).toHaveBeenCalledTimes(1)
  })

  it("does not leak transport secrets through failures and bounds output", async () => {
    const failed = fakeClient({
      callError: new Error(
        "Authorization: Bearer configured-secret at https://secret.invalid"
      ),
    })
    const session = await DirectMcpToolSession.open({
      cwd: "/project",
      signal: new AbortController().signal,
      resolver: async () => [STDIO_SERVER],
      clientFactory: async () => failed.client,
    })
    const [tool] = session.definitions()
    const result = await session.execute(
      tool?.name ?? "",
      {},
      {
        signal: new AbortController().signal,
        limits: { maxLines: 2, maxBytes: 100 },
      }
    )
    expect(result).toEqual({
      output: "Error: MCP tool execution failed.",
      error: "MCP tool execution failed.",
    })
    expect(JSON.stringify(result)).not.toContain("configured-secret")
    expect(JSON.stringify(result)).not.toContain("secret.invalid")
    await session.close()

    const large = fakeClient({
      result: {
        content: [
          {
            type: "text",
            text: "configured-secret\nsecond\nthird\nfourth",
          },
        ],
      },
    })
    const bounded = await DirectMcpToolSession.open({
      cwd: "/project",
      signal: new AbortController().signal,
      resolver: async () => [STDIO_SERVER],
      clientFactory: async () => large.client,
    })
    const [boundedTool] = bounded.definitions()
    const boundedResult = await bounded.execute(
      boundedTool?.name ?? "",
      {},
      {
        signal: new AbortController().signal,
        limits: { maxLines: 2, maxBytes: 100 },
      }
    )
    expect(boundedResult.output).toBe(
      "[REDACTED]\nsecond\n… [output truncated]"
    )
    await bounded.close()
  })

  it("redacts secrets before result and description truncation", async () => {
    const secret = "sensitive-token-" + "z".repeat(200)
    const fake = fakeClient({
      tools: [
        {
          name: "lookup",
          description: "x".repeat(2_000) + secret,
          inputSchema: { type: "object" },
        },
      ],
      result: {
        content: [{ type: "text", text: secret + " trailing result" }],
      },
    })
    const signal = new AbortController().signal
    const session = await DirectMcpToolSession.open({
      cwd: "/project",
      signal,
      resolver: async () => [{ ...STDIO_SERVER, env: { TOKEN: secret } }],
      clientFactory: async () => fake.client,
    })
    try {
      const [tool] = session.definitions()
      const result = await session.execute(
        tool!.name,
        {},
        { signal, limits: { maxLines: 10, maxBytes: 64 } }
      )
      expect(result.output).not.toContain("sensitive-token-")
      expect(result.output).toContain("[REDACTED]")
      expect(tool!.description).not.toContain("sensitive-token-")
      expect(tool!.description.length).toBeLessThanOrEqual(2_048)
    } finally {
      await session.close()
    }
  })

  it("includes the truncation marker in the byte budget after line truncation", async () => {
    const fake = fakeClient({
      result: {
        content: [{ type: "text", text: "x".repeat(95) + "\nsecond" }],
      },
    })
    const signal = new AbortController().signal
    const session = await DirectMcpToolSession.open({
      cwd: "/project",
      signal,
      resolver: async () => [STDIO_SERVER],
      clientFactory: async () => fake.client,
    })
    try {
      const result = await session.execute(
        session.definitions()[0]!.name,
        {},
        { signal, limits: { maxLines: 1, maxBytes: 100 } }
      )
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(100)
      expect(result.output).toContain("output truncated")
    } finally {
      await session.close()
    }
  })

  it("only enables external MCP tools in agent-capable modes", () => {
    expect(directMcpEnabledForMode("agent")).toBe(true)
    expect(directMcpEnabledForMode("debug")).toBe(true)
    expect(directMcpEnabledForMode(null)).toBe(true)
    expect(directMcpEnabledForMode("plan")).toBe(false)
    expect(directMcpEnabledForMode("ask")).toBe(false)
    expect(directMcpEnabledForMode("security")).toBe(false)
    expect(directMcpEnabledForMode("Plan")).toBe(false)
    expect(directMcpEnabledForMode("nope")).toBe(false)
  })

  it("rejects legacy SSE and non-loopback plaintext HTTP before connecting", async () => {
    await expect(
      connectDirectMcpClient(
        {
          id: "legacy",
          name: "Legacy",
          transport: "sse",
          url: "https://example.invalid/sse",
          headers: {},
        },
        "/project",
        new AbortController().signal
      )
    ).rejects.toThrow("MCP connection failed.")

    await expect(
      connectDirectMcpClient(
        {
          id: "plain-remote",
          name: "Plain remote",
          transport: "http",
          url: "http://example.invalid/mcp",
          headers: {},
        },
        "/project",
        new AbortController().signal
      )
    ).rejects.toThrow("MCP connection failed.")
  })

  it("connects to a portable stdio server through the installed MCP SDK", async () => {
    const script = [
      'const rl=require("node:readline").createInterface({input:process.stdin});',
      'rl.on("line",line=>{let m;try{m=JSON.parse(line)}catch{return};',
      'if(!Object.prototype.hasOwnProperty.call(m,"id"))return;',
      "let result={};",
      'if(m.method==="initialize")result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"test",version:"1"}};',
      'if(m.method==="tools/list")result={tools:[{name:"echo",description:"Echo",inputSchema:{type:"object",properties:{text:{type:"string"}}}}]};',
      'if(m.method==="tools/call")result={content:[{type:"text",text:String(m.params.arguments.text)+" "+process.env.PROJECT_TOKEN}]};',
      'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n")});',
    ].join("")
    const controller = new AbortController()
    const session = await DirectMcpToolSession.open({
      cwd: process.cwd(),
      signal: controller.signal,
      resolver: async () => [
        {
          id: "stdio-test",
          name: "Stdio Test",
          transport: "stdio",
          command: process.execPath,
          args: ["-e", script],
          env: { PROJECT_TOKEN: "stdio-secret" },
        },
      ],
    })
    const [tool] = session.definitions()
    expect(tool?.name).toMatch(/^mcp__/)
    const result = await session.execute(
      tool?.name ?? "",
      { text: "hello" },
      {
        signal: controller.signal,
        limits: { maxLines: 20, maxBytes: 2_000 },
      }
    )
    expect(result).toEqual({ output: "hello [REDACTED]" })
    await session.close()
  }, 15_000)

  it("connects to a loopback streamable HTTP server and forwards safe headers", async () => {
    const seenAuthorization: string[] = []
    const server = createServer((request, response) => {
      if (request.method !== "POST") {
        response.statusCode = request.method === "DELETE" ? 200 : 405
        response.end()
        return
      }
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        const message = JSON.parse(body) as {
          id?: string | number
          method: string
          params?: Record<string, unknown>
        }
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          response.statusCode = 202
          response.end()
          return
        }
        seenAuthorization.push(request.headers.authorization ?? "")
        let result: Record<string, unknown> = {}
        if (message.method === "initialize") {
          const params = message.params ?? {}
          result = {
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "http-test", version: "1" },
          }
        } else if (message.method === "tools/list") {
          result = {
            tools: [
              {
                name: "ping",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }
        } else if (message.method === "tools/call") {
          result = { content: [{ type: "text", text: "pong" }] }
        }
        response.statusCode = 200
        response.setHeader("content-type", "application/json")
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result,
          })
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as AddressInfo
    let client: DirectMcpClient | null = null
    try {
      client = await connectDirectMcpClient(
        {
          id: "http-test",
          name: "HTTP Test",
          transport: "http",
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: "Bearer http-secret" },
        },
        process.cwd(),
        new AbortController().signal
      )
      const listed = await client.listTools({
        signal: new AbortController().signal,
        timeout: 5_000,
        maxTotalTimeout: 5_000,
      })
      expect(listed.tools.map((tool) => tool.name)).toEqual(["ping"])
      const result = await client.callTool(
        { name: "ping", arguments: {} },
        {
          signal: new AbortController().signal,
          timeout: 5_000,
          maxTotalTimeout: 5_000,
        }
      )
      expect(result).toMatchObject({
        content: [{ type: "text", text: "pong" }],
      })
      expect(seenAuthorization).toContain("Bearer http-secret")
    } finally {
      await client?.close()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 15_000)
})
