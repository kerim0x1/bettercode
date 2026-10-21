import {
  BookOpen01Icon,
  CpuIcon,
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

/**
 * Static configuration for the Settings modal's left-rail tabs.
 *
 * Each entry drives both the `<TabsTrigger>` row in the nav and the inner
 * render switch in `<SettingsModal>`. Tab `id` values are referenced by
 * {@link SettingsModal}'s `defaultTab` prop — keep them in sync.
 */
export const settingsTabs = [
  {
    id: "general",
    label: "General",
    icon: Settings01Icon,
    description: "App preferences, theme, and language",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: PaintBoardIcon,
    description: "Colors, typography, border radius, and style",
  },
  {
    id: "models",
    label: "Providers",
    icon: CpuIcon,
    description: "API keys, provider settings, and model visibility",
  },
  {
    id: "plugins",
    label: "Plugins",
    icon: PuzzleIcon,
    description: "Manage installed plugins",
  },
  {
    id: "rules",
    label: "Rules",
    icon: RulerIcon,
    description: "Custom rules and instructions",
  },
  {
    id: "skills",
    label: "Skills & Subagents",
    icon: MagicWand01Icon,
    description: "Manage skills and sub-agent configs",
  },
  {
    id: "tools",
    label: "Tools & MCP",
    icon: Wrench01Icon,
    description: "Tool integrations and MCP servers",
  },
  {
    id: "hooks",
    label: "Hooks",
    icon: LinkIcon,
    description: "App event hooks (shell commands run by BetterC0de)",
  },
  {
    id: "remote",
    label: "Remote Access",
    icon: WifiSyncIcon,
    description: "Pair trusted phones and browsers with this BetterC0de host",
  },
  {
    id: "permissions",
    label: "Permissions",
    icon: ShieldKeyIcon,
    description: "Always-allow rules from approval decisions",
  },
  {
    id: "betterc0de",
    label: "Compatibility",
    icon: PuzzleIcon,
    description:
      "BetterC0de config, commands, permissions, and provider policy",
  },
  {
    id: "experimental",
    label: "Experimental",
    icon: TestTube01Icon,
    description: "Optional features: orchestrator teams and Jev code search",
  },
  {
    id: "docs",
    label: "Docs",
    icon: BookOpen01Icon,
    description: "Documentation and help",
  },
] as const
