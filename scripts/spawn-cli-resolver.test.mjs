import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const source = readFileSync(new URL("../apps/shell/shared/spawn-cli.cjs", import.meta.url), "utf8")

/**
 * Load spawn-cli.cjs as it behaves on Windows, against a fake file system
 * (`files`: absolute paths that exist) and a recording `spawn`.
 */
function loadWindows({ files, env }) {
  const existing = new Set(files.map((file) => file.toLowerCase()))
  const spawned = []
  const fakeFs = {
    constants: { X_OK: 1 },
    statSync: (file) => {
      if (!existing.has(String(file).toLowerCase())) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      return { isFile: () => true }
    },
    accessSync: () => {},
    existsSync: (file) => existing.has(String(file).toLowerCase()),
  }
  const spawn = (command, args, options) => {
    spawned.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.exitCode = null
    child.signalCode = null
    setImmediate(() => {
      child.exitCode = 0
      child.emit("close", 0, null)
    })
    return child
  }
  const module = { exports: {} }
  runInNewContext(source, {
    module,
    Buffer,
    setTimeout,
    clearTimeout,
    process: { platform: "win32", env },
    require: (name) => {
      if (name === "child_process") return { spawn }
      if (name === "fs") return fakeFs
      if (name === "os") return { homedir: () => "C:\\Users\\me" }
      if (name === "path") return path.win32
      throw new Error(`unexpected ${name}`)
    },
  })
  return { cli: module.exports, spawned }
}

test("Windows resolution accepts only programs cmd can run, from absolute PATH entries", () => {
  const { cli } = loadWindows({
    env: {
      PATH: ".;;relative\\bin;C:\\tools;C:\\Program Files\\nodejs",
      PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    },
    files: [
      // A planted binary in the current directory / a relative entry.
      "claude.exe",
      "relative\\bin\\codex.exe",
      // Script-host and PowerShell shims on PATH.
      "C:\\tools\\fmt.js",
      "C:\\tools\\fmt.vbs",
      "C:\\tools\\lint.ps1",
      "C:\\tools\\lint",
      "C:\\Program Files\\nodejs\\npx.cmd",
      "C:\\Program Files\\nodejs\\node.exe",
      // npm's global shims: only the .cmd is runnable.
      "C:\\Users\\me\\AppData\\Roaming\\npm\\gemini.ps1",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\gemini",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\qwen.ps1",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\qwen.cmd",
    ],
  })
  assert.equal(cli.resolveCliBinary("claude"), null)
  assert.equal(cli.resolveCliBinary("codex"), null)
  assert.equal(cli.resolveCliBinary("fmt"), null)
  assert.equal(cli.resolveCliBinary("lint"), null)
  assert.equal(cli.resolveCliBinary("gemini"), null)
  assert.equal(cli.resolveCliBinary("lint.ps1"), null)
  assert.equal(cli.resolveCliBinary("npx"), "C:\\Program Files\\nodejs\\npx.cmd")
  assert.equal(cli.resolveCliBinary("npx.cmd"), "C:\\Program Files\\nodejs\\npx.cmd")
  assert.equal(cli.resolveCliBinary("qwen"), "C:\\Users\\me\\AppData\\Roaming\\npm\\qwen.cmd")
})

test("runCli refuses what cmd would hand to a file association, and runs Node scripts with node.exe", async () => {
  const { cli, spawned } = loadWindows({
    env: { PATH: "C:\\Program Files\\nodejs", PATHEXT: ".EXE;.CMD" },
    files: ["C:\\Program Files\\nodejs\\node.exe"],
  })
  await assert.rejects(cli.runCli("C:\\tools\\lint.ps1", []), /only \.exe, \.cmd and \.bat/)
  await assert.rejects(cli.runCli("C:\\tools\\lint", []), /only \.exe, \.cmd and \.bat/)
  await assert.rejects(cli.runCli("C:\\tools\\fmt.vbs", []), /only \.exe, \.cmd and \.bat/)
  assert.equal(spawned.length, 0)

  const result = await cli.runCli("C:\\tools\\server.mjs", ["--port", "3000"], { cwd: "C:\\work" })
  assert.equal(result.code, 0)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].command, "C:\\Program Files\\nodejs\\node.exe")
  assert.deepEqual([...spawned[0].args], ["C:\\tools\\server.mjs", "--port", "3000"])
  assert.equal(spawned[0].options.windowsVerbatimArguments, false)

  const withoutNode = loadWindows({ env: { PATH: "C:\\empty" }, files: [] })
  await assert.rejects(withoutNode.cli.runCli("C:\\tools\\server.js", []), /node\.exe was not found/)
})
