import { lazy, memo, Suspense, useState, type CSSProperties } from "react"
import {
  ArchiveIcon,
  ExternalLinkIcon,
  LayoutListIcon,
  ListIcon,
  ListTreeIcon,
  SearchIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { setDiffViewOpen } from "@/lib/diff-view"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Separator } from "@/components/ui/separator"
import { SidebarQuickActions } from "@/components/sidebar/quick-actions"
import { EditorWorkspaceNavigation } from "@/components/sidebar/editor-workspace-navigation"
import {
  EditorModeSidebarContent,
  EditorModeSidebarEmptyState,
} from "@/components/sidebar/editor-mode-sidebar-content"
import { SidebarChatsListHeader } from "@/components/sidebar/chats-list-header"
import { SidebarThreadList } from "@/components/sidebar/thread-list"
import { SidebarTaskList } from "@/components/sidebar/thread-task-list"
import { useAppearanceStore } from "@/lib/appearance-store"
import { useAppUiStore } from "@/lib/app-ui-store"
import { SidebarFooter } from "@/components/sidebar/sidebar-footer"
import { SidebarProviderUpdatePill } from "@/components/sidebar/provider-update-pill"
import type { ConfirmAction } from "@/components/dialogs/confirm-action-dialog"
import { resolveThreadRuntimePath } from "@/lib/thread-context"
import {
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  clampLeftSidebarWidth,
  responsiveSidebarWidth,
  SIDEBAR_REFERENCE_VIEWPORT,
  SIDEBAR_WIDE_BREAKPOINT,
  SIDEBAR_WIDE_SCALE,
} from "@/lib/editor-layout"
import type { EditorSidebarView } from "@/lib/preferences-store"
import type { UiProvider } from "@/lib/provider-types"
import { openAutomationsPage } from "@/lib/automations-page"
import type { AppearanceState } from "@/lib/appearance-store"
import { SnoozeCustomDialog } from "@/components/sidebar/snooze-dialog"
import { useChatListShortcuts } from "@/hooks/use-chat-list-shortcuts"
import {
  openArchivedChats,
  useChatListDialogsStore,
} from "@/lib/chat-list-dialogs"

// Loaded on first open: it renders transcripts with the message renderer.
const ArchivedChatsDialog = lazy(() =>
  import("@/components/sidebar/archived-chats-dialog").then((module) => ({
    default: module.ArchivedChatsDialog,
  }))
)

type ChatSidebarLayout = AppearanceState["chatSidebarLayout"]

/** The Agent chat list's layouts, in the header's Chat list menu. */
const CHAT_LIST_LAYOUTS: {
  id: ChatSidebarLayout
  label: string
  icon: typeof ListIcon
}[] = [
  { id: "folders", label: "Folder list", icon: ListTreeIcon },
  { id: "cards", label: "Task cards", icon: LayoutListIcon },
  { id: "compact", label: "Compact list", icon: ListIcon },
]

/**
 * Left sidebar wrapper — resizable outer frame with the collapsed-toggle
 * button, quick-action row, mode-specific content (file tree + git in
 * editor/canvas mode, thread list in agent mode), and the shared account row.
 *
 * All sub-pieces (quick actions, chats header, thread list, footer,
 * editor-mode content) are already their own components. This wrapper
 * mostly handles layout + the resize handle + passing state through.
 *
 * Collapses without losing the file tree's state.
 */
function LeftSidebarImpl({
  sidebarWidth,
  setSidebarWidth,
  setSidebarOpen: _setSidebarOpen,
  collapsed = false,
  minimalChat,
  chatUiStyle,
  appMode,
  setAppMode,
  activeThread,
  setChatDateFilter,
  editorSidebarView,
  providers,
  gitHubUser,
  gitUserName,
  uiSoundEnabled,
  setNewThreadModalPath,
  setNewThreadModalOpen,
  setNewProjectName,
  setNewProjectPath,
  setNewProjectTemplate,
  setNewProjectUI,
  setNewProjectPM,
  setNewProjectStep,
  setNewProjectStatus,
  setNewProjectLog,
  setNewProjectOpen,
  setMarketplaceOpen,
  setSettingsTab,
  setSettingsOpen,
  setGitModal,
  setChatSearch,
  setConfirmAction,
  setFileTreeOpen,
  setSystemBrowserOpen,
  setSystemBrowserIntent,
  setEditorSidebarView,
}: {
  sidebarWidth: number
  setSidebarWidth: (w: number) => void
  setSidebarOpen: (open: boolean) => void
  minimalChat: boolean
  chatUiStyle: string
  appMode: "agent" | "editor" | "design"
  setAppMode: (mode: "agent" | "editor" | "design") => void
  activeThread: {
    id: string
    title: string
    projectName?: string
    projectPath?: string | null
    worktreePath?: string | null
    envMode?: string | null
    messages?: unknown[]
  } | null
  setChatDateFilter: (filter: "all" | "today" | "week" | "month") => void
  /** Which view renders inside the editor-mode sidebar slot. Toggled by
   *  the Activity Bar's Files / Outline / Source Control / Agents icons. */
  editorSidebarView: EditorSidebarView
  setEditorSidebarView: (view: EditorSidebarView) => void
  providers: UiProvider[]
  gitHubUser: string
  gitUserName: string
  uiSoundEnabled: boolean
  setNewThreadModalPath: (path: string) => void
  setNewThreadModalOpen: (open: boolean) => void
  setNewProjectName: (name: string) => void
  setNewProjectPath: (path: string) => void
  setNewProjectTemplate: (t: string | null) => void
  setNewProjectUI: (u: string | null) => void
  setNewProjectPM: (pm: "npm" | "pnpm" | "bun" | "yarn") => void
  setNewProjectStep: (step: number) => void
  setNewProjectStatus: (status: "idle" | "running" | "done" | "error") => void
  setNewProjectLog: (log: string) => void
  setNewProjectOpen: (open: boolean) => void
  setMarketplaceOpen: (open: boolean) => void
  setSettingsTab: (tab: string) => void
  setSettingsOpen: (open: boolean) => void
  setGitModal: (open: boolean) => void
  setChatSearch: (s: string) => void
  setConfirmAction: (a: ConfirmAction) => void
  setFileTreeOpen: (open: boolean) => void
  setSystemBrowserOpen: (open: boolean) => void
  setSystemBrowserIntent: (
    intent: "agent-new-thread" | "editor-open-folder"
  ) => void
  collapsed?: boolean
}) {
  const workspaceSidebar = appMode !== "agent"
  const editorProjectPath = workspaceSidebar
    ? resolveThreadRuntimePath(activeThread)
    : null

  // Chat-list layout (folders tree, flat task cards, or compact rows). Read
  // straight from the appearance store so the picker lives with the list it
  // controls instead of threading yet another prop through the app-shell
  // bundle. An unknown stored value falls back to the folder list.
  const chatSidebarLayout = useAppearanceStore((s) => s.chatSidebarLayout)
  const currentLayout =
    CHAT_LIST_LAYOUTS.find((layout) => layout.id === chatSidebarLayout) ??
    CHAT_LIST_LAYOUTS[0]
  // Held here: the tooltip on the same button overwrites the menu's
  // data-state, so the open fill cannot key off it.
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false)
  // The search text changes per keystroke in the search dialog; reading it
  // here keeps that typing from re-rendering the app shell.
  const chatSearch = useAppUiStore((s) => s.chatSearch)
  const chatDateFilter = useAppUiStore((s) => s.chatDateFilter)
  const setChatSidebarLayout = useAppearanceStore((s) => s.set)
  // Undo, selection, quick-jump hints and pending deletions of the chat
  // lists; the sidebar is mounted once per window in every mode.
  useChatListShortcuts()
  const archivedChatsOpen = useChatListDialogsStore((s) => s.archivedOpen)
  const openNewThread = () => {
    setNewThreadModalPath("")
    setNewThreadModalOpen(true)
  }

  return (
    <aside
      className={cn(
        // Every mode sits flush on the shell surface, running on from the
        // title bar, at one shared width (`.betterc0de-left-sidebar-width`).
        // The aside itself is never zoomed, so switching modes leaves its
        // width untouched instead of animating between a pre- and a
        // post-zoom value.
        "relative flex shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground",
        "betterc0de-left-sidebar-collapse betterc0de-left-sidebar-width",
        collapsed && "pointer-events-none opacity-0"
      )}
      style={
        {
          // Scales from the 1920px reference width; index.css adds the
          // wide-screen factor.
          "--left-sidebar-width": collapsed
            ? "0px"
            : responsiveSidebarWidth(
                sidebarWidth,
                LEFT_SIDEBAR_MIN_WIDTH,
                LEFT_SIDEBAR_MAX_WIDTH
              ),
        } as CSSProperties
      }
    >
      {/* Resize handle */}
      <div
        className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30"
        onMouseDown={(e) => {
          e.preventDefault()
          const startX = e.clientX
          const startW = sidebarWidth
          // Widths are stored against the 1920px reference. Convert the
          // physical pointer delta back to reference pixels, including the
          // large-screen factor every mode's width carries.
          const contentScale =
            window.innerWidth > SIDEBAR_WIDE_BREAKPOINT ? SIDEBAR_WIDE_SCALE : 1
          const deltaScale =
            SIDEBAR_REFERENCE_VIEWPORT /
            Math.max(1, window.innerWidth) /
            contentScale
          const onMove = (ev: MouseEvent) => {
            const next = startW + (ev.clientX - startX) * deltaScale
            setSidebarWidth(clampLeftSidebarWidth(next))
          }
          const onUp = () => {
            window.removeEventListener("mousemove", onMove)
            window.removeEventListener("mouseup", onUp)
          }
          window.addEventListener("mousemove", onMove)
          window.addEventListener("mouseup", onUp)
        }}
      />

      {/* Agent content scales +15% on viewports wider than 1080px
          (`.betterc0de-left-sidebar-scale`); Editor and Canvas keep their
          file tree at its size. The zoomed column fills the aside exactly. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          !workspaceSidebar && "betterc0de-left-sidebar-scale"
        )}
      >
        {appMode === "agent" && (
          <>
            {/* ── Codex-style header: app name + search icon ── */}
            <div className="flex items-center justify-between pt-2.5 pr-2 pb-0.5 pl-4">
              <span className="text-[13px] font-semibold tracking-tight text-sidebar-foreground">
                BetterC0de
              </span>
              <div className="flex items-center gap-0.5">
                <DropdownMenu
                  open={layoutMenuOpen}
                  onOpenChange={setLayoutMenuOpen}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Chat list: ${currentLayout.label}`}
                          className={cn(
                            "size-6 cursor-pointer text-sidebar-foreground/60 hover:text-foreground",
                            layoutMenuOpen &&
                              "bg-sidebar-accent text-foreground"
                          )}
                        >
                          <currentLayout.icon
                            className="size-3.5"
                            strokeWidth={1.75}
                          />
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Chat list</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" className="min-w-[168px]">
                    <DropdownMenuLabel>Chat list</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={currentLayout.id}
                      onValueChange={(value) =>
                        setChatSidebarLayout(
                          "chatSidebarLayout",
                          value as ChatSidebarLayout
                        )
                      }
                    >
                      {CHAT_LIST_LAYOUTS.map((layout) => (
                        <DropdownMenuRadioItem
                          key={layout.id}
                          value={layout.id}
                        >
                          <layout.icon
                            className="text-muted-foreground"
                            strokeWidth={1.75}
                          />
                          {layout.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={openArchivedChats}>
                      <ArchiveIcon
                        className="text-muted-foreground"
                        strokeWidth={1.75}
                      />
                      Archived chats
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Search chats"
                  className="size-6 cursor-pointer text-sidebar-foreground/60 hover:text-foreground"
                  onClick={() => setChatSearch(" ")}
                >
                  <SearchIcon className="size-3.5" strokeWidth={1.75} />
                </Button>
              </div>
            </div>
            <SidebarQuickActions
              appMode={appMode}
              minimalChat={minimalChat}
              onOpenSystemBrowser={() => {
                setSystemBrowserIntent("agent-new-thread")
                setSystemBrowserOpen(true)
              }}
              onNewAgent={() => {
                setNewThreadModalPath("")
                setNewThreadModalOpen(true)
              }}
              onNewProjectStart={() => {
                setNewProjectName("")
                setNewProjectPath("")
                setNewProjectTemplate(null)
                setNewProjectUI(null)
                setNewProjectPM("npm")
                setNewProjectStep(0)
                setNewProjectStatus("idle")
                setNewProjectLog("")
                setNewProjectOpen(true)
              }}
              onOpenMarketplace={() => setMarketplaceOpen(true)}
              onOpenAutomations={openAutomationsPage}
              onOpenSourceControl={() => setGitModal(true)}
              onOpenSearch={() => setChatSearch(" ")}
            />

            {chatUiStyle !== "simple" && (
              <Separator className="bg-sidebar-border" />
            )}
            {chatUiStyle === "simple" && (
              <div className="px-2">
                <div className="h-px bg-sidebar-border/40" />
              </div>
            )}
          </>
        )}

        {/* Middle content area — always flex-1 so the footer sticks to the
          bottom even when none of the inner blocks render (editor mode
          without an active project: no file tree, no chat list). Before
          this wrapper, skipping both blocks caused SidebarQuickActions +
          SidebarFooter to collapse together at the top. */}
        {workspaceSidebar && (
          <EditorWorkspaceNavigation
            projectPath={editorProjectPath}
            projectName={activeThread?.projectName}
            view={editorSidebarView}
            onViewChange={(view) => {
              if (view === "diff") setDiffViewOpen(true)
              else setEditorSidebarView(view)
            }}
            onOpenFolder={() => {
              setSystemBrowserIntent("editor-open-folder")
              setSystemBrowserOpen(true)
            }}
          />
        )}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Files, search, Git and Diff follow the active workspace in both workbenches. */}
          {workspaceSidebar &&
            (editorProjectPath ? (
              <EditorModeSidebarContent
                projectPath={editorProjectPath}
                projectName={activeThread?.projectName}
                view={editorSidebarView}
                providers={providers}
              />
            ) : (
              <EditorModeSidebarEmptyState
                onOpenFolder={() => {
                  setSystemBrowserIntent("editor-open-folder")
                  setSystemBrowserOpen(true)
                }}
                onSearchProjects={() => setChatSearch(" ")}
              />
            ))}

          {/* Chat list — hidden in editor mode. Three switchable layouts:
            the flat feed as task cards or compact rows, or the
            project-folder tree. */}
          {appMode === "agent" && currentLayout.id !== "folders" && (
            <>
              <SidebarTaskList
                search={chatSearch}
                variant={currentLayout.id === "compact" ? "compact" : "cards"}
                onConfirm={setConfirmAction}
                onNewThread={openNewThread}
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-sidebar to-transparent" />
            </>
          )}
          {appMode === "agent" && currentLayout.id === "folders" && (
            <>
              {chatUiStyle !== "simple" && (
                <SidebarChatsListHeader
                  chatDateFilter={chatDateFilter}
                  setChatDateFilter={setChatDateFilter}
                />
              )}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* Minimal mode: NO horizontal padding here — the list's own
                  sections pad to the shared 16px icon column (header text,
                  nav icons, Projects label, folder icons all align). */}
                <div className={minimalChat ? "pt-1 pb-0.5" : "px-2 py-1"}>
                  <SidebarThreadList
                    search={chatSearch}
                    dateFilter={chatDateFilter}
                    minimal={minimalChat}
                    onConfirm={setConfirmAction}
                  />
                </div>
              </div>
              {/* Gradient fade at bottom */}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-sidebar to-transparent" />
            </>
          )}
        </div>

        {appMode === "agent" && chatUiStyle !== "simple" && (
          <>
            <Separator className="bg-sidebar-border" />

            {/* Open Workspace — Extended mode only. In Simple mode this is
              redundant with the "New Agent" / "New Project" quick actions.
              Opens the System Browser overlay so the user can search +
              navigate the whole disk before picking a folder. */}
            <Button
              variant="ghost"
              size="sm"
              className="mx-2 mt-2 w-[calc(100%-16px)] justify-start gap-2.5 text-xs text-muted-foreground"
              onClick={() => {
                setSystemBrowserIntent("agent-new-thread")
                setSystemBrowserOpen(true)
              }}
            >
              <ExternalLinkIcon className="size-3.5" />
              Open Workspace
            </Button>
          </>
        )}

        {appMode === "agent" && chatUiStyle !== "simple" && (
          <Separator className="bg-sidebar-border" />
        )}

        {appMode === "agent" && (
          <SidebarProviderUpdatePill
            onOpenProviderSettings={() => {
              setSettingsTab("models")
              setSettingsOpen(true)
            }}
          />
        )}
      </div>

      {/* The footer scales the same in every mode, so the mode switch stays
          put under the pointer when it changes the mode. */}
      <div className="betterc0de-left-sidebar-scale shrink-0">
        <SidebarFooter
          appMode={appMode}
          setAppMode={setAppMode}
          gitHubUser={gitHubUser}
          gitUserName={gitUserName}
          activeProjectPath={activeThread?.projectPath}
          setFileTreeOpen={setFileTreeOpen}
          setSystemBrowserOpen={setSystemBrowserOpen}
          setSystemBrowserIntent={setSystemBrowserIntent}
          uiSoundEnabled={uiSoundEnabled}
          setSettingsTab={setSettingsTab}
          setSettingsOpen={setSettingsOpen}
        />
      </div>

      {/* The chat lists' dialogs (portaled), here so Settings and every mode
          can open them. */}
      <SnoozeCustomDialog />
      {archivedChatsOpen ? (
        <Suspense fallback={null}>
          <ArchivedChatsDialog />
        </Suspense>
      ) : null}
    </aside>
  )
}

/**
 * Memoized: every prop is a value or a stable setter, so streaming and
 * composer typing in the main area do not re-render the sidebar.
 */
export const LeftSidebar = memo(LeftSidebarImpl)
