import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

const { buildBackendEnvironment, isStrippedBackendEnvironmentKey } =
  createRequire(import.meta.url)("../apps/shell/shared/backend-environment.cjs")

test("drops loader, runtime and key variables, case-insensitively", () => {
  for (const key of [
    "NODE_OPTIONS", "node_options", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES",
    "BASH_ENV", "ENV", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", "BETTERC0DE_SETTINGS_KEY",
    "npm_lifecycle_event", "npm_package_version",
  ]) {
    assert.equal(isStrippedBackendEnvironmentKey(key), true, key)
  }
  for (const key of ["PATH", "HOME", "OPENAI_API_KEY", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "npm_config_registry", "LD_LIBRARY_PATH"]) {
    assert.equal(isStrippedBackendEnvironmentKey(key), false, key)
  }
})

test("keeps the user's configuration and applies overrides last", () => {
  const env = buildBackendEnvironment(
    { PATH: "/usr/bin", HOME: "/home/u", OPENAI_API_KEY: "sk-test", NODE_OPTIONS: "--inspect", BETTERC0DE_DATA_DIR: "/old" },
    { platform: "linux", overrides: { BETTERC0DE_DATA_DIR: "/data", PATH: "/opt/homebrew/bin:/usr/bin" } },
  )
  assert.deepEqual(env, {
    PATH: "/opt/homebrew/bin:/usr/bin",
    HOME: "/home/u",
    OPENAI_API_KEY: "sk-test",
    BETTERC0DE_DATA_DIR: "/data",
    ELECTRON_RUN_AS_NODE: "1",
  })
})

test("does not set ELECTRON_RUN_AS_NODE for a real Node binary", () => {
  const env = buildBackendEnvironment({ PATH: "/usr/bin" }, { platform: "linux", runAsNode: false })
  assert.equal("ELECTRON_RUN_AS_NODE" in env, false)
})

test("never passes two spellings of one Windows variable", () => {
  const env = buildBackendEnvironment(
    { Path: "C:\\Windows", SystemRoot: "C:\\Windows" },
    { platform: "win32", overrides: { PATH: "C:\\Tools;C:\\Windows" } },
  )
  assert.equal(env.PATH, "C:\\Tools;C:\\Windows")
  assert.equal("Path" in env, false)
  assert.equal(env.SystemRoot, "C:\\Windows")
})

test("empty overrides remove a value instead of passing an empty string", () => {
  const env = buildBackendEnvironment({ BETTERC0DE_CLAUDE_CODE_PATH: "/x" }, {
    platform: "linux", overrides: { BETTERC0DE_CLAUDE_CODE_PATH: "" },
  })
  assert.equal("BETTERC0DE_CLAUDE_CODE_PATH" in env, false)
})
