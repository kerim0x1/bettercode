/** How a provider is named in activity rows and notices, on the desktop and the phone. */

type ProviderLabelInput = {
  providerKind?: string | null
  providerInstanceId?: string | null
}

const providerLabels: Record<string, string> = {
  anthropic: "Anthropic",
  anthropiccli: "Claude CLI",
  betterc0de: "BetterC0de",
  bettercode: "BetterC0de",
  claude: "Claude CLI",
  claudeagent: "Claude CLI",
  claudecli: "Claude CLI",
  codex: "Codex CLI",
  codexcli: "Codex CLI",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  gemini: "Google",
  google: "Google",
  grok: "Grok",
  grokcli: "Grok CLI",
  lmstudio: "LM Studio",
  openai: "OpenAI",
  BetterC0de: "BetterC0de",
  openrouter: "OpenRouter",
}

export function formatProviderActivityLabel(
  input: ProviderLabelInput | undefined,
  fallback = "Provider"
): string {
  const providerKind = input?.providerKind?.trim() || undefined
  const providerInstanceId = input?.providerInstanceId?.trim() || undefined
  const inferredKind = providerKind ?? inferProviderKind(providerInstanceId)
  const baseLabel = providerBaseLabel(inferredKind)

  if (!baseLabel) return providerInstanceId ?? fallback
  if (!shouldIncludeInstance(baseLabel, inferredKind, providerInstanceId)) {
    return baseLabel
  }
  return `${baseLabel} / ${providerInstanceId}`
}

function providerBaseLabel(providerKind: string | undefined): string | null {
  if (!providerKind) return null
  const key = compact(providerKind)
  return providerLabels[key] ?? titleizeProvider(providerKind)
}

function inferProviderKind(providerInstanceId: string | undefined) {
  const key = compact(providerInstanceId)
  if (!key) return undefined
  if (key.includes("codex")) return "codex"
  if (key.includes("claude") || key.includes("anthropic")) return "claude"
  if (key.includes("cursor")) return "cursor"
  if (key.includes("betterc0de") || key.includes("bettercode"))
    return "betterc0de"
  if (key.includes("BetterC0de")) return "betterc0de"
  if (key.includes("openrouter")) return "openrouter"
  if (key.includes("lmstudio")) return "lmstudio"
  if (key.includes("openai")) return "openai"
  // Must run before the bare "grok" check — the CLI is a distinct kind.
  if (key.includes("grokcli")) return "grok_cli"
  if (key.includes("grok")) return "grok"
  if (key.includes("deepseek")) return "deepseek"
  if (key.includes("google") || key.includes("gemini")) return "google"
  return undefined
}

function shouldIncludeInstance(
  baseLabel: string,
  providerKind: string | undefined,
  providerInstanceId: string | undefined
) {
  if (!providerInstanceId) return false
  const instanceKey = compact(providerInstanceId)
  if (!instanceKey || instanceKey === "default") return false
  if (providerKind && instanceKey === compact(providerKind)) return false
  if (instanceKey === compact(baseLabel)) return false
  return true
}

function titleizeProvider(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part.length <= 3
        ? part.toUpperCase()
        : `${part.charAt(0).toUpperCase()}${part.slice(1)}`
    )
    .join(" ")
}

function compact(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}
