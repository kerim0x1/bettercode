import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetDesktopRuntimeConfigForTests,
  initDesktopRuntimeConfig,
} from "./desktop-runtime-config"

type Listener = (event: unknown) => void

function desktopApi(config: unknown) {
  const listeners: Listener[] = []
  const calls: string[] = []
  const api = {
    onBackendStatus: vi.fn((listener: Listener) => {
      calls.push("subscribe")
      listeners.push(listener)
      return () => {}
    }),
    getRuntimeConfig: vi.fn(async () => {
      calls.push("get")
      return config
    }),
  }
  return {
    api,
    calls,
    emit: (event: unknown) => listeners.forEach((listener) => listener(event)),
  }
}

beforeEach(() => {
  __resetDesktopRuntimeConfigForTests()
  vi.stubGlobal("window", {})
})

describe("desktop runtime config", () => {
  it("subscribes to backend status before asking for the config", async () => {
    const shell = desktopApi({
      port: 3773,
      mode: "local_sidecar",
      electronPath: "C:/app/apps/shell",
      previewPartition: "betterc0de-preview",
    })
    window.electronAPI = shell.api as unknown as NonNullable<
      Window["electronAPI"]
    >
    await initDesktopRuntimeConfig()
    expect(shell.calls).toEqual(["subscribe", "get"])
    expect(window.__BETTERC0DE__).toEqual({
      port: 3773,
      mode: "local_sidecar",
      electronPath: "C:/app/apps/shell",
      previewPartition: "betterc0de-preview",
    })
  })

  it("publishes the port from a later ready event and keeps the other fields", async () => {
    const shell = desktopApi({
      port: 0,
      mode: "local_sidecar",
      previewPartition: "betterc0de-preview",
    })
    window.electronAPI = shell.api as unknown as NonNullable<
      Window["electronAPI"]
    >
    await initDesktopRuntimeConfig()
    expect(window.__BETTERC0DE__?.port).toBe(0)
    shell.emit({ status: "restarting" })
    shell.emit({ status: "ready", port: 4774 })
    expect(window.__BETTERC0DE__).toMatchObject({
      port: 4774,
      previewPartition: "betterc0de-preview",
    })
  })

  it("leaves backend-served remote pages and plain browsers alone", async () => {
    window.__BETTERC0DE__ = {
      port: 4773,
      mode: "remote_http",
      baseUrl: "https://remote.example",
    }
    const shell = desktopApi({ port: 3773, mode: "local_sidecar" })
    window.electronAPI = shell.api as unknown as NonNullable<
      Window["electronAPI"]
    >
    await initDesktopRuntimeConfig()
    expect(shell.api.getRuntimeConfig).not.toHaveBeenCalled()
    expect(window.__BETTERC0DE__?.mode).toBe("remote_http")

    __resetDesktopRuntimeConfigForTests()
    vi.stubGlobal("window", {})
    await expect(initDesktopRuntimeConfig()).resolves.toBeUndefined()
    expect(window.__BETTERC0DE__).toBeUndefined()
  })

  it("survives a failing IPC call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    window.electronAPI = {
      onBackendStatus: () => () => {},
      getRuntimeConfig: () => Promise.reject(new Error("no handler")),
    } as unknown as NonNullable<Window["electronAPI"]>
    await expect(initDesktopRuntimeConfig()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
