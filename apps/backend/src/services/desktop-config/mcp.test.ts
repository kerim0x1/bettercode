import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  promptMcpsFromServers,
  resolveConfiguredMcpServers,
  type ConfiguredMcpState,
} from "./mcp"

const temporary: string[] = []

function directory(prefix: string): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporary.push(created)
  return created
}

beforeEach(() => {
  // Keep the machine's own global BetterC0de configuration out.
  const isolated = directory("bc0de-mcp-global-")
  vi.stubEnv("XDG_CONFIG_HOME", isolated)
  vi.stubEnv("BetterC0de_TEST_HOME", isolated)
  vi.stubEnv("BETTERC0DE_TEST_MANAGED_CONFIG_DIR", isolated)
  vi.stubEnv("BETTERC0DE_CONFIG_CONTENT", "")
  vi.stubEnv("BETTERC0DE_HOME", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const created of temporary.splice(0)) {
    fs.rmSync(created, { recursive: true, force: true })
  }
})

function state(
  home: string,
  options: {
    dataDir?: string
    settings?: Record<string, unknown>
    trusted?: (cwd: string) => boolean
  } = {}
): ConfiguredMcpState {
  return {
    config: {
      dataDir: options.dataDir ?? path.join(home, "userdata"),
      runtimeHome: home,
    },
    settings: { get: () => options.settings ?? {} },
    ...(options.trusted
      ? {
          agentPermissions: {
            getWorkspaceTrust: (cwd: string) => ({
              state: options.trusted!(cwd) ? "trusted" : "untrusted",
              explicit: true,
            }),
          },
        }
      : {}),
  } as unknown as ConfiguredMcpState
}

function writeStore(home: string, entries: unknown[]) {
  fs.writeFileSync(path.join(home, "mcp-servers.json"), JSON.stringify(entries))
}

describe("the configured MCP servers (one list for turns and prompts)", () => {
  it("reads the desktop store of the runtime home, whatever the data folder is called", async () => {
    const home = directory("bc0de-mcp-home-")
    const dataDir = directory("bc0de-custom-data-")
    writeStore(home, [
      { id: "files", name: "files", command: "npx", args: ["mcp-files"] },
      { id: "off", name: "off", command: "npx", enabled: false },
    ])
    const servers = await resolveConfiguredMcpServers(
      state(home, { dataDir }),
      ""
    )
    expect(servers.map((server) => server.id)).toEqual(["files"])
    expect(promptMcpsFromServers(servers)).toEqual([
      { name: "files", command: "npx", args: ["mcp-files"] },
    ])
  })

  it("lists a project's own servers only where the project is explicitly trusted", async () => {
    const home = directory("bc0de-mcp-home-")
    const project = directory("bc0de-mcp-project-")
    writeStore(home, [
      { id: "user", name: "user", command: "node", args: ["user.js"] },
      {
        id: "repo",
        name: "repo",
        command: "node",
        args: ["repo.js"],
        scope: "project",
        projectRoot: project,
      },
    ])
    const ids = async (cwd: string, trusted?: (cwd: string) => boolean) =>
      (await resolveConfiguredMcpServers(state(home, { trusted }), cwd)).map(
        (server) => server.id
      )
    expect(await ids(project)).toEqual(["user"])
    expect(await ids(project, () => false)).toEqual(["user"])
    expect(await ids(project, () => true)).toEqual(["repo", "user"])
    // Not in another folder, and not without a folder.
    expect(await ids(directory("bc0de-mcp-other-"), () => true)).toEqual([
      "user",
    ])
    expect(await ids("", () => true)).toEqual(["user"])
  })

  it("still honors settings.mcp_servers while the migration could not remove them", async () => {
    const home = directory("bc0de-mcp-home-")
    const servers = await resolveConfiguredMcpServers(
      state(home, {
        settings: {
          mcp_servers: [
            {
              id: "legacy",
              name: "Legacy",
              command: "node",
              args: "legacy.js",
              envVars: "TOKEN=t",
              enabled: true,
            },
          ],
        },
      }),
      ""
    )
    expect(servers).toEqual([
      {
        id: "legacy",
        name: "Legacy",
        transport: "stdio",
        command: "node",
        args: ["legacy.js"],
        env: { TOKEN: "t" },
      },
    ])
  })

  it("names a remote server by its URL in the prompt's view", () => {
    expect(
      promptMcpsFromServers([
        {
          id: "remote",
          name: "remote",
          transport: "http",
          url: "https://mcp.example",
          headers: {},
        },
      ])
    ).toEqual([{ name: "remote", command: "https://mcp.example", args: [] }])
  })
})
