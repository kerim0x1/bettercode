import {
  isBetterC0deRuntimeTerminalFlag,
  stripBetterC0deRuntimeUiFlags,
} from "./mcp-commands"

export function buildProviderOrganizationOutput(
  command = "/org",
  args: ReadonlyArray<string> = []
): string {
  const terminalCommand = buildBetterC0deAccountTerminalCommand(command, args)
  const validation = buildBetterC0deAccountValidationMessages(command, args)
  return [
    "# Organization\n",
    "Opened provider settings. BetterC0de keeps OAuth account, CLI auth, and provider organization controls with each provider.",
    "",
    "## Compatibility references",
    "",
    "| Compatibility CLI | BetterC0de |",
    "|:---------|:-----------|",
    "| `betterc0de console orgs` | `/console.orgs`, `/account.orgs`, or `/orgs` |",
    "| `betterc0de console switch` | `/console.switch`, `/console.org.switch`, or `/switch-org` |",
    "| `console.org.switch` TUI action | `/console.org.switch` |",
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
          "> Opened the terminal panel with this command prefilled.",
        ].join("\n")
      : "> Add `--terminal` to prefill `betterc0de console orgs` or `betterc0de console switch` in the integrated terminal.",
    "",
    "> Console org data is surfaced through provider settings and uses metadata-only display; BetterC0de does not print account tokens or credential values into chat.",
  ].join("\n")
}

export function buildBetterC0deAccountTerminalCommand(
  command: string,
  args: ReadonlyArray<string>
): { command: string; shouldOpen: boolean } {
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode =
    normalized.includes("switch") || normalized.includes("org.switch")
      ? "switch"
      : normalized.includes("open")
        ? "open"
        : "orgs"
  return {
    command: ["betterc0de console", mode].filter(Boolean).join(" "),
    shouldOpen: args.some(isBetterC0deRuntimeTerminalFlag),
  }
}

function buildBetterC0deAccountValidationMessages(
  command: string,
  args: ReadonlyArray<string>
): string[] {
  const cleanArgs = stripBetterC0deRuntimeUiFlags(args)
  if (cleanArgs.length === 0) return []
  const normalized = command.replace(/^\//, "").toLowerCase()
  const mode =
    normalized.includes("switch") || normalized.includes("org.switch")
      ? "switch"
      : normalized.includes("open")
        ? "open"
        : "orgs"
  return [
    `Compatibility console ${mode} does not accept arguments; it uses the active account state.`,
  ]
}
