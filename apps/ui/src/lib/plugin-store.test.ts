import { beforeEach, describe, expect, it, vi } from "vitest"

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock("sonner", () => ({ toast }))
const bridge = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}))
vi.mock("@/services/ipc-facade", () => ({
  getElectronApi: () => bridge.current,
}))

import {
  isCancelledPluginInstall,
  pluginEnvelopeError,
  usePluginStore,
} from "./plugin-store"

beforeEach(() => {
  toast.error.mockReset()
  toast.success.mockReset()
  usePluginStore.setState({ plugins: [], loaded: false })
})

describe("plugin IPC envelopes", () => {
  it("reads the reason of a failed call", () => {
    expect(pluginEnvelopeError({ ok: false, error: " Bad manifest " })).toBe(
      "Bad manifest"
    )
    expect(pluginEnvelopeError({ ok: false })).toBe("Unknown error")
    expect(pluginEnvelopeError({ ok: true })).toBeNull()
    expect(pluginEnvelopeError(undefined)).toBeNull()
  })

  it("treats a closed picker or a cancelled confirmation as no failure", () => {
    expect(isCancelledPluginInstall({ ok: false })).toBe(true)
    expect(
      isCancelledPluginInstall({ ok: false, error: "User cancelled" })
    ).toBe(true)
    expect(isCancelledPluginInstall({ ok: false, error: "Bad manifest" })).toBe(
      false
    )
    expect(isCancelledPluginInstall({ ok: true })).toBe(false)
  })
})

describe("plugin actions report failures", () => {
  it("shows why an install failed, and nothing when it was cancelled", async () => {
    bridge.current = {
      pluginList: vi.fn(async () => []),
      pluginInstall: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: "manifest.json is missing" })
        .mockResolvedValueOnce({ ok: false }),
    }
    await expect(usePluginStore.getState().installPlugin()).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledWith("Couldn't install the plugin", {
      description: "manifest.json is missing",
    })
    toast.error.mockReset()
    await expect(usePluginStore.getState().installPlugin()).resolves.toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("reports a toggle the desktop refused and reloads the list", async () => {
    const pluginList = vi.fn(async () => [])
    bridge.current = {
      pluginList,
      pluginToggle: vi.fn(async () => ({
        ok: false,
        error: "Activation failed",
      })),
    }
    await expect(
      usePluginStore.getState().togglePlugin("demo", true)
    ).resolves.toBe(false)
    expect(toast.error).toHaveBeenCalledWith("Couldn't turn on demo", {
      description: "Activation failed",
    })
    expect(pluginList).toHaveBeenCalled()
  })

  it("reports a removal that threw", async () => {
    bridge.current = {
      pluginList: vi.fn(async () => []),
      pluginRemove: vi.fn(async () => {
        throw new Error("Plugin is busy")
      }),
    }
    await expect(usePluginStore.getState().removePlugin("demo")).resolves.toBe(
      false
    )
    expect(toast.error).toHaveBeenCalledWith("Couldn't remove demo", {
      description: "Plugin is busy",
    })
  })
})
