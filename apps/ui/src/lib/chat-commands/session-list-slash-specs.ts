import { useAppearanceStore } from "@/lib/appearance-store"
import { filterThreadsForSessionDirectory } from "@/lib/session-directory-filter"
import {
  buildBetterC0deSessionCliOutput,
  buildBetterC0deSessionCliTerminalCommand,
} from "./session-cli-commands"
import {
  type SessionListOptions,
  buildSessionsOutput,
} from "./session-commands"
import { dispatchPrefilledTerminalCommand } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"
import {
  isBetterC0deSessionSlashSubcommand,
  stripBetterC0deSessionSlashSubcommand,
} from "./slash-subcommands"

export function parseSessionListOptions(
  args: readonly string[]
): SessionListOptions {
  const options: SessionListOptions = { format: "table" }
  const nextValue = (index: number): string | undefined => {
    const value = args[index + 1]
    return value && !value.startsWith("-") ? value.trim() : undefined
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]?.trim()
    if (!arg) continue
    const normalized = arg.toLowerCase()
    if (normalized === "--json") {
      options.format = "json"
      continue
    }
    if (normalized === "--format" && args[index + 1]) {
      const format = args[index + 1].trim().toLowerCase()
      if (format === "json" || format === "table") options.format = format
      index += 1
      continue
    }
    if (normalized.startsWith("--format=")) {
      const format = normalized.slice("--format=".length)
      if (format === "json" || format === "table") options.format = format
      continue
    }
    if (normalized === "--order" && args[index + 1]) {
      const order = args[index + 1].trim().toLowerCase()
      if (order === "asc" || order === "desc") options.order = order
      index += 1
      continue
    }
    if (normalized.startsWith("--order=")) {
      const order = normalized.slice("--order=".length)
      if (order === "asc" || order === "desc") options.order = order
      continue
    }
    if (normalized === "--search" || normalized === "--query") {
      const value = nextValue(index)
      if (value) {
        options.search = value
        index += 1
      }
      continue
    }
    if (normalized.startsWith("--search=")) {
      options.search = arg.slice("--search=".length).trim()
      continue
    }
    if (normalized.startsWith("--query=")) {
      options.search = arg.slice("--query=".length).trim()
      continue
    }
    if (normalized === "--path" || normalized === "--directory") {
      const value = nextValue(index)
      if (value) {
        options.path = value
        index += 1
      }
      continue
    }
    if (normalized.startsWith("--path=")) {
      options.path = arg.slice("--path=".length).trim()
      continue
    }
    if (normalized.startsWith("--directory=")) {
      options.path = arg.slice("--directory=".length).trim()
      continue
    }
    if (normalized === "--roots") {
      const value = nextValue(index)
      if (value && ["true", "false"].includes(value.toLowerCase())) {
        options.roots = value.toLowerCase() === "true"
        index += 1
      } else {
        options.roots = true
      }
      continue
    }
    if (normalized.startsWith("--roots=")) {
      const value = normalized.slice("--roots=".length)
      if (value === "true" || value === "false")
        options.roots = value === "true"
      continue
    }
    if (normalized === "--start") {
      const value = nextValue(index)
      const parsed = value ? Number(value) : NaN
      if (Number.isFinite(parsed)) {
        options.start = parsed
        index += 1
      }
      continue
    }
    if (normalized.startsWith("--start=")) {
      const parsed = Number(normalized.slice("--start=".length))
      if (Number.isFinite(parsed)) options.start = parsed
      continue
    }
    if (normalized === "--cursor" && args[index + 1]) {
      options.cursor = args[index + 1].trim()
      index += 1
      continue
    }
    if (normalized.startsWith("--cursor=")) {
      options.cursor = arg.slice("--cursor=".length).trim()
      continue
    }
    if (
      (normalized === "--max-count" ||
        normalized === "--limit" ||
        normalized === "-n") &&
      args[index + 1]
    ) {
      const parsed = Number(args[index + 1])
      if (Number.isFinite(parsed)) {
        options.maxCount = Math.max(1, Math.min(500, Math.round(parsed)))
      }
      index += 1
      continue
    }
    if (
      normalized.startsWith("--max-count=") ||
      normalized.startsWith("--limit=")
    ) {
      const [, rawValue] = normalized.split("=", 2)
      const parsed = Number(rawValue)
      if (Number.isFinite(parsed)) {
        options.maxCount = Math.max(1, Math.min(500, Math.round(parsed)))
      }
    }
  }
  return options
}

/** `/session list|delete` CLI parity first, then the session list (also the `/resume` fallback). */
export const SESSION_LIST_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["session"],
      when: ({ cmd, args }) =>
        isBetterC0deSessionSlashSubcommand(cmd, args, "list"),
      run: (run) => {
        const { args, activeThread } = run
        const sessionArgs = stripBetterC0deSessionSlashSubcommand(args)
        const terminalCommand = buildBetterC0deSessionCliTerminalCommand(
          "/betterc0de-session-list",
          sessionArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildBetterC0deSessionCliOutput(
          "/betterc0de-session-list",
          sessionArgs,
          activeThread
        )
      },
    },
    {
      names: ["session"],
      when: ({ cmd, args }) =>
        isBetterC0deSessionSlashSubcommand(cmd, args, "delete"),
      run: (run) => {
        const { args, activeThread } = run
        const sessionArgs = stripBetterC0deSessionSlashSubcommand(args)
        const terminalCommand = buildBetterC0deSessionCliTerminalCommand(
          "/betterc0de-session-delete",
          sessionArgs
        )
        if (terminalCommand.shouldOpen && terminalCommand.command) {
          dispatchPrefilledTerminalCommand(
            activeThread,
            terminalCommand.command
          )
        }
        run.output = buildBetterC0deSessionCliOutput(
          "/betterc0de-session-delete",
          sessionArgs,
          activeThread
        )
      },
    },
    {
      names: [
        "sessions",
        "session",
        "resume",
        "continue",
        "session.list",
        "session.get",
        "session-list",
        "v2.session.list",
        "v2-session-list",
      ],
      run: (run) => {
        const { args, store, threadId } = run
        run.output = buildSessionsOutput(
          filterThreadsForSessionDirectory(
            store.threads,
            threadId,
            useAppearanceStore.getState().sessionDirectoryFilterEnabled
          ),
          threadId,
          parseSessionListOptions(args)
        )
      },
    },
  ]
