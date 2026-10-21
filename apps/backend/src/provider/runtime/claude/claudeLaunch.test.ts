import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  claudeSpawnCommand,
  isClaudeSdkScriptPath,
  readWindowsShimTarget,
  resolveClaudeSdkExecutable,
} from "./claudeLaunch"

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-claude-launch-")
  )
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** The shim `npm install -g @anthropic-ai/claude-code` writes on Windows. */
function writeNpmShim(dir: string, target: string): string {
  const shimPath = path.join(dir, "claude.cmd")
  fs.writeFileSync(
    shimPath,
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      "",
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
      "",
    ].join("\r\n"),
    "utf8"
  )
  return shimPath
}

function writeFile(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, "", "utf8")
  return filePath
}

describe("Claude Code launch resolution", () => {
  it("resolves an npm claude.cmd shim to the cli.js it starts", async () => {
    const dir = tempDir()
    const cli = writeFile(
      path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
    )
    const shim = writeNpmShim(
      dir,
      "node_modules\\@anthropic-ai\\claude-code\\cli.js"
    )

    await expect(readWindowsShimTarget(shim)).resolves.toBe(cli)
    await expect(
      resolveClaudeSdkExecutable(shim, {
        platform: "win32",
        resolveOnPath: (name) =>
          name === "node" ? "C:\\Program Files\\nodejs\\node.exe" : null,
      })
    ).resolves.toEqual({
      pathToClaudeCodeExecutable: cli,
      executable: "C:\\Program Files\\nodejs\\node.exe",
    })
  })

  it("prefers a node.exe installed next to the shim", async () => {
    const dir = tempDir()
    const cli = writeFile(
      path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
    )
    const bundledNode = writeFile(path.join(dir, "node.exe"))
    const shim = writeNpmShim(
      dir,
      "node_modules\\@anthropic-ai\\claude-code\\cli.js"
    )
    await expect(
      resolveClaudeSdkExecutable(shim, {
        platform: "win32",
        resolveOnPath: () => null,
      })
    ).resolves.toEqual({
      pathToClaudeCodeExecutable: cli,
      executable: bundledNode,
    })
  })

  it("resolves a shim around a native binary to that binary", async () => {
    const dir = tempDir()
    const exe = writeFile(
      path.join(
        dir,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "claude.exe"
      )
    )
    const shim = writeNpmShim(
      dir,
      "node_modules\\@anthropic-ai\\claude-code\\claude.exe"
    )
    await expect(
      resolveClaudeSdkExecutable(shim, { platform: "win32" })
    ).resolves.toEqual({ pathToClaudeCodeExecutable: exe })
  })

  it("keeps a shim whose target cannot be found", async () => {
    const dir = tempDir()
    const shim = writeNpmShim(dir, "node_modules\\missing\\cli.js")
    await expect(readWindowsShimTarget(shim)).resolves.toBeNull()
    await expect(
      resolveClaudeSdkExecutable(shim, { platform: "win32" })
    ).resolves.toEqual({ pathToClaudeCodeExecutable: shim })
  })

  it("resolves a bare claude to an absolute path", async () => {
    await expect(
      resolveClaudeSdkExecutable("claude", {
        platform: "linux",
        homeDir: tempDir(),
        resolveOnPath: (name) =>
          name === "claude" ? "/usr/local/bin/claude" : null,
      })
    ).resolves.toEqual({ pathToClaudeCodeExecutable: "/usr/local/bin/claude" })
  })

  it("mirrors the Agent SDK's script detection", () => {
    expect(isClaudeSdkScriptPath("C:\\npm\\cli.js")).toBe(true)
    expect(isClaudeSdkScriptPath("/opt/claude/cli.mjs")).toBe(true)
    expect(isClaudeSdkScriptPath("C:\\npm\\claude.cmd")).toBe(false)
    expect(isClaudeSdkScriptPath("/usr/local/bin/claude")).toBe(false)
  })
})

describe("claudeSpawnCommand", () => {
  it("launches a Windows .cmd shim through cmd.exe with verbatim arguments", () => {
    const plan = claudeSpawnCommand(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      ["--output-format", "stream-json", "--model", "claude-opus-4-7"],
      { platform: "win32" }
    )
    expect(plan.windowsVerbatimArguments).toBe(true)
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"])
    expect(plan.args[3]).toContain("claude.cmd")
    expect(plan.args[3]).toContain("stream-json")
  })

  it("spawns an absolute .exe directly", () => {
    const exe = "C:\\Users\\me\\.local\\bin\\claude.exe"
    expect(
      claudeSpawnCommand(exe, ["--version"], { platform: "win32" })
    ).toEqual({
      command: exe,
      args: ["--version"],
      windowsVerbatimArguments: false,
    })
  })

  it("resolves a bare Windows command before spawning it", () => {
    const node = "C:\\Program Files\\nodejs\\node.exe"
    expect(
      claudeSpawnCommand("node", ["cli.js"], {
        platform: "win32",
        resolveOnPath: () => node,
      })
    ).toEqual({
      command: node,
      args: ["cli.js"],
      windowsVerbatimArguments: false,
    })
    // Unresolved names fail as ENOENT instead of reaching cmd.exe.
    expect(
      claudeSpawnCommand("node", ["cli.js"], {
        platform: "win32",
        resolveOnPath: () => null,
      })
    ).toEqual({
      command: "node",
      args: ["cli.js"],
      windowsVerbatimArguments: false,
    })
  })

  it("refuses JSON arguments a batch shim cannot carry", () => {
    expect(() =>
      claudeSpawnCommand(
        "C:\\npm\\claude.cmd",
        ["--mcp-config", '{"mcpServers":{}}'],
        { platform: "win32" }
      )
    ).toThrow(/command shim/)
  })

  it("leaves POSIX launches untouched", () => {
    expect(
      claudeSpawnCommand("/usr/local/bin/claude", ["--version"], {
        platform: "darwin",
      })
    ).toEqual({
      command: "/usr/local/bin/claude",
      args: ["--version"],
      windowsVerbatimArguments: false,
    })
  })
})
