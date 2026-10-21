import { describe, expect, it } from "vitest"
import {
  formatContextTokens,
  formatPercent,
  readContextUsage,
} from "./context-usage"

describe("readContextUsage", () => {
  it("reads a context-window activity payload", () => {
    expect(
      readContextUsage({
        usedTokens: 35_000,
        maxTokens: 950_000,
        totalProcessedTokens: 187_000,
        compactsAutomatically: true,
        providerKind: "codex",
        providerInstanceId: "codex-main",
      })
    ).toEqual({
      usedTokens: 35_000,
      maxTokens: 950_000,
      totalProcessedTokens: 187_000,
      compactsAutomatically: true,
      providerKind: "codex",
      providerInstanceId: "codex-main",
    })
  })

  it("falls back to totalTokens and leaves unknown fields empty", () => {
    expect(readContextUsage({ totalTokens: 1_200 })).toEqual({
      usedTokens: 1_200,
      maxTokens: null,
      totalProcessedTokens: null,
      compactsAutomatically: null,
      providerKind: null,
      providerInstanceId: null,
    })
  })

  it("ignores payloads without usage", () => {
    expect(readContextUsage(undefined)).toBeNull()
    expect(readContextUsage({ usedTokens: 0 })).toBeNull()
    expect(readContextUsage({ usedTokens: "35k" })).toBeNull()
    expect(readContextUsage([1, 2])).toBeNull()
  })
})

describe("formatContextTokens", () => {
  it("uses compact K and M units", () => {
    expect(formatContextTokens(99)).toBe("99")
    expect(formatContextTokens(35_000)).toBe("35K")
    expect(formatContextTokens(187_432)).toBe("187.4K")
    expect(formatContextTokens(1_000_000)).toBe("1M")
  })
})

describe("formatPercent", () => {
  it("keeps one decimal below ten percent", () => {
    expect(formatPercent(0)).toBe("0%")
    expect(formatPercent(0.04)).toBe("<0.1%")
    expect(formatPercent(3.684)).toBe("3.7%")
    expect(formatPercent(4)).toBe("4%")
    expect(formatPercent(42.4)).toBe("42%")
  })
})
