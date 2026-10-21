import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetMasterKeyCache,
  decryptSecret,
  encryptSecret,
} from "../../settings/crypto"
import { SettingsService } from "../../settings/service"
import { encryptStoredMcpSecrets, migrateDesktopConfig } from "./migration"
import { DesktopConfigStore } from "./store"

const temporary: string[] = []
const KEY = Buffer.alloc(32, 9).toString("base64")

function directory(): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-migrate-"))
  temporary.push(created)
  return created
}

beforeEach(() => {
  vi.stubEnv("BETTERC0DE_SETTINGS_KEY", KEY)
  __resetMasterKeyCache()
})

afterEach(() => {
  vi.unstubAllEnvs()
  __resetMasterKeyCache()
  for (const created of temporary.splice(0)) {
    fs.rmSync(created, { recursive: true, force: true })
  }
})

/** A profile whose settings.json still carries the legacy keys. */
function profile(legacy: Record<string, unknown>) {
  const home = directory()
  const dataDir = path.join(home, "userdata")
  fs.mkdirSync(dataDir)
  const settingsPath = path.join(dataDir, "settings.json")
  fs.writeFileSync(settingsPath, JSON.stringify({ theme: "light", ...legacy }))
  const settings = new SettingsService(settingsPath)
  const store = new DesktopConfigStore(home)
  return { home, settingsPath, settings, store }
}

const onDisk = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"))

describe("moving the desktop configuration out of settings.json", () => {
  it("merges every legacy key into its file and removes it from settings", () => {
    const { settingsPath, settings, store } = profile({
      custom_rules: "Answer in German.",
      mcp_servers: [
        {
          id: "github",
          name: "GitHub",
          command: "npx",
          args: '-y "@scope/server github"',
          envVars: "GITHUB_TOKEN=ghp_secret\nEMPTY=",
          enabled: true,
        },
      ],
      hooks: [
        {
          id: "lint",
          event: "on_commit",
          command: "npm run lint",
          enabled: true,
        },
      ],
      skills: [
        {
          id: "Review",
          name: "Review",
          description: "Review changes",
          triggerPattern: "/review",
          promptTemplate: "Check the diff.",
          enabled: true,
        },
      ],
    })

    const report = migrateDesktopConfig(store, settings, {
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    })
    expect(report).toMatchObject({
      rules: "written",
      mcpServers: 1,
      hooks: 1,
      skills: 1,
      leftovers: 0,
    })
    expect(report.cleared.sort()).toEqual(
      ["custom_rules", "hooks", "mcp_servers", "skills"].sort()
    )

    expect(store.readRules().content).toBe("Answer in German.")
    const [server] = store.readMcp().entries
    expect(server).toMatchObject({
      id: "github",
      name: "GitHub",
      type: "command",
      command: "npx",
      args: ["-y", "@scope/server github"],
      enabled: true,
      url: null,
    })
    // Secrets are encrypted like the desktop's own entries.
    const env = server!.env as Record<string, string>
    expect(env.GITHUB_TOKEN).toMatch(/^enc:v1:/)
    expect(decryptSecret(env.GITHUB_TOKEN!)).toBe("ghp_secret")
    expect(fs.readFileSync(store.paths.mcpFile, "utf8")).not.toContain(
      "ghp_secret"
    )
    // Never approved: settings hooks never ran, and still do not.
    expect(store.readHooks().entries).toEqual([
      expect.objectContaining({
        id: "lint",
        event: "on_commit",
        command: "npm run lint",
        approval: null,
      }),
    ])
    // Settings skills were never in a prompt: they come in switched off.
    expect(store.getDirectoryEntry("skills", "review")).toMatchObject({
      manifest: {
        name: "Review",
        enabled: false,
        settingsEnabled: true,
        triggerPattern: "/review",
      },
      text: "Check the diff.",
    })

    const saved = onDisk(settingsPath)
    for (const key of ["custom_rules", "mcp_servers", "hooks", "skills"]) {
      expect(saved, key).not.toHaveProperty(key)
    }
    expect(saved.theme).toBe("light")
  })

  it("is idempotent: a second start changes nothing", () => {
    const legacy = {
      custom_rules: "Answer in German.",
      mcp_servers: [
        {
          id: "files",
          name: "Files",
          command: "npx",
          args: "mcp-files",
          envVars: "",
          enabled: true,
        },
      ],
      hooks: [{ id: "h", event: "on_commit", command: "x", enabled: true }],
      skills: [
        {
          id: "s",
          name: "S",
          description: "",
          triggerPattern: "",
          promptTemplate: "T",
          enabled: true,
        },
      ],
    }
    const { home, settingsPath, store } = profile(legacy)
    // A start that merged the files but could not clear settings.json.
    const blocked = {
      get: () => new SettingsService(settingsPath).get(),
      update: () => {
        throw new Error("settings.json is read-only")
      },
    }
    expect(migrateDesktopConfig(store, blocked).cleared).toEqual([])
    const files = () =>
      [
        store.paths.rulesFile,
        store.paths.mcpFile,
        store.paths.hooksFile,
        path.join(store.paths.skillsDir, "s", "content.md"),
      ].map((file) => fs.readFileSync(file, "utf8"))
    const first = files()

    const report = migrateDesktopConfig(
      store,
      new SettingsService(settingsPath)
    )
    expect(report).toMatchObject({
      rules: "already-present",
      mcpServers: 0,
      hooks: 0,
      skills: 0,
    })
    expect(files()).toEqual(first)
    expect(fs.readdirSync(store.paths.skillsDir)).toEqual(["s"])
    expect(onDisk(settingsPath)).not.toHaveProperty("mcp_servers")
    // Nothing left to do.
    const again = migrateDesktopConfig(store, new SettingsService(settingsPath))
    expect(again.cleared).toEqual([])
    expect(fs.readdirSync(home).sort()).toEqual(
      [
        "hooks.json",
        "mcp-servers.json",
        "rules.md",
        "skills",
        "userdata",
      ].sort()
    )
  })

  it("adds the settings rules after rules.md content instead of replacing it", () => {
    const { settings, store } = profile({ custom_rules: "From settings." })
    store.writeRules("From the file.\n\n")
    migrateDesktopConfig(store, settings)
    expect(store.readRules().content).toBe("From the file.\n\nFrom settings.")
  })

  it("keeps a desktop server the settings server used to shadow, switched off", () => {
    const { settings, store } = profile({
      mcp_servers: [
        {
          id: "github",
          name: "GitHub",
          command: "settings-server",
          args: "",
          envVars: "",
          enabled: true,
        },
      ],
    })
    const approval = { v: 1, alg: "hmac-sha256", digest: "d".repeat(44) }
    store.writeMcp([
      {
        id: "github",
        name: "GitHub (desktop)",
        command: "desktop-server",
        args: [],
        env: {},
        approval,
        enabled: true,
      },
    ])
    const report = migrateDesktopConfig(store, settings)
    expect(report.renamed).toEqual([
      "mcp-servers.json: github -> github-previous",
    ])
    const entries = store.readMcp().entries
    expect(
      entries.map((entry) => [entry.id, entry.command, entry.enabled])
    ).toEqual([
      ["github-previous", "desktop-server", false],
      ["github", "settings-server", true],
    ])
    // Everything else of the desktop entry is kept.
    expect(entries[0]).toMatchObject({ name: "GitHub (desktop)", approval })
  })

  it("sets aside what a store cannot hold, secrets encrypted, and still clears the key", () => {
    const { home, settingsPath, settings, store } = profile({
      mcp_servers: [
        {
          id: "unsafe-env",
          name: "Unsafe",
          command: "node",
          args: "server.js",
          envVars: "NODE_OPTIONS=--require /tmp/x.js\nTOKEN=kept",
          enabled: true,
        },
        {
          id: "too-many-args",
          name: "Args",
          command: "node",
          args: Array.from({ length: 40 }, (_, index) => `a${index}`).join(" "),
          envVars: "SECRET=hidden-value",
          enabled: true,
        },
      ],
    })
    const report = migrateDesktopConfig(store, settings)
    expect(report.mcpServers).toBe(1)
    expect(report.leftovers).toBe(2)
    expect(report.cleared).toEqual(["mcp_servers"])
    const [server] = store.readMcp().entries
    expect(Object.keys(server!.env as object)).toEqual(["TOKEN"])

    const leftoverFile = report.leftoverFile!
    expect(path.dirname(leftoverFile)).toBe(home)
    const leftover = fs.readFileSync(leftoverFile, "utf8")
    expect(leftover).not.toContain("hidden-value")
    expect(leftover).not.toContain("--require /tmp/x.js")
    const items = JSON.parse(leftover).items as Array<{
      kind: string
      value: Record<string, string>
    }>
    expect(items.map((item) => item.kind).sort()).toEqual(
      ["mcp_servers", "mcp_servers.env"].sort()
    )
    const args = items.find((item) => item.kind === "mcp_servers")!.value
    expect(decryptSecret(args.envVars!)).toBe("SECRET=hidden-value")
    expect(onDisk(settingsPath)).not.toHaveProperty("mcp_servers")
  })

  it("does nothing for settings without legacy keys", () => {
    const { settingsPath, settings, store } = profile({})
    const before = fs.readFileSync(settingsPath, "utf8")
    expect(migrateDesktopConfig(store, settings)).toMatchObject({
      rules: "none",
      cleared: [],
    })
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(before)
    expect(fs.existsSync(store.paths.mcpFile)).toBe(false)
  })
})

describe("plaintext MCP secrets an older desktop left behind", () => {
  it("are encrypted at start, and ciphertext from another key stays opaque", () => {
    const store = new DesktopConfigStore(directory())
    const foreign = encryptSecret("other-machine", Buffer.alloc(32, 1))
    store.writeMcp([
      {
        id: "github",
        type: "command",
        command: "npx",
        env: { GITHUB_TOKEN: "ghp_plain", EMPTY: "", COPIED: foreign },
        headerEnv: { Authorization: "API_KEY" },
      },
      {
        id: "remote",
        type: "http",
        url: "https://mcp.example",
        headers: { Authorization: "Bearer remote-secret" },
      },
    ])
    expect(encryptStoredMcpSecrets(store)).toBe(2)
    const raw = fs.readFileSync(store.paths.mcpFile, "utf8")
    expect(raw).not.toContain("ghp_plain")
    expect(raw).not.toContain("remote-secret")
    const [github, remote] = store.readMcp().entries
    const env = github!.env as Record<string, string>
    expect(decryptSecret(env.GITHUB_TOKEN!)).toBe("ghp_plain")
    expect(env.EMPTY).toBe("")
    expect(env.COPIED).toBe(foreign)
    // Environment variable names are not secrets.
    expect(github!.headerEnv).toEqual({ Authorization: "API_KEY" })
    const headers = remote!.headers as Record<string, string>
    expect(decryptSecret(headers.Authorization!)).toBe("Bearer remote-secret")
    // Nothing left to encrypt.
    expect(encryptStoredMcpSecrets(store)).toBe(0)
  })

  it("stay as they are without a settings key", () => {
    vi.stubEnv("BETTERC0DE_SETTINGS_KEY", "")
    __resetMasterKeyCache()
    const store = new DesktopConfigStore(directory())
    store.writeMcp([{ id: "a", command: "x", env: { TOKEN: "plain" } }])
    expect(encryptStoredMcpSecrets(store)).toBe(0)
    expect(store.readMcp().entries[0]!.env).toEqual({ TOKEN: "plain" })
  })
})
