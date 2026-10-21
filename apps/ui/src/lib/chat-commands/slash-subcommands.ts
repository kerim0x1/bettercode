import { isBetterC0deRuntimeTerminalFlag } from "./mcp-commands"
import { isSlashCommand } from "./prompt-commands"

type BetterC0deMcpSlashSubcommand =
  | "add"
  | "auth"
  | "logout"
  | "debug"
  | "list"
  | "resources"

function betterC0deMcpSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deMcpSlashSubcommand | null {
  if (!isSlashCommand(command, "mcp")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "add":
    case "install":
      return "add"
    case "auth":
    case "authenticate":
      return "auth"
    case "logout":
    case "remove":
      return "logout"
    case "debug":
    case "inspect":
      return "debug"
    case "list":
    case "ls":
    case "status":
      return "list"
    case "resource":
    case "resources":
      return "resources"
    default:
      return null
  }
}

export function isBetterC0deMcpSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>,
  mode: BetterC0deMcpSlashSubcommand
): boolean {
  return betterC0deMcpSlashSubcommand(command, args) === mode
}

type BetterC0deProviderSlashSubcommand = "login" | "list" | "logout"

function betterC0deProviderSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deProviderSlashSubcommand | null {
  if (!isSlashCommand(command, "providers", "auth")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "login":
    case "connect":
      return "login"
    case "list":
    case "ls":
      return "list"
    case "logout":
    case "remove":
      return "logout"
    default:
      return null
  }
}

export function isBetterC0deProviderSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>,
  mode: BetterC0deProviderSlashSubcommand
): boolean {
  return betterC0deProviderSlashSubcommand(command, args) === mode
}

export function stripBetterC0deProviderSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (
    !["login", "connect", "list", "ls", "logout", "remove"].includes(
      first ?? ""
    )
  ) {
    return [...args]
  }
  return args.filter((_, itemIndex) => itemIndex !== index)
}

type BetterC0deConsoleSlashSubcommand =
  | "login"
  | "logout"
  | "switch"
  | "orgs"
  | "open"

function betterC0deConsoleSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deConsoleSlashSubcommand | null {
  if (!isSlashCommand(command, "console", "account")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "login":
      return "login"
    case "logout":
      return "logout"
    case "switch":
    case "org.switch":
    case "org-switch":
      return "switch"
    case "org":
    case "orgs":
    case "organizations":
      return "orgs"
    case "open":
      return "open"
    default:
      return null
  }
}

export function isBetterC0deConsoleSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>,
  mode: BetterC0deConsoleSlashSubcommand
): boolean {
  return betterC0deConsoleSlashSubcommand(command, args) === mode
}

export function stripBetterC0deConsoleSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (
    ![
      "login",
      "logout",
      "switch",
      "org.switch",
      "org-switch",
      "org",
      "orgs",
      "organizations",
      "open",
    ].includes(first ?? "")
  ) {
    return [...args]
  }
  return args.filter((_, itemIndex) => itemIndex !== index)
}

type BetterC0deGithubSlashSubcommand = "install" | "run"

export function betterC0deGithubSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deGithubSlashSubcommand | null {
  if (!isSlashCommand(command, "github", "github-agent")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "install":
      return "install"
    case "run":
      return "run"
    default:
      return null
  }
}

export function stripBetterC0deGithubSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (!["install", "run"].includes(first ?? "")) return [...args]
  return args.filter((_, itemIndex) => itemIndex !== index)
}

type BetterC0deAgentSlashSubcommand = "list" | "create" | "debug"

export function betterC0deAgentSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deAgentSlashSubcommand | null {
  if (!isSlashCommand(command, "agent")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "list":
    case "ls":
      return "list"
    case "create":
    case "new":
      return "create"
    case "debug":
    case "inspect":
      return "debug"
    default:
      return null
  }
}

export function isBetterC0deAgentSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>,
  mode: BetterC0deAgentSlashSubcommand
): boolean {
  return betterC0deAgentSlashSubcommand(command, args) === mode
}

export function stripBetterC0deAgentSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (
    !["list", "ls", "create", "new", "debug", "inspect"].includes(first ?? "")
  ) {
    return [...args]
  }
  return args.filter((_, itemIndex) => itemIndex !== index)
}

type BetterC0deSessionSlashSubcommand = "list" | "delete"

function betterC0deSessionSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>
): BetterC0deSessionSlashSubcommand | null {
  if (!isSlashCommand(command, "session")) return null
  const first = args
    .find((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
    ?.trim()
    .toLowerCase()
  switch (first) {
    case "list":
    case "ls":
      return "list"
    case "delete":
    case "remove":
    case "rm":
      return "delete"
    default:
      return null
  }
}

export function isBetterC0deSessionSlashSubcommand(
  command: string,
  args: ReadonlyArray<string>,
  mode: BetterC0deSessionSlashSubcommand
): boolean {
  return betterC0deSessionSlashSubcommand(command, args) === mode
}

export function stripBetterC0deSessionSlashSubcommand(
  args: ReadonlyArray<string>
): string[] {
  const index = args.findIndex((arg) => !isBetterC0deRuntimeTerminalFlag(arg))
  if (index < 0) return [...args]
  const first = args[index]?.trim().toLowerCase()
  if (!["list", "ls", "delete", "remove", "rm"].includes(first ?? "")) {
    return [...args]
  }
  return args.filter((_, itemIndex) => itemIndex !== index)
}
