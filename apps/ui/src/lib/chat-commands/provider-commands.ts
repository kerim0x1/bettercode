import { stringifyCliArgs } from "@/lib/cli-parse"
import type { UiProvider } from "@/lib/provider-types"
import {
  getProviderOptionCurrentValue,
  type ProviderOptionSelection,
  type SelectProviderOptionDescriptor,
} from "@betterc0de/schema"
import { formatListPlain } from "./input-context"
import {
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import { escapeMarkdownTableCell } from "./provider-config"

export type ModelVariantCycleResult =
  | {
      ok: true
      providerId: string
      providerName: string
      modelId: string
      modelName: string
      descriptorId: string
      descriptorLabel: string
      previousValue: string | undefined
      previousLabel: string | undefined
      nextValue: string | undefined
      nextLabel: string | undefined
      optionSelections: ProviderOptionSelection[]
    }
  | { ok: false; output: string }

export function cycleProviderModelSelectOptionSelection(input: {
  provider: UiProvider | undefined
  selectedModel: string
  optionSelections?: ReadonlyArray<ProviderOptionSelection> | null
  requestedOptionId?: string | null
  descriptorId: string
  direction: 1 | -1
  allowDefaultSelection: boolean
  title: string
  missingMessage: string
}): ModelVariantCycleResult {
  const { provider, selectedModel } = input
  const model = provider?.models.find((entry) => entry.id === selectedModel)
  if (!provider || !model) {
    return {
      ok: false,
      output: [
        `# ${input.title}\n`,
        "> No active provider/model is selected.",
        "",
        provider
          ? `Selected: **${provider.name}** / \`${selectedModel}\``
          : "No provider selected.",
      ].join("\n"),
    }
  }

  const descriptor = resolveCycleSelectDescriptor(
    model,
    input.descriptorId,
    input.requestedOptionId
  )
  if (!descriptor) {
    return {
      ok: false,
      output: [
        `# ${input.title}\n`,
        `> ${input.missingMessage}`,
        "",
        `Selected: **${provider.name}** / \`${model.name || selectedModel}\``,
      ].join("\n"),
    }
  }

  const variants = descriptor.options.map((option) => option.id)
  const selectedValue = selectedOptionValue(
    input.optionSelections,
    descriptor.id,
    variants
  )
  const configuredRaw = getProviderOptionCurrentValue(descriptor)
  const configuredValue =
    typeof configuredRaw === "string" && variants.includes(configuredRaw)
      ? configuredRaw
      : undefined
  const previousValue = resolveModelVariantValue({
    variants,
    selected: selectedValue,
    configured: configuredValue,
  })
  const nextValue = cycleModelVariantValue({
    variants,
    selected: selectedValue,
    configured: configuredValue,
    direction: input.direction,
    allowDefaultSelection: input.allowDefaultSelection,
  })
  const nextSelections = writeProviderOptionSelection(
    input.optionSelections,
    descriptor.id,
    nextValue
  )

  return {
    ok: true,
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    modelName: model.name || model.id,
    descriptorId: descriptor.id,
    descriptorLabel: descriptor.label || descriptor.id,
    previousValue,
    previousLabel: optionChoiceLabel(descriptor, previousValue),
    nextValue,
    nextLabel: optionChoiceLabel(descriptor, nextValue),
    optionSelections: nextSelections,
  }
}

export function resolveModelVariantValue(input: {
  variants: ReadonlyArray<string>
  selected: string | null | undefined
  configured: string | undefined
}): string | undefined {
  if (input.selected === null) return undefined
  if (input.selected && input.variants.includes(input.selected)) {
    return input.selected
  }
  if (input.configured && input.variants.includes(input.configured)) {
    return input.configured
  }
  return undefined
}

export function cycleModelVariantValue(input: {
  variants: ReadonlyArray<string>
  selected: string | null | undefined
  configured: string | undefined
  direction?: 1 | -1
  allowDefaultSelection?: boolean
}): string | undefined {
  if (input.variants.length === 0) return undefined
  const direction = input.direction ?? 1
  const allowDefault = input.allowDefaultSelection ?? true
  if (input.selected === null) {
    return direction === 1
      ? input.variants[0]
      : input.variants[input.variants.length - 1]
  }
  if (input.selected && input.variants.includes(input.selected)) {
    const index = input.variants.indexOf(input.selected)
    if (direction === 1) {
      if (index === input.variants.length - 1) {
        return allowDefault ? undefined : input.variants[0]
      }
      return input.variants[index + 1]
    }
    if (index === 0) {
      return allowDefault
        ? undefined
        : input.variants[input.variants.length - 1]
    }
    return input.variants[index - 1]
  }
  if (input.configured && input.variants.includes(input.configured)) {
    const index = input.variants.indexOf(input.configured)
    if (direction === 1) {
      if (index === input.variants.length - 1) return input.variants[0]
      return input.variants[index + 1]
    }
    if (index === 0) return input.variants[input.variants.length - 1]
    return input.variants[index - 1]
  }
  return direction === 1
    ? input.variants[0]
    : input.variants[input.variants.length - 1]
}

function resolveCycleSelectDescriptor(
  model: UiProvider["models"][number],
  descriptorId: string,
  requestedOptionId: string | null | undefined
): SelectProviderOptionDescriptor | undefined {
  const descriptors = (model.capabilities?.optionDescriptors ?? []).filter(
    (descriptor): descriptor is SelectProviderOptionDescriptor =>
      descriptor.type === "select" && descriptor.options.length > 0
  )
  const requested = requestedOptionId?.trim()
  if (requested) {
    return descriptors.find(
      (descriptor) =>
        descriptor.id.toLowerCase() === requested.toLowerCase() ||
        descriptor.label.toLowerCase() === requested.toLowerCase()
    )
  }
  return descriptors.find((descriptor) => descriptor.id === descriptorId)
}

export function selectedOptionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  optionId: string,
  validValues: ReadonlyArray<string>
): string | undefined {
  const value = selections?.find(
    (selection) => selection.id === optionId
  )?.value
  return typeof value === "string" && validValues.includes(value)
    ? value
    : undefined
}

function writeProviderOptionSelection(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  optionId: string,
  value: string | undefined
): ProviderOptionSelection[] {
  const next = (selections ?? []).filter(
    (selection) => selection.id !== optionId
  )
  if (value) next.push({ id: optionId, value })
  return next
}

function optionChoiceLabel(
  descriptor: SelectProviderOptionDescriptor,
  value: string | undefined
): string | undefined {
  if (!value) return undefined
  return descriptor.options.find((option) => option.id === value)?.label
}

export function buildProviderConnectionOutput(
  provider: UiProvider | undefined,
  command = "/connect",
  args: ReadonlyArray<string> = []
): string {
  const terminalCommand = buildBetterC0deProviderConnectTerminalCommand(
    command,
    args,
    provider
  )
  const validation = buildBetterC0deProviderConnectValidationMessages(
    command,
    args
  )
  if (!provider) {
    return [
      "# Connect Provider",
      "",
      "> No provider is selected. Open the model picker with `/models`, then choose a provider.",
      "",
      terminalCommand.shouldOpen && terminalCommand.command
        ? [
            "## Terminal",
            "",
            "```sh",
            terminalCommand.command,
            "```",
            "",
            "> Opened the terminal panel with this command prefilled.",
          ].join("\n")
        : "",
      validation.length > 0
        ? ["## Validation", "", ...validation.map((item) => `- ${item}`)].join(
            "\n"
          )
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  }
  const status =
    provider.configured === false
      ? "Needs setup"
      : provider.status === "ready" || provider.configured === true
        ? "Ready"
        : "Unknown"
  return [
    "# Connect Provider\n",
    "| | |",
    "|:--|:--|",
    `| **Provider** | ${escapeMarkdownTableCell(provider.name)} |`,
    `| **Status** | ${status} |`,
    provider.setupHint
      ? `| **Setup** | ${escapeMarkdownTableCell(provider.setupHint)} |`
      : "",
    "",
    "## Compatibility references",
    "",
    "| Compatibility CLI | BetterC0de |",
    "|:---------|:-----------|",
    "| `betterc0de providers login --provider <id>` | `/connect` or Settings > Providers |",
    "| `betterc0de auth login --provider <id>` | `/auth.login --provider <id>` or `/auth login --provider <id>` |",
    "| `betterc0de providers login --provider <id> --method <label>` | `/providers.login --provider <id> --method <label> --terminal` for plugin auth methods |",
    "| `betterc0de providers login <url>` | `/console.login <url>` for console-style auth metadata |",
    "| `betterc0de console login <url>` | `/console.login <url>` and provider settings |",
    "| `betterc0de console open` | `/console.open` and provider settings |",
    "",
    ...buildBetterC0deProviderLoginNotes(provider, args),
    validation.length > 0
      ? ["## Validation", "", ...validation.map((item) => `- ${item}`)].join(
          "\n"
        )
      : "",
    terminalCommand.shouldOpen && terminalCommand.command
      ? [
          "## Terminal",
          "",
          "```sh",
          terminalCommand.command,
          "```",
          "",
          "> Opened the terminal panel with this command prefilled. Enter credentials only in the terminal/provider flow, not in chat.",
        ].join("\n")
      : "> Add `--terminal` to prefill the matching BetterC0de compatibility provider or console login command in the integrated terminal.",
    "",
    "> Open Settings > Providers for keys, OAuth, CLI status, provider updates, skills, agents, and native slash-command metadata. Well-known and plugin provider auth stay in the terminal/provider flow so secrets never enter chat.",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildProviderAuthOutput(
  providers: ReadonlyArray<UiProvider>,
  selectedProvider: UiProvider | undefined,
  command = "/auth",
  args: ReadonlyArray<string> = []
): string {
  if (providers.length === 0) {
    return "# Provider Auth\n\n> No provider metadata is loaded yet."
  }
  const terminalCommand = buildBetterC0deProviderAuthTerminalCommand(
    command,
    args
  )
  const validation = buildBetterC0deProviderAuthValidationMessages(
    command,
    args
  )
  const sorted = [...providers].sort((left, right) =>
    left.name.localeCompare(right.name)
  )
  return [
    "# Provider Auth\n",
    "Compatibility references: `auth.list` / `auth.get` / `providers list` / `providers logout`.",
    "",
    selectedProvider
      ? `Selected: **${escapeMarkdownTableCell(selectedProvider.name)}**`
      : "Selected: none",
    "",
    "| Provider | Auth | Status | Env | Availability | Setup |",
    "|:---------|:-----|:-------|:----|:-------------|:------|",
    ...sorted.map(
      (provider) =>
        `| **${escapeMarkdownTableCell(provider.name)}** | ${escapeMarkdownTableCell(provider.authType ?? "-")} | ${escapeMarkdownTableCell(formatProviderAuthStatus(provider))} | ${escapeMarkdownTableCell(formatProviderEnvironment(provider))} | ${escapeMarkdownTableCell(formatProviderAvailability(provider))} | ${escapeMarkdownTableCell(provider.setupHint ?? provider.unavailableReason ?? "-")} |`
    ),
    "",
    "## Compatibility account commands",
    "",
    "| Compatibility CLI | BetterC0de |",
    "|:---------|:-----------|",
    "| `betterc0de providers list` | `/auth` or `/providers.list` |",
    "| `betterc0de auth list` | `/auth.list` or `/auth list` |",
    "| `betterc0de providers logout` | `/providers.logout` |",
    "| `betterc0de auth logout` | `/auth.logout` or `/auth logout` |",
    "| `betterc0de console logout [email]` | `/console.logout` or `/account.logout` |",
    "| `betterc0de console orgs` | `/account.orgs` |",
    "| `betterc0de console switch` | `/account.switch` |",
    "| `betterc0de console open` | `/account.open` |",
    "",
    validation.length > 0
      ? [
          "## Validation",
          "",
          ...validation.map((item) => `- ${item}`),
          "",
        ].join("\n")
      : "",
    terminalCommand.shouldOpen && terminalCommand.command
      ? [
          "## Terminal",
          "",
          "```sh",
          terminalCommand.command,
          "```",
          "",
          "> Opened the terminal panel with this command prefilled. BetterC0de does not remove credentials directly from chat.",
        ].join("\n")
      : "> Add `--terminal` to prefill `betterc0de providers list`, `betterc0de providers logout`, or `betterc0de console logout` in the integrated terminal.",
    "",
    "> Use `/connect` for the selected provider or `/settings providers` to edit credentials and OAuth/CLI setup.",
  ].join("\n")
}

export function buildBetterC0deProviderConnectTerminalCommand(
  command: string,
  args: ReadonlyArray<string>,
  selectedProvider: UiProvider | undefined
): { command: string; shouldOpen: boolean } {
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  const normalized = command.replace(/^\//, "").toLowerCase()
  const shouldOpen = args.some(isBetterC0deRuntimeTerminalFlag)
  const providerCommand = normalized.startsWith("auth.")
    ? "betterc0de auth login"
    : "betterc0de providers login"
  if (normalized.includes("console") || normalized.includes("account")) {
    const mode = normalized.includes("open") ? "open" : "login"
    if (mode === "open") {
      return {
        command: "betterc0de console open",
        shouldOpen,
      }
    }
    return {
      command: ["betterc0de console", mode, stringifyCliArgs(cleanArgs)]
        .filter(Boolean)
        .join(" "),
      shouldOpen,
    }
  }

  const loginArgs =
    cleanArgs.length > 0
      ? cleanArgs
      : selectedProvider?.id
        ? ["--provider", selectedProvider.id]
        : []
  return {
    command: [providerCommand, stringifyCliArgs(loginArgs)]
      .filter(Boolean)
      .join(" "),
    shouldOpen,
  }
}

function buildBetterC0deProviderConnectValidationMessages(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  const normalized = command.replace(/^\//, "").toLowerCase()
  const messages = maintenanceMissingValueMessages(cleanArgs, [
    "--provider",
    "-p",
    "--method",
    "-m",
  ])
  const positionalUrl = firstBetterC0deProviderLoginPositionalArg(cleanArgs)
  const isConsoleLogin =
    (normalized.includes("console") || normalized.includes("account")) &&
    normalized.includes("login")
  const isConsoleOpen =
    (normalized.includes("console") || normalized.includes("account")) &&
    normalized.includes("open")

  if (isConsoleOpen && cleanArgs.length > 0) {
    messages.push(
      "Compatibility console open does not accept arguments; it opens the active account."
    )
  }
  if (isConsoleLogin && !positionalUrl) {
    messages.push("Compatibility console login requires a server URL.")
  }
  if (positionalUrl && !isValidHttpUrl(positionalUrl)) {
    if (isConsoleLogin) {
      messages.push(
        "Compatibility console login URL must be a valid `http://` or `https://` URL."
      )
    } else if (!isConsoleOpen) {
      messages.push(
        "BetterC0de compatibility provider login URL must be a valid `http://` or `https://` URL."
      )
    }
  }
  return messages
}

function buildBetterC0deProviderLoginNotes(
  selectedProvider: UiProvider | undefined,
  args: ReadonlyArray<string>
): string[] {
  const target = resolveBetterC0deProviderLoginTarget(selectedProvider, args)
  const notes: string[] = []

  if (target.kind === "wellknown") {
    notes.push(
      "BetterC0de well-known login fetches `/.well-known/betterc0de`, runs the returned auth command in the terminal, and stores a well-known credential for that URL."
    )
  }

  if (target.provider === "betterc0de" || target.provider === "betterc0de") {
    notes.push(
      "BetterC0de compatibility provider login uses the configured provider auth flow before asking for the API key."
    )
  }
  if (target.provider === "vercel") {
    notes.push(
      "BetterC0de compatibility provider login points Vercel users to `https://vercel.link/ai-gateway-token`."
    )
  }
  if (
    target.provider === "cloudflare" ||
    target.provider === "cloudflare-ai-gateway"
  ) {
    notes.push(
      "BetterC0de Cloudflare AI Gateway login expects `CLOUDFLARE_GATEWAY_ID`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` to be configured through environment or provider config."
    )
  }
  if (target.provider === "amazon-bedrock") {
    notes.push(
      "BetterC0de Amazon Bedrock auth prefers a bearer token first, then the AWS credential chain; provider options like profile, region, and endpoint still live in `betterc0de.json`."
    )
  }
  if (target.provider === "other") {
    notes.push(
      "the compatibility CLI's `Other` provider path only stores a credential; the custom provider still needs matching `betterc0de.json` provider configuration."
    )
  }

  if (notes.length === 0) return []
  return [
    "## Compatibility login notes",
    "",
    ...notes.map((note) => `- ${note}`),
    "",
  ]
}

function resolveBetterC0deProviderLoginTarget(
  selectedProvider: UiProvider | undefined,
  args: ReadonlyArray<string>
): { kind: "provider" | "wellknown"; provider?: string } {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  const providerArg = betterC0deCliOptionValue(cleanArgs, "--provider", "-p")
  if (providerArg?.trim()) {
    return {
      kind: "provider",
      provider: normalizeBetterC0deProviderLoginTarget(providerArg),
    }
  }

  const positionalUrl = firstBetterC0deProviderLoginPositionalArg(cleanArgs)
  if (positionalUrl) return { kind: "wellknown" }

  return {
    kind: "provider",
    provider: normalizeBetterC0deProviderLoginTarget(
      selectedProvider?.id ?? ""
    ),
  }
}

function normalizeBetterC0deProviderLoginTarget(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@ai-sdk\//, "")
    .replace(/[_\s]+/g, "-")
}

function firstBetterC0deProviderLoginPositionalArg(
  args: ReadonlyArray<string>
): string | undefined {
  const optionsWithValues = new Set(["--provider", "-p", "--method", "-m"])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--") {
      return args.slice(index + 1).find((item) => item.trim().length > 0)
    }
    if (
      Array.from(optionsWithValues).some((option) =>
        arg.startsWith(`${option}=`)
      )
    ) {
      continue
    }
    if (optionsWithValues.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith("-")) continue
    if (arg.trim().length > 0) return arg
  }
  return undefined
}

export function buildBetterC0deProviderAuthTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  const normalized = command.replace(/^\//, "").toLowerCase()
  const shouldOpen = args.some(isBetterC0deRuntimeTerminalFlag)
  if (normalized.includes("console") || normalized.includes("account")) {
    const mode = normalized.includes("logout") ? "logout" : "orgs"
    return {
      command: ["betterc0de console", mode, stringifyCliArgs(cleanArgs)]
        .filter(Boolean)
        .join(" "),
      shouldOpen,
    }
  }
  if (normalized.includes("logout")) {
    return {
      command: normalized.startsWith("auth.")
        ? "betterc0de auth logout"
        : "betterc0de providers logout",
      shouldOpen,
    }
  }
  return {
    command: normalized.startsWith("auth.")
      ? "betterc0de auth list"
      : "betterc0de providers list",
    shouldOpen,
  }
}

function buildBetterC0deProviderAuthValidationMessages(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  const normalized = command.replace(/^\//, "").toLowerCase()
  const messages: string[] = []
  if (normalized.includes("console") || normalized.includes("account")) {
    return messages
  }
  if (normalized.includes("logout") && cleanArgs.length > 0) {
    messages.push(
      "BetterC0de compatibility providers logout does not accept provider arguments; it opens an interactive credential picker."
    )
  } else if (cleanArgs.length > 0) {
    messages.push(
      "BetterC0de compatibility providers list does not accept arguments; it lists stored credentials and active provider environment variables."
    )
  }
  return messages
}

function formatProviderAuthStatus(provider: UiProvider): string {
  if (provider.configured === false) return "Needs setup"
  if (provider.status === "ready" || provider.configured === true)
    return "Ready"
  if (provider.status) return provider.status
  return "Unknown"
}

function formatProviderAvailability(provider: UiProvider): string {
  const parts = [
    provider.availability,
    provider.statusMessage,
    provider.unavailableReason,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(" - ") : "-"
}

function formatProviderEnvironment(provider: UiProvider): string {
  const environment = provider.environment ?? []
  if (environment.length === 0) return "-"
  return environment
    .map((entry) => {
      if (entry.sensitive || entry.valueRedacted)
        return `${entry.name} redacted`
      if (entry.value) return `${entry.name} set`
      return entry.name
    })
    .join(", ")
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

export function betterC0deCliOptionValue(
  args: ReadonlyArray<string>,
  ...names: string[]
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (names.includes(arg)) return args[index + 1] ?? ""
    for (const name of names) {
      const prefix = `${name}=`
      if (arg.startsWith(prefix)) return arg.slice(prefix.length)
    }
  }
  return undefined
}

export function maintenanceMissingValueMessages(
  args: ReadonlyArray<string>,
  options: ReadonlyArray<string>
): string[] {
  const messages: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--") break
    const inlineOption = options.find((option) => arg.startsWith(`${option}=`))
    if (inlineOption) {
      if (!arg.slice(`${inlineOption}=`.length).trim()) {
        messages.push(`${inlineOption} requires a value.`)
      }
      continue
    }
    if (!options.includes(arg)) continue
    const value = args[index + 1]
    if (!value || value.startsWith("-")) {
      messages.push(`${arg} requires a value.`)
    } else {
      index += 1
    }
  }
  return messages
}

type ProviderCatalogModelRow = {
  providerId: string
  catalogProviderId: string
  providerName: string
  modelId: string
  modelName: string
  status: string
  context: string
  cost: string
  variants: string
}

type ProviderModelCatalogCost = NonNullable<
  NonNullable<UiProvider["models"][number]["catalog"]>["cost"]
>

export function buildProviderCatalogOutput(
  providers: ReadonlyArray<UiProvider>,
  args: readonly string[] = []
): string {
  const request = parseProviderCatalogArgs(args, providers)
  const terminalCommand = buildBetterC0deModelsTerminalCommand(args, providers)
  const full = request.full
  const refreshRequested = request.refresh
  if (request.validation.length > 0) {
    return [
      "# Model Catalog\n",
      "## Validation",
      "",
      ...request.validation.map((item) => `- ${item}`),
      "",
      "Compatibility reference: `betterc0de models [provider] [--verbose] [--refresh]`.",
      "",
      terminalCommand.shouldOpen && terminalCommand.command
        ? buildModelCatalogTerminalSection(terminalCommand.command)
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  }
  if (request.providerError) {
    return [
      "# Model Catalog\n",
      `> Provider not found: \`${escapeMarkdownTableCell(request.providerError)}\`.`,
      "",
      "Compatibility reference: `betterc0de models [provider]`.",
      "",
      terminalCommand.shouldOpen && terminalCommand.command
        ? buildModelCatalogTerminalSection(terminalCommand.command)
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  const normalizedQuery = normalizeCatalogQuery(request.query)
  const rows = providers
    .flatMap(providerCatalogModelRows)
    .filter((row) => catalogRowMatches(row, request))
    .sort((left, right) =>
      `${left.providerName}/${left.modelName}`.localeCompare(
        `${right.providerName}/${right.modelName}`
      )
    )
  const visibleRows = full ? rows : rows.slice(0, 80)
  const providerInventory = providers
    .flatMap((provider) => provider.providerCatalog ?? [])
    .filter((entry) => {
      if (request.providerFilter) {
        return catalogProviderEntryMatches(entry, request.providerFilter)
      }
      if (!normalizedQuery) return true
      return normalizeCatalogQuery(`${entry.id} ${entry.name}`).includes(
        normalizedQuery
      )
    })

  if (
    providers.length === 0 ||
    (rows.length === 0 && providerInventory.length === 0)
  ) {
    return [
      "# Model Catalog\n",
      normalizedQuery
        ? `> No provider catalog or model matched \`${escapeMarkdownTableCell(request.query)}\`.`
        : "> No provider catalog metadata is loaded yet.",
      "",
      "Open provider settings or wait for provider status sync to refresh catalog metadata.",
      terminalCommand.shouldOpen && terminalCommand.command
        ? `\n${buildModelCatalogTerminalSection(terminalCommand.command)}`
        : "",
    ].join("\n")
  }

  const output = [
    "# Model Catalog\n",
    "Compatibility reference: `betterc0de models` / `catalog.model.list` / `catalog.model.get`.",
    refreshRequested
      ? "> Refresh requested. BetterC0de shows the latest provider metadata already loaded by provider status sync; open Settings > Providers to force provider-specific refresh/setup."
      : "",
    "",
    request.providerFilter
      ? `Provider: \`${escapeMarkdownTableCell(request.providerFilter.raw)}\``
      : normalizedQuery
        ? `Filter: \`${escapeMarkdownTableCell(request.query)}\``
        : "",
    rows.length > visibleRows.length
      ? `> Showing ${visibleRows.length} of ${rows.length} matching models. Use \`/catalog --full\` for all rows.`
      : `> ${rows.length} matching model${rows.length === 1 ? "" : "s"}.`,
    "",
    "| Provider | Model | Name | Status | Context | Cost | Variants |",
    "|:---------|:------|:-----|:-------|:--------|:-----|:---------|",
    ...visibleRows.map(
      (row) =>
        `| ${escapeMarkdownTableCell(row.providerName)} | \`${escapeMarkdownTableCell(row.modelId)}\` | ${escapeMarkdownTableCell(row.modelName)} | ${escapeMarkdownTableCell(row.status)} | ${escapeMarkdownTableCell(row.context)} | ${escapeMarkdownTableCell(row.cost)} | ${escapeMarkdownTableCell(row.variants)} |`
    ),
  ].filter(Boolean)

  if (providerInventory.length > 0) {
    output.push(
      "",
      "## Provider Inventory\n",
      "| Provider | Connected | Enabled | Env | Endpoint |",
      "|:---------|:----------|:--------|:----|:---------|",
      ...providerInventory.slice(0, full ? undefined : 40).map((entry) => {
        const endpoint = entry.endpoint
          ? [entry.endpoint.type, entry.endpoint.url ?? entry.endpoint.package]
              .filter(Boolean)
              .join(" ")
          : "-"
        return `| **${escapeMarkdownTableCell(entry.name)}** (\`${escapeMarkdownTableCell(entry.id)}\`) | ${entry.connected ? "Yes" : "No"} | ${entry.enabled ? "Yes" : "No"} | ${escapeMarkdownTableCell(formatListPlain(entry.env))} | ${escapeMarkdownTableCell(endpoint)} |`
      })
    )
  }

  if (terminalCommand.shouldOpen && terminalCommand.command) {
    output.push("", buildModelCatalogTerminalSection(terminalCommand.command))
  } else {
    output.push(
      "",
      "> Add `--terminal` to prefill `betterc0de models [provider] [--verbose] [--refresh]` in the integrated terminal."
    )
  }

  return output.join("\n")
}

interface ProviderCatalogRequest {
  full: boolean
  refresh: boolean
  query: string
  providerFilter: ProviderCatalogFilter | null
  providerError: string | null
  explicitProvider: string | null
  validation: string[]
}

interface ProviderCatalogFilter {
  raw: string
  normalized: string
}

function parseProviderCatalogArgs(
  args: readonly string[],
  providers: ReadonlyArray<UiProvider>
): ProviderCatalogRequest {
  const values: string[] = []
  let explicitProvider: string | null = null
  let full = false
  let refresh = false
  const validation: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextRequiredValue = (label: string) => {
      if (inlineValue !== undefined) {
        const value = inlineValue.trim()
        if (!value) validation.push(`${label} requires a value.`)
        return value
      }
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        validation.push(`${label} requires a value.`)
        return ""
      }
      index += 1
      return value.trim()
    }
    const parseCatalogBooleanFlag = (
      fallback: boolean,
      label: string
    ): boolean => {
      if (inlineValue === undefined) return fallback
      const value = inlineValue.trim().toLowerCase()
      if (value === "true" || value === "1") return true
      if (value === "false" || value === "0") return false
      validation.push(`\`${label}\` must be true or false.`)
      return fallback
    }

    switch (key) {
      case "--full":
      case "--verbose":
        full = parseCatalogBooleanFlag(true, key)
        break
      case "--no-full":
      case "--no-verbose":
        full = false
        break
      case "--refresh":
        refresh = parseCatalogBooleanFlag(true, "--refresh")
        break
      case "--no-refresh":
        refresh = false
        break
      case "--list":
      case "--terminal":
      case "--open-terminal":
      case "--new-terminal":
        break
      case "--provider":
        explicitProvider = nextRequiredValue("--provider")
        break
      default:
        values.push(arg)
        break
    }
  }

  if (explicitProvider) {
    const providerFilter = resolveProviderCatalogFilter(
      explicitProvider,
      providers
    )
    return {
      full,
      refresh,
      query: values.join(" ").trim(),
      providerFilter,
      providerError: providerFilter ? null : explicitProvider,
      explicitProvider,
      validation,
    }
  }

  const query = values.join(" ").trim()
  const providerFilter =
    values.length === 1
      ? resolveProviderCatalogFilter(values[0] ?? "", providers)
      : null
  return {
    full,
    refresh,
    query: providerFilter ? "" : query,
    providerFilter,
    providerError: null,
    explicitProvider: null,
    validation,
  }
}

function resolveProviderCatalogFilter(
  value: string,
  providers: ReadonlyArray<UiProvider>
): ProviderCatalogFilter | null {
  const normalized = normalizeCatalogQuery(value)
  if (!normalized) return null
  const rows = providers.flatMap(providerCatalogModelRows)
  const providerEntries = providers.flatMap((provider) => [
    provider.id,
    provider.name,
    ...(provider.providerCatalog ?? []).flatMap((entry) => [
      entry.id,
      entry.name,
    ]),
  ])
  const matchesProvider = providerEntries.some(
    (entry) => normalizeCatalogQuery(entry ?? "") === normalized
  )
  const matchesCatalogProvider = rows.some(
    (row) => normalizeCatalogQuery(row.catalogProviderId) === normalized
  )
  return matchesProvider || matchesCatalogProvider
    ? { raw: value, normalized }
    : null
}

export function buildBetterC0deModelsTerminalCommand(
  args: readonly string[],
  providers: ReadonlyArray<UiProvider> = []
): {
  command: string
  shouldOpen: boolean
} {
  const request = parseProviderCatalogArgs(args, providers)
  const cliArgs = args.filter(
    (arg) =>
      !isBetterC0deRuntimeTerminalFlag(arg) &&
      arg !== "--full" &&
      arg !== "--list" &&
      !arg.startsWith("--provider")
  )
  const providerArg = request.providerFilter?.raw ?? request.explicitProvider
  if (providerArg && !cliArgs.some((arg) => !arg.startsWith("-"))) {
    cliArgs.unshift(providerArg)
  }
  return {
    command: ["betterc0de models", stringifyCliArgs([...cliArgs])]
      .filter(Boolean)
      .join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function buildModelCatalogTerminalSection(command: string): string {
  return [
    "## Terminal",
    "",
    "```sh",
    command,
    "```",
    "",
    "> Opened the terminal panel with this BetterC0de models command prefilled.",
  ].join("\n")
}

function providerCatalogModelRows(
  provider: UiProvider
): ProviderCatalogModelRow[] {
  return provider.models.map((model) => {
    const catalog = model.catalog
    return {
      providerId: provider.id,
      catalogProviderId: catalog?.providerId ?? provider.id,
      providerName: provider.name,
      modelId: model.id,
      modelName: model.name,
      status: catalog?.status ?? "-",
      context: formatCatalogContext(model.context, catalog?.limit?.context),
      cost: formatCatalogCost(catalog?.cost),
      variants: catalog?.variants
        ? formatListPlain(Object.keys(catalog.variants))
        : "-",
    }
  })
}

function catalogRowMatches(
  row: ProviderCatalogModelRow,
  request: ProviderCatalogRequest
): boolean {
  if (request.providerFilter) {
    return catalogRowMatchesProvider(row, request.providerFilter)
  }
  const normalizedQuery = normalizeCatalogQuery(request.query)
  if (!normalizedQuery) return true
  return normalizeCatalogQuery(
    `${row.providerId} ${row.catalogProviderId} ${row.providerName} ${row.modelId} ${row.modelName} ${row.status}`
  ).includes(normalizedQuery)
}

function catalogRowMatchesProvider(
  row: ProviderCatalogModelRow,
  filter: ProviderCatalogFilter
): boolean {
  return [
    row.providerId,
    row.catalogProviderId,
    row.providerName,
    row.modelId.split("/")[0] ?? "",
  ].some((value) => normalizeCatalogQuery(value) === filter.normalized)
}

function catalogProviderEntryMatches(
  entry: NonNullable<UiProvider["providerCatalog"]>[number],
  filter: ProviderCatalogFilter
): boolean {
  return [entry.id, entry.name].some(
    (value) => normalizeCatalogQuery(value) === filter.normalized
  )
}

function normalizeCatalogQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

function formatCatalogContext(
  label: string | undefined,
  numericLimit: number | undefined
): string {
  if (typeof numericLimit === "number") {
    return numericLimit.toLocaleString("en-US")
  }
  return label || "-"
}

function formatCatalogCost(cost: ProviderModelCatalogCost | undefined): string {
  if (!cost) return "-"
  const parts = [
    typeof cost.input === "number" ? `in ${cost.input}` : "",
    typeof cost.output === "number" ? `out ${cost.output}` : "",
    typeof cost.cache?.read === "number" ? `cache read ${cost.cache.read}` : "",
    typeof cost.cache?.write === "number"
      ? `cache write ${cost.cache.write}`
      : "",
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : "-"
}
