import { stringifyCliArgs } from "@/lib/cli-parse"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { formatDebugPathCell } from "./lsp-commands"
import {
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"
import { maintenanceMissingValueMessages } from "./provider-commands"
import type { ActiveThreadRef } from "./provider-config"

function isPositiveIntegerString(value: string): boolean {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0
}

function betterC0deSessionCliMode(
  command: string,
  args: ReadonlyArray<string>
): "delete" | "list" {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const first = args.find((arg) => !arg.startsWith("-"))?.toLowerCase()
  if (normalized.includes("delete") || first === "delete") return "delete"
  return "list"
}

function buildBetterC0deSessionCliArgs(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  const cleanArgs = [...stripBetterC0deRuntimeUiFlags(args)]
  const first = cleanArgs.find((arg) => !arg.startsWith("-"))?.toLowerCase()
  const mode = betterC0deSessionCliMode(command, cleanArgs)
  if (first === "list" || first === "delete") return cleanArgs
  return [mode, ...cleanArgs]
}

export function buildBetterC0deSessionCliTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const cliArgs = stringifyCliArgs(buildBetterC0deSessionCliArgs(command, args))
  return {
    command: ["betterc0de session", cliArgs].filter(Boolean).join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function buildBetterC0deSessionCliValidationMessages(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  const mode = betterC0deSessionCliMode(command, cleanArgs)
  const messages = maintenanceMissingValueMessages(cleanArgs, [
    "--format",
    "--max-count",
    "-n",
  ])

  if (mode === "delete") {
    if (!firstBetterC0deSessionDeleteId(command, cleanArgs)) {
      messages.push("BetterC0de session delete requires a session ID.")
    }
    return messages
  }

  const format = betterC0deSessionCliOptionValue(cleanArgs, "--format")
  if (format !== undefined) {
    if (!format.trim()) {
      pushUnique(messages, "--format requires a value.")
    } else if (!["table", "json"].includes(format.toLowerCase())) {
      messages.push("`--format` must be `table` or `json`.")
    }
  }

  const maxCount = betterC0deSessionCliOptionValue(
    cleanArgs,
    "--max-count",
    "-n"
  )
  if (maxCount !== undefined) {
    if (!maxCount.trim()) {
      pushUnique(messages, "--max-count requires a value.")
    } else if (!isPositiveIntegerString(maxCount)) {
      messages.push("`--max-count` must be a positive integer.")
    }
  }

  return messages
}

function betterC0deSessionCliOptionValue(
  args: ReadonlyArray<string>,
  ...names: string[]
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--") break
    if (names.includes(arg)) {
      const value = args[index + 1]
      return value && !value.startsWith("-") ? value : ""
    }
    for (const name of names) {
      const prefix = `${name}=`
      if (arg.startsWith(prefix)) return arg.slice(prefix.length)
    }
  }
  return undefined
}

function firstBetterC0deSessionDeleteId(
  command: string,
  args: ReadonlyArray<string>
): string | undefined {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const commandImpliesDelete = normalized.includes("delete")
  const optionsWithValues = new Set(["--format", "--max-count", "-n"])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (isBetterC0deRuntimeTerminalFlag(arg)) continue
    if (arg === "--") {
      return args.slice(index + 1).find((item) => item.trim().length > 0)
    }
    if (arg === "delete" && !commandImpliesDelete) continue
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

function pushUnique(messages: string[], message: string): void {
  if (!messages.includes(message)) messages.push(message)
}

export function buildBetterC0deSessionCliOutput(
  command: string,
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): string {
  const mode = betterC0deSessionCliMode(command, args)
  const cliArgs = stringifyCliArgs(buildBetterC0deSessionCliArgs(command, args))
  const cliCommand = ["betterc0de session", cliArgs].filter(Boolean).join(" ")
  const workspace = resolveThreadRuntimePath(activeThread)
  const shouldOpenTerminal = args.some(isBetterC0deRuntimeTerminalFlag)
  const validation = buildBetterC0deSessionCliValidationMessages(command, args)
  const heading =
    mode === "delete" ? "BetterC0de Session Delete" : "BetterC0de Session List"
  const details =
    mode === "delete"
      ? [
          "Deletes an BetterC0de session by session ID from the compatibility CLI's own session storage.",
          "BetterC0de's local chat storage is separate; use `/delete-session --yes` for BetterC0de threads.",
          "This flow is terminal-only because BetterC0de owns the backing database and deletion side effects.",
        ]
      : [
          "Lists BetterC0de sessions from the compatibility CLI's own session storage.",
          "Supports `--max-count`/`-n` and `--format table|json`, matching BetterC0de compatibility CLI.",
          "Use `/sessions` for BetterC0de's native chat sessions.",
        ]

  return [
    `# ${heading}`,
    "",
    `Compatibility reference: \`betterc0de session ${mode}\`.`,
    "",
    `Workspace: ${workspace ? formatDebugPathCell(workspace) : "No folder open"}`,
    "",
    "```sh",
    cliCommand,
    "```",
    "",
    "## Behavior",
    "",
    ...details.map((item) => `- ${item}`),
    ...(validation.length > 0
      ? ["", "## Validation", "", ...validation.map((item) => `- ${item}`)]
      : []),
    "",
    shouldOpenTerminal
      ? workspace
        ? "> Opened the terminal panel with this BetterC0de session command prefilled. Press Enter there to run it intentionally."
        : "> Open a workspace first, then run this command with `--terminal` to prefill the integrated terminal."
      : "> Add `--terminal` to open the integrated terminal with this compatibility command prefilled.",
  ].join("\n")
}
