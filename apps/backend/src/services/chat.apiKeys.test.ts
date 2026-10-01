import { beforeEach, describe, expect, it, vi } from "vitest"
import { settingsSchema } from "@betterc0de/schema"
import { ApiKeyPool } from "../auth/apiKeyPool"

const mocks = vi.hoisted(() => ({
  anthropicOptions: vi.fn(),
  openaiOptions: vi.fn(),
  anthropicRequest: vi.fn(),
  openaiRequest: vi.fn(),
}))
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(options: unknown) {
      mocks.anthropicOptions(options)
    }
    messages = { create: mocks.anthropicRequest }
  },
}))
vi.mock("openai", () => ({
  default: class {
    constructor(options: unknown) {
      mocks.openaiOptions(options)
    }
    chat = { completions: { create: mocks.openaiRequest } }
  },
}))
import { ChatLlmHelpers } from "./chat"

beforeEach(() => vi.resetAllMocks())

function fixture(provider: "anthropic" | "openai", enabled = true) {
  const keys = ["primary", "backup"].map((id) => ({
    id,
    label: id,
    enabled: true,
    api_key: `synthetic-${id}`,
  }))
  const settings = settingsSchema.parse({
    providers: {
      anthropic: {
        enabled: provider === "anthropic" && enabled,
        api_keys: provider === "anthropic" ? keys : [],
      },
      openai: {
        enabled: provider === "openai" && enabled,
        api_keys: provider === "openai" ? keys : [],
      },
    },
  })
  const pool = new ApiKeyPool({
    get: () => settings,
    getPublic: () => ({}),
    update: () => settings,
  })
  return {
    helpers: new ChatLlmHelpers({ settings: () => settings, apiKeyPool: pool }),
    pool,
  }
}

describe("API key recovery for short chat helpers", () => {
  it.each(["anthropic", "openai"] as const)(
    "uses %s backup credentials for a title without changing the request or deadline",
    async (provider) => {
      const { helpers } = fixture(provider)
      const request =
        provider === "anthropic" ? mocks.anthropicRequest : mocks.openaiRequest
      const options =
        provider === "anthropic" ? mocks.anthropicOptions : mocks.openaiOptions
      request.mockRejectedValueOnce({ status: 401 }).mockResolvedValueOnce(
        provider === "anthropic"
          ? {
              content: [
                {
                  type: "text",
                  text: '{"title":"Recovered provider title"}',
                },
              ],
            }
          : {
              choices: [
                {
                  message: {
                    content: '{"title":"Recovered provider title"}',
                  },
                },
              ],
            }
      )
      expect(await helpers.generateTitle("Improve API settings")).toBe(
        "Recovered provider title"
      )
      expect(options.mock.calls.map((call) => call[0].apiKey)).toEqual([
        "synthetic-primary",
        "synthetic-backup",
      ])
      expect(options.mock.calls.every((call) => call[0].maxRetries === 0)).toBe(
        true
      )
      expect(request.mock.calls[0][0]).toEqual(request.mock.calls[1][0])
      expect(request.mock.calls[0][1].signal).toBe(
        request.mock.calls[1][1].signal
      )
    }
  )
  it.each(["anthropic", "openai"] as const)(
    "never calls a disabled %s provider for a helper",
    async (provider) => {
      const { helpers } = fixture(provider, false)
      await helpers.generateTitle("Improve API settings")
      expect(mocks.anthropicRequest).not.toHaveBeenCalled()
      expect(mocks.openaiRequest).not.toHaveBeenCalled()
    }
  )
  it("does not rotate a helper request rejected for account permissions", async () => {
    const { helpers } = fixture("anthropic")
    mocks.anthropicRequest.mockRejectedValueOnce({ status: 403 })
    await helpers.generateTitle("Improve API settings")
    expect(mocks.anthropicRequest).toHaveBeenCalledOnce()
    expect(mocks.openaiRequest).not.toHaveBeenCalled()
  })
})
