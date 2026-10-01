import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiKeyPool, classifyApiKeyFailure } from "./apiKeyPool"
import { SettingsService } from "../settings/service"
import { __resetMasterKeyCache } from "../settings/crypto"

const directories: string[] = []
beforeEach(() => {
  vi.stubEnv("BETTERC0DE_SETTINGS_KEY", Buffer.alloc(32, 15).toString("base64"))
  __resetMasterKeyCache()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  __resetMasterKeyCache()
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-key-pool-")
  )
  directories.push(directory)
  const file = path.join(directory, "settings.json")
  const settings = new SettingsService(file)
  return { file, settings, pool: new ApiKeyPool(settings) }
}

describe("API key persistence and migration", () => {
  it("encrypts every key, redacts responses, and keeps keys through public settings round trips and reordering", () => {
    const { settings, pool, file } = fixture()
    pool.add("openai", "Primary", "synthetic-primary-secret")
    const view = pool.add("openai", "Backup", "synthetic-backup-secret")
    const publicSettings = settings.getPublic()
    for (const secret of [
      "synthetic-primary-secret",
      "synthetic-backup-secret",
    ]) {
      expect(fs.readFileSync(file, "utf8")).not.toContain(secret)
      expect(JSON.stringify(publicSettings)).not.toContain(secret)
      expect(JSON.stringify(view)).not.toContain(secret)
    }
    settings.updatePublic({ providers: publicSettings.providers })
    pool.reorder("openai", view.keys.map((key) => key.id).reverse())
    const reopened = new SettingsService(file)
    expect(
      reopened.get().providers.openai.api_keys?.map((key) => key.api_key)
    ).toEqual(["synthetic-backup-secret", "synthetic-primary-secret"])
    expect(
      pool
        .view("openai")
        .keys.every((key) => key.secret.storage === "encrypted")
    ).toBe(true)
  })
  it("preserves a stored single key as the first key on the initial pool mutation", () => {
    const { settings, pool } = fixture()
    settings.update({
      providers: { anthropic: { api_key: { set: "synthetic-old" } } },
    })
    pool.add("anthropic", "Backup", "synthetic-new")
    expect(pool.credentials("anthropic").map((key) => key.key)).toEqual([
      "synthetic-old",
      "synthetic-new",
    ])
    expect(settings.get().providers.anthropic.api_key).toBe("")
  })
  it("honors disabled and empty managed pools without falling back to environment credentials", () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-environment")
    const { pool } = fixture()
    expect(pool.view("openai").keys[0].source).toBe("environment")
    const view = pool.add("openai", "Saved", "synthetic-saved")
    const id = view.keys[0].id
    pool.update("openai", id, { enabled: false })
    expect(pool.isReady("openai")).toBe(false)
    pool.remove("openai", id)
    expect(pool.credentials("openai")).toEqual([])
    pool.useExternal("openai")
    expect(pool.credentials("openai")[0].source).toBe("environment")
    expect(pool.credentials("openai")[0].key).toBe("synthetic-environment")
  })
  it("rejects duplicate secrets, malformed order, unknown IDs, destination changes and unsupported pools", () => {
    const { pool, settings } = fixture()
    const view = pool.add("grok", "Primary", "synthetic-xai")
    expect(() => pool.add("grok", "Duplicate", "synthetic-xai")).toThrow(
      "already stored"
    )
    expect(() => pool.reorder("grok", [])).toThrow("exactly once")
    expect(() => pool.requireKey("grok", "missing")).toThrow("not found")
    expect(() =>
      settings.update({
        providers: { grok: { base_url: "https://example.test" } },
      })
    ).toThrow("destination")
    expect(() =>
      settings.update({ providers: { openrouter: { api_keys: [] } } })
    ).toThrow("supported")
    expect(() =>
      settings.update({
        providers: { grok: { api_keys: [view.keys[0], view.keys[0]] } },
      })
    ).toThrow()
  })
})

describe("API key recovery", () => {
  it.each([401, 402, 429, 500, 529])(
    "tries an enabled backup for HTTP %s and remembers the failed key",
    async (status) => {
      const { pool } = fixture()
      pool.add("openai", "Primary", "synthetic-primary")
      pool.add("openai", "Backup", "synthetic-backup")
      const call = vi.fn(async (key) => {
        if (key.key === "synthetic-primary")
          throw { status, message: "synthetic-primary" }
        return "answer"
      })
      expect(await pool.snapshot("openai").run(call)).toBe("answer")
      expect(call).toHaveBeenCalledTimes(2)
      expect(pool.view("openai").keys[0].status).not.toBe("untested")
      expect(JSON.stringify(pool.view("openai"))).not.toContain(
        "synthetic-primary"
      )
      call.mockClear()
      await pool.snapshot("openai").run(call)
      expect(call).toHaveBeenCalledTimes(1)
    }
  )
  it("does not rotate on request/policy errors or after any response starts", async () => {
    const { pool } = fixture()
    pool.add("anthropic", "Primary", "synthetic-primary")
    pool.add("anthropic", "Backup", "synthetic-backup")
    for (const status of [400, 403, 404]) {
      const call = vi.fn(async () => {
        throw { status }
      })
      await expect(pool.snapshot("anthropic").run(call)).rejects.toThrow()
      expect(call).toHaveBeenCalledTimes(1)
    }
    const call = vi.fn(async (_key, started) => {
      started()
      throw { status: 503 }
    })
    await expect(pool.snapshot("anthropic").run(call)).rejects.toThrow(
      "Temporary"
    )
    expect(call).toHaveBeenCalledTimes(1)
  })
  it("respects Retry-After, including manual checks, and restores eligibility after the delay", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { pool } = fixture()
    const view = pool.add("grok", "Key", "synthetic-key")
    await expect(
      pool.snapshot("grok").run(async () => {
        throw { status: 429, headers: new Headers({ "retry-after": "120" }) }
      })
    ).rejects.toThrow()
    expect(pool.view("grok").keys[0].retryAt).toBe(1_120_000)
    expect(() => pool.reset("grok", view.keys[0].id)).toThrow("retry delay")
    expect(pool.isReady("grok")).toBe(false)
    vi.advanceTimersByTime(120_000)
    expect(pool.isReady("grok")).toBe(true)
  })
  it("keeps turn credentials stable and ignores late status from replaced keys", async () => {
    const { pool } = fixture()
    const view = pool.add("openai", "Key", "synthetic-old")
    const session = pool.snapshot("openai")
    pool.update("openai", view.keys[0].id, { apiKey: "synthetic-new" })
    await expect(
      session.run(async (key) => {
        expect(key.key).toBe("synthetic-old")
        throw { status: 401 }
      })
    ).rejects.toThrow()
    expect(pool.view("openai").keys[0].status).toBe("untested")
    expect(pool.credentials("openai")[0].key).toBe("synthetic-new")
  })
  it("never tries another key after interruption", async () => {
    const { pool } = fixture()
    pool.add("openai", "Primary", "synthetic-primary")
    pool.add("openai", "Backup", "synthetic-backup")
    const controller = new AbortController()
    const call = vi.fn(async () => {
      controller.abort()
      throw { status: 503 }
    })
    await expect(
      pool.snapshot("openai").run(call, controller.signal)
    ).rejects.toThrow()
    expect(call).toHaveBeenCalledTimes(1)
    expect(pool.view("openai").keys[0].status).toBe("untested")
  })
  it("does not let an older success erase a newer authentication failure", async () => {
    const { pool } = fixture()
    pool.add("openai", "Key", "synthetic-primary")
    let finish: (() => void) | undefined
    const pending = pool.snapshot("openai").run(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    await expect(
      pool.snapshot("openai").run(async () => {
        throw { status: 401 }
      })
    ).rejects.toThrow()
    finish!()
    await pending
    expect(pool.view("openai").keys[0].status).toBe("invalid")
  })
  it("bounds attempts to one per credential and exposes no provider error or key", async () => {
    const { pool } = fixture()
    pool.add("openai", "Primary", "synthetic-primary")
    pool.add("openai", "Backup", "synthetic-backup")
    const call = vi.fn(async () => {
      throw { status: 401, message: "Authorization: synthetic-primary" }
    })
    try {
      await pool.snapshot("openai").run(call)
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-primary")
    }
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe("provider error classification", () => {
  it.each([
    "credit_balance_exhausted",
    "insufficient_quota",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
  ])("distinguishes %s from temporary rate limits", (code) => {
    expect(classifyApiKeyFailure({ status: 429, error: { code } }).kind).toBe(
      "quota"
    )
  })
  it("recognizes Anthropic spend limits and xAI incorrect-key errors without rotating restricted access", () => {
    expect(
      classifyApiKeyFailure({
        status: 400,
        error: { message: "Your credit balance is too low" },
      }).kind
    ).toBe("quota")
    expect(
      classifyApiKeyFailure({
        status: 400,
        error: { message: "Incorrect API key provided" },
      }).kind
    ).toBe("invalid")
    expect(
      classifyApiKeyFailure({
        status: 401,
        error: { message: "IP not authorized" },
      }).kind
    ).toBe("request")
    expect(
      classifyApiKeyFailure({ error: { type: "overloaded_error" } }).kind
    ).toBe("cooldown")
    expect(
      classifyApiKeyFailure(new DOMException("deadline", "TimeoutError")).kind
    ).toBe("cooldown")
  })
})
