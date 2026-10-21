import React from "react"
import {
  CopyIcon,
  FileIcon as LucideFileIcon,
  FileTextIcon,
  GlobeIcon,
  LayersIcon,
  PanelLeftIcon,
  PencilIcon,
  RefreshCwIcon,
  SquarePenIcon,
  MonitorIcon,
  TerminalIcon,
  UndoIcon,
  XIcon,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  BookOpen01Icon,
  BotIcon,
  Bug01Icon,
  CodeIcon as CodeHugeIcon,
  FolderOpenIcon,
  LayoutAlignLeftIcon,
  PaintBoardIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SimpleDropdown,
  SimpleDropdownItem,
  SimpleDropdownSeparator,
} from "@/components/ui/simple-dropdown"
import { useChatStore } from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { resolveNewThreadContext } from "@/lib/thread-context"
import { openAppWindow } from "@/lib/open-app-window"
import { pickFolder } from "@/services/backend"
import {
  isMacTitlebarPlatform,
  shouldRenderCustomWindowControls,
} from "@/components/layout/titlebar-platform"

type ElectronApi = {
  platform?: NodeJS.Platform
  windowMinimize?: () => void
  windowMaximize?: () => void
  windowClose?: () => void
  windowToggleDevTools?: () => void
  windowOpenWith?: NonNullable<Window["electronAPI"]>["windowOpenWith"]
  openExternal?: (url: string) => void
}

type ConsoleLog = {
  type: "log" | "warn" | "error" | "info" | "debug"
  message: string
  timestamp: Date
}

/**
 * Custom titlebar shown when running under a frameless Electron window
 * (packaged builds + dev mode). If `electronApi` is missing we render
 * nothing — the native OS titlebar is used instead.
 *
 * Contains:
 *  - Menu bar (Edit / File / View / Window / Help)
 *  - Center: current project name (read-only)
 *  - Right: DevTools toggle, console error indicator, window controls
 *
 * Menu behavior switches between the Radix `<DropdownMenu>` (extended UI)
 * and our custom `<SimpleDropdown>` (simple UI) based on `chatUiStyle`
 * so the titlebar menus feel consistent with the rest of the UI chrome
 * in each mode.
 */
type ComposerTabLite = {
  id: string
  threadId: string | null
  label: string
}

export function Titlebar({
  activeThreadProjectName,
  consoleLogs,
  consolePanelOpen,
  chatUiStyle,
  appMode,
  setAppMode,
  setConsolePanelOpen,
  setNewProjectOpen,
  setSettingsOpen,
  setSidebarOpen,
  setTerminalOpen,
  setSystemBrowserOpen,
  setSystemBrowserIntent,
  electronApi,
  composerTabs: _composerTabs,
  activeComposerTab: _activeComposerTab,
  setActiveComposerTab: _setActiveComposerTab,
  splitMode: _splitMode,
  enterSplitMode: _enterSplitMode,
  exitSplitMode: _exitSplitMode,
}: {
  activeThreadProjectName: string | undefined
  consoleLogs: ConsoleLog[]
  consolePanelOpen: boolean
  chatUiStyle: string
  appMode: "agent" | "editor" | "design"
  setAppMode: (mode: "agent" | "editor" | "design") => void
  setConsolePanelOpen: (open: boolean) => void
  setNewProjectOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setSidebarOpen: (open: boolean) => void
  setTerminalOpen: (open: boolean) => void
  setSystemBrowserOpen: (open: boolean) => void
  setSystemBrowserIntent: (
    intent: "agent-new-thread" | "editor-open-folder"
  ) => void
  electronApi: ElectronApi | undefined
  composerTabs?: ComposerTabLite[]
  activeComposerTab?: string
  setActiveComposerTab?: (id: string) => void
  splitMode?: boolean
  enterSplitMode?: () => void
  exitSplitMode?: () => void
}) {
  const isFrameless = !!electronApi?.windowMinimize
  if (!isFrameless) return null
  const navigatorPlatform =
    typeof navigator !== "undefined" ? navigator.platform : undefined
  const isMac = isMacTitlebarPlatform(electronApi?.platform, navigatorPlatform)
  const windowOpenWith = electronApi.windowOpenWith
  const showCustomWindowControls = shouldRenderCustomWindowControls({
    electronPlatform: electronApi?.platform,
    navigatorPlatform,
    hasWindowControlIpc: !!electronApi?.windowMinimize,
  })

  const menus: {
    label: string
    icon: React.ReactNode
    items: {
      label: string
      icon?: React.ReactNode
      shortcut?: string
      action?: () => void
    }[]
  }[] = [
    {
      label: "File",
      icon: <LucideFileIcon className="size-3.5" />,
      items: [
        {
          label: "New Thread",
          icon: <SquarePenIcon className="size-3.5" />,
          shortcut: "Ctrl+N",
          action: () => {
            pickFolder().then((folder) => {
              const store = useChatStore.getState()
              const activeThread = store.activeThreadId
                ? store.threads.find(
                    (thread) => thread.id === store.activeThreadId
                  )
                : null
              const context = resolveNewThreadContext({
                selectedPath: folder,
                activeThread,
              })
              store.createThread(
                "New Chat",
                context.projectName,
                context.projectPath,
                context.options
              )
            })
          },
        },
        {
          label: "New Project",
          icon: (
            <HugeiconsIcon
              icon={FolderOpenIcon}
              strokeWidth={2}
              className="size-3.5"
            />
          ),
          shortcut: "Ctrl+Shift+N",
          action: () => setNewProjectOpen(true),
        },
        {
          label: "Open Folder",
          icon: (
            <HugeiconsIcon
              icon={FolderOpenIcon}
              strokeWidth={2}
              className="size-3.5"
            />
          ),
          shortcut: "Ctrl+Shift+O",
          action: () => {
            setSystemBrowserIntent(
              appMode !== "agent" ? "editor-open-folder" : "agent-new-thread"
            )
            setSystemBrowserOpen(true)
          },
        },
        { label: "---" },
        {
          label: "Settings",
          icon: (
            <HugeiconsIcon
              icon={Settings01Icon}
              strokeWidth={2}
              className="size-3.5"
            />
          ),
          shortcut: "Ctrl+,",
          action: () => setSettingsOpen(true),
        },
        { label: "---" },
        {
          label: "Exit",
          icon: <XIcon className="size-3.5" />,
          action: () => electronApi.windowClose?.(),
        },
      ],
    },
    {
      label: "Edit",
      icon: <PencilIcon className="size-3.5" />,
      items: [
        {
          label: "Undo",
          icon: <UndoIcon className="size-3.5" />,
          shortcut: "Ctrl+Z",
          action: () => document.execCommand("undo"),
        },
        {
          label: "Redo",
          icon: <RefreshCwIcon className="size-3.5" />,
          shortcut: "Ctrl+Y",
          action: () => document.execCommand("redo"),
        },
        { label: "---" },
        {
          label: "Cut",
          icon: <CopyIcon className="size-3.5" />,
          shortcut: "Ctrl+X",
          action: () => document.execCommand("cut"),
        },
        {
          label: "Copy",
          icon: <CopyIcon className="size-3.5" />,
          shortcut: "Ctrl+C",
          action: () => document.execCommand("copy"),
        },
        {
          label: "Paste",
          icon: <LucideFileIcon className="size-3.5" />,
          shortcut: "Ctrl+V",
          action: () => document.execCommand("paste"),
        },
      ],
    },
    {
      label: "View",
      icon: <LayersIcon className="size-3.5" />,
      items: [
        {
          label: "Toggle Sidebar",
          icon: <PanelLeftIcon className="size-3.5" />,
          shortcut: "Ctrl+B",
          action: () =>
            setSidebarOpen(!usePreferencesStore.getState().sidebarOpen),
        },
        // Editor mode has no integrated terminal (it's an agent-mode
        // surface), so the entry would be a dead control there.
        ...(appMode === "editor"
          ? []
          : [
              {
                label: "Toggle Terminal",
                icon: <TerminalIcon className="size-3.5" />,
                shortcut: "Ctrl+`",
                action: () =>
                  setTerminalOpen(!usePreferencesStore.getState().terminalOpen),
              },
            ]),
        {
          label: "Toggle DevTools",
          icon: <MonitorIcon className="size-3.5" />,
          shortcut: "F12",
          action: () => electronApi.windowToggleDevTools?.(),
        },
        {
          label: (() => {
            const errCount = consoleLogs.filter(
              (l) => l.type === "error"
            ).length
            const total = consoleLogs.length
            if (total === 0) return "Console Report"
            if (errCount > 0)
              return `Console Report (${total} logs, ${errCount} errors)`
            return `Console Report (${total} logs)`
          })(),
          icon: <FileTextIcon className="size-3.5" />,
          action: () => setConsolePanelOpen(!consolePanelOpen),
        },
        { label: "---" },
        {
          label: "Agent Mode",
          icon: (
            <HugeiconsIcon
              icon={BotIcon}
              strokeWidth={2}
              className="size-3.5"
            />
          ),
          action: () => setAppMode("agent"),
        },
        {
          label: "Editor Mode",
          icon: (
            <HugeiconsIcon
              icon={CodeHugeIcon}
              strokeWidth={2}
              className="size-3.5"
            />
          ),
          action: () => setAppMode("editor"),
        },
        {
          label: "Canvas Mode",
          icon: (
            <HugeiconsIcon
              icon={PaintBoardIcon}
              strokeWidth={2}
              className="size-3.5"
            />
          ),
          action: () => setAppMode("design"),
        },
      ],
    },
    ...(windowOpenWith
      ? [
          {
            label: "Window",
            icon: <MonitorIcon className="size-3.5" />,
            items: (
              [
                {
                  mode: "editor",
                  label: "New Editor Window",
                  icon: CodeHugeIcon,
                },
                {
                  mode: "design",
                  label: "New Canvas Window",
                  icon: PaintBoardIcon,
                },
                { mode: "agent", label: "New Agent Window", icon: BotIcon },
              ] as const
            ).map(({ mode, label, icon }) => ({
              label,
              icon: (
                <HugeiconsIcon
                  icon={icon}
                  strokeWidth={2}
                  className="size-3.5"
                />
              ),
              action: () => {
                void openAppWindow(mode, undefined, { windowOpenWith })
              },
            })),
          },
        ]
      : []),
    {
      label: "Help",
      icon: (
        <HugeiconsIcon
          icon={BookOpen01Icon}
          strokeWidth={2}
          className="size-3.5"
        />
      ),
      items: [
        {
          label: "Documentation",
          icon: (
            <HugeiconsIcon
              icon={BookOpen01Icon}
              strokeWidth={2}
              className="size-3.5"
            />
          ),
          action: () =>
            electronApi.openExternal?.("https://betterc0de.dev/docs"),
        },
        {
          label: "Report Issue",
          icon: (
            <HugeiconsIcon
              icon={Bug01Icon}
              strokeWidth={2}
              className="size-3.5"
            />
          ),
          action: () =>
            electronApi.openExternal?.("https://github.com/betterc0de/issues"),
        },
        { label: "---" },
        {
          label: "About BetterC0de",
          icon: <GlobeIcon className="size-3.5" />,
          // TODO: implement about dialog
          action: () => {
            console.info("About: not implemented yet")
          },
        },
      ],
    },
  ]

  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center bg-sidebar select-none",
        isMac && "pl-20"
      )}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Left: App icon + menus */}
      <div
        className="flex h-full items-center"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <SidebarToggleButton />
        <div className="mx-1 h-5 w-px bg-border" />
        {/* Render order: Edit → File → View → Window → Help. File sits directly to
            the right of Edit per the UI spec. */}
        {(() => {
          const byLabel = Object.fromEntries(menus.map((m) => [m.label, m]))
          return ["Edit", "File", "View", "Window", "Help"]
            .map((label) => byLabel[label])
            .filter(Boolean)
            .map((menu) => renderMenu(menu, chatUiStyle))
        })()}
      </div>

      <div className="flex-1" />

      {/* Center: project title */}
      <span className="max-w-[300px] truncate text-[11px] text-muted-foreground/50">
        {activeThreadProjectName || "BetterC0de"}
      </span>

      <div className="flex-1" />

      {/* Right: Window controls. macOS uses native traffic lights. */}
      <div
        className="flex h-full items-center"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {showCustomWindowControls && (
          <>
            <button
              type="button"
              onClick={() => electronApi.windowMinimize?.()}
              className="flex h-full w-11 items-center justify-center text-muted-foreground/50 transition-colors hover:bg-muted/30 hover:text-foreground"
              aria-label="Minimize window"
            >
              <svg viewBox="0 0 12 12" className="size-3" fill="currentColor">
                <rect x="1" y="5.5" width="10" height="1" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => electronApi.windowMaximize?.()}
              className="flex h-full w-11 items-center justify-center text-muted-foreground/50 transition-colors hover:bg-muted/30 hover:text-foreground"
              aria-label="Maximize window"
            >
              <svg
                viewBox="0 0 12 12"
                className="size-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              >
                <rect x="1.5" y="1.5" width="9" height="9" rx="1" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => electronApi.windowClose?.()}
              className="flex h-full w-12 items-center justify-center text-muted-foreground/50 transition-colors hover:bg-destructive hover:text-white"
              aria-label="Close window"
            >
              <XIcon className="size-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

type MenuDef = {
  label: string
  icon: React.ReactNode
  items: {
    label: string
    icon?: React.ReactNode
    shortcut?: string
    action?: () => void
  }[]
}

/**
 * Render a single titlebar menu in the correct
 * dropdown flavor depending on the user's UI style — SimpleDropdown for
 * the "simple" UI mode, Radix DropdownMenu otherwise. Shared so we can
 * render the File menu on the left and Edit/View/Help on the right
 * without duplicating the item mapping.
 */
function renderMenu(menu: MenuDef, chatUiStyle: string) {
  if (chatUiStyle === "simple") {
    return (
      <SimpleDropdown
        key={menu.label}
        align="start"
        side="bottom"
        className="min-w-[220px]"
        trigger={
          <button
            type="button"
            className="flex h-full items-center justify-center px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
            style={{ height: "40px" }}
          >
            {menu.label}
          </button>
        }
      >
        {menu.items.map((item, i) =>
          item.label === "---" ? (
            <SimpleDropdownSeparator key={i} />
          ) : (
            <SimpleDropdownItem key={item.label} onClick={item.action}>
              {item.icon}
              <span className="flex-1">{item.label}</span>
              {item.shortcut && (
                <span className="ml-4 text-[10px] tracking-wider text-muted-foreground/60">
                  {item.shortcut}
                </span>
              )}
            </SimpleDropdownItem>
          )
        )}
      </SimpleDropdown>
    )
  }
  return (
    <DropdownMenu key={menu.label}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-full items-center justify-center px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
        >
          {menu.label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {menu.items.map((item, i) =>
          item.label === "---" ? (
            <DropdownMenuSeparator key={i} />
          ) : (
            <DropdownMenuItem
              key={item.label}
              onClick={item.action}
              className="gap-2.5"
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
              {item.shortcut && (
                <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SidebarToggleButton() {
  const sidebarOpen = usePreferencesStore((s) => s.sidebarOpen)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() =>
            usePreferencesStore.getState().set("sidebarOpen", !sidebarOpen)
          }
          className="flex h-full items-center justify-center px-3 text-sidebar-foreground transition-colors hover:bg-muted/30"
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={sidebarOpen}
        >
          <HugeiconsIcon
            icon={LayoutAlignLeftIcon}
            strokeWidth={2}
            className="size-4"
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {sidebarOpen ? "Hide" : "Show"} Sidebar (Ctrl+B)
      </TooltipContent>
    </Tooltip>
  )
}
