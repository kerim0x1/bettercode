import { describe, expect, it } from "vitest"
import { displayModelName, prettyModelId } from "./model-display-name"

describe("prettyModelId", () => {
  it.each([
    ["google/gemini-4-argon", "Gemini 4 Argon"],
    ["anthropic/claude-3-5-sonnet", "Claude 3.5 Sonnet"],
    ["meta-llama/llama-3.1-70b-instruct:free", "Llama 3.1 70B Instruct (Free)"],
    ["deepseek/deepseek-v4-pro-0813", "DeepSeek V4 Pro 0813"],
    ["qwen/qwen3.8-max", "Qwen3.8 Max"],
    ["openai/gpt-4o-mini", "GPT 4o Mini"],
    ["openai/o3-mini", "o3 Mini"],
    ["z-ai/glm-4.6", "GLM 4.6"],
  ])("reads %s as %s", (id, name) => {
    expect(prettyModelId(id)).toBe(name)
  })
})

describe("displayModelName", () => {
  it("keeps a real name and reads a vendor slug otherwise", () => {
    expect(displayModelName("qwen/qwen3.8-max", "Qwen 3.8 Max")).toBe(
      "Qwen 3.8 Max"
    )
    expect(
      displayModelName("google/gemini-4-argon", "google/gemini-4-argon")
    ).toBe("Gemini 4 Argon")
    expect(displayModelName("claude-opus-5-5")).toBe("claude-opus-5-5")
  })
})
