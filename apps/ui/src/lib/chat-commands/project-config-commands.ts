import {
  BETTERC0DE_COMPOSER_KEYBIND_DEFAULTS,
  BETTERC0DE_KEYBIND_DEFAULTS,
} from "@/lib/betterc0de-keybinds"
import { getProjectRules } from "@/lib/project-rules"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import type {
  WorkspaceProjectConfigSetting,
  WorkspaceProjectPlugin,
  WorkspaceProjectToolFlag,
} from "@/services/backend/workspaceApi"
import { formatListPlain } from "./input-context"
import {
  isBetterC0deRuntimeTerminalFlag,
  loadProjectBetterC0deConfigForChat,
  writeProjectBetterC0deConfigForChat,
} from "./mcp-commands"
import {
  escapeMarkdownTableCell,
  parseBetterC0deRuntimeList,
  parsePluginToggleBoolean,
  type ActiveThreadRef,
} from "./provider-config"

export function buildProjectConfigOutput(
  settings: ReadonlyArray<WorkspaceProjectConfigSetting>,
  activeThread: ActiveThreadRef
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# BetterC0de Project Config\n\n> No workspace folder is open."
  }
  if (settings.length === 0) {
    return [
      "# BetterC0de Project Config\n",
      "> No BetterC0de project settings found.",
      "",
      "BetterC0de checks its project config files and legacy compatibility locations.",
    ].join("\n")
  }

  return [
    "# BetterC0de Project Config\n",
    `${settings.length} setting${settings.length > 1 ? "s" : ""} loaded from \`${runtimePath}\`\n`,
    "| Setting | Kind | Value | Source |",
    "|:--------|:-----|:------|:-------|",
    ...settings.map(
      (setting) =>
        `| **${escapeMarkdownTableCell(setting.label)}** (\`${escapeMarkdownTableCell(setting.key)}\`) | ${setting.kind} | ${escapeMarkdownTableCell(setting.value)} | \`${escapeMarkdownTableCell(setting.sourcePath)}\` |`
    ),
    "",
    "> Detailed config groups are also available with `/commands`, `/agents`, `/skills`, `/mcps`, `/references`, `/formatters`, `/lsp`, `/permissions`, `/tui`, `/keybinds`, `/attachments`, `/tool-output`, `/compaction`, and `/instructions`.",
  ].join("\n")
}

export function buildBetterC0deDebugConfigOutput(
  settings: ReadonlyArray<WorkspaceProjectConfigSetting>,
  activeThread: ActiveThreadRef,
  args: ReadonlyArray<string> = []
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# BetterC0de Debug Config\n\n> Open a workspace folder before viewing debug config."
  }

  const projectSettings = settings.filter(
    (setting) => !isBetterC0deTuiSetting(setting)
  )
  if (projectSettings.length === 0) {
    return [
      "# BetterC0de Debug Config\n",
      "Compatibility reference: `betterc0de debug config`.\n",
      "> No BetterC0de project settings found.",
      "",
      terminalHintForBetterC0deDebugConfig(args),
    ].join("\n")
  }

  const config = configObjectFromProjectSettings(projectSettings)
  const sourceFiles = Array.from(
    new Set(
      projectSettings
        .map((setting) => setting.sourcePath.split("#")[0])
        .filter(Boolean)
    )
  )

  return [
    "# BetterC0de Debug Config\n",
    "Compatibility reference: `betterc0de debug config`.\n",
    `Project config preview from \`${runtimePath}\`.`,
    sourceFiles.length
      ? `Sources: ${sourceFiles.map((source) => `\`${source}\``).join(", ")}.`
      : "",
    "",
    "```json",
    JSON.stringify(config, null, 2),
    "```",
    "",
    terminalHintForBetterC0deDebugConfig(args),
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function terminalHintForBetterC0deDebugConfig(
  args: ReadonlyArray<string>
): string {
  return args.some(isBetterC0deRuntimeTerminalFlag)
    ? "> Opened the integrated terminal with `betterc0de debug config` for fully resolved external compatibility output."
    : "> This BetterC0de preview is reconstructed from project config files. Add `--terminal` only if you intentionally need byte-for-byte external CLI output, including global, remote, and runtime-resolved config."
}

function isBetterC0deTuiSetting(
  setting: WorkspaceProjectConfigSetting
): boolean {
  const source = setting.sourcePath.split("#")[0] ?? ""
  return /(?:^|\/)tui\.jsonc?$/iu.test(source)
}

function configObjectFromProjectSettings(
  settings: ReadonlyArray<WorkspaceProjectConfigSetting>
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  const ordered = [...settings].sort(
    (left, right) => configKeyDepth(left.key) - configKeyDepth(right.key)
  )
  for (const setting of ordered) {
    assignConfigSettingValue(output, setting)
  }
  return output
}

function configKeyDepth(key: string): number {
  return key.split(".").filter(Boolean).length
}

function assignConfigSettingValue(
  output: Record<string, unknown>,
  setting: WorkspaceProjectConfigSetting
): void {
  const path = setting.key.split(".").filter(Boolean)
  if (path.length === 0) return
  const value = jsonValueFromConfigSetting(setting)

  let target: Record<string, unknown> = output
  for (const segment of path.slice(0, -1)) {
    const current = target[segment]
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      target[segment] = {}
    }
    target = target[segment] as Record<string, unknown>
  }

  const leaf = path[path.length - 1]
  if (!leaf) return
  if (
    setting.kind === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    target[leaf] = {
      ...((target[leaf] &&
      typeof target[leaf] === "object" &&
      !Array.isArray(target[leaf])
        ? target[leaf]
        : {}) as Record<string, unknown>),
      ...(value as Record<string, unknown>),
    }
    return
  }
  target[leaf] = value
}

function jsonValueFromConfigSetting(
  setting: WorkspaceProjectConfigSetting
): unknown {
  if (setting.kind === "toggle") return setting.value === "enabled"
  if (setting.kind === "list") {
    if (setting.value === "(empty)") return []
    return setting.value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (setting.kind === "object") return {}
  return scalarJsonValueFromConfigSetting(setting.value)
}

function scalarJsonValueFromConfigSetting(value: string): unknown {
  if (value === "true") return true
  if (value === "false") return false
  if (/^-?(?:0|[1-9]\d*)$/u.test(value)) return Number(value)
  if (/^-?(?:0|[1-9]\d*)\.\d+$/u.test(value)) return Number(value)
  return value
}

export function buildProjectTuiConfigOutput(
  settings: ReadonlyArray<WorkspaceProjectConfigSetting>,
  activeThread: ActiveThreadRef
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# BetterC0de Terminal UI Config\n\n> No workspace folder is open."
  }
  const tuiSettings = settings.filter((setting) =>
    isBetterC0deTuiConfigKey(setting.key)
  )
  if (tuiSettings.length === 0) {
    return [
      "# BetterC0de Terminal UI Config\n",
      "> No BetterC0de terminal UI compatibility settings found.",
      "",
      "BetterC0de checks terminal UI config files and legacy compatibility locations.",
    ].join("\n")
  }

  return [
    "# BetterC0de Terminal UI Config\n",
    `${tuiSettings.length} setting${tuiSettings.length > 1 ? "s" : ""} loaded from \`${runtimePath}\`.\n`,
    "| Setting | Kind | Value | Source |",
    "|:--------|:-----|:------|:-------|",
    ...tuiSettings.map(
      (setting) =>
        `| **${escapeMarkdownTableCell(setting.label)}** (\`${escapeMarkdownTableCell(setting.key)}\`) | ${setting.kind} | ${escapeMarkdownTableCell(setting.value)} | \`${escapeMarkdownTableCell(setting.sourcePath)}\` |`
    ),
    "",
    "> These are BetterC0de terminal UI compatibility settings. App UI behavior remains controlled by BetterC0de settings unless a feature explicitly maps the option.",
    "",
    "> Write safe BetterC0de terminal UI settings with `/tui --config-only --theme <name> --mouse true --diff-style auto|stacked`, or keybinds with `/keybinds --config-only --bind session_export=<leader>x`.",
  ].join("\n")
}

export function buildProjectKeybindsOutput(
  settings: ReadonlyArray<WorkspaceProjectConfigSetting>,
  activeThread: ActiveThreadRef
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# BetterC0de Keybinds\n\n> No workspace folder is open."
  }
  const keybinds = settings.filter((setting) =>
    setting.key.startsWith("keybinds.")
  )
  const out = ["# BetterC0de Keybinds\n"]

  if (keybinds.length === 0) {
    out.push(
      "> No BetterC0de terminal UI keybind overrides found.",
      "",
      "Add a `keybinds` object to `tui.json` / `tui.jsonc` to override BetterC0de command bindings.",
      ""
    )
  } else {
    out.push(
      `${keybinds.length} override${keybinds.length > 1 ? "s" : ""} loaded from \`${runtimePath}\`.\n`,
      "## Project Overrides\n",
      "| Command | Binding | Source |",
      "|:--------|:--------|:-------|",
      ...keybinds.map(
        (setting) =>
          `| \`${escapeMarkdownTableCell(setting.key.replace(/^keybinds\./, ""))}\` | ${escapeMarkdownTableCell(setting.value)} | \`${escapeMarkdownTableCell(setting.sourcePath)}\` |`
      ),
      ""
    )
  }

  out.push(
    "## BetterC0de Default Keybinds\n",
    "| Command | Default | BetterC0de Slash | Description |",
    "|:--------|:--------|:-----------------|:------------|",
    ...BETTERC0DE_KEYBIND_DEFAULTS.map(
      (item) =>
        `| \`${escapeMarkdownTableCell(item.command)}\` | ${escapeMarkdownTableCell(item.binding)} | ${item.slash ? `\`${escapeMarkdownTableCell(item.slash)}\`` : "-"} | ${escapeMarkdownTableCell(item.description)} |`
    ),
    "",
    "## Composer Native Keybinds\n",
    "| Command | Default | BetterC0de Handling | Description |",
    "|:--------|:--------|:--------------------|:------------|",
    ...BETTERC0DE_COMPOSER_KEYBIND_DEFAULTS.map(
      (item) =>
        `| \`${escapeMarkdownTableCell(item.command)}\` | ${escapeMarkdownTableCell(item.binding)} | ${escapeMarkdownTableCell(item.handling ?? "Native textarea")} | ${escapeMarkdownTableCell(item.description)} |`
    ),
    "",
    "> BetterC0de native keyboard shortcuts remain controlled by the app shortcut layer; this reference exposes command names, defaults, slash equivalents, and composer-native handling for compatibility."
  )

  return out.join("\n")
}

function isBetterC0deTuiConfigKey(key: string): boolean {
  return (
    key === "theme" ||
    key === "keybinds" ||
    key.startsWith("keybinds.") ||
    key === "leader_timeout" ||
    key === "attention" ||
    key.startsWith("attention.") ||
    key === "scroll_speed" ||
    key === "scroll_acceleration" ||
    key.startsWith("scroll_acceleration.") ||
    key === "diff_style" ||
    key === "mouse" ||
    key === "plugin_enabled" ||
    key.startsWith("plugin_enabled.")
  )
}

export function buildProjectPluginsOutput(
  plugins: ReadonlyArray<WorkspaceProjectPlugin>,
  activeThread: ActiveThreadRef,
  args: readonly string[] = []
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# BetterC0de Project Plugins\n\n> No workspace folder is open."
  }
  const selected = resolveProjectPluginReference(plugins, args.join(" "))
  if (selected) {
    return buildProjectPluginDetailOutput(selected, runtimePath)
  }
  if (plugins.length === 0) {
    return [
      "# BetterC0de Project Plugins\n",
      "> No BetterC0de compatibility project plugins found.",
      "",
      "Add `plugin` entries to `betterc0de.json` / `betterc0de.jsonc`, or place `.js` / `.ts` plugin files under `.betterc0de/plugin/` or `.betterc0de/plugins/`.",
    ].join("\n")
  }

  return [
    "# BetterC0de Project Plugins\n",
    `${plugins.length} plugin spec${plugins.length > 1 ? "s" : ""} loaded from \`${runtimePath}\`.\n`,
    "| # | Plugin | Kind | Path | Options | Source | Status | Metadata |",
    "|:--|:-------|:-----|:-----|:--------|:-------|:-------|:---------|",
    ...plugins.map((plugin, index) => {
      const status = plugin.skipped
        ? (plugin.skippedReason ?? "Skipped")
        : plugin.kind === "invalid"
          ? (plugin.message ?? "Invalid")
          : plugin.kind === "file"
            ? plugin.exists === false
              ? "Missing"
              : "Found"
            : "Configured"
      return `| ${index + 1} | \`${escapeMarkdownTableCell(plugin.spec)}\` | ${plugin.kind} | ${escapeMarkdownTableCell(plugin.relativePath ?? "-")} | ${escapeMarkdownTableCell(formatListPlain(plugin.optionsKeys))} | \`${escapeMarkdownTableCell(plugin.sourcePath)}\` | ${escapeMarkdownTableCell(status)} | ${escapeMarkdownTableCell(formatProjectPluginMetadata(plugin))} |`
    }),
    "",
    "Use `/project-plugins <#|spec|path>` for a detailed plugin view.",
    "",
    "> BetterC0de lists project plugins for BetterC0de compatibility, but does not execute arbitrary project plugin code from chat display.",
  ].join("\n")
}

function resolveProjectPluginReference(
  plugins: ReadonlyArray<WorkspaceProjectPlugin>,
  rawReference: string
): WorkspaceProjectPlugin | null {
  const reference = rawReference.trim()
  if (!reference) return null
  const ordinal = Number(reference.replace(/^#/, ""))
  if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= plugins.length) {
    return plugins[ordinal - 1] ?? null
  }
  const normalized = reference.toLowerCase()
  return (
    plugins.find((plugin) =>
      [
        plugin.id,
        plugin.spec,
        plugin.relativePath ?? "",
        plugin.sourcePath,
      ].some((value) => value.toLowerCase() === normalized)
    ) ??
    plugins.find((plugin) =>
      [plugin.id, plugin.spec, plugin.relativePath ?? ""].some((value) =>
        value.toLowerCase().includes(normalized)
      )
    ) ??
    null
  )
}

function buildProjectPluginDetailOutput(
  plugin: WorkspaceProjectPlugin,
  runtimePath: string
): string {
  const status = plugin.skipped
    ? (plugin.skippedReason ?? "Skipped")
    : plugin.kind === "invalid"
      ? (plugin.message ?? "Invalid")
      : plugin.kind === "file"
        ? plugin.exists === false
          ? "Missing"
          : "Found"
        : "Configured"
  return [
    "# BetterC0de Project Plugin\n",
    `Loaded from \`${runtimePath}\`.\n`,
    "| Field | Value |",
    "|:------|:------|",
    `| Spec | \`${escapeMarkdownTableCell(plugin.spec)}\` |`,
    `| Kind | ${plugin.kind} |`,
    `| Status | ${escapeMarkdownTableCell(status)} |`,
    `| Source | \`${escapeMarkdownTableCell(plugin.sourcePath)}\` |`,
    `| Relative path | ${escapeMarkdownTableCell(plugin.relativePath ?? "-")} |`,
    `| Absolute path | ${plugin.path ? `\`${escapeMarkdownTableCell(plugin.path)}\`` : "-"} |`,
    `| Options | ${escapeMarkdownTableCell(formatListPlain(plugin.optionsKeys))} |`,
    `| Metadata source | ${plugin.metaSourcePath ? `\`${escapeMarkdownTableCell(plugin.metaSourcePath)}\`` : "-"} |`,
    `| Metadata | ${escapeMarkdownTableCell(formatProjectPluginMetadata(plugin))} |`,
    "",
    plugin.kind === "file" && plugin.relativePath
      ? `Open local plugin source with \`/open ${plugin.relativePath}\`.`
      : "> Remote/npm plugin source is listed for visibility only.",
    "",
    "> BetterC0de does not execute arbitrary project plugin code from this display.",
  ].join("\n")
}

function formatProjectPluginMetadata(plugin: WorkspaceProjectPlugin): string {
  const parts = [
    plugin.metaSource ? `source ${plugin.metaSource}` : "",
    plugin.metaTarget ? `target ${plugin.metaTarget}` : "",
    plugin.metaRequested ? `requested ${plugin.metaRequested}` : "",
    plugin.metaVersion ? `version ${plugin.metaVersion}` : "",
    plugin.metaLoadCount ? `loaded ${plugin.metaLoadCount}x` : "",
    plugin.metaThemes && plugin.metaThemes.length > 0
      ? `themes ${plugin.metaThemes.join(", ")}`
      : "",
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : "-"
}

export function buildProjectToolsOutput(
  tools: ReadonlyArray<WorkspaceProjectToolFlag>,
  activeThread: ActiveThreadRef,
  activePermissionLevel: string
): string {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# BetterC0de Project Tools\n\n> No workspace folder is open."
  }
  if (tools.length === 0) {
    return [
      "# BetterC0de Project Tools\n",
      "> No BetterC0de `tools` config or custom tool modules found.",
      "",
      `Active BetterC0de permission preset: \`${activePermissionLevel}\`.`,
    ].join("\n")
  }

  return [
    "# BetterC0de Project Tools\n",
    `${tools.length} project tool entr${tools.length === 1 ? "y" : "ies"} configured in \`${runtimePath}\`.\n`,
    `Active BetterC0de permission preset: \`${activePermissionLevel}\`.\n`,
    "| Tool | Type | State | Source |",
    "|:-----|:-----|:------|:-------|",
    ...tools.map(
      (tool) =>
        `| \`${escapeMarkdownTableCell(tool.tool)}\` | ${tool.kind === "custom" ? "Custom module" : "Legacy flag"} | ${formatProjectToolState(tool)} | \`${escapeMarkdownTableCell(tool.sourcePath)}\` |`
    ),
    "",
    "> BetterC0de `tools` is legacy config and custom modules come from `.betterc0de/tool(s)`. BetterC0de displays both for parity; runtime access is still governed by the active BetterC0de permission preset and provider tool policy.",
  ].join("\n")
}

export function formatProjectToolState(tool: WorkspaceProjectToolFlag): string {
  if (tool.kind === "custom") {
    return tool.exportName ? `custom export \`${tool.exportName}\`` : "custom"
  }
  return tool.enabled ? "Enabled" : "Disabled"
}

export async function buildProjectToolsConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# BetterC0de Project Tools\n\n> Open a workspace folder before using `--config-only`."
  }

  const request = parseProjectToolsConfigArgs(args)
  if (request.entries.length === 0 && request.remove.length === 0) {
    return [
      "# BetterC0de Project Tools",
      "",
      "> Usage: `/project-tools --config-only --tool bash --enabled false`",
      "> Shortcut: `/project-tools --config-only --enable read,grep --disable bash`",
      "> Remove usage: `/project-tools --config-only --remove bash`",
    ].join("\n")
  }

  const loaded = await loadProjectBetterC0deConfigForChat(
    runtimePath,
    "BetterC0de Project Tools"
  )
  if ("output" in loaded) return loaded.output
  const tools =
    loaded.config.tools &&
    typeof loaded.config.tools === "object" &&
    !Array.isArray(loaded.config.tools)
      ? { ...(loaded.config.tools as Record<string, unknown>) }
      : {}
  for (const tool of request.remove) delete tools[tool]
  for (const entry of request.entries) tools[entry.tool] = entry.enabled
  loaded.config.tools = tools

  return writeProjectBetterC0deConfigForChat({
    runtimePath,
    config: loaded.config,
    configPath: loaded.configPath,
    existed: loaded.existed,
    heading: "BetterC0de Project Tools",
    settings: [
      ...request.entries.map((entry) => `tools.${entry.tool}`),
      ...request.remove.map((tool) => `tools.${tool}`),
    ],
  })
}

interface ProjectToolsConfigRequest {
  entries: Array<{ tool: string; enabled: boolean }>
  remove: string[]
}

function parseProjectToolsConfigArgs(
  args: ReadonlyArray<string>
): ProjectToolsConfigRequest {
  const request: ProjectToolsConfigRequest = { entries: [], remove: [] }
  let pendingTool: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue
      index += 1
      return args[index] ?? ""
    }
    const pushTools = (raw: string, enabled: boolean) => {
      for (const tool of parseProjectToolNames(raw)) {
        request.entries.push({ tool, enabled })
      }
    }
    switch (key) {
      case "--config-only":
        break
      case "--tool":
        pendingTool = nextValue().trim()
        break
      case "--enabled":
      case "--state": {
        const enabled = parsePluginToggleBoolean(nextValue())
        if (pendingTool && enabled !== undefined) {
          pushTools(pendingTool, enabled)
          pendingTool = undefined
        }
        break
      }
      case "--enable":
        pushTools(nextValue(), true)
        break
      case "--disable":
        pushTools(nextValue(), false)
        break
      case "--remove":
      case "--delete":
        request.remove.push(...parseProjectToolNames(nextValue()))
        break
      default:
        break
    }
  }
  request.remove = Array.from(new Set(request.remove))
  const byTool = new Map<string, boolean>()
  for (const entry of request.entries) byTool.set(entry.tool, entry.enabled)
  request.entries = Array.from(byTool, ([tool, enabled]) => ({
    tool,
    enabled,
  }))
  return request
}

function parseProjectToolNames(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(entry))
}

export async function buildProjectInstructionsOutput(
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Project Instructions\n\n> No workspace folder is open."
  }

  const rules = await getProjectRules(runtimePath)
  if (!rules?.trim()) {
    return [
      "# Project Instructions\n",
      "> No project instruction files found.",
      "",
      "BetterC0de checks `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, `.cursorrules`, `.github/copilot-instructions.md`, and BetterC0de `betterc0de.json(c).instructions`.",
    ].join("\n")
  }

  return [
    "# Project Instructions\n",
    `Loaded from \`${runtimePath}\` and injected into the chat system prompt.`,
    "",
    "---",
    "",
    rules,
  ].join("\n")
}

export async function buildProjectInstructionsConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Project Instructions\n\n> Open a workspace folder before using `--config-only`."
  }

  const request = parseProjectInstructionsConfigArgs(args)
  if (request.add.length === 0 && request.remove.length === 0) {
    return [
      "# Project Instructions",
      "",
      "> Usage: `/instructions --config-only --add AGENTS.md --add .cursor/rules/*.md`",
      "> Remove usage: `/instructions --config-only --remove AGENTS.md`",
    ].join("\n")
  }

  const loaded = await loadProjectBetterC0deConfigForChat(
    runtimePath,
    "Project Instructions"
  )
  if ("output" in loaded) return loaded.output
  const current = Array.isArray(loaded.config.instructions)
    ? loaded.config.instructions.filter(
        (item): item is string => typeof item === "string"
      )
    : []
  const remove = new Set(request.remove)
  loaded.config.instructions = Array.from(
    new Set([...current.filter((item) => !remove.has(item)), ...request.add])
  )

  return writeProjectBetterC0deConfigForChat({
    runtimePath,
    config: loaded.config,
    configPath: loaded.configPath,
    existed: loaded.existed,
    heading: "Project Instructions",
    settings: ["instructions"],
  })
}

export async function buildProjectSkillsConfigOutput(
  args: ReadonlyArray<string>,
  activeThread: ActiveThreadRef
): Promise<string> {
  const runtimePath = resolveThreadRuntimePath(activeThread)
  if (!runtimePath) {
    return "# Skills\n\n> Open a workspace folder before using `--config-only`."
  }

  const request = parseProjectSkillsConfigArgs(args)
  if (
    request.paths.length === 0 &&
    request.urls.length === 0 &&
    request.removePaths.length === 0 &&
    request.removeUrls.length === 0
  ) {
    return [
      "# Skills",
      "",
      "> Usage: `/skills --config-only --path ./.betterc0de/skills --url https://example.com/.well-known/skills/`",
      "> Remove usage: `/skills --config-only --remove-path ./.betterc0de/skills --remove-url https://example.com/.well-known/skills/`",
    ].join("\n")
  }

  const loaded = await loadProjectBetterC0deConfigForChat(runtimePath, "Skills")
  if ("output" in loaded) return loaded.output
  const current =
    loaded.config.skills &&
    typeof loaded.config.skills === "object" &&
    !Array.isArray(loaded.config.skills)
      ? (loaded.config.skills as Record<string, unknown>)
      : {}
  const paths = mergeStringListConfig(
    current.paths,
    request.paths,
    request.removePaths
  )
  const urls = mergeStringListConfig(
    current.urls,
    request.urls,
    request.removeUrls
  )
  loaded.config.skills = {
    ...current,
    ...(paths.length > 0 ? { paths } : {}),
    ...(urls.length > 0 ? { urls } : {}),
  }

  return writeProjectBetterC0deConfigForChat({
    runtimePath,
    config: loaded.config,
    configPath: loaded.configPath,
    existed: loaded.existed,
    heading: "Skills",
    settings: ["skills"],
  })
}

interface ProjectInstructionsConfigRequest {
  add: string[]
  remove: string[]
}

function parseProjectInstructionsConfigArgs(
  args: ReadonlyArray<string>
): ProjectInstructionsConfigRequest {
  const request: ProjectInstructionsConfigRequest = { add: [], remove: [] }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue
      index += 1
      return args[index] ?? ""
    }
    switch (key) {
      case "--config-only":
        break
      case "--add":
      case "--instruction":
      case "--file":
        request.add.push(...parseBetterC0deRuntimeList(nextValue()))
        break
      case "--remove":
      case "--delete":
        request.remove.push(...parseBetterC0deRuntimeList(nextValue()))
        break
      default:
        break
    }
  }
  request.add = Array.from(new Set(request.add))
  request.remove = Array.from(new Set(request.remove))
  return request
}

interface ProjectSkillsConfigRequest {
  paths: string[]
  urls: string[]
  removePaths: string[]
  removeUrls: string[]
}

function parseProjectSkillsConfigArgs(
  args: ReadonlyArray<string>
): ProjectSkillsConfigRequest {
  const request: ProjectSkillsConfigRequest = {
    paths: [],
    urls: [],
    removePaths: [],
    removeUrls: [],
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    const key = inline?.[1] ? `--${inline[1]}` : arg
    const inlineValue = inline?.[2]
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue
      index += 1
      return args[index] ?? ""
    }
    switch (key) {
      case "--config-only":
        break
      case "--path":
      case "--skill-path":
        request.paths.push(...parseBetterC0deRuntimeList(nextValue()))
        break
      case "--url":
      case "--skill-url":
        request.urls.push(...parseBetterC0deRuntimeList(nextValue()))
        break
      case "--remove-path":
        request.removePaths.push(...parseBetterC0deRuntimeList(nextValue()))
        break
      case "--remove-url":
        request.removeUrls.push(...parseBetterC0deRuntimeList(nextValue()))
        break
      default:
        break
    }
  }
  request.paths = Array.from(new Set(request.paths))
  request.urls = Array.from(new Set(request.urls))
  request.removePaths = Array.from(new Set(request.removePaths))
  request.removeUrls = Array.from(new Set(request.removeUrls))
  return request
}

function mergeStringListConfig(
  current: unknown,
  add: ReadonlyArray<string>,
  remove: ReadonlyArray<string>
): string[] {
  const removeSet = new Set(remove)
  const existing = Array.isArray(current)
    ? current.filter((item): item is string => typeof item === "string")
    : []
  return Array.from(
    new Set([...existing.filter((item) => !removeSet.has(item)), ...add])
  )
}
