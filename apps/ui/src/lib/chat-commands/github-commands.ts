import { stringifyCliArgs } from "@/lib/cli-parse"
import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { HttpError } from "@/lib/errors/types"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { readFile, writeFile } from "@/services/backend/workspaceApi"
import {
  isBetterC0deProviderModelId,
  splitBetterC0deProviderModelId,
} from "./agent-commands"
import { formatListPlain } from "./input-context"
import { formatDebugPathCell } from "./lsp-commands"
import { isBetterC0deRuntimeTerminalFlag } from "./mcp-commands"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  isGithubWorkflowEnvName,
  type ActiveThreadRef,
} from "./provider-config"

export async function buildGithubAgentOutput(
  command: string,
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode = normalized.includes("install")
    ? "install"
    : normalized.includes("run")
      ? "run"
      : "overview"
  const installRequest = parseGithubWorkflowInstallArgs(args)
  const runRequest = parseGithubRunArgs(args)
  const terminalCommand = buildBetterC0deGithubTerminalCommand(command, args)
  const heading =
    mode === "install"
      ? "BetterC0de GitHub Agent Install"
      : mode === "run"
        ? "BetterC0de GitHub Agent Run"
        : "BetterC0de GitHub Agent"

  if (
    mode === "install" &&
    runtimePath &&
    installRequest.workflowOnly &&
    installRequest.provider &&
    installRequest.model &&
    !installRequest.dryRun
  ) {
    return writeGithubAgentWorkflowFromChat({
      runtimePath,
      request: {
        ...installRequest,
        provider: installRequest.provider,
        model: installRequest.model,
      },
    })
  }

  return [
    `# ${heading}`,
    "",
    "Legacy compatibility reference: `betterc0de github install` / `betterc0de github run`.",
    "",
    `Workspace: ${runtimePath ? formatDebugPathCell(runtimePath) : "No folder open"}`,
    "",
    mode === "install"
      ? [
          "## Install Flow",
          "",
          "BetterC0de does not silently install the BetterC0de GitHub app or write `.github/workflows/betterc0de.yml` from chat.",
          "",
          "the legacy compatibility CLI's install flow:",
          "- Opens the compatibility GitHub App",
          "- Detects the GitHub App installation for the current repo",
          "- Creates a GitHub Actions workflow",
          "- Prompts for provider/model and required repository secrets",
          "",
          "Chat workflow-only usage:",
          '`/github.install --workflow-only --provider <provider> --model <model> [--env ENV_NAME] [--agent <agent>] [--share true|false] [--mentions /betterc0de,/bc] [--triggers issue_comment,pull_request_review_comment] [--schedule "0 9 * * *"] [--prompt "..."] [--variant <variant>] [--use-github-token] [--force]`',
          "",
          buildGithubWorkflowInstallValidationSection(installRequest),
        ].join("\n")
      : "",
    mode === "run"
      ? [
          "## Run Flow",
          "",
          "BetterC0de `github run` is intended for GitHub Actions or explicit local mock-event execution. BetterC0de keeps this as a visible workflow entrypoint instead of running a GitHub App token exchange from chat.",
          "",
          "Use the terminal when you intentionally want to run the CLI:",
          "- `betterc0de github run --event <event.json> --token <github_pat_...>` for a local mock",
          "- GitHub Actions should provide the real event context and token/OIDC environment",
          "",
          "BetterC0de compatibility runtime environment:",
          "- `MODEL=provider/model` is required",
          "- `GITHUB_RUN_ID=<id>` is required",
          "- `SHARE`, `USE_GITHUB_TOKEN`, `OIDC_BASE_URL`, and `VARIANT` are optional",
          "",
          buildGithubRunValidationSection(runRequest),
        ].join("\n")
      : "",
    mode === "overview"
      ? [
          "## Available Entrypoints",
          "",
          "| Command | Purpose | BetterC0de behavior |",
          "|:--------|:--------|:--------------------|",
          "| `/github.install` | Prepare the BetterC0de GitHub agent app/workflow | Shows safe install guidance |",
          "| `/github.run` | Run the BetterC0de GitHub agent for an event | Shows safe run guidance |",
          "| `/pr <number>` | Work on a GitHub PR | Starts a read-only BetterC0de PR review prompt |",
        ].join("\n")
      : "",
    "",
    terminalCommand.shouldOpen && terminalCommand.command
      ? [
          "## Terminal",
          "",
          "```sh",
          terminalCommand.command,
          "```",
          "",
          "> Opened the terminal panel with this BetterC0de GitHub command prefilled. BetterC0de-only workflow flags are not passed to the CLI.",
        ].join("\n")
      : "",
    "",
    mode === "install" &&
    installRequest.workflowOnly &&
    (!runtimePath || !installRequest.provider || !installRequest.model)
      ? [
          "> Workflow-only mode needs an open workspace plus `--provider` and `--model` before BetterC0de can write `.github/workflows/betterc0de.yml`.",
          "Example: `/github.install --workflow-only --provider anthropic --model claude-sonnet-4-5 --env ANTHROPIC_API_KEY --share true`.",
        ].join("\n")
      : "",
    "",
    "> BetterC0de does not silently install the GitHub App, exchange GitHub tokens, checkout PR branches, or run the GitHub agent from chat. With `--workflow-only`, it only writes the project workflow file.",
  ]
    .filter(Boolean)
    .join("\n")
}

type GithubWorkflowTrigger =
  | "issue_comment"
  | "pull_request_review_comment"
  | "issues"
  | "pull_request"
  | "schedule"
  | "workflow_dispatch"

const GITHUB_WORKFLOW_DEFAULT_TRIGGERS: readonly GithubWorkflowTrigger[] = [
  "issue_comment",
  "pull_request_review_comment",
]

const GITHUB_WORKFLOW_SUPPORTED_TRIGGERS: readonly GithubWorkflowTrigger[] = [
  ...GITHUB_WORKFLOW_DEFAULT_TRIGGERS,
  "issues",
  "pull_request",
  "schedule",
  "workflow_dispatch",
]

interface GithubWorkflowInstallRequest {
  workflowOnly: boolean
  provider?: string
  model?: string
  env: string[]
  agent?: string
  share?: boolean
  prompt?: string
  triggers: GithubWorkflowTrigger[]
  schedules: string[]
  useGithubToken: boolean
  mentions?: string
  variant?: string
  oidcBaseUrl?: string
  force: boolean
  dryRun: boolean
  errors: string[]
}

export function buildBetterC0deGithubTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode = normalized.includes("run") ? "run" : "install"
  const shouldOpen = args.some(isBetterC0deRuntimeTerminalFlag)
  if (mode === "run") {
    const request = parseGithubRunArgs(args)
    const cliArgs = [
      request.eventFile ? ["--event", request.eventFile] : [],
      request.token ? ["--token", request.token] : [],
      request.passthroughArgs,
    ].flat()
    const envPrefix = formatGithubRunEnvironmentPrefix(request)
    return {
      command: [envPrefix, "betterc0de github run", stringifyCliArgs(cliArgs)]
        .filter(Boolean)
        .join(" "),
      shouldOpen,
    }
  }
  return {
    command: ["betterc0de github", mode].filter(Boolean).join(" "),
    shouldOpen,
  }
}

interface GithubRunRequest {
  eventFile?: string
  token?: string
  model?: string
  runId?: string
  share?: boolean
  useGithubToken?: boolean
  oidcBaseUrl?: string
  variant?: string
  passthroughArgs: string[]
  errors: string[]
}

function parseGithubRunArgs(args: ReadonlyArray<string>): GithubRunRequest {
  const request: GithubRunRequest = { passthroughArgs: [], errors: [] }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextRequiredValue = (label: string) => {
      if (inlineValue !== undefined) {
        const value = inlineValue.trim()
        if (!value) request.errors.push(`${label} requires a value.`)
        return value
      }
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        request.errors.push(`${label} requires a value.`)
        return ""
      }
      index += 1
      return value.trim()
    }
    const nextOptionalValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const value = args[index + 1]
      if (!value || value.startsWith("-")) return undefined
      index += 1
      return value
    }

    switch (key) {
      case "--event":
        request.eventFile = nextRequiredValue("--event")
        break
      case "--token":
        request.token = nextRequiredValue("--token")
        break
      case "--model":
      case "-m":
        request.model = nextRequiredValue(key)
        break
      case "--run-id":
      case "--github-run-id":
        request.runId = nextRequiredValue(key)
        break
      case "--share": {
        const value = nextOptionalValue() ?? "true"
        const parsed = parseGithubBooleanOption(
          value,
          "`--share`",
          "`SHARE`",
          request.errors
        )
        if (parsed !== undefined) request.share = parsed
        break
      }
      case "--no-share":
        request.share = false
        break
      case "--use-github-token": {
        const value = nextOptionalValue() ?? "true"
        const parsed = parseGithubBooleanOption(
          value,
          "`--use-github-token`",
          "`USE_GITHUB_TOKEN`",
          request.errors
        )
        if (parsed !== undefined) request.useGithubToken = parsed
        break
      }
      case "--oidc-base-url":
      case "--oidc":
        request.oidcBaseUrl = nextRequiredValue(key)
        break
      case "--variant":
        request.variant = nextRequiredValue("--variant")
        break
      default:
        request.passthroughArgs.push(arg)
        break
    }
  }

  return request
}

function parseGithubBooleanOption(
  rawValue: string,
  label: string,
  target: string,
  errors: string[]
): boolean | undefined {
  const value = rawValue.trim().toLowerCase()
  if (value === "true") return true
  if (value === "false") return false
  errors.push(
    `${label} maps to BetterC0de ${target} and must be \`true\` or \`false\``
  )
  return undefined
}

function buildGithubWorkflowInstallValidationSection(
  request: GithubWorkflowInstallRequest
): string {
  const message = validateGithubWorkflowInstallRequest(request)
  return message ? `## Workflow Checks\n\n${message}` : ""
}

function buildGithubRunValidationSection(request: GithubRunRequest): string {
  const messages = githubRunValidationMessages(request)
  if (messages.length === 0) {
    return "> Run arguments look complete for the visible compatibility CLI handoff."
  }
  return ["> Run checks:", ...messages.map((message) => `> - ${message}`)].join(
    "\n"
  )
}

function githubRunValidationMessages(request: GithubRunRequest): string[] {
  const messages: string[] = [...request.errors]
  if (!request.model) messages.push("set `--model provider/model` for `MODEL`")
  if (request.model && !isBetterC0deProviderModelId(request.model)) {
    messages.push(
      "`--model` must use the compatibility CLI's `provider/model` format for `MODEL`"
    )
  }
  if (!request.runId) messages.push("set `--run-id <id>` for `GITHUB_RUN_ID`")
  if (request.token && !request.eventFile) {
    messages.push("`--token` is only useful together with `--event <file>`")
  }
  if (request.eventFile && !request.token && request.useGithubToken !== true) {
    messages.push(
      "local mock runs with `--event` need `--token <github_pat_...>` unless `--use-github-token` is set and `GITHUB_TOKEN` is present in the terminal environment"
    )
  }
  return messages
}

function formatGithubRunEnvironmentPrefix(request: GithubRunRequest): string {
  const entries = [
    request.model ? ["MODEL", request.model] : undefined,
    request.runId ? ["GITHUB_RUN_ID", request.runId] : undefined,
    request.share !== undefined ? ["SHARE", String(request.share)] : undefined,
    request.useGithubToken !== undefined
      ? ["USE_GITHUB_TOKEN", String(request.useGithubToken)]
      : undefined,
    request.oidcBaseUrl ? ["OIDC_BASE_URL", request.oidcBaseUrl] : undefined,
    request.variant ? ["VARIANT", request.variant] : undefined,
  ].filter((entry): entry is [string, string] => Boolean(entry))
  return entries
    .map(([key, value]) => `${key}=${stringifyCliArgs([value])}`)
    .join(" ")
}

function parseGithubWorkflowInstallArgs(
  args: ReadonlyArray<string>
): GithubWorkflowInstallRequest {
  const request: GithubWorkflowInstallRequest = {
    workflowOnly: false,
    env: [],
    triggers: [],
    schedules: [],
    useGithubToken: false,
    force: false,
    dryRun: false,
    errors: [],
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextRequiredValue = (label: string) => {
      if (inlineValue !== undefined) {
        const value = inlineValue.trim()
        if (!value) request.errors.push(`${label} requires a value.`)
        return value
      }
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        request.errors.push(`${label} requires a value.`)
        return ""
      }
      index += 1
      return value.trim()
    }
    const nextOptionalValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const value = args[index + 1]
      if (!value || value.startsWith("-")) return undefined
      index += 1
      return value
    }

    switch (key) {
      case "--workflow-only":
      case "--workflow":
        request.workflowOnly = true
        break
      case "--provider":
      case "-p":
        request.provider = nextRequiredValue(key)
        break
      case "--model":
      case "-m":
        request.model = nextRequiredValue(key)
        break
      case "--agent":
      case "-a":
        request.agent = nextRequiredValue(key)
        break
      case "--share": {
        const parsed = parseGithubBooleanOption(
          nextOptionalValue() ?? "true",
          "`--share`",
          "`share` action input",
          request.errors
        )
        if (parsed !== undefined) request.share = parsed
        break
      }
      case "--no-share":
        request.share = false
        break
      case "--prompt":
        request.prompt = nextRequiredValue("--prompt")
        break
      case "--triggers":
      case "--events":
        request.triggers.push(
          ...parseGithubWorkflowTriggers(nextRequiredValue(key), request.errors)
        )
        break
      case "--schedule":
      case "--cron": {
        const schedule = nextRequiredValue(key)
        if (schedule) {
          request.triggers.push("schedule")
          if (isGithubWorkflowCronSchedule(schedule)) {
            request.schedules.push(schedule)
          } else {
            request.errors.push(
              `Invalid GitHub workflow schedule: \`${schedule}\`. Use five-field cron like \`0 9 * * *\`.`
            )
          }
        }
        break
      }
      case "--use-github-token": {
        const parsed = parseGithubBooleanOption(
          nextOptionalValue() ?? "true",
          "`--use-github-token`",
          "`use_github_token` action input",
          request.errors
        )
        if (parsed !== undefined) request.useGithubToken = parsed
        break
      }
      case "--mentions":
        request.mentions = nextRequiredValue("--mentions")
        break
      case "--variant":
        request.variant = nextRequiredValue("--variant")
        break
      case "--oidc-base-url":
      case "--oidc":
        request.oidcBaseUrl = nextRequiredValue(key)
        break
      case "--env": {
        request.env.push(
          ...parseGithubWorkflowEnvNames(
            nextRequiredValue("--env"),
            request.errors
          )
        )
        break
      }
      case "--force":
      case "-f":
        request.force = true
        break
      case "--dry-run":
        request.dryRun = true
        break
      default:
        break
    }
  }

  request.env = Array.from(new Set(request.env))
  request.triggers = Array.from(new Set(request.triggers))
  request.schedules = Array.from(new Set(request.schedules))
  normalizeGithubWorkflowProviderModelRequest(request)
  return request
}

function parseGithubWorkflowTriggers(
  value: string,
  errors: string[] = []
): GithubWorkflowTrigger[] {
  const triggers: GithubWorkflowTrigger[] = []
  for (const rawEntry of value.split(",")) {
    const raw = rawEntry.trim()
    if (!raw) continue
    const entries = resolveGithubWorkflowTriggerAlias(raw)
    if (entries.length > 0) {
      triggers.push(...entries)
    } else {
      errors.push(`Unsupported GitHub workflow trigger: \`${raw}\`.`)
    }
  }
  return triggers
}

function resolveGithubWorkflowTriggerAlias(
  value: string
): GithubWorkflowTrigger[] {
  const entry = value.toLowerCase().replace(/[\s.-]+/g, "_")
  switch (entry) {
    case "comment":
    case "comments":
      return ["issue_comment", "pull_request_review_comment"]
    case "issue":
      return ["issues"]
    case "pull_request_comment":
    case "pull_request_comments":
    case "pr_comment":
    case "pr_comments":
    case "review_comment":
    case "review_comments":
      return ["pull_request_review_comment"]
    case "pr":
    case "pull":
    case "pull_request_event":
      return ["pull_request"]
    case "dispatch":
    case "manual":
      return ["workflow_dispatch"]
    case "cron":
    case "scheduled":
      return ["schedule"]
    default:
      return GITHUB_WORKFLOW_SUPPORTED_TRIGGERS.includes(
        entry as GithubWorkflowTrigger
      )
        ? [entry as GithubWorkflowTrigger]
        : []
  }
}

function isGithubWorkflowCronSchedule(value: string): boolean {
  const fields = value.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ]
  return fields.every((field, index) =>
    isGithubWorkflowCronField(field, ranges[index] ?? [0, 59], index)
  )
}

function isGithubWorkflowCronField(
  field: string,
  [min, max]: [number, number],
  index: number
): boolean {
  if (!field || /\s/.test(field)) return false
  return field.split(",").every((entry) => {
    const [rangePart, stepPart, extra] = entry.split("/")
    if (extra !== undefined || !rangePart) return false
    if (stepPart !== undefined && !isGithubCronNumber(stepPart, 1, 999)) {
      return false
    }
    if (rangePart === "*") return true
    const [start, end, overflow] = rangePart.split("-")
    if (overflow !== undefined || !start) return false
    const startValue = parseGithubCronFieldValue(start, index)
    if (startValue === null || startValue < min || startValue > max) {
      return false
    }
    if (end === undefined) return true
    const endValue = parseGithubCronFieldValue(end, index)
    if (endValue === null || endValue < min || endValue > max) return false
    return startValue <= endValue
  })
}

function parseGithubCronFieldValue(
  value: string,
  index: number
): number | null {
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10)
  const normalized = value.toUpperCase()
  if (index === 3) {
    const month = [
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC",
    ].indexOf(normalized)
    return month >= 0 ? month + 1 : null
  }
  if (index === 4) {
    const day = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].indexOf(
      normalized
    )
    return day >= 0 ? day : null
  }
  return null
}

function isGithubCronNumber(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) return false
  const parsed = Number.parseInt(value, 10)
  return parsed >= min && parsed <= max
}

function normalizeGithubWorkflowProviderModelRequest(
  request: GithubWorkflowInstallRequest
): void {
  const model = request.model?.trim()
  if (!model) return
  const parsed = splitBetterC0deProviderModelId(model)
  if (!parsed) return
  if (!request.provider) {
    request.provider = parsed.provider
    request.model = parsed.model
    return
  }
  if (
    normalizeGithubWorkflowProviderId(request.provider) ===
    normalizeGithubWorkflowProviderId(parsed.provider)
  ) {
    request.model = parsed.model
  }
}

function parseGithubWorkflowEnvNames(
  value: string,
  errors: string[] = []
): string[] {
  const envNames: string[] = []
  for (const rawEntry of value.split(",")) {
    const raw = rawEntry.trim()
    if (!raw) continue
    if (isGithubWorkflowEnvName(raw)) {
      envNames.push(raw)
    } else {
      errors.push(
        `Invalid GitHub workflow env name: \`${raw}\`. Use uppercase letters, numbers, and underscores.`
      )
    }
  }
  return envNames
}

async function writeGithubAgentWorkflowFromChat(input: {
  runtimePath: string
  request: GithubWorkflowInstallRequest & {
    provider: string
    model: string
  }
}): Promise<string> {
  const workflowPath = ".github/workflows/betterc0de.yml"
  const absoluteWorkflowPath = resolveWorkspaceFilePath(
    input.runtimePath,
    workflowPath
  )
  if (!input.request.force) {
    try {
      await readFile(absoluteWorkflowPath, { silent404: true })
      return [
        "# BetterC0de GitHub Agent Install",
        "",
        "> GitHub agent workflow already exists.",
        "",
        `Target: \`${escapeInlineCode(workflowPath)}\``,
        "",
        "Use `--force` to overwrite it intentionally.",
      ].join("\n")
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) {
        return [
          "# BetterC0de GitHub Agent Install",
          "",
          "> Could not verify whether the GitHub agent workflow already exists.",
          "",
          `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
        ].join("\n")
      }
    }
  }

  const validationError = validateGithubWorkflowInstallRequest(input.request)
  if (validationError) {
    return [
      "# BetterC0de GitHub Agent Install",
      "",
      "> Could not write the GitHub agent workflow.",
      "",
      validationError,
    ].join("\n")
  }

  const content = buildGithubAgentWorkflowYaml(input.request)
  try {
    await writeFile(input.runtimePath, workflowPath, content)
  } catch (error) {
    return [
      "# BetterC0de GitHub Agent Install",
      "",
      "> Could not write the GitHub agent workflow.",
      "",
      `Target: \`${escapeInlineCode(workflowPath)}\``,
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  const envNames = resolveGithubWorkflowEnvNames(input.request)
  const normalizedProvider = normalizeGithubWorkflowProviderId(
    input.request.provider
  )

  return [
    "# BetterC0de GitHub Agent Install",
    "",
    "Created the BetterC0de GitHub agent workflow file.",
    "",
    `Target: \`${escapeInlineCode(workflowPath)}\``,
    `Model: \`${escapeInlineCode(`${input.request.provider}/${input.request.model}`)}\``,
    `Secrets referenced: ${escapeMarkdownTableCell(formatListPlain(envNames))}`,
    input.request.agent
      ? `Agent: \`${escapeInlineCode(input.request.agent)}\``
      : "",
    input.request.variant
      ? `Variant: \`${escapeInlineCode(input.request.variant)}\``
      : "",
    input.request.share !== undefined
      ? `Share: \`${String(input.request.share)}\``
      : "",
    input.request.mentions
      ? `Mentions: \`${escapeInlineCode(input.request.mentions)}\``
      : "",
    `Triggers: \`${escapeInlineCode(resolveGithubWorkflowTriggers(input.request).join(", "))}\``,
    input.request.schedules.length > 0
      ? `Schedules: \`${escapeInlineCode(input.request.schedules.join(", "))}\``
      : "",
    input.request.useGithubToken
      ? "GitHub token mode: uses `${{ github.token }}` via the action's `use_github_token` input."
      : "",
    "",
    "Next steps:",
    "- Commit and push the workflow file.",
    "- Install the BetterC0de GitHub App for this repository.",
    envNames.length > 0
      ? "- Add the referenced secrets in the repo or organization settings."
      : normalizedProvider === "amazon-bedrock"
        ? "- Configure AWS OIDC for GitHub Actions access to Amazon Bedrock."
        : "- Add any required provider secrets in the repo or organization settings.",
    "",
    "> Workflow-only mode did not install the GitHub App, request credentials, exchange tokens, or run the agent.",
  ].join("\n")
}

function validateGithubWorkflowInstallRequest(
  request: GithubWorkflowInstallRequest
): string | null {
  if (request.errors.length > 0) {
    return [
      "> Workflow checks:",
      ...request.errors.map((error) => `> - ${error}`),
    ].join("\n")
  }
  const triggers = resolveGithubWorkflowTriggers(request)
  if (
    triggers.includes("schedule") &&
    request.schedules.filter(Boolean).length === 0
  ) {
    return 'Scheduled workflows need `--schedule "<cron>"`, for example `--schedule "0 9 * * *"`.'
  }
  if (
    githubWorkflowTriggersRequirePrompt(triggers) &&
    !request.prompt?.trim()
  ) {
    return "`--prompt` is required for `issues`, `schedule`, and `workflow_dispatch` triggers because BetterC0de cannot extract a user prompt from a comment body for those events."
  }
  return null
}

function buildGithubAgentWorkflowYaml(
  request: GithubWorkflowInstallRequest & {
    provider: string
    model: string
  }
): string {
  const envEntries = [
    ...resolveGithubWorkflowEnvNames(request).map(
      (env) => `${env}: \${{ secrets.${env} }}`
    ),
    request.useGithubToken ? "GITHUB_TOKEN: ${{ github.token }}" : "",
  ].filter(Boolean)
  const envBlock =
    envEntries.length > 0
      ? `\n        env:${envEntries.map((entry) => `\n          ${entry}`).join("")}`
      : ""
  const withEntries = buildGithubWorkflowWithEntries(request)
  const ifCondition = buildGithubWorkflowMentionCondition(request)
  const onBlock = buildGithubWorkflowOnBlock(request)
  const permissionsBlock = buildGithubWorkflowPermissionsBlock(request)

  return `name: betterc0de

${onBlock}

jobs:
  betterc0de:
    if: |
      ${ifCondition}
    runs-on: ubuntu-latest
    permissions:
${permissionsBlock}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          persist-credentials: false

      - name: Run BetterC0de
        uses: betterc0de-ai/betterc0de-github@latest${envBlock}
        with:
${withEntries.map(([key, value]) => `          ${key}: ${formatGithubWorkflowValue(value)}`).join("\n")}
`
}

const GITHUB_WORKFLOW_PROVIDER_ENV: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  "anthropic-api": ["ANTHROPIC_API_KEY"],
  claude: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "openai-api": ["OPENAI_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  gemini: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "or-qwen": ["OPENROUTER_API_KEY"],
  "or-deepseek": ["OPENROUTER_API_KEY"],
  grok: ["XAI_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  "amazon-bedrock": [],
}

function resolveGithubWorkflowEnvNames(
  request: Pick<GithubWorkflowInstallRequest, "env"> & { provider?: string }
): string[] {
  const provider = normalizeGithubWorkflowProviderId(request.provider ?? "")
  const defaults = GITHUB_WORKFLOW_PROVIDER_ENV[provider] ?? []
  return Array.from(new Set([...defaults, ...request.env])).filter(
    isGithubWorkflowEnvName
  )
}

function normalizeGithubWorkflowProviderId(provider: string): string {
  return provider
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
}

function buildGithubWorkflowPermissionsBlock(
  request: GithubWorkflowInstallRequest
): string {
  const access = request.useGithubToken ? "write" : "read"
  return [
    "      id-token: write",
    `      contents: ${access}`,
    `      pull-requests: ${access}`,
    `      issues: ${access}`,
  ].join("\n")
}

function buildGithubWorkflowOnBlock(
  request: GithubWorkflowInstallRequest
): string {
  const triggers = resolveGithubWorkflowTriggers(request)
  const lines = ["on:"]
  if (triggers.includes("issue_comment")) {
    lines.push("  issue_comment:", "    types: [created]")
  }
  if (triggers.includes("pull_request_review_comment")) {
    lines.push("  pull_request_review_comment:", "    types: [created]")
  }
  if (triggers.includes("issues")) {
    lines.push("  issues:", "    types: [opened]")
  }
  if (triggers.includes("pull_request")) {
    lines.push("  pull_request:", "    types: [opened, synchronize, reopened]")
  }
  if (triggers.includes("workflow_dispatch")) {
    lines.push("  workflow_dispatch:")
  }
  if (triggers.includes("schedule")) {
    lines.push("  schedule:")
    for (const cron of request.schedules) {
      lines.push(`    - cron: ${formatGithubWorkflowValue(cron)}`)
    }
  }
  return lines.join("\n")
}

function resolveGithubWorkflowTriggers(
  request: GithubWorkflowInstallRequest
): GithubWorkflowTrigger[] {
  return request.triggers.length > 0
    ? Array.from(new Set(request.triggers))
    : [...GITHUB_WORKFLOW_DEFAULT_TRIGGERS]
}

function githubWorkflowTriggersRequirePrompt(
  triggers: readonly GithubWorkflowTrigger[]
): boolean {
  return triggers.some(
    (trigger) =>
      trigger === "issues" ||
      trigger === "schedule" ||
      trigger === "workflow_dispatch"
  )
}

function buildGithubWorkflowMentionCondition(
  request: GithubWorkflowInstallRequest
): string {
  const triggers = resolveGithubWorkflowTriggers(request)
  const commentCondition = buildGithubWorkflowMentionBodyCondition(request)
  const conditions: string[] = []
  if (triggers.includes("issue_comment")) {
    conditions.push(
      `(github.event_name == 'issue_comment' && (${commentCondition}))`
    )
  }
  if (triggers.includes("pull_request_review_comment")) {
    conditions.push(
      `(github.event_name == 'pull_request_review_comment' && (${commentCondition}))`
    )
  }
  if (triggers.includes("issues"))
    conditions.push("github.event_name == 'issues'")
  if (triggers.includes("pull_request")) {
    conditions.push("github.event_name == 'pull_request'")
  }
  if (triggers.includes("workflow_dispatch")) {
    conditions.push("github.event_name == 'workflow_dispatch'")
  }
  if (triggers.includes("schedule")) {
    conditions.push("github.event_name == 'schedule'")
  }
  return conditions.join(" ||\n      ")
}

function buildGithubWorkflowMentionBodyCondition(
  request: GithubWorkflowInstallRequest
): string {
  return parseGithubWorkflowMentions(request.mentions)
    .flatMap((mention) => [
      `contains(github.event.comment.body, ' ${mention}')`,
      `startsWith(github.event.comment.body, '${mention}')`,
    ])
    .join(" || ")
}

function parseGithubWorkflowMentions(value: string | undefined): string[] {
  const mentions = (value || "/bc,/betterc0de")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^\/[A-Za-z0-9._-]+$/.test(entry))
  return mentions.length > 0
    ? Array.from(new Set(mentions))
    : ["/bc", "/betterc0de"]
}

function buildGithubWorkflowWithEntries(
  request: GithubWorkflowInstallRequest & {
    provider: string
    model: string
  }
): Array<[string, string]> {
  return [
    ["model", `${request.provider}/${request.model}`],
    request.agent ? ["agent", request.agent] : undefined,
    request.share !== undefined ? ["share", String(request.share)] : undefined,
    request.prompt ? ["prompt", request.prompt] : undefined,
    request.useGithubToken ? ["use_github_token", "true"] : undefined,
    request.mentions ? ["mentions", request.mentions] : undefined,
    request.variant ? ["variant", request.variant] : undefined,
    request.oidcBaseUrl ? ["oidc_base_url", request.oidcBaseUrl] : undefined,
  ].filter((entry): entry is [string, string] => Boolean(entry))
}

function formatGithubWorkflowValue(value: string): string {
  return JSON.stringify(value)
}
