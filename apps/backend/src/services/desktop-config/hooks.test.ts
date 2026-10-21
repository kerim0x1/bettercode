import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { recordHookRun } from "./hooks"
import { DesktopConfigStore } from "./store"

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function store(): DesktopConfigStore {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-hook-runs-"))
  temporary.push(home)
  return new DesktopConfigStore(home)
}

const at = () => new Date("2026-10-07T12:00:00.000Z")

describe("a hook's last run", () => {
  it("is recorded on its entry, keeping everything else", () => {
    const config = store()
    const approval = { v: 1, alg: "hmac-sha256", digest: "x".repeat(44) }
    config.writeHooks([
      { id: "other", event: "on_commit", command: "a", enabled: true },
      {
        id: "lint",
        event: "on_message_send",
        command: "npm run lint",
        enabled: true,
        approval,
        createdAt: "then",
      },
    ])
    expect(
      recordHookRun(
        config,
        "lint",
        { status: "error", exitCode: 2, error: "x".repeat(10_000) },
        at
      )
    ).toBe(true)
    const [other, lint] = config.readHooks().entries
    expect(other).toEqual({
      id: "other",
      event: "on_commit",
      command: "a",
      enabled: true,
    })
    expect(lint).toMatchObject({
      approval,
      createdAt: "then",
      lastRunAt: "2026-10-07T12:00:00.000Z",
      lastStatus: "error",
      lastExitCode: 2,
      updatedAt: "2026-10-07T12:00:00.000Z",
    })
    // Bounded like the desktop's run updates.
    expect(lint!.lastError).toHaveLength(8_192)
  })

  it("is not recorded for a hook that is gone or a file that cannot be read", () => {
    const config = store()
    expect(
      recordHookRun(config, "x", {
        status: "success",
        exitCode: 0,
        error: null,
      })
    ).toBe(false)
    expect(fs.existsSync(config.paths.hooksFile)).toBe(false)
    fs.writeFileSync(config.paths.hooksFile, "{ broken")
    expect(
      recordHookRun(config, "x", {
        status: "success",
        exitCode: 0,
        error: null,
      })
    ).toBe(false)
    expect(fs.readFileSync(config.paths.hooksFile, "utf8")).toBe("{ broken")
  })
})
