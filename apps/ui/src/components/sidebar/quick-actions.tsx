import {
  GitPullRequestIcon,
  PackageIcon,
  RefreshCwIcon,
  SquarePenIcon,
} from "lucide-react"
import { openPullRequestsPage } from "@/lib/pull-requests-page"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

/** Compact keyboard-shortcut hint (e.g. `Ctrl + N`) rendered as a row of
 *  monospace `<kbd>` chips. Hidden by default and only revealed on parent
 *  button hover so the resting row stays clean (icon + label only). */
function Shortcut({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-0.5 opacity-0 transition-opacity duration-75 group-hover/qa:opacity-100">
      {keys.map((k) => (
        <kbd
          key={k}
          className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded bg-sidebar-accent/50 px-0.5 font-mono text-[9px] leading-none text-muted-foreground"
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}

/**
 * Quick-action buttons stacked at the top of the left sidebar.
 *
 * Editor mode renders nothing — the ActivityBar carries the icon column
 * + the file tree + git panel take the main space.
 *
 * Agent mode keeps the full labeled row set:
 *  - "Open Folder" (new agent tied to a folder) + "Create project"
 *    (scaffolding wizard) — primary workflow CTAs with shortcut chips.
 *  - Marketplace / Automations / Search — platform entry points that
 *    would be overkill to collapse into icons when the user is in the
 *    chat-first view.
 */
export function SidebarQuickActions({
  appMode,
  minimalChat: _minimalChat,
  onNewAgent,
  onNewProjectStart: _onNewProjectStart,
  onOpenMarketplace,
  onOpenAutomations,
  onOpenSearch: _onOpenSearch,
  onOpenSystemBrowser: _onOpenSystemBrowser,
}: {
  appMode: "agent" | "editor" | "design"
  minimalChat: boolean
  onNewAgent: () => void
  onNewProjectStart: () => void
  onOpenMarketplace: () => void
  onOpenAutomations: () => void
  /** Not rendered in this component any more — Source Control lives in
   *  the ActivityBar (editor mode) and the Git panel in the right
   *  workspace panel (agent mode). Kept in the type for
   *  left-sidebar.tsx's call-site back-compat. */
  onOpenSourceControl?: () => void
  onOpenSearch: () => void
  /** Opens the System Browser overlay — a virtualized cross-platform
   *  file/folder browser that lets the user navigate + search anywhere
   *  on disk before picking a project folder. */
  onOpenSystemBrowser: () => void
}) {
  // Editor mode delegates every entry point to the ActivityBar — no
  // redundant labeled rows here.
  if (appMode !== "agent") return null

  // Codex-desktop-style nav rows: roomier 28px rows, 12px labels, muted
  // icons. Search is NOT here any more — it lives as an icon in the
  // sidebar header (left-sidebar.tsx). `duration-75` overrides the Button
  // primitive's default `transition-all` (~150ms) to feel instantly
  // responsive.
  const btnClass = cn(
    "group/qa h-7 w-full cursor-pointer justify-between !pr-1.5 !pl-2 text-[12px] font-normal",
    "text-sidebar-foreground/90 hover:bg-foreground/10 hover:text-foreground",
    "duration-75"
  )

  return (
    <div className="space-y-0 px-2 pt-1 pb-2">
      <Button
        variant="ghost"
        size="sm"
        className={btnClass}
        onClick={onNewAgent}
      >
        <span className="flex items-center gap-2.5">
          <SquarePenIcon
            className="size-3.5 text-sidebar-foreground/70"
            strokeWidth={1.75}
          />
          New Task
        </span>
        <Shortcut keys={["Ctrl", "N"]} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={btnClass}
        onClick={onOpenAutomations}
      >
        <span className="flex items-center gap-2.5">
          <RefreshCwIcon
            className="size-3.5 text-sidebar-foreground/70"
            strokeWidth={1.75}
          />
          Scheduled
        </span>
        <Shortcut keys={["Ctrl", "⇧", "A"]} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={btnClass}
        onClick={() => openPullRequestsPage()}
      >
        <span className="flex items-center gap-2.5">
          <GitPullRequestIcon
            className="size-3.5 text-sidebar-foreground/70"
            strokeWidth={1.75}
          />
          Pull Requests
        </span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={btnClass}
        onClick={onOpenMarketplace}
      >
        <span className="flex items-center gap-2.5">
          <PackageIcon
            className="size-3.5 text-sidebar-foreground/70"
            strokeWidth={1.75}
          />
          Plugins
        </span>
        <Shortcut keys={["Ctrl", "⇧", "M"]} />
      </Button>
    </div>
  )
}
