import { beforeEach, describe, expect, it, vi } from "vitest"

const createMock = vi.fn()
const sdkOptions = vi.hoisted(() => vi.fn())
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } }
    constructor(opts: unknown) {
      sdkOptions(opts)
    }
  },
}))
vi.mock("../../services/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/workspace")>()),
  getProjectToolOutputLimits: vi.fn(async () => ({
    maxLines: 2000,
    maxBytes: 50_000,
  })),
}))

import { makeNineRouterAdapter } from "../adapters/factories"
import { mapCompatReasoningEffort } from "../adapters/openaiCompat"
import { defaultSettings, type Settings } from "../../settings/schema"
import type { ProviderSendTurnInput } from "../types"

function stream(chunks: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

const textTurn = (text: string) => [
  { choices: [{ delta: { reasoning_content: "thinking…" } }] },
  { choices: [{ delta: { content: text }, finish_reason: "stop" }] },
]

function settingsWith(
  connections: Array<Record<string, unknown>>,
  enabled = true
): Settings {
  const settings = defaultSettings()
  ;(settings.providers as Record<string, unknown>).ninerouter = {
    enabled,
    custom_models: [],
    hidden_models: [],
    connections: connections.map((connection) => ({
      enabled: true,
      token_saver: true,
      custom_models: [],
      hidden_models: [],
      ...connection,
    })),
  }
  return settings
}

function input(
  over: Partial<ProviderSendTurnInput> = {}
): ProviderSendTurnInput {
  return {
    thread_id: "t1",
    message: "hi",
    model_id: "cc/claude-opus-5-5",
    history: [],
    chat_mode: "ask",
    project_path: "",
    ...over,
  }
}

beforeEach(() => vi.clearAllMocks())

describe("9Router adapter", () => {
  const laptop = {
    id: "laptop",
    name: "Laptop",
    base_url: "http://localhost:20128/v1",
  }
  const vps = {
    id: "vps",
    name: "VPS",
    base_url: "https://router.example.com/v1",
    api_key: "sk-vps",
    token_saver: false,
  }

  it("routes each turn to the selected connection with its key and headers", async () => {
    const settings = settingsWith([laptop, vps])
    const adapter = makeNineRouterAdapter(() => settings)
    createMock.mockReturnValueOnce(stream(textTurn("ok")))
    await adapter.sendMessage(input({ provider_instance_id: "ninerouter:vps" }))
    expect(sdkOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseURL: "https://router.example.com/v1",
        apiKey: "sk-vps",
        defaultHeaders: { "X-9Router-Token-Saver": "off" },
        maxRetries: 0,
      })
    )
    expect(createMock.mock.calls[0][0]).toMatchObject({
      model: "cc/claude-opus-5-5",
      stream: true,
    })
  })

  it("accepts a bare connection id from older clients", async () => {
    const settings = settingsWith([laptop, vps])
    const adapter = makeNineRouterAdapter(() => settings)
    createMock.mockReturnValueOnce(stream(textTurn("ok")))
    await adapter.sendMessage(input({ provider_instance_id: "vps" }))
    expect(sdkOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseURL: "https://router.example.com/v1" })
    )
  })

  it("uses the first enabled connection when the chat names none", async () => {
    const settings = settingsWith([{ ...laptop, enabled: false }, vps])
    const adapter = makeNineRouterAdapter(() => settings)
    createMock.mockReturnValueOnce(stream(textTurn("ok")))
    await adapter.sendMessage(input())
    expect(sdkOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseURL: "https://router.example.com/v1" })
    )
  })

  it("streams reasoning_content as reasoning deltas", async () => {
    const settings = settingsWith([laptop])
    const adapter = makeNineRouterAdapter(() => settings)
    const events: Array<{ event_type: string; payload: unknown }> = []
    adapter.subscribeEvents().on("event", (event) => events.push(event))
    createMock.mockReturnValueOnce(stream(textTurn("ok")))
    await adapter.sendMessage(input())
    expect(events.map((event) => event.event_type)).toEqual([
      "reasoning_delta",
      "content_delta",
    ])
  })

  it.each([
    ["auto", "auto"],
    ["Auto", "auto"],
    ["No Reasoning", "none"],
    ["minimal", "minimal"],
    ["xHigh", "xhigh"],
    ["max", "max"],
    ["Ultra Think", "max"],
  ])("sends reasoning %s as %s", async (effort, expected) => {
    const settings = settingsWith([laptop])
    const adapter = makeNineRouterAdapter(() => settings)
    createMock.mockReturnValueOnce(stream(textTurn("ok")))
    await adapter.sendMessage(input({ reasoning_effort: effort }))
    expect(createMock.mock.calls[0][0].reasoning_effort).toBe(expected)
  })

  it("omits reasoning when the router default is chosen", () => {
    expect(mapCompatReasoningEffort(null, "ninerouter")).toBeNull()
    expect(mapCompatReasoningEffort("off", "ninerouter")).toBeNull()
  })

  it("is configured only with an enabled connection", () => {
    expect(makeNineRouterAdapter(() => settingsWith([])).isConfigured()).toBe(
      false
    )
    expect(
      makeNineRouterAdapter(() => settingsWith([laptop], false)).isConfigured()
    ).toBe(false)
    expect(
      makeNineRouterAdapter(() => settingsWith([laptop])).isConfigured()
    ).toBe(true)
  })

  it("names a removed connection instead of silently switching routers", async () => {
    const settings = settingsWith([laptop])
    const adapter = makeNineRouterAdapter(() => settings)
    await expect(
      adapter.sendMessage(input({ provider_instance_id: "ninerouter:gone" }))
    ).rejects.toThrow('9Router connection "gone" no longer exists')
    expect(createMock).not.toHaveBeenCalled()
  })

  it("explains a missing API key in 9Router terms", async () => {
    const settings = settingsWith([laptop])
    const adapter = makeNineRouterAdapter(() => settings)
    createMock.mockRejectedValueOnce(
      Object.assign(new Error("401 Missing API key"), { status: 401 })
    )
    await expect(adapter.sendMessage(input())).rejects.toThrow(
      '9Router "Laptop" requires an API key'
    )
    expect(sdkOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: "betterc0de-no-key" })
    )
  })

  it("explains an unreachable router", async () => {
    const settings = settingsWith([laptop])
    const adapter = makeNineRouterAdapter(() => settings)
    const error = new Error("Connection error.")
    error.name = "APIConnectionError"
    createMock.mockRejectedValueOnce(error)
    await expect(adapter.sendMessage(input())).rejects.toThrow(
      '9Router "Laptop" is not reachable at http://localhost:20128/v1'
    )
  })
})
