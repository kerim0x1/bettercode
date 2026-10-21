import { afterEach, describe, expect, it, vi } from "vitest"
import { getElectronApi, hasElectronApi } from "./ipc-facade"
import type { ElectronAPI } from "@/types/electron-api"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("desktop bridge accessor", () => {
  it("reports no bridge when there is no window", () => {
    vi.stubGlobal("window", undefined)
    expect(getElectronApi()).toBeUndefined()
    expect(hasElectronApi()).toBe(false)
  })

  it("reports no bridge outside the desktop shell", () => {
    vi.stubGlobal("window", {})
    expect(getElectronApi()).toBeUndefined()
    expect(hasElectronApi()).toBe(false)
  })

  it("reads the bridge at call time, so a later install is seen", () => {
    vi.stubGlobal("window", {})
    expect(hasElectronApi()).toBe(false)
    const bridge = { openPath: vi.fn() } as unknown as ElectronAPI
    vi.stubGlobal("window", { electronAPI: bridge })
    expect(getElectronApi()).toBe(bridge)
    expect(hasElectronApi()).toBe(true)
  })
})
