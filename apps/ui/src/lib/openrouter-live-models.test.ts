import { describe, expect, it } from "vitest"
import {
  buildOpenRouterGroupModels,
  formatOpenRouterContextLabel,
  openRouterCustomUiModels,
  openRouterDisplayName,
  openRouterModelTier,
} from "./openrouter-live-models"

describe("openrouter live model helpers", () => {
  it("strips the vendor prefix from catalog display names", () => {
    expect(openRouterDisplayName("Qwen: Qwen3.8 Max", "qwen/qwen3.8-max")).toBe(
      "Qwen3.8 Max"
    )
    expect(openRouterDisplayName("GLM 5.3", "z-ai/glm-5.3")).toBe("GLM 5.3")
    expect(openRouterDisplayName("  ", "z-ai/glm-5.3")).toBe("z-ai/glm-5.3")
  })

  it("formats context labels in the picker's conventions", () => {
    expect(formatOpenRouterContextLabel(1_000_000)).toBe("1M")
    expect(formatOpenRouterContextLabel(1_310_720)).toBe("1.3M")
    expect(formatOpenRouterContextLabel(2_000_000)).toBe("2M")
    expect(formatOpenRouterContextLabel(262_144)).toBe("256K")
    expect(formatOpenRouterContextLabel(500_000)).toBe("500K")
    expect(formatOpenRouterContextLabel(null)).toBe("—")
  })

  it("derives tiers from id/name conventions", () => {
    expect(openRouterModelTier("z-ai/glm-5.2:free", "GLM 5.2 (free)")).toBe(
      "Free"
    )
    expect(openRouterModelTier("qwen/qwen3-coder-next", "Coder Next")).toBe(
      "Coding"
    )
    expect(openRouterModelTier("google/gemini-3.7-flash", "Flash")).toBe("Fast")
    expect(openRouterModelTier("qwen/qwen3.8-max", "Max")).toBe("Flagship")
    expect(openRouterModelTier("deepseek/deepseek-v3.2", "V3.2")).toBe(
      "Balanced"
    )
  })

  it("names Settings custom models readably, trimmed and deduped", () => {
    expect(
      openRouterCustomUiModels([
        "  moonshotai/kimi-k2  ",
        "moonshotai/kimi-k2",
        "",
        "mistralai/devstral-large",
      ])
    ).toEqual([
      {
        id: "moonshotai/kimi-k2",
        name: "Kimi K2",
        context: "custom",
        tier: "Custom",
      },
      {
        id: "mistralai/devstral-large",
        name: "Devstral Large",
        context: "custom",
        tier: "Custom",
      },
    ])
    expect(openRouterCustomUiModels([])).toEqual([])
  })

  it("groups by family, caps per group, and skips unknown families", () => {
    const groups = buildOpenRouterGroupModels([
      { id: "qwen/a", name: "Qwen: A", contextLength: 1_000_000 },
      { id: "qwen/b", name: "Qwen: B", contextLength: 1_000_000 },
      { id: "qwen/c", name: "Qwen: C", contextLength: 1_000_000 },
      { id: "qwen/d", name: "Qwen: D", contextLength: 1_000_000 },
      { id: "qwen/e-over-cap", name: "Qwen: E", contextLength: 1_000_000 },
      { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", contextLength: 1_310_720 },
      {
        id: "google/gemini-3.7-flash",
        name: "Gemini Flash",
        contextLength: 1_000_000,
      },
      // Grok deliberately has no OpenRouter group (direct xAI covers it).
      {
        id: "x-ai/grok-4.6",
        name: "SpaceXAI: Grok 4.6",
        contextLength: 500_000,
      },
      { id: "mistralai/unknown", name: "Mistral", contextLength: 32_000 },
    ])

    expect(groups.get("or-qwen")?.map((m) => m.id)).toEqual([
      "qwen/a",
      "qwen/b",
      "qwen/c",
      "qwen/d",
    ])
    expect(groups.has("or-zhipu")).toBe(false)
    expect(groups.has("or-xai")).toBe(false)
    // Removed groups cannot return through live catalog refreshes.
    expect(groups.has("or-gemini")).toBe(false)
    expect([...groups.keys()].some((k) => k.includes("mistral"))).toBe(false)
  })
})
