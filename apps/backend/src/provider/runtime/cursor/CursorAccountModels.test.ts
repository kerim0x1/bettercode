import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CursorAcpAdapter } from "./CursorAcpAdapter"
import type {
  CursorAcpRuntime,
  CursorAcpSessionSetupResult,
} from "./CursorAcpRuntime"
import { cursorModelAccountIdentity } from "./CursorAccountModels"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function cacheDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-models-"))
  directories.push(directory)
  return directory
}

function testAdapter(input: {
  readonly directory: string
  readonly account: string | null
  readonly models?: ReadonlyArray<string>
  readonly customModels?: ReadonlyArray<string>
  readonly statusEnv?: NodeJS.ProcessEnv
  readonly fail?: boolean
}) {
  const start = vi.fn(async () => {
    if (input.fail) throw new Error("Cursor ACP unavailable")
    const configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select" as const,
        currentValue: input.models?.[0] ?? "",
        options: (input.models ?? []).map((value) => ({ value, name: value })),
      },
    ]
    return {
      sessionId: "probe",
      resumed: false,
      initializeResult: {},
      sessionSetupResult: {
        configOptions,
      } satisfies CursorAcpSessionSetupResult,
      configOptions,
      modelConfigId: "model",
    }
  })
  const close = vi.fn(async () => {})
  const adapter = new CursorAcpAdapter({
    binaryPath: "test-cursor",
    modelCacheDir: input.directory,
    modelAccountIdentity: input.account,
    statusEnv: input.statusEnv,
    customModels: input.customModels,
    runtimeFactory: () => ({ start, close }) as unknown as CursorAcpRuntime,
  })
  return { adapter, start, close }
}

describe("Cursor account model catalog", () => {
  it("persists only the current account's successful ACP models across restarts", async () => {
    const directory = cacheDir()
    const initial = testAdapter({
      directory,
      account: "account-a",
      models: ["auto", "new-model"],
    })
    expect(
      (await initial.adapter.availableModels()).map((model) => model.slug)
    ).toEqual(["auto", "new-model"])
    expect(initial.close).toHaveBeenCalledOnce()

    const offline = testAdapter({ directory, account: "account-a", fail: true })
    expect(
      (await offline.adapter.availableModels()).map((model) => model.slug)
    ).toEqual(["auto", "new-model"])
    const otherAccount = testAdapter({
      directory,
      account: "account-b",
      customModels: ["my-own-model"],
      fail: true,
    })
    expect(await otherAccount.adapter.availableModels()).toEqual([
      expect.objectContaining({ slug: "my-own-model", isCustom: true }),
    ])
  })

  it("refreshes the live list, including a successful withdrawal or empty list", async () => {
    const directory = cacheDir()
    const current = ["old-model"]
    const adapter = testAdapter({
      directory,
      account: "account-a",
      models: current,
    })
    expect(
      (await adapter.adapter.availableModels()).map((model) => model.slug)
    ).toEqual(["old-model"])
    current.splice(0, 1, "new-model")
    expect(
      (await adapter.adapter.availableModels()).map((model) => model.slug)
    ).toEqual(["old-model"])
    expect(
      (await adapter.adapter.availableModels({ force: true })).map(
        (model) => model.slug
      )
    ).toEqual(["new-model"])
    current.splice(0, 1)
    expect(await adapter.adapter.availableModels({ force: true })).toEqual([])
    const restarted = testAdapter({
      directory,
      account: "account-a",
      fail: true,
    })
    expect(await restarted.adapter.availableModels()).toEqual([])
  })

  it("invalidates an in-memory catalog when the configured Cursor key changes", async () => {
    const directory = cacheDir()
    const statusEnv: NodeJS.ProcessEnv = { CURSOR_API_KEY: "first-key" }
    const current = ["first-model"]
    const { adapter } = testAdapter({
      directory,
      account: null,
      statusEnv,
      models: current,
    })
    expect(
      (await adapter.availableModels()).map((model) => model.slug)
    ).toEqual(["first-model"])
    statusEnv.CURSOR_API_KEY = "second-key"
    current.splice(0, 1, "second-model")
    expect(
      (await adapter.availableModels()).map((model) => model.slug)
    ).toEqual(["second-model"])
    const firstAccountOffline = testAdapter({
      directory,
      account: null,
      statusEnv: { CURSOR_API_KEY: "first-key" },
      fail: true,
    })
    expect(
      (await firstAccountOffline.adapter.availableModels()).map(
        (model) => model.slug
      )
    ).toEqual(["first-model"])
  })

  it("namespaces API keys without storing the key in a snapshot", async () => {
    const one = await cursorModelAccountIdentity(
      { statusEnv: { CURSOR_API_KEY: "key-one" } },
      { force: false }
    )
    const two = await cursorModelAccountIdentity(
      { statusEnv: { CURSOR_API_KEY: "key-two" } },
      { force: false }
    )
    expect(one).toMatch(/^[a-f0-9]{64}$/)
    expect(two).not.toBe(one)
    expect(one).not.toContain("key-one")
  })
})
