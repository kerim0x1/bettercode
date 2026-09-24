import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultSettings, type Settings } from "@betterc0de/schema"
import type {
  AcpEvent,
  AcpPermissionRequest,
  AcpRuntime,
} from "../provider/runtime/acp/AcpRuntimeBase"
import * as cursorBinaryResolution from "../provider/runtime/cursor/CursorBinaryResolution"
import * as cursorRuntimeModule from "../provider/runtime/cursor/CursorAcpRuntime"
import {
  activeNativeTextGenerationResourceCount,
  resumeNativeTextGenerationAdmissions,
  runNativeTextGeneration,
  shutdownAllNativeTextGenerationResources,
  type NativeTextGenerationRunner,
} from "./native-text-generation"

afterEach(async () => {
  try {
    await shutdownAllNativeTextGenerationResources()
  } finally {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    if (activeNativeTextGenerationResourceCount() === 0) {
      resumeNativeTextGenerationAdmissions()
    }
  }
})

function settingsWithInstance(input: {
  readonly instanceId: string
  readonly driver: string
  readonly binaryPath: string
  readonly config?: Record<string, unknown>
  readonly environment?: Array<{
    readonly name: string
    readonly value: string
    readonly sensitive?: boolean
  }>
}): Settings {
  return {
    ...defaultSettings(),
    provider_instances: {
      [input.instanceId]: {
        instanceId: input.instanceId,
        driver: input.driver,
        enabled: true,
        environment: (input.environment ?? []).map((item) => ({
          ...item,
          sensitive: item.sensitive ?? false,
        })),
        config: { binaryPath: input.binaryPath, ...(input.config ?? {}) },
      },
    },
  }
}

describe("native provider text generation", () => {
  it("retains an ACP runtime and its directory after failed close until shutdown retry succeeds", async () => {
    let directory = ""
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("process tree still alive"))
      .mockResolvedValue(undefined)
    const runtime = {
      start: vi.fn(async () => {
        throw new Error("request failed")
      }),
      cancel: vi.fn(async () => {}),
      close,
      onEvent: vi.fn(() => () => {}),
      onPermissionRequest: vi.fn(),
    } as unknown as AcpRuntime
    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "grok-retained",
            driver: "grok-cli",
            binaryPath: "test-grok",
          }),
          modelSelection: { instanceId: "grok-retained", model: "grok-4.6" },
          prompt: "private context",
          schemaName: "threadTitle",
        },
        {
          run: vi.fn(),
          createGrokRuntime: (options) => {
            directory = options.cwd
            return runtime
          },
        }
      )
    ).rejects.toThrow("request and process cleanup both failed")
    expect((await fs.stat(directory)).isDirectory()).toBe(true)
    expect(activeNativeTextGenerationResourceCount()).toBe(1)
    expect(() => resumeNativeTextGenerationAdmissions()).toThrow(
      "previous resources remain active"
    )
    await expect(
      runNativeTextGeneration({
        settings: defaultSettings(),
        modelSelection: null,
        prompt: "blocked",
        schemaName: "threadTitle",
      })
    ).rejects.toMatchObject({ code: "NATIVE_TEXT_GENERATION_ADMISSION_CLOSED" })
    await expect(shutdownAllNativeTextGenerationResources()).resolves.toBe(1)
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
    expect(close).toHaveBeenCalledTimes(2)
    expect(activeNativeTextGenerationResourceCount()).toBe(0)
  })

  it("rejects an unverified Cursor binary before constructing the production runtime", async () => {
    const resolve = vi
      .spyOn(cursorBinaryResolution, "resolveCursorBinaryAsync")
      .mockResolvedValue(null)
    const create = vi
      .spyOn(cursorRuntimeModule, "createCursorAcpRuntime")
      .mockImplementation(() => {
        throw new Error("unverified executable reached runtime")
      })
    await expect(
      runNativeTextGeneration({
        settings: settingsWithInstance({
          instanceId: "cursor-unverified",
          driver: "cursor-agent",
          binaryPath: "agent",
        }),
        modelSelection: { instanceId: "cursor-unverified", model: "gpt-5.4" },
        prompt: "Private repository content",
        schemaName: "threadTitle",
      })
    ).rejects.toThrow("Cursor Agent CLI is unavailable")
    expect(resolve).toHaveBeenCalledWith("agent")
    expect(create).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    "runs Grok summaries with denied tools and closes the runtime (nonempty=%s)",
    async (nonempty) => {
      let listener: (event: AcpEvent) => void = () => {}
      let permission: (
        request: AcpPermissionRequest
      ) => Promise<unknown> = async () => {
        throw new Error("permission handler missing")
      }
      const unsubscribe = vi.fn()
      const runtime: AcpRuntime = {
        start: async () => ({
          sessionId: "grok-summary",
          resumed: false,
          initializeResult: {},
          sessionSetupResult: {},
          configOptions: [],
        }),
        getConfigOptions: () => [],
        getModeState: () => undefined,
        setConfigOption: vi.fn(async () => ({})),
        setModel: vi.fn(async () => {}),
        setMode: vi.fn(async () => {}),
        prompt: vi.fn(async () => {
          expect(await permission({ kind: "execute", raw: {} })).toEqual({
            outcome: { outcome: "cancelled" },
          })
          if (nonempty)
            listener({
              type: "content.delta",
              text: '{"summary":"Carry these decisions forward."}',
              raw: {},
            })
          return { stopReason: "completed" }
        }),
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        onEvent: (callback) => {
          listener = callback
          return unsubscribe
        },
        onPermissionRequest: (handler) => {
          permission = handler
        },
        onExtRequest: vi.fn(),
        onExtNotification: vi.fn(),
      }
      const createGrokRuntime = vi.fn(() => runtime)
      const result = runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "grok-source",
            driver: "grok-cli",
            binaryPath: "verified-grok-test",
          }),
          modelSelection: { instanceId: "grok-source", model: "grok-4.6" },
          cwd: "/private/repository",
          prompt: "Summarize this conversation",
          schemaName: "threadContextSummary",
        },
        { run: vi.fn(), createGrokRuntime }
      )
      if (nonempty)
        await expect(result).resolves.toBe(
          '{"summary":"Carry these decisions forward."}'
        )
      else await expect(result).rejects.toThrow("Grok returned empty output")
      expect(runtime.setModel).toHaveBeenCalledWith("grok-4.6")
      expect(runtime.setMode).not.toHaveBeenCalled()
      expect(createGrokRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: expect.stringContaining("betterc0de-grok-text-generation-"),
        })
      )
      expect(runtime.close).toHaveBeenCalledTimes(1)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    }
  )

  it("admits native text generation in configurable FIFO order", async () => {
    vi.stubEnv("BETTERC0DE_NATIVE_TEXT_GENERATION_MAX_CONCURRENT", "1")
    vi.stubEnv("BETTERC0DE_NATIVE_TEXT_GENERATION_MAX_QUEUED", "3")
    const started: string[] = []
    const releases: Array<() => void> = []
    const runner: NativeTextGenerationRunner = {
      run: vi.fn(async (_command, _args, options) => {
        started.push(options.stdin)
        await new Promise<void>((resolve) => releases.push(resolve))
        return {
          stdout: JSON.stringify({
            structured_output: { title: options.stdin },
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
        }
      }),
    }
    const settings = settingsWithInstance({
      instanceId: "claude-fifo",
      driver: "claude",
      binaryPath: "claude-test",
    })
    const generate = (prompt: string) =>
      runNativeTextGeneration(
        {
          settings,
          modelSelection: {
            instanceId: "claude-fifo",
            model: "claude-opus-4-7",
          },
          prompt,
          schemaName: "threadTitle",
        },
        runner
      )

    const first = generate("first")
    const second = generate("second")
    const third = generate("third")
    await vi.waitFor(() => expect(started).toEqual(["first"]))

    releases.shift()!()
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]))
    releases.shift()!()
    await vi.waitFor(() =>
      expect(started).toEqual(["first", "second", "third"])
    )
    releases.shift()!()

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      '{"title":"first"}',
      '{"title":"second"}',
      '{"title":"third"}',
    ])
  })

  it("rejects native text generation when the bounded queue is full", async () => {
    vi.stubEnv("BETTERC0DE_NATIVE_TEXT_GENERATION_MAX_CONCURRENT", "1")
    vi.stubEnv("BETTERC0DE_NATIVE_TEXT_GENERATION_MAX_QUEUED", "1")
    const releases: Array<() => void> = []
    const runner: NativeTextGenerationRunner = {
      run: vi.fn(async () => {
        await new Promise<void>((resolve) => releases.push(resolve))
        return {
          stdout: '{"structured_output":{"title":"ok"}}',
          stderr: "",
          exitCode: 0,
          signal: null,
        }
      }),
    }
    const input = {
      settings: settingsWithInstance({
        instanceId: "claude-bounded",
        driver: "claude",
        binaryPath: "claude-test",
      }),
      modelSelection: {
        instanceId: "claude-bounded",
        model: "claude-opus-4-7",
      },
      prompt: "bounded",
      schemaName: "threadTitle" as const,
    }

    const first = runNativeTextGeneration(input, runner)
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1))
    const second = runNativeTextGeneration(input, runner)
    const thirdRejection = expect(
      runNativeTextGeneration(input, runner)
    ).rejects.toMatchObject({
      code: "NATIVE_TEXT_GENERATION_QUEUE_FULL",
      statusCode: 503,
    })
    await thirdRejection

    releases.shift()!()
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(2))
    releases.shift()!()
    await expect(Promise.all([first, second])).resolves.toEqual([
      '{"title":"ok"}',
      '{"title":"ok"}',
    ])
  })

  it("rejects queued work and aborts the active runner during shutdown", async () => {
    vi.stubEnv("BETTERC0DE_NATIVE_TEXT_GENERATION_MAX_CONCURRENT", "1")
    vi.stubEnv("BETTERC0DE_NATIVE_TEXT_GENERATION_MAX_QUEUED", "4")
    const runner: NativeTextGenerationRunner = {
      run: vi.fn(
        async (_command, _args, options) =>
          await new Promise<never>((_resolve, reject) => {
            const rejectForAbort = () =>
              reject(
                options.signal?.reason ??
                  new Error("native text generation aborted")
              )
            options.signal?.addEventListener("abort", rejectForAbort, {
              once: true,
            })
            if (options.signal?.aborted) rejectForAbort()
          })
      ),
    }
    const input = {
      settings: settingsWithInstance({
        instanceId: "claude-shutdown-queue",
        driver: "claude",
        binaryPath: "claude-test",
      }),
      modelSelection: {
        instanceId: "claude-shutdown-queue",
        model: "claude-opus-4-7",
      },
      prompt: "shutdown",
      schemaName: "threadTitle" as const,
    }

    const active = runNativeTextGeneration(input, runner)
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1))
    const queued = runNativeTextGeneration(input, runner)
    const activeRejection = expect(active).rejects.toMatchObject({
      code: "NATIVE_TEXT_GENERATION_SHUTDOWN",
    })
    const queuedRejection = expect(queued).rejects.toMatchObject({
      code: "NATIVE_TEXT_GENERATION_SHUTDOWN",
    })

    await expect(
      shutdownAllNativeTextGenerationResources()
    ).resolves.toBeGreaterThanOrEqual(2)
    await Promise.all([activeRejection, queuedRejection])
    expect(runner.run).toHaveBeenCalledTimes(1)
    expect(activeNativeTextGenerationResourceCount()).toBe(0)
  })

  it("does not invoke a runner when shutdown wins before spawn", async () => {
    const runner: NativeTextGenerationRunner = {
      run: vi.fn(async () => ({
        stdout: '{"structured_output":{"title":"late"}}',
        stderr: "",
        exitCode: 0,
        signal: null,
      })),
    }
    const running = runNativeTextGeneration(
      {
        settings: settingsWithInstance({
          instanceId: "claude-abort-before-spawn",
          driver: "claude",
          binaryPath: "claude-test",
        }),
        modelSelection: {
          instanceId: "claude-abort-before-spawn",
          model: "claude-opus-4-7",
        },
        prompt: "must not spawn",
        schemaName: "threadTitle",
      },
      runner
    )
    const rejection = expect(running).rejects.toMatchObject({
      code: "NATIVE_TEXT_GENERATION_SHUTDOWN",
    })

    await expect(
      shutdownAllNativeTextGenerationResources()
    ).resolves.toBeGreaterThanOrEqual(1)
    await rejection
    expect(runner.run).not.toHaveBeenCalled()
  })

  it("waits for a timed-out native provider process tree to exit", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "betterc0de-native-tree-"))
    )
    const pidFile = path.join(root, "descendant.pid")
    const scriptPath = path.join(root, "codex-runner.cjs")
    const binaryPath =
      process.platform === "win32"
        ? path.join(root, "codex.cmd")
        : path.join(root, "codex")
    let descendantPid: number | null = null
    try {
      await fs.writeFile(
        scriptPath,
        [
          'const { spawn } = require("node:child_process")',
          'const fs = require("node:fs")',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
          "setInterval(() => {}, 1000)",
        ].join("\n"),
        "utf8"
      )
      await fs.writeFile(
        binaryPath,
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`
          : `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)})\n`,
        "utf8"
      )
      await fs.chmod(binaryPath, 0o755)

      await expect(
        runNativeTextGeneration({
          settings: settingsWithInstance({
            instanceId: "codex-timeout-tree",
            driver: "codex",
            binaryPath,
          }),
          modelSelection: {
            instanceId: "codex-timeout-tree",
            model: "gpt-5.4",
          },
          prompt: "Hang",
          schemaName: "threadTitle",
          // Long enough for the fake CLI (cmd -> node -> node on Windows) to
          // start its descendant before the timeout fires. 100 ms raced the
          // start-up on slow runners: the tree was killed half-started (macOS
          // Intel: no pid file; loaded Windows: unconfirmed cleanup).
          timeoutMs: 3_000,
        })
      ).rejects.toThrow(/timed out/i)

      expect(
        fsSync.existsSync(pidFile),
        "the fake CLI had not started its descendant when the timeout fired"
      ).toBe(true)
      descendantPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10)
      expect(isProcessRunning(descendantPid)).toBe(false)
    } finally {
      if (descendantPid && isProcessRunning(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL")
        } catch {
          // The process may exit between the liveness check and cleanup.
        }
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it("terminates a running native provider process tree when shutdown aborts it", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(
        path.join(os.tmpdir(), "betterc0de-native-shutdown-tree-")
      )
    )
    const pidFile = path.join(root, "descendant.pid")
    const scriptPath = path.join(root, "codex-runner.cjs")
    const binaryPath =
      process.platform === "win32"
        ? path.join(root, "codex.cmd")
        : path.join(root, "codex")
    let descendantPid: number | null = null
    try {
      await fs.writeFile(
        scriptPath,
        [
          'const { spawn } = require("node:child_process")',
          'const fs = require("node:fs")',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
          "setInterval(() => {}, 1000)",
        ].join("\n"),
        "utf8"
      )
      await fs.writeFile(
        binaryPath,
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`
          : `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)})\n`,
        "utf8"
      )
      await fs.chmod(binaryPath, 0o755)

      const running = runNativeTextGeneration({
        settings: settingsWithInstance({
          instanceId: "codex-shutdown-tree",
          driver: "codex",
          binaryPath,
        }),
        modelSelection: {
          instanceId: "codex-shutdown-tree",
          model: "gpt-5.4",
        },
        prompt: "Hang until shutdown",
        schemaName: "threadTitle",
        timeoutMs: 30_000,
      })
      const rejection = expect(running).rejects.toMatchObject({
        code: "NATIVE_TEXT_GENERATION_SHUTDOWN",
      })
      await vi.waitFor(async () => {
        descendantPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10)
        expect(descendantPid).toBeGreaterThan(0)
      })

      await expect(
        shutdownAllNativeTextGenerationResources()
      ).resolves.toBeGreaterThanOrEqual(2)
      await rejection
      expect(isProcessRunning(descendantPid!)).toBe(false)
      expect(activeNativeTextGenerationResourceCount()).toBe(0)
    } finally {
      if (descendantPid && isProcessRunning(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL")
        } catch {
          // The process may exit between the liveness check and cleanup.
        }
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it("drains a local compatibility server that is still starting", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(
        path.join(os.tmpdir(), "betterc0de-native-server-startup-")
      )
    )
    const pidFile = path.join(root, "server.pid")
    const scriptPath = path.join(root, "server.cjs")
    const binaryPath =
      process.platform === "win32"
        ? path.join(root, "betterc0de.cmd")
        : path.join(root, "betterc0de")
    let serverPid: number | null = null
    try {
      await fs.writeFile(
        scriptPath,
        [
          'const fs = require("node:fs")',
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
          "setInterval(() => {}, 1000)",
        ].join("\n"),
        "utf8"
      )
      await fs.writeFile(
        binaryPath,
        process.platform === "win32"
          ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
          : `#!/usr/bin/env node\nrequire(${JSON.stringify(scriptPath)})\n`,
        "utf8"
      )
      await fs.chmod(binaryPath, 0o755)

      const running = runNativeTextGeneration({
        settings: settingsWithInstance({
          instanceId: "betterc0de-startup-shutdown",
          driver: "betterc0de",
          binaryPath,
        }),
        modelSelection: {
          instanceId: "betterc0de-startup-shutdown",
          model: "openai/gpt-5",
        },
        prompt: "Generate title",
        schemaName: "threadTitle",
      })
      const rejection = expect(running).rejects.toThrow(
        /exited before ready|shutting down/i
      )
      await vi.waitFor(async () => {
        serverPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10)
        expect(serverPid).toBeGreaterThan(0)
      })
      expect(activeNativeTextGenerationResourceCount()).toBeGreaterThanOrEqual(
        2
      )

      await expect(
        shutdownAllNativeTextGenerationResources()
      ).resolves.toBeGreaterThanOrEqual(2)
      await rejection
      expect(isProcessRunning(serverPid!)).toBe(false)
      expect(activeNativeTextGenerationResourceCount()).toBe(0)
      resumeNativeTextGenerationAdmissions()
    } finally {
      if (serverPid && isProcessRunning(serverPid)) {
        try {
          process.kill(serverPid, "SIGKILL")
        } catch {
          // The process may exit between the liveness check and cleanup.
        }
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it("does not let provider overrides reintroduce denied child environment keys", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined
    const runner: NativeTextGenerationRunner = {
      run: async (_command, args, options) => {
        capturedEnv = options.env
        const outputIndex = args.indexOf("--output-last-message")
        await fs.writeFile(args[outputIndex + 1], '{"title":"safe"}', "utf8")
        return { stdout: "", stderr: "", exitCode: 0, signal: null }
      },
    }

    await runNativeTextGeneration(
      {
        settings: settingsWithInstance({
          instanceId: "codex-safe-env",
          driver: "codex",
          binaryPath: "codex-test",
          environment: [
            { name: "SAFE_PROVIDER_VALUE", value: "allowed" },
            { name: "NODE_OPTIONS", value: "--require ./injected.js" },
            { name: "LD_PRELOAD", value: "/tmp/injected.so" },
          ],
        }),
        modelSelection: { instanceId: "codex-safe-env", model: "gpt-5.4" },
        prompt: "Generate JSON",
        schemaName: "threadTitle",
      },
      runner
    )

    expect(capturedEnv).toMatchObject({ SAFE_PROVIDER_VALUE: "allowed" })
    expect(capturedEnv).not.toHaveProperty("NODE_OPTIONS")
    expect(capturedEnv).not.toHaveProperty("LD_PRELOAD")
  })

  it("runs Codex CLI text generation with read-only structured output", async () => {
    const calls: Array<{
      command: string
      args: ReadonlyArray<string>
      stdin: string
    }> = []
    const runner: NativeTextGenerationRunner = {
      run: async (command, args, options) => {
        calls.push({ command, args, stdin: options.stdin })
        const outputIndex = args.indexOf("--output-last-message")
        const outputPath = args[outputIndex + 1]
        await fs.writeFile(
          outputPath,
          '{"subject":"Fix login flow","body":"","branch":"login-flow"}',
          "utf8"
        )
        return { stdout: "", stderr: "", exitCode: 0, signal: null }
      },
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "codex-work",
            driver: "codex",
            binaryPath: "codex-test",
          }),
          modelSelection: {
            instanceId: "codex-work",
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          },
          prompt: "Generate commit JSON",
          schemaName: "commitMessageWithBranch",
        },
        runner
      )
    ).resolves.toBe(
      '{"subject":"Fix login flow","body":"","branch":"login-flow"}'
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe("codex-test")
    expect(calls[0].stdin).toBe("Generate commit JSON")
    expect(calls[0].args).toEqual(
      expect.arrayContaining([
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "--model",
        "gpt-5.4",
        "--config",
        "model_reasoning_effort='high'",
        "--output-schema",
        "--output-last-message",
        "-",
      ])
    )
    expect(calls[0].args).toEqual(
      expect.arrayContaining(["--config", "service_tier='fast'"])
    )
  })

  it("uses Finder's resolved Codex CLI for a provider handoff", async () => {
    const installedCodex = path.join(os.tmpdir(), "installed-codex")
    vi.stubEnv("BETTERC0DE_CODEX_CLI_PATH", installedCodex)
    const run = vi.fn<NativeTextGenerationRunner["run"]>().mockResolvedValue({
      stdout: '{"summary":"Continue the current work."}',
      stderr: "",
      exitCode: 0,
      signal: null,
    })

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "codex-work",
            driver: "codex",
            binaryPath: "codex",
          }),
          modelSelection: { instanceId: "codex-work", model: "gpt-5.4" },
          prompt: "Summarize the conversation for the next provider",
          schemaName: "threadContextSummary",
        },
        { run }
      )
    ).resolves.toBe('{"summary":"Continue the current work."}')
    expect(run).toHaveBeenCalledWith(
      installedCodex,
      expect.any(Array),
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it("rejects an oversized Codex output file without reading it unbounded", async () => {
    const runner: NativeTextGenerationRunner = {
      run: async (_command, args) => {
        const outputIndex = args.indexOf("--output-last-message")
        await fs.writeFile(
          args[outputIndex + 1],
          Buffer.alloc(2 * 1024 * 1024 + 1, 0x78)
        )
        return { stdout: "", stderr: "", exitCode: 0, signal: null }
      },
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "codex-oversized-output",
            driver: "codex",
            binaryPath: "codex-test",
          }),
          modelSelection: {
            instanceId: "codex-oversized-output",
            model: "gpt-5.4",
          },
          prompt: "Generate JSON",
          schemaName: "threadTitle",
        },
        runner
      )
    ).rejects.toThrow(/output exceeded 2097152 bytes/i)
  })

  it("runs Claude CLI text generation and unwraps structured_output", async () => {
    const calls: Array<{
      command: string
      args: ReadonlyArray<string>
      cwd: string
    }> = []
    const runner: NativeTextGenerationRunner = {
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd })
        return {
          stdout:
            '{"structured_output":{"title":"Provider routing","body":"## Summary"}}',
          stderr: "",
          exitCode: 0,
          signal: null,
        }
      },
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "claude-work",
            driver: "claude",
            binaryPath: "claude-test",
          }),
          modelSelection: {
            instanceId: "claude-work",
            model: "claude-opus-4-7",
            options: [{ id: "effort", value: "xhigh" }],
          },
          prompt: "Generate PR JSON",
          schemaName: "prContent",
          cwd: process.cwd(),
        },
        runner
      )
    ).resolves.toBe('{"title":"Provider routing","body":"## Summary"}')

    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe("claude-test")
    expect(calls[0].args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        "--model",
        "claude-opus-4-7",
        "--effort",
        "max",
        "--tools",
        "",
        "--disallowedTools",
      ])
    )
    expect(calls[0].args).not.toContain("--dangerously-skip-permissions")
    expect(calls[0].cwd).not.toBe(process.cwd())
  })

  it("uses the packaged app's resolved Claude binary for a handoff", async () => {
    const installedClaude = path.join(os.tmpdir(), "installed-claude")
    vi.stubEnv("BETTERC0DE_CLAUDE_CODE_PATH", installedClaude)
    const run = vi.fn<NativeTextGenerationRunner["run"]>().mockResolvedValue({
      stdout: '{"structured_output":{"summary":"Keep the current goal."}}',
      stderr: "",
      exitCode: 0,
      signal: null,
    })

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "claude-work",
            driver: "claude",
            binaryPath: "",
          }),
          modelSelection: {
            instanceId: "claude-work",
            model: "claude-sonnet-5",
          },
          prompt: "Summarize the conversation for the next provider",
          schemaName: "threadContextSummary",
        },
        { run }
      )
    ).resolves.toBe('{"summary":"Keep the current goal."}')
    expect(run).toHaveBeenCalledWith(
      installedClaude,
      expect.any(Array),
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })

  it("uses the Claude Terminal provider instance as hidden Claude CLI text generation", async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = []
    const runner: NativeTextGenerationRunner = {
      run: async (command, args) => {
        calls.push({ command, args })
        return {
          stdout:
            '{"structured_output":{"summary":"Compacted thread context"}}',
          stderr: "",
          exitCode: 0,
          signal: null,
        }
      },
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "claude-terminal",
            driver: "claude-terminal",
            binaryPath: "claude-test",
          }),
          modelSelection: {
            instanceId: "claude-terminal",
            model: "claude-opus-4-7",
            options: [{ id: "effort", value: "max" }],
          },
          prompt: "Compact thread context JSON",
          schemaName: "threadContextSummary",
        },
        runner
      )
    ).resolves.toBe('{"summary":"Compacted thread context"}')

    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe("claude-test")
    expect(calls[0].args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        "--model",
        "claude-opus-4-7",
        "--effort",
        "max",
        "--tools",
        "",
        "--disallowedTools",
      ])
    )
    expect(calls[0].args).not.toContain("--dangerously-skip-permissions")
  })

  it("runs BetterC0de compatibility SDK text generation through an external server", async () => {
    const sessionCreate = vi.fn(async () => ({ data: { id: "oc-session-1" } }))
    const sessionPrompt = vi.fn(async () => ({
      data: {
        parts: [
          {
            type: "text",
            text: 'Sure.\n```json\n{"branch":"BetterC0de compatibility Flow"}\n```',
          },
        ],
      },
    }))
    const sessionDelete = vi.fn(async () => ({}))
    const close = vi.fn(async () => {})
    const connectBetterC0deServer = vi.fn(async () => ({
      url: "http://127.0.0.1:4096",
      external: true,
      close,
    }))
    const createBetterC0deClient = vi.fn(
      async (_input: { readonly baseUrl: string }) => ({
        session: {
          create: sessionCreate,
          prompt: sessionPrompt,
          delete: sessionDelete,
        },
      })
    )
    const runner: NativeTextGenerationRunner = {
      run: async () => {
        throw new Error("process runner should not be called")
      },
      connectBetterC0deServer,
      createBetterC0deClient,
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "betterc0de-work",
            driver: "open-code",
            binaryPath: "betterc0de-test",
            config: {
              serverUrl: "http://127.0.0.1:4096",
              serverUsername: "alice",
              serverPassword: "secret",
            },
          }),
          modelSelection: {
            instanceId: "betterc0de-work",
            model: "openai/gpt-5",
            options: [
              { id: "agent", value: "build" },
              { id: "variant", value: "high" },
            ],
          },
          prompt: "Generate branch JSON",
          schemaName: "branchName",
        },
        runner
      )
    ).resolves.toBe('{"branch":"BetterC0de compatibility Flow"}')

    expect(connectBetterC0deServer).toHaveBeenCalledWith({
      binaryPath: "betterc0de-test",
      serverUrl: "http://127.0.0.1:4096",
      env: expect.any(Object),
    })
    expect(createBetterC0deClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:4096",
      directory: expect.any(String),
      serverUsername: "alice",
      serverPassword: "secret",
    })
    expect(sessionCreate).toHaveBeenCalledWith(
      {
        title: "BetterC0de branchName",
        permission: [{ permission: "*", pattern: "*", action: "deny" }],
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(sessionPrompt).toHaveBeenCalledWith(
      {
        sessionID: "oc-session-1",
        model: { providerID: "openai", modelID: "gpt-5" },
        agent: "build",
        variant: "high",
        parts: [{ type: "text", text: "Generate branch JSON" }],
      },
      { signal: expect.any(AbortSignal) }
    )
    expect(sessionDelete).toHaveBeenCalledWith(
      { sessionID: "oc-session-1" },
      { signal: expect.any(AbortSignal) }
    )
    expect(close).toHaveBeenCalled()
  })

  it("retains and retries failed external compatibility session cleanup", async () => {
    const deleteFailure = new Error("external session delete failed")
    const sessionDelete = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(deleteFailure)
      .mockRejectedValueOnce(deleteFailure)
      .mockResolvedValueOnce({})
    const close = vi.fn(async () => {})
    const runner: NativeTextGenerationRunner = {
      run: async () => {
        throw new Error("process runner should not be called")
      },
      connectBetterC0deServer: vi.fn(async () => ({
        url: "http://127.0.0.1:4097",
        external: true,
        close,
      })),
      createBetterC0deClient: vi.fn(async () => ({
        session: {
          create: vi.fn(async () => ({ data: { id: "external-session" } })),
          prompt: vi.fn(async () => ({
            data: { parts: [{ type: "text", text: '{"title":"safe"}' }] },
          })),
          delete: sessionDelete,
        },
      })),
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "betterc0de-external-cleanup",
            driver: "betterc0de",
            binaryPath: "betterc0de-test",
            config: { serverUrl: "http://127.0.0.1:4097" },
          }),
          modelSelection: {
            instanceId: "betterc0de-external-cleanup",
            model: "openai/gpt-5",
          },
          prompt: "Generate title",
          schemaName: "threadTitle",
        },
        runner
      )
    ).rejects.toThrow("external session delete failed")
    expect(activeNativeTextGenerationResourceCount()).toBe(1)
    expect(sessionDelete).toHaveBeenCalledTimes(1)

    await expect(
      shutdownAllNativeTextGenerationResources()
    ).rejects.toMatchObject({ name: "AggregateError" })
    expect(activeNativeTextGenerationResourceCount()).toBe(1)
    expect(sessionDelete).toHaveBeenCalledTimes(2)

    await expect(
      shutdownAllNativeTextGenerationResources()
    ).resolves.toBeGreaterThanOrEqual(1)
    expect(activeNativeTextGenerationResourceCount()).toBe(0)
    expect(sessionDelete).toHaveBeenCalledTimes(3)
    expect(close).toHaveBeenCalledOnce()
  })

  it("fails closed when the external session-cleanup backlog reaches its cap", async () => {
    vi.stubEnv(
      "BETTERC0DE_NATIVE_TEXT_GENERATION_MAX_PENDING_SESSION_CLEANUPS",
      "1"
    )
    const sessionDelete = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("delete unavailable"))
      .mockResolvedValueOnce({})
    const connectBetterC0deServer = vi.fn(async () => ({
      url: "http://127.0.0.1:4098",
      external: true,
      close: vi.fn(async () => {}),
    }))
    const runner: NativeTextGenerationRunner = {
      run: async () => {
        throw new Error("process runner should not be called")
      },
      connectBetterC0deServer,
      createBetterC0deClient: vi.fn(async () => ({
        session: {
          create: vi.fn(async () => ({ data: { id: "backlog-session" } })),
          prompt: vi.fn(async () => ({
            data: { parts: [{ type: "text", text: '{"title":"safe"}' }] },
          })),
          delete: sessionDelete,
        },
      })),
    }
    const input = {
      settings: settingsWithInstance({
        instanceId: "betterc0de-cleanup-backlog",
        driver: "betterc0de",
        binaryPath: "betterc0de-test",
        config: { serverUrl: "http://127.0.0.1:4098" },
      }),
      modelSelection: {
        instanceId: "betterc0de-cleanup-backlog",
        model: "openai/gpt-5",
      },
      prompt: "Generate title",
      schemaName: "threadTitle" as const,
    }

    await expect(runNativeTextGeneration(input, runner)).rejects.toThrow(
      "delete unavailable"
    )
    await expect(runNativeTextGeneration(input, runner)).rejects.toMatchObject({
      code: "NATIVE_TEXT_GENERATION_CLEANUP_BACKLOG_FULL",
      statusCode: 503,
    })
    expect(connectBetterC0deServer).toHaveBeenCalledTimes(1)
    expect(activeNativeTextGenerationResourceCount()).toBe(1)

    await expect(
      shutdownAllNativeTextGenerationResources()
    ).resolves.toBeGreaterThanOrEqual(1)
    expect(activeNativeTextGenerationResourceCount()).toBe(0)
  })

  it("extracts the first balanced BetterC0de compatibility JSON object", async () => {
    const sessionPrompt = vi.fn(async () => ({
      data: {
        parts: [
          {
            type: "text",
            text: 'Sure {"branch":"Provider } Routing"} trailing {"branch":"Wrong"}',
          },
        ],
      },
    }))
    const close = vi.fn(async () => {})
    const runner: NativeTextGenerationRunner = {
      run: async () => {
        throw new Error("process runner should not be called")
      },
      connectBetterC0deServer: vi.fn(async () => ({
        url: "http://127.0.0.1:4096",
        external: true,
        close,
      })),
      createBetterC0deClient: vi.fn(async () => ({
        session: {
          create: vi.fn(async () => ({ data: { id: "oc-session-1" } })),
          prompt: sessionPrompt,
          delete: vi.fn(async () => ({})),
        },
      })),
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "betterc0de-work",
            driver: "betterc0de",
            binaryPath: "betterc0de-test",
            config: { serverUrl: "http://127.0.0.1:4096" },
          }),
          modelSelection: {
            instanceId: "betterc0de-work",
            model: "openai/gpt-5",
            options: [],
          },
          prompt: "Generate branch JSON",
          schemaName: "branchName",
        },
        runner
      )
    ).resolves.toBe('{"branch":"Provider } Routing"}')

    expect(close).toHaveBeenCalled()
  })

  it("reuses a local BetterC0de compatibility text-generation server until the idle timeout", async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn(async () => {})
      const connectBetterC0deServer = vi.fn(async () => ({
        url: "http://127.0.0.1:4100",
        external: false,
        close,
      }))
      const sessionCreate = vi.fn(async () => ({
        data: { id: "oc-session-1" },
      }))
      const sessionPrompt = vi.fn(async () => ({
        data: { parts: [{ type: "text", text: '{"branch":"shared-server"}' }] },
      }))
      const createBetterC0deClient = vi.fn(async () => ({
        session: {
          create: sessionCreate,
          prompt: sessionPrompt,
        },
      }))
      const runner: NativeTextGenerationRunner = {
        run: async () => {
          throw new Error("process runner should not be called")
        },
        connectBetterC0deServer,
        createBetterC0deClient,
      }
      const settings = settingsWithInstance({
        instanceId: "betterc0de-local",
        driver: "betterc0de",
        binaryPath: "betterc0de-test",
      })

      await runNativeTextGeneration(
        {
          settings,
          modelSelection: {
            instanceId: "betterc0de-local",
            model: "openai/gpt-5",
          },
          prompt: "Generate branch JSON",
          schemaName: "branchName",
        },
        runner
      )
      await runNativeTextGeneration(
        {
          settings,
          modelSelection: {
            instanceId: "betterc0de-local",
            model: "openai/gpt-5",
          },
          prompt: "Generate branch JSON again",
          schemaName: "branchName",
        },
        runner
      )

      expect(connectBetterC0deServer).toHaveBeenCalledTimes(1)
      expect(createBetterC0deClient).toHaveBeenCalledTimes(2)
      expect(close).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(30_000)
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      await vi.runOnlyPendingTimersAsync()
      vi.useRealTimers()
    }
  })

  it("serializes concurrent local compatibility server acquisition", async () => {
    vi.useFakeTimers()
    try {
      let resolveServer!: (value: {
        url: string
        external: false
        close: () => Promise<void>
      }) => void
      const close = vi.fn(async () => {})
      const connectBetterC0deServer = vi.fn(
        () =>
          new Promise<{
            url: string
            external: false
            close: () => Promise<void>
          }>((resolve) => {
            resolveServer = resolve
          })
      )
      const createBetterC0deClient = vi.fn(async () => ({
        session: {
          create: vi.fn(async () => ({ data: { id: "session" } })),
          prompt: vi.fn(async () => ({
            data: { parts: [{ type: "text", text: '{"title":"safe"}' }] },
          })),
        },
      }))
      const runner: NativeTextGenerationRunner = {
        run: async () => {
          throw new Error("process runner should not be called")
        },
        connectBetterC0deServer,
        createBetterC0deClient,
      }
      const settings = settingsWithInstance({
        instanceId: "betterc0de-concurrent",
        driver: "betterc0de",
        binaryPath: "betterc0de-concurrent-test",
      })
      const input = {
        settings,
        modelSelection: {
          instanceId: "betterc0de-concurrent",
          model: "openai/gpt-5",
        },
        prompt: "Generate title",
        schemaName: "threadTitle" as const,
      }

      const first = runNativeTextGeneration(input, runner)
      const second = runNativeTextGeneration(input, runner)
      await vi.waitFor(() =>
        expect(connectBetterC0deServer).toHaveBeenCalledTimes(1)
      )
      resolveServer({
        url: "http://127.0.0.1:4101",
        external: false,
        close,
      })

      await expect(Promise.all([first, second])).resolves.toEqual([
        '{"title":"safe"}',
        '{"title":"safe"}',
      ])
      expect(connectBetterC0deServer).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      await vi.runOnlyPendingTimersAsync()
      vi.useRealTimers()
    }
  })

  it("isolates concurrent local compatibility servers by binary and hashed environment fingerprint", async () => {
    let releasePrompts!: () => void
    const promptGate = new Promise<void>((resolve) => {
      releasePrompts = resolve
    })
    const closes = [
      vi.fn(async () => {}),
      vi.fn(async () => {}),
      vi.fn(async () => {}),
    ]
    const connectBetterC0deServer = vi.fn(async () => {
      const index = connectBetterC0deServer.mock.calls.length - 1
      return {
        url: `http://127.0.0.1:${4200 + index}`,
        external: false,
        close: closes[index]!,
      }
    })
    const createBetterC0deClient = vi.fn(
      async (_input: { readonly baseUrl: string }) => ({
        session: {
          create: vi.fn(async () => ({ data: { id: "session" } })),
          prompt: vi.fn(async () => {
            await promptGate
            return {
              data: { parts: [{ type: "text", text: '{"title":"isolated"}' }] },
            }
          }),
        },
      })
    )
    const runner: NativeTextGenerationRunner = {
      run: async () => {
        throw new Error("process runner should not be called")
      },
      connectBetterC0deServer,
      createBetterC0deClient,
    }
    const makeInput = (
      instanceId: string,
      binaryPath: string,
      secret: string
    ) => ({
      settings: settingsWithInstance({
        instanceId,
        driver: "betterc0de",
        binaryPath,
        environment: [
          { name: "BETTERC0DE_TEST_SECRET", value: secret, sensitive: true },
        ],
      }),
      modelSelection: {
        instanceId,
        model: "openai/gpt-5",
      },
      prompt: "Generate title",
      schemaName: "threadTitle" as const,
    })

    const first = runNativeTextGeneration(
      makeInput("betterc0de-fingerprint-a", "betterc0de-shared", "secret-one"),
      runner
    )
    await vi.waitFor(() =>
      expect(connectBetterC0deServer).toHaveBeenCalledTimes(1)
    )
    const second = runNativeTextGeneration(
      makeInput("betterc0de-fingerprint-b", "betterc0de-shared", "secret-two"),
      runner
    )
    await vi.waitFor(() =>
      expect(connectBetterC0deServer).toHaveBeenCalledTimes(2)
    )
    const third = runNativeTextGeneration(
      makeInput("betterc0de-fingerprint-c", "betterc0de-other", "secret-two"),
      runner
    )
    await vi.waitFor(() =>
      expect(connectBetterC0deServer).toHaveBeenCalledTimes(3)
    )

    releasePrompts()
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      '{"title":"isolated"}',
      '{"title":"isolated"}',
      '{"title":"isolated"}',
    ])
    expect(
      new Set(createBetterC0deClient.mock.calls.map(([input]) => input.baseUrl))
        .size
    ).toBe(3)
  })

  it("retains shared-server ownership when shutdown close fails and retries safely", async () => {
    const closeFailure = new Error("close failed")
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(closeFailure)
      .mockResolvedValueOnce(undefined)
    const runner: NativeTextGenerationRunner = {
      run: async () => {
        throw new Error("process runner should not be called")
      },
      connectBetterC0deServer: vi.fn(async () => ({
        url: "http://127.0.0.1:4300",
        external: false,
        close,
      })),
      createBetterC0deClient: vi.fn(async () => ({
        session: {
          create: vi.fn(async () => ({ data: { id: "session" } })),
          prompt: vi.fn(async () => ({
            data: { parts: [{ type: "text", text: '{"title":"safe"}' }] },
          })),
        },
      })),
    }
    await runNativeTextGeneration(
      {
        settings: settingsWithInstance({
          instanceId: "betterc0de-close-retry",
          driver: "betterc0de",
          binaryPath: "betterc0de-close-retry",
        }),
        modelSelection: {
          instanceId: "betterc0de-close-retry",
          model: "openai/gpt-5",
        },
        prompt: "Generate title",
        schemaName: "threadTitle",
      },
      runner
    )

    await expect(
      shutdownAllNativeTextGenerationResources()
    ).rejects.toMatchObject({ name: "AggregateError" })
    expect(activeNativeTextGenerationResourceCount()).toBe(1)

    await expect(
      shutdownAllNativeTextGenerationResources()
    ).resolves.toBeGreaterThanOrEqual(1)
    expect(activeNativeTextGenerationResourceCount()).toBe(0)
    expect(close).toHaveBeenCalledTimes(2)
    resumeNativeTextGenerationAdmissions()
  })

  it("aborts active compatibility requests and drains their shared server on shutdown", async () => {
    const prompt = vi.fn(() => new Promise<never>(() => {}))
    const close = vi.fn(async () => {})
    const runner: NativeTextGenerationRunner = {
      run: async () => {
        throw new Error("process runner should not be called")
      },
      connectBetterC0deServer: vi.fn(async () => ({
        url: "http://127.0.0.1:4301",
        external: false,
        close,
      })),
      createBetterC0deClient: vi.fn(async () => ({
        session: {
          create: vi.fn(async () => ({ data: { id: "session" } })),
          prompt,
        },
      })),
    }
    const running = runNativeTextGeneration(
      {
        settings: settingsWithInstance({
          instanceId: "betterc0de-shutdown",
          driver: "betterc0de",
          binaryPath: "betterc0de-shutdown",
        }),
        modelSelection: {
          instanceId: "betterc0de-shutdown",
          model: "openai/gpt-5",
        },
        prompt: "Generate title",
        schemaName: "threadTitle",
      },
      runner
    )
    const rejection = expect(running).rejects.toMatchObject({
      code: "NATIVE_TEXT_GENERATION_SHUTDOWN",
    })
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())

    await expect(
      shutdownAllNativeTextGenerationResources()
    ).resolves.toBeGreaterThanOrEqual(2)
    await rejection
    expect(close).toHaveBeenCalledOnce()
    expect(activeNativeTextGenerationResourceCount()).toBe(0)
    await expect(
      runNativeTextGeneration(
        {
          settings: defaultSettings(),
          modelSelection: null,
          prompt: "blocked",
          schemaName: "threadTitle",
        },
        runner
      )
    ).rejects.toMatchObject({
      code: "NATIVE_TEXT_GENERATION_ADMISSION_CLOSED",
    })
    resumeNativeTextGenerationAdmissions()
  })

  it("times out an unresponsive compatibility prompt and releases the server", async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn(async () => {})
      const runner: NativeTextGenerationRunner = {
        run: async () => {
          throw new Error("process runner should not be called")
        },
        connectBetterC0deServer: vi.fn(async () => ({
          url: "http://127.0.0.1:4102",
          external: true,
          close,
        })),
        createBetterC0deClient: vi.fn(async () => ({
          session: {
            create: vi.fn(async () => ({ data: { id: "session-timeout" } })),
            prompt: vi.fn(() => new Promise<never>(() => {})),
            delete: vi.fn(async () => ({})),
          },
        })),
      }
      const promise = runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "betterc0de-timeout",
            driver: "betterc0de",
            binaryPath: "betterc0de-timeout-test",
            config: { serverUrl: "http://127.0.0.1:4102" },
          }),
          modelSelection: {
            instanceId: "betterc0de-timeout",
            model: "openai/gpt-5",
          },
          prompt: "Generate title",
          schemaName: "threadTitle",
          timeoutMs: 25,
        },
        runner
      )
      const rejection = expect(promise).rejects.toThrow(/timed out/i)
      await vi.advanceTimersByTimeAsync(25)
      await rejection
      expect(close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("runs Cursor ACP text generation in ask mode with model config options", async () => {
    const calls: Array<ReadonlyArray<unknown>> = []
    let listener: ((event: { type: string; text?: string }) => void) | null =
      null
    let currentModeId = "default"
    const runtime = {
      start: vi.fn(async () => ({
        sessionId: "cursor-session-1",
        initializeResult: {},
        sessionSetupResult: {},
        configOptions: [],
      })),
      getConfigOptions: () => [
        {
          id: "reasoning",
          name: "Reasoning",
          category: "model_option",
          type: "select",
          options: [{ value: "extra-high", name: "Extra High" }],
        },
        {
          id: "context",
          name: "Context Window",
          category: "model_config",
          type: "select",
          options: [{ value: "1m", name: "1m tokens" }],
        },
        {
          id: "fast",
          name: "Fast Mode",
          category: "model_config",
          type: "select",
          options: [
            { value: "true", name: "True" },
            { value: "false", name: "False" },
          ],
        },
      ],
      getModeState: () => ({
        currentModeId,
        availableModes: [
          { id: "default", name: "Default" },
          { id: "ask", name: "Ask" },
        ],
      }),
      setConfigOption: vi.fn(
        async (configId: string, value: string | boolean) => {
          calls.push(["setConfigOption", configId, value])
          return {}
        }
      ),
      setModel: vi.fn(async (model: string) => {
        calls.push(["setModel", model])
      }),
      setMode: vi.fn(async (modeId: string) => {
        calls.push(["setMode", modeId])
        currentModeId = modeId
      }),
      prompt: vi.fn(
        async (input: { prompt: ReadonlyArray<Record<string, unknown>> }) => {
          calls.push(["prompt", input])
          listener?.({
            type: "content.delta",
            text: 'Here is the JSON:\n```json\n{"title":"Cursor title"}\n```',
          })
          return { stopReason: "completed" }
        }
      ),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onEvent: vi.fn(
        (nextListener: (event: { type: string; text?: string }) => void) => {
          listener = nextListener
          return () => {
            listener = null
          }
        }
      ),
      onPermissionRequest: vi.fn(),
      onExtRequest: vi.fn(),
      onExtNotification: vi.fn(),
    }
    const createCursorRuntime = vi.fn(() => runtime as never)
    const runner: NativeTextGenerationRunner = {
      run: async () => {
        throw new Error("process runner should not be called")
      },
      createCursorRuntime,
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "cursor-work",
            driver: "cursor-agent",
            binaryPath: "agent-test",
            config: { apiEndpoint: "http://127.0.0.1:9999" },
          }),
          modelSelection: {
            instanceId: "cursor-work",
            model: "gpt-5.4[reasoning=xhigh]",
            options: [
              { id: "reasoning", value: "xhigh" },
              { id: "contextWindow", value: "1m" },
              { id: "fastMode", value: true },
            ],
          },
          prompt: "Generate title JSON",
          schemaName: "threadTitle",
        },
        runner
      )
    ).resolves.toBe('{"title":"Cursor title"}')

    expect(createCursorRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: {
          binaryPath: "agent-test",
          apiEndpoint: "http://127.0.0.1:9999",
        },
        clientInfo: {
          name: "betterc0de-text-generation",
          title: "BetterC0de",
          version: "0.0.0",
        },
      })
    )
    expect(calls).toEqual([
      ["setMode", "ask"],
      ["setModel", "gpt-5.4"],
      ["setConfigOption", "reasoning", "extra-high"],
      ["setConfigOption", "context", "1m"],
      ["setConfigOption", "fast", "true"],
      ["prompt", { prompt: [{ type: "text", text: "Generate title JSON" }] }],
    ])
    expect(runtime.onPermissionRequest).toHaveBeenCalledTimes(1)
    expect(runtime.close).toHaveBeenCalled()
  })

  it("fails closed when Cursor does not advertise ask mode", async () => {
    const prompt = vi.fn(async () => ({ stopReason: "completed" }))
    const close = vi.fn(async () => {})
    const runtime = {
      start: vi.fn(async () => ({
        sessionId: "cursor-session-no-ask",
        initializeResult: {},
        sessionSetupResult: {},
        configOptions: [],
      })),
      getConfigOptions: () => [],
      getModeState: () => ({
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default" }],
      }),
      setConfigOption: vi.fn(async () => ({})),
      setModel: vi.fn(async () => {}),
      setMode: vi.fn(async () => {}),
      prompt,
      cancel: vi.fn(async () => {}),
      close,
      onEvent: vi.fn(() => () => {}),
      onPermissionRequest: vi.fn(),
      onExtRequest: vi.fn(),
      onExtNotification: vi.fn(),
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "cursor-no-ask",
            driver: "cursor-agent",
            binaryPath: "agent-test",
          }),
          modelSelection: {
            instanceId: "cursor-no-ask",
            model: "gpt-5.4",
          },
          prompt: "Generate title JSON",
          schemaName: "threadTitle",
        },
        {
          run: async () => {
            throw new Error("process runner should not be called")
          },
          createCursorRuntime: () => runtime as never,
        }
      )
    ).rejects.toThrow(/required ask permission mode/i)
    expect(prompt).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("caps Cursor streaming output and cancels the request", async () => {
    let listener: ((event: { type: string; text?: string }) => void) | null =
      null
    let currentModeId = "default"
    const cancel = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const runtime = {
      start: vi.fn(async () => ({
        sessionId: "cursor-session-oversized",
        initializeResult: {},
        sessionSetupResult: {},
        configOptions: [],
      })),
      getConfigOptions: () => [],
      getModeState: () => ({
        currentModeId,
        availableModes: [
          { id: "default", name: "Default" },
          { id: "ask", name: "Ask" },
        ],
      }),
      setConfigOption: vi.fn(async () => ({})),
      setModel: vi.fn(async () => {}),
      setMode: vi.fn(async (modeId: string) => {
        currentModeId = modeId
      }),
      prompt: vi.fn(async () => {
        listener?.({
          type: "content.delta",
          text: "x".repeat(2 * 1024 * 1024 + 1),
        })
        return { stopReason: "cancelled" }
      }),
      cancel,
      close,
      onEvent: vi.fn(
        (nextListener: (event: { type: string; text?: string }) => void) => {
          listener = nextListener
          return () => {
            listener = null
          }
        }
      ),
      onPermissionRequest: vi.fn(),
      onExtRequest: vi.fn(),
      onExtNotification: vi.fn(),
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "cursor-oversized",
            driver: "cursor-agent",
            binaryPath: "agent-test",
          }),
          modelSelection: {
            instanceId: "cursor-oversized",
            model: "gpt-5.4",
          },
          prompt: "Generate title JSON",
          schemaName: "threadTitle",
        },
        {
          run: async () => {
            throw new Error("process runner should not be called")
          },
          createCursorRuntime: () => runtime as never,
        }
      )
    ).rejects.toThrow(/output exceeded 2097152 bytes/i)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("returns null for unsupported provider-native text generation drivers", async () => {
    const runner: NativeTextGenerationRunner = {
      run: async () => {
        throw new Error("runner should not be called")
      },
    }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "zed",
            driver: "zed",
            binaryPath: "zed-agent",
          }),
          modelSelection: {
            instanceId: "zed",
            model: "composer-2",
          },
          prompt: "Generate branch JSON",
          schemaName: "branchName",
        },
        runner
      )
    ).resolves.toBeNull()
  })
})

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("Codex CLI argument hygiene", () => {
  it("rejects a reasoning effort outside the Codex ladder before spawning", async () => {
    const run = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
    }))
    const runner: NativeTextGenerationRunner = { run }

    await expect(
      runNativeTextGeneration(
        {
          settings: settingsWithInstance({
            instanceId: "codex-effort",
            driver: "codex",
            binaryPath: "codex-test",
          }),
          modelSelection: {
            instanceId: "codex-effort",
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: 'high"\napproval_policy="never' },
            ],
          },
          prompt: "Generate JSON",
          schemaName: "threadTitle",
        },
        runner
      )
    ).rejects.toMatchObject({ code: "NATIVE_TEXT_GENERATION_INVALID_EFFORT" })
    expect(run).not.toHaveBeenCalled()
  })

  it("runs in a private temporary directory when no workspace is given", async () => {
    const cwds: string[] = []
    const runner: NativeTextGenerationRunner = {
      run: async (_command, args, options) => {
        cwds.push(options.cwd)
        const outputPath = args[args.indexOf("--output-last-message") + 1]
        await fs.writeFile(outputPath, '{"title":"t"}', "utf8")
        return { stdout: "", stderr: "", exitCode: 0, signal: null }
      },
    }

    await runNativeTextGeneration(
      {
        settings: settingsWithInstance({
          instanceId: "codex-cwd",
          driver: "codex",
          binaryPath: "codex-test",
        }),
        modelSelection: { instanceId: "codex-cwd", model: "gpt-5.4" },
        prompt: "Generate JSON",
        schemaName: "threadTitle",
      },
      runner
    )

    expect(cwds).toHaveLength(1)
    expect(cwds[0]).not.toBe(process.cwd())
    const relativeToTmp = path.relative(os.tmpdir(), cwds[0]!)
    expect(relativeToTmp.startsWith("..")).toBe(false)
    expect(path.isAbsolute(relativeToTmp)).toBe(false)
  })
})
