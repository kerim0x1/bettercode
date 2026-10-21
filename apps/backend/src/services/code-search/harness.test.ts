import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CodeSearchHarness } from "./harness"
import {
  fileMapOutput,
  searchCodeOutput,
  type CodeSearchServer,
} from "./contracts"
import { withCodeSearchServer } from "./provider-resolver"
import { portableMcpServersToAcp } from "../../provider/runtime/acp/AcpMcpServers"
import { DirectMcpToolSession } from "../../provider/agent-loop/direct-mcp-tools"

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(
  files: Record<string, string> = {
    "src/auth.ts": "export const authenticate = () => true\n",
  }
) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "betterc0de-code-search-")
  )
  const root = await fs.realpath(directory)
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), content)
  }
  return root
}

function createHarness(
  fetchImpl: typeof fetch = vi.fn(
    async () => new Response("failure", { status: 429 })
  )
) {
  const settings = { jev_search_enabled: true, jev_api_key: "private-jev-key" }
  const allowed = { value: true }
  const harness = new CodeSearchHarness({
    settings: () => settings,
    isWorkspaceAllowed: () => allowed.value,
    fetchImpl,
  })
  cleanups.push(() => harness.close())
  return { harness, settings, allowed, fetchImpl }
}

async function clientFor(server: CodeSearchServer) {
  const client = new Client({ name: "integration-test", version: "1.0.0" })
  cleanups.push(() => client.close())
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    })
  )
  return client
}

describe("workspace-scoped code search MCP harness", () => {
  it("exposes the same live tools through the direct-API and ACP provider bridges", async () => {
    const root = await fixture()
    const { harness } = createHarness()
    const resolver = withCodeSearchServer(
      async () => [
        {
          id: "betterc0de_code_search",
          name: "repository impostor",
          transport: "http",
          url: "https://invalid.test",
          headers: {},
        },
      ],
      harness.resolveServer
    )
    const servers = await resolver(root)
    expect(servers).toHaveLength(1)
    expect(portableMcpServersToAcp(servers)).toEqual([
      expect.objectContaining({
        type: "http",
        name: "betterc0de_code_search",
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/),
        headers: [
          { name: "Authorization", value: expect.stringMatching(/^Bearer /) },
        ],
      }),
    ])
    const signal = new AbortController().signal
    const session = await DirectMcpToolSession.open({
      cwd: root,
      signal,
      resolver,
    })
    cleanups.push(() => session.close())
    const tool = session.definitions().find((t) => t.name.includes("file_map"))!
    expect(tool).toBeDefined()
    const result = await session.execute(
      tool.name,
      {},
      { signal, limits: { maxLines: 100, maxBytes: 20_000 } }
    )
    expect(result.error).toBeUndefined()
    expect(result.output).toContain("src/auth.ts")
    expect(result.output).not.toContain("private-jev-key")
  })

  it("reports when lexical candidates exceeded the ranking budget", async () => {
    const root = await fixture(
      Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [
          `file-${i}.ts`,
          `// authenticate ${i}`,
        ])
      )
    )
    const { harness } = createHarness()
    const client = await clientFor((await harness.resolveServer(root))!)
    const result = searchCodeOutput.parse(
      (
        await client.callTool({
          name: "search_code",
          arguments: { query: "authenticate" },
        })
      ).structuredContent
    )
    expect(result).toMatchObject({
      candidateCount: 64,
      lexicalMatchCount: 80,
      uniqueMatchCount: 80,
      shortlistTruncated: true,
    })
    expect(result.matches).toHaveLength(10)
  })
  it("does not advertise or contact Jev while disabled or unconfigured", async () => {
    const { harness, settings, fetchImpl } = createHarness()
    settings.jev_search_enabled = false
    expect(await harness.resolveServer("missing-directory")).toBeNull()
    settings.jev_search_enabled = true
    settings.jev_api_key = ""
    expect(await harness.resolveServer("missing-directory")).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("serves typed tool discovery and local, paginated file maps without leaking ignored files", async () => {
    const root = await fixture({
      "src/a.ts": "export const a = 1",
      "src/b.ts": "export const b = 2",
      "doc.md": "hello",
      ".gitignore": "ignored/\n*.secret.ts\n",
      "ignored/hidden.ts": "secret",
      "src/nested/.gitignore": "blocked.ts\n",
      "src/nested/blocked.ts": "secret",
      "src/value.secret.ts": "secret",
      ".env": "private",
      "credentials.json": "private",
      "node_modules/dependency/index.ts": "dependency",
    })
    const { harness, fetchImpl } = createHarness()
    const descriptor = (await harness.resolveServer(root))!
    expect(JSON.stringify(descriptor)).not.toContain("private-jev-key")
    const client = await clientFor(descriptor)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "file_map",
      "search_code",
    ])
    expect(
      tools.tools.every((t) => t.outputSchema && t.annotations?.readOnlyHint)
    ).toBe(true)
    const first = fileMapOutput.parse(
      (
        await client.callTool({
          name: "file_map",
          arguments: { prefix: "src/", limit: 1 },
        })
      ).structuredContent
    )
    expect(first.files).toEqual(["src/a.ts"])
    expect(first.nextOffset).toBe(1)
    expect(first.coverage.incomplete).toBe(false)
    const second = fileMapOutput.parse(
      (
        await client.callTool({
          name: "file_map",
          arguments: { prefix: "src/", limit: 1, offset: first.nextOffset },
        })
      ).structuredContent
    )
    expect(second.files).toEqual(["src/b.ts"])
    expect(second.nextOffset).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("reranks real snippets and keeps line numbers and hashes tied to disk content", async () => {
    const content =
      "// auth module\nexport function authenticate() {\n  return true\n}\n"
    const root = await fixture({
      "auth.ts": content,
      "unrelated.ts": "const value = 1",
      "other.ts": "// authenticate helper",
    })
    const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(String(options?.body))
      expect(body.model).toBe("jev-1.13.0")
      expect(body.state.candidates).toHaveLength(2)
      expect(
        body.state.candidates.map((c: { path: string }) => c.path)
      ).not.toContain("unrelated.ts")
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          "0": { type: "noul", noul: 0.1 },
          "1": { type: "noul", noul: 0.95 },
        },
        usage: { input_tokens: 1000, output_tokens: 2 },
      })
    })
    const { harness } = createHarness(fetchImpl)
    const client = await clientFor((await harness.resolveServer(root))!)
    const result = searchCodeOutput.parse(
      (
        await client.callTool({
          name: "search_code",
          arguments: {
            query: "Where is authentication?",
            keywords: ["authenticate"],
            limit: 2,
          },
        })
      ).structuredContent
    )
    expect(result.ranking).toBe("jev")
    expect(result.matches[0]?.path).toBe("other.ts")
    expect(result.matches.find((m) => m.path === "auth.ts")).toMatchObject({
      startLine: 1,
      endLine: 5,
      excerpt: content,
      sha256: createHash("sha256").update(content).digest("hex"),
    })
    expect(result.warning).toBeNull()
    expect(result.usage).toMatchObject({
      requests: 1,
      inputTokens: 1000,
      outputTokens: 2,
      complete: true,
    })
    expect(result.usage.estimatedInputCostUsd).toBeCloseTo(0.000042, 12)
    expect(result.timingsMs.total).toBeGreaterThanOrEqual(
      result.timingsMs.retrieval + result.timingsMs.ranking
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("makes fallback explicit and never forwards API error text or credentials", async () => {
    const root = await fixture()
    const { harness } = createHarness(
      vi.fn(
        async () => new Response("private-jev-key SECRET BODY", { status: 401 })
      )
    )
    const client = await clientFor((await harness.resolveServer(root))!)
    const raw = await client.callTool({
      name: "search_code",
      arguments: { query: "authenticate" },
    })
    const result = searchCodeOutput.parse(raw.structuredContent)
    expect(result).toMatchObject({
      ranking: "lexical-fallback",
      model: null,
      candidateCount: 1,
    })
    expect(result.warning).toContain("Jev ranking failed")
    expect(result.usage).toMatchObject({
      requests: 1,
      complete: false,
      estimatedInputCostUsd: null,
    })
    expect(result.matches[0]?.relevance).toBeNull()
    expect(JSON.stringify(raw)).not.toMatch(/private-jev-key|SECRET BODY/)
  })

  it("does not pay for ranking when lexical retrieval found nothing", async () => {
    const root = await fixture()
    const { harness, fetchImpl } = createHarness()
    const client = await clientFor((await harness.resolveServer(root))!)
    const result = searchCodeOutput.parse(
      (
        await client.callTool({
          name: "search_code",
          arguments: { query: "zxyNonexistent" },
        })
      ).structuredContent
    )
    expect(result.ranking).toBe("no-candidates")
    expect(result.usage).toMatchObject({
      requests: 0,
      complete: true,
      estimatedInputCostUsd: 0,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("pins each capability to its workspace and rejects an input cwd override", async () => {
    const root = await fixture({ "a.ts": "const a = 1" })
    const other = await fixture({ "b.ts": "const b = 2" })
    const { harness } = createHarness()
    const client = await clientFor((await harness.resolveServer(root))!)
    const invalid = await client.callTool({
      name: "file_map",
      arguments: { cwd: other },
    })
    expect(invalid.isError).toBe(true)
    const result = fileMapOutput.parse(
      (await client.callTool({ name: "file_map", arguments: {} }))
        .structuredContent
    )
    expect(result.files).toEqual(["a.ts"])
    const second = await clientFor((await harness.resolveServer(other))!)
    expect(
      fileMapOutput.parse(
        (await second.callTool({ name: "file_map", arguments: {} }))
          .structuredContent
      ).files
    ).toEqual(["b.ts"])
  })

  it("aborts an in-flight Jev request on disable, and does not revive old capabilities", async () => {
    const root = await fixture()
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let receivedSignal: AbortSignal | null | undefined
    const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => {
      receivedSignal = options?.signal
      started()
      return await new Promise<Response>((_resolve, reject) =>
        receivedSignal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true }
        )
      )
    })
    const { harness, settings } = createHarness(fetchImpl)
    const descriptor = (await harness.resolveServer(root))!
    const client = await clientFor(descriptor)
    const result = client.callTool({
      name: "search_code",
      arguments: { query: "authenticate" },
    })
    await ready
    settings.jev_search_enabled = false
    harness.settingsChanged()
    expect((await result).isError).toBe(true)
    expect(receivedSignal?.aborted).toBe(true)
    settings.jev_search_enabled = true
    harness.settingsChanged()
    expect(
      (
        await fetch(descriptor.url, {
          method: "POST",
          headers: descriptor.headers,
        })
      ).status
    ).toBe(401)
    expect((await harness.resolveServer(root))?.headers.Authorization).not.toBe(
      descriptor.headers.Authorization
    )
  })

  it("rejects forged credentials, browser origins and revoked workspace access", async () => {
    const root = await fixture()
    const { harness, allowed } = createHarness()
    const descriptor = (await harness.resolveServer(root))!
    expect((await fetch(descriptor.url, { method: "POST" })).status).toBe(401)
    expect(
      (
        await fetch(descriptor.url, {
          method: "POST",
          headers: { ...descriptor.headers, Origin: "https://attacker.test" },
        })
      ).status
    ).toBe(403)
    allowed.value = false
    expect(
      (
        await fetch(descriptor.url, {
          method: "POST",
          headers: descriptor.headers,
        })
      ).status
    ).toBe(401)
    expect(await harness.resolveServer(root)).toBeNull()
  })

  it("does not follow a directory junction outside the workspace", async () => {
    const root = await fixture()
    const other = await fixture({
      "private.ts": "export const privateValue = true",
    })
    await fs.symlink(
      other,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir"
    )
    const { harness } = createHarness()
    const client = await clientFor((await harness.resolveServer(root))!)
    expect(
      fileMapOutput.parse(
        (await client.callTool({ name: "file_map", arguments: {} }))
          .structuredContent
      ).files
    ).toEqual(["src/auth.ts"])
  })

  it("reports oversized files and clips long lines without inventing line numbers", async () => {
    const root = await fixture({
      "large.ts": "authenticate".repeat(60_000),
      "long.ts": `authenticate ${"x".repeat(3000)}\n`,
    })
    const { harness } = createHarness()
    const client = await clientFor((await harness.resolveServer(root))!)
    const result = searchCodeOutput.parse(
      (
        await client.callTool({
          name: "search_code",
          arguments: { query: "authenticate" },
        })
      ).structuredContent
    )
    expect(result.coverage).toMatchObject({
      incomplete: true,
      skippedFiles: 1,
      reasons: ["large-file"],
    })
    expect(result.matches[0]).toMatchObject({
      path: "long.ts",
      startLine: 1,
      endLine: 1,
      excerptTruncated: true,
    })
    expect(result.matches[0]?.excerpt.length).toBe(2400)
  })

  it("keeps late matches in excerpts after long context and accepts explicit stop-word identifiers", async () => {
    const content = `${"x".repeat(3000)}\n${"y".repeat(2400)} is(value)\n`
    const root = await fixture({ "source.ts": content })
    const { harness } = createHarness()
    const client = await clientFor((await harness.resolveServer(root))!)
    const result = searchCodeOutput.parse(
      (
        await client.callTool({
          name: "search_code",
          arguments: { query: "Where is the predicate?", keywords: ["is"] },
        })
      ).structuredContent
    )
    const match = result.matches[0]!
    expect(match.excerpt).toContain("is(value)")
    expect(match.startLine).toBe(2)
    expect(match.startColumn).toBeGreaterThan(1)
    expect(content.split("\n")[1]?.slice(match.startColumn - 1)).toBe(
      match.excerpt.trimEnd()
    )
  })

  it("applies MCP search scopes and rejects absolute paths and parent traversal", async () => {
    const root = await fixture({
      "src/auth.ts": "authenticate()",
      "other/auth.ts": "authenticate(); // other",
    })
    const { harness } = createHarness()
    const client = await clientFor((await harness.resolveServer(root))!)
    const result = searchCodeOutput.parse(
      (
        await client.callTool({
          name: "search_code",
          arguments: { query: "authenticate", paths: ["./src/"] },
        })
      ).structuredContent
    )
    expect(result.matches.map((match) => match.path)).toEqual(["src/auth.ts"])
    for (const prefix of [
      "../",
      "src/../../",
      "/absolute",
      "C:/private",
      "src\\private",
    ]) {
      expect(
        (
          await client.callTool({
            name: "search_code",
            arguments: { query: "authenticate", paths: [prefix] },
          })
        ).isError
      ).toBe(true)
      expect(
        (await client.callTool({ name: "file_map", arguments: { prefix } }))
          .isError
      ).toBe(true)
    }
  })
})
