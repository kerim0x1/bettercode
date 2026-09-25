/**
 * Maps the UI's internal "thinking mode" label to a value that the currently
 * selected provider/model can actually accept.
 *
 * BetterC0de exposes these labels (see `THINKING_MODES` below):
 *   `No Reasoning` · `Low` · `Medium` · `High` · `xHigh` · `Ultra Think`
 *
 * Codex model support is not inferred here. `model-capabilities.ts` validates
 * the normalized value against the selected model's live `model/list`
 * descriptor and omits the effort entirely when metadata is unavailable.
 *
 * IMPORTANT: "Fast Mode" is NOT a thinking mode. It is the orthogonal
 * `serviceTier: "fast"` field on Codex's `turn/start` payload (priority
 * compute), modelled in BetterC0de as a separate boolean option on the model
 * selection; the Codex adapter maps that flag to the wire representation.
 *
 * LM Studio configures reasoning at runtime via its own UI; we return
 * null so the request payload doesn't carry an effort field.
 */

/** Canonical thinking-mode labels as exposed by the chat toolbar. */
export const THINKING_MODES = [
  "No Reasoning",
  "Low",
  "Medium",
  "High",
  "xHigh",
  "Ultra Think",
] as const

export type ThinkingMode = (typeof THINKING_MODES)[number]

export function normalizeThinkingMode(
  provider: { id: string; providerKind?: string } | undefined,
  modelId: string,
  thinkingMode: string | null
): string | null {
  if (!thinkingMode) return null
  const isUltraThinkLabel = thinkingMode === "Ultra Think"
  const normalizedEffort = thinkingMode
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  const providerKind = (
    provider?.providerKind ??
    provider?.id ??
    ""
  ).toLowerCase()
  const lowerModel = modelId.toLowerCase()
  const isCodexFamily =
    providerKind === "codex" ||
    providerKind === "openai" ||
    lowerModel.startsWith("gpt-") ||
    lowerModel.includes("codex")

  // LM Studio configures reasoning at model runtime, not via request payload.
  if (providerKind === "lmstudio") return null

  // Codex validity is checked against live model metadata later. Other
  // providers retain the conservative Low fallback.
  if (thinkingMode === "No Reasoning") {
    if (isCodexFamily) return "No Reasoning"
    return "Low"
  }

  const maxHighProviders = new Set(["openrouter", "grok", "google", "deepseek"])
  if (maxHighProviders.has(providerKind)) {
    if (
      thinkingMode === "Ultra Think" ||
      thinkingMode === "xHigh" ||
      normalizedEffort === "ultrathink" ||
      normalizedEffort === "max"
    ) {
      return "High"
    }
    return thinkingMode
  }

  // Conservative fallback for unknown providers/models.
  if (!providerKind || providerKind.startsWith("or-")) {
    if (
      thinkingMode === "Ultra Think" ||
      thinkingMode === "xHigh" ||
      normalizedEffort === "ultrathink" ||
      normalizedEffort === "max"
    ) {
      return "High"
    }
    return thinkingMode
  }

  // Codex/GPT/Claude providers support xHigh/Ultra in this runtime.
  //
  // The Claude family is matched against three different `providerKind`
  // values that all reach this function depending on which entry the
  // user picked in the model dropdown:
  //   - `"anthropic"`        — built-in "Claude API" (direct REST adapter)
  //   - `"anthropic_cli"`    — backend ClaudeAgent SDK kind
  //   - `"claude"`           — built-in "Claude CLI" UI entry
  if (providerKind.includes("anthropic") || providerKind.includes("claude")) {
    return thinkingMode
  }

  if (isCodexFamily) {
    if (providerKind === "codex") return thinkingMode
    // The model descriptor decides whether direct OpenAI accepts max.
    if (providerKind === "openai" && normalizedEffort === "max")
      return thinkingMode
    if (
      normalizedEffort === "max" ||
      normalizedEffort === "ultra" ||
      (normalizedEffort === "ultrathink" && !isUltraThinkLabel)
    ) {
      return "xHigh"
    }
    return thinkingMode
  }

  if (
    thinkingMode === "Ultra Think" ||
    thinkingMode === "xHigh" ||
    normalizedEffort === "ultrathink" ||
    normalizedEffort === "max"
  ) {
    return "High"
  }
  return thinkingMode
}

/**
 * Translate a user-facing thinking-mode label into the wire-level effort
 * string the backend expects. Pure helper — exported so tests and the
 * chat-send path stay consistent.
 */
export function thinkingModeToEffort(label: string | null): string | null {
  if (!label) return null
  switch (label) {
    case "No Reasoning":
      return "none"
    case "Minimal":
      return "minimal"
    case "Low":
      return "low"
    case "Medium":
      return "medium"
    case "High":
      return "high"
    case "xHigh":
    case "Ultra Think":
      return "xhigh"
    default:
      return label
  }
}
