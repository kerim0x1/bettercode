import { describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createProviderVersionAdvisory,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilities,
  runProviderMaintenanceCommand,
} from "./ProviderMaintenance"

describe("ProviderMaintenance", () => {
  it.runIf(process.platform === "win32")(
    "runs a Windows batch shim with literal arguments",
    async () => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "bc0de-maintenance-shim-")
      )
      const shim = path.join(directory, "provider update.cmd")
      const script = path.join(directory, "args.cjs")
      fs.writeFileSync(
        script,
        "process.stdout.write(JSON.stringify(process.argv.slice(2)))"
      )
      fs.writeFileSync(shim, `@"${process.execPath}" "%~dp0args.cjs" %*\r\n`)
      const args = [
        "package with space",
        "@scope/pkg@latest",
        "literal&echo value",
      ]
      try {
        const result = await runProviderMaintenanceCommand({
          executable: shim,
          args,
          timeoutMs: 5_000,
        })
        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual(args)
      } finally {
        fs.unlinkSync(shim)
        fs.unlinkSync(script)
        fs.rmdirSync(directory)
      }
    }
  )

  it("selects package-managed update commands for Codex install paths", () => {
    expect(
      resolveProviderMaintenanceCapabilities({
        driver: "codex",
        binaryPath: "codex",
      }).update?.command
    ).toBe("npm install -g @openai/codex@latest")

    expect(
      resolveProviderMaintenanceCapabilities({
        driver: "codex",
        binaryPath: "/opt/homebrew/bin/codex",
      }).update?.command
    ).toBe("brew upgrade codex")

    expect(
      resolveProviderMaintenanceCapabilities({
        driver: "codex",
        binaryPath: "/Applications/Codex.app/Contents/MacOS/codex",
      }).update
    ).toBeNull()
  })

  it("selects Claude native and package-manager update commands", () => {
    expect(
      resolveProviderMaintenanceCapabilities({
        driver: "claudeAgent",
        binaryPath: "/Users/me/.local/share/claude/claude",
      }).update?.command
    ).toBe("claude update")

    expect(
      resolveProviderMaintenanceCapabilities({
        driver: "claude",
        binaryPath: "/usr/local/bin/claude",
      }).update?.command
    ).toBe("brew upgrade claude-code")
  })

  it("selects Cursor and BetterC0de update commands", () => {
    expect(
      resolveProviderMaintenanceCapabilities({
        driver: "cursor",
        binaryPath: "agent",
      }).update?.command
    ).toBe("agent update")

    expect(
      resolveProviderMaintenanceCapabilities({
        driver: "BetterC0de",
        binaryPath: "BetterC0de",
      }).update?.command
    ).toBeUndefined()

    expect(
      resolveProviderMaintenanceCapabilities({
        driver: "BetterC0de",
        binaryPath: "/Users/me/.BetterC0de/bin/BetterC0de",
      }).update?.command
    ).toBeUndefined()

    expect(
      resolveProviderMaintenanceCapabilities({
        driver: "BetterC0de",
        binaryPath: "/opt/homebrew/bin/BetterC0de",
      }).update?.command
    ).toBeUndefined()
  })

  it("does not pass provider secrets or the parent environment to an update", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "bc0de-maintenance-env-")
    )
    const script = path.join(directory, "env.cjs")
    fs.writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({ codex: process.env.CODEX_HOME ?? null, key: process.env.OPENAI_API_KEY ?? null, parent: process.env.BETTERC0DE_MAINTENANCE_PARENT ?? null }))"
    )
    const previousKey = process.env.OPENAI_API_KEY
    const previousParent = process.env.BETTERC0DE_MAINTENANCE_PARENT
    process.env.OPENAI_API_KEY = "from-parent"
    process.env.BETTERC0DE_MAINTENANCE_PARENT = "from-parent"
    try {
      const result = await runProviderMaintenanceCommand({
        executable: process.execPath,
        args: [script],
        env: {
          CODEX_HOME: "/home/codex",
          OPENAI_API_KEY: "instance-secret",
          PATH: process.env.PATH,
        },
        timeoutMs: 10_000,
      })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        codex: "/home/codex",
        key: null,
        parent: null,
      })
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
      if (previousParent === undefined)
        delete process.env.BETTERC0DE_MAINTENANCE_PARENT
      else process.env.BETTERC0DE_MAINTENANCE_PARENT = previousParent
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("settles a timed-out update after killing the process tree", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "bc0de-maintenance-hang-")
    )
    const script = path.join(directory, "hang.cjs")
    fs.writeFileSync(
      script,
      [
        "const { spawn } = require('node:child_process')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })",
        "child.unref()",
        "setInterval(() => {}, 1000)",
      ].join("\n")
    )
    try {
      const result = await runProviderMaintenanceCommand({
        executable: process.execPath,
        args: [script],
        timeoutMs: 200,
      })
      expect(result.timedOut).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it("derives BetterC0de-compatible version advisory states", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(
      {
        provider: "codex",
        npmPackageName: "@openai/codex",
        homebrewFormula: "codex",
        nativeUpdate: null,
      },
      { binaryPath: "codex" }
    )

    expect(
      createProviderVersionAdvisory({
        driver: "codex",
        currentVersion: "1.2.3",
        latestVersion: "1.3.0",
        checkedAt: "2026-05-13T00:00:00.000Z",
        maintenanceCapabilities: capabilities,
      })
    ).toEqual({
      status: "behind_latest",
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-05-13T00:00:00.000Z",
      message: "Install the update now or review provider settings.",
    })

    expect(
      createProviderVersionAdvisory({
        driver: "codex",
        currentVersion: "1.3.0",
        latestVersion: "1.3.0",
        maintenanceCapabilities: capabilities,
      }).status
    ).toBe("current")
  })
})
