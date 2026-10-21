import { describe, expect, it } from "vitest"
import { anthropicThinkingAlwaysOn, isOpenAiSolModel } from "./modelFamilies"

describe("model family matchers", () => {
  it("keeps always-on thinking for dated snapshots and later Opus releases", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-opus-5-5-20261001",
      "claude-opus-5-5[1m]",
      "opus-5-5",
      "claude-opus-6",
    ]) {
      expect(anthropicThinkingAlwaysOn(id), id).toBe(true)
    }
    for (const id of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "opus",
      "custom-model",
      null,
    ]) {
      expect(anthropicThinkingAlwaysOn(id), String(id)).toBe(false)
    }
  })

  it("matches the GPT-5.6 sol line including dated snapshots", () => {
    expect(isOpenAiSolModel("gpt-5.6-sol")).toBe(true)
    expect(isOpenAiSolModel("gpt-5.6-sol-2026-09-01")).toBe(true)
    expect(isOpenAiSolModel("gpt-5.6")).toBe(false)
    expect(isOpenAiSolModel("gpt-5.6-solar")).toBe(false)
  })
})
