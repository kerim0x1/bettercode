/// <reference types="node" />
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// plugin-manager.cjs `require("electron")` returns the binary path string in
// a node-only environment, which makes the destructured `app` undefined and
// the constructor blow up. Stub before importing — same trick as
// ipc-handlers-factory.test.ts.
const requireCjs = createRequire(import.meta.url)
const electronPath = requireCjs.resolve("electron")
const cache = (
  requireCjs as unknown as {
    cache: Record<
      string,
      { id: string; filename: string; loaded: boolean; exports: unknown }
    >
  }
).cache
cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir() },
  },
}

const { PluginManager, assertPluginTreeHasNoSymlinks } = requireCjs(
  "../../../shell/plugin-manager.cjs"
) as {
  PluginManager: new () => {
    _pluginsDir: string | null
    setEncryptionKey: (key: string) => void
    setConfig: (pluginId: string, key: string, value: unknown) => void
    getConfig: (pluginId: string) => Record<string, unknown>
    getPublicConfig: (pluginId: string) => Record<string, unknown>
    listPlugins: () => Array<{ config: Record<string, unknown> }>
    loadPlugin: (pluginId: string) => Promise<Record<string, unknown>>
    unloadPlugin: (pluginId: string) => Promise<boolean>
    togglePlugin: (pluginId: string, enabled: boolean) => Promise<void>
    sendToPlugin: (
      pluginId: string,
      method: string,
      args?: unknown
    ) => Promise<unknown>
    setupPluginEvents: (
      pluginId: string,
      callback: (event: unknown) => void
    ) => Promise<boolean>
    plugins: Map<
      string,
      {
        manifest: Record<string, unknown>
        module: Record<string, unknown> | null
        config: Record<string, unknown>
        error: string | null
        eventDisposer: (() => unknown) | null
        entryPath: string
      }
    >
  }
  assertPluginTreeHasNoSymlinks: (
    root: string,
    opts?: { maxNodes?: number }
  ) => void
}

function tmpDir(label: string): string {
  // Canonical, because require.cache is keyed by real paths: on macOS the
  // temp dir is reached through the /var -> /private/var symlink, and a
  // lookup by the /var path would never find the loaded plugin.
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `bc0de-plug-${label}-`))
  )
}

describe("assertPluginTreeHasNoSymlinks (S3)", () => {
  let dir: string
  beforeEach(() => {
    dir = tmpDir("symlink")
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("accepts a clean tree with files and subdirectories", () => {
    fs.writeFileSync(path.join(dir, "manifest.json"), "{}")
    fs.mkdirSync(path.join(dir, "src"))
    fs.writeFileSync(path.join(dir, "src", "index.js"), "module.exports = {}")
    expect(() => assertPluginTreeHasNoSymlinks(dir)).not.toThrow()
  })

  it("rejects a tree containing a symlink to an outside file", () => {
    fs.writeFileSync(path.join(dir, "manifest.json"), "{}")
    const outsideFile = path.join(os.tmpdir(), `bc0de-target-${Date.now()}.txt`)
    fs.writeFileSync(outsideFile, "secret")
    try {
      // Use a `file` link explicitly so this works on Windows without
      // requiring elevation. Skip the assertion if we can't create a link
      // (sandboxed CI), since that would make the test useless rather than
      // reveal a regression.
      fs.symlinkSync(outsideFile, path.join(dir, "leaky"), "file")
    } catch {
      return
    }
    expect(() => assertPluginTreeHasNoSymlinks(dir)).toThrow(/symlink/i)
    fs.rmSync(outsideFile, { force: true })
  })

  it("refuses an absurdly large tree to avoid DoS on the install path", () => {
    fs.writeFileSync(path.join(dir, "manifest.json"), "{}")
    expect(() => assertPluginTreeHasNoSymlinks(dir, { maxNodes: 0 })).toThrow(
      /more than 0 entries/
    )
  })
})

describe("PluginManager secret config", () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir("secrets")
    const pluginDir = path.join(dir, "demo")
    fs.mkdirSync(pluginDir)
    fs.writeFileSync(
      path.join(pluginDir, "manifest.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        entry: "index.cjs",
        config: [
          { key: "apiKey", type: "secret", label: "API key" },
          { key: "region", type: "string", label: "Region" },
        ],
      })
    )
    fs.writeFileSync(path.join(pluginDir, "index.cjs"), "module.exports = {}")
    fs.writeFileSync(
      path.join(pluginDir, "config.json"),
      JSON.stringify({
        enabled: true,
        values: { apiKey: "legacy-secret", region: "eu" },
      })
    )
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("migrates declared secrets to encrypted storage and redacts renderer reads", () => {
    const manager = new PluginManager()
    manager._pluginsDir = dir
    manager.setEncryptionKey(Buffer.alloc(32, 9).toString("base64"))

    const disk = fs.readFileSync(path.join(dir, "demo", "config.json"), "utf8")
    expect(disk).toContain("enc:v1:")
    expect(disk).not.toContain("legacy-secret")
    expect(manager.getConfig("demo")).toEqual({
      apiKey: "legacy-secret",
      region: "eu",
    })
    expect(manager.getPublicConfig("demo")).toEqual({
      apiKey: { configured: true, storage: "encrypted" },
      region: "eu",
    })
    expect(manager.listPlugins()[0]?.config).toEqual({
      apiKey: { configured: true, storage: "encrypted" },
      region: "eu",
    })
  })

  it("accepts write-only set and clear patches", async () => {
    const manager = new PluginManager()
    manager._pluginsDir = dir
    manager.setEncryptionKey(Buffer.alloc(32, 3).toString("base64"))

    await manager.setConfig("demo", "apiKey", { set: "replacement-secret" })
    expect(manager.getConfig("demo").apiKey).toBe("replacement-secret")
    expect(
      fs.readFileSync(path.join(dir, "demo", "config.json"), "utf8")
    ).not.toContain("replacement-secret")

    await manager.setConfig("demo", "apiKey", { clear: true })
    expect(manager.getPublicConfig("demo").apiKey).toEqual({
      configured: false,
      storage: "encrypted",
    })
  })

  it("refuses to load or invoke a disabled plugin", async () => {
    fs.writeFileSync(
      path.join(dir, "demo", "config.json"),
      JSON.stringify({ enabled: false, values: {} })
    )
    fs.writeFileSync(
      path.join(dir, "demo", "index.cjs"),
      "module.exports = { ping() { return 'pong' } }"
    )
    const manager = new PluginManager()
    manager._pluginsDir = dir

    await expect(manager.loadPlugin("demo")).rejects.toThrow(/disabled/i)
    await expect(manager.sendToPlugin("demo", "ping")).rejects.toThrow(
      /disabled/i
    )
    expect(manager.plugins.has("demo")).toBe(false)
  })

  it("drains an active invocation before disabling and disposing its plugin", async () => {
    const manager = new PluginManager()
    manager._pluginsDir = dir
    const order: string[] = []
    let releaseInvocation!: () => void
    let markStarted!: () => void
    const invocationGate = new Promise<void>((resolve) => {
      releaseInvocation = resolve
    })
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    manager.plugins.set("demo", {
      manifest: { id: "demo" },
      module: {
        async run() {
          order.push("run:start")
          markStarted()
          await invocationGate
          order.push("run:end")
          return "done"
        },
        async dispose() {
          order.push("dispose")
        },
      },
      config: {},
      error: null,
      eventDisposer: null,
      entryPath: path.join(dir, "demo", "index.cjs"),
    })

    const invocation = manager.sendToPlugin("demo", "run")
    await started
    const disabling = manager.togglePlugin("demo", false)
    await Promise.resolve()
    expect(order).toEqual(["run:start"])

    releaseInvocation()
    await expect(invocation).resolves.toBe("done")
    await disabling
    expect(order).toEqual(["run:start", "run:end", "dispose"])
    expect(manager.plugins.has("demo")).toBe(false)
  })

  it("awaits object disposers and evicts the plugin entry from require.cache", async () => {
    fs.writeFileSync(
      path.join(dir, "demo", "index.cjs"),
      [
        "module.exports = {",
        "  onEvent() {",
        "    return { async dispose() { global.__betterc0dePluginDisposed = true } }",
        "  }",
        "}",
      ].join("\n")
    )
    const manager = new PluginManager()
    manager._pluginsDir = dir
    const entryPath = path.join(dir, "demo", "index.cjs")

    await manager.loadPlugin("demo")
    await manager.setupPluginEvents("demo", () => {})
    expect(requireCjs.cache[entryPath]).toBeDefined()
    await manager.unloadPlugin("demo")

    expect(
      (globalThis as { __betterc0dePluginDisposed?: boolean })
        .__betterc0dePluginDisposed
    ).toBe(true)
    expect(requireCjs.cache[entryPath]).toBeUndefined()
    delete (globalThis as { __betterc0dePluginDisposed?: boolean })
      .__betterc0dePluginDisposed
  })
})
