import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi, beforeEach } from "vitest"
import type { ProviderRuntimeEvent, ThreadId } from "../contracts"
import {
  ClaudeAdapter,
  buildClaudeModelsFromInitialization,
} from "./ClaudeAdapter"

const queryMock = vi.hoisted(() => vi.fn())

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  tool: vi.fn(
    (
      name: string,
      description: string,
      inputSchema: unknown,
      handler: unknown
    ) => ({
      name,
      description,
      inputSchema,
      handler,
    })
  ),
  createSdkMcpServer: vi.fn((options: { name: string }) => ({
    type: "sdk",
    ...options,
  })),
}))

function makeQuery(messages: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message
    },
    interrupt: vi.fn(),
    close: vi.fn(),
  }
}

function makeInitializingQuery(
  input:
    | unknown[]
    | {
        readonly commands?: unknown[]
        readonly account?: Record<string, unknown>
      }
) {
  const init = Array.isArray(input) ? { commands: input } : input
  return {
    initializationResult: vi.fn(async () => init),
    async *[Symbol.asyncIterator]() {},
    interrupt: vi.fn(),
    close: vi.fn(),
  }
}

function makeTempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

function makeFakeClaudeBinary(version = "2.1.111") {
  const dir = makeTempDir("betterc0de fake claude-")
  const scriptPath = path.join(dir, "fake-claude.cjs")
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      `  process.stdout.write("Claude Code ${version}\\n");`,
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
    "utf8"
  )
  return { dir, binaryPath: platformNodeCliPath(scriptPath) }
}

describe("ClaudeAdapter provider metadata", () => {
  it("uses the SDK account's exact model list and Opus 5.5 effort options", () => {
    const models = buildClaudeModelsFromInitialization([
      {
        value: "claude-opus-5-5",
        displayName: "Claude Opus 5.5",
        supportsAdaptiveThinking: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      { value: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    ])
    expect(models.map((model) => model.slug)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5",
    ])
    expect(models[0]?.context).toBe("1M")
    expect(models[0]?.capabilities?.optionDescriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "effort",
          currentValue: "medium",
        }),
      ])
    )
  })
  beforeEach(() => {
    queryMock.mockReset()
  })

  it("retains a failed SDK metadata cleanup and retries it before spawning again", async () => {
    const query = makeInitializingQuery([])
    const failure = new Error("metadata close failed")
    query.close.mockImplementation(() => {
      throw failure
    })
    queryMock.mockReturnValue(query)
    const adapter = new ClaudeAdapter({ binaryPath: process.execPath })
    await expect(adapter.availableSlashCommands()).rejects.toBe(failure)
    await expect(adapter.availableSlashCommands({ force: true })).rejects.toBe(
      failure
    )
    expect(queryMock).toHaveBeenCalledOnce()
    await expect(adapter.stopAll()).rejects.toThrow("Failed to stop all Claude")
    query.close.mockImplementation(() => {})
    await expect(adapter.stopAll()).resolves.toBeUndefined()
    expect(query.close).toHaveBeenCalledTimes(4)
  })

  it("drains SDK metadata work and fences new probes during stopAll", async () => {
    let release!: () => void
    const query = makeInitializingQuery([])
    query.initializationResult.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ commands: [] })
        })
    )
    queryMock.mockReturnValue(query)
    const adapter = new ClaudeAdapter({ binaryPath: process.execPath })
    const pending = adapter.availableSlashCommands()
    await vi.waitFor(() =>
      expect(query.initializationResult).toHaveBeenCalledOnce()
    )
    let stopped = false
    const stopping = adapter.stopAll().then(() => {
      stopped = true
    })
    try {
      await Promise.resolve()
      expect(stopped).toBe(false)
      await expect(
        adapter.availableSlashCommands({ force: true })
      ).rejects.toThrow("stopping")
    } finally {
      release()
      await Promise.all([pending, stopping])
    }
    expect(query.close).toHaveBeenCalledOnce()
    expect(queryMock).toHaveBeenCalledOnce()
  })

  it("aggregates stopAll failures after attempting every session", async () => {
    const adapter = new ClaudeAdapter()
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

  it("probes Claude CLI version and SDK account metadata", async () => {
    const fake = makeFakeClaudeBinary("2.1.111")
    expect(fake.binaryPath).toContain(" ")
    const repoPath = makeTempDir("betterc0de-claude-repo-")
    const homePath = makeTempDir("betterc0de-claude-home-")
    fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true })
    fs.writeFileSync(
      path.join(homePath, ".claude", "credentials.json"),
      '{"token":"test"}\n',
      "utf8"
    )
    queryMock.mockReturnValueOnce(
      makeInitializingQuery({
        account: {
          email: "user@example.com",
          subscriptionType: "claudeMax20xSubscription",
          tokenSource: "subscription",
        },
        commands: [
          {
            name: "review",
            description: "Review changes",
            argumentHint: "scope",
          },
        ],
      })
    )

    const adapter = new ClaudeAdapter({
      binaryPath: fake.binaryPath,
      homePath,
    })

    await expect(adapter.probeStatus({ cwd: repoPath })).resolves.toEqual({
      configured: true,
      installed: true,
      version: "2.1.111",
      status: "ready",
      auth: {
        status: "authenticated",
        email: "user@example.com",
        type: "claudeMax20xSubscription",
        label: "Claude Max 20x Subscription",
      },
    })
    expect(queryMock.mock.calls[0]?.[0]?.options).toMatchObject({
      cwd: repoPath,
      pathToClaudeCodeExecutable: fake.binaryPath,
      persistSession: false,
      tools: [],
    })
    expect(queryMock.mock.calls[0]?.[0]?.options).not.toHaveProperty(
      "allowedTools"
    )
    await expect(
      adapter.availableSlashCommands({ cwd: repoPath })
    ).resolves.toEqual([
      {
        name: "review",
        description: "Review changes",
        input: { hint: "scope" },
      },
    ])
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it("terminates a Claude probe that exceeds the combined output cap", async () => {
    const dir = makeTempDir("betterc0de noisy claude-")
    const scriptPath = path.join(dir, "noisy-claude.cjs")
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(Buffer.alloc(300 * 1024, 120));",
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
      "utf8"
    )
    const binaryPath = platformNodeCliPath(scriptPath)
    try {
      const adapter = new ClaudeAdapter({ binaryPath })

      await expect(adapter.probeStatus({ cwd: dir })).resolves.toMatchObject({
        configured: false,
        installed: true,
        status: "error",
        message: "Failed to execute Claude Agent CLI health check.",
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("gates Claude Opus 4.7 models when the CLI version is too old", async () => {
    const fake = makeFakeClaudeBinary("2.1.100")
    queryMock.mockReturnValueOnce(
      makeInitializingQuery({
        account: {
          email: "user@example.com",
          subscriptionType: "pro",
        },
      })
    )
    const adapter = new ClaudeAdapter({
      binaryPath: fake.binaryPath,
    })

    await expect(adapter.probeStatus({ cwd: fake.dir })).resolves.toMatchObject(
      {
        configured: true,
        installed: true,
        version: "2.1.100",
        status: "ready",
        message:
          "Claude Code v2.1.100 is too old for Claude Opus 4.7. Upgrade to v2.1.111 or newer to access it.",
      }
    )
    const gatedSlugs = (await adapter.availableModels()).map(
      (model) => model.slug
    )
    expect(gatedSlugs).not.toContain("claude-opus-4-7")
    expect(gatedSlugs).not.toContain("claude-opus-4-8")
    expect(gatedSlugs).not.toContain("claude-fable-5")
    expect(gatedSlugs).not.toContain("claude-sonnet-5")
  })

  it("reports BetterC0de Claude health errors when the CLI is missing", async () => {
    const adapter = new ClaudeAdapter({
      binaryPath: path.join(
        makeTempDir("betterc0de-missing-claude-"),
        "missing-claude"
      ),
    })

    await expect(adapter.probeStatus()).resolves.toEqual({
      configured: false,
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Claude Agent CLI (`claude`) is not installed or not on PATH.",
    })
    expect(queryMock).not.toHaveBeenCalled()
  })

  it("uses provider instance ANTHROPIC_API_KEY environment for Claude metadata probes", async () => {
    const fake = makeFakeClaudeBinary("2.1.111")
    const repoPath = makeTempDir("betterc0de-claude-repo-")
    queryMock.mockReturnValueOnce(
      makeInitializingQuery([
        {
          name: "fix",
          description: "Fix a focused issue",
        },
      ])
    )

    const adapter = new ClaudeAdapter({
      binaryPath: fake.binaryPath,
      environment: [{ name: "ANTHROPIC_API_KEY", value: "test-key" }],
    })

    await expect(
      adapter.availableSlashCommands({ cwd: repoPath })
    ).resolves.toEqual([
      {
        name: "fix",
        description: "Fix a focused issue",
      },
    ])
    expect(queryMock.mock.calls[0]?.[0]?.options?.env).toMatchObject({
      ANTHROPIC_API_KEY: "test-key",
    })
  })

  it("loads provider skills from the Claude config directory", async () => {
    const homePath = makeTempDir("betterc0de-claude-home-")
    const repoPath = makeTempDir("betterc0de-claude-repo-")
    const configDir = path.join(homePath, ".claude")
    fs.mkdirSync(path.join(configDir, "skills", "fix-ci"), {
      recursive: true,
    })
    fs.mkdirSync(path.join(configDir, "skills", "review"), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(configDir, "credentials.json"),
      '{"token":"test"}\n',
      "utf8"
    )
    fs.writeFileSync(
      path.join(configDir, "skills", "fix-ci", "SKILL.md"),
      [
        "---",
        "name: Fix CI",
        "description: Inspect failing GitHub Actions checks",
        "short_description: CI triage",
        "---",
        "",
        "# Fix CI",
      ].join("\n"),
      "utf8"
    )
    fs.writeFileSync(
      path.join(configDir, "skills", "review", "README.md"),
      "# Review\n\nAudit code changes and summarize risks.\n",
      "utf8"
    )

    const adapter = new ClaudeAdapter({
      binaryPath: process.execPath,
      homePath,
    })

    expect(await adapter.availableSkills({ cwd: repoPath })).toEqual([
      {
        name: "fix-ci",
        path: path.join(configDir, "skills", "fix-ci", "SKILL.md"),
        enabled: true,
        scope: "user",
        displayName: "Fix CI",
        description: "Inspect failing GitHub Actions checks",
        shortDescription: "CI triage",
      },
      {
        name: "review",
        path: path.join(configDir, "skills", "review", "README.md"),
        enabled: true,
        scope: "user",
        displayName: "Review",
        description: "Audit code changes and summarize risks.",
      },
    ])
  })

  it("treats CLAUDE_CONFIG_DIR as the exact config directory", async () => {
    const configDir = makeTempDir("betterc0de-claude-config-")
    const skillDir = path.join(configDir, "skills", "custom-config")
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "# Custom config\n\nLoaded from an exact config directory.\n",
      "utf8"
    )
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    try {
      const adapter = new ClaudeAdapter({ binaryPath: process.execPath })
      await expect(adapter.availableSkills()).resolves.toEqual([
        expect.objectContaining({
          name: "custom-config",
          path: path.join(skillDir, "SKILL.md"),
        }),
      ])
      const env = (
        adapter as unknown as { makeEnvironment(): NodeJS.ProcessEnv }
      ).makeEnvironment()
      expect(env.CLAUDE_CONFIG_DIR).toBe(path.resolve(configDir))
      expect(env.HOME).not.toBe(path.resolve(configDir))
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  it("probes and deduplicates Claude slash commands from SDK initialization", async () => {
    const homePath = makeTempDir("betterc0de-claude-home-")
    const repoPath = makeTempDir("betterc0de-claude-repo-")
    fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true })
    fs.writeFileSync(
      path.join(homePath, ".claude", "credentials.json"),
      '{"token":"test"}\n',
      "utf8"
    )
    queryMock.mockReturnValueOnce(
      makeInitializingQuery([
        {
          name: "ui",
          description: "Explore and refine UI",
        },
        {
          name: "UI",
          argumentHint: "component-or-screen",
        },
        {
          name: "",
          description: "ignored",
        },
      ])
    )

    const adapter = new ClaudeAdapter({
      binaryPath: process.execPath,
      homePath,
    })

    expect(await adapter.availableSlashCommands({ cwd: repoPath })).toEqual([
      {
        name: "ui",
        description: "Explore and refine UI",
        input: { hint: "component-or-screen" },
      },
    ])
    expect(queryMock.mock.calls[0]?.[0]?.options).toEqual(
      expect.objectContaining({
        cwd: repoPath,
        additionalDirectories: [repoPath],
        tools: [],
        persistSession: false,
      })
    )
    expect(queryMock.mock.calls[0]?.[0]?.options).not.toHaveProperty(
      "allowedTools"
    )
  })
})

describe("ClaudeAdapter plan mode", () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it.each(["AskUserQuestion", "ExitPlanMode", "Bash"])(
    "registers %s before publishing its request",
    async (tool) => {
      queryMock.mockReturnValueOnce(
        makeQuery([{ type: "result", subtype: "success" }])
      )
      const adapter = new ClaudeAdapter()
      const threadId = `immediate-${tool}` as ThreadId
      let response: Promise<void> | undefined
      adapter.subscribe((event) => {
        if (event.type !== "request.opened") return
        const decision =
          tool === "AskUserQuestion"
            ? { kind: "user_input" as const, answers: { scope: "workspace" } }
            : tool === "ExitPlanMode"
              ? { kind: "plan_approval" as const, decision: "approve" as const }
              : { kind: "tool_approval" as const, decision: "approve" as const }
        response = adapter.respondToRequest(
          threadId,
          event.requestId as never,
          decision
        )
        void response.catch(() => {})
      })
      await adapter.sendTurn({
        threadId,
        message: "hello",
        modelId: "claude-opus-4-7",
        history: [],
        permissionLevel: "default",
      })
      try {
        const result = queryMock.mock.calls[0]?.[0]?.options.canUseTool(tool, {
          plan: "# Plan",
          questions: [{ id: "scope", question: "Scope?" }],
        })
        await expect(response).resolves.toBeUndefined()
        await expect(result).resolves.toMatchObject({ behavior: "allow" })
      } finally {
        await adapter.stopAll()
      }
    }
  )

  it.each(["AskUserQuestion", "ExitPlanMode", "Bash"])(
    "cancels %s without a late resolution when stopped from its request event",
    async (tool) => {
      queryMock.mockReturnValueOnce(
        makeQuery([{ type: "result", subtype: "success" }])
      )
      const adapter = new ClaudeAdapter()
      const threadId = `cancel-${tool}` as ThreadId
      const events: ProviderRuntimeEvent[] = []
      let stop: Promise<void> | undefined
      adapter.subscribe((event) => {
        events.push(event)
        if (event.type === "request.opened")
          stop = adapter.stopSession(threadId)
      })
      await adapter.sendTurn({
        threadId,
        message: "hello",
        modelId: "claude-opus-4-7",
        history: [],
        permissionLevel: "default",
      })
      const result = queryMock.mock.calls[0]?.[0]?.options.canUseTool(tool, {
        plan: "# Plan",
        questions: [{ id: "scope", question: "Scope?" }],
      })
      await stop
      await expect(result).resolves.toMatchObject({ behavior: "deny" })
      expect(events.some((event) => event.type === "request.resolved")).toBe(
        false
      )
    }
  )

  it("does not start an SDK query after stop during asynchronous turn preparation", async () => {
    const repoPath = makeTempDir("betterc0de-claude-stop-startup-")
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = new ClaudeAdapter({
      resolveCodeSearchServer: async () => {
        entered()
        await gate
        return null
      },
    })
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const threadId = "stop-startup" as ThreadId
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const turn = adapter.sendTurn({
      threadId,
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
      projectPath: repoPath,
    })
    try {
      await started
      await adapter.stopSession(threadId)
      release()
      await turn
      expect(queryMock).not.toHaveBeenCalled()
      expect(events).toEqual([])
    } finally {
      release()
      await turn
      await adapter.stopAll()
      fs.rmSync(repoPath, { recursive: true, force: true })
    }
  })

  it("gives only the selected coordinator its team tools alongside code search", async () => {
    const repoPath = makeTempDir("betterc0de-claude-orchestrator-")
    const descriptor = {
      type: "http" as const,
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer team" },
    }
    const resolver = vi.fn(async (_cwd: string, id: string) =>
      id === "main" ? descriptor : null
    )
    const adapter = new ClaudeAdapter({
      resolveOrchestratorServer: resolver,
      resolveCodeSearchServer: async () => descriptor,
    })
    try {
      for (const id of ["main", "worker"]) {
        queryMock.mockReturnValueOnce(
          makeQuery([{ type: "result", subtype: "success" }])
        )
        await adapter.sendTurn({
          threadId: id,
          message: "Work",
          modelId: "claude-opus-4-7",
          history: [],
          projectPath: repoPath,
        })
        const servers = queryMock.mock.calls.at(-1)?.[0]?.options?.mcpServers
        expect(servers.betterc0de_code_search).toEqual(descriptor)
        if (id === "main")
          expect(servers.betterc0de_orchestrator).toEqual(descriptor)
        else expect(servers).not.toHaveProperty("betterc0de_orchestrator")
        expect(resolver).toHaveBeenCalledWith(repoPath, id)
      }
    } finally {
      await adapter.stopAll()
      fs.rmSync(repoPath, { recursive: true, force: true })
    }
  })

  it.each([true, false])(
    "registers the workspace code-search service only when enabled (%s)",
    async (enabled) => {
      const repoPath = makeTempDir("betterc0de-claude-code-search-")
      const descriptor = {
        type: "http" as const,
        url: "http://127.0.0.1:12345/mcp",
        headers: { Authorization: "Bearer local-capability" },
      }
      const resolver = vi.fn(async () => (enabled ? descriptor : null))
      const adapter = new ClaudeAdapter({ resolveCodeSearchServer: resolver })
      queryMock.mockReturnValueOnce(
        makeQuery([{ type: "result", subtype: "success" }])
      )
      try {
        await adapter.sendTurn({
          threadId: "code-search",
          message: "Find auth",
          modelId: "claude-opus-4-7",
          history: [],
          projectPath: repoPath,
        })
        expect(resolver).toHaveBeenCalledWith(repoPath)
        const servers = queryMock.mock.calls[0]?.[0]?.options?.mcpServers
        if (enabled) expect(servers.betterc0de_code_search).toEqual(descriptor)
        else expect(servers).not.toHaveProperty("betterc0de_code_search")
      } finally {
        await adapter.stopAll()
        fs.rmSync(repoPath, { recursive: true, force: true })
      }
    }
  )

  it.each(["read-only", "bypass"])(
    "enables implementation tools in the running query only after plan approval (%s)",
    async (permissionLevel) => {
      const adapter = new ClaudeAdapter()
      const threadId = "thread-live-plan" as ThreadId
      const repoPath = makeTempDir("betterc0de-plan-rollover-")
      const setPermissionMode = vi.fn().mockResolvedValue(undefined)
      let planOpened!: (id: string) => void
      let agentOpened!: (id: string) => void
      const planRequest = new Promise<string>((resolve) => {
        planOpened = resolve
      })
      const agentRequest = new Promise<string>((resolve) => {
        agentOpened = resolve
      })
      const events: ProviderRuntimeEvent[] = []
      adapter.subscribe((event) => {
        events.push(event)
        if (
          event.type === "request.opened" &&
          event.kind === "plan_approval" &&
          event.requestId
        )
          planOpened(event.requestId)
        if (
          event.type === "request.opened" &&
          event.kind === "tool_approval" &&
          event.tool === "Agent" &&
          event.requestId
        )
          agentOpened(event.requestId)
      })
      queryMock.mockImplementationOnce(({ options }) => ({
        setPermissionMode,
        interrupt: vi.fn(),
        close: vi.fn(),
        async *[Symbol.asyncIterator]() {
          for (const tool of ["Write", "Edit", "Agent"]) {
            expect(options.tools).toContain(tool)
            expect(options.disallowedTools ?? []).not.toContain(tool)
            expect(await options.canUseTool(tool, {})).toMatchObject({
              behavior: "deny",
            })
          }
          expect(
            await options.canUseTool("ExitPlanMode", { plan: "# Implement" })
          ).toMatchObject({ behavior: "allow" })
          expect(setPermissionMode).toHaveBeenCalledWith("acceptEdits")
          for (const tool of ["Write", "Edit"]) {
            expect(
              await options.canUseTool(tool, {
                file_path: path.join(repoPath, "main.ts"),
                content: "ok",
              })
            ).toMatchObject({ behavior: "allow" })
          }
          // Agent execution is registered, but still needs its own approval
          // under acceptEdits; it must not inherit unrestricted write access.
          expect(
            await options.canUseTool("Agent", { prompt: "Review the change" })
          ).toMatchObject({ behavior: "allow" })
          yield { type: "result", subtype: "success" }
        },
      }))
      const turn = adapter.sendTurn({
        threadId,
        message: "Plan this",
        modelId: "claude-opus-4-7",
        history: [],
        chatMode: "plan",
        permissionLevel,
        projectPath: repoPath,
      })
      try {
        await adapter.respondToRequest(threadId, (await planRequest) as never, {
          kind: "plan_approval",
          decision: "approve",
          permissionMode: "acceptEdits",
        })
        await adapter.respondToRequest(
          threadId,
          (await agentRequest) as never,
          { kind: "tool_approval", decision: "approve" }
        )
        await turn
        expect(
          events.filter((event) => event.type === "runtime.error")
        ).toEqual([])
        expect(
          events.filter((event) => event.type === "turn.completed")
        ).toEqual([expect.objectContaining({ status: "completed" })])
      } finally {
        await adapter.stopAll()
        fs.rmSync(repoPath, { recursive: true, force: true })
      }
    }
  )

  it("streams plan text as normal content and emits the proposed plan on completion", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "<proposed_plan>\n# Plan" },
          },
        },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "<proposed_plan>\n# Plan\n</proposed_plan>",
              },
            ],
          },
        },
        { type: "result", subtype: "success" },
      ])
    )

    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-1",
      message: "create a hero design",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "plan",
      systemInstruction: "PLAN MODE SYSTEM",
    })

    const queryArgs = queryMock.mock.calls[0]?.[0]
    expect(queryArgs?.prompt).toContain("<betterc0de_plan_mode_request>")
    expect(queryArgs?.prompt).toContain("create a hero design")
    expect(queryArgs?.options?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "PLAN MODE SYSTEM",
    })
    // Interactive plan mode keeps checkpointing ON (an approved plan can
    // roll into implementation within the same turn) and budgets extra turns.
    expect(queryArgs?.options?.enableFileCheckpointing).toBe(true)
    expect(queryArgs?.options?.maxTurns).toBe(50)
    expect(queryArgs?.options?.permissionMode).toBe("plan")
    expect(queryArgs?.options?.tools).toEqual(
      expect.arrayContaining(["Write", "Edit", "Bash", "Agent"])
    )
    expect(queryArgs?.options).not.toHaveProperty("allowedTools")
    expect(queryArgs?.options?.hooks?.PreToolUse).toHaveLength(1)

    // Plan-mode text streams as normal assistant content (the frontend's
    // <proposed_plan> boundary detector decides plan-vs-narration); the
    // completed message with a real <proposed_plan> block becomes the plan.
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "content.delta",
          streamKind: "assistant_text",
          delta: "<proposed_plan>\n# Plan",
        }),
        expect.objectContaining({
          type: "turn.proposed.completed",
          payload: { planMarkdown: "# Plan" },
        }),
      ])
    )
    // The completed text was a real plan block → proposal, not content.replace.
    expect(events.some((event) => event.type === "turn.proposed.delta")).toBe(
      false
    )
    expect(events.some((event) => event.type === "content.replace")).toBe(false)
  })

  it("keeps preliminary plan-mode narration as normal content (no premature proposal)", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "I'm in plan mode. Let me read the UI first.",
            },
          },
        },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "I'm in plan mode. Let me read the UI first.\n\n## Tasks\n- [ ] a\n- [ ] b\n- [ ] c",
              },
            ],
          },
        },
        { type: "result", subtype: "success" },
      ])
    )

    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-narration",
      message: "plan this",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "plan",
    })

    // Narration (no <proposed_plan> wrapper) must NOT become a proposal —
    // it streams as content and finalizes as a normal assistant message.
    expect(events.some((e) => e.type === "turn.proposed.completed")).toBe(false)
    expect(events.some((e) => e.type === "turn.proposed.delta")).toBe(false)
    expect(
      events.some(
        (e) => e.type === "content.delta" && e.streamKind === "assistant_text"
      )
    ).toBe(true)
    expect(
      events.some(
        (e) => e.type === "content.replace" && e.streamKind === "assistant_text"
      )
    ).toBe(true)
  })

  it("captures ExitPlanMode tool-use snapshots as proposed plans", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "exit-plan-1",
                name: "ExitPlanMode",
                input: { plan: "# Ship it\n\n- one\n- two" },
              },
            ],
          },
        },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "exit-plan-1",
                name: "ExitPlanMode",
                input: { plan: "# Ship it\n\n- one\n- two" },
              },
            ],
          },
        },
        { type: "result", subtype: "success" },
      ])
    )

    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-exit-plan",
      message: "plan this",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "plan",
    })

    const proposedPlans = events.filter(
      (event) => event.type === "turn.proposed.completed"
    )
    expect(proposedPlans).toHaveLength(1)
    expect(proposedPlans[0]).toMatchObject({
      type: "turn.proposed.completed",
      payload: { planMarkdown: "# Ship it\n\n- one\n- two" },
    })
  })

  it("denies mutating SDK tools in plan mode even with bypass permissions", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )

    const adapter = new ClaudeAdapter()

    await adapter.sendTurn({
      threadId: "thread-plan-deny",
      message: "plan this",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "plan",
      permissionLevel: "bypass",
    })

    const canUseTool = queryMock.mock.calls[0]?.[0]?.options?.canUseTool
    expect(typeof canUseTool).toBe("function")
    await expect(
      canUseTool?.("Read", { file_path: "src/app.ts" })
    ).resolves.toEqual(
      expect.objectContaining({
        behavior: "allow",
      })
    )
    await expect(
      canUseTool?.("Bash", { command: "touch owned" })
    ).resolves.toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("Plan mode"),
      })
    )
  })

  it("maps BetterC0de permission presets to Claude SDK permission modes", async () => {
    queryMock
      .mockReturnValueOnce(makeQuery([{ type: "result", subtype: "success" }]))
      .mockReturnValueOnce(makeQuery([{ type: "result", subtype: "success" }]))

    const adapter = new ClaudeAdapter()

    await adapter.sendTurn({
      threadId: "thread-allow-edits",
      message: "edit the file",
      modelId: "claude-opus-4-7",
      history: [],
      permissionLevel: "allow-edits",
    })
    await adapter.sendTurn({
      threadId: "thread-bypass",
      message: "run the migration",
      modelId: "claude-opus-4-7",
      history: [],
      permissionLevel: "bypass",
    })

    expect(queryMock.mock.calls[0]?.[0]?.options?.permissionMode).toBe(
      "acceptEdits"
    )
    expect(queryMock.mock.calls[0]?.[0]?.options).not.toHaveProperty(
      "allowDangerouslySkipPermissions"
    )
    expect(queryMock.mock.calls[1]?.[0]?.options?.permissionMode).toBe(
      "default"
    )
    expect(queryMock.mock.calls[1]?.[0]?.options).not.toHaveProperty(
      "allowDangerouslySkipPermissions"
    )
  })

  it("keeps legacy capture-and-deny for pipeline-driven plan turns", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-plan-capture",
      message: "plan this",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "plan",
      planApprovalMode: "capture",
    })

    const queryArgs = queryMock.mock.calls[0]?.[0]
    expect(queryArgs?.options?.enableFileCheckpointing).toBe(false)
    expect(queryArgs?.options?.maxTurns).toBe(20)

    const canUseTool = queryArgs?.options?.canUseTool
    await expect(
      canUseTool?.("ExitPlanMode", { plan: "# Ship" })
    ).resolves.toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("captured your proposed plan"),
      })
    )
    expect(
      events.some(
        (event) =>
          event.type === "request.opened" &&
          (event as { kind?: string }).kind === "plan_approval"
      )
    ).toBe(false)
    expect(
      events.some((event) => event.type === "turn.proposed.completed")
    ).toBe(true)
  })

  it("opens a plan_approval request on ExitPlanMode and continues on approve", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-plan-approve",
      message: "plan this",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "plan",
    })

    const canUseTool = queryMock.mock.calls[0]?.[0]?.options?.canUseTool
    const resultPromise = canUseTool?.("ExitPlanMode", {
      plan: "# Ship it",
    }) as Promise<{ behavior: string }>

    const opened = events.find(
      (event) =>
        event.type === "request.opened" &&
        (event as { kind?: string }).kind === "plan_approval"
    ) as { requestId?: string; planMarkdown?: string } | undefined
    expect(opened).toBeTruthy()
    expect(opened?.planMarkdown).toBe("# Ship it")

    await adapter.respondToRequest(
      "thread-plan-approve" as ThreadId,
      opened!.requestId! as never,
      {
        kind: "plan_approval",
        decision: "approve",
        permissionMode: "acceptEdits",
      }
    )
    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({ behavior: "allow" })
    )
    const resolved = events.find(
      (event) =>
        event.type === "request.resolved" &&
        (event as { requestKind?: string }).requestKind === "plan_approval"
    )
    expect(resolved).toMatchObject({
      decision: "approve",
      permissionMode: "acceptEdits",
    })

    // Post-approval the session gate leaves plan mode. acceptEdits permits
    // file edits, while executable tools still use the approval gate.
    const bashPromise = canUseTool?.("Bash", {
      command: "npm test",
    }) as Promise<{ behavior: string; message?: string }>
    const bashRequest = events.find(
      (event) =>
        event.type === "request.opened" &&
        (event as { kind?: string }).kind === "tool_approval" &&
        (event as { tool?: string }).tool === "Bash"
    ) as { requestId?: string } | undefined
    expect(bashRequest).toBeTruthy()
    await adapter.respondToRequest(
      "thread-plan-approve" as ThreadId,
      bashRequest!.requestId! as never,
      { kind: "tool_approval", decision: "deny" }
    )
    await expect(bashPromise).resolves.toEqual(
      expect.objectContaining({ behavior: "deny" })
    )
  })

  it("returns plan feedback to the model when the user keeps planning", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-plan-feedback",
      message: "plan this",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "plan",
    })

    const canUseTool = queryMock.mock.calls[0]?.[0]?.options?.canUseTool
    const resultPromise = canUseTool?.("ExitPlanMode", {
      plan: "# Draft",
    }) as Promise<{ behavior: string; message?: string }>
    const opened = events.find(
      (event) =>
        event.type === "request.opened" &&
        (event as { kind?: string }).kind === "plan_approval"
    ) as { requestId?: string } | undefined

    await adapter.respondToRequest(
      "thread-plan-feedback" as ThreadId,
      opened!.requestId! as never,
      {
        kind: "plan_approval",
        decision: "deny",
        message: "Split step 2 into two steps",
      }
    )
    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("Split step 2 into two steps"),
      })
    )
  })

  it("forwards approval context without letting session rules widen ask-on-edit", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-session-rules",
      message: "run the build",
      modelId: "claude-opus-4-7",
      history: [],
      permissionLevel: "ask-on-edit",
    })

    const canUseTool = queryMock.mock.calls[0]?.[0]?.options?.canUseTool
    const firstCall = canUseTool?.(
      "Bash",
      { command: "npm run build" },
      {
        title: "Claude wants to run npm run build",
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm run build*" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      }
    ) as Promise<{ behavior: string; updatedPermissions?: unknown[] }>

    const opened = events.find(
      (event) =>
        event.type === "request.opened" &&
        (event as { kind?: string }).kind === "tool_approval"
    ) as { requestId?: string; title?: string; suggestions?: unknown[] }
    expect(opened?.title).toBe("Claude wants to run npm run build")
    expect(opened?.suggestions).toHaveLength(1)

    await adapter.respondToRequest(
      "thread-session-rules" as ThreadId,
      opened.requestId! as never,
      {
        kind: "tool_approval",
        decision: "approve",
        updatedPermissions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm run build*" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      }
    )
    await expect(firstCall).resolves.toEqual(
      expect.objectContaining({
        behavior: "allow",
        updatedPermissions: expect.arrayContaining([
          expect.objectContaining({ destination: "session" }),
        ]),
      })
    )

    // A mirrored allow rule may narrow repeated prompts, but it cannot widen
    // the immutable ask-on-edit ceiling for process execution.
    const openedCountBefore = events.filter(
      (event) => event.type === "request.opened"
    ).length
    const secondCall = canUseTool?.("Bash", {
      command: "npm run build",
    }) as Promise<{ behavior: string }>
    const openedCountAfter = events.filter(
      (event) => event.type === "request.opened"
    ).length
    expect(openedCountAfter).toBe(openedCountBefore + 1)
    const secondOpened = events
      .filter((event) => event.type === "request.opened")
      .at(-1) as { requestId?: string }
    await adapter.respondToRequest(
      "thread-session-rules" as ThreadId,
      secondOpened.requestId! as never,
      { kind: "tool_approval", decision: "deny" }
    )
    await expect(secondCall).resolves.toEqual(
      expect.objectContaining({ behavior: "deny" })
    )
  })

  it("adds disallowedTools for read-only turns", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const adapter = new ClaudeAdapter()
    await adapter.sendTurn({
      threadId: "thread-read-only",
      message: "inspect",
      modelId: "claude-opus-4-7",
      history: [],
      permissionLevel: "read-only",
    })
    expect(queryMock.mock.calls[0]?.[0]?.options?.disallowedTools).toEqual(
      expect.arrayContaining(["Write", "Edit", "Bash"])
    )
  })

  it("routes the default level straight to the approval gate", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-default-level",
      message: "do things",
      modelId: "claude-opus-4-7",
      history: [],
      permissionLevel: "default",
    })
    expect(queryMock.mock.calls[0]?.[0]?.options?.permissionMode).toBe(
      "default"
    )

    const canUseTool = queryMock.mock.calls[0]?.[0]?.options?.canUseTool
    // Even a read tool asks under "default" — the CLI's own engine already
    // decided this call needs a prompt.
    const readPromise = canUseTool?.("Read", {
      file_path: "src/app.ts",
    }) as Promise<{ behavior: string }>
    const opened = events.find(
      (event) =>
        event.type === "request.opened" &&
        (event as { kind?: string }).kind === "tool_approval"
    ) as { requestId?: string } | undefined
    expect(opened).toBeTruthy()
    await adapter.respondToRequest(
      "thread-default-level" as ThreadId,
      opened!.requestId! as never,
      { kind: "tool_approval", decision: "approve" }
    )
    await expect(readPromise).resolves.toEqual(
      expect.objectContaining({ behavior: "allow" })
    )
  })

  it("queues permission-mode switches while no turn is live", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const adapter = new ClaudeAdapter()
    await adapter.sendTurn({
      threadId: "thread-mode-switch",
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
      permissionLevel: "ask-on-edit",
    })
    await expect(
      adapter.setPermissionMode("thread-mode-switch" as ThreadId, "acceptEdits")
    ).resolves.toEqual({ applied: "queued" })
  })

  it("drains pending plan approvals on interrupt", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const adapter = new ClaudeAdapter()
    await adapter.sendTurn({
      threadId: "thread-plan-interrupt",
      message: "plan this",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "plan",
    })

    const canUseTool = queryMock.mock.calls[0]?.[0]?.options?.canUseTool
    const resultPromise = canUseTool?.("ExitPlanMode", {
      plan: "# Pending",
    }) as Promise<{ behavior: string; message?: string }>
    await adapter.interruptTurn("thread-plan-interrupt" as ThreadId)
    await expect(resultPromise).resolves.toEqual(
      expect.objectContaining({
        behavior: "deny",
        message: expect.stringContaining("Interrupted"),
      })
    )
  })

  it("escalates a wedged interrupt through close and abort and still ends the turn", async () => {
    const hangingQuery = {
      // A wedged CLI: the stream never produces a message and never ends.
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<unknown>>(() => {}) }
      },
      interrupt: vi.fn(() => new Promise<void>(() => {})),
      // The real SDK's close() is synchronous — a deadline on it never
      // fires, which is why the old ladder's abort rung was dead code.
      close: vi.fn(() => undefined),
    }
    queryMock.mockReturnValueOnce(hangingQuery)
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))
    void adapter.sendTurn({
      threadId: "thread-wedged",
      message: "hang",
      modelId: "claude-opus-4-7",
      history: [],
      dispatchTurnId: "dispatch-wedged",
    } as never)
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce())
    const abortController = queryMock.mock.calls[0]?.[0]?.options
      ?.abortController as AbortController | undefined
    expect(abortController).toBeInstanceOf(AbortController)
    expect(abortController?.signal.aborted).toBe(false)
    const ctx = (
      adapter as unknown as {
        sessions: Map<string, { activeTurn: unknown; query: unknown }>
      }
    ).sessions.get("thread-wedged")
    expect(ctx?.activeTurn).not.toBeNull()

    vi.useFakeTimers()
    try {
      const interrupting = adapter.interruptTurn("thread-wedged" as ThreadId)
      // The ladder shares one 5 s budget: interrupt() and the wait for the
      // read loop end at 40 % (2 s), close() at 60 % (3 s), abort at 80 %
      // (4 s); then the turn is force-completed.
      await vi.advanceTimersByTimeAsync(1_900)
      expect(hangingQuery.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      expect(hangingQuery.close).toHaveBeenCalledOnce()
      expect(abortController?.signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(abortController?.signal.aborted).toBe(true)
      expect(ctx?.activeTurn).not.toBeNull()
      await vi.advanceTimersByTimeAsync(1_000)
      await interrupting
    } finally {
      vi.useRealTimers()
    }
    expect(hangingQuery.interrupt).toHaveBeenCalledOnce()
    // Stop always ends the turn: the adapter force-completed it.
    expect(ctx?.activeTurn).toBeNull()
    expect(ctx?.query).toBeNull()
    expect(events.filter((event) => event.type === "turn.aborted")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          reason: "Interrupted by user.",
          dispatchTurnId: "dispatch-wedged",
        }),
      }),
    ])
    await expect(adapter.listSessions()).resolves.toEqual([
      expect.objectContaining({
        threadId: "thread-wedged",
        activeTurnId: null,
      }),
    ])
  })

  it("kills the Claude process when a wedged turn is force-completed", async () => {
    const hangingQuery = {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<unknown>>(() => {}) }
      },
      interrupt: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn(() => undefined),
    }
    queryMock.mockReturnValueOnce(hangingQuery)
    const adapter = new ClaudeAdapter()
    void adapter.sendTurn({
      threadId: "thread-tree",
      message: "hang",
      modelId: "claude-opus-4-7",
      history: [],
    } as never)
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce())
    const spawnClaude = queryMock.mock.calls[0]?.[0]?.options
      ?.spawnClaudeCodeProcess as
      | ((options: {
          command: string
          args: string[]
          cwd?: string
          env: NodeJS.ProcessEnv
          signal: AbortSignal
        }) => { pid?: number; once(event: "exit", listener: () => void): void })
      | undefined
    expect(spawnClaude).toEqual(expect.any(Function))
    const child = spawnClaude!({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 100000)"],
      cwd: process.cwd(),
      env: process.env,
      signal: new AbortController().signal,
    })
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
    })
    await adapter.interruptTurn("thread-tree" as ThreadId, {
      interruptBudgetMs: 200,
    })
    await expect(exited).resolves.toBeUndefined()
  }, 20_000)

  it("fits the whole ladder into the budget the hub passes", async () => {
    const hangingQuery = {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<unknown>>(() => {}) }
      },
      interrupt: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn(() => undefined),
    }
    queryMock.mockReturnValueOnce(hangingQuery)
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))
    void adapter.sendTurn({
      threadId: "thread-budget",
      message: "hang",
      modelId: "claude-opus-4-7",
      history: [],
    } as never)
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce())

    vi.useFakeTimers()
    try {
      let settled = false
      const interrupting = adapter
        .interruptTurn("thread-budget" as ThreadId, {
          interruptBudgetMs: 1_000,
        })
        .then(() => {
          settled = true
        })
      // Nothing yields on this query, so every rung runs to its deadline.
      await vi.advanceTimersByTimeAsync(700)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(300)
      await interrupting
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
    expect(hangingQuery.interrupt).toHaveBeenCalledOnce()
    expect(hangingQuery.close).toHaveBeenCalledOnce()
    expect(
      events.filter((event) => event.type === "turn.aborted")
    ).toHaveLength(1)
  })

  it("does not end a turn after stopSession already tore the session down", async () => {
    // The hub gives up on an interrupt after its own timeout, hard-stops the
    // session and emits session.exited. A ladder still running from the
    // earlier interrupt used to force-complete afterwards and emit a stray
    // turn.aborted behind it.
    const hangingQuery = {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<unknown>>(() => {}) }
      },
      interrupt: vi.fn(() => new Promise<void>(() => {})),
      close: vi.fn(() => undefined),
    }
    queryMock.mockReturnValueOnce(hangingQuery)
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))
    void adapter.sendTurn({
      threadId: "thread-stopped",
      message: "hang",
      modelId: "claude-opus-4-7",
      history: [],
    } as never)
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce())
    const sessions = (
      adapter as unknown as {
        sessions: Map<
          string,
          {
            activeTurn: { forceCompleted: boolean } | null
            query: unknown
            sessionExited: boolean
          }
        >
      }
    ).sessions
    const ctx = sessions.get("thread-stopped")
    const activeTurn = ctx?.activeTurn
    expect(activeTurn).toBeTruthy()

    vi.useFakeTimers()
    try {
      // A long-budget ladder (a caller without the hub's budget) is still
      // waiting on its first rung when the hub hard-stops the session.
      const slowLadder = adapter.interruptTurn("thread-stopped" as ThreadId, {
        interruptBudgetMs: 60_000,
      })
      await vi.advanceTimersByTimeAsync(100)
      const stopping = adapter.stopSession("thread-stopped" as ThreadId)
      await vi.advanceTimersByTimeAsync(5_100)
      await stopping
      expect(sessions.has("thread-stopped")).toBe(false)
      expect(ctx?.sessionExited).toBe(true)
      // stopSession's own ladder ended the turn once, before the session
      // was torn down.
      expect(
        events.filter((event) => event.type === "turn.aborted")
      ).toHaveLength(1)

      // The slow ladder reaches its force-complete rung after the session is
      // gone: no second terminal event.
      await vi.advanceTimersByTimeAsync(60_000)
      await slowLadder
    } finally {
      vi.useRealTimers()
    }
    expect(
      events.filter((event) => event.type === "turn.aborted")
    ).toHaveLength(1)

    // And the guard itself, for a ladder that captured a turn stopSession
    // never reached: the force-complete is a no-op once the session exited.
    const forceComplete = (
      adapter as unknown as {
        forceCompleteInterruptedTurn: (
          ctx: unknown,
          threadId: string,
          activeTurn: unknown,
          query: unknown
        ) => void
      }
    ).forceCompleteInterruptedTurn.bind(adapter)
    const orphanTurn = {
      ...(activeTurn as object),
      forceCompleted: false,
      id: "orphan",
    }
    forceComplete(ctx, "thread-stopped", orphanTurn, null)
    expect(
      events.filter((event) => event.type === "turn.aborted")
    ).toHaveLength(1)
    expect(orphanTurn.forceCompleted).toBe(true)
  })

  it("ends the turn once when interrupt is acked but the stream unwinds late", async () => {
    let releaseStream!: () => void
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const lateQuery = {
      // The CLI acks the interrupt immediately but keeps the stream open
      // until well past every deadline.
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            streamReleased.then(
              (): IteratorResult<unknown> => ({ value: undefined, done: true })
            ),
        }
      },
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => undefined),
    }
    queryMock.mockReturnValueOnce(lateQuery)
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const turn = adapter.sendTurn({
      threadId: "thread-late-unwind",
      message: "hang",
      modelId: "claude-opus-4-7",
      history: [],
    })
    await vi.waitFor(() => expect(queryMock).toHaveBeenCalledOnce())
    const ctx = (
      adapter as unknown as {
        sessions: Map<string, { activeTurn: unknown }>
      }
    ).sessions.get("thread-late-unwind")

    vi.useFakeTimers()
    try {
      const interrupting = adapter.interruptTurn(
        "thread-late-unwind" as ThreadId
      )
      await vi.advanceTimersByTimeAsync(5_100 + 2_100 + 2_100)
      await interrupting
    } finally {
      vi.useRealTimers()
    }
    expect(ctx?.activeTurn).toBeNull()
    expect(
      events.filter((event) => event.type === "turn.aborted")
    ).toHaveLength(1)

    // The loop finally unwinds: its finally must not emit a second terminal.
    releaseStream()
    await turn
    expect(
      events.filter((event) => event.type === "turn.aborted")
    ).toHaveLength(1)
    expect(events.filter((event) => event.type === "turn.completed")).toEqual(
      []
    )
  })

  it("names the real SDK load failure after the 'not installed' prefix", async () => {
    const adapter = new ClaudeAdapter()
    ;(adapter as unknown as { sdkLoadError: string | null }).sdkLoadError =
      "Cannot find module 'better_sqlite3.node'"
    ;(adapter as unknown as { loadSdk(): Promise<unknown> }).loadSdk = vi.fn(
      async () => null
    )
    await expect(
      adapter.sendTurn({
        threadId: "thread-sdk-detail",
        message: "hello",
        modelId: "claude-opus-4-7",
        history: [],
      })
    ).rejects.toThrow(
      "Claude SDK is not installed or could not be loaded: Cannot find module 'better_sqlite3.node'."
    )
  })

  it("caches a 'not installed' probe for the normal TTL and only failures briefly", async () => {
    const adapter = new ClaudeAdapter({
      binaryPath: path.join(
        makeTempDir("betterc0de-missing-claude-"),
        "claude.cmd"
      ),
    })
    const status = await adapter.probeStatus()
    expect(status).toMatchObject({ installed: false })
    const cache = (
      adapter as unknown as {
        statusCache: { readonly error?: true } | null
      }
    ).statusCache
    expect(cache).not.toBeNull()
    expect(cache?.error).toBeUndefined()
  })
})

describe("ClaudeAdapter native observability", () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it("writes provider-native observability records when enabled", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([
        {
          type: "stream_event",
          session_id: "sdk-session-native-log",
          uuid: "stream-native-log",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hi" },
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-session-native-log",
          uuid: "result-native-log",
        },
      ])
    )
    const nativeEvents: Array<{
      event?: {
        provider?: string
        providerInstanceId?: string
        providerThreadId?: string
        threadId?: string
        method?: string
        turnId?: string
      }
    }> = []
    const nativeThreadIds: Array<string | null> = []
    const adapter = new ClaudeAdapter({
      providerInstanceId: "claude-work",
      nativeEventLogger: {
        filePath: "memory://claude-native-events",
        write: (event, threadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number])
          nativeThreadIds.push(threadId ?? null)
        },
        flush: async () => {},
        removeThread: async () => {},
        close: () => {},
      },
    })

    await adapter.sendTurn({
      threadId: "thread-native-log",
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
    })

    expect(
      nativeEvents.some((record) => record.event?.provider === "claudeAgent")
    ).toBe(true)
    expect(
      nativeEvents.some(
        (record) => record.event?.providerInstanceId === "claude-work"
      )
    ).toBe(true)
    expect(
      nativeEvents.some(
        (record) =>
          record.event?.method ===
          "claude/stream_event/content_block_delta/text_delta"
      )
    ).toBe(true)
    expect(
      nativeEvents.some(
        (record) => record.event?.providerThreadId === "sdk-session-native-log"
      )
    ).toBe(true)
    expect(nativeEvents.every((record) => record.event?.turnId)).toBe(true)
    expect(
      nativeThreadIds.every((threadId) => threadId === "thread-native-log")
    ).toBe(true)
  })
})

describe("ClaudeAdapter prompt-injected effort", () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it("maps Opus 4.8 xhigh selections to Claude max effort", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )

    const adapter = new ClaudeAdapter()
    await adapter.sendTurn({
      threadId: "thread-max",
      message: "Investigate this failure",
      modelId: "claude-opus-4-8",
      history: [],
      modelSelection: {
        instanceId: "claude",
        model: "claude-opus-4-8",
        options: [{ id: "effort", value: "xhigh" }],
      },
    })

    const queryArgs = queryMock.mock.calls[0]?.[0]
    expect(queryArgs?.options?.effort).toBe("max")
  })

  it("prefixes ultracode prompts when modelSelection carries a prompt-injected effort", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )

    const adapter = new ClaudeAdapter()
    await adapter.sendTurn({
      threadId: "thread-ultra",
      message: "Investigate this failure",
      modelId: "claude-opus-4-8",
      history: [],
      modelSelection: {
        instanceId: "claude",
        model: "claude-opus-4-8",
        options: [{ id: "effort", value: "ultracode" }],
      },
    })

    // The prompt carries the keyword; the API-side effort falls back to the
    // ladder's default (xhigh → SDK "max").
    const queryArgs = queryMock.mock.calls[0]?.[0]
    expect(queryArgs?.options?.effort).toBe("max")
    expect(queryArgs?.prompt).toBe("ultracode:\nInvestigate this failure")
  })

  it("treats Sonnet ultracode as prompt control while keeping the default SDK effort", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )

    const adapter = new ClaudeAdapter()
    await adapter.sendTurn({
      threadId: "thread-sonnet-ultra",
      message: "Investigate this failure",
      modelId: "claude-sonnet-5",
      history: [],
      modelSelection: {
        instanceId: "claude",
        model: "claude-sonnet-5",
        options: [{ id: "effort", value: "ultracode" }],
      },
    })

    const queryArgs = queryMock.mock.calls[0]?.[0]
    expect(queryArgs?.options?.effort).toBe("high")
    expect(queryArgs?.prompt).toBe("ultracode:\nInvestigate this failure")
  })

  it("uses the Opus 4.8 descriptor default when no explicit effort is supplied", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )

    const adapter = new ClaudeAdapter()
    await adapter.sendTurn({
      threadId: "thread-opus-default",
      message: "Investigate this failure",
      modelId: "claude-opus-4-8",
      history: [],
    })

    const queryArgs = queryMock.mock.calls[0]?.[0]
    expect(queryArgs?.options?.effort).toBe("max")
  })

  it("does not duplicate an existing ultracode keyword", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )

    const adapter = new ClaudeAdapter()
    await adapter.sendTurn({
      threadId: "thread-ultra-existing",
      message: "ultracode:\nInvestigate this failure",
      modelId: "claude-opus-4-8",
      history: [],
      modelSelection: {
        instanceId: "claude",
        model: "claude-opus-4-8",
        options: [{ id: "effort", value: "ultracode" }],
      },
    })

    const queryArgs = queryMock.mock.calls[0]?.[0]
    expect(queryArgs?.prompt).toBe("ultracode:\nInvestigate this failure")
  })
})

describe("ClaudeAdapter stream event tools", () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it.each([
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
    "success",
  ])("reports SDK error results as failed (%s)", async (subtype) => {
    queryMock.mockReturnValueOnce(
      makeQuery([
        {
          type: "result",
          subtype,
          is_error: true,
          errors: ["SDK limit reached"],
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      ])
    )
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.sendTurn({
      threadId: "native-error",
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
    })
    expect(events.filter((event) => event.type === "turn.completed")).toEqual([
      expect.objectContaining({ status: "failed", error: "SDK limit reached" }),
    ])
    expect(
      (await adapter.readThread("native-error" as ThreadId)).turns
    ).toEqual([])
    await adapter.stopAll()
  })

  it("projects the SDK result envelope's top-level usage including cache tokens", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([
        {
          type: "result",
          subtype: "success",
          result: "done",
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_input_tokens: 11,
            cache_creation_input_tokens: 2,
          },
          total_cost_usd: 0.25,
          duration_ms: 120,
        },
      ])
    )
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))
    await adapter.sendTurn({
      threadId: "native-usage",
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
    })
    expect(events.find((event) => event.type === "token.usage")).toMatchObject({
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        cachedInputTokens: 13,
        cacheReadTokens: 11,
        cacheCreationTokens: 2,
        totalCostUsd: 0.25,
        durationMs: 120,
      },
    })
    expect(
      events.find((event) => event.type === "turn.completed")
    ).toMatchObject({
      status: "completed",
      payload: { usage: { totalTokens: 10 } },
    })
    await adapter.stopAll()
  })

  it("surfaces streamed tool starts, input JSON deltas, and tool results", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-grep-1",
              name: "Grep",
              input: {},
            },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"pattern":"TODO","path":"src"}',
            },
          },
        },
        {
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-grep-1",
                content: [{ type: "text", text: "src/app.ts: TODO" }],
              },
            ],
          },
        },
        { type: "result", subtype: "success" },
      ])
    )

    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-tools",
      message: "find todos",
      modelId: "claude-opus-4-7",
      history: [],
    })

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.started",
          toolId: "tool-grep-1",
          toolName: "Grep",
          input: {},
          title: "Search",
        }),
        expect.objectContaining({
          type: "item.updated",
          itemId: "tool-grep-1",
          kind: "tool:Grep",
          payload: expect.objectContaining({
            itemType: "web_search",
            input: { pattern: "TODO", path: "src" },
            data: {
              toolName: "Grep",
              input: { pattern: "TODO", path: "src" },
            },
          }),
        }),
        expect.objectContaining({
          type: "tool.completed",
          toolId: "tool-grep-1",
          toolName: "Grep",
          output: "src/app.ts: TODO",
        }),
      ])
    )
  })

  it("classifies streamed Task tool calls as subagent tasks", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-task-1",
              name: "Task",
              input: {
                subagent_type: "code-reviewer",
                description: "Review provider runtime extraction",
              },
            },
          },
        },
        { type: "result", subtype: "success" },
      ])
    )

    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-subagent",
      message: "review this",
      modelId: "claude-opus-4-7",
      history: [],
    })

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.started",
          toolId: "tool-task-1",
          toolName: "Task",
          title: "Subagent task",
        }),
      ])
    )
  })
})

describe("ClaudeAdapter conversation rollback", () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it("trims local turns and resumes Claude from the last retained assistant message", async () => {
    queryMock
      .mockReturnValueOnce(
        makeQuery([
          {
            type: "assistant",
            uuid: "assistant-first",
            session_id: "sdk-session-rollback",
            message: { content: [{ type: "text", text: "first answer" }] },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-session-rollback",
          },
        ])
      )
      .mockReturnValueOnce(
        makeQuery([
          {
            type: "assistant",
            uuid: "assistant-second",
            session_id: "sdk-session-rollback",
            message: { content: [{ type: "text", text: "second answer" }] },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-session-rollback",
          },
        ])
      )
      .mockReturnValueOnce(
        makeQuery([
          {
            type: "assistant",
            uuid: "assistant-third",
            session_id: "sdk-session-rollback",
            message: { content: [{ type: "text", text: "third answer" }] },
          },
          {
            type: "result",
            subtype: "success",
            session_id: "sdk-session-rollback",
          },
        ])
      )

    const adapter = new ClaudeAdapter()
    const threadId = "thread-rollback" as ThreadId

    await adapter.sendTurn({
      threadId,
      message: "first",
      modelId: "claude-opus-4-7",
      history: [],
    })
    await adapter.sendTurn({
      threadId,
      message: "second",
      modelId: "claude-opus-4-7",
      history: [],
    })

    expect(queryMock.mock.calls[0]?.[0]?.options?.resume).toBeUndefined()
    expect(queryMock.mock.calls[1]?.[0]?.options?.resume).toBe(
      "sdk-session-rollback"
    )
    expect(queryMock.mock.calls[1]?.[0]?.options?.resumeSessionAt).toBe(
      "assistant-first"
    )

    const beforeRollback = await adapter.readThread(threadId)
    expect(beforeRollback.turns.map((turn) => turn.id)).toHaveLength(2)

    const rolledBack = await adapter.rollbackThread(threadId, 1)
    expect(rolledBack.turns.map((turn) => turn.id)).toEqual([
      beforeRollback.turns[0]?.id,
    ])

    const afterRollback = await adapter.readThread(threadId)
    expect(afterRollback.turns.map((turn) => turn.id)).toEqual([
      beforeRollback.turns[0]?.id,
    ])

    await adapter.sendTurn({
      threadId,
      message: "third",
      modelId: "claude-opus-4-7",
      history: [],
    })

    expect(queryMock.mock.calls[2]?.[0]?.options?.resume).toBe(
      "sdk-session-rollback"
    )
    expect(queryMock.mock.calls[2]?.[0]?.options?.resumeSessionAt).toBe(
      "assistant-first"
    )
  })

  it("hydrates and persists Claude resume cursors across adapter restarts", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([
        {
          type: "assistant",
          uuid: "assistant-new",
          session_id: "sdk-session-persisted",
          message: { content: [{ type: "text", text: "new answer" }] },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sdk-session-persisted",
        },
      ])
    )
    const persisted: Array<{
      threadId: string
      providerThreadId: string | null
      resumeCursor: unknown
    }> = []
    const adapter = new ClaudeAdapter({
      getStoredProviderThreadId: () => "sdk-session-persisted",
      getStoredProviderResumeCursor: () => ({
        threadId: "thread-persisted",
        resume: "sdk-session-persisted",
        sessionId: "sdk-session-persisted",
        resumeSessionAt: "assistant-existing",
        turnCount: 2,
      }),
      persistProviderThreadId: (threadId, providerThreadId, resumeCursor) => {
        persisted.push({ threadId, providerThreadId, resumeCursor })
      },
    })

    await adapter.sendTurn({
      threadId: "thread-persisted" as ThreadId,
      message: "continue",
      modelId: "claude-opus-4-7",
      history: [],
    })

    expect(queryMock.mock.calls[0]?.[0]?.options?.resume).toBe(
      "sdk-session-persisted"
    )
    expect(queryMock.mock.calls[0]?.[0]?.options?.resumeSessionAt).toBe(
      "assistant-existing"
    )
    expect(persisted.at(-1)).toEqual({
      threadId: "thread-persisted",
      providerThreadId: "sdk-session-persisted",
      resumeCursor: {
        threadId: "thread-persisted",
        resume: "sdk-session-persisted",
        sessionId: "sdk-session-persisted",
        resumeSessionAt: "assistant-new",
        turnCount: 3,
        turnResumeSessionAts: [null, "assistant-existing", "assistant-new"],
      },
    })
  })

  it("prefers an explicit recovery resume cursor over stored Claude resume state", async () => {
    const adapter = new ClaudeAdapter({
      getStoredProviderThreadId: () => "stored-session",
      getStoredProviderResumeCursor: () => ({
        threadId: "thread-recover",
        resume: "stored-session",
        sessionId: "stored-session",
        resumeSessionAt: "stored-assistant",
        turnCount: 1,
      }),
    })

    const session = await adapter.startSession({
      threadId: "thread-recover" as ThreadId,
      cwd: "/repo",
      modelSelection: {
        instanceId: "claude-main",
        model: "claude-opus-4-7",
      },
      resumeCursor: {
        threadId: "thread-recover",
        resume: "cursor-session",
        sessionId: "cursor-session",
        resumeSessionAt: "cursor-assistant",
        turnCount: 2,
        turnResumeSessionAts: ["first-assistant", "cursor-assistant"],
      },
      runtimeMode: "full-access",
    })

    expect(session).toMatchObject({
      threadId: "thread-recover",
      providerThreadId: "cursor-session",
      cwd: "/repo",
      resumeCursor: {
        threadId: "thread-recover",
        resume: "cursor-session",
        sessionId: "cursor-session",
        resumeSessionAt: "cursor-assistant",
        turnCount: 2,
        turnResumeSessionAts: ["first-assistant", "cursor-assistant"],
      },
    })
  })

  it("rolls back a persisted Claude resume stack without an active adapter session", async () => {
    const persisted: Array<{
      threadId: string
      providerThreadId: string | null
      resumeCursor: unknown
    }> = []
    const adapter = new ClaudeAdapter({
      getStoredProviderThreadId: () => "sdk-session-stack",
      getStoredProviderResumeCursor: () => ({
        threadId: "thread-stack",
        resume: "sdk-session-stack",
        sessionId: "sdk-session-stack",
        resumeSessionAt: "assistant-second",
        turnCount: 2,
        turnResumeSessionAts: ["assistant-first", "assistant-second"],
      }),
      persistProviderThreadId: (threadId, providerThreadId, resumeCursor) => {
        persisted.push({ threadId, providerThreadId, resumeCursor })
      },
    })

    await adapter.rollbackThread("thread-stack" as ThreadId, 1)

    expect(persisted.at(-1)).toEqual({
      threadId: "thread-stack",
      providerThreadId: "sdk-session-stack",
      resumeCursor: {
        threadId: "thread-stack",
        resume: "sdk-session-stack",
        sessionId: "sdk-session-stack",
        resumeSessionAt: "assistant-first",
        turnCount: 1,
        turnResumeSessionAts: ["assistant-first"],
      },
    })
  })
})

describe("ClaudeAdapter imagegen tool wiring", () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it("registers imagegen and auto-allows it only with explicit edit permission", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const repoPath = makeTempDir("betterc0de-imagegen-repo-")
    const adapter = new ClaudeAdapter()
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await adapter.sendTurn({
      threadId: "thread-imagegen-agent",
      message: "build a landing page",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "agent",
      permissionLevel: "allow-edits",
      projectPath: repoPath,
    })

    const options = queryMock.mock.calls[0]?.[0]?.options
    expect(options?.mcpServers?.betterc0de).toMatchObject({
      type: "sdk",
      name: "betterc0de",
    })
    expect(options).not.toHaveProperty("allowedTools")
    // MCP tools must not leak into the builtins-only `tools` option.
    expect(options?.tools).not.toContain("mcp__betterc0de__generate_image")
    expect(options?.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
    })
    expect(options?.systemPrompt?.append).toContain(
      "mcp__betterc0de__generate_image"
    )
    // In-process MCP calls run minutes — the SDK's 60s stream-close default
    // would kill them.
    expect(options?.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe("420000")
    await expect(
      options?.canUseTool?.("mcp__betterc0de__generate_image", {
        prompt: "blue rocket",
        save_path: "public/hero.png",
      })
    ).resolves.toEqual(expect.objectContaining({ behavior: "allow" }))
    expect(
      events.some(
        (event) =>
          event.type === "request.opened" &&
          (event as { kind?: string }).kind === "tool_approval"
      )
    ).toBe(false)
  })

  it.each(["default", "ask-on-edit"])(
    "routes imagegen through normal approval at the %s permission level",
    async (permissionLevel) => {
      queryMock.mockReturnValueOnce(
        makeQuery([{ type: "result", subtype: "success" }])
      )
      const repoPath = makeTempDir("betterc0de-imagegen-repo-")
      const adapter = new ClaudeAdapter()
      const events: ProviderRuntimeEvent[] = []
      adapter.subscribe((event) => events.push(event))
      const threadId = `thread-imagegen-${permissionLevel}`

      await adapter.sendTurn({
        threadId,
        message: "build a landing page with a hero image",
        modelId: "claude-opus-4-7",
        history: [],
        chatMode: "agent",
        permissionLevel,
        projectPath: repoPath,
      })

      const options = queryMock.mock.calls[0]?.[0]?.options
      expect(options).not.toHaveProperty("allowedTools")
      const approval = options?.canUseTool?.(
        "mcp__betterc0de__generate_image",
        { prompt: "blue rocket", save_path: "public/hero.png" }
      ) as Promise<{ behavior: string }>
      const opened = events.find(
        (event) =>
          event.type === "request.opened" &&
          (event as { kind?: string }).kind === "tool_approval"
      ) as { requestId?: string } | undefined
      expect(opened?.requestId).toBeTruthy()
      await adapter.respondToRequest(
        threadId as ThreadId,
        opened!.requestId! as never,
        { kind: "tool_approval", decision: "approve" }
      )
      await expect(approval).resolves.toEqual(
        expect.objectContaining({ behavior: "allow" })
      )
    }
  )

  it("keeps the tool unavailable in plan mode and read-only turns", async () => {
    const repoPath = makeTempDir("betterc0de-imagegen-repo-")

    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const adapter = new ClaudeAdapter()
    await adapter.sendTurn({
      threadId: "thread-imagegen-plan",
      message: "plan a landing page",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "plan",
      projectPath: repoPath,
    })
    const planOptions = queryMock.mock.calls[0]?.[0]?.options
    // Interactive plans keep the immutable catalog available for rollover;
    // the mutable permission gate denies calls until approval.
    expect(planOptions?.mcpServers?.betterc0de).toBeDefined()
    expect(planOptions).not.toHaveProperty("allowedTools")
    expect(planOptions?.disallowedTools ?? []).not.toContain(
      "mcp__betterc0de__generate_image"
    )
    await expect(
      planOptions?.canUseTool?.("mcp__betterc0de__generate_image", {
        save_path: "public/hero.png",
      })
    ).resolves.toEqual(expect.objectContaining({ behavior: "deny" }))

    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    await adapter.sendTurn({
      threadId: "thread-imagegen-readonly",
      message: "build a landing page",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "agent",
      permissionLevel: "read-only",
      projectPath: repoPath,
    })
    const readOnlyOptions = queryMock.mock.calls[1]?.[0]?.options
    expect(readOnlyOptions).not.toHaveProperty("allowedTools")
    expect(readOnlyOptions?.disallowedTools).toContain(
      "mcp__betterc0de__generate_image"
    )
    await expect(
      readOnlyOptions?.canUseTool?.("mcp__betterc0de__generate_image", {
        save_path: "public/hero.png",
      })
    ).resolves.toEqual(expect.objectContaining({ behavior: "deny" }))
  })

  it("skips imagegen entirely when the turn has no workspace", async () => {
    queryMock.mockReturnValueOnce(
      makeQuery([{ type: "result", subtype: "success" }])
    )
    const adapter = new ClaudeAdapter()
    await adapter.sendTurn({
      threadId: "thread-imagegen-no-cwd",
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
      chatMode: "agent",
    })
    const options = queryMock.mock.calls[0]?.[0]?.options
    expect(options?.mcpServers).toBeUndefined()
    expect(options).not.toHaveProperty("allowedTools")
    expect(options?.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBeUndefined()
  })
})
