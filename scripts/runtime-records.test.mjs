import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"

// hooks.json and mcp-servers.json are written by the desktop process
// (apps/shell) and read by the backend. Both now check against one shared
// definition (@betterc0de/schema/runtime-records); the bounds each side
// enforces before it gets there are kept equal here.

const require = createRequire(import.meta.url)
const root = new URL("../", import.meta.url)
const {
  RUNTIME_HOOK_LIMITS,
  RUNTIME_HOOK_STATUSES,
  RUNTIME_MCP_LIMITS,
  runtimeHookRecordSchema,
  runtimeMcpServerRecordSchema,
} = require("@betterc0de/schema/runtime-records")
const { RUNTIME_HOOK_EVENTS } = require("@betterc0de/schema/runtime-hooks")
const { normalizeMcpConfig } = require("../apps/shell/mcp-ipc.cjs")
const approval = require("../apps/shell/shared/command-approval.cjs")

function source(relative) {
  return fs.readFileSync(new URL(relative, root), "utf8")
}

/** The value of `const NAME = 4 * 1_024` in `text`. */
function numericConstant(text, name) {
  const match = new RegExp(`const ${name} = ([0-9_ *]+)\\r?\\n`).exec(text)
  assert.ok(match, `${name} is not declared as a number`)
  return match[1]
    .replace(/_/g, "")
    .split("*")
    .map((factor) => Number(factor.trim()))
    .reduce((product, factor) => product * factor, 1)
}

/** The strings of `const NAME = new Set([...])` in `text`. */
function stringSetConstant(text, name) {
  const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(text)
  assert.ok(match, `${name} is not declared as a Set`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1])
}

test("the shell's hooks.json bounds are the shared ones", () => {
  const hooks = source("apps/shell/hooks-ipc.cjs")
  assert.equal(numericConstant(hooks, "MAX_HOOKS"), RUNTIME_HOOK_LIMITS.maxHooks)
  assert.equal(numericConstant(hooks, "MAX_HOOK_ID_LENGTH"), RUNTIME_HOOK_LIMITS.maxIdChars)
  assert.equal(
    numericConstant(hooks, "MAX_HOOK_COMMAND_LENGTH"),
    RUNTIME_HOOK_LIMITS.maxCommandChars,
  )
  assert.equal(numericConstant(hooks, "MAX_HOOK_ERROR_LENGTH"), RUNTIME_HOOK_LIMITS.maxErrorChars)
  assert.deepEqual(stringSetConstant(hooks, "HOOK_EVENTS"), [...RUNTIME_HOOK_EVENTS])
  assert.deepEqual(stringSetConstant(hooks, "HOOK_STATUSES"), [...RUNTIME_HOOK_STATUSES])
})

test("the shell and the backend read mcp-servers.json with the shared bounds", () => {
  const shell = source("apps/shell/mcp-ipc.cjs")
  const expectedShell = {
    MAX_MCP_ENTRIES: RUNTIME_MCP_LIMITS.maxServers,
    MAX_MCP_NAME_CHARS: RUNTIME_MCP_LIMITS.maxNameChars,
    MAX_MCP_COMMAND_CHARS: RUNTIME_MCP_LIMITS.maxCommandOrUrlChars,
    MAX_MCP_ARGS: RUNTIME_MCP_LIMITS.maxArgs,
    MAX_MCP_ARG_CHARS: RUNTIME_MCP_LIMITS.maxArgChars,
    MAX_MCP_ARGS_CHARS: RUNTIME_MCP_LIMITS.maxArgsChars,
    MAX_MCP_ENV_ENTRIES: RUNTIME_MCP_LIMITS.maxEnvEntries,
    MAX_MCP_ENV_VALUE_CHARS: RUNTIME_MCP_LIMITS.maxEnvValueChars,
    MAX_MCP_ENCRYPTED_VALUE_CHARS: RUNTIME_MCP_LIMITS.maxEncryptedValueChars,
    MAX_MCP_STORE_BYTES: RUNTIME_MCP_LIMITS.maxStoreBytes,
  }
  for (const [name, expected] of Object.entries(expectedShell)) {
    assert.equal(numericConstant(shell, name), expected, `apps/shell/mcp-ipc.cjs ${name}`)
  }

  const backend = source("apps/backend/src/provider/runtime/acp/AcpMcpServers.ts")
  const expectedBackend = {
    MAX_IMPORTED_STORE_BYTES: RUNTIME_MCP_LIMITS.maxStoreBytes,
    MAX_MCP_SERVERS: RUNTIME_MCP_LIMITS.maxServers,
    MAX_NAME_CHARS: RUNTIME_MCP_LIMITS.maxNameChars,
    MAX_COMMAND_OR_URL_CHARS: RUNTIME_MCP_LIMITS.maxCommandOrUrlChars,
    MAX_ARGS: RUNTIME_MCP_LIMITS.maxArgs,
    MAX_ARG_CHARS: RUNTIME_MCP_LIMITS.maxArgChars,
    MAX_ENV_ENTRIES: RUNTIME_MCP_LIMITS.maxEnvEntries,
    MAX_ENV_KEY_CHARS: RUNTIME_MCP_LIMITS.maxEnvKeyChars,
    MAX_ENV_VALUE_CHARS: RUNTIME_MCP_LIMITS.maxEnvValueChars,
  }
  for (const [name, expected] of Object.entries(expectedBackend)) {
    assert.equal(numericConstant(backend, name), expected, `AcpMcpServers.ts ${name}`)
  }
})

test("every MCP record the shell's normalizer produces is a valid stored record", () => {
  const marker = approval.createApprovalMarker("mcp", JSON.stringify(["npx", ["-y", "server"]]))
  const projectRoot = path.resolve("workspace-root")
  const entries = [
    normalizeMcpConfig({
      id: "files",
      name: "Files",
      command: "npx",
      args: ["-y", "server"],
      env: { API_TOKEN: "secret" },
      approval: marker,
    }),
    normalizeMcpConfig({
      name: "Remote",
      type: "http",
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer token" },
      headerEnv: { "X-Api-Key": "REMOTE_API_KEY" },
      authenticated: true,
    }),
    normalizeMcpConfig({
      name: "Repository server",
      command: "node",
      args: ["server.js"],
      scope: "project",
      projectRoot,
    }),
    // A record as an older release left it on disk.
    { id: "legacy", name: "legacy", command: "node", enabled: true },
  ]
  for (const entry of entries) {
    const result = runtimeMcpServerRecordSchema.safeParse(entry)
    assert.ok(result.success, `${entry.id}: ${result.error?.message}`)
  }
  assert.equal(
    runtimeMcpServerRecordSchema.safeParse({ id: "x", args: "--flag" }).success,
    false,
  )
  assert.equal(
    runtimeMcpServerRecordSchema.safeParse({ id: "x", scope: "global" }).success,
    false,
  )
})

test("a hook record as the shell writes it is valid, and a malformed one is not", () => {
  const now = new Date().toISOString()
  const stored = {
    id: "hook-1",
    event: "on_message_send",
    command: "npm test",
    enabled: true,
    approval: approval.createApprovalMarker("hook", "npm test"),
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastStatus: "idle",
    lastExitCode: null,
    lastError: null,
  }
  assert.ok(runtimeHookRecordSchema.safeParse(stored).success)
  // Fields an older release did not write are optional.
  assert.ok(
    runtimeHookRecordSchema.safeParse({
      id: "old",
      event: "on_commit",
      command: "",
      enabled: false,
    }).success,
  )
  for (const broken of [
    { ...stored, event: "on_startup" },
    { ...stored, command: "a\0b" },
    { ...stored, lastStatus: "done" },
    { ...stored, id: " " },
  ]) {
    assert.equal(runtimeHookRecordSchema.safeParse(broken).success, false)
  }
})
