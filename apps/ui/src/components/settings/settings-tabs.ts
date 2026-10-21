import {
  BookOpen01Icon,
  MessageMultiple01Icon,
  CpuIcon,
  FingerPrintIcon,
  LayoutLeftIcon,
  Notification01Icon,
  FileSyncIcon,
  TestTube01Icon,
  LinkIcon,
  MagicWand01Icon,
  PaintBoardIcon,
  PuzzleIcon,
  RulerIcon,
  Settings01Icon,
  ShieldKeyIcon,
  WifiSyncIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons"

/** The Settings rail's groups, in order. */
export const settingsTabGroups = [
  "App",
  "Agents",
  "Access & Privacy",
  "More",
] as const

/**
 * Static configuration for the Settings page's left-rail tabs.
 *
 * Each entry drives both the rail row and the inner render switch in
 * `<SettingsPage>`; `keywords` feed the rail's search. Tab `id` values are
 * referenced by the app UI store's `settingsTab` (shown by `SettingsPage`)
 * — keep them in sync.
 */
export const settingsTabs = [
  {
    id: "general",
    group: "App",
    label: "General",
    icon: Settings01Icon,
    description: "Updates, chat history and reset",
    keywords:
      "updates version autosave save archive archived restore delete confirm reset import conversations claude code codex sessions",
  },
  {
    id: "appearance",
    group: "App",
    label: "Appearance",
    icon: PaintBoardIcon,
    description: "Mode, theme, colors, fonts and motion",
    keywords:
      "theme dark light system mode colors hue font size typography radius animations terminal titles transparency import export reset",
  },
  {
    id: "layout",
    group: "App",
    label: "Layout",
    icon: LayoutLeftIcon,
    description: "Panels and the sidebar width",
    keywords: "panels sidebar right panel files console diff review width",
  },
  {
    id: "chat",
    group: "App",
    label: "Chat",
    icon: MessageMultiple01Icon,
    description:
      "Message text and how answers, reasoning, tools and diffs appear",
    keywords:
      "font size text compact density streaming timestamps thinking reasoning tools shell edits diff wrap scrollbar file context mentions visual replies html charts sending enter queue steer resume usage limit rate limit restart continue",
  },
  {
    id: "notifications",
    group: "App",
    label: "Notifications & Sound",
    icon: Notification01Icon,
    description: "System notifications, toasts, badges and sounds",
    keywords: "notify alerts toasts badges attention sound typing click volume",
  },
  {
    id: "models",
    group: "Agents",
    label: "Providers",
    icon: CpuIcon,
    description: "CLI sign-ins, API keys, and which models appear",
    keywords:
      "models api key cli claude codex openai anthropic grok xai cursor openrouter lm studio login",
  },
  {
    id: "rules",
    group: "Agents",
    label: "Rules",
    icon: RulerIcon,
    description: "Custom rules and instructions",
    keywords: "instructions system prompt agents.md claude.md",
  },
  {
    id: "skills",
    group: "Agents",
    label: "Skills & Subagents",
    icon: MagicWand01Icon,
    description: "Manage skills and sub-agent configs",
    keywords: "agents subagents skill",
  },
  {
    id: "tools",
    group: "Agents",
    label: "Tools & MCP",
    icon: Wrench01Icon,
    description: "Tool integrations and MCP servers",
    keywords: "mcp servers tools integrations",
  },
  {
    id: "plugins",
    group: "Agents",
    label: "Plugins",
    icon: PuzzleIcon,
    description: "Manage installed plugins",
    keywords: "extensions marketplace",
  },
  {
    id: "permissions",
    group: "Access & Privacy",
    label: "Permissions",
    icon: ShieldKeyIcon,
    description: "Project trust, your rules and saved approvals",
    keywords: "approvals allow deny trust workspace",
  },
  {
    id: "hooks",
    group: "Access & Privacy",
    label: "Hooks",
    icon: LinkIcon,
    description: "Shell commands BetterC0de runs on app events",
    keywords: "events shell commands automation",
  },
  {
    id: "remote",
    group: "Access & Privacy",
    label: "Remote Access",
    icon: WifiSyncIcon,
    description: "Pair trusted phones and browsers with this BetterC0de host",
    keywords: "phone mobile pairing tailscale browser",
  },
  {
    id: "privacy",
    group: "Access & Privacy",
    label: "Privacy & Diagnostics",
    icon: FingerPrintIcon,
    description: "Crash reports, usage ping and backend logs",
    keywords: "privacy crash reports telemetry usage ping logs debug trace",
  },
  {
    id: "betterc0de",
    group: "More",
    label: "Compatibility",
    icon: FileSyncIcon,
    description: "What this project's config files set up (read-only)",
    keywords:
      "betterc0de.json config policy commands agents.md claude.md skills providers",
  },
  {
    id: "experimental",
    group: "More",
    label: "Experimental",
    icon: TestTube01Icon,
    description: "Optional features: orchestrator teams and Jev code search",
    keywords: "orchestrator orchestration code search beta",
  },
  {
    id: "docs",
    group: "More",
    label: "Docs",
    icon: BookOpen01Icon,
    description: "Documentation and help",
    keywords: "help getting started shortcuts keyboard product guide",
  },
] as const

/** Tabs matching a search over label, description and keywords. */
export function matchSettingsTabs(query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...settingsTabs]
  return settingsTabs.filter((tab) => {
    const text = `${tab.label} ${tab.description} ${tab.keywords}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}
