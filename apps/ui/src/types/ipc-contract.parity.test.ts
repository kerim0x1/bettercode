/// <reference types="node" />
/**
 * The IPC channel registry (`apps/shell/shared/ipc-contract.cjs`) is the one
 * source of truth for the bridge. These checks hold the two sides to it: the
 * preload exposes a method for every channel and event, and the main process
 * registers every channel exactly once. (A TypeScript twin of the registry
 * used to be kept in sync by a parity test; nothing imported it, so it was
 * removed.)
 */
import { describe, it, expect, vi } from "vitest"
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as path from "node:path"
import { runInNewContext } from "node:vm"

const requireCjs = createRequire(import.meta.url)
const { IpcChannel, IpcEvent } = requireCjs(
  "../../../shell/shared/ipc-contract.cjs"
) as {
  IpcChannel: Record<string, string>
  IpcEvent: Record<string, string>
}

describe("IPC contract registry", () => {
  it("has unique channel and event names", () => {
    const channels = Object.values(IpcChannel)
    expect(new Set(channels).size).toBe(channels.length)
    const events = Object.values(IpcEvent)
    expect(new Set(events).size).toBe(events.length)
  })

  it("executes every preload method against the channel registry and removes only its own listeners", async () => {
    const invoked = new Set<string>()
    const subscribed = new Set<string>()
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    let api: Record<string, unknown> = {}
    runInNewContext(
      fs.readFileSync(
        path.resolve(__dirname, "../../../shell/preload.cjs"),
        "utf8"
      ),
      {
        process: { platform: "win32" },
        navigator: { userActivation: { isActive: true } },
        require: (name: string) => {
          if (name !== "electron")
            throw new Error(`Unexpected preload dependency ${name}`)
          return {
            contextBridge: {
              exposeInMainWorld: (
                name: string,
                value: Record<string, unknown>
              ) => {
                expect(name).toBe("electronAPI")
                api = value
              },
            },
            ipcRenderer: {
              invoke: async (channel: string) => {
                invoked.add(channel)
              },
              on: (channel: string, listener: (...args: unknown[]) => void) => {
                subscribed.add(channel)
                const entries = listeners.get(channel) ?? new Set()
                entries.add(listener)
                listeners.set(channel, entries)
              },
              removeListener: (
                channel: string,
                listener: (...args: unknown[]) => void
              ) => listeners.get(channel)?.delete(listener),
            },
          }
        },
      }
    )
    for (const [name, method] of Object.entries(api)) {
      if (typeof method !== "function") continue
      const callback = vi.fn()
      const result: unknown = await method(callback)
      if (typeof result === "function") {
        const second: unknown = await method(() => undefined)
        const payload = { value: name }
        for (const entries of listeners.values())
          for (const listener of entries) listener({}, payload)
        expect(callback).toHaveBeenCalledWith(payload)
        result()
        expect(
          [...listeners.values()].reduce(
            (count, entries) => count + entries.size,
            0
          )
        ).toBe(1)
        if (typeof second !== "function")
          throw new Error(`Missing unsubscribe for ${name}`)
        second()
      }
    }
    expect([...invoked].sort()).toEqual(Object.values(IpcChannel).sort())
    expect([...subscribed].sort()).toEqual(Object.values(IpcEvent).sort())
    expect([...listeners.values()].every((entries) => entries.size === 0)).toBe(
      true
    )
  })

  it("registers every channel exactly once through the real main/module registration functions", async () => {
    const registered = new Map<string, unknown>()
    const electron = {
      ipcMain: {
        handle: (channel: string, handler: unknown) => {
          expect(registered.has(channel), `duplicate handler: ${channel}`).toBe(
            false
          )
          expect(typeof handler).toBe("function")
          registered.set(channel, handler)
        },
      },
      app: {
        requestSingleInstanceLock: () => true,
        on: vi.fn(),
        whenReady: () => new Promise(() => {}),
        getPath: () => "/test/user",
        commandLine: { appendSwitch: vi.fn() },
      },
      crashReporter: { start: vi.fn() },
      protocol: { registerSchemesAsPrivileged: vi.fn() },
    }
    const modules = new Map<string, { exports: Record<string, unknown> }>()
    const shellDir = path.resolve(__dirname, "../../../shell")
    const registrations = {
      "plugin-ipc.cjs": "registerPluginHandlers",
      "cli-plugins-ipc.cjs": "registerCliPluginHandlers",
      "onboarding-ipc.cjs": "registerOnboardingHandlers",
      "mcp-ipc.cjs": "registerMcpHandlers",
      "skills-ipc.cjs": "registerSkillsHandlers",
      "hooks-ipc.cjs": "registerHooksHandlers",
      "subagents-ipc.cjs": "registerSubagentsHandlers",
      "provider-ipc.cjs": "registerProviderHandlers",
    }
    const executable = new Set([
      "main.cjs",
      // main.cjs registers the app-level handlers through it at load.
      "shared/app-ipc.cjs",
      ...Object.keys(registrations),
      "shared/ipc-contract.cjs",
      "shared/ipc-envelope.cjs",
      "shared/ipc-handlers-factory.cjs",
      // Every registration goes through it, so it must run for real.
      "shared/trusted-ipc.cjs",
      "shared/backend-endpoint.cjs",
    ])
    function load(relative: string): Record<string, unknown> {
      const cached = modules.get(relative)
      if (cached) return cached.exports
      const module = { exports: {} as Record<string, unknown> }
      modules.set(relative, module)
      const filename = path.join(shellDir, relative)
      runInNewContext(
        fs.readFileSync(filename, "utf8"),
        {
          module,
          exports: module.exports,
          __dirname: path.dirname(filename),
          console,
          process: {
            platform: "win32",
            env: {},
            on: vi.fn(),
            resourcesPath: "/test/resources",
            argv: [],
            versions: {},
          },
          require: (name: string) => {
            if (name === "electron") return electron
            if (name === "path" || name === "node:path") return path
            const resolved = path
              .relative(shellDir, path.resolve(path.dirname(filename), name))
              .replaceAll("\\", "/")
            if (executable.has(resolved)) return load(resolved)
            if (resolved === "plugin-manager.cjs")
              return {
                PluginManager: class {
                  plugins = new Map()
                  async loadAllEnabled() {}
                },
              }
            // Registration must not perform I/O; handlers' dependencies are inert.
            return {}
          },
        },
        { filename }
      )
      return module.exports
    }
    load("main.cjs")
    for (const [file, name] of Object.entries(registrations)) {
      const register = load(file)[name]
      if (typeof register !== "function")
        throw new Error(`Missing registration export ${name}`)
      await register()
    }
    expect([...registered.keys()].sort()).toEqual(
      Object.values(IpcChannel).sort()
    )
  })
})
