/**
 * One place for "what provider kind does this string mean". Provider events,
 * settings drivers and payloads spell the same backend many ways
 * (`claudeAgent`, `claude-cli`, `cursor_agent`, ...). The backend hub, the
 * ingestion lifecycle store, the activity projection and the renderer each
 * kept a copy of this ladder and the copies drifted, so a pending request
 * keyed by one spelling could miss its approval keyed by another.
 *
 * Not to be confused with `skillScopeProviderKey` (prompt-context), which
 * folds kinds onto the key skills and options are *stored* under and uses
 * different canonical spellings on purpose.
 */
export type CanonicalProviderKindAlias =
  | "codex"
  | "codex_cli"
  | "claude"
  | "anthropic_cli"
  | "cursor"
  | "grok_cli"
  | "betterc0de"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "grok"
  | "google"
  | "lmstudio"

/** Lower-cased with every non-alphanumeric character removed. */
export function compactProviderAlias(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Resolves an alias to its canonical kind, or null when unknown. `codex_cli`
 * stays distinct from `codex` here; callers that route by adapter fold it.
 * Bare `grok` stays the legacy xAI API adapter — the CLI is a separate kind so
 * it cannot shadow the API-key provider.
 */
export function canonicalProviderKindAlias(
  value: string | undefined
): CanonicalProviderKindAlias | null {
  const key = compactProviderAlias(value)
  switch (key) {
    case "":
      return null
    case "codex":
      return "codex"
    case "codexcli":
      return "codex_cli"
    case "claude":
    case "claudeagent":
    case "claudecli":
      return "claude"
    case "anthropiccli":
      return "anthropic_cli"
    case "cursor":
    case "cursoragent":
    case "cursorcli":
    case "cursoracp":
      return "cursor"
    case "grokcli":
    case "grokagent":
    case "grokacp":
    case "grokbuild":
      return "grok_cli"
    case "betterc0de":
    case "bettercode":
    case "betterc0decli":
    case "bettercodecli":
    case "betterc0deagent":
    case "bettercodeagent":
      return "betterc0de"
    case "openai":
    case "anthropic":
    case "openrouter":
    case "grok":
    case "google":
    case "lmstudio":
      return key
    default:
      return null
  }
}

/**
 * The permissive flavour used on the event bridge and in activity
 * projection: folds the CLI spellings we know and passes any other value
 * through untouched so unknown providers keep their own label.
 */
export function providerKindFromDriver(
  value: string | undefined
): string | undefined {
  const key = compactProviderAlias(value)
  if (!key) return undefined
  if (key === "codex" || key === "codexcli") return "codex"
  if (key === "claude" || key === "claudeagent" || key === "claudecli") {
    return "claude"
  }
  if (key === "anthropiccli") return "anthropic_cli"
  return value
}
