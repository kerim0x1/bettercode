import { normalizeThinkingModeValue } from "@betterc0de/schema"

/** Stable effort identities; contrast variants follow the resolved theme mode. */
export function reasoningColorClass(mode: string | null): string {
  switch (normalizeThinkingModeValue(mode ?? "off")) {
    case "high":
      return "text-orange-700 dark:text-orange-400"
    case "xhigh":
      return "text-red-700 dark:text-red-400"
    case "max":
      return "text-blue-700 dark:text-blue-400"
    case "ultra":
    case "ultrathink":
    case "ultracode":
      return "text-purple-700 dark:text-purple-400"
    default:
      return "text-primary"
  }
}
