import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const {
  scanClaude,
  scanCodex,
  parseTomlConfig,
  resolveClaudeConfigDir,
} = require("../apps/shell/cli-scanner.cjs")
const { normalizeMcpConfig } = require("../apps/shell/mcp-ipc.cjs")
const {
  resolveCliScanContext,
  scanCliAssets,
} = require("../apps/shell/onboarding-ipc.cjs")
const { parseMarkdownAgent } = require("../apps/shell/subagents-ipc.cjs")
const tempRoots = []

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true }))
  )
})

test("Codex scan includes native TOML agents alongside skills", async () => {
  const codexDir = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-codex-scan-"))
  tempRoots.push(codexDir)
  await fs.mkdir(path.join(codexDir, "skills", "review"), { recursive: true })
  await fs.writeFile(
    path.join(codexDir, "skills", "review", "SKILL.md"),
    "# Review\n",
    "utf8"
  )
  await fs.mkdir(path.join(codexDir, "agents"), { recursive: true })
  await fs.writeFile(
    path.join(codexDir, "agents", "executor.toml"),
    'name = "executor"\ndescription = "Implements changes"\n',
    "utf8"
  )

  const scan = await scanCodex({ codexDir, homeDir: path.dirname(codexDir) })

  assert.equal(scan.skills.length, 1)
  assert.deepEqual(scan.agents, [
    {
      id: "codex-agent-executor",
      name: "executor",
      description: "Implements changes",
      source: "codex",
      scope: "user",
      path: path.join(codexDir, "agents", "executor.toml"),
      sourcePath: path.join(codexDir, "agents", "executor.toml"),
    },
  ])
})

test("Codex scan imports command and URL MCP servers with config metadata", async () => {
  const codexDir = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-codex-mcp-"))
  tempRoots.push(codexDir)
  const configPath = path.join(codexDir, "config.toml")
  await fs.writeFile(
    configPath,
    [
      'model = "gpt-test"',
      "",
      "[features]",
      "collaboration = true",
      "",
      '[mcp_servers."local-files"]',
      'command = "node"',
      'args = ["server.js", "--safe"]',
      'env = { MODE = "readonly" }',
      "",
      '[mcp_servers."local-files".env]',
      'TOKEN_NAME = "from-env-only"',
      "",
      "[mcp_servers.remote]",
      'url = "https://mcp.example.test"',
      "enabled = false",
      "",
      "[mcp_servers.secure]",
      'url = "https://secure.example.test"',
      'bearer_token_env_var = "MCP_TOKEN"',
      "",
    ].join("\n"),
    "utf8"
  )

  const scan = await scanCodex({ codexDir, homeDir: path.dirname(codexDir) })

  assert.equal(scan.model, "gpt-test")
  assert.deepEqual(scan.features, { collaboration: true })
  assert.deepEqual(scan.configSources, [configPath])
  assert.deepEqual(scan.mcpServers, [
    {
      id: "local-files",
      name: "Local Files",
      source: "codex",
      type: "command",
      command: "node",
      args: ["server.js", "--safe"],
      env: { MODE: "readonly", TOKEN_NAME: "from-env-only" },
      enabled: true,
      authenticated: false,
      scope: "user",
      sourcePath: configPath,
    },
    {
      id: "remote",
      name: "Remote",
      source: "codex",
      type: "http",
      args: [],
      env: {},
      url: "https://mcp.example.test",
      enabled: false,
      authenticated: false,
      scope: "user",
      sourcePath: configPath,
    },
  ])
  assert.deepEqual(scan.skippedMcpServers, [
    {
      id: "secure",
      name: "Secure",
      source: "codex",
      scope: "user",
      sourcePath: configPath,
      reason:
        "The source uses MCP options that BetterC0de cannot import without changing their semantics.",
      unsupportedKeys: ["bearer_token_env_var"],
    },
  ])
})

test("Codex scan preserves static and environment-backed HTTP headers through import", async () => {
  const codexDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "bc0de-codex-headers-")
  )
  tempRoots.push(codexDir)
  const configPath = path.join(codexDir, "config.toml")
  await fs.writeFile(
    configPath,
    [
      "[mcp_servers.inline]",
      'url = "https://inline.example.test/mcp"',
      'http_headers = { "X-Static" = "literal", Authorization = "Basic public-config" }',
      'env_http_headers = { "X-Token" = "MCP_TOKEN" }',
      "",
      "[mcp_servers.tables]",
      'url = "https://tables.example.test/mcp"',
      "[mcp_servers.tables.http_headers]",
      '"X-Region" = "eu-central-1"',
      "[mcp_servers.tables.env_http_headers]",
      'Authorization = "MCP_AUTHORIZATION"',
      "",
      "[mcp_servers.malformed]",
      'url = "https://malformed.example.test/mcp"',
      'env_http_headers = { Authorization = "NOT-AN-ENV-NAME" }',
    ].join("\n"),
    "utf8"
  )

  const scan = await scanCodex({
    codexDir,
    homeDir: path.dirname(codexDir),
    environment: {
      MCP_TOKEN: "must-not-be-materialized",
      MCP_AUTHORIZATION: "also-must-not-be-materialized",
    },
  })

  assert.deepEqual(
    scan.skippedMcpServers.map(({ id, unsupportedKeys }) => ({
      id,
      unsupportedKeys,
    })),
    [
      {
        id: "malformed",
        unsupportedKeys: ["env_http_headers"],
      },
    ]
  )
  assert.deepEqual(
    scan.mcpServers.map(({ id, headers, headerEnv }) => ({
      id,
      headers,
      headerEnv,
    })),
    [
      {
        id: "inline",
        headers: {
          "X-Static": "literal",
          Authorization: "Basic public-config",
        },
        headerEnv: { "X-Token": "MCP_TOKEN" },
      },
      {
        id: "tables",
        headers: { "X-Region": "eu-central-1" },
        headerEnv: { Authorization: "MCP_AUTHORIZATION" },
      },
    ]
  )
  assert.equal(JSON.stringify(scan).includes("must-not-be-materialized"), false)

  const normalized = normalizeMcpConfig(scan.mcpServers[0])
  assert.deepEqual(
    {
      type: normalized.type,
      headers: normalized.headers,
      headerEnv: normalized.headerEnv,
    },
    {
      type: "http",
      headers: {
        "X-Static": "literal",
        Authorization: "Basic public-config",
      },
      headerEnv: { "X-Token": "MCP_TOKEN" },
    }
  )
  assert.deepEqual(
    normalizeMcpConfig({
      id: "legacy-remote",
      name: "Legacy Remote",
      type: "http",
      url: "https://legacy.example.test/mcp",
      env: { "X-Legacy-Header": "legacy-value" },
    }).env,
    { "X-Legacy-Header": "legacy-value" }
  )
})

test("production onboarding scan forwards only an explicit selected and trusted project root", async () => {
  const projectRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "bc0de-onboarding-project-")
  )
  tempRoots.push(projectRoot)
  const calls = []
  const dependencies = {
    scanClaude(options) {
      calls.push(["claude", options])
      return { source: "claude" }
    },
    scanCodex(options) {
      calls.push(["codex", options])
      return { source: "codex" }
    },
  }

  const withoutSelection = await scanCliAssets(undefined, dependencies)
  assert.deepEqual(withoutSelection.projectScope, {
    status: "not-selected",
    projectPath: null,
    workspaceTrusted: false,
  })
  assert.deepEqual(calls.splice(0), [
    ["claude", { workspaceTrusted: false }],
    ["codex", { workspaceTrusted: false }],
  ])

  const untrusted = await scanCliAssets(
    { projectPath: projectRoot, workspaceTrusted: true },
    dependencies
  )
  assert.deepEqual(untrusted.projectScope, {
    status: "untrusted",
    projectPath: projectRoot,
    workspaceTrusted: false,
  })
  assert.deepEqual(calls.splice(0), [
    [
      "claude",
      {
        cwd: projectRoot,
        projectRoot,
        workspaceTrusted: false,
      },
    ],
    [
      "codex",
      {
        cwd: projectRoot,
        projectRoot,
        workspaceTrusted: false,
      },
    ],
  ])

  // The backend's compatibility default (`trusted`, no stored record) is not
  // consent to read the repository's own CLI configuration.
  const compatibilityDefault = await scanCliAssets(
    { projectPath: projectRoot, workspaceTrusted: true },
    {
      ...dependencies,
      readWorkspaceTrust: async () => ({ state: "trusted", explicit: false }),
    }
  )
  assert.equal(compatibilityDefault.projectScope.status, "untrusted")
  assert.equal(compatibilityDefault.projectScope.workspaceTrusted, false)
  assert.deepEqual(
    calls.splice(0).map(([, options]) => options.workspaceTrusted),
    [false, false]
  )

  const trusted = await scanCliAssets(
    { projectPath: projectRoot, workspaceTrusted: false },
    {
      ...dependencies,
      readWorkspaceTrust: async () => ({ state: "trusted", explicit: true }),
    }
  )
  assert.equal(trusted.projectScope.status, "trusted")
  assert.deepEqual(calls.splice(0), [
    [
      "claude",
      {
        cwd: projectRoot,
        projectRoot,
        workspaceTrusted: true,
      },
    ],
    [
      "codex",
      {
        cwd: projectRoot,
        projectRoot,
        workspaceTrusted: true,
      },
    ],
  ])

  const rendererCannotOverride = await scanCliAssets(
    { projectPath: projectRoot, workspaceTrusted: true },
    {
      ...dependencies,
      readWorkspaceTrust: async () => ({ state: "untrusted", explicit: true }),
    }
  )
  assert.equal(rendererCannotOverride.projectScope.status, "untrusted")
  assert.equal(rendererCannotOverride.projectScope.workspaceTrusted, false)

  assert.deepEqual(await resolveCliScanContext({ projectPath: "relative/project" }), {
    scanOptions: { workspaceTrusted: false },
    projectScope: {
      status: "invalid",
      projectPath: null,
      workspaceTrusted: false,
    },
  })
})

test("Codex trusted project layers use closest config and agent while preserving duplicate skills", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-codex-project-"))
  tempRoots.push(root)
  const codexDir = path.join(root, "home", ".codex")
  const projectRoot = path.join(root, "repo")
  const cwd = path.join(projectRoot, "packages", "app")
  const userSkill = path.join(codexDir, "skills", "review")
  const projectSkill = path.join(cwd, ".agents", "skills", "review")
  const userAgent = path.join(codexDir, "agents")
  const projectAgent = path.join(cwd, ".codex", "agents")
  await Promise.all([
    fs.mkdir(path.join(projectRoot, ".git"), { recursive: true }),
    fs.mkdir(path.join(projectRoot, ".codex"), { recursive: true }),
    fs.mkdir(userSkill, { recursive: true }),
    fs.mkdir(projectSkill, { recursive: true }),
    fs.mkdir(userAgent, { recursive: true }),
    fs.mkdir(projectAgent, { recursive: true }),
  ])
  await fs.writeFile(
    path.join(userSkill, "SKILL.md"),
    "---\nname: Review\ndescription: User review\n---\nuser",
    "utf8"
  )
  await fs.writeFile(
    path.join(projectSkill, "SKILL.md"),
    "---\nname: Review\ndescription: Project review\n---\nproject",
    "utf8"
  )
  await fs.writeFile(path.join(userAgent, "critic.toml"), 'name = "critic"\n')
  await fs.writeFile(
    path.join(projectAgent, "critic.toml"),
    'name = "critic"\n'
  )
  await fs.writeFile(
    path.join(codexDir, "config.toml"),
    '[mcp_servers.shared]\ncommand = "user-command"\n'
  )
  await fs.writeFile(
    path.join(projectRoot, ".codex", "config.toml"),
    '[mcp_servers.shared]\ncommand = "root-command"\n'
  )
  await fs.writeFile(
    path.join(cwd, ".codex", "config.toml"),
    '[mcp_servers.shared]\ncommand = "project-command"\n'
  )

  const scan = await scanCodex({
    codexDir,
    homeDir: path.join(root, "home"),
    cwd,
    workspaceTrusted: true,
  })

  assert.equal(scan.skills.length, 2)
  assert.deepEqual(
    scan.skills.map((skill) => [skill.scope, skill.description]),
    [
      ["user", "User review"],
      ["project", "Project review"],
    ]
  )
  assert.equal(scan.agents.length, 1)
  assert.equal(scan.agents[0].scope, "project")
  assert.equal(scan.mcpServers.length, 1)
  assert.equal(scan.mcpServers[0].command, "project-command")
  assert.equal(scan.mcpServers[0].scope, "project")
})

test("Codex ignores project config, agents, and skills until trust is explicit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-codex-trust-"))
  tempRoots.push(root)
  const homeDir = path.join(root, "home")
  const codexDir = path.join(homeDir, ".codex")
  const cwd = path.join(root, "repo")
  await fs.mkdir(path.join(codexDir, "skills", "user"), { recursive: true })
  await fs.mkdir(path.join(cwd, ".agents", "skills", "project"), {
    recursive: true,
  })
  await fs.mkdir(path.join(cwd, ".codex", "agents"), { recursive: true })
  await fs.writeFile(
    path.join(codexDir, "skills", "user", "SKILL.md"),
    "# User\n"
  )
  await fs.writeFile(
    path.join(cwd, ".agents", "skills", "project", "SKILL.md"),
    "# Project\n"
  )
  await fs.writeFile(
    path.join(cwd, ".codex", "agents", "project.toml"),
    [
      'name = "project"',
      'description = "Project agent"',
      'developer_instructions = "Work"',
    ].join("\n")
  )
  await fs.writeFile(
    path.join(cwd, ".codex", "config.toml"),
    '[mcp_servers.project]\ncommand = "project-command"\n'
  )

  const scan = await scanCodex({ codexDir, homeDir, cwd })

  assert.deepEqual(
    scan.skills.map((skill) => skill.scope),
    ["user"]
  )
  assert.deepEqual(scan.agents, [])
  assert.deepEqual(scan.mcpServers, [])
  assert.deepEqual(scan.configSources, [])
})

test("Claude scan resolves user and project assets with project precedence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-claude-scan-"))
  tempRoots.push(root)
  const homeDir = path.join(root, "home")
  const claudeDir = path.join(homeDir, "isolated-claude")
  const cwd = path.join(root, "repo")
  const userSkill = path.join(claudeDir, "skills", "review")
  const projectSkill = path.join(cwd, ".claude", "skills", "review")
  const userAgent = path.join(claudeDir, "agents")
  const projectAgent = path.join(cwd, ".claude", "agents")
  const userCommands = path.join(claudeDir, "commands")
  const projectCommands = path.join(cwd, ".claude", "commands")
  await Promise.all([
    fs.mkdir(userSkill, { recursive: true }),
    fs.mkdir(projectSkill, { recursive: true }),
    fs.mkdir(userAgent, { recursive: true }),
    fs.mkdir(projectAgent, { recursive: true }),
    fs.mkdir(userCommands, { recursive: true }),
    fs.mkdir(projectCommands, { recursive: true }),
  ])
  await fs.writeFile(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({
      enabledPlugins: {
        "review-tools@official": true,
        "disabled@official": false,
      },
      mcpServers: {
        shared: { command: "user-command", args: ["--user"] },
      },
    })
  )
  await fs.writeFile(
    path.join(claudeDir, "credentials.json"),
    JSON.stringify({
      mcpServers: {
        remote: {
          serverUrl: "https://mcp.example.test",
          accessToken: "must-not-leak",
        },
      },
    })
  )
  await fs.writeFile(
    path.join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        shared: { command: "project-command", args: ["--project"] },
      },
    })
  )
  await fs.writeFile(
    path.join(userSkill, "SKILL.md"),
    "---\nname: Review\ndescription: User skill\n---\nuser",
    "utf8"
  )
  await fs.writeFile(
    path.join(projectSkill, "SKILL.md"),
    "---\nname: Review\ndescription: Project skill\n---\nproject",
    "utf8"
  )
  await fs.writeFile(
    path.join(userAgent, "critic.md"),
    "---\nname: Critic\ndescription: User agent\n---\nUser prompt",
    "utf8"
  )
  await fs.writeFile(
    path.join(projectAgent, "critic.md"),
    "---\nname: Critic\ndescription: Project agent\n---\nProject prompt",
    "utf8"
  )
  await fs.writeFile(path.join(userCommands, "review.md"), "User command")
  await fs.writeFile(path.join(projectCommands, "review.md"), "Project command")

  const untrusted = await scanClaude({ homeDir, claudeDir, cwd })
  assert.equal(untrusted.skills[0].description, "User skill")
  assert.equal(untrusted.agents[0].description, "User agent")
  assert.equal(
    untrusted.mcpServers.find((server) => server.id === "shared").command,
    "user-command"
  )

  const scan = await scanClaude({
    homeDir,
    claudeDir,
    cwd,
    workspaceTrusted: true,
  })

  assert.deepEqual(
    scan.plugins.map((plugin) => plugin.id),
    ["review-tools@official"]
  )
  assert.equal(scan.skills.length, 1)
  assert.equal(scan.skills[0].scope, "project")
  assert.equal(scan.skills[0].description, "Project skill")
  assert.equal(scan.agents.length, 1)
  assert.equal(scan.agents[0].scope, "project")
  assert.equal(scan.commands.length, 1)
  assert.equal(scan.commands[0].scope, "project")
  assert.equal(
    scan.mcpServers.find((server) => server.id === "shared").command,
    "project-command"
  )
  assert.equal(
    scan.mcpServers.find((server) => server.id === "remote").authenticated,
    true
  )
  assert.equal(JSON.stringify(scan).includes("must-not-leak"), false)
})

test("Claude trusted local project MCP overrides project and user scopes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-claude-local-"))
  tempRoots.push(root)
  const homeDir = path.join(root, "home")
  const claudeDir = path.join(homeDir, ".claude")
  const cwd = path.join(root, "repo")
  await Promise.all([
    fs.mkdir(claudeDir, { recursive: true }),
    fs.mkdir(cwd, { recursive: true }),
  ])
  await fs.writeFile(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({
      mcpServers: {
        shared: { command: "user-command" },
      },
    })
  )
  await fs.writeFile(
    path.join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        shared: { command: "project-command" },
      },
    })
  )
  const userStatePath = path.join(homeDir, ".claude.json")
  await fs.writeFile(
    userStatePath,
    JSON.stringify({
      projects: {
        [cwd]: {
          mcpServers: {
            shared: { command: "local-command", args: ["--local"] },
          },
        },
        [path.join(root, "other-repo")]: {
          mcpServers: {
            ignored: { command: "other-command" },
          },
        },
      },
    })
  )

  const untrusted = await scanClaude({ homeDir, claudeDir, cwd })
  assert.equal(untrusted.mcpServers[0].command, "user-command")

  const trusted = await scanClaude({
    homeDir,
    claudeDir,
    cwd,
    workspaceTrusted: true,
  })
  assert.deepEqual(trusted.mcpServers, [
    {
      id: "shared",
      name: "Shared",
      source: "claude",
      type: "command",
      command: "local-command",
      args: ["--local"],
      env: {},
      enabled: true,
      authenticated: false,
      scope: "local",
      sourcePath: userStatePath,
    },
  ])
  assert.equal(trusted.configSources.includes(userStatePath), true)
})

test("Claude config directory env is authoritative and is not rewritten", () => {
  const homeDir = path.join("tmp", "home")
  const configured = path.join("tmp", "claude-profile")
  assert.equal(
    resolveClaudeConfigDir({
      homeDir,
      environment: { CLAUDE_CONFIG_DIR: configured },
    }),
    path.resolve(configured)
  )
})

test("TOML parser retains nested MCP env and header maps", () => {
  const parsed = parseTomlConfig(
    [
      "[mcp_servers.files]",
      'command = "node"',
      "[mcp_servers.files.env]",
      'MODE = "safe"',
      "[mcp_servers.remote]",
      'url = "https://mcp.example.test"',
      "[mcp_servers.remote.http_headers]",
      '"X-Static" = "literal"',
      "[mcp_servers.remote.env_http_headers]",
      'Authorization = "MCP_TOKEN"',
    ].join("\n")
  )
  assert.deepEqual(parsed.mcpServers.files, {
    command: "node",
    env: { MODE: "safe" },
  })
  assert.deepEqual(parsed.mcpServers.remote, {
    url: "https://mcp.example.test",
    http_headers: { "X-Static": "literal" },
    env_http_headers: { Authorization: "MCP_TOKEN" },
  })
})

test("TOML server names cannot mutate inherited objects", () => {
  try {
    const parsed = parseTomlConfig([
      "[mcp_servers.__proto__]",
      'betterc0deAuditMarker = "polluted"',
      "[mcp_servers.constructor]",
      'command = "safe-command"',
      "[mcp_servers.normal]",
      'env = { __proto__ = { MODE = "own-value" } }',
    ].join("\n"))
    assert.equal(Object.prototype.betterc0deAuditMarker, undefined)
    assert.equal(Object.command, undefined)
    assert.equal(Object.hasOwn(parsed.mcpServers, "__proto__"), true)
    assert.equal(parsed.mcpServers.constructor.command, "safe-command")
    assert.equal(Object.hasOwn(parsed.mcpServers.normal.env, "__proto__"), true)
    assert.equal(parsed.mcpServers.normal.env.MODE, undefined)
  } finally {
    delete Object.prototype.betterc0deAuditMarker
    delete Object.command
  }
})

test("scanner skips oversized TOML and frontmatter before reading their contents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-scan-size-"))
  tempRoots.push(root)
  const codexDir = path.join(root, ".codex")
  const skillDir = path.join(codexDir, "skills", "review")
  await fs.mkdir(skillDir, { recursive: true })
  const configPath = path.join(codexDir, "config.toml")
  const skillPath = path.join(skillDir, "SKILL.md")
  await fs.writeFile(configPath, '[mcp_servers.oversized]\ncommand = "node"\n')
  await fs.writeFile(skillPath, "---\nname: Oversized metadata\n---\n")
  await fs.truncate(configPath, 2 * 1024 * 1024)
  await fs.truncate(skillPath, 2 * 1024 * 1024)
  const scan = await scanCodex({ codexDir, homeDir: root })
  assert.deepEqual(scan.configSources, [])
  assert.deepEqual(scan.mcpServers, [])
  assert.equal(scan.skills[0].name, "Review")
})

test("Claude markdown agents retain frontmatter and prompt body on import", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-agent-markdown-"))
  tempRoots.push(root)
  const file = path.join(root, "reviewer.md")
  await fs.writeFile(
    file,
    [
      "---",
      "name: Careful Reviewer",
      "description: Finds regressions",
      "---",
      "Review the change carefully.",
    ].join("\n"),
    "utf8"
  )

  assert.deepEqual(parseMarkdownAgent(file), {
    id: "careful-reviewer",
    name: "Careful Reviewer",
    description: "Finds regressions",
    prompt: "Review the change carefully.",
    sourcePath: file,
    source: "claude",
  })
})

test("the CLI scans are asynchronous and never read synchronously on the main thread", async () => {
  const { readFileSync } = await import("node:fs")
  const scannerSource = readFileSync(
    new URL("../apps/shell/cli-scanner.cjs", import.meta.url),
    "utf8"
  )
  assert.doesNotMatch(scannerSource, /Sync\(|readJson\(|readBoundedRegularFile\(/)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-scan-async-"))
  tempRoots.push(root)
  const claude = scanClaude({ homeDir: root, claudeDir: path.join(root, ".claude") })
  const codex = scanCodex({ homeDir: root, codexDir: path.join(root, ".codex") })
  assert.ok(claude instanceof Promise)
  assert.ok(codex instanceof Promise)
  const [claudeScan, codexScan] = await Promise.all([claude, codex])
  assert.equal(claudeScan.found, false)
  assert.equal(codexScan.found, false)
  assert.deepEqual(claudeScan.mcpServers, [])
})

test("a stored MCP server keeps the CLI it was imported from", () => {
  const imported = normalizeMcpConfig({
    id: "linear",
    name: "Linear",
    source: "claude",
    type: "command",
    command: "linear-mcp",
    scope: "user",
  })
  assert.equal(imported.source, "claude")
  // Display only: anything that is not a short lowercase name is dropped.
  assert.equal(
    "source" in normalizeMcpConfig({ id: "x", command: "node", source: "<b>x</b>" }),
    false
  )
  assert.equal(
    "source" in normalizeMcpConfig({ id: "y", command: "node" }),
    false
  )
})
