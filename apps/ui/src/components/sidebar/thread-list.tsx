import { copyText } from "@/lib/clipboard"
import { memo, useCallback, useMemo, useState, type DragEvent } from "react"
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  FolderIcon,
  FolderOpenIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/kibo-ui/spinner"
import { AttentionBadge } from "@/components/attention/attention-badge"
import { useChatStore } from "@/lib/chat-store"
import { usePrompt } from "@/components/dialogs/prompt-provider"
import { useSettingsStore } from "@/lib/settings-store"
import { timeAgo } from "@/lib/format"
import { shouldShowThreadInSidebar } from "@/lib/sidebar-thread-visibility"
import { THREAD_DRAG_TYPE } from "@/components/layout/panes/pane-drop-zone"
import { buildSessionTree, type SessionTreeNode } from "@/lib/session-tree"
import type { ChatThread } from "@betterc0de/schema"

/**
 * Drag handlers that let a sidebar chat be dragged into the agent pane grid —
 * dropped on a pane edge it opens as a new pane, in the center as a new tab
 * (see pane-drop-zone.tsx + use-panes `openThreadOnPane`). Coexists with the
 * row's onClick (click still opens in the focused pane).
 */
function threadDragHandlers(threadId: string, title: string) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = "copyMove"
      e.dataTransfer.setData(
        THREAD_DRAG_TYPE,
        JSON.stringify({ threadId, label: title })
      )
    },
  }
}

/**
 * Sidebar section that lists all chat threads, grouped by project folder.
 *
 * Two layouts share one component:
 *  - Extended (default): project header has a folder icon + border-left
 *    guide for the nested thread list, thread rows show `timeAgo` on the
 *    right.
 *  - Minimal (Simple UI mode): tighter row heights, no per-thread icon.
 *    Used when the sidebar is in "just the essentials" mode.
 *
 * Thread rows carry no background of their own: hover and the active
 * selection are expressed purely through the title's color/weight, so the
 * list reads as text under the folder rather than a stack of cards. The
 * project header keeps its hover background — it's the interactive
 * container.
 *
 * Swarm threads (title prefixed with `[Swarm:...]`) are hoisted into their
 * own collapsible group at the top, keeping the regular project groups
 * clean.
 *
 * Archiving is non-destructive: the thread is kept in the store but added
 * to `settings.archived_thread_ids`, which this component filters out.
 * Delete is destructive and routes through the `onConfirm` callback so the
 * parent can show a shared confirmation dialog.
 */
export function SidebarThreadList({
  search = "",
  dateFilter = "all",
  minimal = false,
  onConfirm,
}: {
  search?: string
  dateFilter?: string
  minimal?: boolean
  onConfirm?: (opts: {
    title: string
    description: string
    action: () => void
  }) => void
}) {
  const threads = useChatStore((s) => s.threads)
  const prompt = usePrompt()
  const messagesLoadedByThread = useChatStore((s) => s.messagesLoadedByThread)
  const setActiveThread = useChatStore((s) => s.setActiveThread)
  const deleteThread = useChatStore((s) => s.deleteThread)
  const archivedThreadIds = useSettingsStore((s) => s.archivedThreadIds)

  /**
   * Opens a thread from the sidebar. Bug before this change: we only called
   * `setActiveThread`, which updates the store but leaves the composer-tab
   * bar untouched. If the tab for that thread had been closed earlier, the
   * main area would keep showing whatever the active tab was — the click
   * felt dead. Dispatching `betterc0de:open-thread` lets the composer hook
   * reuse or create a tab for this thread (see use-composer-tabs.ts).
   */
  const openThread = useCallback(
    (threadId: string, title?: string) => {
      setActiveThread(threadId)
      window.dispatchEvent(
        new CustomEvent("betterc0de:open-thread", {
          detail: { threadId, label: title },
        })
      )
    },
    [setActiveThread]
  )

  const handleRename = useCallback(
    async (threadId: string, currentTitle: string) => {
      const newTitle = await prompt({
        title: "Rename thread",
        defaultValue: currentTitle,
        confirmLabel: "Rename",
      })
      if (newTitle && newTitle.trim()) {
        useChatStore.getState().updateThreadTitle(threadId, newTitle.trim())
      }
    },
    [prompt]
  )

  const handleShare = useCallback(async (threadId: string) => {
    // Threads restored by usePersistedThreads are skeletons with
    // `messages: []` until opened once — sharing an unopened thread used
    // to copy only the header. Hydrate first (same pattern as forkThread),
    // then re-read the store for the filled-in messages.
    const store = useChatStore.getState()
    if (!store.messagesLoadedByThread[threadId]) {
      await store.hydrateThreadMessages(threadId)
    }
    const thread = useChatStore
      .getState()
      .threads.find((t) => t.id === threadId)
    if (!thread) return
    const content = thread.messages
      .map((m) => {
        const role =
          m.role === "user"
            ? "User"
            : m.role === "assistant"
              ? "Assistant"
              : "System"
        return `[${role}]\n${m.content}`
      })
      .join("\n\n---\n\n")
    const header = `Thread: ${thread.title}\nProject: ${thread.projectName}\nDate: ${thread.createdAt}\n\n`
    copyText(header + content)
  }, [])

  const handleArchive = useCallback((threadId: string) => {
    const settings = useSettingsStore.getState()
    const updated = [...settings.archivedThreadIds, threadId]
    settings.update({ archived_thread_ids: updated })
  }, [])

  // Filter threads by search + date + archive
  const now = Date.now()
  // Deliberately NOT applying filterThreadsForSessionDirectory here: the
  // sidebar is the global chat overview. With the session-directory filter
  // applied, opening any chat collapsed the whole list to that chat's
  // project folder — every other folder silently vanished ("all my chats
  // are gone" bug). Workspace-scoped filtering remains where it belongs:
  // Alt+Arrow thread cycling (use-global-shortcuts) and the thread pickers
  // in use-chat-submit.
  const filtered = threads.filter((t) => {
    // Hide silent inline-edit threads (handleInlineEdit creates these
    // with a `__inline-edit-<timestamp>__` title prefix and deletes
    // them when done; this guard covers the window in between).
    if (t.title?.startsWith("__inline-edit-")) return false
    // Hide placeholder tabs that were opened but never used — i.e. no
    // user message has been sent yet. These come from the "+" button and
    // would otherwise clutter the list with "Chat 2", "Chat 3", etc.
    // Deliberately-created "New Chat" threads stay visible so selecting a
    // folder in the New Thread dialog immediately creates a project entry.
    //
    // After an app reload `usePersistedThreads` stores skeleton threads
    // with `messages: []` and hydrates them lazily on `setActiveThread`.
    // Without the `isHydrated` guard every real chat would be filtered
    // out until the user clicked it — but they can't click what isn't
    // rendered, so the sidebar looked empty ("chats are gone" bug). Fall
    // back to the DB-side `messageCount` for unhydrated threads, which
    // the backend populates via `projection_threads.message_count`.
    const isHydrated = messagesLoadedByThread[t.id] === true
    if (!shouldShowThreadInSidebar(t, isHydrated)) {
      return false
    }
    // Hide archived threads
    if (archivedThreadIds.includes(t.id)) return false
    // Search filter — trim so the " " sentinel that opens the search
    // dialog doesn't accidentally narrow results in the sidebar list.
    const q = search.trim().toLowerCase()
    if (q) {
      const matchTitle = t.title?.toLowerCase().includes(q)
      const matchProject = t.projectName?.toLowerCase().includes(q)
      const matchContent = t.messages?.some((m) =>
        m.content?.toLowerCase().includes(q)
      )
      if (!matchTitle && !matchProject && !matchContent) return false
    }
    // Date filter
    if (dateFilter !== "all") {
      const updated = new Date(t.updatedAt).getTime()
      if (dateFilter === "today" && now - updated > 86400000) return false
      if (dateFilter === "week" && now - updated > 7 * 86400000) return false
      if (dateFilter === "month" && now - updated > 30 * 86400000) return false
    }
    return true
  })

  if (filtered.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/40">
        {search.trim()
          ? `No chats matching "${search.trim()}"`
          : "No conversations yet"}
      </div>
    )
  }

  // Separate swarm threads from regular threads
  const swarmThreads = filtered.filter((t) => t.title?.startsWith("[Swarm:"))
  const regularThreads = filtered.filter((t) => !t.title?.startsWith("[Swarm:"))

  // Group regular threads by projectName
  const projectGroups = new Map<string, typeof threads>()
  for (const thread of regularThreads) {
    const key = thread.projectName || "BetterC0de"
    if (!projectGroups.has(key)) projectGroups.set(key, [])
    projectGroups.get(key)!.push(thread)
  }

  if (minimal) {
    // Simple UI mode — threads grouped under their project folder as
    // collapsible folders, but with the minimal styling from the rest
    // of the sidebar (no dividers, clean foreground colors, compact
    // row heights, left-aligned at 12 px to match quick actions).
    return (
      <>
        {/* Swarm threads — px-2 wrapper keeps the icon column at 16px now
            that the outer list wrapper carries no horizontal padding. */}
        {swarmThreads.length > 0 && (
          <div className="px-2">
            <Collapsible defaultOpen>
              <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[10px] text-primary/80 transition-colors duration-75 hover:bg-foreground/10">
                <ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=closed]:-rotate-90" />
                <svg
                  viewBox="0 0 24 24"
                  className="size-3 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="5" cy="19" r="2" />
                  <circle cx="19" cy="19" r="2" />
                  <path d="M12 7v4m-5.3 3.3 3.6-3.6m7.4 3.6-3.6-3.6" />
                </svg>
                <span className="truncate font-medium">Swarm</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="betterc0de-collapsible-content">
                <div className="space-y-0.5 pr-1 pl-4">
                  {swarmThreads.map((thread) => (
                    <SwarmMinimalRow
                      key={thread.id}
                      threadId={thread.id}
                      title={thread.title}
                      openThread={openThread}
                    />
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
        {/* ── Codex-style "Projects" sections: always-visible thread
            titles under each project, active project highlighted, long
            lists clamped behind "Show more". ── */}
        <div className="px-4 pt-2 pb-1 text-[10px] font-medium text-sidebar-foreground/40">
          Projects
        </div>
        {Array.from(projectGroups.entries()).map(
          ([projectName, projectThreads]) => (
            <ProjectSection
              key={projectName}
              projectName={projectName}
              threads={projectThreads}
              openThread={openThread}
              handleRename={handleRename}
              handleShare={handleShare}
              handleArchive={handleArchive}
              deleteThread={deleteThread}
              onConfirm={onConfirm}
            />
          )
        )}
      </>
    )
  }

  return (
    <>
      {/* Swarm threads (extended view) */}
      {swarmThreads.length > 0 && (
        <Collapsible defaultOpen>
          <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-[10px] text-primary/80 transition-colors duration-75 hover:bg-foreground/10">
            <ChevronDownIcon className="size-3 shrink-0 transition-transform group-data-[state=closed]:-rotate-90" />
            <svg
              viewBox="0 0 24 24"
              className="size-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="5" r="2" />
              <circle cx="5" cy="19" r="2" />
              <circle cx="19" cy="19" r="2" />
              <path d="M12 7v4m-5.3 3.3 3.6-3.6m7.4 3.6-3.6-3.6" />
            </svg>
            <span className="truncate font-medium">Swarm</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="betterc0de-collapsible-content">
            <div className="ml-3 border-l border-primary/20 pl-1">
              {swarmThreads.map((thread) => (
                <SwarmExtendedRow
                  key={thread.id}
                  threadId={thread.id}
                  title={thread.title}
                  updatedAt={thread.updatedAt}
                  openThread={openThread}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
      {Array.from(projectGroups.entries()).map(
        ([projectName, projectThreads]) => (
          <Collapsible key={projectName} defaultOpen={false}>
            <div className="group/project flex w-full items-center">
              <CollapsibleTrigger className="group flex flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1 py-1 text-[10px] text-muted-foreground transition-colors duration-75 hover:bg-foreground/10">
                <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground/60 group-data-[state=closed]:hidden" />
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60 group-data-[state=open]:hidden" />
                <span className="truncate font-medium text-muted-foreground">
                  {projectName}
                </span>
                <span className="ml-auto shrink-0 rounded-full bg-foreground/[0.07] px-1.5 py-px text-[9px] font-medium text-muted-foreground/70 tabular-nums">
                  {projectThreads.length}
                </span>
              </CollapsibleTrigger>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="mr-1 size-5 shrink-0 text-muted-foreground/35 transition-colors hover:text-foreground"
                  >
                    <EllipsisIcon className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="right">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      if (onConfirm) {
                        onConfirm({
                          title: "Delete project chats?",
                          description: `All ${projectThreads.length} chat(s) in "${projectName}" will be permanently deleted.`,
                          action: () => {
                            projectThreads.forEach((t) => deleteThread(t.id))
                          },
                        })
                      }
                    }}
                  >
                    <Trash2Icon className="size-3.5" />
                    Delete All Chats
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <CollapsibleContent className="betterc0de-collapsible-content">
              {projectThreads.length === 0 ? (
                <p className="ml-3 border-l border-border/50 py-1 pl-4 text-[10px] text-muted-foreground/30">
                  No chats
                </p>
              ) : (
                <div className="ml-3 border-l border-border/50 pl-1">
                  <SessionTreeRows
                    nodes={buildSessionTree(projectThreads)}
                    variant="extended"
                    openThread={openThread}
                    handleRename={handleRename}
                    handleShare={handleShare}
                    handleArchive={handleArchive}
                    deleteThread={deleteThread}
                    onConfirm={onConfirm}
                  />
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        )
      )}
    </>
  )
}

/** How many threads a project shows before folding behind "Show more". */
const PROJECT_VISIBLE_THREADS = 5

interface ProjectSectionProps {
  projectName: string
  threads: ChatThread[]
  openThread: (id: string, title?: string) => void
  handleRename: (id: string, title: string) => void
  handleShare: (id: string) => void
  handleArchive: (id: string) => void
  deleteThread: (id: string) => void
  onConfirm?: (dialog: {
    title: string
    description: string
    action: () => void
  }) => void
}

/**
 * One Codex-style project group: folder + name row (highlighted while a
 * thread inside is active), plain-text thread rows beneath, and a
 * "Show more" clamp for long lists. The row itself toggles the section.
 */
const ProjectSection = memo(function ProjectSection({
  projectName,
  threads,
  openThread,
  handleRename,
  handleShare,
  handleArchive,
  deleteThread,
  onConfirm,
}: ProjectSectionProps) {
  // Sections start COLLAPSED — the folder row is the toggle; chats only
  // show once the user opens a project.
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const containsActive = useChatStore((s) =>
    threads.some((t) => t.id === s.activeThreadId)
  )
  const sessionTree = useMemo(() => buildSessionTree(threads), [threads])
  const visible = showAll
    ? sessionTree
    : sessionTree.slice(0, PROJECT_VISIBLE_THREADS)

  return (
    <div className="px-2 pb-1">
      <div className="group/project flex w-full items-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            "flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors duration-75 hover:bg-foreground/10",
            containsActive && "bg-foreground/[0.07]"
          )}
        >
          <FolderIcon
            className="size-3.5 shrink-0 text-sidebar-foreground/60"
            strokeWidth={1.75}
          />
          <span className="truncate text-[12px] text-sidebar-foreground/90">
            {projectName}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-0.5 size-5 shrink-0 text-muted-foreground/35 transition-colors hover:text-foreground"
            >
              <EllipsisIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right">
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                if (onConfirm) {
                  onConfirm({
                    title: "Delete project chats?",
                    description: `All ${threads.length} chat(s) in "${projectName}" will be permanently deleted.`,
                    action: () => {
                      threads.forEach((t) => deleteThread(t.id))
                    },
                  })
                }
              }}
            >
              <Trash2Icon className="size-3.5" />
              Delete All Chats
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded &&
        (threads.length === 0 ? (
          <p className="py-1 pl-[30px] text-[11px] text-sidebar-foreground/30">
            No tasks
          </p>
        ) : (
          <div className="space-y-px pt-0.5">
            <SessionTreeRows
              nodes={visible}
              variant="minimal"
              openThread={openThread}
              handleRename={handleRename}
              handleShare={handleShare}
              handleArchive={handleArchive}
              deleteThread={deleteThread}
              onConfirm={onConfirm}
            />
            {sessionTree.length > PROJECT_VISIBLE_THREADS && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="cursor-pointer py-[3px] pl-[30px] text-left text-[11px] text-sidebar-foreground/40 transition-colors duration-75 hover:text-sidebar-foreground"
              >
                {showAll ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        ))}
    </div>
  )
})

type SessionTreeRowsProps = {
  nodes: SessionTreeNode<ChatThread>[]
  variant: "minimal" | "extended"
  openThread: (id: string, title?: string) => void
  handleRename: (id: string, title: string) => void
  handleShare: (id: string) => void
  handleArchive: (id: string) => void
  deleteThread: (id: string) => void
  onConfirm?: (dialog: {
    title: string
    description: string
    action: () => void
  }) => void
}

function SessionTreeRows(props: SessionTreeRowsProps) {
  return (
    <>
      {props.nodes.map((node) => (
        <SessionTreeBranch key={node.id} {...props} node={node} />
      ))}
    </>
  )
}

function SessionTreeBranch({
  node,
  variant,
  ...callbacks
}: Omit<SessionTreeRowsProps, "nodes"> & {
  node: SessionTreeNode<ChatThread>
}) {
  const hasChildren = node.children.length > 0
  const [expanded, setExpanded] = useState(() =>
    readSessionTreeExpanded(node.id)
  )
  const toggle = () => {
    setExpanded((current) => {
      const next = !current
      writeSessionTreeExpanded(node.id, next)
      return next
    })
  }
  const rowProps = {
    threadId: node.value.id,
    title: node.value.title,
    childCount: node.children.length,
    expanded,
    onToggle: hasChildren ? toggle : undefined,
    ...callbacks,
  }

  return (
    <div>
      {variant === "minimal" ? (
        <ThreadListRow {...rowProps} />
      ) : (
        <ExtendedProjectRow {...rowProps} updatedAt={node.value.updatedAt} />
      )}
      {hasChildren && expanded ? (
        <div className="ml-3 border-l border-border/50 pl-1">
          <SessionTreeRows
            nodes={node.children}
            variant={variant}
            {...callbacks}
          />
        </div>
      ) : null}
    </div>
  )
}

const SESSION_TREE_STORAGE_PREFIX = "betterc0de:session-tree:expanded:"

function readSessionTreeExpanded(threadId: string): boolean {
  if (typeof window === "undefined") return true
  try {
    return (
      window.localStorage.getItem(
        `${SESSION_TREE_STORAGE_PREFIX}${threadId}`
      ) !== "false"
    )
  } catch {
    return true
  }
}

function writeSessionTreeExpanded(threadId: string, expanded: boolean): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      `${SESSION_TREE_STORAGE_PREFIX}${threadId}`,
      String(expanded)
    )
  } catch {
    // Storage is optional; navigation remains functional without persistence.
  }
}

interface ThreadListRowProps {
  threadId: string
  title: string
  childCount?: number
  expanded?: boolean
  onToggle?: () => void
  openThread: (id: string, title?: string) => void
  handleRename: (id: string, title: string) => void
  handleShare: (id: string) => void
  handleArchive: (id: string) => void
  deleteThread: (id: string) => void
  onConfirm?: (dialog: {
    title: string
    description: string
    action: () => void
  }) => void
}

const ThreadListRow = memo(function ThreadListRow({
  threadId,
  title,
  childCount = 0,
  expanded = true,
  onToggle,
  openThread,
  handleRename,
  handleShare,
  handleArchive,
  deleteThread,
  onConfirm,
}: ThreadListRowProps) {
  const active = useChatStore((s) => s.activeThreadId === threadId)
  const isStreaming = useChatStore(
    (s) => !!s.streamingByThread[threadId]?.isStreaming
  )
  const displayTitle = title || "New Task"
  const truncated =
    displayTitle.length > 34 ? displayTitle.slice(0, 34) + "…" : displayTitle
  return (
    <div
      className={cn(
        // pl-[30px] + the section's px-2 = 38px — thread titles start
        // exactly under the project NAME (16px icon column + 14px icon +
        // 8px gap).
        "group flex cursor-pointer items-center gap-1.5 rounded-md py-[3px] pr-1 pl-[30px]",
        // Selection reads as a subtle row fill (Codex-style); hover still
        // brightens the text only.
        active && "bg-foreground/[0.06]"
      )}
      onClick={() => openThread(threadId, title || undefined)}
      {...threadDragHandlers(threadId, title)}
    >
      {onToggle ? (
        <button
          type="button"
          aria-label={expanded ? "Collapse forks" : "Expand forks"}
          aria-expanded={expanded}
          className="grid size-4 shrink-0 place-items-center rounded text-sidebar-foreground/50 hover:bg-foreground/10 hover:text-sidebar-foreground"
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
        </button>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <span
        className={cn(
          "flex-1 truncate text-[11px] transition-colors duration-75",
          active
            ? "font-medium text-sidebar-foreground"
            : "text-sidebar-foreground/65 group-hover:text-sidebar-foreground"
        )}
      >
        {truncated}
      </span>
      {childCount > 0 ? (
        <span className="shrink-0 text-[9px] text-sidebar-foreground/40 tabular-nums">
          {childCount}
        </span>
      ) : null}
      <AttentionBadge threadId={threadId} className="shrink-0" />
      {isStreaming && (
        <Spinner variant="bars" size={14} className="shrink-0 text-primary" />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 shrink-0 text-muted-foreground/35 transition-colors hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <EllipsisIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              handleRename(threadId, title)
            }}
          >
            <PencilIcon className="size-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              handleShare(threadId)
            }}
          >
            <CopyIcon className="size-3.5" />
            Copy to Clipboard
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              handleArchive(threadId)
            }}
          >
            <ArchiveIcon className="size-3.5" />
            Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={(e) => {
              e.stopPropagation()
              if (onConfirm) {
                onConfirm({
                  title: "Delete chat?",
                  description: `"${title || "New Chat"}" will be permanently deleted.`,
                  action: () => deleteThread(threadId),
                })
              }
            }}
          >
            <Trash2Icon className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

interface SwarmMinimalRowProps {
  threadId: string
  title: string
  openThread: (id: string, title?: string) => void
}

const SwarmMinimalRow = memo(function SwarmMinimalRow({
  threadId,
  title,
  openThread,
}: SwarmMinimalRowProps) {
  const active = useChatStore((s) => s.activeThreadId === threadId)
  const isStreaming = useChatStore(
    (s) => !!s.streamingByThread[threadId]?.isStreaming
  )
  const agentName = title?.replace(/^\[Swarm:[^\]]+\]\s*/, "") || "Agent"
  return (
    <div
      className="group flex cursor-pointer items-center gap-2 px-2 py-1"
      onClick={() => openThread(threadId, title || undefined)}
      {...threadDragHandlers(threadId, title)}
    >
      <span
        className={cn(
          "flex-1 truncate text-[10px] transition-colors duration-75",
          active
            ? "font-medium text-sidebar-foreground"
            : "text-sidebar-foreground/60 group-hover:text-sidebar-foreground"
        )}
      >
        {agentName}
      </span>
      <AttentionBadge threadId={threadId} className="shrink-0" />
      {isStreaming && (
        <Spinner variant="bars" size={14} className="shrink-0 text-primary" />
      )}
    </div>
  )
})

interface SwarmExtendedRowProps {
  threadId: string
  title: string
  updatedAt: string
  openThread: (id: string, title?: string) => void
}

const SwarmExtendedRow = memo(function SwarmExtendedRow({
  threadId,
  title,
  updatedAt,
  openThread,
}: SwarmExtendedRowProps) {
  const active = useChatStore((s) => s.activeThreadId === threadId)
  const isStreaming = useChatStore(
    (s) => !!s.streamingByThread[threadId]?.isStreaming
  )
  const agentName = title?.replace(/^\[Swarm:[^\]]+\]\s*/, "") || "Agent"
  return (
    <div
      className="group grid cursor-pointer items-center py-1 pr-1 pl-3"
      style={{ gridTemplateColumns: "1fr auto auto auto" }}
      onClick={() => openThread(threadId, title || undefined)}
      {...threadDragHandlers(threadId, title)}
    >
      <span
        className={cn(
          "truncate text-[10px] transition-colors duration-75",
          active
            ? "font-medium text-sidebar-foreground"
            : "text-sidebar-foreground/60 group-hover:text-sidebar-foreground"
        )}
      >
        {agentName}
      </span>
      <AttentionBadge threadId={threadId} className="mr-1" />
      {isStreaming ? (
        <Spinner variant="bars" size={14} className="text-primary" />
      ) : (
        <span />
      )}
      <span className="px-1.5 text-[9px] whitespace-nowrap text-muted-foreground/50 tabular-nums">
        {timeAgo(updatedAt)}
      </span>
    </div>
  )
})

interface ExtendedProjectRowProps {
  threadId: string
  title: string
  updatedAt: string
  childCount?: number
  expanded?: boolean
  onToggle?: () => void
  openThread: (id: string, title?: string) => void
  handleRename: (id: string, title: string) => void
  handleShare: (id: string) => void
  handleArchive: (id: string) => void
  deleteThread: (id: string) => void
  onConfirm?: (dialog: {
    title: string
    description: string
    action: () => void
  }) => void
}

const ExtendedProjectRow = memo(function ExtendedProjectRow({
  threadId,
  title,
  updatedAt,
  childCount = 0,
  expanded = true,
  onToggle,
  openThread,
  handleRename,
  handleShare,
  handleArchive,
  deleteThread,
  onConfirm,
}: ExtendedProjectRowProps) {
  const active = useChatStore((s) => s.activeThreadId === threadId)
  const isStreaming = useChatStore(
    (s) => !!s.streamingByThread[threadId]?.isStreaming
  )
  const raw = title || "New Chat"
  const displayTitle = raw.length > 40 ? raw.slice(0, 40) + "..." : raw
  return (
    <div
      className="group flex cursor-pointer items-center py-1 pr-1 pl-3"
      onClick={() => openThread(threadId, title || undefined)}
      {...threadDragHandlers(threadId, title)}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {onToggle ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse forks" : "Expand forks"}
            aria-expanded={expanded}
            className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
          >
            {expanded ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <span
          className={cn(
            "min-w-0 truncate text-[10px] transition-colors duration-75",
            active
              ? "font-medium text-sidebar-foreground"
              : "text-sidebar-foreground/60 group-hover:text-sidebar-foreground"
          )}
        >
          {displayTitle}
        </span>
        {childCount > 0 ? (
          <span className="shrink-0 text-[9px] text-muted-foreground/50 tabular-nums">
            {childCount}
          </span>
        ) : null}
      </div>
      <AttentionBadge threadId={threadId} className="mr-1" />
      {isStreaming ? (
        <Spinner variant="bars" size={14} className="text-primary" />
      ) : (
        <span />
      )}
      <span className="px-1.5 text-[9px] whitespace-nowrap text-muted-foreground/50 tabular-nums">
        {timeAgo(updatedAt)}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 shrink-0 text-muted-foreground/35 transition-colors hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <EllipsisIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              handleRename(threadId, title)
            }}
          >
            <PencilIcon className="size-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              handleShare(threadId)
            }}
          >
            <CopyIcon className="size-3.5" />
            Copy to Clipboard
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation()
              handleArchive(threadId)
            }}
          >
            <ArchiveIcon className="size-3.5" />
            Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={(e) => {
              e.stopPropagation()
              if (onConfirm) {
                onConfirm({
                  title: "Delete chat?",
                  description: `"${title || "New Chat"}" will be permanently deleted.`,
                  action: () => deleteThread(threadId),
                })
              }
            }}
          >
            <Trash2Icon className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
