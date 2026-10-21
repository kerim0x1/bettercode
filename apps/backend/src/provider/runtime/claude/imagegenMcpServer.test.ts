import { DEFAULT_IMAGE_GENERATION_MODEL } from "@betterc0de/schema"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildImagegenMcpServer,
  type SdkMcpCapableModule,
} from "./imagegenMcpServer"

/** The backend's image generations: a fake the tests inspect. */
const generateImage = vi.fn()
const imageGeneration = { generate: generateImage }

interface CapturedTool {
  readonly name: string
  readonly description: string
  readonly handler: (args: unknown, extra: unknown) => Promise<unknown>
}

function fakeSdk(): { sdk: SdkMcpCapableModule; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const sdk = {
    tool: (
      name: string,
      description: string,
      _schema: unknown,
      handler: CapturedTool["handler"]
    ) => {
      const captured = { name, description, handler }
      tools.push(captured)
      return captured
    },
    createSdkMcpServer: (config: { name: string }) => ({
      type: "sdk",
      name: config.name,
      instance: {},
    }),
  }
  return { sdk: sdk as unknown as SdkMcpCapableModule, tools }
}

beforeEach(() => {
  generateImage.mockReset()
  generateImage.mockResolvedValue({
    ok: true,
    absolutePath: "/work/hero.png",
    relativePath: "hero.png",
    bytes: 8,
  })
})

describe("buildImagegenMcpServer", () => {
  it("names and uses the configured image model", async () => {
    const { sdk, tools } = fakeSdk()
    buildImagegenMcpServer(sdk, {
      workspaceDir: "/work",
      model: "gpt-image-test",
      imageGeneration,
    })

    expect(tools).toHaveLength(1)
    expect(tools[0]!.description).toContain("gpt-image-test")
    expect(tools[0]!.description).not.toContain(DEFAULT_IMAGE_GENERATION_MODEL)

    await tools[0]!.handler(
      { prompt: "blue rocket", save_path: "hero.png" },
      undefined
    )
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/work",
        model: "gpt-image-test",
      })
    )
  })

  it("falls back to the default model when none or an invalid one is set", async () => {
    for (const model of [undefined, null, "", "gpt 5 & calc"]) {
      const { sdk, tools } = fakeSdk()
      buildImagegenMcpServer(sdk, {
        workspaceDir: "/work",
        model,
        imageGeneration,
      })
      expect(tools[0]!.description).toContain(DEFAULT_IMAGE_GENERATION_MODEL)
      await tools[0]!.handler(
        { prompt: "blue rocket", save_path: "hero.png" },
        undefined
      )
      expect(generateImage).toHaveBeenLastCalledWith(
        expect.objectContaining({ model: DEFAULT_IMAGE_GENERATION_MODEL })
      )
    }
  })
})
