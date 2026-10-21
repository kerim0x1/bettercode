/**
 * Pure helpers behind the slash menu: trigger detection at the cursor,
 * fuzzy ranking, composer filtering and the text replacement a selection
 * performs. Provider, project and skill commands are adapted here too.
 */

import { formatProviderSkillCommandDescription } from "@/lib/provider-skill-presentation"
import {
  type WorkspaceProjectCommand,
  type WorkspaceProjectSkill,
} from "@/services/backend"
import type { ProviderSkill, ProviderSlashCommand } from "@betterc0de/schema"
import {
  GOAL_SUBCOMMANDS,
  isReservedBuiltinSlashCommandName,
  type SlashCommand,
} from "@/lib/slash-command-catalog"

export interface SlashCommandTrigger {
  trigger: "/" | "$"
  query: string
  rangeStart: number
  rangeEnd: number
}

export interface SlashCommandReplacementRange {
  start: number
  end: number
}

export function detectSlashCommandTrigger(
  text: string,
  cursorInput = text.length
): SlashCommandTrigger | null {
  const rangeEnd = clampCursor(text, cursorInput)
  const afterNewline = text.lastIndexOf("\n", Math.max(0, rangeEnd - 1)) + 1
  const line = text.substring(afterNewline, Math.max(afterNewline, rangeEnd))
  const token = tokenStartForCursor(text, rangeEnd)
  const goalPrefix = /^\/goal[\t ]+(\S*)$/i.exec(line)
  const completingGoalCommand =
    goalPrefix !== null &&
    GOAL_SUBCOMMANDS.some((command) =>
      [command.name, ...(command.aliases ?? [])].some((name) =>
        name.slice("/goal ".length).startsWith(goalPrefix[1].toLowerCase())
      )
    )
  const candidates: ReadonlyArray<readonly ["/" | "$", number, boolean]> = [
    [
      "/",
      afterNewline,
      (line[0] === "/" && !/\s/.test(line)) || completingGoalCommand,
    ],
    ["$", token, text.slice(token, rangeEnd).startsWith("$")],
  ]
  for (const [trigger, rangeStart, valid] of candidates) {
    if (valid)
      return {
        trigger,
        query: text.slice(rangeStart + 1, rangeEnd),
        rangeStart,
        rangeEnd,
      }
  }
  return null
}

export function filterSlashCommandsForQuery(
  commands: ReadonlyArray<SlashCommand>,
  query: string,
  trigger: "/" | "$",
  limit = Number.POSITIVE_INFINITY
): SlashCommand[] {
  const normalizedQuery = normalizeCommandQuery(query, trigger)
  if (!normalizedQuery) return commands.slice(0, limit)

  return commands
    .map((command) => {
      const score = scoreSlashCommand(command, normalizedQuery, trigger)
      return score === null
        ? null
        : {
            command,
            score,
            tieBreaker: `${categoryRank(command.category)}\u0000${stripTrigger(command.name, trigger).toLowerCase()}`,
          }
    })
    .filter(
      (
        entry
      ): entry is {
        command: SlashCommand
        score: number
        tieBreaker: string
      } => entry !== null
    )
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score
      return left.tieBreaker.localeCompare(right.tieBreaker)
    })
    .slice(0, limit)
    .map((entry) => entry.command)
}

export type SlashCommandFilter = "all" | "commands" | "skills"

export function filterComposerCommands(
  commands: ReadonlyArray<SlashCommand>,
  query: string,
  category: SlashCommandFilter = "all",
  limit = 12
): SlashCommand[] {
  const goalPrefix = /^goal[\t ]+(\S*)$/i.exec(query)
  const scopedCommands = goalPrefix
    ? commands.filter(
        (command) =>
          GOAL_SUBCOMMANDS.includes(command) &&
          [command.name, ...(command.aliases ?? [])].some((name) =>
            name.slice("/goal ".length).startsWith(goalPrefix[1].toLowerCase())
          )
      )
    : query.trim()
      ? commands
      : commands.filter((command) => !GOAL_SUBCOMMANDS.includes(command))
  const matching = filterSlashCommandsForQuery(
    scopedCommands.filter(
      (command) =>
        category === "all" ||
        (category === "skills") === (command.category === "skill")
    ),
    goalPrefix ? `goal ${goalPrefix[1]}` : query,
    "/"
  )
  if (query.trim() || category !== "all") return matching.slice(0, limit)
  // Hundreds of built-ins must not hide every skill when opening `/`.
  const skills = matching.filter((command) => command.category === "skill")
  const others = matching.filter((command) => command.category !== "skill")
  const skillSlots = Math.min(skills.length, 4, limit)
  const commandPreview = others.slice(0, limit - skillSlots)
  return [...commandPreview, ...skills.slice(0, limit - commandPreview.length)]
}

export function slashCommandEmptyStateText(
  trigger: "/" | "$",
  category: SlashCommandFilter = "all"
): string {
  return trigger === "$"
    ? "No skills found. Try / to browse provider commands."
    : category === "skills"
      ? "No matching skills."
      : category === "commands"
        ? "No matching command."
        : "No matching command or skill."
}

export function slashCommandSelectionReplacement(
  command: SlashCommand
): string {
  if (IMMEDIATE_BUILTIN_COMMAND_IDS.has(command.id)) {
    return ""
  }
  return `${command.insertText ?? command.name} `
}

const IMMEDIATE_BUILTIN_COMMAND_IDS = new Set([
  "model",
  "plan",
  "ask",
  "security",
  "debug",
  "default",
  "prompt-clear",
  "prompt-paste",
])

export function replaceSlashCommandTriggerRange(
  text: string,
  range: SlashCommandReplacementRange | null | undefined,
  replacement: string
): { text: string; cursor: number } | null {
  const safeRange = normalizeReplacementRange(text, range)
  if (!safeRange) return null
  const replacementEnd = extendReplacementRangeForTrailingSpace(
    text,
    safeRange.end,
    replacement
  )
  const nextText = `${text.slice(0, safeRange.start)}${replacement}${text.slice(
    replacementEnd
  )}`
  return {
    text: nextText,
    cursor: safeRange.start + replacement.length,
  }
}

export function providerSlashCommands(
  commands: ReadonlyArray<ProviderSlashCommand>
): SlashCommand[] {
  return commands
    .filter((command) => command.name.trim().length > 0)
    .map((command) => {
      const name = stripTrigger(command.name, "/")
      if (isReservedBuiltinSlashCommandName(name)) return null
      return {
        id: `provider-${name}`,
        name: `/${name}`,
        description:
          command.description ?? command.input?.hint ?? "Provider command",
        category: "provider",
        action: "insert",
      }
    })
    .filter((command): command is SlashCommand => Boolean(command))
}

export function projectCommandSlashCommands(
  commands: ReadonlyArray<WorkspaceProjectCommand>
): SlashCommand[] {
  return commands
    .filter((command) => command.name.trim().length > 0)
    .map((command) => {
      const name = stripTrigger(command.name, "/")
      if (isReservedBuiltinSlashCommandName(name)) return null
      return {
        id: `project-${name}`,
        name: `/${name}`,
        description: projectCommandSlashDescription(command),
        category: "project",
        action: "insert",
      }
    })
    .filter((command): command is SlashCommand => Boolean(command))
}

function projectCommandSlashDescription(
  command: WorkspaceProjectCommand
): string {
  const base =
    command.description ?? `Project command from ${command.sourcePath}`
  const meta = [
    command.agent ? `agent: ${command.agent}` : "",
    command.model ? `model: ${command.model}` : "",
    typeof command.subtask === "boolean"
      ? `subtask: ${command.subtask ? "enabled" : "disabled"}`
      : "",
  ].filter(Boolean)
  return meta.length > 0 ? `${base} (${meta.join(", ")})` : base
}

export function projectSkillSlashCommands(
  skills: ReadonlyArray<WorkspaceProjectSkill>,
  commands: ReadonlyArray<WorkspaceProjectCommand> = []
): SlashCommand[] {
  const commandNames = new Set(
    commands.map((command) => stripTrigger(command.name, "/").toLowerCase())
  )
  return skills
    .filter((skill) => skill.id.trim().length > 0)
    .map((skill) => {
      const name = stripTrigger(skill.id, "/")
      if (commandNames.has(name.toLowerCase())) return null
      if (isReservedBuiltinSlashCommandName(name)) return null
      return {
        id: `project-skill-${name}`,
        name: `/${name}`,
        description:
          skill.description ?? `Project skill from ${skill.sourcePath}`,
        category: "skill",
        action: "insert",
      }
    })
    .filter((command): command is SlashCommand => Boolean(command))
}

export function providerSkillCommands(
  skills: ReadonlyArray<ProviderSkill>,
  trigger: "/" | "$" = "$"
): SlashCommand[] {
  return skills
    .filter((skill) => skill.enabled && skill.name.trim().length > 0)
    .map((skill) => {
      const name = stripTrigger(skill.name, "$")
      return {
        id: `skill-${name}`,
        name: `${trigger}${name}`,
        ...(trigger === "/" ? { insertText: `$${name}` } : {}),
        description: formatProviderSkillCommandDescription(skill),
        category: "skill",
        action: "insert",
      }
    })
}

function stripTrigger(value: string, trigger: "/" | "$"): string {
  return value.trim().replace(new RegExp(`^\\${trigger}+`), "")
}

function normalizeReplacementRange(
  text: string,
  range: SlashCommandReplacementRange | null | undefined
): SlashCommandReplacementRange | null {
  if (!range) return null
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return null
  const start = Math.floor(range.start)
  const end = Math.floor(range.end)
  if (start < 0 || end < start || end > text.length) return null
  return { start, end }
}

function extendReplacementRangeForTrailingSpace(
  text: string,
  rangeEnd: number,
  replacement: string
): number {
  if (!replacement.endsWith(" ")) return rangeEnd
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd
}

function clampCursor(text: string, cursorInput: number): number {
  if (!Number.isFinite(cursorInput)) return text.length
  return Math.max(0, Math.min(text.length, Math.floor(cursorInput)))
}

function tokenStartForCursor(text: string, cursor: number): number {
  const prefix = text.slice(0, cursor)
  const token = /\S+$/.exec(prefix)
  // JavaScript's $ also matches before a final newline; only accept an actual suffix.
  return token && token.index + token[0].length === cursor
    ? token.index
    : cursor
}

function normalizeCommandQuery(query: string, trigger: "/" | "$"): string {
  return stripTrigger(query, trigger).trim().toLowerCase().replace(/\s+/g, " ")
}

function scoreSlashCommand(
  command: SlashCommand,
  query: string,
  trigger: "/" | "$"
): number | null {
  const primary = stripTrigger(command.name, trigger).toLowerCase()
  const aliases = (command.aliases ?? []).map((alias) =>
    stripTrigger(alias, trigger).toLowerCase()
  )
  const description = command.description.toLowerCase()
  const scores = [
    scoreQueryMatch(primary, query, {
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
    }),
    ...aliases.map((alias) =>
      scoreQueryMatch(alias, query, {
        exactBase: 1,
        prefixBase: 3,
        boundaryBase: 5,
        includesBase: 7,
        fuzzyBase: 101,
      })
    ),
    scoreQueryMatch(description, query, {
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
      fuzzyBase: null,
    }),
  ].filter((score): score is number => score !== null)
  return scores.length === 0 ? null : Math.min(...scores)
}

function scoreQueryMatch(
  value: string,
  query: string,
  bases: {
    exactBase: number
    prefixBase: number
    boundaryBase: number
    includesBase: number
    fuzzyBase: number | null
  }
): number | null {
  if (!value || !query) return null
  if (value === query) return bases.exactBase
  if (value.startsWith(query)) return bases.prefixBase
  if (hasBoundaryMatch(value, query)) return bases.boundaryBase
  const index = value.indexOf(query)
  if (index >= 0) return bases.includesBase + Math.min(index / 100, 0.99)
  if (bases.fuzzyBase !== null) {
    const fuzzyScore = fuzzySequenceScore(value, query)
    if (fuzzyScore !== null) return bases.fuzzyBase + fuzzyScore
  }
  return null
}

function hasBoundaryMatch(value: string, query: string): boolean {
  const queryLength = query.length
  for (let index = 0; index <= value.length - queryLength; index += 1) {
    if (value.slice(index, index + queryLength) !== query) continue
    if (index === 0 || "-_/ ".includes(value[index - 1] ?? "")) return true
  }
  return false
}

function fuzzySequenceScore(value: string, query: string): number | null {
  let valueIndex = 0
  let firstMatch = -1
  let lastMatch = -1
  for (const char of query) {
    const nextIndex = value.indexOf(char, valueIndex)
    if (nextIndex < 0) return null
    if (firstMatch < 0) firstMatch = nextIndex
    lastMatch = nextIndex
    valueIndex = nextIndex + 1
  }
  return (
    firstMatch + Math.max(0, lastMatch - firstMatch - query.length + 1) / 10
  )
}

function categoryRank(category: SlashCommand["category"]): number {
  switch (category) {
    case "builtin":
      return 0
    case "project":
      return 1
    case "provider":
      return 2
    case "skill":
      return 3
  }
}
