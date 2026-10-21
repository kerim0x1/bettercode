import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createServerConfig } from "../config"
import { AgentPermissionRuntime } from "../provider/agent-permission-runtime"
import type { BootRoot } from "./context"
import { openPersistence } from "./persistence"

let home: string
const cleanup: BootRoot["startupCleanup"] = []

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-profile-isolation-"))
  vi.spyOn(os, "homedir").mockReturnValue(home)
  vi.stubEnv("BETTERC0DE_HOME", undefined)
  vi.stubEnv("BETTERC0DE_DATA_DIR", undefined)
  vi.stubEnv("APPDATA", path.join(home, "roaming"))
  const legacy = path.join(home, ".betterc0de")
  fs.mkdirSync(legacy)
  const source = new Database(path.join(legacy, "betterc0de.db"))
  source.exec(
    "CREATE TABLE legacy_profile_marker (value TEXT); INSERT INTO legacy_profile_marker VALUES ('production history')"
  )
  source.close()
  fs.writeFileSync(
    path.join(legacy, "settings.json"),
    JSON.stringify({ custom_rules: "production settings" })
  )
  fs.writeFileSync(
    path.join(legacy, "settings-key.bin"),
    "production wrapped key"
  )
})

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step.run()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})

function open(options: Parameters<typeof createServerConfig>[0] = {}) {
  const config = createServerConfig(options)
  const root = {
    config,
    options: {},
    startupCleanup: cleanup,
    agentPermissionRuntime: new AgentPermissionRuntime(),
    resourceShutdowns: {
      git: async () => undefined,
      imageGeneration: async () => 0,
      nativeTextGeneration: async () => undefined,
      workspace: async () => undefined,
    },
  } as unknown as BootRoot
  return { ...openPersistence(root), config }
}

it.each(["dataDir option", "BETTERC0DE_HOME", "BETTERC0DE_DATA_DIR"])(
  "keeps a custom profile isolated when selected with %s",
  (selection) => {
    const custom = path.join(home, "isolated")
    if (selection !== "dataDir option") vi.stubEnv(selection, custom)
    const { db, config } = open(
      selection === "dataDir option" ? { dataDir: custom } : {}
    )
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'legacy_profile_marker'"
        )
        .get()
    ).toBeUndefined()
    expect(fs.existsSync(config.settingsPath)).toBe(false)
    expect(fs.existsSync(path.join(config.dataDir, "settings-key.bin"))).toBe(
      false
    )
  }
)

it("continues automatically migrating the standard production profile", () => {
  const { db, config } = open()
  expect(db.prepare("SELECT value FROM legacy_profile_marker").get()).toEqual({
    value: "production history",
  })
  expect(fs.readFileSync(config.settingsPath, "utf8")).toContain(
    "production settings"
  )
})
