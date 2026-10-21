import { stringifyCliArgs } from "@/lib/cli-parse"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  type WorkspaceProjectFormatResult,
  type WorkspaceProjectFormatter,
  type WorkspaceProjectLspServer,
  formatProjectFile,
} from "@/services/backend/workspaceApi"
import {
  buildProjectFormatPreviewOutput,
  buildProjectFormatTerminalCommand,
  buildProjectFormatterConfigOutput,
  formatCommand,
  parseProjectFormatArgs,
  parseProjectFormatFlags,
} from "./formatter-commands"
import {
  type ProjectLspDebugIntent,
  type ProjectLspDebugKind,
  buildProjectLspConfigOutput,
  buildProjectLspDebugOutput,
  formatList,
} from "./lsp-commands"
import {
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import {
  buildProjectPermissionsConfigOutput,
  buildProjectPermissionsOutput,
} from "./permission-commands"
import {
  buildProjectCommandConfigOutput,
  buildProjectCommandsOutput,
  buildProjectReferenceConfigOutput,
  buildProjectReferencesOutput,
} from "./project-commands"
import {
  type ActiveThreadRef,
  escapeInlineCode,
  escapeMarkdownTableCell,
} from "./provider-config"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"

export async function buildProjectFormatOutput(
  args: string[],
  formatters: ReadonlyArray<WorkspaceProjectFormatter>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Format File\n\n> No workspace folder is open."
  }
  if (args.length === 0) {
    return [
      "# Format File\n",
      "> Usage: `/format <relative-file> [formatter] [--dry-run|--terminal]`",
      "",
      "Run `/formatters` to see configured BetterC0de formatter IDs.",
    ].join("\n")
  }

  const requestedFlags = parseProjectFormatFlags(args)
  const { relativePath, formatterId } = parseProjectFormatArgs(
    requestedFlags.args,
    formatters
  )
  if (!relativePath) {
    return [
      "# Format File\n",
      "> Usage: `/format <relative-file> [formatter] [--dry-run|--terminal]`",
    ].join("\n")
  }
  if (requestedFlags.dryRun || requestedFlags.terminal) {
    return buildProjectFormatPreviewOutput({
      formatters,
      formatterId,
      relativePath,
      runtimePath,
      terminal: requestedFlags.terminal,
    })
  }

  try {
    const result = await formatProjectFile(
      runtimePath,
      relativePath,
      formatterId
    )
    return buildProjectFormatResultOutput(result, runtimePath)
  } catch (error) {
    return [
      "# Format File\n",
      `> Failed to run formatter for \`${escapeInlineCode(relativePath)}\`.`,
      "",
      error instanceof Error ? error.message : String(error),
    ].join("\n")
  }
}

function buildProjectFormatResultOutput(
  result: WorkspaceProjectFormatResult,
  runtimePath: string
): string {
  if (result.results.length === 0) {
    return [
      "# Format File\n",
      `**${escapeMarkdownTableCell(result.file)}** in \`${escapeInlineCode(runtimePath)}\``,
      "",
      `> ${result.skippedReason ?? "No formatter was run."}`,
    ].join("\n")
  }

  return [
    "# Format File\n",
    `**${escapeMarkdownTableCell(result.file)}** in \`${escapeInlineCode(runtimePath)}\``,
    "",
    "| Formatter | Command | Status | Output |",
    "|:----------|:--------|:-------|:-------|",
    ...result.results.map((run) => {
      const status = run.skippedReason
        ? "Skipped"
        : run.success
          ? "Formatted"
          : run.timedOut
            ? "Timed out"
            : `Failed (${run.exitCode ?? "spawn"})`
      const output =
        run.skippedReason ??
        firstNonEmptyLine(run.stderr) ??
        firstNonEmptyLine(run.stdout) ??
        "-"
      return `| **${escapeMarkdownTableCell(run.name)}** | \`${escapeMarkdownTableCell(formatCommand(run.command, run.args, false))}\` | ${escapeMarkdownTableCell(status)} | ${escapeMarkdownTableCell(output)} |`
    }),
  ].join("\n")
}

function buildProjectFormattersOutput(
  formatters: ReadonlyArray<WorkspaceProjectFormatter>,
  activeThread: ActiveThreadRef
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Project Formatters\n\n> No workspace folder is open."
  }
  if (formatters.length === 0) {
    return [
      "# Project Formatters\n",
      "> No BetterC0de formatter config found.",
      "",
      "Add a `formatter` object to `betterc0de.json` or `betterc0de.jsonc` to document project formatters.",
      'Use `/formatters --config-only <id> --command "prettier --write $FILE" --ext .ts,.tsx` to write one from chat.',
    ].join("\n")
  }

  return [
    "# Project Formatters\n",
    `${formatters.length} formatter${formatters.length > 1 ? "s" : ""} configured in \`${runtimePath}\`\n`,
    "| Formatter | Extensions | Command | Source | Status |",
    "|:----------|:-----------|:--------|:-------|:-------|",
    ...formatters.map(
      (formatter) =>
        `| **${escapeMarkdownTableCell(formatter.name)}** | ${escapeMarkdownTableCell(formatList(formatter.extensions))} | \`${escapeMarkdownTableCell(formatCommand(formatter.command, formatter.args, formatter.builtin))}\` | \`${escapeMarkdownTableCell(formatter.sourcePath)}\` | ${escapeMarkdownTableCell(formatProjectFormatterStatus(formatter))} |`
    ),
    "",
    "> Use `/format <relative-file> [formatter]` to run a configured formatter explicitly, or add `--dry-run` / `--terminal` to preview the resolved command without changing files. Add `/formatters --config-only ...` to write a formatter entry.",
  ].join("\n")
}

function formatProjectFormatterStatus(
  formatter: WorkspaceProjectFormatter
): string {
  if (!formatter.enabled) return "Disabled"
  if (formatter.available === false) return "Unavailable"
  if (formatter.available === true) return "Available"
  return "Enabled"
}

export function buildProjectLspServersOutput(
  servers: ReadonlyArray<WorkspaceProjectLspServer>,
  activeThread: ActiveThreadRef,
  command = "/lsp",
  args: ReadonlyArray<string> = []
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const debugIntent = resolveProjectLspDebugIntent(
    command,
    stripBetterC0deRuntimeUiFlags(args)
  )
  if (debugIntent) {
    return buildProjectLspDebugOutput(servers, activeThread, {
      ...debugIntent,
      terminalRequested: args.some(isBetterC0deRuntimeTerminalFlag),
    })
  }
  if (!runtimePath) {
    return "# Project LSP Servers\n\n> No workspace folder is open."
  }
  if (servers.length === 0) {
    return [
      "# Project LSP Servers\n",
      "> No BetterC0de LSP config found.",
      "",
      "Add an `lsp` object to `betterc0de.json` or `betterc0de.jsonc` to document project language servers.",
      'Use `/lsp --config-only <id> --command "typescript-language-server --stdio" --ext .ts,.tsx` to write one from chat.',
    ].join("\n")
  }

  return [
    "# Project LSP Servers\n",
    `${servers.length} server${servers.length > 1 ? "s" : ""} configured in \`${runtimePath}\`\n`,
    "| Server | Extensions | Command | Init | Source | Status |",
    "|:-------|:-----------|:--------|:-----|:-------|:-------|",
    ...servers.map(
      (server) =>
        `| **${escapeMarkdownTableCell(server.name)}** | ${escapeMarkdownTableCell(formatList(server.extensions))} | \`${escapeMarkdownTableCell(formatCommand(server.command, server.args, server.builtin))}\` | ${escapeMarkdownTableCell(formatObjectKeys(server.initialization))} | \`${escapeMarkdownTableCell(server.sourcePath)}\` | ${server.enabled ? "Enabled" : "Disabled"} |`
    ),
    "",
    "> This is BetterC0de compatibility project metadata. Use `/lsp diagnostics <file> [--json]`, `/lsp symbols <query> [--json]`, or `/lsp document-symbols <uri> [--json]` for BetterC0de debug guidance and local JSON previews. Add `/lsp --config-only ...` to write an LSP entry.",
  ].join("\n")
}

function buildProjectLspTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const intent = resolveProjectLspDebugIntent(
    command,
    stripBetterC0deRuntimeUiFlags(args)
  )
  if (!intent) return { command: "", shouldOpen: false }
  const placeholder =
    intent.kind === "diagnostics"
      ? "<file>"
      : intent.kind === "symbols"
        ? "<query>"
        : "<uri>"
  const target = intent.target || placeholder
  return {
    command: `betterc0de debug lsp ${intent.kind} ${stringifyCliArgs([target])}`,
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function resolveProjectLspDebugIntent(
  command: string,
  args: ReadonlyArray<string>
): ProjectLspDebugIntent | null {
  const normalizedCommand = command.replace(/^\//, "")
  const commandKind = lspDebugKindFromToken(normalizedCommand)
  const parsedArgs = parseProjectLspDebugArgs(args)
  if (commandKind) {
    return {
      kind: commandKind,
      target: parsedArgs.args.join(" ").trim() || undefined,
      outputJson: parsedArgs.outputJson,
    }
  }

  const [head, ...rest] = parsedArgs.args
  const argsKind = lspDebugKindFromToken(head ?? "")
  if (!argsKind) return null
  return {
    kind: argsKind,
    target: rest.join(" ").trim() || undefined,
    outputJson: parsedArgs.outputJson,
  }
}

function parseProjectLspDebugArgs(args: ReadonlyArray<string>): {
  args: string[]
  outputJson: boolean
} {
  const cleanArgs: string[] = []
  let outputJson = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ""
    const normalized = arg.trim().toLowerCase()
    if (normalized === "--json" || normalized === "--format=json") {
      outputJson = true
      continue
    }
    if (normalized === "--format" && args[index + 1]) {
      const format = args[index + 1]!.trim().toLowerCase()
      if (format === "json") {
        outputJson = true
        index += 1
        continue
      }
    }
    cleanArgs.push(arg)
  }
  return { args: cleanArgs, outputJson }
}

function lspDebugKindFromToken(value: string): ProjectLspDebugKind | null {
  const normalized = value.toLowerCase().replace(/_/g, "-")
  if (
    normalized === "diagnostics" ||
    normalized === "debug.lsp.diagnostics" ||
    normalized === "debug-lsp-diagnostics"
  ) {
    return "diagnostics"
  }
  if (
    normalized === "symbols" ||
    normalized === "debug.lsp.symbols" ||
    normalized === "debug-lsp-symbols"
  ) {
    return "symbols"
  }
  if (
    normalized === "document-symbols" ||
    normalized === "documentsymbols" ||
    normalized === "debug.lsp.document-symbols" ||
    normalized === "debug-lsp-document-symbols"
  ) {
    return "document-symbols"
  }
  return null
}

function firstNonEmptyLine(value: string): string | null {
  const line = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean)
  return line ?? null
}

function formatObjectKeys(value: Record<string, unknown>): string {
  const keys = Object.keys(value)
  return keys.length > 0 ? keys.map((key) => `\`${key}\``).join(", ") : "-"
}

/** Project commands, references, formatters, LSP servers and permission rules. */
export const PROJECT_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["commands", "project-commands", "command.list", "command-list"],
      run: async (run) => {
        const { args, activeThread, skillList, projectCommandList } = run
        if (args.includes("--config-only")) {
          run.output = await buildProjectCommandConfigOutput(args, activeThread)
        } else {
          run.output = buildProjectCommandsOutput(
            projectCommandList,
            skillList,
            activeThread
          )
        }
      },
    },
    {
      names: ["references", "refs", "project-references"],
      run: async (run) => {
        const { args, activeThread, projectReferenceList } = run
        if (args.includes("--config-only")) {
          run.output = await buildProjectReferenceConfigOutput(
            args,
            activeThread
          )
        } else {
          run.output = buildProjectReferencesOutput(
            projectReferenceList,
            activeThread
          )
        }
      },
    },
    {
      names: ["format", "project-format", "formatter.run"],
      run: async (run) => {
        const { args, activeThread, projectFormatterList } = run
        const terminalCommand = buildProjectFormatTerminalCommand(
          args,
          projectFormatterList
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = await buildProjectFormatOutput(
          args,
          projectFormatterList,
          activeThread
        )
      },
    },
    {
      names: [
        "formatters",
        "project-formatters",
        "formatter.status",
        "formatter-status",
      ],
      run: async (run) => {
        const { args, activeThread, projectFormatterList } = run
        if (args.includes("--config-only")) {
          run.output = await buildProjectFormatterConfigOutput(
            args,
            activeThread
          )
        } else {
          run.output = buildProjectFormattersOutput(
            projectFormatterList,
            activeThread
          )
        }
      },
    },
    {
      names: [
        "lsp",
        "lsps",
        "language-servers",
        "debug.lsp",
        "debug-lsp",
        "lsp.status",
        "lsp-status",
        "debug.lsp.diagnostics",
        "debug-lsp-diagnostics",
        "debug.lsp.symbols",
        "debug-lsp-symbols",
        "debug.lsp.document-symbols",
        "debug-lsp-document-symbols",
      ],
      run: async (run) => {
        const { cmd, args, activeThread, projectLspServerList } = run
        const terminalCommand = buildProjectLspTerminalCommand(cmd, args)
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        if (args.includes("--config-only")) {
          run.output = await buildProjectLspConfigOutput(args, activeThread)
        } else {
          run.output = buildProjectLspServersOutput(
            projectLspServerList,
            activeThread,
            cmd,
            args
          )
        }
      },
    },
    {
      names: ["permissions", "project-permissions"],
      run: async (run) => {
        const {
          args,
          permissionLevel,
          activeThread,
          projectSubagentList,
          projectPermissionList,
        } = run
        if (args.includes("--config-only")) {
          run.output = await buildProjectPermissionsConfigOutput(
            args,
            activeThread
          )
        } else {
          run.output = buildProjectPermissionsOutput(
            projectPermissionList,
            activeThread,
            permissionLevel,
            projectSubagentList
          )
        }
      },
    },
  ]
