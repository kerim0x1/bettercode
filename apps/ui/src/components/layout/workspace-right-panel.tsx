import {
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GlobeIcon,
  LayoutPanelTopIcon,
  PlayIcon,
  SearchIcon,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ClipboardIcon, LayoutAlignRightIcon } from "@hugeicons/core-free-icons"
import { motion } from "motion/react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import React, { lazy, Suspense, useEffect, useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { OpenTargetIcon } from "@/components/icons/open-target-icons"
import { useOpenTargets } from "@/hooks/use-open-targets"
import { MessageResponse } from "@/components/ai-elements/message"
import { DiffPanel } from "@/components/diff-panel"
import { ErrorBoundary } from "@/components/error-boundary"
import { GitPanel } from "@/components/git-panel"
import { ProjectFileTree } from "@/components/file-tree/project-file-tree"
import { WorkspaceStatusBar } from "@/components/layout/workspace-status-bar"
import { WorkspaceOverviewCard } from "@/components/layout/workspace-overview-card"
import {
  useChatStore,
  useThreadActivities,
  useThreadMessages,
} from "@/lib/chat-store"
import { useChatStreamingState } from "@/hooks/use-chat-streaming-state"
import { openInEditor, pickFolder } from "@/services/backend"
import type { SetPlanModalContent } from "@/lib/plan-modal"
import type { WorkspaceTab } from "@/lib/preferences-store"

const BrowserPreviewPanel = lazy(() =>
  import("@/components/browser-preview-panel").then((module) => ({
    default: module.BrowserPreviewPanel,
  }))
)

type ActiveThread = {
  id: string
  projectName?: string | null
  projectPath?: string | null
  worktreePath?: string | null
}

/**
 * Right-hand workspace panel in agent mode.
 *
 * Tabbed container for the plan preview, file tree, source control,
 * diff viewer, and browser preview — each tab is a thin wrapper around the
 * corresponding standalone component/panel, which keeps this file about
 * layout and tab orchestration only.
 *
 * Collapsible: when collapsed, the parent swaps us out for a thin toggle
 * tab. We get resize-handle mouse wiring via `onResizeStart` (owned by the
 * parent so the animation frame + state both live with the other sidebar
 * resize handlers).
 *
 * Persistent shell: the panel always mounts in agent mode even when there
 * is no active thread or no attached folder. In that case every tab shows
 * a shared, grayed-out "No folder / Repo open" empty state with an attach
 * action that auto-creates a thread when there isn't one yet, so the user
 * can onboard from the panel itself instead of first having to create a
 * chat from elsewhere.
 */
export function WorkspaceRightPanel({
  rightSidebarOpen,
  setRightSidebarOpen,
  rightSidebarWidth,
  onResizeStart,
  isResizingRight,
  workspaceTab,
  setWorkspaceTab,
  activeThread,
  setPlanModalContent,
  setEditingFile,
}: {
  rightSidebarOpen: boolean
  setRightSidebarOpen: (open: boolean) => void
  rightSidebarWidth: number
  onResizeStart: (e: React.MouseEvent) => void
  isResizingRight: boolean
  workspaceTab: WorkspaceTab
  setWorkspaceTab: (tab: WorkspaceTab) => void
  activeThread: ActiveThread | null
  setPlanModalContent: SetPlanModalContent
  setEditingFile: (path: string) => void
}) {
  const threadMessages = useThreadMessages(activeThread?.id ?? null)
  const threadActivities = useThreadActivities(activeThread?.id ?? null)
  const { isPlanStreaming, allPlans } = useChatStreamingState(
    threadMessages,
    activeThread?.id ?? null,
    { includeShimmer: false },
    threadActivities
  )
  // Prefer the worktree path when this chat runs in a git worktree, matching
  // the per-pane WorkspacePanelBody so Files/Git/Diff act on the same
  // directory the agent does. `activeThread` is rebound to the focused pane's
  // thread by the parent, so switching chats reslots the whole panel to that
  // workspace.
  const projectPath =
    activeThread?.worktreePath || activeThread?.projectPath || null
  const hasFolder = !!projectPath
  const showBrowser =
    hasFolder && workspaceTab === "browser" && rightSidebarOpen
  const [openedBrowserProject, setOpenedBrowserProject] = useState<
    string | null
  >(null)
  useEffect(() => {
    if (showBrowser) setOpenedBrowserProject(projectPath)
  }, [showBrowser, projectPath])
  // Keep the guest page alive when another workspace view is selected.
  const browserMounted = showBrowser || openedBrowserProject === projectPath

  // Which external tools are actually installed (Codex-style "Open in"
  // list). Detection pauses while the panel is closed.
  const { targets: openTargets, loading: openTargetsLoading } = useOpenTargets(
    hasFolder && rightSidebarOpen
  )

  const attachFolderButton = (
    <Button
      size="xs"
      className="w-full gap-1.5"
      variant="outline"
      onClick={async () => {
        const folder = await pickFolder()
        if (!folder) return
        const name = folder.split(/[/\\]/).pop() || "Project"
        if (activeThread) {
          useChatStore.setState((s) => ({
            threads: s.threads.map((t) =>
              t.id === activeThread.id
                ? { ...t, projectPath: folder, projectName: name }
                : t
            ),
          }))
        } else {
          // No thread to attach to yet — spin one up so the picked folder
          // still lands somewhere and becomes the new active workspace.
          useChatStore.getState().createThread("New Chat", name, folder)
        }
      }}
    >
      <FolderOpenIcon className="size-3.5" strokeWidth={1.5} />
      Attach folder
    </Button>
  )

  // Shared grayed-out empty state reused across every tab when there's no
  // folder/repo attached (either no active thread at all, or the active
  // thread's `projectPath` is empty). Keeping the message identical across
  // tabs avoids the prior per-tab copy drift and makes the panel feel like
  // a persistent shell rather than five separate disabled features.
  const noFolderEmptyState = (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center opacity-60">
      <FolderOpenIcon
        className="size-8 text-muted-foreground/50"
        strokeWidth={1.25}
      />
      <div className="space-y-1">
        <p className="text-sm font-medium text-muted-foreground">
          No folder / repo open
        </p>
        <p className="text-xs text-muted-foreground/70">
          Attach a folder to enable Plans, Files, Git, Diff, and Browser.
        </p>
      </div>
      <div className="w-full max-w-[200px]">{attachFolderButton}</div>
    </div>
  )

  const workspaceViews = [
    {
      key: "overview",
      label: "Overview",
      icon: <LayoutPanelTopIcon className="size-3.5" strokeWidth={1.5} />,
    },
    {
      key: "diff",
      label: "Diff",
      icon: <CodeIcon className="size-3.5" strokeWidth={1.5} />,
    },
    {
      key: "git",
      label: "Git",
      icon: <GitBranchIcon className="size-3.5" strokeWidth={1.5} />,
    },
    {
      key: "files",
      label: "Files",
      icon: <FolderOpenIcon className="size-3.5" strokeWidth={1.5} />,
    },
    {
      key: "plan",
      label: "Plan",
      icon: (
        <HugeiconsIcon
          icon={ClipboardIcon}
          strokeWidth={1.5}
          className="size-3.5"
        />
      ),
    },
    {
      key: "browser",
      label: "Browser",
      icon: <GlobeIcon className="size-3.5" strokeWidth={1.5} />,
    },
  ] as const
  const activeWorkspaceView =
    workspaceViews.find((view) => view.key === workspaceTab) ??
    workspaceViews[0]

  return (
    <motion.aside
      initial={false}
      animate={{
        width: rightSidebarOpen ? rightSidebarWidth : 0,
        marginLeft: rightSidebarOpen ? 0 : -8,
        opacity: rightSidebarOpen ? 1 : 0,
        x: rightSidebarOpen ? 0 : 8,
      }}
      transition={
        isResizingRight
          ? { duration: 0 }
          : rightSidebarOpen
            ? { type: "spring", duration: 0.3, bounce: 0 }
            : { duration: 0.16, ease: [0.4, 0, 1, 1] }
      }
      className={cn(
        "relative flex min-w-0 shrink-0 flex-col overflow-hidden rounded-xl border bg-sidebar shadow-[0_18px_50px_-32px_rgba(0,0,0,0.9)]",
        rightSidebarOpen
          ? "border-border/40"
          : "pointer-events-none border-transparent"
      )}
      aria-hidden={!rightSidebarOpen}
      inert={!rightSidebarOpen}
    >
      {/* Resize handle */}
      <div
        onMouseDown={onResizeStart}
        className={cn(
          "absolute top-0 bottom-0 left-0 z-10 w-1 cursor-ew-resize transition-colors",
          isResizingRight ? "bg-primary" : "hover:bg-primary/50"
        )}
      />
      {/* Codex-style header: "Open in <editor>" on the left, the view
          picker menu and the close control on the right. The tab strip is
          gone — views switch through the picker (and rows on the Overview
          card). The close control lives here, beside the picker, because the
          pane-bar toggle that opened the panel disappears as soon as the
          panel takes focus. */}
      <div className="flex h-9 shrink-0 items-center justify-between bg-sidebar px-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              disabled={!hasFolder}
              className="h-6 gap-1.5 rounded-lg px-2 text-[11px]"
            >
              <ExternalLinkIcon className="size-3" />
              Open in
              <ChevronDownIcon className="size-3 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[190px]">
            {openTargetsLoading || !openTargets ? (
              <DropdownMenuItem disabled>Detecting…</DropdownMenuItem>
            ) : (
              (() => {
                const available = openTargets.filter((t) => t.available)
                if (available.length === 0) {
                  return (
                    <DropdownMenuItem disabled>No tools found</DropdownMenuItem>
                  )
                }
                return available.map((target, index) => (
                  <React.Fragment key={target.id}>
                    {index > 0 &&
                      available[index - 1]!.group !== target.group && (
                        <DropdownMenuSeparator />
                      )}
                    <DropdownMenuItem
                      className="gap-2.5"
                      onClick={() => {
                        if (projectPath)
                          void openInEditor(projectPath, target.id)
                      }}
                    >
                      <OpenTargetIcon id={target.id} className="size-4" />
                      {target.label}
                    </DropdownMenuItem>
                  </React.Fragment>
                ))
              })()
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="xs"
                aria-label={`Current view: ${activeWorkspaceView.label}. Change workspace view`}
                className="h-7 min-w-[112px] justify-between gap-2 rounded-lg px-2.5 text-[11px] transition-[scale,background-color,color] duration-150 ease-out active:scale-[0.96]"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 text-muted-foreground">
                    {activeWorkspaceView.icon}
                  </span>
                  <span className="truncate font-medium">
                    {activeWorkspaceView.label}
                  </span>
                </span>
                <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[190px]">
              {/* "Overview" is the panel's home/landing view, not a menu option:
                  it's excluded here (still resolved for the button label above,
                  and reachable via the Diff view's close button). */}
              {workspaceViews
                .filter((view) => view.key !== "overview")
                .map((view) => (
                  <DropdownMenuItem
                    key={view.key}
                    onClick={() => setWorkspaceTab(view.key)}
                    className="gap-2.5"
                  >
                    <span className="text-muted-foreground">{view.icon}</span>
                    <span className="flex-1">{view.label}</span>
                    {workspaceTab === view.key && (
                      <CheckIcon className="size-3.5 text-primary" />
                    )}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setRightSidebarOpen(false)}
            className="size-7 text-primary transition-[color,scale] duration-150 ease-out hover:text-foreground active:scale-[0.96]"
            aria-label="Close workspace"
            title="Close workspace"
          >
            <HugeiconsIcon
              icon={LayoutAlignRightIcon}
              strokeWidth={2}
              className="size-3.5"
            />
          </Button>
        </div>
      </div>

      {/* Content area - based on active tab. When no folder/repo is
          attached, every tab renders the same grayed-out empty state so
          the panel still feels present and discoverable instead of going
          silently blank. */}
      <div
        className={cn(
          "min-h-0 flex-1",
          workspaceTab === "browser" ? "overflow-hidden" : "overflow-y-auto"
        )}
      >
        {!hasFolder && noFolderEmptyState}
        {hasFolder && workspaceTab === "overview" && projectPath && (
          <ErrorBoundary label="Overview">
            <WorkspaceOverviewCard
              projectPath={projectPath}
              threadId={activeThread?.id ?? null}
              isWorktree={!!activeThread?.worktreePath}
              setWorkspaceTab={setWorkspaceTab}
            />
          </ErrorBoundary>
        )}
        {hasFolder && workspaceTab === "plan" && (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-2">
              <HugeiconsIcon
                icon={ClipboardIcon}
                strokeWidth={2}
                className="size-4 text-sky-400"
              />
              <span className="flex-1 text-xs font-medium text-sidebar-foreground">
                Plans
              </span>
              <span className="text-[10px] text-muted-foreground">
                {allPlans.length}
              </span>
              {isPlanStreaming && (
                <span className="animate-pulse text-[10px] text-primary">
                  Live
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              {allPlans.length === 0 ? (
                <p className="text-xs text-muted-foreground/70">
                  No plans yet. Use plan mode to generate one.
                </p>
              ) : (
                allPlans
                  .slice()
                  .reverse()
                  .map((plan, reversedIdx) => {
                    const planNumber = allPlans.length - reversedIdx
                    return (
                      <div
                        key={plan.id}
                        className="overflow-hidden rounded-lg border border-sidebar-border bg-sidebar"
                      >
                        <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-1.5">
                          <span className="text-[10px] font-medium text-muted-foreground">
                            Plan #{planNumber}
                          </span>
                          {plan.streaming && (
                            <span className="animate-pulse text-[10px] text-primary">
                              Live
                            </span>
                          )}
                          {plan.createdAt && !plan.streaming && (
                            <span className="text-[10px] text-muted-foreground/60">
                              {new Date(plan.createdAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          )}
                          <div className="flex-1" />
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={() => {
                                  navigator.clipboard
                                    .writeText(plan.content)
                                    .catch(() => {
                                      /* Expected: clipboard may be unavailable (unfocused window, permissions) */
                                    })
                                }}
                                className="text-sidebar-foreground hover:text-foreground"
                              >
                                <CopyIcon
                                  className="size-3.5"
                                  strokeWidth={1.5}
                                />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="left">Copy</TooltipContent>
                          </Tooltip>
                        </div>
                        <div className="space-y-3 p-3">
                          <div className="plan-preview-prose text-xs leading-relaxed text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                            <MessageResponse>{plan.preview}</MessageResponse>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="xs"
                              className="flex-1 gap-1.5"
                              variant="outline"
                              onClick={() =>
                                setPlanModalContent({
                                  content: plan.content,
                                  sourceProposedPlan:
                                    plan.sourceProposedPlan ?? null,
                                  implemented: plan.implemented ?? false,
                                  implementedAt: plan.implementedAt ?? null,
                                  implementationThreadId:
                                    plan.implementationThreadId ?? null,
                                })
                              }
                            >
                              <SearchIcon
                                className="size-3.5"
                                strokeWidth={1.5}
                              />
                              Open
                            </Button>
                            <Button
                              size="xs"
                              className="flex-1 gap-1.5"
                              onClick={() =>
                                setPlanModalContent({
                                  content: plan.content,
                                  sourceProposedPlan:
                                    plan.sourceProposedPlan ?? null,
                                  implemented: plan.implemented ?? false,
                                  implementedAt: plan.implementedAt ?? null,
                                  implementationThreadId:
                                    plan.implementationThreadId ?? null,
                                })
                              }
                              disabled={plan.implemented}
                            >
                              <PlayIcon
                                className="size-3.5"
                                strokeWidth={1.5}
                              />
                              {plan.implemented ? "Implemented" : "Implement"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })
              )}
            </div>
          </div>
        )}

        {hasFolder && workspaceTab === "files" && projectPath && (
          <div className="h-full">
            <div className="h-full overflow-y-auto p-2">
              <ProjectFileTree
                projectPath={projectPath}
                defaultOpen
                onFileSelect={(relPath) => {
                  // searchEntries returns paths RELATIVE to projectPath —
                  // FileEditorModal calls readFile(filePath) directly with
                  // no cwd context, so we MUST prepend the project root or
                  // the backend 404s against its own process cwd. Same fix
                  // as editor-mode-sidebar-content.tsx.
                  const alreadyAbs =
                    /^[A-Za-z]:[\\/]/.test(relPath) ||
                    relPath.startsWith("/") ||
                    relPath.startsWith("\\\\")
                  if (alreadyAbs) {
                    setEditingFile(relPath)
                    return
                  }
                  const root = projectPath ?? ""
                  const sep = root.includes("\\") ? "\\" : "/"
                  const base = root.replace(/[\\/]+$/, "")
                  setEditingFile(`${base}${sep}${relPath}`)
                }}
              />
            </div>
          </div>
        )}

        {hasFolder && workspaceTab === "git" && projectPath && (
          <div className="h-full">
            <div className="h-full min-h-0">
              <ErrorBoundary label="Git">
                <GitPanel cwd={projectPath} appMode="agent" />
              </ErrorBoundary>
            </div>
          </div>
        )}

        {hasFolder && workspaceTab === "diff" && projectPath && (
          <div className="flex h-full flex-col">
            <DiffPanel
              open={true}
              onClose={() => setWorkspaceTab("overview")}
              cwd={projectPath}
            />
          </div>
        )}
        {hasFolder && browserMounted && projectPath && (
          <div
            className={cn("h-full min-h-0", !showBrowser && "hidden")}
            aria-hidden={!showBrowser}
            inert={!showBrowser}
          >
            <ErrorBoundary label="Browser preview">
              <Suspense
                fallback={
                  <div
                    className="size-full bg-muted/20"
                    aria-label="Loading browser preview"
                  />
                }
              >
                <BrowserPreviewPanel
                  key={projectPath}
                  projectPath={projectPath}
                  threadId={activeThread?.id ?? null}
                  active={showBrowser && rightSidebarOpen}
                  compact
                  className="h-full min-h-0"
                  onClose={() => setWorkspaceTab("overview")}
                />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
      </div>

      {/* Status bar — the panel follows the focused chat, so the workspace it
          is bound to (+ a live git summary) lives down here where the space
          was going unused, instead of competing with the tabs up top. */}
      {activeThread?.projectName && (
        <WorkspaceStatusBar
          projectName={activeThread.projectName}
          projectPath={projectPath}
          isWorktree={!!activeThread.worktreePath}
        />
      )}
    </motion.aside>
  )
}
