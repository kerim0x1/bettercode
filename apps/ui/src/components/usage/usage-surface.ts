import { builtinProviders } from "@/lib/builtin-providers"
import type { UsageProviderId } from "@/services/backend/coreApi"

/**
 * Shared surface classes and provider identity for the Usage page's views
 * (Cost, Tokens, Limits), so every view reads as the same page.
 */

/** A card on the page: soft border and an inset fill, as in Usage before. */
export const CARD = "rounded-2xl border border-border/40 bg-foreground/[0.02]"

export const DETAIL_ICON = "size-3.5 shrink-0 text-muted-foreground"

/**
 * Staggered entrance. A CSS animation runs once on mount and
 * `fill-mode-both` holds the end state, so a re-render mid-flight can never
 * strand a section at its start frame.
 */
export const ENTER =
  "motion-safe:animate-in motion-safe:fill-mode-both motion-safe:duration-300 motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
export const enterDelay = (index: number) => ({
  animationDelay: `${index * 60}ms`,
})

/** The providers the Usage page reads, in display order. */
export const USAGE_PROVIDER_IDS: readonly UsageProviderId[] = [
  "claude",
  "codex",
]

export const USAGE_PROVIDER_LABEL: Record<UsageProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
}

/**
 * Series color per provider. Claude's is its brand terracotta (#D97757), the
 * same provider-identity exception the logos make; Codex follows the theme's
 * foreground, white on dark and near-black on light.
 */
export const USAGE_PROVIDER_COLOR: Record<UsageProviderId, string> = {
  claude: "#d97757",
  codex: "var(--foreground)",
  grok: "var(--muted-foreground)",
}

/** The builtin provider entry `ProviderIcon` needs, named as on this page. */
export function usageProviderIcon(id: UsageProviderId) {
  const entry = builtinProviders.find((item) => item.id === id)
  return entry ? { ...entry, name: USAGE_PROVIDER_LABEL[id] } : null
}
