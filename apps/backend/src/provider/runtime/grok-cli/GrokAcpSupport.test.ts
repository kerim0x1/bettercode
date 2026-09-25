import { describe, expect, it } from "vitest"
import {
  buildGrokAcpSpawnInput,
  buildGrokDiscoveredModelsFromConfigOptions,
  mergeGrokCustomModels,
} from "./GrokAcpSupport"

describe("GrokAcpSupport", () => {
  it("spawns `grok agent stdio` by default", () => {
    const input = buildGrokAcpSpawnInput(null, "/tmp/project")
    expect(input).toEqual({
      command: "grok",
      args: ["agent", "stdio"],
      cwd: "/tmp/project",
    })
  })

  it("honors an explicit binary path (Windows absolute paths included)", () => {
    const input = buildGrokAcpSpawnInput(
      { binaryPath: "C:\\Users\\dev\\AppData\\Roaming\\npm\\grok.cmd" },
      "C:\\repo",
      { XAI_API_KEY: "xai-test" }
    )
    expect(input.command).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\grok.cmd"
    )
    expect(input.args).toEqual(["agent", "stdio"])
    expect(input.env).toEqual({ XAI_API_KEY: "xai-test" })
  })

  it("discovers models from a `category: model` config option", () => {
    const models = buildGrokDiscoveredModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "grok-build-0.1",
        options: [
          { value: "grok-build-0.1", name: "Grok Build 0.1" },
          { value: "grok-4.3", name: "Grok 4.3" },
        ],
      },
    ])
    expect(models.map((model) => model.slug)).toEqual([
      "grok-build-0.1",
      "grok-4.3",
    ])
  })

  it("merges custom models without duplicating discovered slugs", () => {
    const merged = mergeGrokCustomModels([], ["grok-4.5", "grok-custom", " "])
    expect(merged.map((model) => model.slug)).toEqual([
      "grok-4.5",
      "grok-custom",
    ])
    expect(merged.at(-1)).toMatchObject({ isCustom: true, tier: "Custom" })
  })
})
