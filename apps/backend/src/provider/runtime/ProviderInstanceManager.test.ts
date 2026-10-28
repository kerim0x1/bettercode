import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { settingsSchema } from "@betterc0de/schema"
import {
  ProviderInstanceManager,
  deriveProviderInstanceConfigs,
} from "./ProviderInstanceManager"
import { CursorAcpAdapter } from "./cursor/CursorAcpAdapter"
import { GrokAcpAdapter } from "./grok-cli/GrokAcpAdapter"
import { BetterC0deCompatAdapter } from "./betterc0deCompat/BetterC0deCompatAdapter"

const tempRoots: string[] = []
const originalPath = process.env.PATH

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function makeCodexBinary(version: string): string {
  const dir = makeTempDir("betterc0de-provider-codex-")
  const binaryPath = path.join(
    dir,
    process.platform === "win32" ? "codex.cmd" : "codex"
  )
  fs.writeFileSync(
    binaryPath,
    process.platform === "win32"
      ? `@echo off
if "%1"=="--version" echo ${version}
exit /b 0
`
      : `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("${version}\\n");
  process.exit(0);
}
process.exit(0);
`,
    "utf8"
  )
  fs.chmodSync(binaryPath, 0o755)
  return binaryPath
}

afterEach(() => {
  vi.unstubAllEnvs()
  process.env.PATH = originalPath
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("ProviderInstanceManager", () => {
  it("passes Finder's resolved Codex path to built-in and custom adapters", () => {
    const installedCodex = path.join(makeTempDir("betterc0de-codex-"), "codex")
    vi.stubEnv("BETTERC0DE_CODEX_CLI_PATH", installedCodex)
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    const instances = manager.reconcile(
      settingsSchema.parse({
        provider_instances: {
          "codex-work": { driver: "codex", config: {} },
        },
      })
    ).instances

    for (const id of ["codex", "codex-work"]) {
      expect(
        instances.find((instance) => instance.instanceId === id)?.config
      ).toMatchObject({ binaryPath: installedCodex })
    }
  })

  it("passes the shell-resolved Claude binary to a custom SDK adapter", () => {
    const installedClaude = path.join(
      makeTempDir("betterc0de-claude-"),
      "claude"
    )
    vi.stubEnv("BETTERC0DE_CLAUDE_CODE_PATH", installedClaude)
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    const claude = manager
      .reconcile(
        settingsSchema.parse({
          provider_instances: {
            "claude-work": { driver: "claude", config: {} },
          },
        })
      )
      .instances.find((instance) => instance.instanceId === "claude-work")

    expect(
      (claude?.adapter as unknown as { options?: { binaryPath?: string } })
        .options?.binaryPath
    ).toBe(installedClaude)
  })

  it("rebuilds an instance when opaque own __proto__ configuration changes", () => {
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })
    const settings = (value: number) =>
      settingsSchema.parse({
        provider_instances: {
          custom: {
            driver: "futureProvider",
            config: {
              opaque: JSON.parse(`{"__proto__":{"version":${value}}}`),
            },
          },
        },
      })
    const first = manager.reconcile(settings(1))
    expect(manager.reconcile(settings(1)).changed).toBe(false)
    const second = manager.reconcile(settings(2))
    expect(second.changed).toBe(true)
    expect(
      second.instances.find((instance) => instance.instanceId === "custom")
    ).not.toBe(
      first.instances.find((instance) => instance.instanceId === "custom")
    )
    expect(
      second.instances.find((instance) => instance.instanceId === "custom")
        ?.config
    ).toEqual({ opaque: JSON.parse('{"__proto__":{"version":2}}') })
  })

  it("rejects unsafe environment keys before distributing config to adapters", () => {
    const settings = settingsSchema.parse({
      provider_instances: {
        unsafe: {
          driver: "codex",
          environment: [
            { name: "NODE_OPTIONS", value: "--require ./steal.js" },
          ],
        },
      },
    })
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    expect(() => manager.reconcile(settings)).toThrow(
      /NODE_OPTIONS.*not allowed/i
    )
  })

  it("hydrates default CLI instances and explicit custom instances", () => {
    const settings = settingsSchema.parse({
      provider_instances: {
        "codex-work": {
          driver: "codex",
          displayName: "Codex Work",
          enabled: true,
          environment: [
            { name: "OPENAI_API_KEY", value: "secret", sensitive: true },
          ],
          config: {
            binaryPath: "/opt/homebrew/bin/codex",
            homePath: "/Users/example/.codex-work",
            shadowHomePath: "/Users/example/.codex-shadow",
            customModels: ["gpt-custom"],
          },
        },
      },
    })

    const configs = deriveProviderInstanceConfigs(settings)
    expect(configs.map((config) => config.instanceId)).toEqual([
      "codex",
      "claude",
      "cursor",
      "grok-cli",
      "opencode-cli",
      "codex-work",
    ])
    expect(
      configs.find((config) => config.instanceId === "codex-work")
    ).toMatchObject({
      driver: "codex",
      displayName: "Codex Work",
      environment: [{ name: "OPENAI_API_KEY", sensitive: true }],
      config: {
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/example/.codex-work",
        shadowHomePath: "/Users/example/.codex-shadow",
        customModels: ["gpt-custom"],
      },
    })
  })

  it("synthesizes built-in provider slots from legacy provider settings", () => {
    const settings = settingsSchema.parse({
      providers: {
        codex: { custom_models: ["gpt-custom"] },
        claudeAgent: {
          enabled: false,
          custom_models: ["claude-custom"],
          binaryPath: "/opt/claude",
        },
        cursor: {
          custom_models: ["cursor/custom"],
          binaryPath: "/opt/cursor-agent",
          apiEndpoint: "http://127.0.0.1:3939",
        },
        betterc0de: {
          custom_models: ["betterc0de/custom"],
          binaryPath: "/opt/betterc0de",
          serverUrl: "http://127.0.0.1:4096",
          serverUsername: "alice",
          serverPassword: "secret",
        },
      },
    })

    const configs = deriveProviderInstanceConfigs(settings)
    expect(configs.map((config) => config.instanceId)).toEqual([
      "codex",
      "cursor",
      "grok-cli",
      "opencode-cli",
    ])
    expect(
      configs.find((config) => config.instanceId === "claude")
    ).toBeUndefined()
    expect(
      configs.find((config) => config.instanceId === "betterc0de")
    ).toBeUndefined()
    expect(
      configs.find((config) => config.instanceId === "cursor")
    ).toMatchObject({
      driver: "cursor",
      config: {
        binaryPath: "/opt/cursor-agent",
        apiEndpoint: "http://127.0.0.1:3939",
        customModels: ["cursor/custom"],
      },
    })
  })

  it("uses BetterC0de as the canonical provider settings key while accepting legacy BetterC0de input", () => {
    const settings = settingsSchema.parse({
      providers: {
        BetterC0de: {
          enabled: false,
          custom_models: ["legacy/provider-model"],
          binaryPath: "/opt/legacy-open-code",
          serverUrl: "http://127.0.0.1:4096",
        },
      },
    })

    expect(settings.providers.betterc0de).toMatchObject({
      enabled: false,
      custom_models: ["legacy/provider-model"],
      binaryPath: "/opt/legacy-open-code",
      serverUrl: "http://127.0.0.1:4096",
    })
    expect(settings.providers).not.toHaveProperty("BetterC0de")

    const configs = deriveProviderInstanceConfigs(settings)
    expect(
      configs.find((config) => config.instanceId === "betterc0de")
    ).toBeUndefined()
    expect(configs.some((config) => config.instanceId === "BetterC0de")).toBe(
      false
    )
  })

  it("does not synchronously inspect or execute Codex binaries during reconciliation", () => {
    const staleBinary = makeCodexBinary("0.2.3")
    const currentBinary = makeCodexBinary("9.9.9")
    process.env.PATH = `${path.dirname(currentBinary)}${path.delimiter}${originalPath ?? ""}`
    const settings = settingsSchema.parse({
      providers: {
        codex: { binaryPath: staleBinary },
      },
    })
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const codex = manager
      .reconcile(settings)
      .instances.find((instance) => instance.instanceId === "codex")

    expect(codex?.version).toBeNull()
    expect(codex?.config).toMatchObject({
      binaryPath: staleBinary,
    })
    expect(
      (codex?.adapter as unknown as { options?: { binaryPath?: string } })
        .options?.binaryPath
    ).toBe(staleBinary)
  })

  it("keeps unsupported drivers as snapshots instead of rejecting settings", () => {
    const settings = settingsSchema.parse({
      provider_instances: {
        experimental: {
          driver: "futureDriver",
          displayName: "Future",
          config: {},
        },
      },
    })

    expect(
      deriveProviderInstanceConfigs(settings).find(
        (config) => config.instanceId === "experimental"
      )
    ).toMatchObject({
      driver: "futureDriver",
      displayName: "Future",
    })
  })

  it("preserves opaque driver config payloads at the settings boundary", () => {
    const settings = settingsSchema.parse({
      provider_instances: {
        experimental: {
          driver: "futureDriver",
          displayName: "Future",
          config: ["driver-owned", { nested: true }],
        },
      },
    })

    expect(settings.provider_instances.experimental?.config).toEqual([
      "driver-owned",
      { nested: true },
    ])
    expect(
      deriveProviderInstanceConfigs(settings).find(
        (config) => config.instanceId === "experimental"
      )?.config
    ).toEqual(["driver-owned", { nested: true }])
  })

  it("keeps provider instance slugs strict and lossless at the settings boundary", () => {
    const settings = settingsSchema.parse({
      provider_instances: {
        claudeAgent: {
          driver: "claudeAgent",
          displayName: "Claude Agent",
          environment: [{ name: "ANTHROPIC_API_KEY", value: "secret" }],
        },
        futureProvider: {
          driver: "futureProvider",
          displayName: "Future Provider",
          accentColor: " #aabbcc ",
        },
      },
    })

    expect(settings.provider_instances.claudeAgent?.driver).toBe("claudeAgent")
    expect(settings.provider_instances.futureProvider?.driver).toBe(
      "futureProvider"
    )
    expect(settings.provider_instances.futureProvider?.accentColor).toBe(
      "#aabbcc"
    )
  })

  it("hydrates text-generation model selection defaults and aliases", () => {
    expect(settingsSchema.parse({}).text_generation_model_selection).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
    })

    expect(
      settingsSchema.parse({
        textGenerationModelSelection: {
          instanceId: "claude",
          model: "claude-haiku-4-5",
          options: { thinking: "max" },
        },
      }).text_generation_model_selection
    ).toEqual({
      instanceId: "claude",
      model: "claude-haiku-4-5",
      options: [{ id: "thinking", value: "max" }],
    })

    expect(
      settingsSchema.parse({
        text_generation_model: "gpt-5.4-mini-legacy",
      }).text_generation_model_selection
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini-legacy",
    })
  })

  it("rejects provider instance ids, drivers, and env names outside slug rules", () => {
    expect(() =>
      settingsSchema.parse({
        provider_instances: { "1bad": { driver: "codex" } },
      })
    ).toThrow()
    expect(() =>
      settingsSchema.parse({
        provider_instances: { valid: { driver: "has spaces" } },
      })
    ).toThrow()
    expect(() =>
      settingsSchema.parse({
        provider_instances: {
          valid: {
            driver: "codex",
            environment: [{ name: "HAS-DASH", value: "x" }],
          },
        },
      })
    ).toThrow()
  })

  it("maps legacy driver aliases to BetterC0de runtimes while preserving unknown drivers", () => {
    const settings = settingsSchema.parse({
      provider_instances: {
        claudeAgent: { driver: "claudeAgent", displayName: "Claude Agent" },
        cursorAgent: { driver: "cursor-agent", displayName: "Cursor Agent" },
        grokAgent: { driver: "grok_cli", displayName: "Grok Agent" },
        betterc0deCli: {
          driver: "betterc0de-cli",
          displayName: "BetterC0de CLI",
        },
        futureProvider: { driver: "futureProvider", displayName: "Future" },
      },
    })

    const configs = deriveProviderInstanceConfigs(settings)
    expect(
      configs.find((config) => config.instanceId === "claudeAgent")
    ).toMatchObject({
      driver: "claude",
      displayName: "Claude Agent",
    })
    expect(
      configs.find((config) => config.instanceId === "cursorAgent")
    ).toMatchObject({
      driver: "cursor",
      displayName: "Cursor Agent",
    })
    expect(
      configs.find((config) => config.instanceId === "grokAgent")
    ).toMatchObject({
      driver: "grok-cli",
      displayName: "Grok Agent",
    })
    expect(
      configs.find((config) => config.instanceId === "betterc0deCli")
    ).toMatchObject({
      driver: "betterc0de",
      displayName: "BetterC0de CLI",
    })
    expect(
      configs.find((config) => config.instanceId === "futureProvider")
    ).toMatchObject({
      driver: "futureProvider",
      displayName: "Future",
    })
  })

  it("expands tilde home paths before deriving continuation keys", () => {
    const settings = settingsSchema.parse({
      provider_instances: {
        "codex-home": {
          driver: "codex",
          config: { homePath: "~/.codex-work" },
        },
        "claude-home": {
          driver: "claude",
          config: { homePath: "~/.claude" },
        },
      },
    })
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const instances = manager.reconcile(settings).instances
    expect(
      instances.find((instance) => instance.instanceId === "codex-home")
        ?.continuationKey
    ).toBe(`codex:home:${path.resolve(os.homedir(), ".codex-work")}`)
    expect(
      instances.find((instance) => instance.instanceId === "claude-home")
        ?.continuationKey
    ).toBe(`claude:home:${os.homedir()}`)
  })

  it("threads the shared native event logger into Codex and Claude adapters", () => {
    const nativeEventLogger = {
      filePath: "memory://provider-native-events",
      write: () => {},
      flush: async () => {},
      removeThread: async () => {},
      close: () => {},
    }
    const settings = settingsSchema.parse({
      provider_instances: {
        "codex-work": { driver: "codex" },
        "claude-work": { driver: "claude" },
      },
    })
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      nativeEventLogger,
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const instances = manager.reconcile(settings).instances
    const codexOptions = (
      instances.find((instance) => instance.instanceId === "codex-work")
        ?.adapter as unknown as {
        options?: { nativeEventLogger?: unknown }
      }
    ).options
    const claudeOptions = (
      instances.find((instance) => instance.instanceId === "claude-work")
        ?.adapter as unknown as {
        options?: { nativeEventLogger?: unknown }
      }
    ).options
    const claudeInstance = instances.find(
      (instance) => instance.instanceId === "claude-work"
    )

    expect(codexOptions?.nativeEventLogger).toBe(nativeEventLogger)
    expect(claudeOptions?.nativeEventLogger).toBe(nativeEventLogger)
    expect(claudeInstance?.statusProbe).toEqual(expect.any(Function))
  })

  it("threads the authoritative MCP resolver into Cursor and Grok ACP adapters", () => {
    const resolveAcpMcpServers = async () => []
    const resolveCodeSearchServer = async () => null
    const settings = settingsSchema.parse({})
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      resolveAcpMcpServers,
      resolveCodeSearchServer,
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const instances = manager.reconcile(settings).instances
    const cursorOptions = (
      instances.find((instance) => instance.instanceId === "cursor")
        ?.adapter as unknown as {
        options?: { resolveMcpServers?: unknown }
      }
    ).options
    const grokOptions = (
      instances.find((instance) => instance.instanceId === "grok-cli")
        ?.adapter as unknown as {
        options?: { resolveMcpServers?: unknown }
      }
    ).options

    expect(cursorOptions?.resolveMcpServers).toBe(resolveAcpMcpServers)
    expect(grokOptions?.resolveMcpServers).toBe(resolveAcpMcpServers)
    for (const id of ["claude", "codex"]) {
      expect(
        instances.find((instance) => instance.instanceId === id)?.adapter
      ).toMatchObject({
        options: { resolveCodeSearchServer },
      })
    }
  })

  it("omits compat and claude-terminal unless they are explicitly enabled", () => {
    const settings = settingsSchema.parse({})
    const configs = deriveProviderInstanceConfigs(settings)
    expect(configs.map((config) => config.instanceId)).toEqual([
      "codex",
      "claude",
      "cursor",
      "grok-cli",
      "opencode-cli",
    ])

    const enabled = deriveProviderInstanceConfigs(
      settingsSchema.parse({
        providers: {
          "claude-terminal": { enabled: true },
          betterc0de: { enabled: true },
        },
      })
    )
    expect(enabled.map((config) => config.instanceId)).toEqual([
      "codex",
      "claude",
      "claude-terminal",
      "cursor",
      "betterc0de",
      "grok-cli",
      "opencode-cli",
    ])
  })

  it("builds BetterC0de with the live SDK adapter instead of a pending placeholder", () => {
    const settings = settingsSchema.parse({
      providers: {
        betterc0de: {
          enabled: true,
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "secret",
          custom_models: ["custom/provider-model"],
        },
      },
    })
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const instance = manager
      .reconcile(settings)
      .instances.find((candidate) => candidate.instanceId === "betterc0de")

    expect(instance?.adapter).toBeInstanceOf(BetterC0deCompatAdapter)
    expect(instance?.adapter.isConfigured()).toBe(true)
  })

  it("builds Cursor with the live ACP adapter instead of a pending placeholder", () => {
    const settings = settingsSchema.parse({
      providers: {
        cursor: {
          // Binary resolution only accepts real absolute files — the running
          // node executable is a convenient guaranteed-real path.
          binaryPath: process.execPath,
          apiEndpoint: "http://127.0.0.1:3939",
          custom_models: ["cursor/custom"],
        },
      },
    })
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const instance = manager
      .reconcile(settings)
      .instances.find((candidate) => candidate.instanceId === "cursor")

    expect(instance?.adapter).toBeInstanceOf(CursorAcpAdapter)
    expect(instance?.adapter.isConfigured()).toBe(true)
  })

  it("builds Grok CLI with the live ACP adapter and the grok_cli provider kind", () => {
    const settings = settingsSchema.parse({
      provider_instances: {
        "grok-work": {
          driver: "grok-cli",
          displayName: "Grok Work",
          // Binary resolution only accepts real files (grok-dev incident) —
          // the running node executable is a convenient guaranteed-real path.
          config: {
            binaryPath: process.execPath,
            customModels: ["grok-custom"],
          },
        },
      },
    })
    const manager = new ProviderInstanceManager({
      clientInfo: { name: "BetterC0de", title: "BetterC0de", version: "test" },
      getStoredProviderThreadId: () => null,
      persistProviderThreadId: () => {},
    })

    const instances = manager.reconcile(settings).instances
    const custom = instances.find(
      (candidate) => candidate.instanceId === "grok-work"
    )
    expect(custom?.adapter).toBeInstanceOf(GrokAcpAdapter)
    expect(custom?.provider).toBe("grok_cli")
    expect(custom?.adapter.isConfigured()).toBe(true)

    // The default "grok-cli" slot exists even without explicit settings.
    expect(
      instances.some((candidate) => candidate.instanceId === "grok-cli")
    ).toBe(true)
  })
})
