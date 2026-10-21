import type { RuntimeSubagent } from "@/lib/runtime-config"
import {
  buildAgentCreateOutput,
  buildBetterC0deAgentTerminalCommand,
  buildRuntimeSubagentDebugOutput,
  formatSubagentStatus,
} from "./agent-commands"
import {
  buildMcpTerminalSection,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import { buildRuntimeSkillsOutput } from "./project-commands"
import {
  buildProjectInstructionsConfigOutput,
  buildProjectInstructionsOutput,
  buildProjectSkillsConfigOutput,
} from "./project-config-commands"
import { isSlashCommand } from "./prompt-commands"
import { escapeInlineCode, escapeMarkdownTableCell } from "./provider-config"
import { openSettingsTab } from "./settings-actions"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"
import {
  isBetterC0deAgentSlashSubcommand,
  stripBetterC0deAgentSlashSubcommand,
} from "./slash-subcommands"

export function buildRuntimeSubagentListOutput(
  subagents: ReadonlyArray<RuntimeSubagent>,
  terminalCommand?: string
): string {
  const body =
    subagents.length === 0
      ? [
          "# Subagents",
          "",
          "> No subagents configured yet.",
          ">",
          "> Open **Settings > Skills & Subagents** to create or import one.",
        ].join("\n")
      : [
          "# Subagents\n",
          `${subagents.length} subagent${subagents.length > 1 ? "s" : ""} configured\n`,
          "| # | Subagent | Command | Source | Mode | Model | Status |",
          "|:--|:---------|:--------|:-------|:-----|:------|:-------|",
          ...subagents.map(
            (agent, i) =>
              `| ${i + 1} | **${escapeMarkdownTableCell(agent.name)}** | \`/${escapeMarkdownTableCell(agent.id)}\` | ${escapeMarkdownTableCell(agent.sourcePath || agent.source || "local")} | ${escapeMarkdownTableCell(agent.mode ?? "-")} | ${escapeMarkdownTableCell(agent.model ?? "-")} | ${formatSubagentStatus(agent)} |`
          ),
          "",
          "> Type `/<subagent-id>` for details, `/debug.agent <subagent-id>` for BetterC0de-compatible details, or `@<subagent-id>` to inject the subagent prompt into your message.",
        ].join("\n")

  return [
    body,
    terminalCommand
      ? [
          "",
          buildMcpTerminalSection(terminalCommand),
          "",
          "> Opened the terminal panel with this BetterC0de agent command prefilled.",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function resolveRuntimeSubagent(
  subagents: ReadonlyArray<RuntimeSubagent>,
  query: string
): RuntimeSubagent | null {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return null
  return (
    subagents.find(
      (agent) =>
        agent.id.toLowerCase() === normalized ||
        agent.name.toLowerCase() === normalized
    ) ??
    subagents.find(
      (agent) =>
        agent.id.toLowerCase().includes(normalized) ||
        agent.name.toLowerCase().includes(normalized)
    ) ??
    null
  )
}

function buildSubagentNotFoundOutput(
  query: string,
  subagents: ReadonlyArray<RuntimeSubagent>
): string {
  const known = subagents.map((agent) => `\`${agent.id}\``).join(", ")
  return [
    "# Subagents",
    "",
    `> No subagent matched \`${escapeInlineCode(query)}\`.`,
    known ? `\nKnown subagent IDs: ${known}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

/** Skills, subagents and project instructions. `/agent list|debug|create` only reaches this phase when the composer agent-cycle spec declined it. */
export const AGENT_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: [
        "skills",
        "prompt.skills",
        "prompt-skills",
        "debug.skill",
        "debug-skill",
        "app.skills",
      ],
      run: async (run) => {
        const { cmd, args, activeThread, skillList } = run
        if (args.includes("--config-only")) {
          run.output = await buildProjectSkillsConfigOutput(args, activeThread)
        } else {
          run.output = buildRuntimeSkillsOutput(
            skillList,
            isSlashCommand(cmd, "debug.skill", "debug-skill")
              ? [...args, "--json"]
              : args
          )
        }
      },
    },
    {
      names: ["agent"],
      when: ({ cmd, args }) =>
        isBetterC0deAgentSlashSubcommand(cmd, args, "list"),
      run: (run) => {
        const { args, activeThread, subagentList } = run
        const agentArgs = stripBetterC0deAgentSlashSubcommand(args)
        const terminalCommand = buildBetterC0deAgentTerminalCommand(
          "/agents",
          agentArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildRuntimeSubagentListOutput(
          subagentList,
          terminalCommand.shouldOpen ? terminalCommand.command : undefined
        )
      },
    },
    {
      names: ["agent"],
      when: ({ cmd, args }) =>
        isBetterC0deAgentSlashSubcommand(cmd, args, "debug"),
      run: (run) => {
        const { args, activeThread, subagentList } = run
        const agentArgs = stripBetterC0deAgentSlashSubcommand(args)
        const terminalCommand = buildBetterC0deAgentTerminalCommand(
          "/debug.agent",
          agentArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        const cleanArgs = stripBetterC0deRuntimeUiFlags(agentArgs)
        if (cleanArgs[0]) {
          const matchedSubagent = resolveRuntimeSubagent(
            subagentList,
            cleanArgs[0]
          )
          run.output = matchedSubagent
            ? buildRuntimeSubagentDebugOutput(
                matchedSubagent,
                cleanArgs,
                terminalCommand.command
              )
            : buildSubagentNotFoundOutput(cleanArgs[0], subagentList)
        } else {
          run.output = buildRuntimeSubagentListOutput(
            subagentList,
            terminalCommand.shouldOpen ? terminalCommand.command : undefined
          )
        }
      },
    },
    {
      names: [
        "agents",
        "agent.list",
        "agent-list",
        "debug.agent",
        "debug-agent",
        "app.agents",
      ],
      run: (run) => {
        const { cmd, args, activeThread, subagentList } = run
        const terminalCommand = buildBetterC0deAgentTerminalCommand(cmd, args)
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
        if (isSlashCommand(cmd, "debug.agent", "debug-agent") && cleanArgs[0]) {
          const matchedSubagent = resolveRuntimeSubagent(
            subagentList,
            cleanArgs[0]
          )
          run.output = matchedSubagent
            ? buildRuntimeSubagentDebugOutput(
                matchedSubagent,
                cleanArgs,
                terminalCommand.command
              )
            : buildSubagentNotFoundOutput(cleanArgs[0], subagentList)
        } else {
          run.output = buildRuntimeSubagentListOutput(
            subagentList,
            terminalCommand.shouldOpen ? terminalCommand.command : undefined
          )
        }
      },
    },
    {
      names: ["agent"],
      when: ({ cmd, args }) =>
        isBetterC0deAgentSlashSubcommand(cmd, args, "create"),
      run: async (run) => {
        const { args, activeThread } = run
        const agentArgs = stripBetterC0deAgentSlashSubcommand(args)
        const terminalCommand = buildBetterC0deAgentTerminalCommand(
          "/agent-create",
          agentArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        openSettingsTab("skills")
        run.output = await buildAgentCreateOutput(agentArgs, activeThread)
      },
    },
    {
      names: ["agent-create", "agent.create", "agents.create", "create-agent"],
      run: async (run) => {
        const { cmd, args, activeThread } = run
        const terminalCommand = buildBetterC0deAgentTerminalCommand(cmd, args)
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        openSettingsTab("skills")
        run.output = await buildAgentCreateOutput(args, activeThread)
      },
    },
    {
      names: ["instructions", "project-rules"],
      run: async (run) => {
        const { args, activeThread } = run
        if (args.includes("--config-only")) {
          run.output = await buildProjectInstructionsConfigOutput(
            args,
            activeThread
          )
        } else {
          run.output = await buildProjectInstructionsOutput(activeThread)
        }
      },
    },
  ]
