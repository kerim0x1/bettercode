import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetMasterKeyCache } from "./crypto"
import { InvalidSettingsPatchError, SettingsService } from "./service"
import { httpContracts } from "@betterc0de/schema/http-contracts"

describe("SettingsService secret contract", () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-settings-"))
    filePath = path.join(dir, "settings.json")
    vi.stubEnv(
      "BETTERC0DE_SETTINGS_KEY",
      Buffer.alloc(32, 7).toString("base64")
    )
    __resetMasterKeyCache()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    __resetMasterKeyCache()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("returns only secret state and encrypts every declared settings secret", () => {
    const service = new SettingsService(filePath)

    const response = service.updatePublic({
      providers: {
        openai: { api_key: { set: "sk-openai" } },
        betterc0de: { serverPassword: { set: "provider-password" } },
      },
      provider_instances: {
        remote: {
          driver: "betterc0de",
          environment: [
            { name: "REMOTE_TOKEN", value: "env-token", sensitive: true },
          ],
          config: { serverPassword: { set: "instance-password" } },
        },
      },
      deepgram_api_key: { set: "deepgram-key" },
    })

    expect(response).toMatchObject({
      providers: {
        openai: { api_key: { configured: true, storage: "encrypted" } },
        betterc0de: {
          serverPassword: { configured: true, storage: "encrypted" },
        },
      },
      provider_instances: {
        remote: {
          environment: [
            {
              name: "REMOTE_TOKEN",
              value: "",
              valueRedacted: true,
              secretState: { configured: true, storage: "encrypted" },
            },
          ],
          config: {
            serverPassword: { configured: true, storage: "encrypted" },
          },
        },
      },
      deepgram_api_key: { configured: true, storage: "encrypted" },
    })
    const serializedResponse = JSON.stringify(response)
    for (const secret of [
      "sk-openai",
      "provider-password",
      "env-token",
      "instance-password",
      "deepgram-key",
    ]) {
      expect(serializedResponse).not.toContain(secret)
    }

    const disk = fs.readFileSync(filePath, "utf8")
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
    }
    expect(disk.match(/enc:v1:/g)?.length).toBe(5)
    expect(disk).not.toContain("sk-openai")
    expect(disk).not.toContain("provider-password")
    expect(disk).not.toContain("env-token")
    expect(disk).not.toContain("instance-password")
    expect(disk).not.toContain("deepgram-key")
  })

  it("persists the complete voice setup across restart without returning the Deepgram key", () => {
    const service = new SettingsService(filePath)
    const response = service.updatePublic({
      deepgram_api_key: { set: "synthetic-deepgram-key" },
      voice_mic_device_id: "default",
      voice_language: "de",
    })

    expect(response).toMatchObject({
      deepgram_api_key: { configured: true, storage: "encrypted" },
      voice_mic_device_id: "default",
      voice_language: "de",
    })
    expect(JSON.stringify(response)).not.toContain("synthetic-deepgram-key")
    expect(fs.readFileSync(filePath, "utf8")).not.toContain(
      "synthetic-deepgram-key"
    )

    const reopened = new SettingsService(filePath)
    expect(reopened.get()).toMatchObject({
      deepgram_api_key: "synthetic-deepgram-key",
      voice_mic_device_id: "default",
      voice_language: "de",
    })
    reopened.updatePublic({ voice_mic_device_id: "", voice_language: "en-US" })
    expect(reopened.get().deepgram_api_key).toBe("synthetic-deepgram-key")
    reopened.updatePublic({ deepgram_api_key: { clear: true } })
    expect(reopened.getPublic()).toMatchObject({
      deepgram_api_key: { configured: false },
      voice_mic_device_id: "",
      voice_language: "en-US",
    })
  })

  it("keeps Jev disabled by default and persists its key as a write-only encrypted secret", () => {
    const service = new SettingsService(filePath)
    expect(service.get().jev_search_enabled).toBe(false)
    expect(service.getPublic().jev_api_key).toBeUndefined()
    const response = service.updatePublic({
      jev_search_enabled: true,
      jev_api_key: { set: "jev-private-key" },
    })
    expect(response).toMatchObject({
      jev_search_enabled: true,
      jev_api_key: { configured: true, storage: "encrypted" },
    })
    expect(JSON.stringify(response)).not.toContain("jev-private-key")
    expect(fs.readFileSync(filePath, "utf8")).not.toContain("jev-private-key")
    const reopened = new SettingsService(filePath)
    expect(reopened.get().jev_api_key).toBe("jev-private-key")
    reopened.updatePublic({ jev_search_enabled: false })
    expect(reopened.get().jev_api_key).toBe("jev-private-key")
    reopened.updatePublic({ jev_api_key: { clear: true } })
    expect(reopened.getPublic().jev_api_key).toMatchObject({
      configured: false,
    })
  })

  it("rejects undeclared root settings instead of persisting or returning unknown secrets", () => {
    const service = new SettingsService(filePath)

    expect(() =>
      service.updatePublic({
        custom: {
          access_token: "must-not-be-accepted",
        },
      })
    ).toThrowError(
      expect.objectContaining<Partial<InvalidSettingsPatchError>>({
        statusCode: 400,
        code: "invalid_settings_patch",
      })
    )

    expect(JSON.stringify(service.getPublic())).not.toContain(
      "must-not-be-accepted"
    )
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("encrypts and redacts sensitive names nested in provider instance config", () => {
    const service = new SettingsService(filePath)

    const response = service.updatePublic({
      provider_instances: {
        custom: {
          driver: "custom",
          config: {
            oauth: {
              clientSecret: { set: "nested-client-secret" },
              access_token: { set: "nested-access-token" },
            },
          },
        },
      },
    })

    expect(response).toMatchObject({
      provider_instances: {
        custom: {
          config: {
            oauth: {
              clientSecret: { configured: true, storage: "encrypted" },
              access_token: { configured: true, storage: "encrypted" },
            },
          },
        },
      },
    })
    const disk = fs.readFileSync(filePath, "utf8")
    expect(disk).not.toContain("nested-client-secret")
    expect(disk).not.toContain("nested-access-token")
    expect(disk.match(/enc:v1:/g)?.length).toBe(2)
  })

  it("round-trips a redacted response without clearing stored secrets", () => {
    const service = new SettingsService(filePath)
    service.updatePublic({
      providers: { openai: { api_key: { set: "sk-keep" } } },
    })

    const publicSettings = service.getPublic()
    service.updatePublic({
      providers: publicSettings.providers,
      theme: "light",
    })

    expect(service.get().providers.openai.api_key).toBe("sk-keep")
    const reloaded = new SettingsService(filePath)
    expect(reloaded.get().providers.openai.api_key).toBe("sk-keep")
    expect(reloaded.getPublic()).toMatchObject({
      providers: {
        openai: { api_key: { configured: true, storage: "encrypted" } },
      },
      theme: "light",
    })
  })

  it("rejects downgrading a configured sensitive environment value", () => {
    const service = new SettingsService(filePath)
    service.updatePublic({
      provider_instances: {
        remote: {
          driver: "betterc0de",
          environment: [
            { name: "REMOTE_TOKEN", value: "keep-secret", sensitive: true },
          ],
        },
      },
    })
    const remote = (
      service.getPublic().provider_instances as Record<
        string,
        { driver: string; environment: Array<Record<string, unknown>> }
      >
    ).remote
    const [redacted] = remote.environment

    expect(() =>
      service.updatePublic({
        provider_instances: {
          remote: {
            ...remote,
            environment: [{ ...redacted, sensitive: false }],
          },
        },
      })
    ).toThrowError(
      expect.objectContaining<Partial<InvalidSettingsPatchError>>({
        statusCode: 400,
        code: "invalid_settings_patch",
      })
    )
    expect(
      service.get().provider_instances.remote.environment[0]
    ).toMatchObject({
      sensitive: true,
      value: "keep-secret",
    })
    expect(JSON.stringify(service.getPublic())).not.toContain("keep-secret")

    service.updatePublic({
      provider_instances: {
        remote: {
          ...remote,
          environment: [
            {
              name: "REMOTE_TOKEN",
              sensitive: false,
              value: { clear: true },
            },
          ],
        },
      },
    })
    expect(
      service.get().provider_instances.remote.environment[0]
    ).toMatchObject({
      sensitive: true,
      value: "",
    })
  })

  it("auto-classifies and protects secret-like provider fields", () => {
    const service = new SettingsService(filePath)

    const response = service.updatePublic({
      provider_instances: {
        remote: {
          driver: "betterc0de",
          environment: [
            {
              name: "OPENAI_API_KEY",
              value: "environment-secret",
              sensitive: false,
            },
            {
              name: "OPENAI_BASE_URL",
              value: "https://api.example.test/v1",
              sensitive: false,
            },
          ],
          config: {
            authorization: { set: "Bearer config-secret" },
            transport: {
              privateKey: { set: "nested-private-key" },
              endpoint: "https://remote.example.test",
            },
          },
        },
      },
    })

    expect(response).toMatchObject({
      provider_instances: {
        remote: {
          environment: [
            {
              name: "OPENAI_API_KEY",
              value: "",
              sensitive: true,
              valueRedacted: true,
              secretState: { configured: true, storage: "encrypted" },
            },
            {
              name: "OPENAI_BASE_URL",
              value: "https://api.example.test/v1",
              sensitive: false,
            },
          ],
          config: {
            authorization: { configured: true, storage: "encrypted" },
            transport: {
              privateKey: { configured: true, storage: "encrypted" },
              endpoint: "https://remote.example.test",
            },
          },
        },
      },
    })
    const stored = service.get().provider_instances.remote
    expect(stored.environment[0]).toMatchObject({
      name: "OPENAI_API_KEY",
      value: "environment-secret",
      sensitive: true,
    })
    expect(stored).toMatchObject({
      config: {
        authorization: "Bearer config-secret",
        transport: { privateKey: "nested-private-key" },
      },
    })

    const disk = fs.readFileSync(filePath, "utf8")
    expect(disk.match(/enc:v1:/g)?.length).toBe(3)
    expect(disk).not.toContain("environment-secret")
    expect(disk).not.toContain("config-secret")
    expect(disk).not.toContain("nested-private-key")
  })

  it("removes provider instances only through the explicit delete contract", () => {
    const service = new SettingsService(filePath)
    service.updatePublic({
      provider_instances: {
        remove_me: {
          driver: "betterc0de",
          environment: [{ name: "REMOTE_TOKEN", value: "delete-this-secret" }],
        },
        keep_me: {
          driver: "codex",
          environment: [],
        },
      },
    })

    service.updatePublic({
      provider_instances: {
        keep_me: {
          driver: "codex",
          environment: [],
        },
      },
    })
    expect(service.get().provider_instances.remove_me).toBeDefined()

    const response = service.updatePublic({
      remove_provider_instance_ids: ["remove_me", "remove_me"],
    })

    expect(service.get().provider_instances.remove_me).toBeUndefined()
    expect(service.get().provider_instances.keep_me).toBeDefined()
    expect(response).not.toHaveProperty("remove_provider_instance_ids")
    const disk = fs.readFileSync(filePath, "utf8")
    expect(disk).not.toContain("remove_me")
    expect(disk).not.toContain("delete-this-secret")
  })

  it("merges sequential writes from independent service instances", () => {
    const firstWindow = new SettingsService(filePath)
    const secondWindow = new SettingsService(filePath)

    firstWindow.updatePublic({
      providers: { openai: { api_key: { set: "shared-secret" } } },
    })
    secondWindow.updatePublic({ theme: "light" })

    const reloaded = new SettingsService(filePath)
    expect(reloaded.get()).toMatchObject({
      theme: "light",
      providers: { openai: { api_key: "shared-secret" } },
    })
    expect(fs.readFileSync(filePath, "utf8")).not.toContain("shared-secret")
  })

  it("does not auto-trust workspaces by default or when a present settings file cannot be applied", () => {
    // Opening a folder is not consent to run what it declares.
    expect(new SettingsService(filePath).get().auto_trust_workspaces).toBe(
      false
    )
    fs.writeFileSync(filePath, "{ definitely not valid JSON", "utf8")
    expect(new SettingsService(filePath).get().auto_trust_workspaces).toBe(
      false
    )
  })

  it("keeps a stored auto-trust choice", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ auto_trust_workspaces: true }),
      "utf8"
    )
    expect(new SettingsService(filePath).get().auto_trust_workspaces).toBe(true)
  })

  it("preserves malformed settings bytes and blocks writes until repaired", () => {
    const malformed = "{ definitely not valid JSON"
    fs.writeFileSync(filePath, malformed, "utf8")
    const service = new SettingsService(filePath)

    expect(() => service.updatePublic({ theme: "light" })).toThrowError(
      expect.objectContaining<Partial<InvalidSettingsPatchError>>({
        statusCode: 400,
        code: "invalid_settings_patch",
      })
    )
    expect(fs.readFileSync(filePath, "utf8")).toBe(malformed)

    fs.rmSync(filePath)
    expect(service.updatePublic({ theme: "light" })).toMatchObject({
      theme: "light",
    })
  })

  it("preserves a settings file when its metadata cannot be read", () => {
    const bytes = JSON.stringify({
      theme: "light",
      custom_rules: "Keep these rules",
    })
    fs.writeFileSync(filePath, bytes)
    const nativeStat = fs.statSync
    const stat = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      if (args[0] === filePath)
        throw Object.assign(new Error("metadata denied"), { code: "EACCES" })
      return Reflect.apply(nativeStat, fs, args)
    })
    let service: SettingsService
    try {
      service = new SettingsService(filePath)
      expect(() => service.update({ theme: "dark" })).toThrow(/metadata denied/)
      expect(fs.readFileSync(filePath, "utf8")).toBe(bytes)
    } finally {
      stat.mockRestore()
    }
    fs.rmSync(filePath)
    expect(service.update({ theme: "dark" }).theme).toBe("dark")
  })

  it("never overwrites or removes a temporary path it did not create", () => {
    const service = new SettingsService(filePath)
    service.update({ theme: "light" })
    const before = fs.readFileSync(filePath, "utf8")
    const nativeOpen = fs.openSync
    let occupiedPath = ""
    const open = vi
      .spyOn(fs, "openSync")
      .mockImplementation((target, flags, mode) => {
        if (String(target).endsWith(".tmp")) {
          occupiedPath = String(target)
          const fd = nativeOpen(target, "wx", 0o600)
          try {
            fs.writeFileSync(fd, "another owner's file")
          } finally {
            fs.closeSync(fd)
          }
        }
        return nativeOpen(target, flags, mode)
      })
    try {
      expect(() => service.update({ theme: "dark" })).toThrow(/EEXIST/)
      expect(fs.readFileSync(occupiedPath, "utf8")).toBe("another owner's file")
      expect(fs.readFileSync(filePath, "utf8")).toBe(before)
      expect(service.get().theme).toBe("light")
    } finally {
      open.mockRestore()
    }
  })

  it("loads legacy null optional fields and saves without losing settings or encrypted credentials", () => {
    const original = new SettingsService(filePath)
    original.updatePublic({
      theme: "light",
      language: "de",
      archived_thread_ids: ["saved-chat"],
      providers: {
        openai: {
          api_key: { set: "keep-encrypted-key" },
          base_url: "https://example.test/v1",
        },
        claude: { enabled: false, custom_models: ["custom-model"] },
      },
    })
    const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"))
    // A key an older version kept (now in rules.md) still loads.
    legacy.custom_rules = "Keep my project rules"
    legacy.text_generation_model = null
    legacy.deepgram_api_key = null
    for (const name of [
      "anthropic",
      "google",
      "grok",
      "openrouter",
      "deepseek",
      "lmstudio",
    ]) {
      legacy.providers[name].api_key = null
      legacy.providers[name].base_url = null
    }
    legacy.providers.claude.binaryPath = null
    const legacyBytes = JSON.stringify(legacy)
    fs.writeFileSync(filePath, legacyBytes)

    const migrated = new SettingsService(filePath)
    expect(migrated.get()).toMatchObject({
      theme: "light",
      language: "de",
      custom_rules: "Keep my project rules",
      archived_thread_ids: ["saved-chat"],
      providers: {
        openai: {
          api_key: "keep-encrypted-key",
          base_url: "https://example.test/v1",
        },
        claude: { enabled: false, custom_models: ["custom-model"] },
      },
    })
    expect(migrated.get().text_generation_model).toBeUndefined()
    expect(migrated.get().providers.anthropic.api_key).toBeUndefined()
    expect(fs.readFileSync(filePath, "utf8")).toBe(legacyBytes)
    const saved = migrated.updatePublic({ show_tool_details: true })
    expect(
      httpContracts.updateSettings.response.safeParse(
        JSON.parse(JSON.stringify(saved))
      ).success
    ).toBe(true)
    expect(saved).toMatchObject({ language: "de", show_tool_details: true })
    expect(JSON.stringify(saved)).not.toContain("keep-encrypted-key")
    const disk = fs.readFileSync(filePath, "utf8")
    expect(disk).toContain("enc:v1:")
    expect(disk).not.toContain("keep-encrypted-key")
    expect(JSON.parse(disk)).not.toHaveProperty("text_generation_model")
    expect(new SettingsService(filePath).get()).toEqual(migrated.get())
  })

  it("accepts an all-null legacy provider configuration like the console report", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        text_generation_model: null,
        providers: Object.fromEntries(
          [
            "openai",
            "anthropic",
            "google",
            "grok",
            "openrouter",
            "deepseek",
            "lmstudio",
          ].map((name) => [name, { api_key: null, base_url: null }])
        ),
      })
    )
    const service = new SettingsService(filePath)
    expect(service.updatePublic({ language: "de" })).toMatchObject({
      language: "de",
    })
    expect(service.get().text_generation_model_selection.instanceId).toBe(
      "codex"
    )
    expect(service.getPublic()).toMatchObject({
      providers: { openai: { api_key: { configured: false } } },
    })
    expect(
      httpContracts.getSettings.response.safeParse(
        JSON.parse(JSON.stringify(service.getPublic()))
      ).success
    ).toBe(true)
  })

  it.each([
    { theme: null },
    { providers: { openai: { enabled: null } } },
    { providers: { openai: { api_key: 42 } } },
    { providers: { openai: { base_url: [] } } },
  ])(
    "still protects invalid settings from being overwritten: %j",
    (invalid) => {
      const bytes = JSON.stringify({ text_generation_model: null, ...invalid })
      fs.writeFileSync(filePath, bytes)
      const service = new SettingsService(filePath)
      expect(() => service.updatePublic({ theme: "light" })).toThrowError(
        expect.objectContaining({ code: "invalid_settings_patch" })
      )
      expect(fs.readFileSync(filePath, "utf8")).toBe(bytes)
    }
  )

  it("does not overwrite schema-invalid settings containing credentials", () => {
    const invalid = JSON.stringify({
      diff_style: "side-by-side",
      provider_instances: {
        remote: {
          driver: "betterc0de",
          environment: [{ name: "REMOTE_TOKEN", value: "recover-this-secret" }],
        },
      },
    })
    fs.writeFileSync(filePath, invalid, "utf8")
    const service = new SettingsService(filePath)

    expect(() => service.updatePublic({ theme: "light" })).toThrowError(
      expect.objectContaining<Partial<InvalidSettingsPatchError>>({
        statusCode: 400,
        code: "invalid_settings_patch",
      })
    )
    expect(fs.readFileSync(filePath, "utf8")).toBe(invalid)
  })

  it("reports the plaintext fallback without returning the secret", () => {
    vi.stubEnv("BETTERC0DE_SETTINGS_KEY", "")
    vi.stubEnv("BETTERC0DE_ALLOW_PLAINTEXT_SECRETS", "1")
    __resetMasterKeyCache()
    const service = new SettingsService(filePath)

    const response = service.updatePublic({
      providers: { anthropic: { api_key: { set: "plaintext-key" } } },
    })

    expect(response).toMatchObject({
      providers: {
        anthropic: { api_key: { configured: true, storage: "plaintext" } },
      },
    })
    expect(JSON.stringify(response)).not.toContain("plaintext-key")
    expect(fs.readFileSync(filePath, "utf8")).toContain("plaintext-key")
  })

  it("refuses plaintext secret persistence without explicit opt-in", () => {
    vi.stubEnv("BETTERC0DE_SETTINGS_KEY", "")
    vi.stubEnv("BETTERC0DE_ALLOW_PLAINTEXT_SECRETS", "")
    __resetMasterKeyCache()
    const service = new SettingsService(filePath)

    expect(() =>
      service.updatePublic({
        providers: { openai: { api_key: { set: "must-not-persist" } } },
      })
    ).toThrowError(
      expect.objectContaining<Partial<InvalidSettingsPatchError>>({
        statusCode: 400,
        code: "invalid_settings_patch",
      })
    )
    expect(service.get().providers.openai.api_key).toBeUndefined()
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("requires provider credentials to be cleared or replaced before changing their destination", () => {
    const service = new SettingsService(filePath)
    service.updatePublic({
      providers: {
        openai: {
          api_key: { set: "sk-bound-to-api-one" },
          base_url: "https://api-one.example.test/v1",
        },
      },
    })

    const publicOpenAi = (
      service.getPublic().providers as Record<string, Record<string, unknown>>
    ).openai
    expect(() =>
      service.updatePublic({
        providers: {
          openai: {
            ...publicOpenAi,
            base_url: "https://api-two.example.test/v1",
          },
        },
      })
    ).toThrowError(
      expect.objectContaining<Partial<InvalidSettingsPatchError>>({
        statusCode: 400,
        code: "invalid_settings_patch",
      })
    )
    expect(service.get().providers.openai).toMatchObject({
      api_key: "sk-bound-to-api-one",
      base_url: "https://api-one.example.test/v1",
    })

    service.updatePublic({
      providers: {
        openai: {
          ...publicOpenAi,
          api_key: { set: "sk-bound-to-api-two" },
          base_url: "https://api-two.example.test/v1",
        },
      },
    })
    expect(service.get().providers.openai).toMatchObject({
      api_key: "sk-bound-to-api-two",
      base_url: "https://api-two.example.test/v1",
    })
  })

  it("refuses to store the desktop configuration keys that moved to their files", () => {
    const service = new SettingsService(filePath)
    for (const patch of [
      { custom_rules: "rules" },
      { skills: [] },
      { hooks: [] },
      {
        mcp_servers: [
          {
            id: "github",
            name: "GitHub",
            command: "trusted-mcp",
            args: "--stdio",
            envVars: { set: "GITHUB_TOKEN=bound-secret" },
            enabled: true,
          },
        ],
      },
    ]) {
      expect(() => service.updatePublic(patch)).toThrowError(
        expect.objectContaining<Partial<InvalidSettingsPatchError>>({
          statusCode: 400,
          code: "invalid_settings_patch",
        })
      )
    }
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("keeps legacy MCP envVars encrypted until the migration removes them", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        theme: "light",
        mcp_servers: [
          {
            id: "github",
            name: "GitHub",
            command: "trusted-mcp",
            args: "--stdio",
            envVars: "GITHUB_TOKEN=bound-secret",
            enabled: true,
          },
        ],
      })
    )
    const service = new SettingsService(filePath)
    // Plaintext from an older version is encrypted on load, and read back.
    expect(fs.readFileSync(filePath, "utf8")).not.toContain("bound-secret")
    expect(service.get().mcp_servers?.[0]).toMatchObject({
      id: "github",
      envVars: "GITHUB_TOKEN=bound-secret",
    })
    expect(
      (service.getPublic().mcp_servers as Array<Record<string, unknown>>)[0]
    ).toMatchObject({ envVars: { configured: true, storage: "encrypted" } })

    // The migration removes the key once the servers are in their file.
    service.update({ mcp_servers: undefined })
    expect(service.get().mcp_servers).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).not.toHaveProperty(
      "mcp_servers"
    )
    expect(new SettingsService(filePath).get().theme).toBe("light")
  })

  it("requires instance credentials to be cleared before changing driver destinations", () => {
    const service = new SettingsService(filePath)
    service.updatePublic({
      provider_instances: {
        remote: {
          driver: "betterc0de",
          environment: [
            { name: "REMOTE_TOKEN", value: "bound-secret", sensitive: true },
          ],
          config: { serverUrl: "wss://one.example.test" },
        },
      },
    })

    const remote = (
      service.getPublic().provider_instances as Record<
        string,
        Record<string, unknown>
      >
    ).remote
    expect(() =>
      service.updatePublic({
        provider_instances: {
          remote: {
            ...remote,
            config: { serverUrl: "wss://two.example.test" },
          },
        },
      })
    ).toThrowError(
      expect.objectContaining<Partial<InvalidSettingsPatchError>>({
        statusCode: 400,
        code: "invalid_settings_patch",
      })
    )
    expect(service.get().provider_instances.remote.config).toEqual({
      serverUrl: "wss://one.example.test",
    })
  })

  it("preserves untouched provider instances and omitted instance fields on partial patches", () => {
    const service = new SettingsService(filePath)
    service.updatePublic({
      provider_instances: {
        primary: {
          driver: "claude",
          displayName: "Primary",
          environment: [
            {
              name: "ANTHROPIC_API_KEY",
              value: "primary-secret",
              sensitive: true,
            },
          ],
          config: {
            homePath: "/trusted/claude-home",
            apiKey: { set: "primary-config-secret" },
          },
        },
        secondary: {
          driver: "codex",
          displayName: "Secondary",
          environment: [{ name: "SECONDARY_FLAG", value: "enabled" }],
          config: { shadowHomePath: "/trusted/codex-home" },
        },
      },
    })

    service.updatePublic({
      provider_instances: {
        primary: {
          displayName: "Renamed Primary",
        },
      },
    })

    expect(service.get().provider_instances).toMatchObject({
      primary: {
        instanceId: "primary",
        driver: "claude",
        displayName: "Renamed Primary",
        environment: [
          {
            name: "ANTHROPIC_API_KEY",
            value: "primary-secret",
            sensitive: true,
          },
        ],
        config: {
          homePath: "/trusted/claude-home",
          apiKey: "primary-config-secret",
        },
      },
      secondary: {
        instanceId: "secondary",
        driver: "codex",
        displayName: "Secondary",
        environment: [{ name: "SECONDARY_FLAG", value: "enabled" }],
        config: { shadowHomePath: "/trusted/codex-home" },
      },
    })

    const reloaded = new SettingsService(filePath)
    expect(reloaded.get().provider_instances.primary.config).toMatchObject({
      homePath: "/trusted/claude-home",
      apiKey: "primary-config-secret",
    })
    expect(reloaded.get().provider_instances.secondary.displayName).toBe(
      "Secondary"
    )
  })

  it.each(["homePath", "shadowHomePath"])(
    "requires instance credentials to be rebound before changing %s",
    (destinationKey) => {
      const service = new SettingsService(filePath)
      service.updatePublic({
        provider_instances: {
          guarded: {
            driver: "claude",
            environment: [
              {
                name: "ANTHROPIC_API_KEY",
                value: "bound-secret",
                sensitive: true,
              },
            ],
            config: { [destinationKey]: "/trusted/home" },
          },
        },
      })

      expect(() =>
        service.updatePublic({
          provider_instances: {
            guarded: {
              config: { [destinationKey]: "/attacker/home" },
            },
          },
        })
      ).toThrowError(
        expect.objectContaining({ code: "invalid_settings_patch" })
      )

      expect(service.get().provider_instances.guarded.config).toMatchObject({
        [destinationKey]: "/trusted/home",
      })
    }
  )

  it("does not let provider environment changes redirect preserved instance secrets", () => {
    const service = new SettingsService(filePath)
    service.updatePublic({
      provider_instances: {
        remote: {
          driver: "betterc0de",
          environment: [
            { name: "REMOTE_TOKEN", value: "bound-secret", sensitive: true },
          ],
        },
      },
    })
    const remote = (
      service.getPublic().provider_instances as Record<
        string,
        Record<string, unknown>
      >
    ).remote
    const environment = remote.environment as Array<Record<string, unknown>>

    expect(() =>
      service.updatePublic({
        provider_instances: {
          remote: {
            ...remote,
            environment: [
              ...environment,
              {
                name: "HTTPS_PROXY",
                value: "https://attacker.example",
                sensitive: false,
              },
            ],
          },
        },
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_settings_patch" }))

    expect(() =>
      service.updatePublic({
        provider_instances: {
          remote: {
            ...remote,
            environment: [{ ...environment[0], name: "RENAMED_TOKEN" }],
          },
        },
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_settings_patch" }))

    service.updatePublic({
      provider_instances: {
        remote: {
          ...remote,
          environment: [
            {
              name: "REMOTE_TOKEN",
              value: { set: "rebound-secret" },
              sensitive: true,
            },
            {
              name: "HTTPS_PROXY",
              value: "https://approved.example",
              sensitive: false,
            },
          ],
        },
      },
    })
    expect(service.get().provider_instances.remote.environment).toEqual([
      { name: "REMOTE_TOKEN", value: "rebound-secret", sensitive: true },
      {
        name: "HTTPS_PROXY",
        value: "https://approved.example",
        sensitive: false,
      },
    ])
  })

  it("rejects provider environment loader-injection variables", () => {
    const service = new SettingsService(filePath)
    expect(() =>
      service.updatePublic({
        provider_instances: {
          unsafe: {
            driver: "codex",
            environment: [
              {
                name: "NODE_OPTIONS",
                value: "--require ./steal.js",
                sensitive: false,
              },
            ],
          },
        },
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_settings_patch" }))
  })

  it("rejects invalid values instead of silently retaining old settings", () => {
    const service = new SettingsService(filePath)

    expect(() => service.update({ theme: 42 })).toThrowError(
      expect.objectContaining<Partial<InvalidSettingsPatchError>>({
        statusCode: 400,
        code: "invalid_settings_patch",
      })
    )
    expect(service.get().theme).toBe("dark")
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it("persists configured helper models and rejects an invalid model id", () => {
    const service = new SettingsService(filePath)

    service.update({
      image_generation_model: "gpt-image-3",
      commit_message_claude_model: "claude-haiku-5",
    })
    const reloaded = new SettingsService(filePath).get()
    expect(reloaded.image_generation_model).toBe("gpt-image-3")
    expect(reloaded.commit_message_claude_model).toBe("claude-haiku-5")
    expect(reloaded.commit_message_codex_model).toBe("gpt-5.6-luna")

    expect(() =>
      service.update({ image_generation_model: "gpt-5.5 & calc" })
    ).toThrowError(
      expect.objectContaining<Partial<InvalidSettingsPatchError>>({
        statusCode: 400,
        code: "invalid_settings_patch",
      })
    )
    expect(service.get().image_generation_model).toBe("gpt-image-3")

    service.update({ image_generation_model: "" })
    expect(service.get().image_generation_model).toBe("gpt-5.5")
  })

  it("keeps encrypted secrets on disk and blocks writes when the master key cannot decrypt them", () => {
    const service = new SettingsService(filePath)
    service.updatePublic({
      providers: { openai: { api_key: { set: "survives-key-loss" } } },
      theme: "dark",
    })
    const encryptedFile = fs.readFileSync(filePath, "utf8")
    expect(encryptedFile).toContain("enc:v1:")
    expect(encryptedFile).not.toContain("survives-key-loss")

    vi.stubEnv(
      "BETTERC0DE_SETTINGS_KEY",
      Buffer.alloc(32, 9).toString("base64")
    )
    __resetMasterKeyCache()
    const locked = new SettingsService(filePath)

    expect(locked.get().providers.openai.api_key).toBe("")
    expect(() => locked.updatePublic({ theme: "light" })).toThrowError(
      expect.objectContaining<Partial<InvalidSettingsPatchError>>({
        statusCode: 400,
        code: "invalid_settings_patch",
      })
    )
    expect(fs.readFileSync(filePath, "utf8")).toBe(encryptedFile)
  })

  it("returns the validated immutable snapshot without reparsing on hot reads", () => {
    const service = new SettingsService(filePath)
    const first = service.get()
    const second = service.get()

    expect(second).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.providers)).toBe(true)
  })

  it("isolates change-listener failures after a successful persistence", () => {
    const service = new SettingsService(filePath)
    const laterListener = vi.fn()
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)
    service.on("change", () => {
      throw new Error("listener failed")
    })
    service.on("change", laterListener)

    expect(() => service.update({ theme: "light" })).not.toThrow()
    expect(service.get().theme).toBe("light")
    expect(laterListener).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).theme).toBe("light")
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

describe("SettingsService request-path costs", () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-settings-cost-"))
    filePath = path.join(dir, "settings.json")
    vi.stubEnv(
      "BETTERC0DE_SETTINGS_KEY",
      Buffer.alloc(32, 7).toString("base64")
    )
    __resetMasterKeyCache()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    __resetMasterKeyCache()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("does not re-read the file on update when nothing changed on disk", () => {
    const service = new SettingsService(filePath)
    service.update({ theme: "light" })
    const readFile = vi.spyOn(fs, "readFileSync")

    service.update({ theme: "dark" })

    expect(readFile).not.toHaveBeenCalledWith(filePath, "utf8")
    expect(service.get().theme).toBe("dark")
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).theme).toBe("dark")
  })

  it("still picks up an external edit before merging a patch", () => {
    const service = new SettingsService(filePath)
    service.update({ theme: "light" })

    // Simulate another process editing settings.json: different content
    // (size) and a newer mtime, which is what the stamp compares.
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >
    onDisk.custom_rules = "always answer in haiku"
    fs.writeFileSync(filePath, JSON.stringify(onDisk, null, 2), "utf8")
    const later = Date.now() / 1000 + 5
    fs.utimesSync(filePath, later, later)

    service.update({ theme: "dark" })

    expect(service.get().custom_rules).toBe("always answer in haiku")
    expect(service.get().theme).toBe("dark")
  })

  it("emits change listeners only after the write lock is released", () => {
    const service = new SettingsService(filePath)
    const lockPath = `${filePath}.lock`
    let lockHeldDuringListener: boolean | null = null
    service.on("change", () => {
      lockHeldDuringListener = fs.existsSync(lockPath)
    })

    service.update({ theme: "light" })

    expect(lockHeldDuringListener).toBe(false)
  })

  it("serves a cached, frozen public view until the next write", () => {
    const service = new SettingsService(filePath)
    const first = service.getPublic()
    expect(service.getPublic()).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)

    service.update({ theme: "light" })
    const second = service.getPublic()
    expect(second).not.toBe(first)
    expect(second.theme).toBe("light")
    expect(service.getPublic()).toBe(second)
  })
})
