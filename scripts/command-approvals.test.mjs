// Main-process approval of commands a renderer asks the shell to store or
// install (SEC-01): MCP servers (mcp:install, onboarding import) and CLI
// plugins (cliPlugin:install). A renderer alone must not be able to persist a
// command that runs later; the user approves the exact command line in a
// native dialog the main process shows.

import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { installFakeDesktopConfigBackend } from "./fake-desktop-config-backend.mjs"

const shellDir = new URL("../apps/shell/", import.meta.url)
const requireShell = createRequire(new URL("mcp-ipc.cjs", shellDir))
const approval = requireShell("./shared/command-approval.cjs")
const {
  approveMcpLaunches,
  isMcpLaunchApproved,
  mcpLaunchCommandLine,
  normalizeMcpConfig,
  redactMcpForRenderer,
} = requireShell("./mcp-ipc.cjs")

function fakeDialog(answers = []) {
  const shown = []
  return {
    shown,
    showMessageBox: async (...args) => {
      shown.push(args.at(-1))
      return { response: answers.length > 0 ? answers.shift() : 0 }
    },
  }
}

const server = (id, command, args = [], extra = {}) =>
  normalizeMcpConfig({ id, name: id, command, args, ...extra })

test("a new MCP command line is listed exactly and approved only on Allow", async () => {
  const dialog = fakeDialog([1])
  const next = server("files", "npx", ["-y", "@mcp/files", "--root", "C:\\work"], {
    env: { TOKEN: "secret-value" },
  })
  const approvals = await approveMcpLaunches([next], { dialogImpl: dialog })
  assert.equal(dialog.shown.length, 1)
  const { detail, buttons } = dialog.shown[0]
  assert.deepEqual(buttons, ["Cancel", "Allow"])
  for (const part of ['"npx"', '1. "-y"', '2. "@mcp/files"', '4. "C:\\\\work"', "TOKEN"]) {
    assert.ok(detail.includes(part), `dialog lists ${part}`)
  }
  // Environment values never appear, only their names.
  assert.equal(detail.includes("secret-value"), false)
  assert.ok(isMcpLaunchApproved({ ...next, approval: approvals[0] }))

  const declined = await approveMcpLaunches([next], { dialogImpl: fakeDialog([0]) })
  assert.equal(declined, null)
})

test("an unchanged command line keeps its marker; any change asks again", async () => {
  const stored = { ...server("git", "git-mcp", ["--repo", "."]) }
  stored.approval = approval.createApprovalMarker("mcp", mcpLaunchCommandLine(stored))

  // Env or enabled edits of the same command line: no dialog, same marker.
  const quiet = fakeDialog()
  const kept = await approveMcpLaunches(
    [server("git", "git-mcp", ["--repo", "."], { env: { A: "1" }, enabled: false })],
    { dialogImpl: quiet, findExisting: () => stored },
  )
  assert.equal(quiet.shown.length, 0)
  assert.deepEqual(kept[0], stored.approval)

  // A changed argument is a new command line.
  const asked = fakeDialog([1])
  const changed = server("git", "git-mcp", ["--repo", "/"])
  const fresh = await approveMcpLaunches([changed], {
    dialogImpl: asked,
    findExisting: () => stored,
  })
  assert.equal(asked.shown.length, 1)
  assert.ok(isMcpLaunchApproved({ ...changed, approval: fresh[0] }))
  // The old marker does not approve the new command line.
  assert.equal(isMcpLaunchApproved({ ...changed, approval: stored.approval }), false)
})

test("remote servers need no approval and several commands share one dialog", async () => {
  const dialog = fakeDialog([1])
  const approvals = await approveMcpLaunches(
    [
      normalizeMcpConfig({ id: "remote", name: "remote", type: "http", url: "https://mcp.example.test" }),
      server("one", "node", ["one.js"]),
      server("two", "node", ["two.js"]),
    ],
    { dialogImpl: dialog },
  )
  assert.equal(dialog.shown.length, 1)
  assert.match(dialog.shown[0].detail, /MCP servers:/)
  assert.equal(approvals[0], null)
  assert.ok(approvals[1] && approvals[2])
})

test("an approval marker is kept through normalization but never shown to or taken from the renderer", () => {
  const marker = approval.createApprovalMarker("mcp", JSON.stringify(["node", "x.js"]))
  const entry = normalizeMcpConfig({ id: "x", name: "x", command: "node", args: ["x.js"], approval: marker })
  assert.deepEqual(entry.approval, marker)
  assert.equal("approval" in normalizeMcpConfig({ id: "y", command: "node", approval: "forged" }), false)
  assert.equal("approval" in redactMcpForRenderer(entry), false)
})

/**
 * A fresh copy of a shell module, loaded in this realm, with the given
 * `require` requests replaced (Electron, the IPC registration, file paths).
 */
function loadShellModule(relative, stubs) {
  const Module = requireShell("node:module")
  const originalLoad = Module._load
  const resolved = requireShell.resolve(relative)
  Module._load = function load(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request]
    return originalLoad.call(this, request, ...rest)
  }
  delete requireShell.cache[resolved]
  try {
    return requireShell(relative)
  } finally {
    Module._load = originalLoad
    delete requireShell.cache[resolved]
  }
}

function capturingFactory(handlers) {
  const factory = requireShell("./shared/ipc-handlers-factory.cjs")
  return {
    safeHandle: (channel, handler) => handlers.set(channel, factory.makeSafeWrapper(handler)),
    rawHandle: (channel, handler) => handlers.set(channel, handler),
  }
}

/**
 * mcp-ipc.cjs with its handlers captured. Its store (mcp-servers.json, owned
 * by the backend) is answered by a fake backend that keeps it in a temp dir.
 */
function mcpHarness(t, answers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-mcp-approval-"))
  const backend = installFakeDesktopConfigBackend(dir)
  t.after(() => {
    backend.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const mcpFile = path.join(dir, "mcp-servers.json")
  const handlers = new Map()
  const dialog = fakeDialog(answers)
  const runtimePaths = requireShell("./shared/runtime-paths.cjs")
  const mcpIpc = loadShellModule("./mcp-ipc.cjs", {
    electron: { BrowserWindow: { fromWebContents: () => null }, dialog },
    "./shared/ipc-handlers-factory.cjs": capturingFactory(handlers),
    "./shared/runtime-paths.cjs": {
      ...runtimePaths,
      getBaseDir: () => dir,
      getFocusedWindow: () => null,
    },
  })
  mcpIpc.registerMcpHandlers()
  const call = (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args)
  const stored = () => JSON.parse(fs.readFileSync(mcpFile, "utf8"))
  return { call, dialog, stored }
}

test("mcp:install stores a command only after the user allows it", async (t) => {
  const { call, dialog, stored } = mcpHarness(t, [0, 1])
  const config = { id: "files", name: "Files", command: "npx", args: ["@mcp/files"] }

  const refused = await call("mcp:install", config)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /not allowed/)
  assert.equal(dialog.shown.length, 1)

  // A marker the renderer sends along is ignored.
  const allowed = await call("mcp:install", { ...config, approval: { v: 1, alg: "sha256", digest: "forged" } })
  assert.equal(allowed.ok, true)
  assert.equal(dialog.shown.length, 2)
  const [entry] = stored()
  assert.ok(isMcpLaunchApproved(entry))
  assert.notEqual(entry.approval.digest, "forged")

  // Saving it again with only an env change asks nothing and keeps the marker.
  const again = await call("mcp:install", { ...config, env: { DEBUG: "1" } })
  assert.equal(again.ok, true)
  assert.equal(dialog.shown.length, 2)
  assert.deepEqual(stored()[0].approval, entry.approval)
  const listed = await call("mcp:list")
  assert.equal("approval" in listed[0], false)
})

test("cliPlugin:install asks in a native dialog with the exact command and installs only on Install", async () => {
  const installs = []
  const handlers = new Map()
  const dialog = fakeDialog([0, 1])
  const real = requireShell("./cli-plugins.cjs")
  const cliPluginsIpc = loadShellModule("./cli-plugins-ipc.cjs", {
    electron: { BrowserWindow: { fromWebContents: () => null }, dialog },
    "./shared/ipc-handlers-factory.cjs": capturingFactory(handlers),
    "./shared/spawn-cli.cjs": { resolveCliBinary: () => null },
    "./cli-plugins.cjs": {
      validateCliPluginId: real.validateCliPluginId,
      getCliPluginInventory: async () => ({ claude: { plugins: [] }, codex: { plugins: [] } }),
      getAvailableCliPlugins: async () => ({ claude: [], codex: [] }),
      claudePluginInstall: async (id) => installs.push(["claude", id]),
      codexPluginAdd: async (id) => installs.push(["codex", id]),
    },
  })
  cliPluginsIpc.registerCliPluginHandlers()
  const install = (source, id) => handlers.get("cliPlugin:install")({ sender: {} }, { source, id })

  const cancelled = await install("claude", "reviewer@team")
  assert.equal(cancelled.ok, false)
  assert.match(cancelled.error, /cancelled/)
  assert.deepEqual(installs, [])
  assert.match(dialog.shown[0].detail, /claude plugin install reviewer@team/)
  assert.deepEqual(dialog.shown[0].buttons, ["Cancel", "Install"])

  const done = await install("codex", "formatter")
  assert.equal(done.ok, true)
  assert.match(dialog.shown[1].detail, /codex plugin add formatter/)
  assert.deepEqual(installs, [["codex", "formatter"]])
})
