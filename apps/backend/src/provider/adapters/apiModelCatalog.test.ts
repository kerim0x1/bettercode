import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiModelCatalog, isOpenAiChatModel } from "./apiModelCatalog"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-models-"))
  directories.push(directory)
  return directory
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("API model catalogs", () => {
  it("filters unsuitable OpenAI models while accepting new GPT and o chat models", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        data: [
          { id: "gpt-5.6-sol" },
          { id: "gpt-7" },
          { id: "o6" },
          { id: "chatgpt-7" },
          { id: "gpt-image-2" },
          { id: "gpt-5.6-audio" },
          { id: "gpt-5.6-realtime" },
          { id: "text-embedding-3-large" },
        ],
      })
    )
    const models = await new ApiModelCatalog(
      undefined,
      fetchMock as unknown as typeof fetch
    ).list("openai", "account-a")
    expect(models.map((model) => model.slug)).toEqual([
      "o6",
      "gpt-7",
      "gpt-5.6-sol",
      "chatgpt-7",
    ])
    expect(
      models.find((model) => model.slug === "gpt-5.6-sol")?.capabilities
    ).toMatchObject({ optionDescriptors: [{ currentValue: "medium" }] })
    expect(isOpenAiChatModel("gpt-7-mini")).toBe(true)
    expect(isOpenAiChatModel("gpt-7-audio")).toBe(false)
    expect(isOpenAiChatModel("chatgpt-7")).toBe(true)
  })

  it("keeps accounts separate, deduplicates requests, and restores a successful snapshot after restart", async () => {
    const directory = temporaryDirectory()
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) =>
      response({
        data: [
          {
            id:
              options.headers &&
              (options.headers as Record<string, string>).Authorization ===
                "Bearer first"
                ? "gpt-7"
                : "gpt-8",
          },
        ],
      })
    )
    const catalog = new ApiModelCatalog(
      directory,
      fetchMock as unknown as typeof fetch
    )
    const [first, duplicate] = await Promise.all([
      catalog.list("openai", "first"),
      catalog.list("openai", "first"),
    ])
    expect(first).toEqual(duplicate)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await catalog.list("openai", "second"))[0]?.slug).toBe("gpt-8")
    const failed = new ApiModelCatalog(
      directory,
      vi.fn(async () => {
        throw new Error("offline")
      }) as unknown as typeof fetch
    )
    expect((await failed.list("openai", "first"))[0]?.slug).toBe("gpt-7")
    expect(await failed.list("openai", "never-seen")).toEqual([])
    const persisted = fs
      .readdirSync(directory)
      .map((file) => fs.readFileSync(path.join(directory, file), "utf8"))
      .join(" ")
    expect(persisted).not.toContain("first")
    expect(persisted).not.toContain("second")
  })

  it("uses the full xAI language catalog and exposes its reasoning ladder", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      response({
        models: [
          {
            id: "grok-4.7",
            context_length: 500_000,
            output_modalities: ["text"],
            capabilities: {
              reasoning_effort: ["low", "medium", "high", "xhigh"],
              default_reasoning_effort: "medium",
            },
          },
          { id: "grok-image", output_modalities: ["image"] },
        ],
      })
    )
    const models = await new ApiModelCatalog(
      undefined,
      fetchMock as unknown as typeof fetch
    ).list("grok", "xai-account")
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.x.ai/v1/language-models"
    )
    expect(models).toMatchObject([
      {
        slug: "grok-4.7",
        context: "500K",
        capabilities: { optionDescriptors: [{ currentValue: "medium" }] },
      },
    ])
  })

  it("does not add withdrawn Anthropic models from a compiled list", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }],
        has_more: false,
      })
    )
    const models = await new ApiModelCatalog(
      undefined,
      fetchMock as unknown as typeof fetch
    ).list("anthropic", "anthropic-account")
    expect(models.map((model) => model.slug)).toEqual(["claude-opus-5-5"])
    expect(models[0]?.context).toBe("1M")
    expect(models[0]?.capabilities).toMatchObject({
      optionDescriptors: [{ currentValue: "medium" }],
    })
  })

  it("removes a withdrawn model after a successful refresh", async () => {
    const fetchMock = vi
      .fn(async (_url: string) => response({ data: [{ id: "gpt-7" }] }))
      .mockResolvedValueOnce(
        response({ data: [{ id: "gpt-6" }, { id: "gpt-7" }] })
      )
    const catalog = new ApiModelCatalog(
      undefined,
      fetchMock as unknown as typeof fetch
    )
    expect(
      (await catalog.list("openai", "account")).map((model) => model.slug)
    ).toContain("gpt-6")
    expect(
      (await catalog.list("openai", "account", true)).map((model) => model.slug)
    ).toEqual(["gpt-7"])
  })
})
