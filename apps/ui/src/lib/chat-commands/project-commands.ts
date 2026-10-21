import { isReservedBuiltinSlashCommandName } from "@/lib/slash-command-catalog"
import { type RuntimeSkill } from "@/lib/runtime-config"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import type {
  WorkspaceProjectCommand,
  WorkspaceProjectReference,
} from "@/services/backend/workspaceApi"
import {
  loadProjectBetterC0deConfigForChat,
  writeProjectBetterC0deConfigForChat,
} from "./mcp-commands"
import {
  escapeMarkdownTableCell,
  parsePluginToggleBoolean,
  type ActiveThreadRef,
} from "./provider-config"

export function buildProjectCommandsOutput(
  commands: ReadonlyArray<WorkspaceProjectCommand>,
  skills: ReadonlyArray<RuntimeSkill>,
  activeThread: ActiveThreadRef
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Project Commands\n\n> No workspace folder is open."
  }
  const skillCommands = projectSkillCommandRows(skills, commands)
  if (commands.length === 0 && skillCommands.length === 0) {
    return [
      "# Project Commands\n",
      "> No repo-local compatibility command templates found.",
      "",
      "Create markdown templates in `.betterc0de/command/` or `.betterc0de/commands/`, or add project skills under `.betterc0de/skill(s)/` to expose them as slash commands.",
    ].join("\n")
  }
  return [
    "# Project Commands\n",
    `${commands.length + skillCommands.length} command${commands.length + skillCommands.length > 1 ? "s" : ""} loaded from \`${runtimePath}\`\n`,
    commands.length === 0
      ? "> No markdown command templates found."
      : [
          "| Command | Source | Agent | Model | Subtask | Description |",
          "|:--------|:-------|:------|:------|:--------|:------------|",
          ...commands.map((command) => {
            const cells = [
              `\`/${escapeMarkdownTableCell(command.name)}\``,
              `\`${escapeMarkdownTableCell(command.sourcePath)}\``,
              escapeMarkdownTableCell(command.agent ?? "-"),
              escapeMarkdownTableCell(command.model ?? "-"),
              escapeMarkdownTableCell(
                projectCommandSubtaskLabel(command.subtask)
              ),
              escapeMarkdownTableCell(command.description ?? ""),
            ]
            return `| ${cells.join(" | ")} |`
          }),
        ].join("\n"),
    "",
    "## Skill Commands\n",
    skillCommands.length === 0
      ? "> No runnable project/runtime skill commands found."
      : [
          "| Command | Source | Description |",
          "|:--------|:-------|:------------|",
          ...skillCommands,
        ].join("\n"),
    "",
    "> Run one with `/<command> [arguments]`. Templates support `$ARGUMENTS`, `$1`, `$2`, and other positional placeholders.",
  ].join("\n")
}

export function buildRuntimeSkillsOutput(
  skills: ReadonlyArray<RuntimeSkill>,
  args: ReadonlyArray<string> = []
): string {
  const json = args.includes("--json") || args.includes("--format=json")
  if (json) return buildRuntimeSkillsJsonOutput(skills)

  const verbose = args.includes("--verbose") || args.includes("-v")
  if (verbose) return buildRuntimeSkillsVerboseOutput(skills)

  if (skills.length === 0) {
    return "# Skills\n\n> No installed or project-local skills found yet.\n>\n> Open the **Marketplace** to browse and install skills, create your own in the **Create Skill** tab, or add repo skills under `.betterc0de/skills/`."
  }

  return [
    "# Skills\n",
    `${skills.filter((skill) => skill.enabled).length} enabled · ${skills.length} installed\n`,
    "Type `/` and choose **Skills** to find a skill, or copy an invocation below.\n",
    "| Skill | Invocation |",
    "|:------|:-----------|",
    ...skills.map(
      (skill) =>
        `| **${escapeMarkdownTableCell(skill.name)}**${skill.enabled ? "" : " — Disabled"} | \`@${escapeMarkdownTableCell(skill.id)}\` |`
    ),
    "",
    "> Use `/<skill-id>` to run a runtime/project skill, `@<skill-id>` to attach it, or `$<skill>` for a provider-native skill. Existing commands take precedence when names overlap.",
    "",
    "Full source paths and skill contents: `/skills --json`. Descriptions: `/skills --verbose`.",
  ].join("\n")
}

function buildRuntimeSkillsJsonOutput(
  skills: ReadonlyArray<RuntimeSkill>
): string {
  const payload = skills
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
      location: formatBetterC0deSkillLocation(skill),
      content: skill.content,
    }))

  return [
    "# Skills Debug",
    "",
    "Compatibility reference: `betterc0de debug skill`.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n")
}

function buildRuntimeSkillsVerboseOutput(
  skills: ReadonlyArray<RuntimeSkill>
): string {
  const described = skills
    .filter((skill) => typeof skill.description === "string")
    .filter((skill) => skill.description!.trim().length > 0)
    .toSorted((a, b) => a.name.localeCompare(b.name))

  if (described.length === 0) {
    return [
      "# Skills",
      "",
      "Compatibility verbose format: `Skill.fmt(list, { verbose: true })`.",
      "",
      "> No described skills are currently available.",
    ].join("\n")
  }

  const xml = [
    "<available_skills>",
    ...described.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXmlText(skill.name)}</name>`,
      `    <description>${escapeXmlText(skill.description ?? "")}</description>`,
      `    <location>${escapeXmlText(formatBetterC0deSkillLocation(skill))}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n")

  return [
    "# Skills",
    "",
    "Compatibility verbose format: `Skill.fmt(list, { verbose: true })`.",
    "",
    "```xml",
    xml,
    "```",
    "",
    "> Skills without a description are omitted, matching BetterC0de compatibility model prompt surface.",
  ].join("\n")
}

function formatRuntimeSkillLocation(skill: RuntimeSkill): string {
  return skill.sourcePath || skill.sourceUrl || skill.source || "local"
}

function formatBetterC0deSkillLocation(skill: RuntimeSkill): string {
  const location = formatRuntimeSkillLocation(skill)
  if (location.startsWith("/")) return `file://${encodeURI(location)}`
  return location
}

export function projectCommandSubtaskLabel(
  subtask: boolean | undefined
): string {
  return typeof subtask === "boolean" ? (subtask ? "enabled" : "disabled") : "-"
}

function projectSkillCommandRows(
  skills: ReadonlyArray<RuntimeSkill>,
  commands: ReadonlyArray<WorkspaceProjectCommand>
): string[] {
  const commandNames = new Set(
    commands.map((command) => command.name.trim().toLowerCase())
  )
  return skills
    .filter((skill) => skill.enabled && skill.id.trim().length > 0)
    .filter((skill) => !commandNames.has(skill.id.trim().toLowerCase()))
    .filter((skill) => !isReservedBuiltinSlashCommandName(skill.id))
    .map(
      (skill) =>
        `| \`/${escapeMarkdownTableCell(skill.id)}\` | \`${escapeMarkdownTableCell(skill.sourcePath || skill.sourceUrl || skill.source || "local")}\` | ${escapeMarkdownTableCell(skill.description ?? skill.name)} |`
    )
}

export async function buildProjectCommandConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Project Commands\n\n> Open a workspace folder before using `--config-only`."
  }

  const request = parseProjectCommandConfigArgs(args)
  if (!request.name) {
    return [
      "# Project Commands",
      "",
      '> Usage: `/commands --config-only review --template "Review {{args}}" --description "Review code" --agent build`',
      "> Remove usage: `/commands --config-only review --remove`",
    ].join("\n")
  }
  if (/[`\s,]/.test(request.name)) {
    return "# Project Commands\n\n> Command name must not contain whitespace, comma, or backtick."
  }
  if (!request.remove && !request.template) {
    return "# Project Commands\n\n> Provide `--template <text>` or `--remove`."
  }

  const loaded = await loadProjectBetterC0deConfigForChat(
    runtimePath,
    "Project Commands"
  )
  if ("output" in loaded) return loaded.output
  const command =
    loaded.config.command &&
    typeof loaded.config.command === "object" &&
    !Array.isArray(loaded.config.command)
      ? { ...(loaded.config.command as Record<string, unknown>) }
      : {}
  if (request.remove) {
    delete command[request.name]
  } else if (request.template) {
    command[request.name] = {
      template: request.template,
      ...(request.description ? { description: request.description } : {}),
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.subtask !== undefined ? { subtask: request.subtask } : {}),
    }
  }
  loaded.config.command = command

  return writeProjectBetterC0deConfigForChat({
    runtimePath,
    config: loaded.config,
    configPath: loaded.configPath,
    existed: loaded.existed,
    heading: "Project Commands",
    settings: [`command.${request.name}`],
  })
}

interface ProjectCommandConfigRequest {
  name?: string
  template?: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
  remove: boolean
}

function parseProjectCommandConfigArgs(
  args: ReadonlyArray<string>
): ProjectCommandConfigRequest {
  const request: ProjectCommandConfigRequest = { remove: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
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
      case "--config-only":
        break
      case "--name":
        request.name = nextValue().trim().replace(/^\/+/, "")
        break
      case "--template":
      case "--prompt":
        request.template = nextValue()
        break
      case "--description":
        request.description = nextValue()
        break
      case "--agent":
        request.agent = nextValue().trim()
        break
      case "--model":
        request.model = nextValue().trim()
        break
      case "--subtask": {
        const value = parsePluginToggleBoolean(nextOptionalValue() ?? "true")
        if (value !== undefined) request.subtask = value
        break
      }
      case "--remove":
      case "--delete":
        request.remove = true
        break
      default:
        if (!arg.startsWith("-") && !request.name) {
          request.name = arg.trim().replace(/^\/+/, "")
        }
        break
    }
  }
  return request
}

export function buildProjectReferencesOutput(
  references: ReadonlyArray<WorkspaceProjectReference>,
  activeThread: ActiveThreadRef
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Project References\n\n> No workspace folder is open."
  }
  if (references.length === 0) {
    return [
      "# Project References\n",
      "> No BetterC0de compatibility project references found.",
      "",
      "Add `reference` entries to `betterc0de.json` or `betterc0de.jsonc` to expose aliases like `@docs` or `@docs/path`.",
    ].join("\n")
  }

  return [
    "# Project References\n",
    `${references.length} reference${references.length > 1 ? "s" : ""} configured in \`${runtimePath}\`\n`,
    "| Reference | Kind | Target | Source | Status |",
    "|:----------|:-----|:-------|:-------|:-------|",
    ...references.map((reference) => {
      const target =
        reference.kind === "git"
          ? (reference.repository ?? "")
          : (reference.relativePath ?? reference.path ?? "")
      const status =
        reference.kind === "invalid"
          ? (reference.message ?? "Invalid")
          : reference.message
            ? reference.message
            : "Ready"
      return `| \`@${escapeMarkdownTableCell(reference.id)}\` | ${reference.kind} | ${escapeMarkdownTableCell(target)}${reference.branch ? ` (${escapeMarkdownTableCell(reference.branch)})` : ""} | \`${escapeMarkdownTableCell(reference.sourcePath)}\` | ${escapeMarkdownTableCell(status)} |`
    }),
    "",
    "> Mention a configured reference with `@<alias>` or `@<alias>/<path>`. Git references are surfaced as metadata; BetterC0de does not clone remote references automatically.",
  ].join("\n")
}

export async function buildProjectReferenceConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Project References\n\n> Open a workspace folder before using `--config-only`."
  }

  const request = parseProjectReferenceConfigArgs(args)
  if (!request.alias) {
    return [
      "# Project References",
      "",
      "> Usage: `/references --config-only --alias docs --path ./docs`",
      "> Git usage: `/references --config-only --alias sdk --repo owner/repo --branch main`",
      "> Remove usage: `/references --config-only --alias docs --remove`",
    ].join("\n")
  }
  if (/[/\s`,]/.test(request.alias)) {
    return "# Project References\n\n> Reference alias must not contain `/`, whitespace, comma, or backtick."
  }
  if (!request.remove && !request.path && !request.repository) {
    return "# Project References\n\n> Provide `--path <dir>` or `--repo <repo>` for this reference."
  }

  const loaded = await loadProjectBetterC0deConfigForChat(
    runtimePath,
    "Project References"
  )
  if ("output" in loaded) return loaded.output
  const reference =
    loaded.config.reference &&
    typeof loaded.config.reference === "object" &&
    !Array.isArray(loaded.config.reference)
      ? { ...(loaded.config.reference as Record<string, unknown>) }
      : {}

  if (request.remove) {
    delete reference[request.alias]
  } else if (request.path) {
    reference[request.alias] = { path: request.path }
  } else if (request.repository) {
    reference[request.alias] = request.branch
      ? { repository: request.repository, branch: request.branch }
      : { repository: request.repository }
  }
  loaded.config.reference = reference

  return writeProjectBetterC0deConfigForChat({
    runtimePath,
    config: loaded.config,
    configPath: loaded.configPath,
    existed: loaded.existed,
    heading: "Project References",
    settings: [`reference.${request.alias}`],
  })
}

interface ProjectReferenceConfigRequest {
  alias?: string
  path?: string
  repository?: string
  branch?: string
  remove: boolean
}

function parseProjectReferenceConfigArgs(
  args: ReadonlyArray<string>
): ProjectReferenceConfigRequest {
  const request: ProjectReferenceConfigRequest = { remove: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue
      index += 1
      return args[index] ?? ""
    }
    switch (key) {
      case "--config-only":
        break
      case "--alias":
      case "--name":
        request.alias = nextValue().trim()
        break
      case "--path":
      case "--local":
        request.path = nextValue().trim()
        break
      case "--repo":
      case "--repository":
        request.repository = nextValue().trim()
        break
      case "--branch":
      case "--ref":
        request.branch = nextValue().trim()
        break
      case "--remove":
      case "--delete":
        request.remove = true
        break
      default:
        if (!arg.startsWith("-") && !request.alias) {
          request.alias = arg.trim()
        }
        break
    }
  }
  return request
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
