import {
  SELECTABLE_THEME_TEMPLATES,
  templateMode,
  useAppearanceStore,
} from "@/lib/appearance-store"
import { readCustomThemes } from "@/lib/custom-theme-cache"
import { customTemplateId, customThemeIdOf } from "@/lib/vscode-theme"
import { isSlashCommand } from "./prompt-commands"
import { escapeMarkdownTableCell } from "./provider-config"
import { resolveToggleArg } from "./settings-actions"
import { buildToggleOutput } from "./slash-command-actions"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"

function buildThemesOutput(currentTemplate: string, switched: boolean): string {
  const rows = SELECTABLE_THEME_TEMPLATES.map((template) => {
    const current = template.id === currentTemplate ? "Active" : ""
    return `| \`${template.mode}\` | ${template.name} | \`${template.id}\` | ${current} |`
  })
  // Imported VS Code / Cursor themes are switchable by id or name too.
  const imported = Object.values(readCustomThemes()).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
  for (const theme of imported) {
    const current =
      customTemplateId(theme.id) === currentTemplate ? "Active" : ""
    rows.push(
      `| \`${theme.mode}\` | ${escapeMarkdownTableCell(theme.name)} | \`${theme.id}\` | ${current} |`
    )
  }
  return [
    "# Themes\n",
    switched
      ? "Theme updated.\n"
      : imported.length > 0
        ? "Use `/theme <id>` with one of the ids below, or `/theme dark` / `/theme light`. Import more under **Settings → Appearance → Imported themes**.\n"
        : "Use `/theme dark` or `/theme light`. Import VS Code or Cursor themes under **Settings → Appearance → Imported themes**.\n",
    "| Mode | Name | ID | |",
    "|:-----|:-----|:---|:--|",
    ...rows,
  ].join("\n")
}

function buildThemeModeOutput(
  currentTemplate: string,
  locked: boolean
): string {
  const template = SELECTABLE_THEME_TEMPLATES.find(
    (entry) => entry.id === currentTemplate
  )
  const importedName =
    readCustomThemes()[customThemeIdOf(currentTemplate) ?? ""]?.name
  return [
    "# Theme Mode\n",
    `Switched to **${(templateMode(currentTemplate) ?? template?.mode) === "light" ? "Light" : "Dark"}** mode.`,
    "",
    `Theme: **${escapeMarkdownTableCell(template?.name ?? importedName ?? currentTemplate)}**`,
    `Mode lock: **${locked ? "On" : "Off"}**`,
    "",
    "> Use `/theme-mode-lock on|off` to pin or unpin the current mode.",
  ].join("\n")
}

function resolveThemeTemplateId(value: string): string | null {
  if (value === "dark" || value === "default-dark") return "default-dark"
  if (value === "light" || value === "white") return "white"
  const builtIn = SELECTABLE_THEME_TEMPLATES.find(
    (template) =>
      template.id.toLowerCase() === value ||
      template.name.toLowerCase() === value
  )
  if (builtIn) return builtIn.id
  const wanted = value.replace(/^custom:/, "")
  const imported = Object.values(readCustomThemes()).find(
    (theme) =>
      theme.id.toLowerCase() === wanted || theme.name.toLowerCase() === wanted
  )
  return imported ? customTemplateId(imported.id) : null
}

function nextThemeTemplateId(currentTemplate: string): string {
  return currentTemplate === "white" ? "default-dark" : "white"
}

function buildLanguageCompatibilityOutput(): string {
  return [
    "# Language\n",
    "Compatibility reference: `language.cycle` / `language.set.<locale>`.",
    "",
    "BetterC0de currently exposes a single UI language. The command is reserved for BetterC0de compatibility so project docs, keybind references, and command searches do not fall through to the provider.",
  ].join("\n")
}

function handleTerminalFontCommand(args: string[]): string {
  const appearance = useAppearanceStore.getState()
  const requested = normalizeTerminalFontCommandValue(args.join(" "))
  if (requested !== null) {
    appearance.set("terminalFontFamily", requested)
  }
  return buildTerminalFontOutput(
    useAppearanceStore.getState().terminalFontFamily,
    requested !== null
  )
}

export function normalizeTerminalFontCommandValue(
  value: string
): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const unquoted = trimmed.replace(/^["']|["']$/g, "").trim()
  const normalized = unquoted.toLowerCase()
  if (
    normalized === "system" ||
    normalized === "default" ||
    normalized === "reset" ||
    normalized === "off"
  ) {
    return ""
  }
  return unquoted
}

export function buildTerminalFontOutput(
  font: string,
  changed: boolean
): string {
  return [
    "# Terminal Font\n",
    changed
      ? "Terminal font updated.\n"
      : "Use `/terminal-font JetBrains Mono` or `/terminal-font system`.\n",
    `Current: **${escapeMarkdownTableCell(font || "Terminal default")}**`,
  ].join("\n")
}

/** Themes, theme mode, language and terminal font. */
export const APPEARANCE_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["theme-mode", "theme.switch_mode", "theme-switch-mode"],
      run: (run) => {
        const appearance = useAppearanceStore.getState()
        const nextTemplate = nextThemeTemplateId(appearance.template)
        appearance.applyTemplate(nextTemplate)
        run.output = buildThemeModeOutput(
          useAppearanceStore.getState().template,
          appearance.themeModeLocked
        )
      },
    },
    {
      names: ["theme-mode-lock", "theme.mode.lock", "theme-lock"],
      run: (run) => {
        const { args } = run
        const appearance = useAppearanceStore.getState()
        const next = resolveToggleArg(args[0], appearance.themeModeLocked)
        appearance.set("themeModeLocked", next)
        run.output = buildToggleOutput("Theme Mode Lock", next)
      },
    },
    {
      names: [
        "themes",
        "theme",
        "theme.switch",
        "theme-switch",
        "theme.cycle",
        "theme-cycle",
        "theme.scheme.cycle",
        "theme-scheme-cycle",
      ],
      run: (run) => {
        const { cmd, args } = run
        const appearance = useAppearanceStore.getState()
        const cycleRequested = isSlashCommand(
          cmd,
          "theme.cycle",
          "theme-cycle",
          "theme.scheme.cycle",
          "theme-scheme-cycle"
        )
        const requestedTheme =
          cycleRequested && !args[0]
            ? nextThemeTemplateId(appearance.template)
            : args[0]?.toLowerCase()
        const nextTemplate = requestedTheme
          ? resolveThemeTemplateId(requestedTheme)
          : null
        if (nextTemplate) {
          appearance.applyTemplate(nextTemplate)
        }
        run.output = buildThemesOutput(
          nextTemplate
            ? useAppearanceStore.getState().template
            : appearance.template,
          Boolean(nextTemplate)
        )
      },
    },
    {
      names: ["language", "language.cycle", "language-cycle"],
      run: (run) => {
        run.output = buildLanguageCompatibilityOutput()
      },
    },
    {
      names: [
        "terminal-font",
        "font.terminal",
        "terminal.font",
        "appearance.terminal_font",
      ],
      run: (run) => {
        const { args } = run
        run.output = handleTerminalFontCommand(args)
      },
    },
  ]
