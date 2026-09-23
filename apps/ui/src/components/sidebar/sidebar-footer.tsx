import { useState, type MouseEvent } from "react"
import {
  CheckIcon,
  ChartNoAxesCombinedIcon,
  ChevronDownIcon,
  CodeIcon,
  SettingsIcon as FileSettingsIcon,
  Volume2Icon,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  FlashOffIcon as FlashOffHugeIcon,
  PaintBoardIcon,
  PaintBrush04Icon,
  Robot01Icon,
} from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/lib/chat-store"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import { openAppWindow } from "@/lib/open-app-window"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  SimpleDropdown,
  SimpleDropdownItem,
  SimpleDropdownLabel,
  SimpleDropdownSeparator,
} from "@/components/ui/simple-dropdown"
import {
  SELECTABLE_THEME_TEMPLATES,
  useAppearanceStore,
} from "@/lib/appearance-store"

/**
 * Persistent bottom row of the left sidebar.
 *
 * Contents (left → right):
 *  - User avatar + name (sourced from the local git config; falls back
 *    to the GitHub avatar URL when the user has a `github.user` config).
 *  - Agent/Editor/Canvas mode switcher. If no workspace is attached, it opens the
 *    shared system browser in editor-open-folder mode.
 *  - Appearance menu: Simple/Extended UI toggle, sound effects toggle,
 *    theme picker, and a link out to full appearance settings.
 *  - Gear button for full settings.
 *
 * Uses `<SimpleDropdown>` for the mode switcher in Simple UI mode and the
 * native `<DropdownMenu>` in Extended mode — matching the rest of the UI
 * chrome.
 */
export function SidebarFooter({
  minimalChat,
  appMode,
  setAppMode,
  gitHubUser,
  gitUserName,
  activeProjectPath,
  setFileTreeOpen,
  setSystemBrowserOpen,
  setSystemBrowserIntent,
  uiSoundEnabled,
  setSettingsTab,
  setSettingsOpen,
}: {
  minimalChat: boolean
  appMode: "agent" | "editor" | "design"
  setAppMode: (mode: "agent" | "editor" | "design") => void
  gitHubUser: string
  gitUserName: string
  activeProjectPath: string | null | undefined
  setFileTreeOpen: (open: boolean) => void
  setSystemBrowserOpen: (open: boolean) => void
  setSystemBrowserIntent: (
    intent: "agent-new-thread" | "editor-open-folder"
  ) => void
  uiSoundEnabled: boolean
  setSettingsTab: (tab: string) => void
  setSettingsOpen: (open: boolean) => void
}) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const canOpenWindow =
    typeof window !== "undefined" && Boolean(window.electronAPI?.windowOpenWith)
  const windowHint = canOpenWindow
    ? "Right-click to open in a new window"
    : undefined
  const activeTemplate = useAppearanceStore((s) => s.template)
  const displayName = gitUserName.trim() || gitHubUser.trim() || "User"
  const nameParts = displayName.split(/\s+/).filter(Boolean)
  const firstInitial = nameParts[0]?.charAt(0) || "U"
  const lastInitial =
    nameParts.length > 1 ? nameParts.at(-1)?.charAt(0) || "" : ""
  const initials = `${firstInitial}${lastInitial}`.toUpperCase()

  const modeLabel =
    appMode === "agent"
      ? "Agent Mode"
      : appMode === "design"
        ? "Canvas Mode"
        : "Editor Mode"
  const modeIcon =
    appMode === "editor" ? (
      <CodeIcon className="size-3.5" />
    ) : (
      <HugeiconsIcon
        icon={appMode === "design" ? PaintBoardIcon : Robot01Icon}
        strokeWidth={2}
        className="size-3.5"
      />
    )

  const openEditorMode = () => {
    if (
      activeProjectPath ||
      useChatStore
        .getState()
        .threads.some((thread) => resolveThreadRuntimePath(thread))
    ) {
      setAppMode("editor")
      setFileTreeOpen(true)
      return
    }
    setAppMode("editor")
    setFileTreeOpen(true)
    setSystemBrowserIntent("editor-open-folder")
    setSystemBrowserOpen(true)
  }

  const openDesignMode = () => {
    setAppMode("design")
  }

  const openModeWindow = (
    event: MouseEvent,
    mode: "agent" | "editor" | "design"
  ) => {
    if (!window.electronAPI?.windowOpenWith) return
    event.preventDefault()
    event.stopPropagation()
    setModeMenuOpen(false)
    void openAppWindow(mode, activeProjectPath)
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5 px-2 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Avatar size="sm">
          {gitHubUser ? (
            <AvatarImage
              src={`https://github.com/${gitHubUser}.png?size=56`}
              alt={`${displayName} avatar`}
            />
          ) : null}
          <AvatarFallback className="bg-gradient-to-br from-primary/60 to-primary/20 text-[10px] font-bold text-primary-foreground">
            {initials}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium text-sidebar-foreground">
            {displayName}
          </p>
        </div>
      </div>

      {/* The same mode switcher stays available on every surface. */}
      {minimalChat ? (
        <SimpleDropdown
          open={modeMenuOpen}
          onOpenChange={setModeMenuOpen}
          align="end"
          side="top"
          className="min-w-[140px]"
          trigger={
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={modeLabel}
                  className="flex shrink-0 items-center gap-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                >
                  {modeIcon}
                  <ChevronDownIcon className="size-3 text-muted-foreground/60" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{modeLabel}</TooltipContent>
            </Tooltip>
          }
        >
          <SimpleDropdownItem
            onClick={() => setAppMode("agent")}
            onContextMenu={(event) => openModeWindow(event, "agent")}
            tooltip={windowHint}
          >
            <HugeiconsIcon
              icon={Robot01Icon}
              strokeWidth={2}
              className="size-4"
            />
            <span className="flex-1">Agent</span>
            {appMode === "agent" && (
              <CheckIcon className="size-3.5 text-primary" />
            )}
          </SimpleDropdownItem>
          <SimpleDropdownItem
            onClick={openEditorMode}
            onContextMenu={(event) => openModeWindow(event, "editor")}
            tooltip={windowHint}
          >
            <CodeIcon className="size-3.5" />
            <span className="flex-1">Editor</span>
            {appMode === "editor" && (
              <CheckIcon className="size-3.5 text-primary" />
            )}
          </SimpleDropdownItem>
          <SimpleDropdownItem
            onClick={openDesignMode}
            onContextMenu={(event) => openModeWindow(event, "design")}
            tooltip={windowHint}
          >
            <HugeiconsIcon
              icon={PaintBoardIcon}
              strokeWidth={2}
              className="size-4"
            />
            <span className="flex-1">Canvas</span>
            {appMode === "design" && (
              <CheckIcon className="size-3.5 text-primary" />
            )}
          </SimpleDropdownItem>
        </SimpleDropdown>
      ) : (
        <DropdownMenu open={modeMenuOpen} onOpenChange={setModeMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={modeLabel}
              title={modeLabel}
              className="flex shrink-0 items-center gap-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              {modeIcon}
              <ChevronDownIcon className="size-3 text-muted-foreground/60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="min-w-[140px]">
            <DropdownMenuItem
              onClick={() => setAppMode("agent")}
              onContextMenu={(event) => openModeWindow(event, "agent")}
              title={windowHint}
              className={cn(appMode === "agent" && "bg-accent")}
            >
              <HugeiconsIcon
                icon={Robot01Icon}
                strokeWidth={2}
                className="size-4"
              />
              Agent
              {appMode === "agent" && (
                <CheckIcon className="ml-auto size-3.5" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={openEditorMode}
              onContextMenu={(event) => openModeWindow(event, "editor")}
              title={windowHint}
              className={cn(appMode === "editor" && "bg-accent")}
            >
              <CodeIcon className="size-3.5" />
              Editor
              {appMode === "editor" && (
                <CheckIcon className="ml-auto size-3.5" />
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={openDesignMode}
              onContextMenu={(event) => openModeWindow(event, "design")}
              title={windowHint}
              className={cn(appMode === "design" && "bg-accent")}
            >
              <HugeiconsIcon
                icon={PaintBoardIcon}
                strokeWidth={2}
                className="size-4"
              />
              Canvas
              {appMode === "design" && (
                <CheckIcon className="ml-auto size-3.5" />
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Appearance */}
      <SimpleDropdown
        align="end"
        side="top"
        className="min-w-[180px] p-1.5"
        trigger={
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Appearance"
                className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                <HugeiconsIcon
                  icon={PaintBrush04Icon}
                  strokeWidth={2}
                  className="size-3.5"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Appearance</TooltipContent>
          </Tooltip>
        }
      >
        {/* Simple Mode toggle is locked ON while Extended UI mode is
            temporarily disabled. The row stays visible (so the user knows
            the feature exists + they're already on the right setting) but
            the Switch + click handler are inert. */}
        <div
          className="flex items-center justify-between gap-3 px-2 py-1.5 opacity-60"
          style={{ borderRadius: "var(--radius)" }}
          title="Extended UI mode is temporarily disabled"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <HugeiconsIcon
              icon={FlashOffHugeIcon}
              strokeWidth={1.5}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate text-xs">Simple Mode</span>
          </div>
          <Switch size="sm" checked disabled />
        </div>
        <div
          className="flex items-center justify-between gap-3 px-2 py-1.5"
          onClick={(e) => {
            e.stopPropagation()
            useAppearanceStore.getState().set("uiSoundEnabled", !uiSoundEnabled)
          }}
          style={{ borderRadius: "var(--radius)" }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Volume2Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-xs">Sound Effects</span>
          </div>
          <Switch
            size="sm"
            checked={uiSoundEnabled}
            onCheckedChange={(v) =>
              useAppearanceStore.getState().set("uiSoundEnabled", v)
            }
          />
        </div>
        <SimpleDropdownSeparator />
        <SimpleDropdownLabel>Theme</SimpleDropdownLabel>
        {SELECTABLE_THEME_TEMPLATES.map((tmpl) => {
          const isActive = activeTemplate === tmpl.id
          return (
            <SimpleDropdownItem
              key={tmpl.id}
              onClick={() =>
                useAppearanceStore.getState().applyTemplate(tmpl.id)
              }
              active={isActive}
              className="my-0.5 gap-2.5 px-2 py-1.5"
            >
              <div
                className="flex h-5 w-9 shrink-0 items-center overflow-hidden border border-border/40 ring-1 ring-foreground/5 ring-inset"
                style={{
                  background: tmpl.preview.bg,
                  borderRadius: "var(--radius-sm)",
                }}
              >
                <div
                  className="h-full w-[32%] shrink-0"
                  style={{ background: tmpl.preview.sidebar }}
                />
                <div
                  className="ml-1 h-1 w-2 rounded-full"
                  style={{ background: tmpl.preview.accent }}
                />
              </div>
              <span className={cn("flex-1 text-xs", isActive && "font-medium")}>
                {tmpl.name}
              </span>
              {isActive && (
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
              )}
            </SimpleDropdownItem>
          )
        })}
        <SimpleDropdownSeparator />
        <SimpleDropdownItem
          onClick={() => {
            setSettingsTab("appearance")
            setSettingsOpen(true)
          }}
          className="gap-2.5 px-2 py-1.5"
        >
          <HugeiconsIcon
            icon={PaintBoardIcon}
            strokeWidth={1.5}
            className="size-3.5 text-muted-foreground"
          />
          <span className="flex-1 text-xs">Customize</span>
        </SimpleDropdownItem>
      </SimpleDropdown>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Usage"
            className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("betterc0de:open-usage"))
            }
          >
            <ChartNoAxesCombinedIcon className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Usage</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Settings"
            className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={() => setSettingsOpen(true)}
          >
            <FileSettingsIcon className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Settings</TooltipContent>
      </Tooltip>
    </div>
  )
}
