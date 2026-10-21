import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const rulesIpc = vi.hoisted(() => ({
  save: vi.fn(),
}))

vi.mock("@/services/ipc-facade", () => ({
  ipcApi: {
    rules: rulesIpc,
  },
  // The bridge the tests stub on `window`, read at call time like the real one.
  getElectronApi: () => window.electronAPI,
}))
vi.mock("@/lib/provider-metadata-events", () => ({
  dispatchProviderMetadataChanged: vi.fn(),
}))
const coreApi = vi.hoisted(() => ({ getUserRules: vi.fn() }))
vi.mock("@/services/backend/coreApi", () => coreApi)

import { HttpError } from "@/lib/errors"
import {
  canEditCustomRules,
  customRulesDescription,
  getCustomRules,
  listRuntimeHooks,
  readCustomRules,
  saveCustomRules,
} from "./runtime-config"

describe("the user's rules (rules.md, owned by the backend)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rulesIpc.save.mockResolvedValue(undefined)
    vi.stubGlobal("window", {
      electronAPI: {
        rulesGet: vi.fn().mockResolvedValue({ content: "desktop rules" }),
        rulesSave: vi.fn(),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads rules.md through the desktop process", async () => {
    await expect(getCustomRules()).resolves.toBe("desktop rules")
    expect(window.electronAPI?.rulesGet).toHaveBeenCalledTimes(1)
    expect(coreApi.getUserRules).not.toHaveBeenCalled()
    expect(canEditCustomRules()).toBe(true)
  })

  it("reads no rules when the desktop process cannot answer", async () => {
    vi.mocked(window.electronAPI!.rulesGet).mockRejectedValue(
      new Error("Backend is not ready.")
    )
    await expect(getCustomRules()).resolves.toBe("")
  })

  it("saves through the desktop process only", async () => {
    await saveCustomRules("new rules")
    expect(rulesIpc.save).toHaveBeenCalledWith("new rules")
  })

  it("shows a paired browser the rules from the backend, but saves only on the desktop", async () => {
    vi.stubGlobal("window", { electronAPI: undefined })
    coreApi.getUserRules.mockResolvedValue({ content: "backend rules" })
    await expect(readCustomRules()).resolves.toEqual({
      content: "backend rules",
      unavailable: null,
    })
    expect(canEditCustomRules()).toBe(false)
    await expect(saveCustomRules("remote rules")).rejects.toThrow(/desktop app/)
    expect(rulesIpc.save).not.toHaveBeenCalled()
  })

  it("says why a paired browser has no rules to show", async () => {
    vi.stubGlobal("window", { electronAPI: undefined })
    coreApi.getUserRules.mockRejectedValue(
      new HttpError(
        "remote session is restricted to read-only monitoring",
        403,
        "/settings/rules",
        { code: "remote_read_only" }
      )
    )
    await expect(readCustomRules()).resolves.toEqual({
      content: "",
      unavailable: "read-only-session",
    })
    coreApi.getUserRules.mockRejectedValue(new Error("Backend is offline."))
    await expect(readCustomRules()).resolves.toEqual({
      content: "",
      unavailable: "unreadable",
    })
    await expect(getCustomRules()).resolves.toBe("")
  })

  it("tells a paired browser its rules are read-only, or why it has none", () => {
    expect(customRulesDescription(true, null)).toMatch(/^Define global/)
    expect(customRulesDescription(false, null)).toMatch(/read-only/)
    expect(customRulesDescription(false, "read-only-session")).toMatch(
      /paired read-only/
    )
    expect(customRulesDescription(false, "unreadable")).toMatch(
      /could not be loaded/
    )
  })
})

describe("hook approval state", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps the desktop's approved flag, and omits it when not reported", async () => {
    const hook = { event: "on_commit", command: "npm test", enabled: true }
    vi.stubGlobal("window", {
      electronAPI: {
        hookList: vi.fn().mockResolvedValue([
          { ...hook, id: "approved", approved: true },
          { ...hook, id: "unapproved", approved: false },
          { ...hook, id: "older-desktop" },
        ]),
      },
    })
    const hooks = await listRuntimeHooks()
    expect(hooks.map((entry) => [entry.id, entry.approved])).toEqual([
      ["approved", true],
      ["unapproved", false],
      ["older-desktop", undefined],
    ])
    expect("approved" in hooks[2]!).toBe(false)
  })
})
