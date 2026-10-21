import { describe, expect, it, vi } from "vitest"
import { ProviderHub } from "./ProviderHub"
import type { ProviderSessionBindingStore } from "./ProviderSessionBindingStore"
import { threadId } from "./contracts"
import { makeTestProviderAdapterHarness } from "./testUtils/TestProviderAdapterHarness"

describe("provider snapshot secrets", () => {
  it("redacts nested config and inferred environment secrets without changing runtime values", async () => {
    const { adapter } = makeTestProviderAdapterHarness({ configured: false })
    const config = {
      serverUrl: "https://example.test",
      oauth: {
        clientSecret: "nested-client-secret",
        access_token: "nested-token",
        label: "account",
      },
      transports: [{ privateKey: "nested-private-key", timeout: 1000 }],
      authorization: "header-secret",
      apiKey: "top-level-secret",
    }
    const environment = [
      { name: "OPENAI_API_KEY", value: "environment-secret", sensitive: false },
      { name: "LOG_LEVEL", value: "debug", sensitive: false },
    ]
    const originalConfig = structuredClone(config)
    const originalEnvironment = structuredClone(environment)
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "snapshot",
          driver: "codex",
          provider: "codex",
          enabled: true,
          config,
          environment,
          adapter,
        },
      ],
    })
    try {
      const [snapshot] = await hub.listInstances()
      const secret = {
        configured: true,
        storage: expect.stringMatching(/^(encrypted|plaintext)$/),
      }
      expect(snapshot?.config).toEqual({
        serverUrl: "https://example.test",
        oauth: { clientSecret: secret, access_token: secret, label: "account" },
        transports: [{ privateKey: secret, timeout: 1000 }],
        authorization: secret,
        apiKey: secret,
      })
      expect(snapshot?.environment).toEqual([
        expect.objectContaining({
          name: "OPENAI_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
          secretState: secret,
        }),
        environment[1],
      ])
      expect(config).toEqual(originalConfig)
      expect(environment).toEqual(originalEnvironment)
    } finally {
      await hub.stopAll()
    }
  })
})

describe("provider shutdown persistence failure", () => {
  it("still stops adapters and unsubscribes when saving active sessions fails", async () => {
    const { adapter } = makeTestProviderAdapterHarness()
    await adapter.startSession({ threadId: threadId("shutdown") })
    const stopAll = vi.spyOn(adapter, "stopAll")
    const unsubscribe = vi.fn()
    vi.spyOn(adapter, "subscribe").mockReturnValue(unsubscribe)
    const hub = new ProviderHub({ adapters: [adapter] })
    const failure = new Error("database unavailable")
    const bindings = {
      get: () => null,
      list: () => [],
      upsert: () => {
        throw failure
      },
    } as unknown as ProviderSessionBindingStore
    await expect(hub.stopAll(bindings)).rejects.toBeInstanceOf(AggregateError)
    expect(stopAll).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(await adapter.listSessions?.()).toEqual([])
  })
})

describe("qualified model policy admission", () => {
  it("rejects a BetterC0de upstream model that the catalog filters out", async () => {
    const { adapter } = makeTestProviderAdapterHarness({
      provider: "betterc0de",
    })
    vi.spyOn(adapter, "availableModels").mockResolvedValue([
      {
        slug: "openai/gpt-blocked",
        name: "Blocked",
        catalog: { providerId: "openai", modelId: "gpt-blocked" },
      },
      {
        slug: "openai/gpt-allowed",
        name: "Allowed",
        catalog: { providerId: "openai", modelId: "gpt-allowed" },
      },
    ])
    const sendTurn = vi.spyOn(adapter, "sendTurn")
    const hub = new ProviderHub({
      instances: [
        {
          instanceId: "betterc0de-main",
          driver: "betterc0de",
          provider: "betterc0de",
          enabled: true,
          adapter,
        },
      ],
      projectProviderPolicyLoader: async () => ({
        enabledProviders: [],
        disabledProviders: [],
        providers: [
          {
            id: "openai",
            whitelist: ["gpt-allowed"],
            blacklist: ["gpt-blocked"],
          },
        ],
      }),
    })
    try {
      expect(
        (await hub.modelsForInstance("betterc0de-main", { cwd: "/repo" })).map(
          (model) => model.slug
        )
      ).toEqual(["openai/gpt-allowed"])
      await expect(
        hub.sendTurn("betterc0de", {
          threadId: "qualified-policy",
          message: "hello",
          modelId: "openai/gpt-blocked",
          projectPath: "/repo",
          history: [],
        })
      ).rejects.toThrow(/model 'openai\/gpt-blocked' is disabled/i)
      expect(sendTurn).not.toHaveBeenCalled()
    } finally {
      await hub.stopAll()
    }
  })
})

describe("native permission alias admission", () => {
  it.each([
    ["full", "auto-accept-edits"],
    ["allow-edits", "auto-accept-edits"],
    // `full-access` is the old "Full Access" label for allow-edits; only an
    // explicit `bypass` reaches the full-access runtime mode.
    ["bypass", "full-access"],
    ["full-access", "auto-accept-edits"],
  ])(
    "maps permission %s to runtime %s without widening it",
    async (permissionLevel, runtimeMode) => {
      const harness = makeTestProviderAdapterHarness()
      harness.queueTurnResponseForNextSession({
        events: [
          { type: "turn.completed", turnId: "turn-alias", status: "completed" },
        ],
      })
      const startSession = vi.spyOn(harness.adapter, "startSession")
      const hub = new ProviderHub({ adapters: [harness.adapter] })
      try {
        await hub.sendTurn("codex", {
          threadId: "alias-admission",
          message: "hello",
          modelId: "test",
          history: [],
          permissionLevel,
        })
        expect(startSession).toHaveBeenCalledWith(
          expect.objectContaining({ runtimeMode })
        )
      } finally {
        await hub.stopAll()
      }
    }
  )
})
