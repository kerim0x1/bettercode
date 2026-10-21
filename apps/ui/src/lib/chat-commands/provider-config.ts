import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { HttpError } from "@/lib/errors/types"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  readFile,
  writeFile,
  type WorkspaceProjectProvidersSummary,
} from "@/services/backend/workspaceApi"
import { formatListPlain } from "./input-context"

export type ActiveThreadRef = {
  id?: string | null
  projectPath?: string | null
  worktreePath?: string | null
  envMode?: string | null
} | null

export function parseBetterC0deRuntimeList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function buildProjectProvidersOutput(
  summary: WorkspaceProjectProvidersSummary | null,
  activeThread: ActiveThreadRef
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# BetterC0de Project Providers\n\n> No workspace folder is open."
  }
  if (
    !summary ||
    (!summary.defaultModel &&
      !summary.smallModel &&
      summary.enabledProviders.length === 0 &&
      summary.disabledProviders.length === 0 &&
      summary.providers.length === 0 &&
      summary.authAccounts.length === 0)
  ) {
    return [
      "# BetterC0de Project Providers\n",
      "> No BetterC0de compatibility provider config found.",
      "",
      "Add `provider`, `model`, `small_model`, `enabled_providers`, or `disabled_providers` entries to `betterc0de.json` or `betterc0de.jsonc`.",
      "",
      'Use `/project-providers --config-only --provider <id> --name "Provider" --api <api> --npm <package>` to add non-secret provider metadata.',
    ].join("\n")
  }

  const rows = summary.providers.map((provider) => {
    const options = formatProjectProviderOptions(provider)
    return `| **${escapeMarkdownTableCell(provider.name ?? provider.id)}** (\`${escapeMarkdownTableCell(provider.id)}\`) | ${escapeMarkdownTableCell(provider.api ?? "-")} | ${escapeMarkdownTableCell(provider.npm ?? "-")} | ${escapeMarkdownTableCell(formatListPlain(provider.env))} | ${escapeMarkdownTableCell(formatListPlain(provider.whitelist))} | ${escapeMarkdownTableCell(formatListPlain(provider.blacklist))} | ${escapeMarkdownTableCell(options)} | ${provider.models.length} | \`${escapeMarkdownTableCell(provider.sourcePath)}\` |`
  })
  const modelRows = summary.providers.flatMap((provider) =>
    provider.models.map((model) => {
      const capabilities = [
        model.attachment ? "attachments" : "",
        model.reasoning ? "reasoning" : "",
        model.toolCall ? "tools" : "",
        model.temperature ? "temperature" : "",
        model.interleaved
          ? `interleaved${model.interleavedField ? `:${model.interleavedField}` : ""}`
          : "",
        model.experimental ? "experimental" : "",
      ]
        .filter(Boolean)
        .join(", ")
      const limits = [
        model.contextLimit ? `ctx ${model.contextLimit}` : "",
        model.inputLimit ? `in ${model.inputLimit}` : "",
        model.outputLimit ? `out ${model.outputLimit}` : "",
      ]
        .filter(Boolean)
        .join(", ")
      const modalities = formatProjectProviderModelModalities(model)
      const cost = formatProjectProviderModelCost(model)
      const providerRuntime = [
        model.providerApi ? `api ${model.providerApi}` : "",
        model.providerNpm ? `npm ${model.providerNpm}` : "",
      ]
        .filter(Boolean)
        .join(", ")
      const variants =
        model.variants.length > 0
          ? model.variants
              .map((variant) =>
                model.disabledVariants.includes(variant)
                  ? `${variant}(disabled)`
                  : variant
              )
              .join(", ")
          : "-"
      return `| \`${escapeMarkdownTableCell(provider.id)}/${escapeMarkdownTableCell(model.id)}\` | ${escapeMarkdownTableCell(model.name ?? "-")} | ${escapeMarkdownTableCell(model.family ?? "-")} | ${escapeMarkdownTableCell(model.releaseDate ?? "-")} | ${escapeMarkdownTableCell(model.status ?? "-")} | ${escapeMarkdownTableCell(capabilities || "-")} | ${escapeMarkdownTableCell(limits || "-")} | ${escapeMarkdownTableCell(modalities || "-")} | ${escapeMarkdownTableCell(cost || "-")} | ${escapeMarkdownTableCell(providerRuntime || "-")} | ${escapeMarkdownTableCell(formatListPlain(model.optionKeys))} | ${escapeMarkdownTableCell(formatListPlain(model.headerKeys))} | ${escapeMarkdownTableCell(variants)} |`
    })
  )
  const authRows = summary.authAccounts.map((account) => {
    const active = [
      account.activeCredentialType ?? "",
      account.activeExpired ? "expired" : "",
      account.activeDescription ? `desc ${account.activeDescription}` : "",
    ]
      .filter(Boolean)
      .join(", ")
    const metadata = account.metadataKeys?.length
      ? account.metadataKeys.join(", ")
      : "-"
    return `| **${escapeMarkdownTableCell(account.serviceId)}** | ${account.accountCount} | ${escapeMarkdownTableCell(formatListPlain(account.credentialTypes))} | ${escapeMarkdownTableCell(active || "-")} | ${escapeMarkdownTableCell(metadata)} | \`${escapeMarkdownTableCell(account.sourcePath)}\` |`
  })

  return [
    "# BetterC0de Project Providers\n",
    `Loaded from \`${runtimePath}\`.\n`,
    "| Setting | Value |",
    "|:--------|:------|",
    `| Default model | ${summary.defaultModel ? `\`${escapeMarkdownTableCell(summary.defaultModel)}\`` : "-"} |`,
    `| Small model | ${summary.smallModel ? `\`${escapeMarkdownTableCell(summary.smallModel)}\`` : "-"} |`,
    `| Enabled providers | ${escapeMarkdownTableCell(formatListPlain(summary.enabledProviders))} |`,
    `| Disabled providers | ${escapeMarkdownTableCell(formatListPlain(summary.disabledProviders))} |`,
    "",
    "## Providers\n",
    summary.providers.length === 0
      ? "> No custom project providers configured."
      : [
          "| Provider | API | NPM | Env | Allowlist | Blocklist | Options | Models | Source |",
          "|:---------|:----|:----|:----|:----------|:----------|:--------|:-------|:-------|",
          ...rows,
        ].join("\n"),
    "",
    "## Models\n",
    modelRows.length === 0
      ? "> No project provider models configured."
      : [
          "| Model | Name | Family | Release | Status | Capabilities | Limits | Modalities | Cost | Provider | Options | Headers | Variants |",
          "|:------|:-----|:-------|:--------|:-------|:-------------|:-------|:-----------|:-----|:---------|:--------|:--------|:---------|",
          ...modelRows,
        ].join("\n"),
    "",
    "## BetterC0de Auth\n",
    authRows.length === 0
      ? "> No BetterC0de compatibility provider auth accounts found."
      : [
          "| Service | Accounts | Credential types | Active | Metadata keys | Source |",
          "|:--------|---------:|:-----------------|:-------|:--------------|:-------|",
          ...authRows,
        ].join("\n"),
    "",
    "> API keys, OAuth tokens, refresh tokens, and option values are intentionally masked. Configure real credentials in BetterC0de provider settings or environment variables.",
  ].join("\n")
}

function formatProjectProviderOptions(
  provider: WorkspaceProjectProvidersSummary["providers"][number]
): string {
  const knownKeys = new Set([
    "apiKey",
    "baseURL",
    "enterpriseUrl",
    "setCacheKey",
    "timeout",
    "chunkTimeout",
  ])
  const parts = [
    provider.hasApiKey || provider.optionKeys.includes("apiKey")
      ? "apiKey(masked)"
      : "",
    provider.baseURL ? `baseURL ${provider.baseURL}` : "",
    provider.enterpriseUrl ? `enterpriseUrl ${provider.enterpriseUrl}` : "",
    typeof provider.setCacheKey === "boolean"
      ? `setCacheKey ${provider.setCacheKey ? "true" : "false"}`
      : "",
    provider.timeout === false
      ? "timeout disabled"
      : typeof provider.timeout === "number"
        ? `timeout ${provider.timeout}ms`
        : "",
    typeof provider.chunkTimeout === "number"
      ? `chunkTimeout ${provider.chunkTimeout}ms`
      : "",
    ...provider.optionKeys.filter((key) => !knownKeys.has(key)),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : "-"
}

interface ProjectProviderConfigRequest {
  configOnly: boolean
  force: boolean
  providerId?: string
  providerApiId?: string
  name?: string
  api?: string
  npm?: string
  env: string[]
  whitelist: string[]
  blacklist: string[]
  providerOptions: Record<string, unknown>
  baseURL?: string
  enterpriseUrl?: string
  setCacheKey?: boolean
  timeout?: number | false
  chunkTimeout?: number
  defaultModel?: string
  smallModel?: string
  enabledProviders: string[]
  disabledProviders: string[]
  replaceEnabledProviders: boolean
  replaceDisabledProviders: boolean
  modelId?: string
  modelApiId?: string
  modelName?: string
  modelFamily?: string
  modelReleaseDate?: string
  modelStatus?: string
  modelContext?: number
  modelInput?: number
  modelOutput?: number
  modelAttachment?: boolean
  modelReasoning?: boolean
  modelTemperature?: boolean
  modelToolCall?: boolean
  modelInterleaved?: true | { field: "reasoning_content" | "reasoning_details" }
  modelExperimental?: boolean
  modelProviderApi?: string
  modelProviderNpm?: string
  modelOptions: Record<string, unknown>
  modelHeaders: Record<string, string>
  modelInputModalities: string[]
  modelOutputModalities: string[]
  modelCostInput?: number
  modelCostOutput?: number
  modelCacheRead?: number
  modelCacheWrite?: number
  modelContextOver200kCostInput?: number
  modelContextOver200kCostOutput?: number
  modelContextOver200kCacheRead?: number
  modelContextOver200kCacheWrite?: number
  modelVariants: Array<{ name: string; disabled?: boolean }>
  rejectedSecret: boolean
  validation: string[]
}

export async function buildProjectProviderConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const request = parseProjectProviderConfigArgs(args)
  if (!runtimePath) {
    return "# BetterC0de Project Provider Config\n\n> No workspace folder is open."
  }
  if (request.validation.length > 0) {
    return [
      "# BetterC0de Project Provider Config",
      "",
      "## Validation",
      "",
      ...request.validation.map((item) => `- ${item}`),
      "",
      "> No provider config was written.",
    ].join("\n")
  }
  if (request.rejectedSecret) {
    return [
      "# BetterC0de Project Provider Config",
      "",
      "> Refusing to write provider secrets into project config.",
      "",
      "Use BetterC0de auth, environment variables, or BetterC0de provider settings for API keys.",
    ].join("\n")
  }
  if (hasInvalidProjectProviderModelLimit(request)) {
    return [
      "# BetterC0de Project Provider Config",
      "",
      "> Refusing to write an invalid BetterC0de model limit.",
      "",
      "Compatibility requires both `--model-context` and `--model-output` when any `model.limit` field is written. `--model-input` is optional.",
    ].join("\n")
  }
  if (hasInvalidProjectProviderModelModalities(request)) {
    return [
      "# BetterC0de Project Provider Config",
      "",
      "> Refusing to write invalid BetterC0de model modalities.",
      "",
      "Compatibility requires both `--model-input-modalities` and `--model-output-modalities` when `model.modalities` is written.",
    ].join("\n")
  }
  if (!request.providerId) {
    if (hasProjectProviderPolicyMutation(request)) {
      return writeProjectProviderConfigFromChat(runtimePath, request)
    }
    return [
      "# BetterC0de Project Provider Config",
      "",
      '> Usage: `/project-providers --config-only --provider <id> --name "Provider" --api <api> --npm <package> [--env ENV_NAME] [--model <model-id>]`',
      "",
      "Provider options: `--provider-api-id <upstream-id> --base-url <url> --enterprise-url <url> --set-cache-key true --timeout 300000|false --chunk-timeout 30000 --option customFlag=true`.",
      "",
      "Model metadata: `--model-api-id <upstream-model-id> --model-name <name> --model-family <family> --model-status active --model-context 200000 --model-output 8192 --model-input 200000 --model-reasoning true --model-interleaved reasoning_content --model-input-modalities text,image --model-output-modalities text --model-cost-input 0.000003 --model-cost-output 0.000015 --model-context-over-200k-cost-input 0.000006 --model-context-over-200k-cost-output 0.00003 --model-option effort=high --model-header X-Project=enabled --model-variant fast --model-disabled-variant legacy`.",
      "",
      "Policy usage: `/project-providers --config-only --default-model provider/model --small-model provider/model --enable-provider anthropic --disable-provider qwen`",
      "",
      "This writes only non-secret project provider metadata to `betterc0de.json`.",
    ].join("\n")
  }

  return writeProjectProviderConfigFromChat(runtimePath, request)
}

async function writeProjectProviderConfigFromChat(
  runtimePath: string,
  request: ProjectProviderConfigRequest
): Promise<string> {
  if (!request.providerId && !hasProjectProviderPolicyMutation(request)) {
    return "# BetterC0de Project Provider Config\n\n> No provider or provider policy change requested."
  }

  const configPath = "betterc0de.json"
  const absoluteConfigPath = resolveWorkspaceFilePath(runtimePath, configPath)
  let config: Record<string, unknown> = {}
  let existed = false
  try {
    const file = await readFile(absoluteConfigPath, { silent404: true })
    existed = true
    config = parsePluginConfigObject(file.content, configPath)
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      config = {}
    } else {
      return [
        "# BetterC0de Project Provider Config",
        "",
        "> Could not read the project BetterC0de compatibility config.",
        "",
        `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
      ].join("\n")
    }
  }

  let wroteProviderEntry = false
  if (request.providerId) {
    const providerConfig =
      config.provider &&
      typeof config.provider === "object" &&
      !Array.isArray(config.provider)
        ? { ...(config.provider as Record<string, unknown>) }
        : {}
    if (
      Object.prototype.hasOwnProperty.call(
        providerConfig,
        request.providerId
      ) &&
      !request.force
    ) {
      return [
        "# BetterC0de Project Provider Config",
        "",
        "> Provider config entry already exists.",
        "",
        `Provider: \`${escapeInlineCode(request.providerId)}\``,
        "",
        "Use `--force` to replace it intentionally.",
      ].join("\n")
    }

    providerConfig[request.providerId] =
      buildProjectProviderConfigEntry(request)
    config.provider = providerConfig
    wroteProviderEntry = true
  }

  applyProjectProviderPolicyConfig(config, request)

  try {
    await writeFile(runtimePath, configPath, serializeBetterC0deConfig(config))
  } catch (error) {
    return [
      "# BetterC0de Project Provider Config",
      "",
      "> Could not write the project BetterC0de compatibility config.",
      "",
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  return [
    "# BetterC0de Project Provider Config",
    "",
    providerConfigActionSummary(existed, wroteProviderEntry, request),
    "",
    request.providerId
      ? `Provider: \`${escapeInlineCode(request.providerId)}\``
      : "",
    request.modelId ? `Model: \`${escapeInlineCode(request.modelId)}\`` : "",
    request.defaultModel
      ? `Default model: \`${escapeInlineCode(request.defaultModel)}\``
      : "",
    request.smallModel
      ? `Small model: \`${escapeInlineCode(request.smallModel)}\``
      : "",
    request.enabledProviders.length
      ? `Enabled providers: ${escapeMarkdownTableCell(formatListPlain(request.enabledProviders))}`
      : "",
    request.disabledProviders.length
      ? `Disabled providers: ${escapeMarkdownTableCell(formatListPlain(request.disabledProviders))}`
      : "",
    request.env.length
      ? `Environment keys: ${escapeMarkdownTableCell(formatListPlain(request.env))}`
      : "",
    formatProjectProviderConfigOptionSummary(request),
    formatProjectProviderConfigModelSummary(request),
    "",
    "> No API keys, OAuth tokens, or secret values were written.",
  ]
    .filter(Boolean)
    .join("\n")
}

function parseProjectProviderConfigArgs(
  args: ReadonlyArray<string>
): ProjectProviderConfigRequest {
  const request: ProjectProviderConfigRequest = {
    configOnly: false,
    force: false,
    env: [],
    whitelist: [],
    blacklist: [],
    providerOptions: {},
    modelOptions: {},
    modelHeaders: {},
    modelInputModalities: [],
    modelOutputModalities: [],
    modelVariants: [],
    enabledProviders: [],
    disabledProviders: [],
    replaceEnabledProviders: false,
    replaceDisabledProviders: false,
    rejectedSecret: false,
    validation: [],
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextValue = (label = key) => {
      if (inlineValue !== undefined) {
        const value = inlineValue.trim()
        if (!value) request.validation.push(`${label} requires a value.`)
        return inlineValue
      }
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        request.validation.push(`${label} requires a value.`)
        return ""
      }
      index += 1
      return value
    }
    const nextOptionalValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const value = args[index + 1]
      if (!value || value.startsWith("-")) return undefined
      index += 1
      return value
    }
    switch (key) {
      case "--config-only":
        request.configOnly = true
        break
      case "--force":
      case "-f":
        request.force = true
        break
      case "--provider":
      case "--id": {
        const value = parseProjectProviderConfigId(
          nextValue(key),
          key,
          request.validation
        )
        if (value) request.providerId = value
        break
      }
      case "--provider-api-id":
      case "--provider-upstream-id": {
        const value = parseProjectProviderConfigId(
          nextValue(key),
          key,
          request.validation
        )
        if (value) request.providerApiId = value
        break
      }
      case "--name":
        request.name = nextValue().trim()
        break
      case "--api":
        request.api = nextValue().trim()
        break
      case "--npm":
        request.npm = nextValue().trim()
        break
      case "--env":
        request.env.push(
          ...parseProjectProviderEnvNames(
            nextValue("--env"),
            request.validation
          )
        )
        break
      case "--whitelist":
      case "--allowlist":
      case "--allow-model":
        request.whitelist.push(
          ...parseProjectProviderIdList(nextValue(key), key, request.validation)
        )
        break
      case "--blacklist":
      case "--blocklist":
      case "--block-model":
        request.blacklist.push(
          ...parseProjectProviderIdList(nextValue(key), key, request.validation)
        )
        break
      case "--base-url":
      case "--baseURL": {
        const value = nextValue().trim()
        if (value) request.baseURL = value
        break
      }
      case "--enterprise-url":
      case "--enterpriseUrl": {
        const value = nextValue().trim()
        if (value) request.enterpriseUrl = value
        break
      }
      case "--set-cache-key": {
        let value: boolean | undefined
        if (inlineValue !== undefined) {
          value = parsePluginToggleBoolean(inlineValue)
          if (value === undefined) {
            request.validation.push("`--set-cache-key` must be true or false.")
          }
        } else {
          const candidate = args[index + 1] ?? ""
          const parsed = parsePluginToggleBoolean(candidate)
          if (typeof parsed === "boolean") {
            value = parsed
            index += 1
          } else if (candidate && !candidate.startsWith("-")) {
            request.validation.push("`--set-cache-key` must be true or false.")
            index += 1
          } else {
            value = true
          }
        }
        if (typeof value === "boolean") request.setCacheKey = value
        break
      }
      case "--timeout": {
        const raw = nextValue().trim()
        if (raw.toLowerCase() === "false") {
          request.timeout = false
        } else {
          const value = parseProjectProviderPositiveInteger(
            raw,
            "--timeout",
            request.validation,
            " or false"
          )
          if (typeof value === "number") request.timeout = value
        }
        break
      }
      case "--chunk-timeout":
      case "--chunkTimeout": {
        const value = parseProjectProviderPositiveInteger(
          nextValue(key),
          key,
          request.validation
        )
        if (typeof value === "number") request.chunkTimeout = value
        break
      }
      case "--option":
      case "--provider-option": {
        const raw = nextValue(key)
        const pair = parseProjectProviderSafeOptionPair(raw)
        if (pair === "secret") request.rejectedSecret = true
        else if (pair) request.providerOptions[pair.key] = pair.value
        else if (raw.trim()) {
          request.validation.push(
            `\`${key}\` must be a non-secret key=value pair with a safe option key.`
          )
        }
        break
      }
      case "--default-model":
      case "--default":
        request.defaultModel = nextValue().trim()
        break
      case "--small-model":
      case "--small":
        request.smallModel = nextValue().trim()
        break
      case "--enabled-providers":
        request.replaceEnabledProviders = true
        request.enabledProviders.push(
          ...parseProjectProviderIdList(nextValue(key), key, request.validation)
        )
        break
      case "--enable-provider":
        request.enabledProviders.push(
          ...parseProjectProviderIdList(nextValue(key), key, request.validation)
        )
        break
      case "--disabled-providers":
        request.replaceDisabledProviders = true
        request.disabledProviders.push(
          ...parseProjectProviderIdList(nextValue(key), key, request.validation)
        )
        break
      case "--disable-provider":
        request.disabledProviders.push(
          ...parseProjectProviderIdList(nextValue(key), key, request.validation)
        )
        break
      case "--model": {
        const value = parseProjectProviderConfigId(
          nextValue("--model"),
          "--model",
          request.validation
        )
        if (value) request.modelId = value
        break
      }
      case "--model-api-id":
      case "--model-upstream-id": {
        const value = parseProjectProviderConfigId(
          nextValue(key),
          key,
          request.validation
        )
        if (value) request.modelApiId = value
        break
      }
      case "--model-name":
        request.modelName = nextValue().trim()
        break
      case "--model-family":
        request.modelFamily = nextValue().trim()
        break
      case "--model-release-date":
      case "--model-release":
        request.modelReleaseDate = nextValue().trim()
        break
      case "--model-status":
        request.modelStatus = parseProjectProviderModelStatus(
          nextValue("--model-status"),
          request.validation
        )
        break
      case "--model-context": {
        const value = parseProjectProviderPositiveFiniteNumber(
          nextValue("--model-context"),
          "--model-context",
          request.validation
        )
        if (typeof value === "number") request.modelContext = value
        break
      }
      case "--model-input": {
        const value = parseProjectProviderPositiveFiniteNumber(
          nextValue("--model-input"),
          "--model-input",
          request.validation
        )
        if (typeof value === "number") request.modelInput = value
        break
      }
      case "--model-output": {
        const value = parseProjectProviderPositiveFiniteNumber(
          nextValue("--model-output"),
          "--model-output",
          request.validation
        )
        if (typeof value === "number") request.modelOutput = value
        break
      }
      case "--model-attachment":
        request.modelAttachment = parseProjectProviderBooleanFlag(
          args,
          inlineValue,
          index,
          (next) => {
            index = next
          },
          "--model-attachment",
          request.validation
        )
        break
      case "--model-reasoning":
        request.modelReasoning = parseProjectProviderBooleanFlag(
          args,
          inlineValue,
          index,
          (next) => {
            index = next
          },
          "--model-reasoning",
          request.validation
        )
        break
      case "--model-temperature":
        request.modelTemperature = parseProjectProviderBooleanFlag(
          args,
          inlineValue,
          index,
          (next) => {
            index = next
          },
          "--model-temperature",
          request.validation
        )
        break
      case "--model-tool-call":
      case "--model-tool-callable":
        request.modelToolCall = parseProjectProviderBooleanFlag(
          args,
          inlineValue,
          index,
          (next) => {
            index = next
          },
          key,
          request.validation
        )
        break
      case "--model-interleaved": {
        const raw = nextOptionalValue() ?? "true"
        const interleaved = parseProjectProviderInterleavedFlag(raw)
        if (interleaved) request.modelInterleaved = interleaved
        else {
          request.validation.push(
            "`--model-interleaved` must be true, `reasoning_content`, or `reasoning_details`."
          )
        }
        break
      }
      case "--model-experimental":
        request.modelExperimental = parseProjectProviderBooleanFlag(
          args,
          inlineValue,
          index,
          (next) => {
            index = next
          },
          "--model-experimental",
          request.validation
        )
        break
      case "--model-provider-api": {
        const value = nextValue().trim()
        if (value) request.modelProviderApi = value
        break
      }
      case "--model-provider-npm": {
        const value = nextValue().trim()
        if (value) request.modelProviderNpm = value
        break
      }
      case "--model-option": {
        const raw = nextValue("--model-option")
        const pair = parseProjectProviderSafeOptionPair(raw)
        if (pair === "secret") request.rejectedSecret = true
        else if (pair) request.modelOptions[pair.key] = pair.value
        else if (raw.trim()) {
          request.validation.push(
            "`--model-option` must be a non-secret key=value pair with a safe option key."
          )
        }
        break
      }
      case "--model-header":
      case "--model-headers": {
        const raw = nextValue(key)
        const pair = parseProjectProviderSafeHeaderPair(raw)
        if (pair === "secret") request.rejectedSecret = true
        else if (pair) request.modelHeaders[pair.key] = pair.value
        else if (raw.trim()) {
          request.validation.push(
            `\`${key}\` must be a non-secret Header-Name=value pair.`
          )
        }
        break
      }
      case "--model-input-modalities":
        request.modelInputModalities.push(
          ...parseProjectProviderModelModalities(
            nextValue("--model-input-modalities"),
            "--model-input-modalities",
            request.validation
          )
        )
        break
      case "--model-output-modalities":
        request.modelOutputModalities.push(
          ...parseProjectProviderModelModalities(
            nextValue("--model-output-modalities"),
            "--model-output-modalities",
            request.validation
          )
        )
        break
      case "--model-cost-input": {
        const value = parseFiniteNonNegativeNumber(
          nextValue("--model-cost-input"),
          "--model-cost-input",
          request.validation
        )
        if (typeof value === "number") request.modelCostInput = value
        break
      }
      case "--model-cost-output": {
        const value = parseFiniteNonNegativeNumber(
          nextValue("--model-cost-output"),
          "--model-cost-output",
          request.validation
        )
        if (typeof value === "number") request.modelCostOutput = value
        break
      }
      case "--model-cache-read": {
        const value = parseFiniteNonNegativeNumber(
          nextValue("--model-cache-read"),
          "--model-cache-read",
          request.validation
        )
        if (typeof value === "number") request.modelCacheRead = value
        break
      }
      case "--model-cache-write": {
        const value = parseFiniteNonNegativeNumber(
          nextValue("--model-cache-write"),
          "--model-cache-write",
          request.validation
        )
        if (typeof value === "number") request.modelCacheWrite = value
        break
      }
      case "--model-context-over-200k-cost-input":
      case "--model-over-200k-cost-input": {
        const value = parseFiniteNonNegativeNumber(
          nextValue(key),
          key,
          request.validation
        )
        if (typeof value === "number") {
          request.modelContextOver200kCostInput = value
        }
        break
      }
      case "--model-context-over-200k-cost-output":
      case "--model-over-200k-cost-output": {
        const value = parseFiniteNonNegativeNumber(
          nextValue(key),
          key,
          request.validation
        )
        if (typeof value === "number") {
          request.modelContextOver200kCostOutput = value
        }
        break
      }
      case "--model-context-over-200k-cache-read":
      case "--model-over-200k-cache-read": {
        const value = parseFiniteNonNegativeNumber(
          nextValue(key),
          key,
          request.validation
        )
        if (typeof value === "number") {
          request.modelContextOver200kCacheRead = value
        }
        break
      }
      case "--model-context-over-200k-cache-write":
      case "--model-over-200k-cache-write": {
        const value = parseFiniteNonNegativeNumber(
          nextValue(key),
          key,
          request.validation
        )
        if (typeof value === "number") {
          request.modelContextOver200kCacheWrite = value
        }
        break
      }
      case "--model-variant": {
        const raw = nextValue("--model-variant")
        const name = parseProjectProviderVariantName(raw)
        if (name) request.modelVariants.push({ name })
        else if (raw.trim()) {
          request.validation.push(
            "`--model-variant` must be an BetterC0de variant id."
          )
        }
        break
      }
      case "--model-disabled-variant":
      case "--model-variant-disabled": {
        const raw = nextValue(key)
        const name = parseProjectProviderVariantName(raw)
        if (name) request.modelVariants.push({ name, disabled: true })
        else if (raw.trim()) {
          request.validation.push(
            `\`${key}\` must be an BetterC0de variant id.`
          )
        }
        break
      }
      case "--model-enabled-variant":
      case "--model-variant-enabled": {
        const raw = nextValue(key)
        const name = parseProjectProviderVariantName(raw)
        if (name) request.modelVariants.push({ name, disabled: false })
        else if (raw.trim()) {
          request.validation.push(
            `\`${key}\` must be an BetterC0de variant id.`
          )
        }
        break
      }
      case "--api-key":
      case "--token":
      case "--secret":
        request.rejectedSecret = true
        break
      default:
        break
    }
  }
  request.env = Array.from(new Set(request.env))
  request.whitelist = Array.from(new Set(request.whitelist))
  request.blacklist = Array.from(new Set(request.blacklist))
  request.modelInputModalities = Array.from(
    new Set(request.modelInputModalities)
  )
  request.modelOutputModalities = Array.from(
    new Set(request.modelOutputModalities)
  )
  request.modelVariants = dedupeProjectProviderVariants(request.modelVariants)
  request.enabledProviders = Array.from(new Set(request.enabledProviders))
  request.disabledProviders = Array.from(new Set(request.disabledProviders))
  return request
}

function buildProjectProviderConfigEntry(
  request: ProjectProviderConfigRequest
): Record<string, unknown> {
  const entry: Record<string, unknown> = {}
  if (request.providerApiId) entry.id = request.providerApiId
  if (request.name) entry.name = request.name
  if (request.api) entry.api = request.api
  if (request.npm) entry.npm = request.npm
  if (request.env.length > 0) entry.env = request.env
  if (request.whitelist.length > 0) entry.whitelist = request.whitelist
  if (request.blacklist.length > 0) entry.blacklist = request.blacklist
  const options = buildProjectProviderConfigOptions(request)
  if (Object.keys(options).length > 0) entry.options = options
  if (request.modelId) {
    const model: Record<string, unknown> = {}
    if (request.modelApiId) model.id = request.modelApiId
    if (request.modelName) model.name = request.modelName
    if (request.modelFamily) model.family = request.modelFamily
    if (request.modelReleaseDate) model.release_date = request.modelReleaseDate
    if (request.modelStatus) model.status = request.modelStatus
    if (typeof request.modelAttachment === "boolean") {
      model.attachment = request.modelAttachment
    }
    if (typeof request.modelReasoning === "boolean") {
      model.reasoning = request.modelReasoning
    }
    if (typeof request.modelTemperature === "boolean") {
      model.temperature = request.modelTemperature
    }
    if (typeof request.modelToolCall === "boolean") {
      model.tool_call = request.modelToolCall
    }
    if (request.modelInterleaved) {
      model.interleaved = request.modelInterleaved
    }
    if (typeof request.modelExperimental === "boolean") {
      model.experimental = request.modelExperimental
    }
    if (request.modelProviderApi || request.modelProviderNpm) {
      model.provider = {
        ...(request.modelProviderApi ? { api: request.modelProviderApi } : {}),
        ...(request.modelProviderNpm ? { npm: request.modelProviderNpm } : {}),
      }
    }
    if (Object.keys(request.modelOptions).length > 0) {
      model.options = request.modelOptions
    }
    if (Object.keys(request.modelHeaders).length > 0) {
      model.headers = request.modelHeaders
    }
    if (
      typeof request.modelContext === "number" &&
      typeof request.modelOutput === "number"
    ) {
      model.limit = {
        context: request.modelContext,
        ...(typeof request.modelInput === "number"
          ? { input: request.modelInput }
          : {}),
        output: request.modelOutput,
      }
    }
    if (
      request.modelInputModalities.length > 0 ||
      request.modelOutputModalities.length > 0
    ) {
      model.modalities = {
        ...(request.modelInputModalities.length > 0
          ? { input: request.modelInputModalities }
          : {}),
        ...(request.modelOutputModalities.length > 0
          ? { output: request.modelOutputModalities }
          : {}),
      }
    }
    if (
      typeof request.modelCostInput === "number" &&
      typeof request.modelCostOutput === "number"
    ) {
      const contextOver200kCost =
        typeof request.modelContextOver200kCostInput === "number" &&
        typeof request.modelContextOver200kCostOutput === "number"
          ? {
              input: request.modelContextOver200kCostInput,
              output: request.modelContextOver200kCostOutput,
              ...(typeof request.modelContextOver200kCacheRead === "number"
                ? { cache_read: request.modelContextOver200kCacheRead }
                : {}),
              ...(typeof request.modelContextOver200kCacheWrite === "number"
                ? { cache_write: request.modelContextOver200kCacheWrite }
                : {}),
            }
          : undefined
      model.cost = {
        input: request.modelCostInput,
        output: request.modelCostOutput,
        ...(typeof request.modelCacheRead === "number"
          ? { cache_read: request.modelCacheRead }
          : {}),
        ...(typeof request.modelCacheWrite === "number"
          ? { cache_write: request.modelCacheWrite }
          : {}),
        ...(contextOver200kCost
          ? { context_over_200k: contextOver200kCost }
          : {}),
      }
    }
    if (request.modelVariants.length > 0) {
      model.variants = Object.fromEntries(
        request.modelVariants.map((variant) => [
          variant.name,
          typeof variant.disabled === "boolean"
            ? { disabled: variant.disabled }
            : {},
        ])
      )
    }
    entry.models = { [request.modelId]: model }
  }
  return entry
}

function parseProjectProviderBooleanFlag(
  args: ReadonlyArray<string>,
  inlineValue: string | undefined,
  index: number,
  setIndex: (next: number) => void,
  label: string,
  validation: string[]
): boolean | undefined {
  if (inlineValue !== undefined) {
    const parsed = parsePluginToggleBoolean(inlineValue)
    if (parsed === undefined)
      validation.push(`\`${label}\` must be true or false.`)
    return parsed
  }
  const candidate = args[index + 1] ?? ""
  const parsed = parsePluginToggleBoolean(candidate)
  if (typeof parsed === "boolean") {
    setIndex(index + 1)
    return parsed
  }
  if (candidate && !candidate.startsWith("-")) {
    validation.push(`\`${label}\` must be true or false.`)
    setIndex(index + 1)
    return undefined
  }
  return true
}

function parseProjectProviderPositiveInteger(
  value: string,
  label: string,
  validation: string[],
  suffix = ""
): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const numeric = Number(trimmed)
  if (Number.isInteger(numeric) && numeric > 0) return numeric
  validation.push(`\`${label}\` must be a positive integer${suffix}.`)
  return undefined
}

function parseProjectProviderPositiveFiniteNumber(
  value: string,
  label: string,
  validation: string[]
): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  validation.push(`\`${label}\` must be a positive number.`)
  return undefined
}

export function parseFiniteNonNegativeNumber(
  value: string,
  label?: string,
  validation?: string[]
): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && numeric >= 0) return numeric
  if (label && validation) {
    validation.push(`\`${label}\` must be a finite non-negative number.`)
  }
  return undefined
}

function parseProjectProviderSafeOptionPair(
  value: string
): { key: string; value: unknown } | "secret" | undefined {
  const separator = value.indexOf("=")
  if (separator <= 0) return undefined
  const key = value.slice(0, separator).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return undefined
  const parsed = parsePluginInstallOptionValue(
    value.slice(separator + 1).trim()
  )
  if (isProjectProviderSecretLike(key, parsed)) return "secret"
  return { key, value: parsed }
}

function parseProjectProviderSafeHeaderPair(
  value: string
): { key: string; value: string } | "secret" | undefined {
  const separator = value.indexOf("=")
  if (separator <= 0) return undefined
  const key = value.slice(0, separator).trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) return undefined
  const headerValue = value.slice(separator + 1)
  if (isProjectProviderSecretLike(key, headerValue)) return "secret"
  return { key, value: headerValue }
}

export function isProjectProviderSecretLike(
  key: string,
  value: unknown
): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (
    /(apikey|secret|authorization|password|credential|privatekey|cookie)/.test(
      normalizedKey
    ) ||
    normalizedKey === "token" ||
    (normalizedKey.endsWith("token") && normalizedKey !== "maxtoken")
  ) {
    return true
  }
  if (typeof value === "string") {
    return /\bBearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-/i.test(
      value
    )
  }
  if (Array.isArray(value)) {
    return value.some((item) => isProjectProviderSecretLike(key, item))
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([entryKey, entryValue]) =>
        isProjectProviderSecretLike(entryKey, entryValue)
    )
  }
  return false
}

function parseProjectProviderVariantName(value: string): string | undefined {
  const trimmed = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed) ? trimmed : undefined
}

function parseProjectProviderConfigId(
  value: string,
  label: string,
  validation: string[]
): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(trimmed)) return trimmed
  validation.push(`\`${label}\` must be an BetterC0de identifier.`)
  return undefined
}

function parseProjectProviderEnvNames(
  value: string,
  validation: string[]
): string[] {
  const envNames: string[] = []
  for (const rawEntry of value.split(",")) {
    const raw = rawEntry.trim()
    if (!raw) continue
    if (isGithubWorkflowEnvName(raw)) {
      envNames.push(raw)
    } else {
      validation.push(
        `Invalid BetterC0de compatibility provider env name: \`${raw}\`. Use uppercase letters, numbers, and underscores.`
      )
    }
  }
  return envNames
}

const BETTERC0DE_MODEL_MODALITIES = new Set([
  "text",
  "audio",
  "image",
  "video",
  "pdf",
])

const BETTERC0DE_MODEL_STATUSES = new Set([
  "alpha",
  "beta",
  "deprecated",
  "active",
])

function parseProjectProviderModelStatus(
  value: string,
  validation: string[]
): string | undefined {
  const status = value.trim().toLowerCase()
  if (!status) return undefined
  if (BETTERC0DE_MODEL_STATUSES.has(status)) return status
  validation.push(
    "`--model-status` must be `alpha`, `beta`, `deprecated`, or `active`."
  )
  return undefined
}

function parseProjectProviderModelModalities(
  value: string,
  label: string,
  validation: string[]
): string[] {
  const modalities: string[] = []
  for (const raw of parseBetterC0deRuntimeList(value)) {
    const modality = raw.toLowerCase()
    if (BETTERC0DE_MODEL_MODALITIES.has(modality)) {
      modalities.push(modality)
    } else {
      validation.push(
        `Invalid BetterC0de model modality for \`${label}\`: \`${raw}\`. Use text, audio, image, video, or pdf.`
      )
    }
  }
  return modalities
}

function dedupeProjectProviderVariants(
  variants: ProjectProviderConfigRequest["modelVariants"]
): ProjectProviderConfigRequest["modelVariants"] {
  const byName = new Map<string, { name: string; disabled?: boolean }>()
  for (const variant of variants) byName.set(variant.name, variant)
  return [...byName.values()]
}

function parseProjectProviderInterleavedFlag(
  value: string
): ProjectProviderConfigRequest["modelInterleaved"] | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_")
  if (normalized === "true" || normalized === "on" || normalized === "yes") {
    return true
  }
  if (
    normalized === "reasoning_content" ||
    normalized === "reasoning_details"
  ) {
    return { field: normalized }
  }
  return undefined
}

function buildProjectProviderConfigOptions(
  request: ProjectProviderConfigRequest
): Record<string, unknown> {
  const options: Record<string, unknown> = { ...request.providerOptions }
  if (request.baseURL) options.baseURL = request.baseURL
  if (request.enterpriseUrl) options.enterpriseUrl = request.enterpriseUrl
  if (typeof request.setCacheKey === "boolean") {
    options.setCacheKey = request.setCacheKey
  }
  if (request.timeout === false || typeof request.timeout === "number") {
    options.timeout = request.timeout
  }
  if (typeof request.chunkTimeout === "number") {
    options.chunkTimeout = request.chunkTimeout
  }
  return options
}

function hasProjectProviderPolicyMutation(
  request: ProjectProviderConfigRequest
): boolean {
  return Boolean(
    request.defaultModel ||
    request.smallModel ||
    request.enabledProviders.length > 0 ||
    request.disabledProviders.length > 0
  )
}

function hasInvalidProjectProviderModelLimit(
  request: ProjectProviderConfigRequest
): boolean {
  const hasAnyLimitField =
    typeof request.modelContext === "number" ||
    typeof request.modelInput === "number" ||
    typeof request.modelOutput === "number"
  if (!hasAnyLimitField) return false
  return !(
    typeof request.modelContext === "number" &&
    typeof request.modelOutput === "number"
  )
}

function hasInvalidProjectProviderModelModalities(
  request: ProjectProviderConfigRequest
): boolean {
  const hasAnyModalities =
    request.modelInputModalities.length > 0 ||
    request.modelOutputModalities.length > 0
  if (!hasAnyModalities) return false
  return !(
    request.modelInputModalities.length > 0 &&
    request.modelOutputModalities.length > 0
  )
}

function applyProjectProviderPolicyConfig(
  config: Record<string, unknown>,
  request: ProjectProviderConfigRequest
): void {
  if (request.defaultModel) config.model = request.defaultModel
  if (request.smallModel) config.small_model = request.smallModel
  if (request.enabledProviders.length > 0 || request.replaceEnabledProviders) {
    config.enabled_providers = mergeProjectProviderList(
      config.enabled_providers,
      request.enabledProviders,
      request.replaceEnabledProviders
    )
  }
  if (
    request.disabledProviders.length > 0 ||
    request.replaceDisabledProviders
  ) {
    config.disabled_providers = mergeProjectProviderList(
      config.disabled_providers,
      request.disabledProviders,
      request.replaceDisabledProviders
    )
  }
}

function mergeProjectProviderList(
  current: unknown,
  next: ReadonlyArray<string>,
  replace: boolean
): string[] {
  const existing = replace ? [] : readStringList(current)
  return Array.from(new Set([...existing, ...next]))
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function parseProjectProviderIdList(
  value: string,
  label: string,
  validation: string[]
): string[] {
  const ids: string[] = []
  for (const rawEntry of value.split(",")) {
    const raw = rawEntry.trim()
    if (!raw) continue
    if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw)) {
      ids.push(raw)
    } else {
      validation.push(`Invalid BetterC0de id for \`${label}\`: \`${raw}\`.`)
    }
  }
  return ids
}

function providerConfigActionSummary(
  existed: boolean,
  wroteProviderEntry: boolean,
  request: ProjectProviderConfigRequest
): string {
  const target = existed ? "Updated" : "Created"
  if (wroteProviderEntry && hasProjectProviderPolicyMutation(request)) {
    return `${target} \`betterc0de.json\` with project provider metadata and provider policy.`
  }
  if (wroteProviderEntry) {
    return `${target} \`betterc0de.json\` with a project provider entry.`
  }
  return `${target} \`betterc0de.json\` with provider policy.`
}

function formatProjectProviderConfigOptionSummary(
  request: ProjectProviderConfigRequest
): string {
  const parts = [
    request.providerApiId ? `api id ${request.providerApiId}` : "",
    request.baseURL ? `baseURL ${request.baseURL}` : "",
    request.enterpriseUrl ? `enterpriseUrl ${request.enterpriseUrl}` : "",
    typeof request.setCacheKey === "boolean"
      ? `setCacheKey ${request.setCacheKey ? "true" : "false"}`
      : "",
    request.timeout === false
      ? "timeout disabled"
      : typeof request.timeout === "number"
        ? `timeout ${request.timeout}ms`
        : "",
    typeof request.chunkTimeout === "number"
      ? `chunkTimeout ${request.chunkTimeout}ms`
      : "",
    Object.keys(request.providerOptions).length > 0
      ? `custom options ${Object.keys(request.providerOptions)
          .sort()
          .join(", ")}`
      : "",
  ].filter(Boolean)
  return parts.length > 0
    ? `Provider options: ${escapeMarkdownTableCell(parts.join(", "))}`
    : ""
}

function formatProjectProviderConfigModelSummary(
  request: ProjectProviderConfigRequest
): string {
  if (!request.modelId) return ""
  const metadata = [
    request.modelApiId ? `api id ${request.modelApiId}` : "",
    request.modelFamily ? `family ${request.modelFamily}` : "",
    request.modelReleaseDate ? `release ${request.modelReleaseDate}` : "",
    request.modelStatus ? `status ${request.modelStatus}` : "",
    request.modelContext ? `context ${request.modelContext}` : "",
    request.modelInput ? `input ${request.modelInput}` : "",
    request.modelOutput ? `output ${request.modelOutput}` : "",
    request.modelInputModalities.length > 0
      ? `input modalities ${request.modelInputModalities.join("/")}`
      : "",
    request.modelOutputModalities.length > 0
      ? `output modalities ${request.modelOutputModalities.join("/")}`
      : "",
    typeof request.modelCostInput === "number" &&
    typeof request.modelCostOutput === "number"
      ? `cost in ${request.modelCostInput} out ${request.modelCostOutput}`
      : "",
    typeof request.modelContextOver200kCostInput === "number" &&
    typeof request.modelContextOver200kCostOutput === "number"
      ? `>200k cost in ${request.modelContextOver200kCostInput} out ${request.modelContextOver200kCostOutput}`
      : "",
    request.modelProviderApi ? `provider api ${request.modelProviderApi}` : "",
    request.modelProviderNpm ? `provider npm ${request.modelProviderNpm}` : "",
    Object.keys(request.modelOptions).length > 0
      ? `options ${Object.keys(request.modelOptions).sort().join(", ")}`
      : "",
    Object.keys(request.modelHeaders).length > 0
      ? `headers ${Object.keys(request.modelHeaders).sort().join(", ")}`
      : "",
    request.modelInterleaved
      ? request.modelInterleaved === true
        ? "interleaved true"
        : `interleaved ${request.modelInterleaved.field}`
      : "",
    request.modelVariants.length > 0
      ? `variants ${request.modelVariants
          .map((variant) =>
            typeof variant.disabled === "boolean"
              ? `${variant.name}(${variant.disabled ? "disabled" : "enabled"})`
              : variant.name
          )
          .join("/")}`
      : "",
    typeof request.modelAttachment === "boolean"
      ? `attachments ${request.modelAttachment}`
      : "",
    typeof request.modelReasoning === "boolean"
      ? `reasoning ${request.modelReasoning}`
      : "",
    typeof request.modelTemperature === "boolean"
      ? `temperature ${request.modelTemperature}`
      : "",
    typeof request.modelToolCall === "boolean"
      ? `tool_call ${request.modelToolCall}`
      : "",
    typeof request.modelExperimental === "boolean"
      ? `experimental ${request.modelExperimental}`
      : "",
  ].filter(Boolean)
  return metadata.length > 0
    ? `Model metadata: ${escapeMarkdownTableCell(metadata.join(", "))}`
    : ""
}

export function serializeBetterC0deConfig(
  config: Record<string, unknown>
): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

export function isGithubWorkflowEnvName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value)
}

export function parsePluginInstallOptionValue(value: string): unknown {
  if (value === "") return ""
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function parsePluginConfigObject(
  content: string,
  configPath: string
): Record<string, unknown> {
  const stripped = stripJsoncTrailingCommas(stripJsoncComments(content)).trim()
  if (!stripped) return {}
  const parsed: unknown = JSON.parse(stripped)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

export function parsePluginToggleBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase()
  if (["true", "1", "yes", "on", "enable", "enabled"].includes(normalized)) {
    return true
  }
  if (["false", "0", "no", "off", "disable", "disabled"].includes(normalized)) {
    return false
  }
  return undefined
}

function stripJsoncComments(content: string): string {
  let output = ""
  let inString = false
  let escaped = false

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] ?? ""
    const next = content[index + 1] ?? ""

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      continue
    }

    if (char === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") {
        index += 1
      }
      output += "\n"
      continue
    }

    if (char === "/" && next === "*") {
      index += 2
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      ) {
        output += content[index] === "\n" ? "\n" : ""
        index += 1
      }
      index += 1
      continue
    }

    output += char
  }

  return output
}

function stripJsoncTrailingCommas(content: string): string {
  return content.replace(/,\s*([}\]])/g, "$1")
}

export function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

export function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "\\`")
}

function formatProjectProviderModelModalities(
  model: WorkspaceProjectProvidersSummary["providers"][number]["models"][number]
): string {
  const input = model.inputModalities?.length
    ? `in ${model.inputModalities.join(", ")}`
    : ""
  const output = model.outputModalities?.length
    ? `out ${model.outputModalities.join(", ")}`
    : ""
  return [input, output].filter(Boolean).join("; ")
}

function formatProjectProviderModelCost(
  model: WorkspaceProjectProvidersSummary["providers"][number]["models"][number]
): string {
  const base = formatProjectProviderModelCostRecord(model.cost)
  const over200k = formatProjectProviderModelCostRecord(
    model.contextOver200kCost
  )
  return [base ? `base ${base}` : "", over200k ? `>200k ${over200k}` : ""]
    .filter(Boolean)
    .join("; ")
}

function formatProjectProviderModelCostRecord(
  values?: Record<string, number>
): string {
  if (!values) return ""
  return Object.entries(values)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ")
}
