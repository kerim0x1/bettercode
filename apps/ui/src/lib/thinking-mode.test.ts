import { describe, it, expect } from "vitest"
import { normalizeThinkingMode, thinkingModeToEffort } from "./thinking-mode"

describe("normalizeThinkingMode", () => {
  it("returns null when the user has no thinking mode selected", () => {
    expect(
      normalizeThinkingMode(
        { id: "claude", providerKind: "claude" },
        "claude-opus-4-7",
        null
      )
    ).toBeNull()
  })

  describe("LM Studio (configures reasoning at runtime)", () => {
    it("forces null regardless of UI selection", () => {
      expect(
        normalizeThinkingMode(
          { id: "lmstudio", providerKind: "lmstudio" },
          "qwen-coder",
          "Ultra Think"
        )
      ).toBeNull()
    })
  })

  describe("Claude family — passes Ultra Think + xHigh through unchanged", () => {
    // Regression: the Claude CLI builtin uses `providerKind: "claude"`,
    // which doesn't match `.includes("anthropic")`. Before the fix this
    // function silently downgraded Ultra Think / xHigh to High for the
    // CLI entry, so the user could not activate Max / Ultra Think no
    // matter how often they clicked the dropdown.
    it.each([
      ["claude (CLI builtin)", { id: "claude", providerKind: "claude" }],
      ["anthropic (Claude API builtin)", { id: "anthropic" }],
      [
        "anthropic_cli (backend ClaudeAgent kind)",
        { id: "claude", providerKind: "anthropic_cli" },
      ],
    ])("%s preserves Ultra Think", (_label, provider) => {
      expect(
        normalizeThinkingMode(provider, "claude-opus-4-7", "Ultra Think")
      ).toBe("Ultra Think")
    })

    it.each([
      ["claude (CLI builtin)", { id: "claude", providerKind: "claude" }],
      ["anthropic (Claude API builtin)", { id: "anthropic" }],
      [
        "anthropic_cli (backend ClaudeAgent kind)",
        { id: "claude", providerKind: "anthropic_cli" },
      ],
    ])("%s preserves xHigh", (_label, provider) => {
      expect(normalizeThinkingMode(provider, "claude-opus-4-7", "xHigh")).toBe(
        "xHigh"
      )
    })

    it.each([
      ["claude (CLI builtin)", { id: "claude", providerKind: "claude" }],
      ["anthropic (Claude API builtin)", { id: "anthropic" }],
      [
        "anthropic_cli (backend ClaudeAgent kind)",
        { id: "claude", providerKind: "anthropic_cli" },
      ],
    ])("%s preserves descriptor-native max efforts", (_label, provider) => {
      expect(normalizeThinkingMode(provider, "claude-opus-4-7", "max")).toBe(
        "max"
      )
      expect(
        normalizeThinkingMode(provider, "claude-opus-4-7", "ultrathink")
      ).toBe("ultrathink")
    })
  })

  describe("OpenAI / Codex passes through", () => {
    it("openai passes Ultra Think", () => {
      expect(
        normalizeThinkingMode(
          { id: "openai-api", providerKind: "openai" },
          "gpt-5.4",
          "Ultra Think"
        )
      ).toBe("Ultra Think")
    })
    it("codex CLI passes Ultra Think (matched by model id, not providerKind)", () => {
      expect(
        normalizeThinkingMode(
          { id: "codex", providerKind: "codex" },
          "gpt-5.3-codex",
          "Ultra Think"
        )
      ).toBe("Ultra Think")
    })
    it("preserves Codex CLI values but caps direct OpenAI fallbacks", () => {
      expect(
        normalizeThinkingMode(
          { id: "codex", providerKind: "codex" },
          "gpt-5.5",
          "max"
        )
      ).toBe("max")
      expect(
        normalizeThinkingMode(
          { id: "openai-api", providerKind: "openai" },
          "gpt-5.5",
          "ultrathink"
        )
      ).toBe("xHigh")
    })
    it("preserves a direct OpenAI max value for model capability validation", () => {
      expect(
        normalizeThinkingMode(
          { id: "openai-api", providerKind: "openai" },
          "gpt-5.6-sol",
          "max"
        )
      ).toBe("max")
    })
  })

  describe("Capped providers downgrade Ultra Think / xHigh to High", () => {
    it.each(["openrouter", "grok", "google", "deepseek"])(
      "%s downgrades Ultra Think to High",
      (kind) => {
        expect(
          normalizeThinkingMode(
            { id: kind, providerKind: kind },
            "some-model",
            "Ultra Think"
          )
        ).toBe("High")
      }
    )
    it.each(["openrouter", "grok", "google", "deepseek"])(
      "%s downgrades xHigh to High",
      (kind) => {
        expect(
          normalizeThinkingMode(
            { id: kind, providerKind: kind },
            "some-model",
            "xHigh"
          )
        ).toBe("High")
      }
    )
    it.each(["openrouter", "grok", "google", "deepseek"])(
      "%s preserves Low / Medium / High",
      (kind) => {
        expect(
          normalizeThinkingMode(
            { id: kind, providerKind: kind },
            "some-model",
            "High"
          )
        ).toBe("High")
      }
    )
    it.each(["openrouter", "grok", "google", "deepseek"])(
      "%s downgrades Claude-native max efforts to High",
      (kind) => {
        expect(
          normalizeThinkingMode(
            { id: kind, providerKind: kind },
            "some-model",
            "ultrathink"
          )
        ).toBe("High")
        expect(
          normalizeThinkingMode(
            { id: kind, providerKind: kind },
            "some-model",
            "max"
          )
        ).toBe("High")
      }
    )
  })

  describe("Unknown / OpenRouter-prefixed providers downgrade", () => {
    it("or-* providerKind downgrades Ultra Think", () => {
      expect(
        normalizeThinkingMode(
          { id: "or-anthropic", providerKind: "or-anthropic" },
          "claude-opus-4-7",
          "Ultra Think"
        )
      ).toBe("High")
    })
  })

  // Fast Mode is not a thinking mode; it is a separate model-selection boolean
  // that maps to `serviceTier: "fast"` on the wire, orthogonal to reasoning
  // effort. No "Fast" label test here.

  describe("No Reasoning (effort: none) — gpt-5.5 exclusive per OpenAI docs", () => {
    it("passes through on gpt-5.5 (Codex CLI / OpenAI)", () => {
      expect(
        normalizeThinkingMode(
          { id: "codex", providerKind: "codex" },
          "gpt-5.5",
          "No Reasoning"
        )
      ).toBe("No Reasoning")
      expect(
        normalizeThinkingMode(
          { id: "openai-api", providerKind: "openai" },
          "gpt-5.5",
          "No Reasoning"
        )
      ).toBe("No Reasoning")
    })

    it("preserves Codex values for later live-capability validation", () => {
      expect(
        normalizeThinkingMode(
          { id: "codex", providerKind: "codex" },
          "gpt-5.4",
          "No Reasoning"
        )
      ).toBe("No Reasoning")
      expect(
        normalizeThinkingMode(
          { id: "codex", providerKind: "codex" },
          "gpt-5.3-codex",
          "No Reasoning"
        )
      ).toBe("No Reasoning")
      expect(
        normalizeThinkingMode(
          { id: "codex", providerKind: "codex" },
          "gpt-5.1-codex-mini",
          "No Reasoning"
        )
      ).toBe("No Reasoning")
    })

    it("downgrades to 'Low' on non-Codex providers regardless of model", () => {
      expect(
        normalizeThinkingMode(
          { id: "claude", providerKind: "claude" },
          "claude-opus-4-7",
          "No Reasoning"
        )
      ).toBe("Low")
      expect(
        normalizeThinkingMode(
          { id: "grok", providerKind: "grok" },
          "grok-3-beta",
          "No Reasoning"
        )
      ).toBe("Low")
    })
  })

  describe("xHigh fix — passes through to wire (was silently downgraded)", () => {
    it("Codex/GPT/Claude preserve xHigh", () => {
      expect(
        normalizeThinkingMode(
          { id: "codex", providerKind: "codex" },
          "gpt-5.5",
          "xHigh"
        )
      ).toBe("xHigh")
      expect(
        normalizeThinkingMode({ id: "anthropic" }, "claude-opus-4-7", "xHigh")
      ).toBe("xHigh")
    })
  })

  describe("Codex live effort values", () => {
    const codex = { id: "codex", providerKind: "codex" }

    it("preserves values and leaves support decisions to model metadata", () => {
      expect(normalizeThinkingMode(codex, "any-model", "max")).toBe("max")
      expect(normalizeThinkingMode(codex, "any-model", "ultra")).toBe("ultra")
      expect(normalizeThinkingMode(codex, "any-model", "Ultra Think")).toBe(
        "Ultra Think"
      )
    })
  })
})

describe("thinkingModeToEffort", () => {
  it.each([
    ["No Reasoning", "none"],
    ["Low", "low"],
    ["Medium", "medium"],
    ["High", "high"],
    ["xHigh", "xhigh"],
    ["Ultra Think", "xhigh"],
  ] as const)("maps %s → %s", (label, expected) => {
    expect(thinkingModeToEffort(label)).toBe(expected)
  })

  it("returns null for null/empty", () => {
    expect(thinkingModeToEffort(null)).toBeNull()
    expect(thinkingModeToEffort("")).toBeNull()
  })
})
