import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/chat-store", () => ({ useActiveThread: () => null }))
vi.mock("@/lib/runtime-config", () => ({
  RUNTIME_MCP_SECRET_PLACEHOLDER: "••••••••",
  canManageRuntimeConfig: vi.fn(() => true),
  deleteRuntimeMcp: vi.fn(),
  listRuntimeMcps: vi.fn(),
  probeRuntimeMcp: vi.fn(),
  saveRuntimeMcp: vi.fn(),
  setRuntimeMcpEnabled: vi.fn(),
}))
vi.mock("@/lib/cli-scan-context", () => ({
  describeCliScanProjectScope: (scope: { status?: string } | undefined) =>
    scope?.status === "untrusted"
      ? " User config only; project config was skipped because the workspace is not trusted."
      : "",
  resolveCliScanContext: vi.fn(),
}))

import type { RuntimeMcpServer } from "@/lib/runtime-config"
import {
  EMPTY_MCP_FORM,
  buildMcpSavePayload,
  describeMcpSync,
  mcpActionErrorMessage,
  mcpFormFromServer,
  mcpTransportOf,
  parseHeaderText,
} from "./mcp-section"

const PLACEHOLDER = "••••••••"

function server(overrides: Partial<RuntimeMcpServer>): RuntimeMcpServer {
  return {
    id: "server",
    name: "Server",
    command: "",
    args: [],
    env: {},
    enabled: true,
    ...overrides,
  }
}

describe("mcpTransportOf", () => {
  it("reads command, HTTP and SSE servers, and other remote kinds as HTTP", () => {
    expect(mcpTransportOf({ type: "command", command: "npx" })).toBe("command")
    expect(mcpTransportOf({ type: "sse", url: "https://x.test" })).toBe("sse")
    expect(mcpTransportOf({ type: "http", url: "https://x.test" })).toBe("http")
    expect(mcpTransportOf({ type: "oauth", url: "https://x.test" })).toBe(
      "http"
    )
    // Older records without a type.
    expect(mcpTransportOf({ command: "node" })).toBe("command")
    expect(mcpTransportOf({ url: "https://x.test" })).toBe("http")
  })
})

describe("parseHeaderText", () => {
  it("splits at the first colon and reports lines that are not headers", () => {
    expect(
      parseHeaderText(
        "Authorization: Bearer a:b\n\nX-Team:platform\nnot a header\n: empty"
      )
    ).toEqual({
      headers: { Authorization: "Bearer a:b", "X-Team": "platform" },
      invalidLines: [4, 5],
    })
  })
})

describe("editing a remote server", () => {
  const remote = server({
    id: "linear",
    name: "Linear",
    type: "http",
    url: "https://mcp.linear.app/sse",
    headers: { Authorization: PLACEHOLDER },
    headerEnv: { "X-Token": "LINEAR_TOKEN" },
    source: "claude",
  })

  it("shows its URL and headers instead of an empty command", () => {
    const { form, edit } = mcpFormFromServer(remote)
    expect(form.transport).toBe("http")
    expect(form.url).toBe("https://mcp.linear.app/sse")
    expect(form.headersText).toBe(`Authorization: ${PLACEHOLDER}`)
    expect(form.command).toBe("")
    expect(edit.headerEnvKeys).toEqual(["X-Token"])
  })

  it("saves the URL and type and sends kept secrets back as placeholders", () => {
    const { form, edit } = mcpFormFromServer(remote)
    const built = buildMcpSavePayload(form, edit)
    expect(built).toEqual({
      ok: true,
      payload: {
        id: "linear",
        name: "Linear",
        type: "http",
        enabled: true,
        command: "",
        args: [],
        url: "https://mcp.linear.app/sse",
        env: {},
        headers: { Authorization: PLACEHOLDER },
      },
    })
    // Headers filled from environment variables are not sent, so they stay.
    expect(built.ok && "headerEnv" in built.payload).toBe(false)
  })

  it("keeps an older store's headers in env, where their values are stored", () => {
    const legacy = server({
      id: "legacy",
      name: "Legacy",
      type: "sse",
      url: "https://legacy.test/sse",
      env: { "X-Api-Key": PLACEHOLDER },
    })
    const { form, edit } = mcpFormFromServer(legacy)
    expect(form.headersText).toBe(`X-Api-Key: ${PLACEHOLDER}`)
    const built = buildMcpSavePayload(
      { ...form, headersText: `${form.headersText}\nX-New: value` },
      edit
    )
    expect(built.ok && built.payload.env).toEqual({ "X-Api-Key": PLACEHOLDER })
    expect(built.ok && built.payload.headers).toEqual({ "X-New": "value" })
  })

  it("keeps a stored remote kind such as oauth while the transport is unchanged", () => {
    const oauth = server({ type: "oauth", url: "https://x.test/mcp" })
    const { form, edit } = mcpFormFromServer(oauth)
    const built = buildMcpSavePayload(form, edit)
    expect(built.ok && built.payload.type).toBe("oauth")
  })

  it("clears the headers when a remote server becomes a command server", () => {
    const { form, edit } = mcpFormFromServer(remote)
    const built = buildMcpSavePayload(
      { ...form, transport: "command", command: "linear-mcp" },
      edit
    )
    expect(built).toMatchObject({
      ok: true,
      payload: {
        type: "command",
        command: "linear-mcp",
        url: null,
        headers: {},
        headerEnv: {},
      },
    })
  })

  it("refuses a URL that is not http(s)", () => {
    const { form, edit } = mcpFormFromServer(remote)
    expect(buildMcpSavePayload({ ...form, url: "ftp://x" }, edit)).toEqual({
      ok: false,
      error: "Enter an http:// or https:// URL.",
    })
  })
})

describe("buildMcpSavePayload for a new server", () => {
  it("needs a name and a command", () => {
    expect(buildMcpSavePayload(EMPTY_MCP_FORM, null)).toEqual({
      ok: false,
      error: "Enter a name.",
    })
    expect(
      buildMcpSavePayload({ ...EMPTY_MCP_FORM, name: "Files" }, null)
    ).toEqual({
      ok: false,
      error: "Enter the command that starts the server.",
    })
  })

  it("keeps an edited server's enabled state instead of switching it on", () => {
    const off = server({
      id: "off",
      name: "Off",
      command: "node",
      enabled: false,
    })
    const { form, edit } = mcpFormFromServer(off)
    const built = buildMcpSavePayload(form, edit)
    expect(built.ok && built.payload.enabled).toBe(false)
    expect(built.ok && "headers" in built.payload).toBe(false)
  })

  it("adds a command server with its arguments and environment", () => {
    expect(
      buildMcpSavePayload(
        {
          ...EMPTY_MCP_FORM,
          name: "My Files",
          command: "npx",
          args: '-y "@scope/server files"',
          envText: "ROOT=/tmp",
        },
        null
      )
    ).toEqual({
      ok: true,
      payload: {
        id: "my-files",
        name: "My Files",
        type: "command",
        enabled: true,
        command: "npx",
        args: ["-y", "@scope/server files"],
        env: { ROOT: "/tmp" },
        url: null,
      },
    })
  })
})

describe("mcpActionErrorMessage", () => {
  it("words a declined approval as a decision", () => {
    expect(
      mcpActionErrorMessage(
        new Error(
          "The MCP server was not saved because its command was not allowed."
        ),
        "Not saved"
      )
    ).toBe("Not saved: the command wasn't approved.")
    expect(mcpActionErrorMessage(new Error("Disk full"), "Not saved")).toBe(
      "Not saved: Disk full"
    )
  })
})

describe("describeMcpSync", () => {
  const base = {
    ok: true,
    imported: { mcpServers: 0, skills: 0, agents: 0 },
    total: { mcpServers: 0, skills: 0, agents: 0 },
  }

  it("says when neither CLI is installed", () => {
    expect(
      describeMcpSync({ ...base, found: { claude: false, codex: false } })
    ).toEqual({
      title: "Claude Code and Codex aren't installed on this computer.",
      details: [],
    })
  })

  it("reports what was imported and names the servers it skipped", () => {
    expect(
      describeMcpSync({
        ...base,
        imported: { mcpServers: 2, skills: 1, agents: 0 },
        found: { claude: true, codex: true },
        skippedMcpServers: [
          {
            id: "db",
            name: "Db",
            source: "codex",
            reason: "The source has a malformed MCP args list.",
          },
        ],
        skippedWorkspaceAssets: 1,
        projectScope: {
          status: "untrusted",
          projectPath: "/repo",
          workspaceTrusted: false,
        },
      })
    ).toEqual({
      title: "Imported 2 MCP servers.",
      details: [
        "Also imported 1 skill.",
        "Skipped Db (Codex): The source has a malformed MCP args list.",
        "Left out 1 project item: they apply only in their own project.",
        "User config only; project config was skipped because the workspace is not trusted.",
      ],
    })
  })

  it("says when there was nothing new", () => {
    expect(describeMcpSync(base).title).toBe("No new MCP servers to import.")
  })
})
