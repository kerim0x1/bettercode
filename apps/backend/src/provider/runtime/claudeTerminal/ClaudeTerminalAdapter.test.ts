import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ClaudeTerminalAdapter, delayWithSignal } from "./ClaudeTerminalAdapter"
import type { ProviderRuntimeEvent, ThreadId } from "../contracts"
import type { NativePtyHandle } from "./NativePty"
import * as nativePty from "./NativePty"

const tempRoots: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function makeExecutable(filePath: string, source: string): string {
  fs.writeFileSync(filePath, source, "utf8")
  fs.chmodSync(filePath, 0o755)
  return filePath
}

function makeFakeClaudeBinary(logPath: string): string {
  const dir = makeTempDir("betterc0de-claude-terminal-bin-")
  return makeExecutable(
    path.join(dir, "claude"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      "if (process.argv.includes('--version')) {",
      "  process.stdout.write('2.1.138 (Claude Code)\\n')",
      "  process.exit(0)",
      "}",
      "const args = process.argv.slice(2)",
      `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n')`,
      "const readArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }",
      "const sessionId = readArg('--resume') || readArg('--session-id') || '00000000-0000-4000-8000-000000000000'",
      "const cwd = process.cwd()",
      "const home = process.env.HOME || process.env.USERPROFILE || process.cwd()",
      "const projectDir = path.join(home, '.claude', 'projects', path.resolve(cwd).replace(/[/.]/g, '-'))",
      "fs.mkdirSync(projectDir, { recursive: true })",
      "const sessionPath = path.join(projectDir, `${sessionId}.jsonl`)",
      "const lines = [",
      "  { type: 'system', subtype: 'init', cwd, session_id: sessionId },",
      "  { type: 'assistant', message: { content: [{ type: 'text', text: 'Terminal answer' }] }, session_id: sessionId, uuid: 'assistant-1' },",
      "  { type: 'result', subtype: 'success', result: 'Terminal answer', session_id: sessionId, usage: { input_tokens: 1, output_tokens: 2 } },",
      "]",
      "fs.appendFileSync(sessionPath, lines.map((line) => JSON.stringify(line)).join('\\n') + '\\n')",
      "process.stdout.write('Claude terminal completed\\n')",
      "process.exit(0)",
      "",
    ].join("\n")
  )
}

function writeClaudeSessionFile(input: {
  homePath: string
  cwd: string
  sessionId: string
}): void {
  const projectDir = path.join(
    input.homePath,
    ".claude",
    "projects",
    fs.realpathSync.native(path.resolve(input.cwd)).replace(/[/.]/g, "-")
  )
  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(
    path.join(projectDir, `${input.sessionId}.jsonl`),
    "\n",
    "utf8"
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("Claude terminal polling", () => {
  it.each(["../outside", "C:\\private\\history", "/absolute", "not-a-uuid"])(
    "discards unsafe persisted session identifiers: %s",
    async (sessionId) => {
      for (const source of ["cursor", "stored"] as const) {
        const adapter = new ClaudeTerminalAdapter({
          getStoredProviderThreadId: () =>
            source === "stored" ? sessionId : null,
        })
        const session = await adapter.startSession({
          threadId: `thread-${source}` as ThreadId,
          resumeCursor: source === "cursor" ? { sessionId } : null,
        })
        expect(session.providerThreadId).toBeNull()
        expect(session.resumeCursor).toBeNull()
      }
    }
  )

  it("drains cancelled preparation without spawning after session stop", async () => {
    const adapter = new ClaudeTerminalAdapter()
    const threadId = "thread-preparing" as ThreadId
    await adapter.startSession({ threadId })
    let releasePreparation!: (cwd: string) => void
    vi.spyOn(fs.promises, "realpath").mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releasePreparation = resolve
        })
    )
    const spawn = vi
      .spyOn(nativePty, "spawnNativePtyAsync")
      .mockRejectedValue(new Error("unexpected spawn"))
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const turn = adapter.sendTurn({
      threadId,
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
    })
    let stopped = false
    const stop = adapter.stopSession(threadId).then(() => {
      stopped = true
    })
    await Promise.resolve()
    await Promise.resolve()
    const stoppedBeforePreparation = stopped
    releasePreparation(process.cwd())
    await Promise.all([turn, stop])
    expect(stoppedBeforePreparation).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === "turn.started")).toBe(false)
    expect(adapter.hasSession(threadId)).toBe(false)
  })

  it("owns and terminates a PTY that arrives after stop begins", async () => {
    const adapter = new ClaudeTerminalAdapter()
    const threadId = "thread-spawning" as ThreadId
    const cwd = makeTempDir("betterc0de-terminal-spawning-")
    let releaseSpawn!: (child: NativePtyHandle) => void
    const spawn = vi.spyOn(nativePty, "spawnNativePtyAsync").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSpawn = resolve
        })
    )
    let releaseExit!: () => void
    const exit = new Promise<{ exitCode: number; signal: null }>((resolve) => {
      releaseExit = () => resolve({ exitCode: 0, signal: null })
    })
    const child: NativePtyHandle = {
      pid: 4567,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(async () => {
        releaseExit()
      }),
      waitForExit: () => exit,
    }
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const turn = adapter.sendTurn({
      threadId,
      projectPath: cwd,
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    let stopped = false
    const stop = adapter.stopSession(threadId).then(() => {
      stopped = true
    })
    await Promise.resolve()
    await Promise.resolve()
    const stoppedBeforeSpawn = stopped
    releaseSpawn(child)
    if (stoppedBeforeSpawn) releaseExit()
    await Promise.all([turn, stop])
    expect(stoppedBeforeSpawn).toBe(false)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.type === "turn.completed")).toEqual([
      expect.objectContaining({ status: "interrupted" }),
    ])
    expect(adapter.hasSession(threadId)).toBe(false)
  })

  it("retains a PTY whose exit cannot confirm process-tree cleanup", async () => {
    const adapter = new ClaudeTerminalAdapter()
    const threadId = "thread-unconfirmed" as ThreadId
    const cwd = makeTempDir("betterc0de-terminal-unconfirmed-")
    const failure = new Error("process-tree cleanup unconfirmed")
    const child: NativePtyHandle = {
      pid: 4568,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(async () => {}),
      waitForExit: vi.fn(async () => {
        throw failure
      }),
    }
    const spawn = vi
      .spyOn(nativePty, "spawnNativePtyAsync")
      .mockResolvedValue(child)
    const input = {
      threadId,
      projectPath: cwd,
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
    }
    await adapter.sendTurn(input)
    await expect(adapter.stopSession(threadId)).rejects.toBe(failure)
    expect(adapter.hasSession(threadId)).toBe(true)
    await expect(adapter.sendTurn(input)).rejects.toThrow("session is stopping")
    expect(spawn).toHaveBeenCalledOnce()
  })

  it("fences new sessions while stopAll drains pending preparation", async () => {
    const adapter = new ClaudeTerminalAdapter()
    const threadId = "thread-stop-all-preparing" as ThreadId
    await adapter.startSession({ threadId })
    let releasePreparation!: (cwd: string) => void
    vi.spyOn(fs.promises, "realpath").mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releasePreparation = resolve
        })
    )
    const turn = adapter.sendTurn({
      threadId,
      message: "hello",
      modelId: "claude-opus-4-7",
      history: [],
    })
    const stop = adapter.stopAll()
    try {
      await expect(
        adapter.startSession({ threadId: "new-thread" as ThreadId })
      ).rejects.toThrow("stopping")
      await expect(
        adapter.sendTurn({
          threadId,
          message: "next",
          modelId: "claude-opus-4-7",
          history: [],
        })
      ).rejects.toThrow("stopping")
    } finally {
      releasePreparation(process.cwd())
      await Promise.all([turn, stop])
    }
    expect(await adapter.listSessions()).toEqual([])
  })

  it("clears turn admission when persistence fails before spawning", async () => {
    const failure = new Error("persist failed")
    const persist = vi.fn(() => {
      throw failure
    })
    const adapter = new ClaudeTerminalAdapter({
      persistProviderThreadId: persist,
    })
    const threadId = "thread-persist-failure" as ThreadId
    const cwd = makeTempDir("betterc0de-terminal-persist-")
    const spawn = vi.spyOn(nativePty, "spawnNativePtyAsync")
    await expect(
      adapter.sendTurn({
        threadId,
        projectPath: cwd,
        message: "hello",
        modelId: "claude-opus-4-7",
        history: [],
      })
    ).rejects.toBe(failure)
    expect(await adapter.listSessions()).toEqual([
      expect.objectContaining({ status: "ready", activeTurnId: null }),
    ])
    expect(spawn).not.toHaveBeenCalled()
    await adapter.stopSession(threadId)
    expect(adapter.hasSession(threadId)).toBe(false)
  })

  it("probes PTY, CLI, auth, and cwd without synchronous filesystem calls", async () => {
    const cwd = makeTempDir("betterc0de-claude-terminal-probe-cwd-")
    const homePath = makeTempDir("betterc0de-claude-terminal-probe-home-")
    fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(homePath, ".claude", "credentials.json"), "{}\n")
    const syncIo = [
      vi.spyOn(fs, "accessSync"),
      vi.spyOn(fs, "existsSync"),
      vi.spyOn(fs, "openSync"),
      vi.spyOn(fs, "readSync"),
      vi.spyOn(fs, "readFileSync"),
      vi.spyOn(fs, "closeSync"),
      vi.spyOn(fs, "readdirSync"),
      vi.spyOn(fs, "realpathSync"),
      vi.spyOn(fs, "statSync"),
      vi.spyOn(fs, "chmodSync"),
    ]

    try {
      const adapter = new ClaudeTerminalAdapter({
        binaryPath: process.execPath,
        homePath,
      })
      await expect(adapter.probeStatus({ cwd })).resolves.toMatchObject({
        configured: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
      })
      for (const operation of syncIo) {
        const unexpected = operation.mock.calls.filter(
          (args) => !String(args[0] ?? "").includes("cli-version-cache.json")
        )
        expect(unexpected).toEqual([])
      }
    } finally {
      for (const operation of syncIo) operation.mockRestore()
    }
  })

  it("removes its abort listener when a normal delay completes", async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, "removeEventListener")
    await delayWithSignal(1, controller.signal)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  })

  it("treats CLAUDE_CONFIG_DIR as the exact config directory", async () => {
    const configDir = makeTempDir("betterc0de-claude-terminal-config-")
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
      const adapter = new ClaudeTerminalAdapter({
        binaryPath: process.execPath,
      })
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

  it("awaits asynchronous process-tree termination before publishing interruption", async () => {
    const adapter = new ClaudeTerminalAdapter()
    await adapter.startSession({ threadId: "thread-interrupt" as ThreadId })
    const sessions = (
      adapter as unknown as {
        sessions: Map<
          string,
          {
            child: NativePtyHandle | null
            activeTurnId: string | null
            activeDispatchTurnId: string | null
          }
        >
      }
    ).sessions
    const context = sessions.get("thread-interrupt")!
    let finishKill!: () => void
    const killPending = new Promise<void>((resolve) => {
      finishKill = resolve
    })
    let finishExit!: () => void
    const exitPending = new Promise<{ exitCode: number; signal: null }>(
      (resolve) => {
        finishExit = () => resolve({ exitCode: 0, signal: null })
      }
    )
    const child: NativePtyHandle = {
      pid: 4242,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => killPending),
      waitForExit: vi.fn(() => exitPending),
    }
    context.child = child
    context.activeTurnId = "native-turn"
    context.activeDispatchTurnId = "dispatch-turn"
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    const interruption = adapter.interruptTurn("thread-interrupt" as ThreadId)
    await Promise.resolve()
    expect(events).toEqual([])
    expect(context.child).toBe(child)

    finishKill()
    await Promise.resolve()
    expect(events).toEqual([])
    expect(context.child).toBe(child)

    finishExit()
    await expect(interruption).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    expect(context.child).toBeNull()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn.completed",
        turnId: "native-turn",
        status: "interrupted",
        payload: expect.objectContaining({ dispatchTurnId: "dispatch-turn" }),
      })
    )
  })

  it("propagates an asynchronous process-tree kill failure after confirmed exit", async () => {
    const adapter = new ClaudeTerminalAdapter()
    await adapter.startSession({ threadId: "thread-kill-failure" as ThreadId })
    const sessions = (
      adapter as unknown as {
        sessions: Map<
          string,
          {
            child: NativePtyHandle | null
            activeTurnId: string | null
            activeDispatchTurnId: string | null
          }
        >
      }
    ).sessions
    const context = sessions.get("thread-kill-failure")!
    const failure = new Error("taskkill failed")
    const child: NativePtyHandle = {
      pid: 4343,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(async () => {
        throw failure
      }),
      waitForExit: vi.fn(async () => ({ exitCode: 0, signal: null })),
    }
    context.child = child
    context.activeTurnId = "native-turn"

    await expect(
      adapter.interruptTurn("thread-kill-failure" as ThreadId)
    ).rejects.toBe(failure)
    expect(context.child).toBeNull()
  })

  it("escalates a non-exiting PTY tree from SIGTERM to SIGKILL", async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ClaudeTerminalAdapter()
      await adapter.startSession({ threadId: "thread-escalate" as ThreadId })
      const sessions = (
        adapter as unknown as {
          sessions: Map<
            string,
            {
              child: NativePtyHandle | null
              activeTurnId: string | null
              activeDispatchTurnId: string | null
            }
          >
        }
      ).sessions
      const context = sessions.get("thread-escalate")!
      let finishExit!: () => void
      const exitPending = new Promise<{ exitCode: number; signal: string }>(
        (resolve) => {
          finishExit = () => resolve({ exitCode: 1, signal: "SIGKILL" })
        }
      )
      const child: NativePtyHandle = {
        pid: 4444,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(async () => {}),
        waitForExit: vi.fn(() => exitPending),
      }
      context.child = child

      const interruption = adapter.interruptTurn("thread-escalate" as ThreadId)
      await vi.advanceTimersByTimeAsync(500)
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM")
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL")

      finishExit()
      await expect(interruption).resolves.toBeUndefined()
      expect(context.child).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("aggregates stopAll failures after attempting every session", async () => {
    const adapter = new ClaudeTerminalAdapter()
    await adapter.startSession({ threadId: "thread-stop-a" as ThreadId })
    await adapter.startSession({ threadId: "thread-stop-b" as ThreadId })
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
})

describe.skipIf(process.platform === "win32")("ClaudeTerminalAdapter", () => {
  it("spawns Claude CLI through a native PTY in the project cwd and resumes the saved session", async () => {
    const cwd = makeTempDir("betterc0de-claude-terminal-repo-")
    const homePath = makeTempDir("betterc0de-claude-terminal-home-")
    fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(homePath, ".claude", "credentials.json"), "{}\n")
    const logPath = path.join(
      makeTempDir("betterc0de-claude-terminal-log-"),
      "args.jsonl"
    )
    const binaryPath = makeFakeClaudeBinary(logPath)
    const persisted: Array<{
      providerThreadId: string | null
      resumeCursor?: unknown | null
    }> = []
    const adapter = new ClaudeTerminalAdapter({
      providerInstanceId: "claude-terminal",
      binaryPath,
      homePath,
      persistProviderThreadId: (_threadId, providerThreadId, resumeCursor) => {
        persisted.push({ providerThreadId, resumeCursor })
      },
    })
    const events: ProviderRuntimeEvent[] = []
    adapter.subscribe((event) => events.push(event))

    await expect(adapter.probeStatus({ cwd })).resolves.toMatchObject({
      configured: true,
      installed: true,
      status: "ready",
      version: "2.1.138",
    })

    await adapter.sendTurn({
      threadId: "thread-1",
      message: "hello",
      modelId: "claude-opus-4-7",
      projectPath: cwd,
      history: [],
      permissionLevel: "bypass",
    })

    expect(events.map((event) => event.type)).toContain("content.delta")
    expect(events.map((event) => event.type)).toContain("turn.completed")
    expect(
      events.find((event) => event.type === "content.delta")
    ).toMatchObject({
      providerKind: "claude",
      providerInstanceId: "claude-terminal",
      delta: "Terminal answer",
    })
    const firstSessionId = persisted.at(-1)?.providerThreadId
    expect(firstSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    const firstArgs = JSON.parse(
      fs.readFileSync(logPath, "utf8").trim()
    ) as string[]
    expect(firstArgs).toContain("--session-id")
    expect(firstArgs).toContain("--dangerously-skip-permissions")

    writeClaudeSessionFile({ homePath, cwd, sessionId: firstSessionId! })
    events.splice(0)
    await adapter.sendTurn({
      threadId: "thread-1",
      message: "resume",
      modelId: "claude-opus-4-7",
      projectPath: cwd,
      history: [],
      permissionLevel: "bypass",
    })

    const argLines = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/)
    const secondArgs = JSON.parse(argLines[1]!) as string[]
    expect(secondArgs).toContain("--resume")
    expect(secondArgs).toContain(firstSessionId)
  })

  it("passes BetterC0de project tools and permission rules to the Claude CLI", async () => {
    const cwd = makeTempDir("betterc0de-claude-terminal-policy-repo-")
    fs.writeFileSync(
      path.join(cwd, "BetterC0de.jsonc"),
      [
        "{",
        '  "tools": { "bash": false, "webfetch": false },',
        '  "permission": {',
        '    "bash": { "npm test *": "allow" },',
        '    "edit": { "src/generated/*": "deny" }',
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )
    const homePath = makeTempDir("betterc0de-claude-terminal-policy-home-")
    fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(homePath, ".claude", "credentials.json"), "{}\n")
    const logPath = path.join(
      makeTempDir("betterc0de-claude-terminal-policy-log-"),
      "args.jsonl"
    )
    const adapter = new ClaudeTerminalAdapter({
      providerInstanceId: "claude-terminal",
      binaryPath: makeFakeClaudeBinary(logPath),
      homePath,
    })

    await adapter.sendTurn({
      threadId: "thread-policy",
      message: "run safely",
      modelId: "claude-opus-4-7",
      projectPath: cwd,
      history: [],
      permissionLevel: "bypass",
    })

    const args = JSON.parse(fs.readFileSync(logPath, "utf8").trim()) as string[]
    const toolList = args[args.indexOf("--tools") + 1] ?? ""
    expect(toolList.split(",")).not.toContain("Bash")
    expect(toolList.split(",")).not.toContain("WebFetch")
    expect(args).not.toContain("--dangerously-skip-permissions")
    expect(args.join(",")).not.toContain("Bash(npm test *)")
    const disallowedTools = args[args.indexOf("--disallowedTools") + 1] ?? ""
    expect(disallowedTools).toContain("Edit(src/generated/*)")
    expect(disallowedTools).toContain("Write(src/generated/*)")
  })

  it("does not let a comma in a permission pattern become another CLI rule", async () => {
    const cwd = makeTempDir("betterc0de-claude-terminal-comma-repo-")
    fs.writeFileSync(
      path.join(cwd, "BetterC0de.jsonc"),
      [
        "{",
        '  "permission": {',
        '    "bash": { "notes),WebFetch,Read(x": "allow" },',
        '    "edit": { "src/a,b/**": "deny" }',
        "  }",
        "}",
      ].join("\n"),
      "utf8"
    )
    const homePath = makeTempDir("betterc0de-claude-terminal-comma-home-")
    fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(homePath, ".claude", "credentials.json"), "{}\n")
    const logPath = path.join(
      makeTempDir("betterc0de-claude-terminal-comma-log-"),
      "args.jsonl"
    )
    const adapter = new ClaudeTerminalAdapter({
      binaryPath: makeFakeClaudeBinary(logPath),
      homePath,
    })

    await adapter.sendTurn({
      threadId: "thread-comma",
      message: "run safely",
      modelId: "claude-opus-4-7",
      projectPath: cwd,
      history: [],
      permissionLevel: "ask-on-edit",
    })

    const args = JSON.parse(fs.readFileSync(logPath, "utf8").trim()) as string[]
    const allowedTools = args[args.indexOf("--allowedTools") + 1] ?? ""
    const disallowedTools = args[args.indexOf("--disallowedTools") + 1] ?? ""
    const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",")
    expect(allowedTools).not.toContain("WebFetch")
    expect(allowedTools).not.toContain("notes)")
    expect(disallowedTools).not.toContain("src/a,b/**")
    expect(tools).not.toContain("Edit")
    expect(tools).not.toContain("Write")
    expect(tools).not.toContain("NotebookEdit")
    expect(args).not.toContain("--dangerously-skip-permissions")
  })

  it("enforces read-only as a hard CLI tool ceiling", async () => {
    const cwd = makeTempDir("betterc0de-claude-terminal-readonly-repo-")
    const homePath = makeTempDir("betterc0de-claude-terminal-readonly-home-")
    fs.mkdirSync(path.join(homePath, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(homePath, ".claude", "credentials.json"), "{}\n")
    const logPath = path.join(
      makeTempDir("betterc0de-claude-terminal-readonly-log-"),
      "args.jsonl"
    )
    const adapter = new ClaudeTerminalAdapter({
      binaryPath: makeFakeClaudeBinary(logPath),
      homePath,
    })

    await adapter.sendTurn({
      threadId: "thread-readonly",
      message: "inspect",
      modelId: "claude-opus-4-7",
      projectPath: cwd,
      history: [],
      permissionLevel: "read-only",
    })

    const args = JSON.parse(fs.readFileSync(logPath, "utf8").trim()) as string[]
    const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",")
    expect(tools).toContain("Read")
    expect(tools).not.toContain("Bash")
    expect(tools).not.toContain("Write")
    expect(tools).not.toContain("Edit")
    expect(tools).not.toContain("Agent")
    expect(args).not.toContain("--dangerously-skip-permissions")
  })
})
