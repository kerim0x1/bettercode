import path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { sanitizedShellEnvironment } from "../../security/childEnvironment"
import { WorkspaceProcessService } from "./processes"

/** Each test gets its own processes, queue and admission. */
let workspaceProcesses: WorkspaceProcessService

beforeEach(() => {
  workspaceProcesses = new WorkspaceProcessService()
})

/** A bounded command with the defaults these tests share. */
function runTestCommand(input: {
  command: string
  args?: string[]
  timeoutMs?: number
  outputLimitBytes?: number
  signal?: AbortSignal
}) {
  return workspaceProcesses.runBoundedCommand({
    command: input.command,
    args: input.args ?? [],
    env: sanitizedShellEnvironment(),
    timeoutMs: input.timeoutMs ?? 10_000,
    outputLimitBytes: input.outputLimitBytes ?? 64_000,
    label: "workspace-process-test",
    signal: input.signal,
  })
}

describe("runBoundedWorkspaceCommand failure kinds", () => {
  it.each(["shutdown", "aborted"] as const)(
    "does not spawn after %s during asynchronous validation",
    async (kind) => {
      const controller = new AbortController()
      let enterValidation!: () => void
      let releaseValidation!: () => void
      const entered = new Promise<void>((resolve) => {
        enterValidation = resolve
      })
      const released = new Promise<void>((resolve) => {
        releaseValidation = resolve
      })
      const pending = workspaceProcesses.runBoundedCommand({
        command: process.execPath,
        args: ["-e", "process.stdout.write('unexpected-spawn')"],
        env: process.env,
        timeoutMs: 10_000,
        outputLimitBytes: 1_024,
        label: "deferred-validation-test",
        signal: controller.signal,
        beforeSpawn: async () => {
          enterValidation()
          await released
        },
      })
      await entered
      if (kind === "shutdown") await workspaceProcesses.shutdownAll()
      else controller.abort()
      releaseValidation()
      const result = await pending
      expect(result.stdout).toBe("")
      expect(result.exitCode).toBeNull()
      expect(result.failure).toEqual({ kind })
    }
  )

  it("types an already-aborted request instead of only writing stderr", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runTestCommand({
      command: "node",
      args: ["-e", "0"],
      signal: controller.signal,
    })
    expect(result.exitCode).toBeNull()
    expect(result.failure).toEqual({ kind: "aborted" })
  })

  it("types shutdown refusals", async () => {
    workspaceProcesses.beginShutdown()
    const result = await runTestCommand({
      command: "node",
      args: ["-e", "0"],
    })
    expect(result.exitCode).toBeNull()
    expect(result.failure).toEqual({ kind: "shutdown" })
  })

  it("types a binary that cannot be spawned", async () => {
    const missing = path.join(
      process.cwd(),
      "definitely-missing-betterc0de-binary-" + process.pid
    )
    const result = await runTestCommand({
      command: missing,
      args: [],
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBeNull()
    expect(result.failure).toEqual({ kind: "spawn-error" })
  })

  it("leaves failure absent for a real exit", async () => {
    const result = await runTestCommand({
      command: "node",
      args: ["-e", "process.exit(3)"],
      timeoutMs: 20_000,
    })
    expect(result.exitCode).toBe(3)
    expect(result.failure).toBeUndefined()
  }, 30_000)
})
