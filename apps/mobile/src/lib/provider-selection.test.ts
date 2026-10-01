import { describe, expect, it, vi } from "vitest"
import type { NineRouterConnectionView } from "@betterc0de/schema"
import type {
  ChatMessage,
  ChatThread,
  NineRouterProviderView,
  ProviderInstance,
} from "@/types/remote"
import { RemoteApiError } from "@/transport/live/http"
import { thinkingOptionsFor } from "./model-capabilities"
import {
  loadModelOptions,
  modelOptions,
  parseNineRouterView,
  preferredModel,
} from "./provider-selection"

const now = "2026-07-21T12:00:00.000Z"

const instances: ProviderInstance[] = [
  {
    instanceId: "codex-work",
    driver: "codex",
    displayName: "Codex Work",
    enabled: true,
    configured: true,
    installed: true,
    status: "ready",
    availability: "available",
    models: [
      { slug: "gpt-5.5", name: "GPT-5.5" },
      { slug: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    ],
  },
  {
    instanceId: "disabled",
    driver: "claude",
    enabled: false,
    configured: true,
    installed: true,
    status: "disabled",
    availability: "unavailable",
    models: [{ slug: "opus", name: "Opus" }],
  },
]

describe("provider selection", () => {
  it("starts with Claude CLI and falls back through the available CLIs before APIs", () => {
    const instance = (driver: string): ProviderInstance => ({
      instanceId: driver,
      driver,
      enabled: true,
      installed: true,
      configured: true,
      status: "ready",
      availability: "available",
      models: [{ slug: `${driver}-model`, name: driver }],
    })
    const catalog = [
      "anthropic",
      "openai",
      "grok_cli",
      "cursor",
      "codex",
      "claude",
      "claude-terminal",
    ].map(instance)
    expect(modelOptions(catalog).map((option) => option.providerKind)).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok_cli",
      "anthropic",
      "openai",
    ])
    const thread: ChatThread = {
      id: "new",
      title: "New",
      projectName: "Repo",
      projectPath: "/repo",
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    expect(
      preferredModel(thread, [], modelOptions(catalog))?.providerKind
    ).toBe("claude")
    for (const kind of [
      "claude",
      "codex",
      "cursor",
      "grok_cli",
      "anthropic",
      "openai",
    ]) {
      const options = modelOptions(catalog)
      expect(preferredModel(thread, [], options)?.providerKind).toBe(kind)
      catalog.find((entry) => entry.driver === kind)!.configured = false
    }
    expect(preferredModel(thread, [], modelOptions(catalog))).toBeNull()
  })

  it("only exposes dispatchable provider models", () => {
    expect(modelOptions(instances).map((option) => option.modelId)).toEqual([
      "gpt-5.5",
      "gpt-5.4-mini",
    ])
  })

  it("prefers the thread binding and its last-used model", () => {
    const thread: ChatThread = {
      id: "thread-1",
      title: "Test",
      projectName: "Repo",
      projectPath: "/repo",
      session: { providerKind: "codex", providerInstanceId: "codex-work" },
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "Done",
        modelId: "gpt-5.4-mini",
        createdAt: now,
      },
    ]
    expect(
      preferredModel(thread, messages, modelOptions(instances))?.modelId
    ).toBe("gpt-5.4-mini")
  })
})

/** A 9Router connection as the desktop lists it to a paired phone. */
function nineRouterConnection(
  id: string,
  name: string,
  overrides: Partial<NineRouterConnectionView> = {}
): NineRouterConnectionView {
  return {
    id,
    name,
    // Host addresses are removed for paired devices.
    baseUrl: "",
    dashboardUrl: "",
    enabled: true,
    tokenSaver: true,
    secret: { configured: true, storage: "encrypted" },
    customModels: ["my-team/model"],
    hiddenModels: ["cx/gpt-5.5"],
    status: {
      state: "online",
      message: null,
      version: "0.4.12",
      latestVersion: null,
      latencyMs: 14,
      modelCount: 4,
      checkedAt: 1_790_000_000_000,
    },
    models: [
      {
        slug: "fast-combo",
        name: "fast-combo",
        tier: "Combos",
        isCustom: false,
        hidden: false,
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "cc/claude-opus-5-5",
        name: "Claude Opus 5.5",
        tier: "Claude Code",
        context: "1M",
        isCustom: false,
        hidden: false,
        capabilities: {
          attachment: true,
          optionDescriptors: [
            {
              type: "select",
              id: "reasoningEffort",
              label: "Reasoning",
              options: [
                { id: "high", label: "High" },
                { id: "low", label: "Low" },
              ],
            },
          ],
        },
      },
      {
        slug: "cx/gpt-5.5",
        name: "GPT-5.5",
        tier: "Codex",
        isCustom: false,
        hidden: true,
      },
      {
        slug: "my-team/model",
        name: "my-team/model",
        tier: "Custom",
        isCustom: true,
        hidden: false,
      },
    ],
    ...overrides,
  }
}

function nineRouter(
  ...connections: NineRouterConnectionView[]
): NineRouterProviderView {
  return { enabled: true, connections }
}

describe("9Router models", () => {
  it("offers a lone connection's visible models as 9Router, after the hub instances", () => {
    const options = modelOptions(
      instances,
      nineRouter(nineRouterConnection("laptop", "Laptop"))
    )
    expect(options.map((option) => option.key)).toEqual([
      "codex-work:gpt-5.5",
      "codex-work:gpt-5.4-mini",
      "ninerouter:laptop:fast-combo",
      "ninerouter:laptop:cc/claude-opus-5-5",
      "ninerouter:laptop:my-team/model",
    ])
    expect(options[3]).toEqual({
      key: "ninerouter:laptop:cc/claude-opus-5-5",
      providerKind: "ninerouter",
      providerInstanceId: "ninerouter:laptop",
      providerLabel: "9Router",
      // 9Router's own id, prefix included: the desktop routes it verbatim.
      modelId: "cc/claude-opus-5-5",
      modelLabel: "Claude Opus 5.5",
      modelGroup: "Claude Code",
      capabilities: {
        attachment: true,
        optionDescriptors: [
          expect.objectContaining({ id: "reasoningEffort", type: "select" }),
        ],
      },
    })
    expect(options[4]).toMatchObject({
      modelId: "my-team/model",
      modelGroup: "Custom",
      capabilities: null,
    })
  })

  it("names each connection when there are several, and keeps them apart", () => {
    const options = modelOptions(
      [],
      nineRouter(
        nineRouterConnection("laptop", "Laptop"),
        nineRouterConnection("vps", "VPS"),
        nineRouterConnection("vps-2", "VPS")
      )
    )
    expect([...new Set(options.map((option) => option.providerLabel))]).toEqual(
      ["9Router · Laptop", "9Router · VPS (vps)", "9Router · VPS (vps-2)"]
    )
    expect([
      ...new Set(options.map((option) => option.providerInstanceId)),
    ]).toEqual(["ninerouter:laptop", "ninerouter:vps", "ninerouter:vps-2"])
    expect(new Set(options.map((option) => option.key)).size).toBe(
      options.length
    )
  })

  it("leaves out a disabled provider, disabled connections and connections that cannot send", () => {
    expect(
      modelOptions([], {
        enabled: false,
        connections: [nineRouterConnection("laptop", "Laptop")],
      })
    ).toEqual([])
    const unusable = (state: "offline" | "auth_required" | "error") =>
      nineRouterConnection(state, state, {
        status: {
          ...nineRouterConnection("x", "x").status,
          state,
          message: "9Router is not reachable",
        },
      })
    const options = modelOptions(
      [],
      nineRouter(
        nineRouterConnection("laptop", "Laptop", { enabled: false }),
        nineRouterConnection("vps", "VPS"),
        unusable("offline"),
        unusable("auth_required"),
        unusable("error")
      )
    )
    expect([
      ...new Set(options.map((option) => option.providerInstanceId)),
    ]).toEqual(["ninerouter:vps"])
    // Named among the enabled connections, as on the desktop.
    expect(options[0]?.providerLabel).toBe("9Router · VPS")
    expect(
      modelOptions(
        [],
        nineRouter(
          nineRouterConnection("new", "New", {
            status: {
              ...nineRouterConnection("x", "x").status,
              state: "unknown",
            },
          })
        )
      )
    ).toHaveLength(3)
    expect(modelOptions(instances, null)).toEqual(modelOptions(instances))
  })

  it("never offers a hidden model", () => {
    const options = modelOptions(
      [],
      nineRouter(nineRouterConnection("laptop", "Laptop"))
    )
    expect(options.map((option) => option.modelId)).not.toContain("cx/gpt-5.5")
  })

  it("gives 9Router models their reasoning levels", () => {
    const [combo, opus, custom] = modelOptions(
      [],
      nineRouter(nineRouterConnection("laptop", "Laptop"))
    )
    // The router reported no reasoning for the combo.
    expect(thinkingOptionsFor(combo!)).toEqual([])
    expect(thinkingOptionsFor(opus!).map((option) => option.label)).toEqual([
      "Router default",
      "Low",
      "High",
    ])
    // A custom id gets the generic ladder; 9Router clamps it.
    expect(thinkingOptionsFor(custom!).length).toBeGreaterThan(1)
  })

  it("restores a chat's 9Router model", () => {
    const thread: ChatThread = {
      id: "thread-9",
      title: "Routed",
      projectName: "Repo",
      projectPath: "/repo",
      session: {
        providerKind: "ninerouter",
        providerInstanceId: "ninerouter:vps",
      },
      messages: [],
      createdAt: now,
      updatedAt: now,
    }
    const messages: ChatMessage[] = [
      {
        id: "assistant-9",
        role: "assistant",
        content: "Done",
        modelId: "cc/claude-opus-5-5",
        createdAt: now,
      },
    ]
    const options = modelOptions(
      instances,
      nineRouter(
        nineRouterConnection("laptop", "Laptop"),
        nineRouterConnection("vps", "VPS")
      )
    )
    expect(preferredModel(thread, messages, options)).toMatchObject({
      key: "ninerouter:vps:cc/claude-opus-5-5",
      providerInstanceId: "ninerouter:vps",
      modelId: "cc/claude-opus-5-5",
    })
  })

  it("reads what the desktop sends defensively", () => {
    const good = nineRouterConnection("laptop", "Laptop")
    expect(parseNineRouterView(nineRouter(good))).toEqual(nineRouter(good))
    // One unreadable connection does not hide the others.
    expect(
      parseNineRouterView({
        enabled: true,
        connections: [{ id: "broken" }, good],
      })
    ).toEqual(nineRouter(good))
    for (const payload of [
      null,
      "nope",
      [],
      {},
      { enabled: true },
      { enabled: false, connections: [{ id: "broken" }] },
    ]) {
      expect(parseNineRouterView(payload)).toEqual({
        enabled: false,
        connections: [],
      })
    }
  })

  it("loads the hub instances and 9Router together", async () => {
    const listProviderInstances = vi.fn(async () => instances)
    const options = await loadModelOptions(
      {
        listProviderInstances,
        getNineRouter: async () =>
          nineRouter(nineRouterConnection("laptop", "Laptop")),
      },
      "/repo"
    )
    expect(listProviderInstances).toHaveBeenCalledWith("/repo")
    expect(options.map((option) => option.providerInstanceId)).toEqual([
      "codex-work",
      "codex-work",
      "ninerouter:laptop",
      "ninerouter:laptop",
      "ninerouter:laptop",
    ])
  })

  it("still offers the other providers when 9Router cannot be listed", async () => {
    for (const failure of [
      new RemoteApiError("Not found", 404),
      new RemoteApiError("Forbidden", 403),
      new RemoteApiError("The desktop did not answer in time.", 0, "timeout"),
    ]) {
      const options = await loadModelOptions({
        listProviderInstances: async () => instances,
        getNineRouter: async () => {
          throw failure
        },
      })
      expect(options.map((option) => option.modelId)).toEqual([
        "gpt-5.5",
        "gpt-5.4-mini",
      ])
    }
    // The provider list itself is still required.
    await expect(
      loadModelOptions({
        listProviderInstances: async () => {
          throw new RemoteApiError("Unauthorized", 401)
        },
        getNineRouter: async () => nineRouter(),
      })
    ).rejects.toThrow("Unauthorized")
  })
})
