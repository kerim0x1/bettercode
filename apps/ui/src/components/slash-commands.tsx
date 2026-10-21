/**
 * The slash command menu. The catalog and the pure query helpers live in
 * `lib/`; they are re-exported here so callers keep one import. The menu's
 * open/query state lives in `lib/composer-menu-store.ts`.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { cn } from "@/lib/utils"
import {
  ComposerSuggestionItem,
  ComposerSuggestionPanel,
} from "@/components/chat/composer-suggestion-panel"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiBrain01Icon,
  AiIdeaIcon,
  ArchiveIcon,
  CommandIcon,
  CommandLineIcon,
  Comment01Icon,
  ConnectIcon,
  CubeIcon,
  Delete02Icon,
  GitBranchIcon,
  GitCompareIcon,
  GitForkIcon,
  GitPullRequestIcon,
  InformationCircleIcon,
  Note01Icon,
  PauseCircleIcon,
  PencilEdit02Icon,
  PinIcon,
  RedoIcon,
  SearchList01Icon,
  SparklesIcon,
  StarIcon,
  Target02Icon,
  UndoIcon,
  WorkHistoryIcon,
} from "@hugeicons/core-free-icons"
import type { UiProvider } from "@/lib/provider-types"
import { searchProviderSkills } from "@/lib/provider-skill-search"
import {
  betterC0deShareModeFromProjectSettings,
  type BetterC0deShareMode,
} from "@/lib/betterc0de-share-policy"
import {
  listProjectCommands,
  listProjectConfigSettings,
  listProjectSkills,
  type WorkspaceProjectCommand,
  type WorkspaceProjectSkill,
} from "@/services/backend/workspaceApi"
import {
  BUILTIN_COMMANDS,
  filterBuiltinCommandsForBetterC0deShareMode,
  type SlashCommand,
} from "@/lib/slash-command-catalog"
import {
  filterComposerCommands,
  slashCommandEmptyStateText,
  slashCommandSelectionReplacement,
  providerSlashCommands,
  projectCommandSlashCommands,
  projectSkillSlashCommands,
  providerSkillCommands,
  type SlashCommandFilter,
} from "@/lib/slash-command-query"

export {
  type SlashCommand,
  BUILTIN_COMMANDS,
  filterBuiltinCommandsForBetterC0deShareMode,
  isReservedBuiltinSlashCommandName,
} from "@/lib/slash-command-catalog"
export {
  type SlashCommandTrigger,
  type SlashCommandReplacementRange,
  detectSlashCommandTrigger,
  filterSlashCommandsForQuery,
  type SlashCommandFilter,
  filterComposerCommands,
  slashCommandEmptyStateText,
  slashCommandSelectionReplacement,
  replaceSlashCommandTriggerRange,
  projectCommandSlashCommands,
  projectSkillSlashCommands,
  providerSkillCommands,
} from "@/lib/slash-command-query"

/**
 * Per-command icon for the palette (Codex-style: every row carries a
 * meaningful, distinctive glyph — Hugeicons, same set the composer
 * chips use). Keyword-matched on the command id so project/provider
 * commands with recognizable names get a fitting icon too; unknown ids
 * fall back per category.
 */
function slashCommandIconFor(cmd: SlashCommand) {
  const id = cmd.id.toLowerCase()
  const has = (...keys: string[]) => keys.some((key) => id.includes(key))
  if (cmd.category === "skill") return SparklesIcon
  if (has("pr")) return GitPullRequestIcon
  if (has("review")) return SearchList01Icon
  if (has("feedback")) return Comment01Icon
  if (has("init", "agents")) return Note01Icon
  if (has("diff")) return GitCompareIcon
  if (has("mcp")) return ConnectIcon
  if (has("plan")) return AiIdeaIcon
  if (has("goal")) return Target02Icon
  if (has("reason", "think")) return AiBrain01Icon
  if (has("favorite")) return StarIcon
  if (has("model")) return CubeIcon
  if (has("undo", "checkpoint")) return UndoIcon
  if (has("redo")) return RedoIcon
  if (has("interrupt", "stop")) return PauseCircleIcon
  if (has("fork", "parent", "child", "sibling", "merge-back"))
    return GitForkIcon
  if (has("worktree", "branch")) return GitBranchIcon
  if (has("pin")) return PinIcon
  if (has("delete")) return Delete02Icon
  if (has("archive")) return ArchiveIcon
  if (has("status")) return InformationCircleIcon
  if (has("session", "resume", "history")) return WorkHistoryIcon
  if (has("new", "clear")) return PencilEdit02Icon
  if (has("palette")) return CommandIcon
  if (cmd.category === "provider" || cmd.category === "project") {
    return CommandLineIcon
  }
  return CommandIcon
}

interface SlashCommandMenuProps {
  query: string // the text after "/" or "$"
  trigger?: "/" | "$"
  selectedProvider?: UiProvider
  projectPath?: string | null
  onSelect: (command: SlashCommand, replacement: string) => void
  onClose: () => void
  visible: boolean
  /** Write text into the chat input textarea */
  setInputText?: (text: string) => void
}

export function SlashCommandMenu({
  query,
  trigger = "/",
  selectedProvider,
  projectPath,
  onSelect,
  onClose,
  visible,
  setInputText,
}: SlashCommandMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [categoryFilter, setCategoryFilter] =
    useState<SlashCommandFilter>("all")
  const [projectCommands, setProjectCommands] = useState<
    WorkspaceProjectCommand[]
  >([])
  const [projectSkills, setProjectSkills] = useState<WorkspaceProjectSkill[]>(
    []
  )
  const [projectShareMode, setProjectShareMode] =
    useState<BetterC0deShareMode | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!visible || trigger !== "/" || !projectPath) {
      setProjectCommands([])
      setProjectSkills([])
      setProjectShareMode(null)
      return
    }
    let cancelled = false
    Promise.all([
      listProjectCommands(projectPath),
      listProjectSkills(projectPath),
      listProjectConfigSettings(projectPath),
    ])
      .then(([commands, skills, settings]) => {
        if (!cancelled) {
          setProjectCommands(commands)
          setProjectSkills(skills)
          setProjectShareMode(betterC0deShareModeFromProjectSettings(settings))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectCommands([])
          setProjectSkills([])
          setProjectShareMode(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectPath, trigger, visible])

  const allCommands = useMemo(() => {
    if (trigger === "$") return []
    return [
      ...filterBuiltinCommandsForBetterC0deShareMode(
        BUILTIN_COMMANDS,
        projectShareMode
      ),
      ...projectCommandSlashCommands(projectCommands),
      ...projectSkillSlashCommands(projectSkills, projectCommands),
      ...providerSlashCommands(selectedProvider?.slashCommands ?? []),
      ...providerSkillCommands(selectedProvider?.skills ?? [], "/"),
    ]
  }, [
    projectCommands,
    projectShareMode,
    projectSkills,
    selectedProvider?.slashCommands,
    selectedProvider?.skills,
    trigger,
  ])

  const filtered = useMemo(() => {
    if (trigger === "$") {
      return providerSkillCommands(
        searchProviderSkills(selectedProvider?.skills ?? [], query, 12)
      )
    }
    return filterComposerCommands(allCommands, query, categoryFilter)
  }, [allCommands, categoryFilter, query, selectedProvider?.skills, trigger])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query, categoryFilter, selectedProvider?.id, trigger, visible])

  useEffect(() => {
    if (!visible) setCategoryFilter("all")
  }, [visible])

  const activeIndex = Math.min(selectedIndex, filtered.length - 1)

  const handleSelect = useCallback(
    (cmd: SlashCommand) => {
      const replacement = slashCommandSelectionReplacement(cmd)
      if (setInputText) {
        setInputText(replacement)
      }
      onSelect(cmd, replacement)
    },
    [onSelect, setInputText]
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!visible) return
      if (
        e.target instanceof Element &&
        e.target.closest("[data-slash-command-filter]")
      )
        return
      if (e.key === "ArrowDown") {
        e.preventDefault()
        if (filtered.length > 0) {
          setSelectedIndex(Math.min(activeIndex + 1, filtered.length - 1))
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        if (filtered.length > 0) {
          setSelectedIndex(Math.max(activeIndex - 1, 0))
        }
      } else if (
        (e.key === "Enter" || e.key === "Tab") &&
        filtered[activeIndex]
      ) {
        e.preventDefault()
        handleSelect(filtered[activeIndex])
      } else if (e.key === "Escape") {
        onClose()
      }
    },
    [activeIndex, filtered, handleSelect, onClose, visible]
  )

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleKeyDown])

  useEffect(() => {
    menuRef.current
      ?.querySelector(`[data-command-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  if (!visible) return null

  return (
    <div ref={menuRef} className="z-50 mb-2 min-w-0" data-slash-command-menu>
      <ComposerSuggestionPanel
        symbol={trigger}
        title={trigger === "$" ? "Skills" : "Commands"}
        detail={`${filtered.length} ${filtered.length === 1 ? "result" : "results"}`}
        toolbar={
          trigger === "/" && (
            <div
              className="flex items-center gap-1 border-b border-border/50 px-2 py-1.5"
              role="group"
              aria-label="Show commands or skills"
              data-slash-command-filter
            >
              {(
                [
                  ["all", "All"],
                  ["commands", "Commands"],
                  ["skills", "Skills"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={categoryFilter === value}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-foreground/40",
                    categoryFilter === value
                      ? "bg-foreground/[0.08] font-medium text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.04]"
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setCategoryFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          )
        }
      >
        {filtered.length === 0 ? (
          <div
            role="status"
            className="px-2.5 py-5 text-xs text-muted-foreground"
          >
            {slashCommandEmptyStateText(trigger, categoryFilter)}
          </div>
        ) : null}
        {filtered.map((cmd, i) => (
          <ComposerSuggestionItem
            key={cmd.id}
            selected={i === activeIndex}
            title={`${cmd.name}: ${cmd.description}`}
            onClick={() => handleSelect(cmd)}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setSelectedIndex(i)}
            data-command-id={cmd.id}
            data-command-index={i}
            aria-label={`${cmd.name}${cmd.category === "skill" ? " skill" : ""}: ${cmd.description}`}
          >
            <HugeiconsIcon
              icon={slashCommandIconFor(cmd)}
              strokeWidth={1.75}
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span className="max-w-[55%] min-w-0 truncate text-[13px] font-medium tracking-[-0.01em] text-foreground/95">
              {cmd.name}
            </span>
            {cmd.category === "skill" && (
              <span className="shrink-0 rounded bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                Skill
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
              {cmd.description}
            </span>
          </ComposerSuggestionItem>
        ))}
      </ComposerSuggestionPanel>
    </div>
  )
}
