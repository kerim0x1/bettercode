import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const {
  normalizeHumanShellCapabilityScope: normalize,
} = require("../apps/shell/shared/shell-capability-scope.cjs")

test("run and PTY scopes are forwarded with the launch they will be spent with", () => {
  assert.deepEqual(
    normalize({
      operation: "run",
      command: "npm test",
      cwd: "/repo",
      launch: { shell: "bash", env: { CI: "1" } },
    }),
    {
      operation: "run",
      command: "npm test",
      cwd: "/repo",
      launch: { shell: "bash", env: { CI: "1" } },
    },
  )
  assert.deepEqual(
    normalize({
      operation: "pty-open",
      cwd: "/repo",
      sessionId: "t1",
      command: "npm",
      launch: { args: ["run", "dev"] },
    }),
    {
      operation: "pty-open",
      cwd: "/repo",
      sessionId: "t1",
      command: "npm",
      launch: { args: ["run", "dev"] },
    },
  )
  // No launch means the default one; it is spelled out for the backend.
  assert.deepEqual(normalize({ operation: "run", command: "ls", cwd: "/repo" }).launch, {})
})

test("unknown fields are dropped and malformed launches are refused", () => {
  const forwarded = normalize({
    operation: "run",
    command: "ls",
    cwd: "/repo",
    permissionLevel: "bypass",
    humanOrigin: true,
  })
  assert.deepEqual(Object.keys(forwarded).sort(), ["command", "cwd", "launch", "operation"])

  for (const launch of [
    "bash",
    { shell: 42 },
    { shell: "bash", extra: true },
    { args: "run dev" },
    { args: [1] },
    { args: Array.from({ length: 129 }, () => "x") },
    { env: { "BAD-KEY": "1" } },
    { env: { OK: 1 } },
    { env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, "v"])) },
  ]) {
    assert.equal(
      normalize({ operation: "pty-open", cwd: "/repo", launch }),
      null,
      JSON.stringify(launch).slice(0, 80),
    )
  }
  // A plain run has no PTY argument vector.
  assert.equal(normalize({ operation: "run", command: "ls", cwd: "/repo", launch: { args: [] } }), null)
})

test("the other scope rules are unchanged", () => {
  assert.equal(normalize(null), null)
  assert.equal(normalize({ operation: "run", command: "", cwd: "/repo" }), null)
  assert.equal(normalize({ operation: "run", command: "ls", cwd: "" }), null)
  assert.equal(normalize({ operation: "pty-open", cwd: "/repo", sessionId: "x".repeat(257) }), null)
  assert.deepEqual(normalize({ operation: "pty-write", sessionId: "t1", data: "" }), {
    operation: "pty-write",
    sessionId: "t1",
    data: "",
  })
  assert.equal(normalize({ operation: "pty-write", sessionId: "", data: "x" }), null)
  assert.equal(normalize({ operation: "spawn", command: "x", cwd: "/" }), null)
})

test("the shell capability handler forwards only the normalized scope", () => {
  const appIpc = readFileSync(new URL("../apps/shell/shared/app-ipc.cjs", import.meta.url), "utf8")
  const handler = appIpc.slice(
    appIpc.indexOf("registerHandler(IpcChannel.ShellCapability"),
    appIpc.indexOf("// ── Renderer client instances"),
  )
  assert.ok(handler.length > 0)
  assert.match(handler, /const scope = normalizeHumanShellCapabilityScope\(requested\)/)
  assert.match(handler, /body: JSON\.stringify\(scope\)/)
})
