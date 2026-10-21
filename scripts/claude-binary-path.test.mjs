import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const source = readFileSync(new URL("../apps/shell/shared/claude-binary-path.cjs", import.meta.url), "utf8")

function load({ platform, env, files }) {
  const existing = new Set(files)
  const required = []
  const stat = (file) => {
    if (!existing.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    return { isFile: () => true }
  }
  const fakeFs = {
    constants: { X_OK: 1 },
    statSync: stat,
    accessSync: () => {},
    promises: { stat: async (file) => stat(file), access: async () => {} },
  }
  const module = { exports: {} }
  const pathImpl = platform === "win32" ? path.win32 : path.posix
  runInNewContext(source, {
    module,
    process: { platform, env, arch: "x64", resourcesPath: undefined },
    require: Object.assign(
      (name) => {
        required.push(name)
        if (name === "fs") return fakeFs
        if (name === "path") return pathImpl
        if (name === "os") return { homedir: () => (platform === "win32" ? "C:\\Users\\me" : "/home/me") }
        throw new Error(`unexpected ${name}`)
      },
      { resolve: () => { throw new Error("not installed") } },
    ),
  })
  return { resolver: module.exports, required }
}

test("the Claude Code lookup spawns no process and ignores relative PATH entries", async () => {
  const { resolver, required } = load({
    platform: "linux",
    env: { PATH: ".:bin:/usr/local/bin:/opt/claude/bin" },
    files: ["bin/claude", "/opt/claude/bin/claude"],
  })
  assert.equal(required.includes("child_process"), false)
  assert.doesNotMatch(source, /spawnSync|execSync|execFileSync/)
  assert.equal(resolver.resolveClaudeCodeBinaryPath(), "/opt/claude/bin/claude")
  resolver.clearClaudeCodeBinaryPathCache()
  assert.equal(await resolver.resolveClaudeCodeBinaryPathAsync(), "/opt/claude/bin/claude")
  // Cached: a later synchronous call reads the same answer.
  assert.equal(resolver.resolveClaudeCodeBinaryPath(), "/opt/claude/bin/claude")
})

test("Windows looks for claude.exe on absolute PATH entries, then known install locations", async () => {
  const known = "C:\\Users\\me\\AppData\\Local\\Programs\\Anthropic\\claude\\claude.exe"
  const { resolver } = load({
    platform: "win32",
    env: { PATH: ";.;C:\\bin", USERPROFILE: "C:\\Users\\me", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    files: ["claude.exe", known],
  })
  assert.equal(await resolver.resolveClaudeCodeBinaryPathAsync(), known)
})

test("Windows finds the native installer's claude.exe under %USERPROFILE%\\.local\\bin", async () => {
  const native = "C:\\Users\\me\\.local\\bin\\claude.exe"
  const { resolver } = load({
    platform: "win32",
    env: { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\me" },
    files: [native, "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"],
  })
  assert.equal(await resolver.resolveClaudeCodeBinaryPathAsync(), native)
  resolver.clearClaudeCodeBinaryPathCache()
  assert.equal(resolver.resolveClaudeCodeBinaryPath(), native)
})

test("Windows prefers any claude.exe over a claude.cmd shim earlier on PATH", async () => {
  const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"
  const binary = "C:\\Tools\\claude.exe"
  const { resolver } = load({
    platform: "win32",
    env: {
      PATH: "C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Tools",
      USERPROFILE: "C:\\Users\\me",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    },
    files: [shim, binary],
  })
  assert.equal(await resolver.resolveClaudeCodeBinaryPathAsync(), binary)
})

test("Windows falls back to the npm shim when no binary is installed", async () => {
  const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"
  const { resolver } = load({
    platform: "win32",
    env: { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\me", APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
    files: [shim],
  })
  assert.equal(await resolver.resolveClaudeCodeBinaryPathAsync(), shim)
})

test("Linux checks the native installer location before system directories", async () => {
  const { resolver } = load({
    platform: "linux",
    env: { PATH: "/usr/sbin" },
    files: ["/home/me/.local/bin/claude", "/usr/local/bin/claude"],
  })
  assert.equal(await resolver.resolveClaudeCodeBinaryPathAsync(), "/home/me/.local/bin/claude")
})

test("an explicit override wins", async () => {
  const { resolver } = load({
    platform: "linux",
    env: { PATH: "/usr/bin", BETTERC0DE_CLAUDE_CODE_PATH: "/custom/claude" },
    files: ["/custom/claude", "/usr/bin/claude"],
  })
  assert.equal(await resolver.resolveClaudeCodeBinaryPathAsync(), "/custom/claude")
})
