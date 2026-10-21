import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createSettingsKeyIntake,
  createUnhandledRejectionPolicy,
  installSettingsMasterKey,
  isFatalRejection,
  isSettingsKeyMessage,
} from "./processGuards"
import { __resetMasterKeyCache, getMasterKey } from "./settings/crypto"

afterEach(() => {
  vi.useRealTimers()
  delete process.env.BETTERC0DE_SETTINGS_KEY
  __resetMasterKeyCache()
})

describe("settings key intake", () => {
  it("recognises only the settings-key message", () => {
    expect(isSettingsKeyMessage({ type: "settings-key", key: "" })).toBe(true)
    expect(isSettingsKeyMessage({ type: "settings-key" })).toBe(false)
    expect(isSettingsKeyMessage({ type: "shutdown" })).toBe(false)
    expect(isSettingsKeyMessage(null)).toBe(false)
  })

  it("keeps a key that arrives before startup asks for it", async () => {
    const intake = createSettingsKeyIntake()
    expect(intake.accept({ type: "settings-key", key: "early" })).toBe(true)
    expect(intake.accept({ type: "settings-key", key: "ignored" })).toBe(true)
    await expect(intake.wait({ timeoutMs: 10 })).resolves.toBe("early")
  })

  it("resolves a waiting startup when the key arrives", async () => {
    const intake = createSettingsKeyIntake()
    const pending = intake.wait({ timeoutMs: 1_000 })
    expect(intake.accept({ type: "shutdown" })).toBe(false)
    intake.accept({ type: "settings-key", key: "late" })
    await expect(pending).resolves.toBe("late")
  })

  it("fails startup when the host never sends the key", async () => {
    vi.useFakeTimers()
    const intake = createSettingsKeyIntake()
    const pending = intake.wait({ timeoutMs: 30_000 })
    const assertion = expect(pending).rejects.toThrow(
      /did not hand over the settings key within 30s/
    )
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })

  it("stops waiting when startup is cancelled", async () => {
    const intake = createSettingsKeyIntake()
    const controller = new AbortController()
    const pending = intake.wait({
      timeoutMs: 30_000,
      signal: controller.signal,
    })
    controller.abort(new Error("Backend startup cancelled by SIGTERM"))
    await expect(pending).rejects.toThrow(/cancelled by SIGTERM/)
  })

  it("installs the key without leaving it in the environment", () => {
    const key = Buffer.alloc(32, 9).toString("base64")
    expect(installSettingsMasterKey(key)).toBe(true)
    expect(process.env.BETTERC0DE_SETTINGS_KEY).toBeUndefined()
    expect(getMasterKey()?.equals(Buffer.alloc(32, 9))).toBe(true)
  })

  it("an empty key means plaintext fallback", () => {
    process.env.BETTERC0DE_SETTINGS_KEY = "stale"
    expect(installSettingsMasterKey("")).toBe(false)
    expect(process.env.BETTERC0DE_SETTINGS_KEY).toBeUndefined()
    expect(getMasterKey()).toBeNull()
  })
})

describe("unhandled rejection policy", () => {
  it("survives an ordinary rejection", () => {
    const policy = createUnhandledRejectionPolicy()
    expect(policy.classify(new Error("fetch failed"))).toEqual({
      fatal: false,
      recentCount: 1,
    })
  })

  it("treats storage corruption and memory exhaustion as fatal", () => {
    for (const code of [
      "SQLITE_CORRUPT",
      "SQLITE_IOERR_WRITE",
      "SQLITE_NOTADB",
      "SQLITE_FULL",
    ]) {
      expect(isFatalRejection(Object.assign(new Error(code), { code }))).toBe(
        true
      )
    }
    expect(
      isFatalRejection(new RangeError("Maximum call stack size exceeded"))
    ).toBe(true)
    expect(
      isFatalRejection(
        Object.assign(new Error("busy"), { code: "SQLITE_BUSY" })
      )
    ).toBe(false)
    expect(isFatalRejection("plain string")).toBe(false)
    const policy = createUnhandledRejectionPolicy()
    expect(
      policy.classify(
        Object.assign(new Error("db"), { code: "SQLITE_CORRUPT" })
      ).fatal
    ).toBe(true)
  })

  it("a storm of rejections within the window becomes fatal", () => {
    let now = 0
    const policy = createUnhandledRejectionPolicy({
      windowMs: 60_000,
      maxRejections: 3,
      now: () => now,
    })
    expect(policy.classify(new Error("1")).fatal).toBe(false)
    now += 30_000
    expect(policy.classify(new Error("2")).fatal).toBe(false)
    now += 40_000
    // The first rejection left the window.
    expect(policy.classify(new Error("3")).fatal).toBe(false)
    const verdict = policy.classify(new Error("4"))
    expect(verdict.fatal).toBe(true)
    expect(verdict.why).toMatch(/3 unhandled rejections within 60s/)
  })
})
