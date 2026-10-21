import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  configureChildProcessRegistry,
  parseElapsedTime,
  trackChildProcessTree,
  trackedProcessTreeCount,
} from "./child-process-registry"

const tempRoots: string[] = []
const children: ChildProcess[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function startSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
    windowsHide: true,
  })
  children.push(child)
  return child
}

function exited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** A PID that belonged to a process which has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" })
  await exited(child, 10_000)
  return child.pid!
}

function writePreviousPidfile(
  dataDir: string,
  backendPid: number,
  entries: Array<{ pid: number; startedAt: number }>
): void {
  fs.mkdirSync(path.join(dataDir, "run"), { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, "run", "child-process-trees.json"),
    JSON.stringify({
      version: 1,
      backendPid,
      platform: process.platform,
      entries: entries.map((entry) => ({
        ...entry,
        label: "test",
        processGroup: false,
      })),
    })
  )
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL")
    } catch {
      // Already gone.
    }
  }
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("child process registry", () => {
  it("parses ps elapsed times", () => {
    expect(parseElapsedTime("00:05")).toBe(5_000)
    expect(parseElapsedTime("01:02:03")).toBe(3_723_000)
    expect(parseElapsedTime("2-00:00:01")).toBe(172_801_000)
    expect(parseElapsedTime("garbage")).toBeNull()
  })

  it("tracks a child until it is untracked", () => {
    const child = startSleeper()
    const before = trackedProcessTreeCount()
    const untrack = trackChildProcessTree(child, "sleeper")
    expect(trackedProcessTreeCount()).toBe(before + 1)
    untrack()
    untrack()
    expect(trackedProcessTreeCount()).toBe(before)
  })

  it("reaps a tree left by a crashed backend only when its start time matches", async () => {
    const dataDir = makeTempDir("betterc0de-registry-")
    const leftover = startSleeper()
    const reused = startSleeper()
    writePreviousPidfile(dataDir, await deadPid(), [
      { pid: leftover.pid!, startedAt: Date.now() },
      // Same PID number, but recorded an hour earlier: a reused PID.
      { pid: reused.pid!, startedAt: Date.now() - 3_600_000 },
    ])

    await expect(configureChildProcessRegistry({ dataDir })).resolves.toBe(1)
    expect(await exited(leftover, 10_000)).toBe(true)
    expect(reused.exitCode).toBeNull()
    expect(reused.signalCode).toBeNull()
  }, 30_000)

  it("leaves the children of a backend that is still running alone", async () => {
    const dataDir = makeTempDir("betterc0de-registry-live-")
    const child = startSleeper()
    const liveBackend = startSleeper()
    writePreviousPidfile(dataDir, liveBackend.pid!, [
      { pid: child.pid!, startedAt: Date.now() },
    ])
    await expect(configureChildProcessRegistry({ dataDir })).resolves.toBe(0)
    expect(child.exitCode).toBeNull()
  })
})
