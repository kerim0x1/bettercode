import { findBetterC0deKeybindDefault } from "@/lib/betterc0de-keybinds"
import { useChatStore } from "@/lib/chat-store"
import { stringifyCliArgs } from "@/lib/cli-parse"
import { searchTruncationMessage } from "@/lib/search-truncation"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  getWorkspaceMap,
  quickOpenFiles,
  readFile,
  searchContentDetailed,
  type WorkspaceContentSearchResult,
  type WorkspaceMapOverview,
  type WorkspaceQuickOpenFile,
} from "@/services/backend/workspaceApi"
import { gitStatus } from "@/services/backend/gitApi"
import { removeThreadWorktree } from "@/services/backend/coreApi"
import { type GitStatus } from "@betterc0de/schema"
import { isBetterC0deProviderModelId } from "./agent-commands"
import {
  errorMessage,
  markdownFenceForText,
  markdownFenceLanguage,
} from "./input-context"
import { formatDebugPathCell } from "./lsp-commands"
import {
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import {
  betterC0deCliOptionValue,
  isValidHttpUrl,
  maintenanceMissingValueMessages,
} from "./provider-commands"
import {
  escapeInlineCode,
  escapeMarkdownTableCell,
  type ActiveThreadRef,
} from "./provider-config"

export async function buildWorkspaceRemoveOutput(
  threadId: string | null,
  args: readonly string[]
): Promise<string> {
  const store = useChatStore.getState()
  const activeThread = threadId
    ? store.threads.find((candidate) => candidate.id === threadId)
    : null
  if (!threadId || !activeThread) {
    return "# Remove Workspace\n\n> No active chat is available."
  }

  const worktreePath = activeThread.worktreePath?.trim()
  if (!worktreePath) {
    return "# Remove Workspace\n\n> This chat is not using an isolated worktree."
  }

  const deleteBranch = args.some(
    (arg) => arg === "--delete-branch" || arg === "--delete-ref"
  )
  const keepBranch = args.some(
    (arg) => arg === "--keep-branch" || arg === "--keep-ref"
  )
  const shouldDeleteBranch = deleteBranch && !keepBranch

  try {
    await removeThreadWorktree(threadId, {
      deleteBranch: shouldDeleteBranch,
      force: true,
    })
    store.updateThreadContext(threadId, {
      envMode: "local",
      branch: null,
      worktreePath: null,
      baseBranch: null,
      worktreeState: "abandoned",
    })
    return [
      "# Remove Workspace\n",
      "Removed the isolated worktree for this chat.",
      "",
      `Worktree: \`${escapeMarkdownTableCell(worktreePath)}\``,
      activeThread.branch
        ? `Branch: \`${escapeMarkdownTableCell(activeThread.branch)}\``
        : "",
      `Branch deleted: ${shouldDeleteBranch ? "yes" : "no"}`,
      "",
      shouldDeleteBranch
        ? "Use `/workspace-new` to allocate a fresh worktree."
        : "The branch was left in the main repository. Use `/workspace-new` to allocate a fresh worktree.",
    ]
      .filter(Boolean)
      .join("\n")
  } catch (error) {
    return [
      "# Remove Workspace\n",
      "> Could not remove the isolated worktree.",
      "",
      `Error: ${escapeMarkdownTableCell(error instanceof Error ? error.message : String(error))}`,
    ].join("\n")
  }
}

export function buildBetterC0deRuntimeEntrypointOutput(
  command: string,
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode =
    normalized.includes("attach") || normalized === "attach"
      ? "attach"
      : normalized.includes("serve")
        ? "serve"
        : normalized.includes("web")
          ? "web"
          : normalized.includes("acp") || normalized === "acp"
            ? "acp"
            : normalized.includes("tui") ||
                normalized.includes("thread") ||
                normalized.includes("betterc0de.ui") ||
                normalized.includes("betterc0de-ui") ||
                normalized.includes("betterc0de.ui") ||
                normalized.includes("betterc0de-ui")
              ? "tui"
              : "run"
  const shouldOpenTerminal = args.some(isBetterC0deRuntimeTerminalFlag)
  const cliArgs = stringifyCliArgs(
    buildBetterC0deMaintenanceCliArgs(command, args)
  )
  const validation = buildBetterC0deRuntimeValidationMessages(mode, args)
  const cliCommand =
    mode === "tui"
      ? ["betterc0de", cliArgs].filter(Boolean).join(" ")
      : ["betterc0de", mode, cliArgs].filter(Boolean).join(" ")
  const heading =
    mode === "serve"
      ? "BetterC0de Serve"
      : mode === "attach"
        ? "BetterC0de Attach"
        : mode === "web"
          ? "BetterC0de Web"
          : mode === "acp"
            ? "BetterC0de ACP"
            : mode === "tui"
              ? "BetterC0de Terminal"
              : "BetterC0de Run"

  const details =
    mode === "serve"
      ? [
          "Shows the headless server compatibility flow.",
          "Set `BETTERC0DE_SERVER_PASSWORD` before exposing it beyond localhost.",
          "Network flags: `--hostname`, `--port`, `--mdns`, `--mdns-domain`, and repeated `--cors <origin>`.",
        ]
      : mode === "attach"
        ? [
            "Attaches the terminal UI compatibility flow to an already running server URL.",
            "Supports `--dir`, `--continue`, `--session`, `--fork`, `--username`, and `--password`.",
            "`--fork` is only valid together with `--continue` or `--session`.",
            "BetterC0de's equivalent is the integrated terminal plus explicit server URL/session selection.",
          ]
        : mode === "web"
          ? [
              "Shows the web UI compatibility server flow.",
              "Set `BETTERC0DE_SERVER_PASSWORD` before exposing it beyond localhost.",
              "Network flags: `--hostname`, `--port`, `--mdns`, `--mdns-domain`, and repeated `--cors <origin>`.",
            ]
          : mode === "acp"
            ? [
                "Shows an Agent Client Protocol bridge compatibility flow.",
                "This is intended for ACP clients that communicate over stdin/stdout.",
                "Typical flags: `--cwd`, `--hostname`, `--port`, `--mdns`, and `--cors <origin>`.",
              ]
            : mode === "tui"
              ? [
                  "Starts the default compatibility terminal UI for a project folder.",
                  "BetterC0de's normal Agent/Editor UI is the native equivalent; use the CLI only when you intentionally need an external terminal interface.",
                  "Project/session flags: optional `[project]`, `--continue`, `--session`, `--fork`, and `--prompt`.",
                  "Model/runtime flags: `--model`, `--agent`, plus network flags such as `--hostname`, `--port`, `--mdns`, and `--cors <origin>`.",
                  "`--fork` is only valid together with `--continue` or `--session`.",
                ]
              : [
                  "Runs the external compatibility CLI non-interactively with a message, command, model, agent, files, or a remote `--attach` server.",
                  "BetterC0de's normal chat is the native UI equivalent; use the CLI when you need raw JSON events or external automation.",
                  "Session flags: `--continue`, `--session`, `--fork`, `--share`, `--title`, and `--dir`.",
                  "Model/runtime flags: `--model`, `--agent`, `--variant`, `--thinking`, `--format json`, `--command`, and repeated `--file` attachments.",
                  "Remote server flags: `--attach`, `--username`, `--password`, and `--port` for local server startup.",
                  "Interactive flags: `--interactive`, `--replay`, `--replay-limit`, and `--demo`; compatibility CLI replay/demo requires `--interactive` and disallows `--interactive` with `--format json` or `--command`.",
                  "Permission automation: `--dangerously-skip-permissions` auto-approves non-denied permissions and should only be used intentionally.",
                ]
  const globalDetails = [
    "External compatibility flags: `--log-level DEBUG|INFO|WARN|ERROR`, `--print-logs`, and `--pure` are preserved for terminal handoff.",
  ]

  return [
    `# ${heading}`,
    "",
    `Compatibility reference: \`${mode === "tui" ? "betterc0de [project]" : `betterc0de ${mode}`}\`.`,
    "",
    `Workspace: ${runtimePath ? formatDebugPathCell(runtimePath) : "No folder open"}`,
    "",
    "```sh",
    cliCommand,
    "```",
    "",
    "## Behavior",
    "",
    ...details.map((item) => `- ${item}`),
    ...globalDetails.map((item) => `- ${item}`),
    validation.length > 0
      ? [
          "",
          "## Validation",
          "",
          ...validation.map((item) => `- ${item}`),
        ].join("\n")
      : "",
    "",
    shouldOpenTerminal
      ? runtimePath
        ? "> Opened the terminal panel with this command prefilled. Press Enter there to start the CLI process intentionally."
        : "> Open a workspace first, then run this command with `--terminal` to prefill the integrated terminal."
      : "> Add `--terminal` to open the integrated terminal with this compatibility command prefilled. BetterC0de does not auto-start long-running external servers or stdin/stdout protocols from chat.",
  ].join("\n")
}

function buildBetterC0deRuntimeValidationMessages(
  mode: "run" | "tui" | "serve" | "attach" | "web" | "acp",
  args: ReadonlyArray<string>
): string[] {
  const messages: string[] = []
  const interactive = betterC0deCliBooleanFlagValue(args, "--interactive", "-i")
  const terminal = args.some(isBetterC0deRuntimeTerminalFlag)
  const fork = betterC0deCliBooleanFlagValue(args, "--fork")
  const continueSession = betterC0deCliBooleanFlagValue(
    args,
    "--continue",
    "-c"
  )
  const session = hasBetterC0deCliOption(args, "--session", "-s")
  messages.push(...betterC0deCliMissingValueMessages(mode, args))
  messages.push(...betterC0deCliGlobalValidationMessages(args))
  messages.push(...betterC0deCliBooleanValidationMessages(args))
  messages.push(...betterC0deCliNetworkValidationMessages(args))
  messages.push(...betterC0deCliAttachValidationMessages(args))
  if (mode === "attach") {
    messages.push(...betterC0deCliAttachCommandValidationMessages(args))
  }
  if (mode === "run" || mode === "tui") {
    messages.push(...betterC0deCliModelValidationMessages(args))
  }

  if ((mode === "run" || mode === "tui" || mode === "attach") && fork) {
    if (!continueSession && !session) {
      messages.push("`--fork` requires `--continue` or `--session`.")
    }
  }

  if (mode !== "run") return messages

  const command = hasBetterC0deCliOption(args, "--command")
  const demo = betterC0deCliBooleanFlagValue(args, "--demo")
  const replay = betterC0deCliBooleanFlagValue(args, "--replay")
  const dangerouslySkipPermissions = betterC0deCliBooleanFlagValue(
    args,
    "--dangerously-skip-permissions"
  )
  const replayLimit = betterC0deCliOptionValue(args, "--replay-limit")
  const format = betterC0deCliOptionValue(args, "--format")

  if (dangerouslySkipPermissions) {
    messages.push(
      "`--dangerously-skip-permissions` auto-approves permissions that are not explicitly denied. Use it only for intentionally trusted runs."
    )
  }
  if (interactive && !terminal) {
    messages.push(
      "`--interactive` needs a terminal/TTY; add `--terminal` to open the integrated terminal."
    )
  }
  if (interactive && command) {
    messages.push("`--interactive` cannot be used with `--command`.")
  }
  if (demo && !interactive) {
    messages.push("`--demo` requires `--interactive`.")
  }
  if (interactive && format?.toLowerCase() === "json") {
    messages.push("`--interactive` cannot be used with `--format json`.")
  }
  if (format && !["default", "json"].includes(format.toLowerCase())) {
    messages.push("`--format` must be `default` or `json`.")
  }
  if (replay && !interactive) {
    messages.push("`--replay` requires `--interactive`.")
  }
  if (replayLimit !== undefined && !interactive) {
    messages.push("`--replay-limit` requires `--interactive`.")
  }
  if (replayLimit !== undefined) {
    const parsed = Number(replayLimit)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      messages.push("`--replay-limit` must be a positive integer.")
    }
  }
  if (!interactive && !command && !hasBetterC0deRunMessage(args)) {
    messages.push("BetterC0de run requires a message or `--command`.")
  }
  return messages
}

function betterC0deCliMissingValueMessages(
  mode: "run" | "tui" | "serve" | "attach" | "web" | "acp",
  args: ReadonlyArray<string>
): string[] {
  const messages: string[] = []
  const options = betterC0deCliOptionsWithValueForMode(mode)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--") break
    const inlineOption = Array.from(options).find((option) =>
      arg.startsWith(`${option}=`)
    )
    if (inlineOption) {
      if (!arg.slice(`${inlineOption}=`.length).trim()) {
        messages.push(`${inlineOption} requires a value.`)
      }
      continue
    }
    if (!options.has(arg)) continue
    const value = args[index + 1]
    if (!value || value.startsWith("-")) {
      messages.push(`${arg} requires a value.`)
    } else {
      index += 1
    }
  }
  return messages
}

function betterC0deCliNetworkValidationMessages(
  args: ReadonlyArray<string>
): string[] {
  const messages: string[] = []
  const port = betterC0deCliOptionValue(args, "--port")
  if (port !== undefined && port.trim() && !isNonNegativeIntegerString(port)) {
    messages.push("`--port` must be a non-negative integer.")
  }
  return messages
}

function betterC0deCliAttachValidationMessages(
  args: ReadonlyArray<string>
): string[] {
  const attach = betterC0deCliOptionValue(args, "--attach")
  if (!attach || !attach.trim()) return []
  if (isValidHttpUrl(attach)) return []
  return ["`--attach` must be a valid `http://` or `https://` URL."]
}

const BETTERC0DE_CLI_BOOLEAN_OPTIONS = new Set([
  "--continue",
  "-c",
  "--fork",
  "--share",
  "--thinking",
  "--replay",
  "--interactive",
  "-i",
  "--dangerously-skip-permissions",
  "--demo",
  "--mdns",
  "--print-logs",
  "--pure",
])

function betterC0deCliBooleanValidationMessages(
  args: ReadonlyArray<string>
): string[] {
  const messages: string[] = []
  for (const arg of args) {
    const inline = /^(--[^=]+)=(.*)$/.exec(arg)
    if (!inline) continue
    const option = inline[1] ?? ""
    if (!BETTERC0DE_CLI_BOOLEAN_OPTIONS.has(option)) continue
    const value = (inline[2] ?? "").trim().toLowerCase()
    if (value !== "true" && value !== "false") {
      messages.push(`\`${option}\` must be true or false.`)
    }
  }
  return messages
}

function betterC0deCliAttachCommandValidationMessages(
  args: ReadonlyArray<string>
): string[] {
  const url = firstBetterC0deCliPositionalArg("attach", args)
  if (!url) return ["BetterC0de attach requires a server URL."]
  if (isValidHttpUrl(url)) return []
  return ["BetterC0de attach URL must be a valid `http://` or `https://` URL."]
}

function firstBetterC0deCliPositionalArg(
  mode: "run" | "tui" | "serve" | "attach" | "web" | "acp",
  args: ReadonlyArray<string>
): string | undefined {
  const options = betterC0deCliOptionsWithValueForMode(mode)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--") {
      return args.slice(index + 1).find((item) => item.trim().length > 0)
    }
    if (Array.from(options).some((option) => arg.startsWith(`${option}=`))) {
      continue
    }
    if (options.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith("-")) continue
    if (arg.trim().length > 0) return arg
  }
  return undefined
}

function betterC0deCliGlobalValidationMessages(
  args: ReadonlyArray<string>
): string[] {
  const messages: string[] = []
  const logLevel = betterC0deCliOptionValue(args, "--log-level")
  if (
    logLevel &&
    !["DEBUG", "INFO", "WARN", "ERROR"].includes(logLevel.trim())
  ) {
    messages.push("`--log-level` must be `DEBUG`, `INFO`, `WARN`, or `ERROR`.")
  }
  return messages
}

function betterC0deCliModelValidationMessages(
  args: ReadonlyArray<string>
): string[] {
  const model = betterC0deCliOptionValue(args, "--model", "-m")
  if (model && !isBetterC0deProviderModelId(model)) {
    return [
      "`--model` must use the compatibility CLI's `provider/model` format.",
    ]
  }
  return []
}

function isNonNegativeIntegerString(value: string): boolean {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0
}

function betterC0deCliOptionsWithValueForMode(
  mode: "run" | "tui" | "serve" | "attach" | "web" | "acp"
): ReadonlySet<string> {
  const global = new Set(["--log-level"])
  const network = new Set(["--port", "--hostname", "--mdns-domain", "--cors"])
  if (mode === "serve" || mode === "web") {
    return new Set([...global, ...network])
  }
  if (mode === "acp") return new Set([...global, ...network, "--cwd"])
  if (mode === "attach") {
    return new Set([
      ...global,
      "--dir",
      "--session",
      "-s",
      "--password",
      "-p",
      "--username",
      "-u",
    ])
  }
  if (mode === "tui") {
    return new Set([
      ...global,
      ...network,
      "--session",
      "-s",
      "--prompt",
      "--model",
      "-m",
      "--agent",
    ])
  }
  return BETTERC0DE_RUN_OPTIONS_WITH_VALUE
}

function betterC0deCliBooleanFlagValue(
  args: ReadonlyArray<string>,
  ...names: string[]
): boolean {
  for (const arg of args) {
    if (names.includes(arg)) return true
    for (const name of names) {
      const prefix = `${name}=`
      if (!arg.startsWith(prefix)) continue
      const value = arg.slice(prefix.length).trim().toLowerCase()
      if (value === "false" || value === "0") return false
      return true
    }
  }
  return false
}

function hasBetterC0deCliOption(
  args: ReadonlyArray<string>,
  ...names: string[]
): boolean {
  return betterC0deCliOptionValue(args, ...names) !== undefined
}

const BETTERC0DE_RUN_OPTIONS_WITH_VALUE = new Set([
  "--log-level",
  "--command",
  "--session",
  "-s",
  "--model",
  "-m",
  "--agent",
  "--format",
  "--file",
  "-f",
  "--attach",
  "--password",
  "-p",
  "--username",
  "-u",
  "--dir",
  "--port",
  "--variant",
  "--replay-limit",
])

const BETTERC0DE_RUN_OPTIONS_WITH_OPTIONAL_VALUE = new Set(["--title"])

function hasBetterC0deRunMessage(args: ReadonlyArray<string>): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--") {
      return args.slice(index + 1).some((item) => item.trim().length > 0)
    }
    if (BETTERC0DE_RUN_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1
      continue
    }
    if (BETTERC0DE_RUN_OPTIONS_WITH_OPTIONAL_VALUE.has(arg)) {
      const value = args[index + 1]
      if (value && !value.startsWith("-")) index += 1
      continue
    }
    if (
      Array.from(BETTERC0DE_RUN_OPTIONS_WITH_VALUE).some((option) =>
        arg.startsWith(`${option}=`)
      )
    ) {
      continue
    }
    if (
      Array.from(BETTERC0DE_RUN_OPTIONS_WITH_OPTIONAL_VALUE).some((option) =>
        arg.startsWith(`${option}=`)
      )
    ) {
      continue
    }
    if (arg.startsWith("-")) continue
    if (arg.trim().length > 0) return true
  }
  return false
}

export function buildBetterC0deMaintenanceOutput(
  command: string,
  args: ReadonlyArray<string>
): string {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode = normalized.includes("uninstall")
    ? "uninstall"
    : normalized.includes("completion")
      ? "completion"
      : normalized.includes("generate") || normalized.includes("openapi")
        ? "generate"
        : normalized.includes("db")
          ? "db"
          : "upgrade"
  const shouldOpenTerminal = args.some(isBetterC0deRuntimeTerminalFlag)
  const cliArgs = stringifyCliArgs(
    buildBetterC0deMaintenanceCliArgs(command, args)
  )
  const cliCommand = ["betterc0de", mode, cliArgs].filter(Boolean).join(" ")
  const validation = buildBetterC0deMaintenanceValidationMessages(
    command,
    mode,
    args
  )
  const heading =
    mode === "uninstall"
      ? "BetterC0de Uninstall"
      : mode === "completion"
        ? "BetterC0de Completion"
        : mode === "generate"
          ? "BetterC0de Generate"
          : mode === "db"
            ? "BetterC0de DB"
            : "BetterC0de Upgrade"
  const details =
    mode === "uninstall"
      ? [
          "Shows the external compatibility uninstall flow for binaries and related config/data/cache/state.",
          "Useful safety flags: `--dry-run`, `--keep-config`, `--keep-data`, and `--force`.",
          "`--force` skips the external CLI confirmation prompt; BetterC0de still only prefills the terminal command.",
        ]
      : mode === "generate"
        ? [
            "Shows the external compatibility OpenAPI generation flow.",
            "This writes JSON to stdout and is mainly for SDK/API maintenance.",
          ]
        : mode === "completion"
          ? buildBetterC0deCompletionDetails(args)
          : mode === "db"
            ? buildBetterC0deDbDetails(command, args)
            : [
                "Shows the external compatibility upgrade flow for the latest or a requested version.",
                "Supported methods include `curl`, `npm`, `pnpm`, `bun`, `brew`, `choco`, and `scoop`.",
              ]

  return [
    `# ${heading}`,
    "",
    `Compatibility reference: \`betterc0de ${mode}\`.`,
    "",
    "```sh",
    cliCommand,
    "```",
    "",
    "## Behavior",
    "",
    ...details.map((item) => `- ${item}`),
    validation.length > 0
      ? [
          "",
          "## Validation",
          "",
          ...validation.map((item) => `- ${item}`),
        ].join("\n")
      : "",
    "",
    shouldOpenTerminal
      ? "> Opened the terminal panel with this command prefilled. Press Enter there to start the CLI process intentionally."
      : "> Add `--terminal` to open the integrated terminal with this compatibility command prefilled. BetterC0de does not auto-run package-manager changes, uninstall operations, OpenAPI generation, database queries, or migrations from chat.",
  ].join("\n")
}

export function buildBetterC0deMaintenanceValidationMessages(
  command: string,
  mode: "upgrade" | "uninstall" | "generate" | "completion" | "db",
  args: ReadonlyArray<string>
): string[] {
  if (mode === "upgrade") {
    const messages = maintenanceMissingValueMessages(args, ["--method", "-m"])
    const method = betterC0deCliOptionValue(args, "--method", "-m")
    if (
      method &&
      !["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"].includes(
        method.toLowerCase()
      )
    ) {
      messages.push(
        "`--method` must be one of `curl`, `npm`, `pnpm`, `bun`, `brew`, `choco`, or `scoop`."
      )
    }
    return messages
  }

  if (mode === "uninstall") {
    return maintenanceBooleanValidationMessages(
      args,
      new Set([
        "--keep-config",
        "--keep-data",
        "--dry-run",
        "--force",
        "-c",
        "-d",
        "-f",
      ])
    )
  }

  if (mode === "db") {
    const dbMode = betterC0deDbMode(command, args)
    if (dbMode === "path" || dbMode === "migrate") {
      const messages: string[] = []
      if (betterC0deCliOptionValue(args, "--format") !== undefined) {
        messages.push("`--format` is only valid for BetterC0de DB queries.")
      }
      return messages
    }

    const messages = maintenanceMissingValueMessages(args, ["--format"])
    const format = betterC0deCliOptionValue(args, "--format")
    if (format && !["json", "tsv"].includes(format.toLowerCase())) {
      messages.push("`--format` must be `json` or `tsv`.")
    }
    return messages
  }

  if (mode === "completion") {
    const shell = betterC0deCompletionShell(args)
    const messages: string[] = []
    if (shell === "unsupported") {
      messages.push(
        "Completion shell must be one of `bash`, `zsh`, `fish`, `powershell`, or `pwsh`."
      )
    }
    return messages
  }

  return []
}

function maintenanceBooleanValidationMessages(
  args: ReadonlyArray<string>,
  options: ReadonlySet<string>
): string[] {
  const messages: string[] = []
  for (const arg of args) {
    const inline = /^(-{1,2}[^=]+)=(.*)$/.exec(arg)
    if (!inline) continue
    const option = inline[1] ?? ""
    if (!options.has(option)) continue
    const value = (inline[2] ?? "").trim().toLowerCase()
    if (value !== "true" && value !== "false") {
      messages.push(`\`${option}\` must be true or false.`)
    }
  }
  return messages
}

export function buildBetterC0deMaintenanceCliArgs(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  if (normalized.includes("completion")) {
    return stripBetterC0deCompletionShellHints(cleanArgs)
  }
  if (!normalized.includes("db")) return cleanArgs

  const firstCommandArg = cleanArgs.find((arg) => !arg.startsWith("-"))
  if (
    (normalized.includes("db-path") || normalized.includes("db.path")) &&
    firstCommandArg !== "path"
  ) {
    return ["path", ...cleanArgs]
  }
  if (
    (normalized.includes("db-migrate") || normalized.includes("db.migrate")) &&
    firstCommandArg !== "migrate"
  ) {
    return ["migrate", ...cleanArgs]
  }
  return cleanArgs
}

type BetterC0deCompletionShell =
  | "bash"
  | "zsh"
  | "fish"
  | "powershell"
  | "unsupported"
  | null

function betterC0deCompletionShell(
  args: ReadonlyArray<string>
): BetterC0deCompletionShell {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  const raw =
    betterC0deCliOptionValue(cleanArgs, "--shell", "-s") ??
    cleanArgs.find((arg) => arg && !arg.startsWith("-"))
  if (!raw) return null
  const shell = raw.trim().toLowerCase()
  if (shell === "bash") return "bash"
  if (shell === "zsh") return "zsh"
  if (shell === "fish") return "fish"
  if (shell === "powershell" || shell === "pwsh") return "powershell"
  return "unsupported"
}

function stripBetterC0deCompletionShellHints(
  args: ReadonlyArray<string>
): string[] {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (arg === "--shell" || arg === "-s") {
      index += 1
      continue
    }
    if (arg.startsWith("--shell=")) continue
    if (
      !arg.startsWith("-") &&
      betterC0deCompletionShell([arg]) !== "unsupported"
    ) {
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

function buildBetterC0deCompletionDetails(
  args: ReadonlyArray<string>
): string[] {
  const shell = betterC0deCompletionShell(args)
  const label = shell && shell !== "unsupported" ? shell : "your shell"
  const details = [
    "Generates shell completion output through the compatibility CLI's yargs completion command.",
    `Selected shell: \`${label}\`. The shell name is BetterC0de install guidance and is not passed to \`betterc0de completion\` unless you run your own custom command.`,
  ]
  const snippet = betterC0deCompletionInstallSnippet(shell)
  if (snippet) {
    details.push("Install snippet:")
    details.push(snippet)
  } else {
    details.push(
      "Choose a shell with `/betterc0de-completion zsh`, `/betterc0de-completion bash`, `/betterc0de-completion fish`, or `/betterc0de-completion pwsh` for install snippets."
    )
  }
  return details
}

function betterC0deCompletionInstallSnippet(
  shell: BetterC0deCompletionShell
): string | null {
  switch (shell) {
    case "zsh":
      return [
        "```sh",
        "mkdir -p ~/.zsh/completions",
        "betterc0de completion > ~/.zsh/completions/_betterc0de",
        "printf '%s\\n' 'fpath=(~/.zsh/completions $fpath)' 'autoload -Uz compinit && compinit' >> ~/.zshrc",
        "```",
      ].join("\n")
    case "bash":
      return [
        "```sh",
        "mkdir -p ~/.local/share/bash-completion/completions",
        "betterc0de completion > ~/.local/share/bash-completion/completions/betterc0de",
        "```",
      ].join("\n")
    case "fish":
      return [
        "```fish",
        "mkdir -p ~/.config/fish/completions",
        "betterc0de completion > ~/.config/fish/completions/betterc0de.fish",
        "```",
      ].join("\n")
    case "powershell":
      return [
        "```powershell",
        "betterc0de completion | Out-String | Invoke-Expression",
        "```",
      ].join("\n")
    default:
      return null
  }
}

type BetterC0deDbMode = "path" | "migrate" | "query" | "shell"

export function betterC0deDbMode(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deDbMode {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  const firstCommandArg =
    firstBetterC0deDbPositionalArg(cleanArgs)?.toLowerCase()

  if (
    normalized.includes("db-path") ||
    normalized.includes("db.path") ||
    firstCommandArg === "path"
  ) {
    return "path"
  }
  if (
    normalized.includes("db-migrate") ||
    normalized.includes("db.migrate") ||
    firstCommandArg === "migrate"
  ) {
    return "migrate"
  }
  if (
    normalized.includes("db-query") ||
    normalized.includes("db.query") ||
    firstCommandArg
  ) {
    return "query"
  }
  return "shell"
}

function firstBetterC0deDbPositionalArg(
  args: ReadonlyArray<string>
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (arg === "--") {
      return args.slice(index + 1).find((item) => item.trim().length > 0)
    }
    if (arg === "--format") {
      index += 1
      continue
    }
    if (arg.startsWith("--format=")) continue
    if (arg.startsWith("-")) continue
    if (arg.trim()) return arg
  }
  return undefined
}

function buildBetterC0deDbDetails(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  const dbMode = betterC0deDbMode(command, args)
  if (dbMode === "path") {
    return [
      "Prints the compatibility SQLite database path.",
      "BetterC0de exposes its own local paths through `/debug-paths`; the raw external CLI path command stays available through terminal handoff.",
    ]
  }
  if (dbMode === "migrate") {
    return [
      "Shows the external JSON-to-SQLite migration flow and merge behavior.",
      "BetterC0de does not start data migrations from chat; use `--terminal` when you explicitly want the external CLI process.",
    ]
  }
  if (dbMode === "query") {
    return [
      "Shows a read-only compatibility SQLite query with `--format tsv|json`.",
      "BetterC0de does not execute arbitrary SQL from chat; use `--terminal` for the raw external query handoff.",
    ]
  }
  return [
    "Opens the external interactive `sqlite3` shell against its database.",
    "BetterC0de does not auto-start interactive database shells from chat; use `--terminal` when you intentionally want the raw external shell.",
  ]
}

type DebugRgMode = "files" | "list" | "read" | "search" | "status" | "tree"

interface DebugRgRequest {
  mode: DebugRgMode
  args: string[]
  limit: number
  query?: string
  globs: string[]
}

export async function buildDebugRgOutput(
  command: string,
  args: readonly string[],
  activeThread: ActiveThreadRef
): Promise<string> {
  const cwd = resolveThreadRuntimePath(activeThread)
  if (!cwd) {
    return [
      "# Debug Workspace",
      "",
      "> Open a workspace folder before running BetterC0de-compatible file diagnostics.",
    ].join("\n")
  }

  const request = resolveDebugRgRequest(command, args)
  if (request.mode === "status") {
    try {
      const status = await gitStatus(cwd)
      return buildDebugFileStatusOutput(cwd, status)
    } catch (err) {
      return [
        "# Debug File Status",
        "",
        "Compatibility reference: `betterc0de debug file status`.",
        "Compatibility HTTP reference: `file.status`.",
        "",
        `Workspace: ${formatDebugPathCell(cwd)}`,
        "",
        `> Failed to read git file status: ${escapeMarkdownTableCell(errorMessage(err))}`,
      ].join("\n")
    }
  }

  if (request.mode === "read") {
    const requestedPath = request.args.join(" ").trim()
    if (!requestedPath) {
      return [
        "# Debug File Read",
        "",
        "Compatibility reference: `betterc0de debug file read <path>`.",
        "Compatibility HTTP reference: `file.read`.",
        "",
        "> Provide a relative file path, for example `/debug-rg read package.json`.",
      ].join("\n")
    }
    try {
      const result = await readFile(`${cwd}/${requestedPath}`)
      return buildDebugFileReadOutput(cwd, requestedPath, result.content)
    } catch (err) {
      return [
        "# Debug File Read",
        "",
        "Compatibility reference: `betterc0de debug file read <path>`.",
        "Compatibility HTTP reference: `file.read`.",
        "",
        `Workspace: ${formatDebugPathCell(cwd)}`,
        `File: \`${escapeInlineCode(requestedPath)}\``,
        "",
        `> Failed to read file: ${escapeMarkdownTableCell(errorMessage(err))}`,
      ].join("\n")
    }
  }

  if (request.mode === "tree") {
    const map = await getWorkspaceMap(cwd, request.limit)
    return buildDebugRgTreeOutput(cwd, map)
  }

  if (request.mode === "list") {
    const requestedPath = request.args.join(" ").trim()
    if (!requestedPath) {
      return [
        "# Debug File List",
        "",
        "Compatibility reference: `betterc0de debug file list <path>`.",
        "Compatibility HTTP reference: `file.list`.",
        "",
        "> Provide a relative directory path, for example `/debug.file.list src`.",
      ].join("\n")
    }
    const map = await getWorkspaceMap(cwd, request.limit)
    return buildDebugFileListOutput(cwd, requestedPath, map)
  }

  const query = (request.query ?? request.args.join(" ")).trim()
  const include = request.globs.join(",")
  if (request.mode === "files") {
    const files = await quickOpenFiles(cwd, query, {
      limit: Math.min(request.limit, 200),
      include,
    })
    return buildDebugRgFilesOutput(cwd, query, files, request.globs)
  }

  if (!query) {
    return [
      "# Debug Search",
      "",
      "Compatibility reference: `betterc0de debug rg search <pattern>`.",
      "",
      "> Provide a search pattern, for example `/debug-rg search useChatSubmit`.",
    ].join("\n")
  }
  const search = await searchContentDetailed(cwd, query, {
    limit: request.limit,
    include,
  })
  return buildDebugRgSearchOutput(
    cwd,
    query,
    search.results,
    request.globs,
    search
  )
}

export function resolveDebugRgRequest(
  command: string,
  args: readonly string[]
): DebugRgRequest {
  const parsed = extractDebugRgOptions(args)
  const normalized = command.toLowerCase().replace(/^\//, "")
  if (
    normalized === "debug.file.read" ||
    normalized === "debug-file-read" ||
    normalized === "file.read" ||
    normalized === "file-read"
  ) {
    return { ...parsed, mode: "read" }
  }
  if (
    normalized === "debug.file.list" ||
    normalized === "debug-file-list" ||
    normalized === "file.list" ||
    normalized === "file-list"
  ) {
    return { ...parsed, mode: "list" }
  }
  if (
    normalized === "debug.file.status" ||
    normalized === "debug-file-status" ||
    normalized === "file.status" ||
    normalized === "file-status"
  ) {
    return { ...parsed, mode: "status" }
  }
  if (normalized === "debug.rg.files") {
    return { ...parsed, mode: "files" }
  }
  if (normalized === "debug.rg.search" || normalized === "debug.file.search") {
    return { ...parsed, mode: "search" }
  }
  if (normalized === "debug.file.tree") {
    return { ...parsed, mode: "tree" }
  }
  const first = parsed.args[0]?.toLowerCase()
  if (first && ["files", "file"].includes(first)) {
    return { ...parsed, mode: "files", args: parsed.args.slice(1) }
  }
  if (first && first === "list") {
    return { ...parsed, mode: "list", args: parsed.args.slice(1) }
  }
  if (first && ["read", "cat"].includes(first)) {
    return { ...parsed, mode: "read", args: parsed.args.slice(1) }
  }
  if (first && ["search", "grep", "rg"].includes(first)) {
    return { ...parsed, mode: "search", args: parsed.args.slice(1) }
  }
  if (first && first === "status") {
    return { ...parsed, mode: "status", args: parsed.args.slice(1) }
  }
  if (first && ["tree", "map"].includes(first)) {
    return { ...parsed, mode: "tree", args: parsed.args.slice(1) }
  }
  return {
    ...parsed,
    mode: parsed.args.length > 0 ? "search" : "tree",
  }
}

export function extractDebugRgOptions(args: readonly string[]): {
  args: string[]
  limit: number
  query?: string
  globs: string[]
} {
  const rest: string[] = []
  const globs: string[] = []
  let limit = 80
  let query: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--limit" && args[index + 1]) {
      const parsed = Number(args[index + 1])
      if (Number.isFinite(parsed)) limit = parsed
      index += 1
      continue
    }
    if (arg.startsWith("--limit=")) {
      const parsed = Number(arg.slice("--limit=".length))
      if (Number.isFinite(parsed)) limit = parsed
      continue
    }
    if ((arg === "--glob" || arg === "-g") && args[index + 1]) {
      globs.push(args[index + 1] ?? "")
      index += 1
      continue
    }
    if (arg.startsWith("--glob=")) {
      globs.push(arg.slice("--glob=".length))
      continue
    }
    if (arg.startsWith("-g=")) {
      globs.push(arg.slice("-g=".length))
      continue
    }
    if ((arg === "--query" || arg === "-q") && args[index + 1]) {
      query = args[index + 1]?.trim()
      index += 1
      continue
    }
    if (arg.startsWith("--query=")) {
      query = arg.slice("--query=".length).trim()
      continue
    }
    if (arg.startsWith("-q=")) {
      query = arg.slice("-q=".length).trim()
      continue
    }
    rest.push(arg)
  }
  return {
    args: rest,
    limit: Math.max(1, Math.min(500, Math.round(limit))),
    ...(query ? { query } : {}),
    globs: globs.map((glob) => glob.trim()).filter(Boolean),
  }
}

export function buildDebugFileReadOutput(
  cwd: string,
  requestedPath: string,
  content: string
): string {
  const maxChars = 12_000
  const truncated = content.length > maxChars
  const visibleContent = truncated ? content.slice(0, maxChars) : content
  const language = markdownFenceLanguage(
    requestedPath.split(".").pop() || "text"
  )
  const fence = markdownFenceForText(visibleContent)

  return [
    "# Debug File Read",
    "",
    "Compatibility reference: `betterc0de debug file read <path>`.",
    "Compatibility HTTP reference: `file.read`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    `File: \`${escapeInlineCode(requestedPath)}\``,
    `Bytes shown: ${new TextEncoder().encode(visibleContent).length.toLocaleString()}${truncated ? " (truncated)" : ""}`,
    "",
    `${fence}${language}`,
    visibleContent,
    fence,
  ].join("\n")
}

export function buildDebugFileStatusOutput(
  cwd: string,
  // Accepts the typed wire shape and stays defensive for the untyped
  // records the tests feed in (malformed-response coverage).
  status: GitStatus | Record<string, unknown>
): string {
  const branch = typeof status.branch === "string" ? status.branch : ""
  const staged = readDebugStatusFileList(status.staged)
  const modified = readDebugStatusFileList(status.modified)
  const untracked = readDebugStatusFileList(status.untracked)
  const changed = [
    ...staged.map((file) => ({ state: "staged", file })),
    ...modified.map((file) => ({ state: "modified", file })),
    ...untracked.map((file) => ({ state: "added", file })),
  ]

  return [
    "# Debug File Status",
    "",
    "Compatibility reference: `betterc0de debug file status`.",
    "Compatibility HTTP reference: `file.status`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    "",
    "| Field | Value |",
    "|:------|:------|",
    `| Branch | ${escapeMarkdownTableCell(branch || "-")} |`,
    `| Clean | ${status.is_clean === true ? "yes" : "no"} |`,
    `| Staged | ${staged.length.toLocaleString()} |`,
    `| Modified | ${modified.length.toLocaleString()} |`,
    `| Untracked | ${untracked.length.toLocaleString()} |`,
    typeof status.ahead === "number"
      ? `| Ahead | ${status.ahead.toLocaleString()} |`
      : "",
    typeof status.behind === "number"
      ? `| Behind | ${status.behind.toLocaleString()} |`
      : "",
    typeof status.upstream === "string" && status.upstream
      ? `| Upstream | ${escapeMarkdownTableCell(status.upstream)} |`
      : "",
    "",
    changed.length > 0
      ? [
          "| # | Status | File |",
          "|:--|:-------|:-----|",
          ...changed.map(
            (entry, index) =>
              `| ${index + 1} | ${entry.state} | \`${escapeMarkdownTableCell(escapeInlineCode(entry.file))}\` |`
          ),
        ].join("\n")
      : "> No changed files.",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildDebugFileListOutput(
  cwd: string,
  requestedPath: string,
  map: WorkspaceMapOverview
): string {
  const directory = normalizeDebugDirectoryPath(requestedPath)
  const directFiles = map.files
    .filter((file) => normalizeDebugDirectoryPath(file.directory) === directory)
    .slice(0, 80)
  const childDirs = directChildDirectoriesForDebugList(map, directory).slice(
    0,
    80
  )

  return [
    "# Debug File List",
    "",
    "Compatibility reference: `betterc0de debug file list <path>`.",
    "Compatibility HTTP reference: `file.list`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    `Directory: \`${escapeInlineCode(directory || ".")}\``,
    "",
    childDirs.length > 0 || directFiles.length > 0
      ? [
          "| # | Type | Name | Size |",
          "|:--|:-----|:-----|-----:|",
          ...childDirs.map(
            (dir, index) =>
              `| ${index + 1} | directory | \`${escapeMarkdownTableCell(escapeInlineCode(dir))}/\` | - |`
          ),
          ...directFiles.map(
            (file, index) =>
              `| ${childDirs.length + index + 1} | file | \`${escapeMarkdownTableCell(escapeInlineCode(file.name))}\` | ${formatBytes(file.sizeBytes)} |`
          ),
        ].join("\n")
      : "> No files found for this directory in the workspace map.",
    map.truncated
      ? "\n> Workspace map was truncated; increase `--limit` if needed."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export function readDebugStatusFileList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function normalizeDebugDirectoryPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
  if (!normalized || normalized === ".") return ""
  return normalized.replace(/\/+$/g, "")
}

function directChildDirectoriesForDebugList(
  map: WorkspaceMapOverview,
  directory: string
): string[] {
  const prefix = directory ? `${directory}/` : ""
  const children = new Set<string>()
  for (const file of map.files) {
    if (!file.path.startsWith(prefix)) continue
    const rest = file.path.slice(prefix.length)
    const slash = rest.indexOf("/")
    if (slash > 0) children.add(rest.slice(0, slash))
  }
  return [...children].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" })
  )
}

export function buildDebugRgFilesOutput(
  cwd: string,
  query: string,
  files: ReadonlyArray<WorkspaceQuickOpenFile>,
  globs: ReadonlyArray<string> = []
): string {
  return [
    "# Debug Files",
    "",
    "Compatibility reference: `betterc0de debug rg files` / `betterc0de debug file search`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    query ? `Query: \`${escapeInlineCode(query)}\`` : "Query: all files",
    globs.length > 0
      ? `Glob: ${globs.map((glob) => `\`${escapeInlineCode(glob)}\``).join(", ")}`
      : "",
    "",
    files.length > 0
      ? [
          "| # | File |",
          "|:--|:-----|",
          ...files.map(
            (file, index) =>
              `| ${index + 1} | \`${escapeMarkdownTableCell(escapeInlineCode(file.path))}\` |`
          ),
        ].join("\n")
      : "> No files matched.",
  ].join("\n")
}

/** The part of a detailed search response the markdown builders care about. */
export interface SearchOutputTruncation {
  truncated: boolean
  truncatedReason?: string
}

/**
 * Appends a trailing blockquote when the backend cut the search short. The
 * blank line keeps the note out of the preceding markdown table.
 */
export function withSearchTruncationNote(
  body: string,
  truncation: SearchOutputTruncation | undefined,
  hint: string
): string {
  if (!truncation?.truncated) return body
  return `${body}\n\n> ${searchTruncationMessage({ reason: truncation.truncatedReason, hint })}`
}

export function buildDebugRgSearchOutput(
  cwd: string,
  query: string,
  results: ReadonlyArray<WorkspaceContentSearchResult>,
  globs: ReadonlyArray<string> = [],
  truncation?: SearchOutputTruncation
): string {
  const rows = results
    .flatMap((result) =>
      result.matches.slice(0, 3).map((match) => ({
        path: result.path,
        line: match.line,
        column: match.column,
        preview: match.preview.trim(),
      }))
    )
    .slice(0, 80)

  const body = [
    "# Debug Search",
    "",
    "Compatibility reference: `betterc0de debug rg search <pattern>`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    `Pattern: \`${escapeInlineCode(query)}\``,
    globs.length > 0
      ? `Glob: ${globs.map((glob) => `\`${escapeInlineCode(glob)}\``).join(", ")}`
      : "",
    "",
    rows.length > 0
      ? [
          "| # | Location | Preview |",
          "|:--|:---------|:--------|",
          ...rows.map(
            (row, index) =>
              `| ${index + 1} | \`${escapeMarkdownTableCell(escapeInlineCode(`${row.path}:${row.line}:${row.column}`))}\` | ${escapeMarkdownTableCell(row.preview)} |`
          ),
        ].join("\n")
      : "> No content matches found.",
  ].join("\n")
  return withSearchTruncationNote(
    body,
    truncation,
    "narrow the pattern or add a glob to see the rest"
  )
}

export function buildDebugRgTreeOutput(
  cwd: string,
  map: WorkspaceMapOverview
): string {
  const topDirectories = map.topDirectories
    .slice(0, 12)
    .map(
      (directory) =>
        `| \`${escapeMarkdownTableCell(escapeInlineCode(directory.path || "."))}\` | ${directory.fileCount.toLocaleString()} | ${directory.codeFileCount.toLocaleString()} | ${formatBytes(directory.totalBytes)} |`
    )
  const importantFiles = map.importantFiles
    .slice(0, 12)
    .map(
      (file) =>
        `| \`${escapeMarkdownTableCell(escapeInlineCode(file.path))}\` | ${escapeMarkdownTableCell(file.kind)} | ${formatBytes(file.sizeBytes)} |`
    )

  return [
    "# Debug File Tree",
    "",
    "Compatibility reference: `betterc0de debug rg tree` / `betterc0de debug file tree`.",
    "",
    `Workspace: ${formatDebugPathCell(cwd)}`,
    "",
    "| Overview | Value |",
    "|:---------|------:|",
    `| Total files | ${map.totalFiles.toLocaleString()} |`,
    `| Scanned files | ${map.scannedFiles.toLocaleString()} |`,
    `| Code files | ${map.codeFiles.toLocaleString()} |`,
    `| Total bytes | ${formatBytes(map.totalBytes)} |`,
    `| Truncated | ${map.truncated ? "Yes" : "No"} |`,
    "",
    "## Top Directories",
    topDirectories.length > 0
      ? [
          "| Directory | Files | Code files | Size |",
          "|:----------|------:|-----------:|-----:|",
          ...topDirectories,
        ].join("\n")
      : "> No directories found.",
    "",
    "## Important Files",
    importantFiles.length > 0
      ? [
          "| File | Kind | Size |",
          "|:-----|:-----|-----:|",
          ...importantFiles,
        ].join("\n")
      : "> No important files found yet.",
  ].join("\n")
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

type AppLogLevel = "debug" | "info" | "warn" | "error"

export type AppLogPayload = {
  service: string
  level: AppLogLevel
  message: string
  extra?: Record<string, unknown>
}

export type ParsedAppLogCommand =
  | {
      payload: AppLogPayload
      error?: never
    }
  | {
      payload?: never
      error: string
    }

const APP_LOG_LEVELS = new Set<AppLogLevel>(["debug", "info", "warn", "error"])

export function parseAppLogCommandArgs(
  args: ReadonlyArray<string>
): ParsedAppLogCommand {
  const cleanArgs = [...args]
  let level: AppLogLevel = "info"
  let service = "betterc0de-chat"
  let extra: Record<string, unknown> | undefined
  const messageParts: string[] = []

  for (let index = 0; index < cleanArgs.length; index += 1) {
    const arg = cleanArgs[index] ?? ""
    const readValue = () => cleanArgs[++index] ?? ""
    if (arg === "--service") {
      service = readValue().trim() || service
      continue
    }
    if (arg.startsWith("--service=")) {
      service = arg.slice("--service=".length).trim() || service
      continue
    }
    if (arg === "--level") {
      const next = readValue().trim().toLowerCase()
      if (!isAppLogLevel(next)) {
        return { error: `Unsupported log level: ${next || "(empty)"}` }
      }
      level = next
      continue
    }
    if (arg.startsWith("--level=")) {
      const next = arg.slice("--level=".length).trim().toLowerCase()
      if (!isAppLogLevel(next)) {
        return { error: `Unsupported log level: ${next || "(empty)"}` }
      }
      level = next
      continue
    }
    if (arg === "--extra") {
      const parsed = parseAppLogExtra(readValue())
      if ("error" in parsed) return parsed
      extra = parsed.extra
      continue
    }
    if (arg.startsWith("--extra=")) {
      const parsed = parseAppLogExtra(arg.slice("--extra=".length))
      if ("error" in parsed) return parsed
      extra = parsed.extra
      continue
    }
    if (messageParts.length === 0 && isAppLogLevel(arg.toLowerCase())) {
      level = arg.toLowerCase() as AppLogLevel
      continue
    }
    messageParts.push(arg)
  }

  const message = messageParts.join(" ").trim()
  if (!message) {
    return {
      error:
        'Usage: `/app.log [debug|info|warn|error] <message> [--service name] [--extra \'{"key":"value"}\']`',
    }
  }

  return {
    payload: {
      service,
      level,
      message,
      ...(extra ? { extra } : {}),
    },
  }
}

function parseAppLogExtra(
  value: string
): { extra: Record<string, unknown> } | { error: string } {
  const trimmed = value.trim()
  if (!trimmed) return { error: "`--extra` requires a JSON object." }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "`--extra` must be a JSON object." }
    }
    return { extra: parsed as Record<string, unknown> }
  } catch (error) {
    return { error: `Invalid --extra JSON: ${errorMessage(error)}` }
  }
}

function isAppLogLevel(value: string): value is AppLogLevel {
  return APP_LOG_LEVELS.has(value as AppLogLevel)
}

export function betterC0deInternalRouteGuidance(
  route: string,
  args: ReadonlyArray<string> = []
): {
  equivalent: string
  reason?: string
} {
  if (route.startsWith("auth.") || route.startsWith("provider.oauth.")) {
    return {
      equivalent: "`/connect`, `/auth`, or Settings > Providers",
      reason:
        "Credential and OAuth callback flows must stay in provider UI or terminal flows.",
    }
  }
  if (route.startsWith("experimental.console.")) {
    return {
      equivalent:
        "`/account.orgs`, `/account.switch`, `/console`, or Settings > Providers",
      reason: "Console account/org metadata is shown without printing tokens.",
    }
  }
  if (route.startsWith("experimental.workspace.")) {
    return {
      equivalent:
        "`/workspace-toggle`, `/workspace-list`, `/workspace-new`, `/workspace-remove`, or `/warp`",
      reason:
        "Workspace actions use BetterC0de's explicit workspace/worktree UI.",
    }
  }
  if (route.startsWith("sync.")) {
    return {
      equivalent: "`/export`, `/import`, `/events`, or `/sessions`",
      reason:
        "Compatibility websocket sync/replay/steal routes are runtime-internal and not exposed as direct mutations.",
    }
  }
  if (
    route === "tui.prompt.append" ||
    route === "tui.appendPrompt" ||
    route === "tui.publish"
  ) {
    return {
      equivalent: "`/prompt-paste <text>` or type directly in the composer",
      reason:
        "The compatibility route appends text to the active prompt through a terminal UI bus; BetterC0de keeps composer mutations in the native input UI.",
    }
  }
  if (route === "tui.command.execute" || route === "tui.executeCommand") {
    return {
      equivalent: betterC0deTuiCommandEquivalent(args),
      reason:
        "Compatibility command IDs are forwarded through a worker event bus; BetterC0de exposes the safe equivalents as normal slash commands or native UI actions.",
    }
  }
  if (route === "tui.toast.show" || route === "tui.showToast") {
    return {
      equivalent: "the local notification/toast UI",
      reason:
        "Toast payloads are renderer-local UI events and are not executed as provider prompts.",
    }
  }
  if (route === "tui.session.select" || route === "tui.selectSession") {
    return {
      equivalent: "`/resume <session-id>` or `/sessions`",
      reason:
        "Session selection is handled by BetterC0de's chat sidebar and session commands.",
    }
  }
  if (route.startsWith("tui.")) {
    return {
      equivalent:
        "`/help`, `/model`, `/sessions`, `/themes`, `/prompt.clear`, `/prompt.submit`, or the native BetterC0de UI",
      reason: "Terminal UI compatibility events map to BetterC0de UI actions.",
    }
  }
  if (route === "global.dispose" || route === "instance.dispose") {
    return {
      equivalent: "`/exit`",
      reason:
        "App lifecycle is owned by Electron, not the compatibility server.",
    }
  }
  if (route === "global.event") {
    return { equivalent: "`/events`" }
  }
  if (route === "global.upgrade") {
    return { equivalent: "`/betterc0de-upgrade --terminal`" }
  }
  if (route === "project.initGit") {
    return {
      equivalent: "`/terminal-new` then `git init`",
      reason:
        "Git initialization is a filesystem mutation and remains explicit.",
    }
  }
  if (
    route === "part.delete" ||
    route === "part.update" ||
    route === "session.deleteMessage"
  ) {
    return {
      equivalent: "`/messages` plus the chat message UI",
      reason: "Raw message-part mutation is not executed from chat commands.",
    }
  }
  if (route === "session.command") {
    return { equivalent: "`/commands`" }
  }
  if (route === "session.shell") {
    return { equivalent: "`/terminal-new`" }
  }
  if (route === "session.summarize") {
    return { equivalent: "`/compact`" }
  }
  if (
    route === "session.prompt" ||
    route === "session.prompt_async" ||
    route === "v2.session.prompt"
  ) {
    return {
      equivalent: "send a normal chat message through the composer",
      reason:
        "Provider turns are dispatched through BetterC0de's chat runtime.",
    }
  }
  if (route === "v2.session.wait") {
    return { equivalent: "`/session-status` or the live chat stream" }
  }
  if (route === "experimental.resource.list") {
    return { equivalent: "`/mcp-resources`" }
  }
  if (route === "experimental.session.list") {
    return { equivalent: "`/sessions`, `/events`, or `/debug-info`" }
  }
  return { equivalent: "`/betterc0de-audit`" }
}

export function betterC0deTuiCommandEquivalent(
  args: ReadonlyArray<string>
): string {
  const command = resolveBetterC0deTuiCommandId(args)
  const keybind = findBetterC0deKeybindDefault(command)
  if (keybind?.slash) return `\`${keybind.slash}\``

  switch (command) {
    case "session.list":
      return "`/sessions`"
    case "session.new":
      return "`/new`"
    case "session.share":
      return "`/share`"
    case "session.interrupt":
      return "`/stop` or the stop button in the composer"
    case "session.compact":
      return "`/compact`"
    case "session.page.up":
      return "`/page-up`"
    case "session.page.down":
      return "`/page-down`"
    case "session.line.up":
      return "`/line-up`"
    case "session.line.down":
      return "`/line-down`"
    case "session.half.page.up":
      return "`/half-page-up`"
    case "session.half.page.down":
      return "`/half-page-down`"
    case "session.first":
      return "`/first`"
    case "session.last":
      return "`/last`"
    case "prompt.clear":
      return "`/prompt.clear`"
    case "prompt.submit":
      return "`/prompt.submit`"
    case "agent.cycle":
      return "`/agent.cycle`"
    default:
      if (keybind) return formatBetterC0deNativeKeybindEquivalent(keybind)
      return "`/help`, `/sessions`, `/compact`, `/prompt.clear`, `/prompt.submit`, or the native BetterC0de UI"
  }
}

function resolveBetterC0deTuiCommandId(args: ReadonlyArray<string>): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (arg === "--command" || arg === "--id" || arg === "--name") {
      return args[index + 1]?.trim() ?? ""
    }
    if (arg.startsWith("--command=")) {
      return arg.slice("--command=".length).trim()
    }
    if (arg.startsWith("--id=")) {
      return arg.slice("--id=".length).trim()
    }
    if (arg.startsWith("--name=")) {
      return arg.slice("--name=".length).trim()
    }
  }
  return args.find((arg) => arg && !arg.startsWith("-"))?.trim() ?? ""
}

function formatBetterC0deNativeKeybindEquivalent(
  keybind: ReturnType<typeof findBetterC0deKeybindDefault>
): string {
  if (!keybind) return "the native BetterC0de UI"
  const handling = keybind.handling
    ? `native ${keybind.handling}`
    : "the native BetterC0de UI"
  return `${handling} (Settings > Compatibility > BetterC0de Default Keybinds: \`${escapeInlineCode(keybind.command)}\`, ${escapeMarkdownTableCell(keybind.description)})`
}
