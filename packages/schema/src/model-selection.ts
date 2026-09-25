import { z } from "zod"

export const providerOptionChoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
})
export type ProviderOptionChoice = z.infer<typeof providerOptionChoiceSchema>

const providerOptionDescriptorBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
})

export const selectProviderOptionDescriptorSchema =
  providerOptionDescriptorBaseSchema.extend({
    type: z.literal("select"),
    options: z.array(providerOptionChoiceSchema),
    currentValue: z.string().min(1).optional(),
    promptInjectedValues: z.array(z.string().min(1)).optional(),
  })
export type SelectProviderOptionDescriptor = z.infer<
  typeof selectProviderOptionDescriptorSchema
>

export const booleanProviderOptionDescriptorSchema =
  providerOptionDescriptorBaseSchema.extend({
    type: z.literal("boolean"),
    currentValue: z.boolean().optional(),
  })
export type BooleanProviderOptionDescriptor = z.infer<
  typeof booleanProviderOptionDescriptorSchema
>

export const providerOptionDescriptorSchema = z.discriminatedUnion("type", [
  selectProviderOptionDescriptorSchema,
  booleanProviderOptionDescriptorSchema,
])
export type ProviderOptionDescriptor = z.infer<
  typeof providerOptionDescriptorSchema
>

export const modelCapabilitiesSchema = z.object({
  attachment: z.boolean().optional(),
  optionDescriptors: z.array(providerOptionDescriptorSchema).optional(),
})
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>

export const providerOptionSelectionSchema = z.object({
  id: z.string().min(1),
  value: z.union([z.string(), z.boolean()]),
})
export type ProviderOptionSelection = z.infer<
  typeof providerOptionSelectionSchema
>

export const providerOptionSelectionsSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
  const selections: ProviderOptionSelection[] = []
  for (const [rawId, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = rawId.trim()
    if (!id) continue
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (trimmed) selections.push({ id, value: trimmed })
      continue
    }
    if (typeof value === "boolean") selections.push({ id, value })
  }
  return selections
}, z.array(providerOptionSelectionSchema))
export type ProviderOptionSelections = z.infer<
  typeof providerOptionSelectionsSchema
>

export const modelSelectionSchema = z.object({
  instanceId: z.string().min(1),
  model: z.string().min(1),
  options: providerOptionSelectionsSchema.optional(),
})
export type ModelSelection = z.infer<typeof modelSelectionSchema>

export const DEFAULT_MODEL = "gpt-5.4"
export const DEFAULT_GIT_TEXT_GENERATION_MODEL = "gpt-5.4-mini"

/** Picker policy only; legacy backend adapters remain available for history. */
export function isHiddenChatProvider(
  ...identifiers: (string | undefined)[]
): boolean {
  return identifiers.some((identifier) => {
    const key = identifier?.toLowerCase().replace(/[^a-z0-9]/g, "")
    return Boolean(
      key?.includes("claude") &&
      (key.includes("terminal") || key.includes("pty"))
    )
  })
}

/** Shared by desktop and mobile when no usable explicit selection exists. */
export function chatProviderPriority(kind: string): number {
  switch (kind.toLowerCase().replace(/[^a-z0-9]/g, "")) {
    case "claude":
    case "claudecli":
    case "claudeagent":
    case "anthropiccli":
      return 0
    case "codex":
    case "codexcli":
      return 1
    case "cursor":
      return 2
    case "grokcli":
      return 3
    default:
      return 4
  }
}

export const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  codex: DEFAULT_MODEL,
  claude: "claude-sonnet-4-6",
  claudeAgent: "claude-sonnet-4-6",
  cursor: "auto",
  betterc0de: "openai/gpt-5",
}

export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<
  string,
  string
> = {
  codex: DEFAULT_GIT_TEXT_GENERATION_MODEL,
  claude: "claude-haiku-4-5",
  claudeAgent: "claude-haiku-4-5",
  cursor: "composer-2",
  betterc0de: "openai/gpt-5",
}

const CODEX_MODEL_SLUG_ALIASES: Record<string, string> = {
  "gpt-5-codex": "gpt-5.4",
  "5.4": "gpt-5.4",
  "5.3": "gpt-5.3-codex",
  "gpt-5.3": "gpt-5.3-codex",
  "5.3-spark": "gpt-5.3-codex-spark",
  "gpt-5.3-spark": "gpt-5.3-codex-spark",
}

const CLAUDE_MODEL_SLUG_ALIASES: Record<string, string> = {
  fable: "claude-fable-5-1",
  "fable-5": "claude-fable-5",
  "fable-5.0": "claude-fable-5",
  "claude-fable-5": "claude-fable-5",
  "fable-5.1": "claude-fable-5-1",
  "fable-5-1": "claude-fable-5-1",
  "claude-fable-5-1": "claude-fable-5-1",
  opus: "claude-opus-5",
  "opus-5": "claude-opus-5",
  "opus-5.0": "claude-opus-5",
  "claude-opus-5": "claude-opus-5",
  "opus-4.8": "claude-opus-4-8",
  "claude-opus-4.8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "claude-opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4-6-20251117": "claude-opus-4-6",
  sonnet: "claude-sonnet-5",
  "sonnet-5": "claude-sonnet-5",
  "sonnet-5.0": "claude-sonnet-5",
  "claude-sonnet-5": "claude-sonnet-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  "haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
}

const CURSOR_MODEL_SLUG_ALIASES: Record<string, string> = {
  composer: "composer-2",
  "composer-1.5": "composer-1.5",
  "composer-1": "composer-1.5",
  "opus-4.6-thinking": "claude-opus-4-6",
  "opus-4.6": "claude-opus-4-6",
  "sonnet-4.6-thinking": "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "opus-4.5-thinking": "claude-opus-4-5",
  "opus-4.5": "claude-opus-4-5",
}

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<
  "codex" | "claude" | "cursor" | "betterc0de",
  Record<string, string>
> = {
  codex: CODEX_MODEL_SLUG_ALIASES,
  claude: CLAUDE_MODEL_SLUG_ALIASES,
  cursor: CURSOR_MODEL_SLUG_ALIASES,
  betterc0de: {},
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider?: string | null
): string | null {
  if (typeof model !== "string") return null
  const trimmed = model.trim()
  if (!trimmed) return null

  const aliasKey = trimmed.toLowerCase()
  const ownAlias = (aliases: Record<string, string>): string | undefined =>
    Object.hasOwn(aliases, aliasKey) ? aliases[aliasKey] : undefined
  const providerFamily = normalizeModelAliasProvider(provider)
  if (providerFamily) {
    return ownAlias(MODEL_SLUG_ALIASES_BY_PROVIDER[providerFamily]) ?? trimmed
  }
  return (
    ownAlias(CODEX_MODEL_SLUG_ALIASES) ??
    ownAlias(CLAUDE_MODEL_SLUG_ALIASES) ??
    ownAlias(CURSOR_MODEL_SLUG_ALIASES) ??
    trimmed
  )
}

export function resolveSelectableModel(
  provider: string | null | undefined,
  value: string | null | undefined,
  options: ReadonlyArray<{ slug?: string; id?: string; name: string }>
): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const direct = options.find(
    (option) => (option.slug ?? option.id) === trimmed
  )
  if (direct) return direct.slug ?? direct.id ?? null

  const byName = options.find(
    (option) => option.name.toLowerCase() === trimmed.toLowerCase()
  )
  if (byName) return byName.slug ?? byName.id ?? null

  const normalized = normalizeModelSlug(trimmed, provider)
  if (!normalized) return null
  return options.find((option) => (option.slug ?? option.id) === normalized)
    ? normalized
    : null
}

function normalizeModelAliasProvider(
  provider: string | null | undefined
): "codex" | "claude" | "cursor" | "betterc0de" | null {
  const normalized = provider
    ?.trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
  if (!normalized) return null
  const compact = normalized.replace(/-/g, "")
  if (normalized === "codex" || normalized.startsWith("codex-")) return "codex"
  if (
    normalized === "claude" ||
    compact === "claudeagent" ||
    normalized === "claude-agent" ||
    normalized === "anthropic" ||
    normalized === "anthropic-cli" ||
    normalized.startsWith("claude-")
  ) {
    return "claude"
  }
  if (normalized === "cursor" || normalized.startsWith("cursor-"))
    return "cursor"
  if (
    normalized === "betterc0de" ||
    normalized === "bettercode" ||
    normalized.startsWith("betterc0de-") ||
    normalized.startsWith("bettercode-")
  ) {
    return "betterc0de"
  }
  return null
}

export function getProviderOptionSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string
): string | boolean | undefined {
  return selections?.find((selection) => selection.id === id)?.value
}

export function getProviderOptionStringSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string
): string | undefined {
  const value = getProviderOptionSelectionValue(selections, id)
  return typeof value === "string" ? value : undefined
}

export function getProviderOptionBooleanSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string
): boolean | undefined {
  const value = getProviderOptionSelectionValue(selections, id)
  return typeof value === "boolean" ? value : undefined
}

export function getModelSelectionOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string
): string | boolean | undefined {
  return getProviderOptionSelectionValue(modelSelection?.options, id)
}

export function getModelSelectionStringOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string
): string | undefined {
  return getProviderOptionStringSelectionValue(modelSelection?.options, id)
}

export function getModelSelectionBooleanOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string
): boolean | undefined {
  return getProviderOptionBooleanSelectionValue(modelSelection?.options, id)
}

export function createModelCapabilities(input: {
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>
}): ModelCapabilities {
  return {
    optionDescriptors: input.optionDescriptors.map(cloneDescriptor),
  }
}

export function getProviderOptionDescriptors(input: {
  caps: ModelCapabilities | null | undefined
  selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined
}): ReadonlyArray<ProviderOptionDescriptor> {
  const { caps, selections } = input
  const baseDescriptors = (caps?.optionDescriptors ?? []).map(cloneDescriptor)

  return baseDescriptors.map((descriptor) =>
    withDescriptorCurrentValue(
      descriptor,
      getProviderOptionSelectionValue(selections, descriptor.id) ??
        getProviderOptionCurrentValue(descriptor)
    )
  )
}

export function getProviderOptionCurrentValue(
  descriptor: ProviderOptionDescriptor | null | undefined
): string | boolean | undefined {
  if (!descriptor) return undefined
  if (descriptor.type === "boolean") return descriptor.currentValue
  if (descriptor.currentValue) return descriptor.currentValue
  return descriptor.options.find((option) => option.isDefault)?.id
}

export function buildProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined
): Array<ProviderOptionSelection> | undefined {
  if (!descriptors || descriptors.length === 0) return undefined

  const selections: ProviderOptionSelection[] = []
  for (const descriptor of descriptors) {
    const value = getProviderOptionCurrentValue(descriptor)
    if (typeof value === "string" || typeof value === "boolean") {
      selections.push({ id: descriptor.id, value })
    }
  }
  return selections.length > 0 ? selections : undefined
}

export function isClaudeUltrathinkPrompt(
  text: string | null | undefined
): boolean {
  return typeof text === "string" && /\bultrathink\b/i.test(text)
}

export function resolvePromptInjectedEffort(
  caps: ModelCapabilities | null | undefined,
  rawEffort: string | null | undefined
): string | null {
  const effort = trimOrNull(rawEffort)
  const allowed = getProviderOptionDescriptors({ caps }).some(
    (option) =>
      option.type === "select" &&
      option.promptInjectedValues?.some((value) => value === effort)
  )
  return allowed ? effort : null
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: string | null | undefined
): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  if (effort === "ultrathink") {
    if (/^Ultrathink:/i.test(trimmed)) return trimmed
    return `Ultrathink:\n${trimmed}`
  }
  if (effort === "ultracode") {
    // Claude Code arms multi-agent workflow orchestration when the keyword
    // "ultracode" appears in the prompt; keep it lowercase to match the
    // harness's trigger exactly.
    if (/\bultracode\b/i.test(trimmed)) return trimmed
    return `ultracode:\n${trimmed}`
  }
  return trimmed
}

function cloneDescriptor(
  descriptor: ProviderOptionDescriptor
): ProviderOptionDescriptor {
  if (descriptor.type === "boolean") return { ...descriptor }
  return {
    ...descriptor,
    options: descriptor.options.map((option) => ({ ...option })),
    ...(descriptor.promptInjectedValues
      ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
      : {}),
  }
}

function withDescriptorCurrentValue(
  descriptor: ProviderOptionDescriptor,
  rawCurrentValue: string | boolean | undefined
): ProviderOptionDescriptor {
  if (descriptor.type === "boolean") {
    return typeof rawCurrentValue === "boolean"
      ? { ...descriptor, currentValue: rawCurrentValue }
      : descriptor
  }
  const next = { ...descriptor }
  const selection =
    typeof rawCurrentValue === "string"
      ? rawCurrentValue
      : descriptor.currentValue
  const current = resolveDescriptorChoiceValue(descriptor, selection)
  delete next.currentValue
  if (current) next.currentValue = current
  return next
}

function resolveDescriptorChoiceValue(
  descriptor: SelectProviderOptionDescriptor,
  raw: string | null | undefined
): string | undefined {
  const requested = raw?.trim()
  const defaultChoice = () =>
    descriptor.options.find((choice) => choice.isDefault)?.id
  const retained = () => descriptor.currentValue ?? defaultChoice()
  if (!requested) return retained()
  if (!descriptor.options.length) return requested
  const available = descriptor.options.find((choice) => choice.id === requested)
  if (!available) return retained()
  return descriptor.promptInjectedValues?.includes(available.id)
    ? defaultChoice()
    : available.id
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}
