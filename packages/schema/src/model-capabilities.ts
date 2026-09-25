import { anthropicSupportsExtendedEffort } from "./anthropic-model-family"
import type { ModelCapabilities } from "./model-selection"

export interface ModelCapabilityInput {
  readonly providerKind: string
  readonly modelId: string
  readonly capabilities?: ModelCapabilities | null
}
export interface ModelThinkingOption {
  readonly mode: string | null
  readonly label: string
}

// Provider descriptors are sets of supported values, not an ordered UI scale.
// Grok advertises these in descending order; sliders must increase to the right.
const EFFORT_ORDER: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultrathink: 7,
  ultra: 8,
  ultracode: 9,
}

/** Shared by desktop and mobile; live descriptors take precedence over fallbacks. */
export function modelThinkingOptions(
  input: ModelCapabilityInput
): ReadonlyArray<ModelThinkingOption> {
  const descriptor = input.capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === "select" &&
      (option.id === "reasoningEffort" || option.id === "effort")
  )
  if (descriptor?.type !== "select" || descriptor.options.length === 0)
    return getFallbackThinkingOptions(input)
  return [
    ...(input.modelId === "claude-opus-5-5" ||
    descriptor.options.some((option) => option.id === "none")
      ? []
      : [{ mode: null, label: "Off" }]),
    ...[...descriptor.options]
      .sort(
        (a, b) =>
          (EFFORT_ORDER[normalizeThinkingModeValue(a.id)] ??
            Number.MAX_SAFE_INTEGER) -
          (EFFORT_ORDER[normalizeThinkingModeValue(b.id)] ??
            Number.MAX_SAFE_INTEGER)
      )
      .map((option) => ({
        mode: effortIdToThinkingMode(option.id),
        label: option.label,
      })),
  ]
}

export function modelBooleanOption(
  input: ModelCapabilityInput,
  optionId: string
): boolean {
  const descriptors = input.capabilities?.optionDescriptors
  if (descriptors?.length)
    return descriptors.some(
      (option) => option.type === "boolean" && option.id === optionId
    )
  return (
    optionId === "fastMode" && input.providerKind.toLowerCase() === "claude"
  )
}

function effortIdToThinkingMode(id: string): string {
  switch (id) {
    case "none":
      return "No Reasoning"
    case "low":
      return "Low"
    case "medium":
      return "Medium"
    case "high":
      return "High"
    case "xhigh":
      return "xHigh"
    default:
      return id
  }
}

export function normalizeThinkingModeValue(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  switch (normalized) {
    case "noreasoning":
    case "none":
      return "none"
    case "minimal":
      return "minimal"
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
      return "high"
    case "xhigh":
    case "extrahigh":
      return "xhigh"
    case "ultrathink":
      return "ultrathink"
    case "max":
      return "max"
    default:
      return normalized
  }
}

function getFallbackThinkingOptions(
  input: ModelCapabilityInput
): ReadonlyArray<ModelThinkingOption> {
  const providerKind = input.providerKind.toLowerCase()
  const model = input.modelId.toLowerCase()
  // Codex advertises its real ladder through `model/list`; this is only the
  // cold-start fallback. It used to offer "Off" alone, which silently
  // discarded the user's reasoning preference and displayed Codex as having
  // no reasoning at all. Offering the standard ladder is safe because the
  // backend (`effortForModel`) forwards an effort only when the live
  // descriptor actually lists it, and drops anything it cannot verify.
  if (providerKind === "codex") {
    return [
      { mode: null, label: "Off" },
      { mode: "Low", label: "Low" },
      { mode: "Medium", label: "Medium" },
      { mode: "High", label: "High" },
    ]
  }
  const cappedAtHigh =
    providerKind === "openrouter" ||
    providerKind === "grok" ||
    providerKind === "google" ||
    providerKind === "deepseek" ||
    providerKind.startsWith("or-")
  const options: ModelThinkingOption[] = [
    ...(model === "claude-opus-5-5" ? [] : [{ mode: null, label: "Off" }]),
    { mode: "Low", label: "Low" },
    { mode: "Medium", label: "Medium" },
    { mode: "High", label: "High" },
  ]
  if (!cappedAtHigh) {
    const isClaude =
      providerKind.includes("anthropic") || providerKind.includes("claude")
    if (isClaude) {
      // Derived from the model's generation rather than a slug list, so a
      // newly released flagship gets its full thinking menu unattended.
      // "ultracode" is a Claude Code harness keyword (multi-agent workflow
      // orchestration), so it only makes sense on the CLI-backed providers —
      // the raw Anthropic API would receive a meaningless prompt prefix.
      // Ultrathink was dropped from the menu (unused); a stored "ultrathink"
      // selection still steps down to Max via coerceThinkingModeForModel.
      const isClaudeCli = providerKind.includes("claude")
      if (anthropicSupportsExtendedEffort(model)) {
        options.push({ mode: "xHigh", label: "Extra High" })
        options.push({ mode: "max", label: "Max" })
        if (isClaudeCli) options.push({ mode: "ultracode", label: "Ultracode" })
      } else if (model.includes("opus")) {
        options.push({ mode: "max", label: "Max" })
        if (isClaudeCli) options.push({ mode: "ultracode", label: "Ultracode" })
      } else if (model.includes("sonnet")) {
        if (isClaudeCli) options.push({ mode: "ultracode", label: "Ultracode" })
      } else {
        options.push({ mode: "max", label: "Max" })
      }
    } else {
      options.push({ mode: "xHigh", label: "xHigh" })
      options.push({ mode: "Ultra Think", label: "Ultra Think" })
    }
  }
  return options
}
