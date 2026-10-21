import { slugifyRuntimeId, stringifyCliArgs } from "@/lib/cli-parse"
import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { HttpError } from "@/lib/errors/types"
import { type RuntimeSubagent } from "@/lib/runtime-config"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { readFile, writeFile } from "@/services/backend/workspaceApi"
import {
  formatBooleanMap,
  formatListPlain,
  formatPermissionRules,
} from "./input-context"
import { formatDebugPathCell } from "./lsp-commands"
import {
  buildMcpTerminalSection,
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  parseFiniteNonNegativeNumber,
  parsePluginToggleBoolean,
  type ActiveThreadRef,
} from "./provider-config"
import { parseBetterC0dePositiveInteger } from "./runtime-config"

export function isBetterC0deProviderModelId(model: string): boolean {
  return splitBetterC0deProviderModelId(model) !== null
}

export function splitBetterC0deProviderModelId(
  value: string
): { provider: string; model: string } | null {
  const [provider, ...rest] = value.trim().split("/")
  const model = rest.join("/")
  if (!provider || !model) return null
  return { provider, model }
}

export function buildBetterC0deAgentTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  const normalized = command.replace(/^\//, "").toLowerCase()
  const shouldOpen = args.some(isBetterC0deRuntimeTerminalFlag)
  if (normalized.includes("debug.agent") || normalized === "debug-agent") {
    return {
      command: ["betterc0de debug agent", stringifyCliArgs(cleanArgs)]
        .filter(Boolean)
        .join(" "),
      shouldOpen,
    }
  }
  if (normalized.includes("create")) {
    return {
      command: ["betterc0de agent create", stringifyCliArgs(cleanArgs)]
        .filter(Boolean)
        .join(" "),
      shouldOpen,
    }
  }
  return {
    command: "betterc0de agent list",
    shouldOpen,
  }
}

export function buildRuntimeSubagentDetailOutput(
  agent: RuntimeSubagent
): string {
  return [
    `# ${agent.name}\n`,
    "Compatibility reference: `betterc0de debug agent <name>`.",
    "",
    "| | |",
    "|:--|:--|",
    "| **Type** | Subagent |",
    `| **ID** | \`${agent.id}\` |`,
    `| **Status** | ${formatSubagentStatus(agent)} |`,
    agent.mode ? `| **Mode** | ${escapeMarkdownTableCell(agent.mode)} |` : "",
    agent.model
      ? `| **Model** | \`${escapeMarkdownTableCell(agent.model)}\` |`
      : "",
    agent.variant
      ? `| **Variant** | \`${escapeMarkdownTableCell(agent.variant)}\` |`
      : "",
    agent.temperature !== undefined
      ? `| **Temperature** | ${agent.temperature} |`
      : "",
    agent.topP !== undefined ? `| **Top P** | ${agent.topP} |` : "",
    agent.steps !== undefined ? `| **Steps** | ${agent.steps} |` : "",
    agent.color
      ? `| **Color** | ${escapeMarkdownTableCell(agent.color)} |`
      : "",
    agent.tools && Object.keys(agent.tools).length
      ? `| **Tools** | ${escapeMarkdownTableCell(formatBooleanMap(agent.tools))} |`
      : "",
    agent.permissions?.length
      ? `| **Permissions** | ${escapeMarkdownTableCell(formatPermissionRules(agent.permissions))} |`
      : "",
    agent.optionKeys?.length
      ? `| **Options** | ${escapeMarkdownTableCell(formatListPlain(agent.optionKeys))} |`
      : "",
    agent.sourcePath
      ? `| **Source** | \`${escapeMarkdownTableCell(agent.sourcePath)}\` |`
      : "",
    agent.description
      ? `| **Description** | ${escapeMarkdownTableCell(agent.description)} |`
      : "",
    "",
    agent.prompt ? `---\n\n${agent.prompt}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildRuntimeSubagentDebugOutput(
  agent: RuntimeSubagent,
  args: ReadonlyArray<string>,
  terminalCommand?: string
): string {
  const request = parseRuntimeSubagentDebugArgs(args)
  if (!request.tool) {
    return [
      buildRuntimeSubagentDetailOutput(agent),
      terminalCommand
        ? ["", buildMcpTerminalSection(terminalCommand)].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  const availableTools = Object.keys(agent.tools ?? {}).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  )
  const toolState = agent.tools?.[request.tool]
  const params = parseBetterC0deDebugAgentParams(request.paramsRaw)
  const rows = [
    `| **Agent** | \`${escapeMarkdownTableCell(agent.id)}\` |`,
    `| **Tool** | \`${escapeMarkdownTableCell(request.tool)}\` |`,
    `| **State** | ${escapeMarkdownTableCell(formatDebugAgentToolState(toolState))} |`,
    agent.sourcePath
      ? `| **Source** | \`${escapeMarkdownTableCell(agent.sourcePath)}\` |`
      : "",
  ].filter(Boolean)

  return [
    "# BetterC0de Debug Agent Tool",
    "",
    "Compatibility reference: `betterc0de debug agent <name> --tool <tool> --params <json>`.",
    "",
    "| | |",
    "|:--|:--|",
    ...rows,
    "",
    toolState === false
      ? `> Tool \`${escapeInlineCode(request.tool)}\` is disabled for this agent by BetterC0de permission/tool config.`
      : "",
    toolState === undefined && availableTools.length > 0
      ? `> Tool \`${escapeInlineCode(request.tool)}\` is not in this agent's currently visible tool map. Known tools: ${availableTools.map((tool) => `\`${escapeInlineCode(tool)}\``).join(", ")}.`
      : "",
    params.error
      ? `> Could not parse \`--params\` as JSON object: ${escapeMarkdownTableCell(params.error)}. the compatibility CLI's CLI also accepts JS object literals; BetterC0de does not evaluate those inside chat.`
      : "",
    params.value
      ? ["## Params", "", "```json", params.value, "```"].join("\n")
      : "",
    "",
    "> BetterC0de does not execute debug tool calls from chat. Use the integrated terminal handoff when you intentionally want BetterC0de to run the tool in its own debug context.",
    "",
    terminalCommand ? buildMcpTerminalSection(terminalCommand) : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function parseRuntimeSubagentDebugArgs(args: ReadonlyArray<string>): {
  tool?: string
  paramsRaw?: string
} {
  const out: { tool?: string; paramsRaw?: string } = {}
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (arg === "--tool") {
      out.tool = args[index + 1]?.trim()
      index += 1
      continue
    }
    if (arg.startsWith("--tool=")) {
      out.tool = arg.slice("--tool=".length).trim()
      continue
    }
    if (arg === "--params") {
      out.paramsRaw = args[index + 1] ?? ""
      index += 1
      continue
    }
    if (arg.startsWith("--params=")) {
      out.paramsRaw = arg.slice("--params=".length)
    }
  }
  return out
}

function parseBetterC0deDebugAgentParams(raw: string | undefined): {
  value?: string
  error?: string
} {
  if (raw === undefined || raw.trim().length === 0) {
    return { value: "{}" }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Tool params must be a JSON object." }
    }
    return { value: JSON.stringify(parsed, null, 2) }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function formatDebugAgentToolState(value: boolean | undefined): string {
  if (value === true) return "enabled"
  if (value === false) return "disabled"
  return "unknown"
}

export async function buildAgentCreateOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const terminalCommand = buildBetterC0deAgentTerminalCommand(
    "/agent-create",
    args
  )
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  const cliArgs = stringifyCliArgs(cleanArgs)
  const command = ["betterc0de agent create", cliArgs].filter(Boolean).join(" ")
  const request = parseAgentCreateArgs(cleanArgs)
  if (request.errors.length > 0) {
    return [
      "# BetterC0de Agent Create",
      "",
      "> Could not create the agent file.",
      "",
      ...request.errors.map((error) => `- ${error}`),
      "",
      "Compatibility reference: `betterc0de agent create --model provider/model`.",
    ].join("\n")
  }
  const canWrite =
    Boolean(runtimePath) &&
    Boolean(request.description) &&
    Boolean(request.mode) &&
    request.permissionsRaw !== undefined &&
    !request.dryRun &&
    !terminalCommand.shouldOpen

  if (canWrite && runtimePath && request.description && request.mode) {
    return writeProjectAgentFromChat({
      runtimePath,
      request: {
        ...request,
        description: request.description,
        mode: request.mode,
      },
      command,
    })
  }

  return [
    "# BetterC0de Agent Create",
    "",
    "Compatibility reference: `betterc0de agent create`.",
    "",
    `Workspace: ${runtimePath ? formatDebugPathCell(runtimePath) : "No folder open"}`,
    "",
    "Opened **Settings > Skills & Subagents**.",
    "",
    args.length > 0
      ? ["## Requested Command", "", "```sh", command, "```"].join("\n")
      : [
          "## Usage",
          "",
          "```sh",
          'betterc0de agent create --description "Review React performance" --mode subagent --permissions read,grep,lsp --model provider/model',
          'betterc0de agent create --path .betterc0de --description "Write tests" --mode all --permissions read,edit,grep',
          "```",
          "",
          'Chat usage: `/agent-create --description "..." --mode all|primary|subagent --permissions read,edit,grep --model provider/model --variant careful --temperature 0.2 --top-p 0.8 --color primary --steps 7 --hidden true`.',
        ].join("\n"),
    "",
    "Compatibility writes generated agent markdown to `agents/<identifier>.md` under the selected global config or `.betterc0de/agents/` project folder.",
    terminalCommand.shouldOpen && terminalCommand.command
      ? [
          "",
          buildMcpTerminalSection(terminalCommand.command),
          "",
          "> Opened the terminal panel with this BetterC0de agent command prefilled. BetterC0de did not create a project agent file in terminal mode.",
        ].join("\n")
      : "",
    "",
    "Minimal project agent shape:",
    "",
    "```md",
    "---",
    "description: When this agent should be used",
    "mode: subagent",
    "permission:",
    "  bash: deny",
    "---",
    "",
    "System prompt for the agent.",
    "```",
    "",
    request.description && request.mode && request.permissionsRaw === undefined
      ? '> Add `--permissions read,grep,lsp` or `--permissions ""` to write a project agent file from chat. This mirrors the BetterC0de-compatible non-interactive create flow.'
      : "> BetterC0de writes project agent files only for fully specified non-interactive `/agent-create` commands. Use `--description`, `--mode`, and `--permissions` together.",
  ].join("\n")
}

type AgentCreateMode = "all" | "primary" | "subagent"

interface AgentCreateRequest {
  description?: string
  mode?: AgentCreateMode
  permissionsRaw?: string
  permissions: string[]
  model?: string
  variant?: string
  temperature?: number
  topP?: number
  color?: string
  steps?: number
  hidden?: boolean
  prompt?: string
  name?: string
  path?: string
  dryRun: boolean
  force: boolean
  errors: string[]
}

const AGENT_CREATE_PERMISSIONS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "websearch",
  "lsp",
  "skill",
]

function parseAgentCreateArgs(args: ReadonlyArray<string>): AgentCreateRequest {
  const request: AgentCreateRequest = {
    permissions: [...AGENT_CREATE_PERMISSIONS],
    dryRun: false,
    force: false,
    errors: [],
  }
  const descriptionParts: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ?? arg
    const inlineValue = inline?.[2]
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue
      index += 1
      return args[index] ?? ""
    }
    const nextOptionalValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const value = args[index + 1]
      if (!value || value.startsWith("-")) return undefined
      index += 1
      return value
    }

    switch (key) {
      case "--description":
      case "-d":
        request.description = nextValue().trim()
        break
      case "--mode": {
        const value = nextValue().trim().toLowerCase()
        if (value === "all" || value === "primary" || value === "subagent") {
          request.mode = value
        }
        break
      }
      case "--permissions":
      case "--tools": {
        const value = nextValue()
        request.permissionsRaw = value
        request.permissions = parseAgentPermissions(value)
        break
      }
      case "--model":
      case "-m": {
        const value = nextValue().trim()
        if (value && !isBetterC0deProviderModelId(value)) {
          request.errors.push(
            "`--model` must use the compatibility CLI's `provider/model` format."
          )
        } else {
          request.model = value
        }
        break
      }
      case "--variant": {
        const value = parseAgentCreateIdentifierValue(nextValue())
        if (value) request.variant = value
        break
      }
      case "--temperature": {
        const value = parseFiniteNonNegativeNumber(nextValue())
        if (typeof value === "number") request.temperature = value
        break
      }
      case "--top-p":
      case "--top_p": {
        const value = parseFiniteNonNegativeNumber(nextValue())
        if (typeof value === "number") request.topP = value
        break
      }
      case "--color": {
        const value = parseAgentCreateColor(nextValue())
        if (value) request.color = value
        break
      }
      case "--steps":
      case "--max-steps": {
        const value = parseBetterC0dePositiveInteger(nextValue())
        if (typeof value === "number") request.steps = value
        break
      }
      case "--hidden": {
        const value = parsePluginToggleBoolean(nextOptionalValue() ?? "true")
        if (value !== undefined) request.hidden = value
        break
      }
      case "--prompt":
      case "--system-prompt": {
        const value = nextValue().trim()
        if (value) request.prompt = value
        break
      }
      case "--name":
      case "--id":
        request.name = nextValue().trim()
        break
      case "--path":
        request.path = nextValue().trim()
        break
      case "--dry-run":
        request.dryRun = true
        break
      case "--force":
        request.force = true
        break
      default:
        if (!arg.startsWith("-")) descriptionParts.push(arg)
        break
    }
  }

  if (!request.description && descriptionParts.length > 0) {
    request.description = descriptionParts.join(" ").trim()
  }
  return request
}

function parseAgentCreateIdentifierValue(value: string): string | undefined {
  const trimmed = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(trimmed) ? trimmed : undefined
}

const AGENT_CREATE_THEME_COLORS = new Set([
  "primary",
  "secondary",
  "accent",
  "success",
  "warning",
  "error",
  "info",
])

function parseAgentCreateColor(value: string): string | undefined {
  const trimmed = value.trim()
  const normalized = trimmed.toLowerCase()
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed
  return AGENT_CREATE_THEME_COLORS.has(normalized) ? normalized : undefined
}

function parseAgentPermissions(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return [...AGENT_CREATE_PERMISSIONS]
  const selected = trimmed
    .split(",")
    .map((permission) => permission.trim().toLowerCase())
    .filter((permission) => AGENT_CREATE_PERMISSIONS.includes(permission))
  return selected.length > 0 ? selected : [...AGENT_CREATE_PERMISSIONS]
}

async function writeProjectAgentFromChat(input: {
  runtimePath: string
  request: AgentCreateRequest & {
    description: string
    mode: AgentCreateMode
  }
  command: string
}): Promise<string> {
  const identifier =
    slugifyRuntimeId(input.request.name || input.request.description).slice(
      0,
      48
    ) || "agent"
  const targetDirectory = normalizeAgentCreateTargetDirectory(
    input.request.path
  )
  if (!targetDirectory) {
    return [
      "# BetterC0de Agent Create",
      "",
      "> Could not create the agent file.",
      "",
      "Error: `--path` must be a relative workspace path.",
    ].join("\n")
  }
  const relativePath = `${targetDirectory}/${identifier}.md`
  const absoluteTarget = resolveWorkspaceFilePath(
    input.runtimePath,
    relativePath
  )
  if (!input.request.force) {
    try {
      await readFile(absoluteTarget, { silent404: true })
      return [
        "# BetterC0de Agent Create",
        "",
        "> Agent file already exists.",
        "",
        `Target: \`${escapeMarkdownTableCell(relativePath)}\``,
        "",
        "Use `--force` to overwrite it intentionally.",
      ].join("\n")
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) {
        return [
          "# BetterC0de Agent Create",
          "",
          "> Could not verify whether the target agent file already exists.",
          "",
          `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
        ].join("\n")
      }
    }
  }

  const content = buildProjectAgentMarkdown(input.request, identifier)
  try {
    await writeFile(input.runtimePath, relativePath, content)
  } catch (error) {
    return [
      "# BetterC0de Agent Create",
      "",
      "> Could not create the agent file.",
      "",
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }

  return [
    "# BetterC0de Agent Create",
    "",
    "Created a project agent file from the fully specified BetterC0de-compatible command.",
    "",
    `Target: \`${escapeMarkdownTableCell(relativePath)}\``,
    `Identifier: \`${escapeMarkdownTableCell(identifier)}\``,
    `Mode: \`${escapeMarkdownTableCell(input.request.mode)}\``,
    input.request.model
      ? `Model: \`${escapeMarkdownTableCell(input.request.model)}\``
      : "",
    input.request.variant
      ? `Variant: \`${escapeMarkdownTableCell(input.request.variant)}\``
      : "",
    typeof input.request.temperature === "number"
      ? `Temperature: ${input.request.temperature}`
      : "",
    typeof input.request.topP === "number"
      ? `Top P: ${input.request.topP}`
      : "",
    input.request.color
      ? `Color: \`${escapeMarkdownTableCell(input.request.color)}\``
      : "",
    typeof input.request.steps === "number"
      ? `Steps: ${input.request.steps}`
      : "",
    typeof input.request.hidden === "boolean"
      ? `Hidden: ${input.request.hidden ? "true" : "false"}`
      : "",
    `Allowed permissions: ${escapeMarkdownTableCell(formatListPlain(input.request.permissions))}`,
    "",
    "## Requested Command",
    "",
    "```sh",
    input.command,
    "```",
  ]
    .filter(Boolean)
    .join("\n")
}

function normalizeAgentCreateTargetDirectory(
  requestedPath: string | undefined
): string | null {
  const raw = (requestedPath || ".betterc0de").trim() || ".betterc0de"
  const normalized = raw.replace(/\\/g, "/").replace(/^\.?\//, "")
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return null
  }
  const withoutTrailing = normalized.replace(/\/+$/g, "")
  return withoutTrailing.endsWith("/agents") || withoutTrailing === "agents"
    ? withoutTrailing
    : `${withoutTrailing}/agents`
}

function buildProjectAgentMarkdown(
  request: AgentCreateRequest & {
    description: string
    mode: AgentCreateMode
  },
  identifier: string
): string {
  const deniedPermissions = AGENT_CREATE_PERMISSIONS.filter(
    (permission) => !request.permissions.includes(permission)
  )
  return [
    "---",
    `description: ${quoteYamlString(request.description)}`,
    `mode: ${request.mode}`,
    request.model ? `model: ${quoteYamlString(request.model)}` : "",
    request.variant ? `variant: ${quoteYamlString(request.variant)}` : "",
    typeof request.temperature === "number"
      ? `temperature: ${request.temperature}`
      : "",
    typeof request.topP === "number" ? `top_p: ${request.topP}` : "",
    request.color ? `color: ${quoteYamlString(request.color)}` : "",
    typeof request.steps === "number" ? `steps: ${request.steps}` : "",
    typeof request.hidden === "boolean"
      ? `hidden: ${request.hidden ? "true" : "false"}`
      : "",
    deniedPermissions.length > 0 ? "permission:" : "",
    ...deniedPermissions.map((permission) => `  ${permission}: deny`),
    "---",
    "",
    request.prompt ||
      [
        `You are the ${identifier} agent.`,
        "",
        request.description,
        "",
        "Work style:",
        "- Stay inside the assigned scope unless the user asks otherwise.",
        "- Inspect the repository before changing files.",
        "- Report concrete files changed and verification run.",
        "- Keep responses concise and grounded in the codebase.",
      ].join("\n"),
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value)
}

export function formatSubagentStatus(agent: RuntimeSubagent): string {
  if (!agent.enabled) return "Disabled"
  if (agent.hidden) return "Hidden"
  return "Enabled"
}
