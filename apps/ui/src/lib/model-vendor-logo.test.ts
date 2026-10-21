import { describe, expect, it } from "vitest"
import { modelIconProvider, modelVendor } from "@/lib/model-vendor-logo"
import type { UiProvider } from "@/lib/provider-types"

const cursor: UiProvider = {
  id: "cursor",
  name: "Cursor",
  logo: "icons/providers/cursor.svg",
  invertDark: true,
  providerKind: "cursor",
  models: [],
}

describe("modelVendor", () => {
  it.each([
    ["claude-opus-5-5", "Claude Opus 5.5", "Claude"],
    ["sonnet-4.5-thinking", "Sonnet 4.5", "Claude"],
    ["gpt-5.6-sol", "GPT-5.6 Sol", "OpenAI"],
    ["o3-mini", "o3 mini", "OpenAI"],
    ["grok-4.7", "Grok 4.7", "Grok"],
    ["x-ai/grok-code-fast-1", "Grok Code Fast", "Grok"],
    ["gemini-4-argon", "Gemini 4 Argon", "Gemini"],
    ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", "DeepSeek"],
    ["qwen/qwen3.8-max", "Qwen 3.8 Max", "Qwen"],
  ])("reads %s as %s", (id, name, vendor) => {
    expect(modelVendor({ id, name })?.name).toBe(vendor)
  })

  it("leaves Cursor's own models without a maker", () => {
    expect(modelVendor({ id: "auto", name: "Auto" })).toBeNull()
    expect(modelVendor({ id: "composer-2.5", name: "Composer 2.5" })).toBeNull()
  })
})

describe("modelIconProvider", () => {
  it("draws the maker's mark inside a multi-vendor catalog", () => {
    const icon = modelIconProvider(cursor, {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
    })
    expect(icon.name).toBe("Claude")
    expect(icon.logo).toContain("claude.svg")
    expect(icon.invertDark).toBe(false)
  })

  it("keeps the provider's mark for its own models and other providers", () => {
    expect(modelIconProvider(cursor, { id: "auto", name: "Auto" })).toBe(cursor)
    const lmStudio: UiProvider = {
      id: "lmstudio",
      name: "LM Studio",
      logo: "icons/providers/lmstudio.png",
      models: [],
    }
    expect(modelIconProvider(lmStudio, { id: "qwen2.5-coder" })).toBe(lmStudio)
  })
})
