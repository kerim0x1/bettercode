import { parseAnthropicModelId } from "@betterc0de/schema"

/**
 * Model-specific behaviour keyed by model family and generation instead of
 * one exact slug. An exact match silently dropped the behaviour for a dated
 * snapshot (`claude-opus-5-5-20261001`) or the next release, which then fell
 * back to defaults such as a disabled-thinking request or a missing effort
 * ladder. Keep every such rule here so it is changed in one place.
 */

/** First Opus generation whose adaptive thinking cannot be switched off. */
const ALWAYS_ON_THINKING_OPUS_VERSION = 5.5

/**
 * Opus 5.5 and later: thinking is always on and the effort ladder defaults to
 * `medium`. Bare aliases (`opus`) are not matched, since what they resolve
 * to is decided by the endpoint.
 */
export function anthropicThinkingAlwaysOn(
  modelId: string | null | undefined
): boolean {
  const identity = parseAnthropicModelId(modelId)
  return (
    identity?.family === "opus" &&
    identity.version !== null &&
    identity.version >= ALWAYS_ON_THINKING_OPUS_VERSION
  )
}

/**
 * The GPT-5.6 "sol" line (1.05M context, `none`…`max` reasoning ladder),
 * including dated snapshots such as `gpt-5.6-sol-2026-09-01`.
 */
export function isOpenAiSolModel(slug: string | null | undefined): boolean {
  return /^gpt-5\.6-sol(?:-\d{4}-\d{2}-\d{2})?$/i.test((slug ?? "").trim())
}
