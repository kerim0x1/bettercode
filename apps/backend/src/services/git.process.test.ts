import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  deleteCheckpointRefs,
  GitProcessService,
  setDefaultGitProcessService,
  stageAll,
  type GitAdmissionLimits,
  type GitProcessDependencies,
} from "./git"

interface FakeChild {
  readonly process: ChildProcessWithoutNullStreams
  readonly kill: ReturnType<typeof vi.fn>
  readonly stdinEnd: ReturnType<typeof vi.fn>
  close(code: number | null, signal?: NodeJS.Signals | null): void
}

function createFakeChild(pid: number): FakeChild {
  const stdout = Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    resume: vi.fn(),
  })
  const stderr = Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    resume: vi.fn(),
  })
  const stdinEnd = vi.fn()
  const stdin = Object.assign(new EventEmitter(), {
    end: stdinEnd,
    destroy: vi.fn(),
  })
  const kill = vi.fn(() => true)
  const process = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout,
    stderr,
    stdin,
    kill,
  }) as unknown as ChildProcessWithoutNullStreams

  return {
    process,
    kill,
    stdinEnd,
    close(code, signal = null) {
      if (process.exitCode !== null || process.signalCode !== null) return
      Object.assign(process, {
        exitCode: code,
        signalCode: signal,
      })
      process.emit("exit", code, signal)
      process.emit("close", code, signal)
    },
  }
}

/**
 * Fake spawns stand in for git itself. The executable is reported as the
 * bare name so a fake can tell git from taskkill, and the repository-helper
 * probe is answered synchronously so each spawn stays synchronous. Each
 * test builds its own service and installs it as the one the git helpers
 * under test run through.
 */
let git: GitProcessService

function useFakeGitProcesses(
  overrides: Partial<GitProcessDependencies>,
  admissionLimits?: Partial<GitAdmissionLimits>
): void {
  git = new GitProcessService({
    dependencies: {
      resolveGitExecutable: () => "git",
      repositoryHelperConfig: () => ({ filterKeys: [], sshCommand: false }),
      ...overrides,
    },
    admissionLimits,
  })
  setDefaultGitProcessService(git)
}

function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected promise to reject.")
    },
    (error: unknown) => error
  )
}

describe("Git child process lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    expect(git.activeProcessCount()).toBe(0)
    expect(git.queuedProcessCount()).toBe(0)
    setDefaultGitProcessService(null)
    vi.useRealTimers()
  })

  it("can close Git admission without spawning or terminating a child", async () => {
    const spawn = vi.fn()
    useFakeGitProcesses({
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    })

    git.beginShutdown()

    await expect(stageAll("C:\\repo")).rejects.toMatchObject({
      statusCode: 503,
      code: "GIT_SHUTTING_DOWN",
    })
    expect(spawn).not.toHaveBeenCalled()
    expect(git.activeProcessCount()).toBe(0)
  })

  it("bounds active and queued Git processes and drains the queue in order", async () => {
    const children: FakeChild[] = []
    const spawn = vi.fn(() => {
      const child = createFakeChild(40_000 + children.length)
      children.push(child)
      return child.process
    })
    useFakeGitProcesses(
      {
        platform: "win32",
        spawn: spawn as unknown as typeof import("node:child_process").spawn,
      },
      {
        maxConcurrent: 1,
        maxPerWorkspace: 1,
        maxQueued: 1,
        waitMs: 1_000,
      }
    )

    const first = stageAll("C:\\repo")
    const second = stageAll("C:\\repo")
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(git.activeProcessCount()).toBe(1)
    expect(git.queuedProcessCount()).toBe(1)

    await expect(stageAll("C:\\repo")).rejects.toMatchObject({
      statusCode: 503,
      code: "GIT_CAPACITY_EXCEEDED",
    })

    children[0]!.close(0)
    await first
    await Promise.resolve()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(git.queuedProcessCount()).toBe(0)

    children[1]!.close(0)
    await second
    expect(git.activeProcessCount()).toBe(0)
  })

  it("times out bounded Git queue waits without spawning another child", async () => {
    const child = createFakeChild(40_100)
    const spawn = vi.fn(() => child.process)
    useFakeGitProcesses(
      {
        platform: "win32",
        spawn: spawn as unknown as typeof import("node:child_process").spawn,
      },
      {
        maxConcurrent: 1,
        maxPerWorkspace: 1,
        maxQueued: 1,
        waitMs: 250,
      }
    )

    const first = stageAll("C:\\repo")
    const queued = stageAll("C:\\repo")
    const queuedFailure = expect(queued).rejects.toMatchObject({
      statusCode: 503,
      code: "GIT_ADMISSION_TIMEOUT",
    })
    expect(git.queuedProcessCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    await queuedFailure
    expect(spawn).toHaveBeenCalledTimes(1)

    child.close(0)
    await first
  })

  it("rejects queued Git work as soon as shutdown admission closes", async () => {
    const child = createFakeChild(40_200)
    const spawn = vi.fn(() => child.process)
    useFakeGitProcesses(
      {
        platform: "win32",
        spawn: spawn as unknown as typeof import("node:child_process").spawn,
      },
      {
        maxConcurrent: 1,
        maxPerWorkspace: 1,
        maxQueued: 2,
        waitMs: 1_000,
      }
    )

    const first = stageAll("C:\\repo")
    const queued = stageAll("C:\\repo")
    const queuedFailure = expect(queued).rejects.toMatchObject({
      statusCode: 503,
      code: "GIT_SHUTTING_DOWN",
    })
    expect(git.queuedProcessCount()).toBe(1)
    git.beginShutdown()
    await queuedFailure
    expect(git.queuedProcessCount()).toBe(0)

    child.close(0)
    await first
  })

  it("deletes large checkpoint-ref sets through bounded update-ref stdin batches", async () => {
    const children: FakeChild[] = []
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("git")
      expect(args.slice(-2)).toEqual(["update-ref", "--stdin"])
      expect(args).toContain("core.fsmonitor=false")
      expect(args).toContain("protocol.ext.allow=never")
      const child = createFakeChild(46_000 + children.length)
      children.push(child)
      queueMicrotask(() => child.close(0))
      return child.process
    })
    useFakeGitProcesses({
      platform: "linux",
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    })
    const checkpointRefs = Array.from(
      { length: 1_025 },
      (_, turn) => `refs/betterc0de/checkpoints/thread-batched/turn/${turn}`
    )

    await expect(
      deleteCheckpointRefs({ cwd: "/repo", checkpointRefs })
    ).resolves.toBeUndefined()

    expect(spawn).toHaveBeenCalledTimes(3)
    expect(children).toHaveLength(3)
    const batchInputs = children.map(
      (child) => child.stdinEnd.mock.calls[0]?.[0] as string
    )
    expect(
      batchInputs.map(
        (input) =>
          input.split("\n").filter((line) => line.startsWith("delete ")).length
      )
    ).toEqual([512, 512, 1])
    for (const input of batchInputs) {
      const lines = input.split("\n")
      expect(lines[0]).toBe("start")
      expect(lines.at(-3)).toBe("prepare")
      expect(lines.at(-2)).toBe("commit")
      expect(lines.at(-1)).toBe("")
    }
    expect(batchInputs[0]).toContain(`delete ${checkpointRefs[0]}`)
    expect(batchInputs[2]).toContain(`delete ${checkpointRefs.at(-1)}`)
  })

  it("awaits successful Windows taskkill and the Git child exit", async () => {
    const gitChild = createFakeChild(41_001)
    const taskkillChildren: FakeChild[] = []
    const spawn = vi.fn((command: string) => {
      if (command === "git") return gitChild.process
      const taskkill = createFakeChild(42_000 + taskkillChildren.length)
      taskkillChildren.push(taskkill)
      return taskkill.process
    })
    useFakeGitProcesses({
      platform: "win32",
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    })

    const gitRun = stageAll("C:\\repo")
    const gitFailure = rejectedValue(gitRun)
    expect(git.activeProcessCount()).toBe(1)

    let shutdownSettled = false
    const shutdown = git.shutdownAll(5_000).finally(() => {
      shutdownSettled = true
    })
    expect(taskkillChildren).toHaveLength(1)
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)

    taskkillChildren[0]!.close(0)
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)

    gitChild.close(null, "SIGTERM")
    await expect(shutdown).resolves.toBe(1)
    await expect(gitFailure).resolves.toMatchObject({
      name: "GitCommandError",
      survivor: false,
    })
    expect(git.activeProcessCount()).toBe(0)
  })

  it("waits for a timed-out taskkill helper to close after killing it", async () => {
    const gitChild = createFakeChild(41_004)
    const taskkillChildren: FakeChild[] = []
    const spawn = vi.fn((command: string) => {
      if (command === "git") return gitChild.process
      const taskkill = createFakeChild(45_000 + taskkillChildren.length)
      taskkillChildren.push(taskkill)
      return taskkill.process
    })
    useFakeGitProcesses({
      platform: "win32",
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    })

    const gitFailure = rejectedValue(stageAll("C:\\repo"))
    const shutdown = git.shutdownAll(5_000)

    await vi.advanceTimersByTimeAsync(750)
    expect(taskkillChildren).toHaveLength(1)
    expect(taskkillChildren[0]!.kill).toHaveBeenCalledWith("SIGKILL")

    await vi.advanceTimersByTimeAsync(200)
    expect(taskkillChildren).toHaveLength(1)

    taskkillChildren[0]!.close(null, "SIGKILL")
    await Promise.resolve()
    expect(taskkillChildren).toHaveLength(2)

    taskkillChildren[1]!.close(0)
    gitChild.close(null, "SIGKILL")
    await expect(shutdown).resolves.toBe(1)
    await expect(gitFailure).resolves.toMatchObject({
      name: "GitCommandError",
      survivor: false,
    })
  })

  it("reports and retains a Windows process tree when taskkill cannot confirm termination", async () => {
    const gitChild = createFakeChild(41_002)
    let taskkillShouldSucceed = false
    const spawn = vi.fn((command: string) => {
      if (command === "git") return gitChild.process
      const taskkill = createFakeChild(43_000)
      queueMicrotask(() => {
        taskkill.close(taskkillShouldSucceed ? 0 : 1)
        if (taskkillShouldSucceed) gitChild.close(null, "SIGKILL")
      })
      return taskkill.process
    })
    useFakeGitProcesses({
      platform: "win32",
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    })

    const gitRun = stageAll("C:\\repo")
    const gitFailure = rejectedValue(gitRun)
    const firstShutdown = rejectedValue(git.shutdownAll(100))
    await vi.advanceTimersByTimeAsync(150)

    await expect(firstShutdown).resolves.toMatchObject({
      code: "GIT_SHUTDOWN_INCOMPLETE",
    })
    await expect(gitFailure).resolves.toMatchObject({
      name: "GitProcessSurvivorError",
      code: "GIT_PROCESS_SURVIVOR",
      survivor: true,
    })
    expect(gitChild.kill).toHaveBeenCalledWith("SIGKILL")
    expect(git.activeProcessCount()).toBe(1)

    taskkillShouldSucceed = true
    await expect(git.shutdownAll(100)).resolves.toBe(1)
    expect(git.activeProcessCount()).toBe(0)
  })

  it("does not silently settle a timed-out command while its tree remains unconfirmed", async () => {
    const gitChild = createFakeChild(41_003)
    let taskkillShouldSucceed = false
    const spawn = vi.fn((command: string) => {
      if (command === "git") return gitChild.process
      const taskkill = createFakeChild(44_000)
      queueMicrotask(() => {
        taskkill.close(taskkillShouldSucceed ? 0 : 1)
        if (taskkillShouldSucceed) gitChild.close(null, "SIGKILL")
      })
      return taskkill.process
    })
    useFakeGitProcesses({
      platform: "win32",
      spawn: spawn as unknown as typeof import("node:child_process").spawn,
    })

    const gitFailure = rejectedValue(stageAll("C:\\repo"))
    await vi.advanceTimersByTimeAsync(120_000)
    await vi.advanceTimersByTimeAsync(5_100)

    const error = await gitFailure
    expect(error).toMatchObject({
      name: "GitProcessSurvivorError",
      code: "GIT_PROCESS_SURVIVOR",
      killed: true,
      survivor: true,
    })
    expect((error as Error).message).toMatch(
      /timed out[\s\S]*termination could not be confirmed/i
    )
    expect(git.activeProcessCount()).toBe(1)

    taskkillShouldSucceed = true
    await expect(git.shutdownAll(100)).resolves.toBe(1)
    expect(git.activeProcessCount()).toBe(0)
  })
})

describe("repository helper probe", () => {
  let root: string
  const isProbe = (args: readonly string[]) => args.includes("--get-regexp")

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-git-probe-"))
    fs.mkdirSync(path.join(root, ".git"))
    fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n")
  })

  afterEach(() => {
    expect(git.activeProcessCount()).toBe(0)
    setDefaultGitProcessService(null)
    fs.rmSync(root, { recursive: true, force: true })
  })

  function fakeGit(probe: () => { output: string; code: number }) {
    const calls: Array<{ command: string; args: string[] }> = []
    const spawn = vi.fn((command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] })
      const child = createFakeChild(47_000 + calls.length)
      queueMicrotask(() => {
        if (isProbe(args)) {
          const result = probe()
          if (result.output) {
            child.process.stdout.emit("data", Buffer.from(result.output))
          }
          child.close(result.code)
          return
        }
        child.close(0)
      })
      return child.process
    })
    git = new GitProcessService({
      dependencies: {
        // win32 keeps the fake PIDs away from POSIX process-group signals.
        platform: "win32",
        spawn: spawn as unknown as typeof import("node:child_process").spawn,
        resolveGitExecutable: () => "C:\\Program Files\\Git\\cmd\\git.exe",
      },
    })
    setDefaultGitProcessService(git)
    return calls
  }

  it("spawns the resolved executable, applies the probe and reuses it until the config changes", async () => {
    let output = "filter.lfs.clean\0filter.lfs.required\0core.sshcommand\0"
    const calls = fakeGit(() => ({ output, code: output ? 0 : 1 }))

    await stageAll(root)
    expect(calls.every((call) => call.command.endsWith("git.exe"))).toBe(true)
    const probes = () => calls.filter((call) => isProbe(call.args))
    expect(probes()).toHaveLength(1)
    expect(probes()[0]!.args).toEqual(
      expect.arrayContaining(["config", "--local", "--includes", "--null"])
    )
    const firstCommand = calls.at(-1)!.args
    expect(firstCommand).toContain("filter.lfs.clean=")
    expect(firstCommand).toContain("filter.lfs.required=false")
    expect(firstCommand).toContain("core.sshCommand=ssh")

    await stageAll(root)
    expect(probes()).toHaveLength(1)
    expect(calls.at(-1)!.args).toContain("filter.lfs.clean=")

    output = ""
    fs.writeFileSync(
      path.join(root, ".git", "config"),
      "[core]\n\trepositoryformatversion = 0\n"
    )
    await stageAll(root)
    expect(probes()).toHaveLength(2)
    expect(calls.at(-1)!.args).not.toContain("filter.lfs.clean=")
    expect(calls.at(-1)!.args).not.toContain("core.sshCommand=ssh")
  })

  it("never caches a config that includes other files", async () => {
    const calls = fakeGit(() => ({
      output: "include.path\0filter.probe.clean\0",
      code: 0,
    }))
    await stageAll(root)
    await stageAll(root)
    expect(calls.filter((call) => isProbe(call.args))).toHaveLength(2)
    expect(calls.at(-1)!.args).toContain("filter.probe.clean=")
  })

  it("fails closed when the probe fails unexpectedly", async () => {
    const calls = fakeGit(() => ({ output: "", code: 2 }))
    await expect(stageAll(root)).rejects.toMatchObject({ exitCode: 2 })
    expect(calls).toHaveLength(1)
    expect(isProbe(calls[0]!.args)).toBe(true)
  })
})
