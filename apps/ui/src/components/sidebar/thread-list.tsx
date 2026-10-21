import { copyText } from "@/lib/clipboard"
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from "react"
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
import { CompareMarker } from "@/components/chat/compare-group"
import { useChatStore } from "@/lib/chat-store"
import { usePrompt } from "@/components/dialogs/prompt-provider"
import { useSettingsStore } from "@/lib/settings-store"
import { archiveChatDialog, runThreadAction } from "@/lib/thread-confirm"
import { timeAgo } from "@/lib/format"
import { shouldShowThreadInSidebar } from "@/lib/sidebar-thread-visibility"
import { THREAD_DRAG_TYPE } from "@/components/layout/panes/pane-drop-zone"
import { buildSessionTree, type SessionTreeNode } from "@/lib/session-tree"
import type { ChatThread } from "@betterc0de/schema"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { MENU_PANEL, MENU_WIDTH_MD } from "@/components/ui/menu-chrome"
import { useAttentionStore, useThreadAttention } from "@/lib/attention-store"
import { useThreadIsRunning } from "@/lib/chat/running-selectors"
import { useThreadPullRequest } from "@/lib/thread-pull-request"
import {
  ThreadDetailsCard,
  ThreadStatusGlyph,
} from "@/components/sidebar/thread-row-status"
import { archiveChats, deleteChats } from "@/lib/chat-list-actions"
import {
  openChatFromList,
  publishChatListOrder,
  releaseChatListOrder,
} from "@/lib/chat-list-nav"
import { useChatSelectionStore } from "@/lib/chat-list-selection"
import { partitionChatList } from "@/lib/chat-list-sections"
import { usePendingDeletesStore } from "@/lib/pending-thread-deletes"
import {
  ChatBackMark,
  ChatDraftMark,
  ChatJumpHint,
  ROW_FOCUS_CLASS,
  SELECTED_ROW_CLASS,
  useChatHasDraft,
  useChatJumpSlot,
  useChatRowBehavior,
  useClearBackWhenActive,
  useSnoozeWakeTick,
} from "@/components/sidebar/chat-row-behavior"
import { ChatOrganizeMenuItems } from "@/components/sidebar/chat-organize-menu"
import { ChatBulkBar } from "@/components/sidebar/chat-bulk-bar"
import { PinnedChats } from "@/components/sidebar/pinned-chats"
import { SnoozedSection } from "@/components/sidebar/snoozed-section"

const NO_IDS: ReadonlySet<string> = new Set()

type ChatState = ReturnType<typeof useChatStore.getState>

/** Ids of chats with an unsent draft (and below, running or waiting), as
 *  one string, so the list re-renders only when that set changes. */
function draftThreadIdsKey(state: ChatState): string {
  return Object.keys(state.draftsByThread)
    .filter((id) => (state.draftsByThread[id]?.trim().length ?? 0) > 0)
    .sort()
    .join("\n")
}

function streamingThreadIdsKey(state: ChatState): string {
  return Object.keys(state.streamingByThread)
    .filter((id) => state.streamingByThread[id]?.isStreaming)
    .sort()
    .join("\n")
}

function waitingThreadIdsKey(
  state: ReturnType<typeof useAttentionStore.getState>
): string {
  return Object.keys(state.byThread).sort().join("\n")
}

function idSet(key: string): Set<string> {
  return new Set(key ? key.split("\n") : [])
}

/** Visible rows of a session tree: each node, then its forks when open. */
function visibleTreeIds(nodes: SessionTreeNode<ChatThread>[]): string[] {
  return nodes.flatMap((node) => [
    node.id,
    ...(node.children.length > 0 && readSessionTreeExpanded(node.id)
      ? visibleTreeIds(node.children)
      : []),
  ])
}

function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set)
  if (!next.delete(key)) next.add(key)
  return next
}

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
 * Delete routes through the `onConfirm` callback so the parent can show a
 * shared confirmation dialog, then waits a few seconds for an undo
 * (`lib/pending-thread-deletes.ts`).
 *
 * Pinned chats lead the list in their own group, snoozed chats fold into a
 * Snoozed section at the bottom until they are due, and chats select with
 * Ctrl/Cmd+click and Shift+click for the bulk bar on top.
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
  const archivedThreadIds = useSettingsStore((s) => s.archivedThreadIds)
  const pinnedThreadIds = useSettingsStore((s) => s.pinnedThreadIds)
  const snoozedThreads = useSettingsStore((s) => s.snoozedThreads)
  const deletedIds = usePendingDeletesStore((s) => s.hidden)
  const draftKey = useChatStore(draftThreadIdsKey)
  const streamingKey = useChatStore(streamingThreadIdsKey)
  const waitingKey = useAttentionStore(waitingThreadIdsKey)
  // Open projects and those showing every chat, held here because they
  // decide the Ctrl/Cmd+number order. Projects start closed.
  const [openProjects, setOpenProjects] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [allShownProjects, setAllShownProjects] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const selecting = useChatSelectionStore((s) => s.ids.length > 0)
  useSnoozeWakeTick(snoozedThreads)

  /**
   * Opens a thread from the sidebar. Bug before this change: we only called
   * `setActiveThread`, which updates the store but leaves the composer-tab
   * bar untouched. If the tab for that thread had been closed earlier, the
   * main area would keep showing whatever the active tab was — the click
   * felt dead. `openChatFromList` also dispatches `betterc0de:open-thread`,
   * which lets the composer hook reuse or create a tab for this thread (see
   * use-composer-tabs.ts), and ends the chat's snooze.
   */
  const openThread = openChatFromList

  // Deletion waits a few seconds for an undo (lib/pending-thread-deletes).
  const deleteThread = useCallback((threadId: string) => {
    deleteChats([threadId])
  }, [])

  const toggleProject = useCallback(
    (projectName: string) =>
      setOpenProjects((current) => toggled(current, projectName)),
    []
  )
  const toggleShowAll = useCallback(
    (projectName: string) =>
      setAllShownProjects((current) => toggled(current, projectName)),
    []
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
    // `messages: []` until opened once, and an open thread holds only the
    // pages read so far — sharing used to copy only the header or the tail.
    // Load every page first (same pattern as forkThread), then re-read the
    // store for the filled-in messages.
    await useChatStore.getState().ensureFullThreadMessages(threadId)
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

  const handleArchive = useCallback(
    (threadId: string) => {
      const title = useChatStore
        .getState()
        .threads.find((thread) => thread.id === threadId)?.title
      runThreadAction(
        "archive",
        archiveChatDialog(title, () => {
          archiveChats([threadId])
        }),
        onConfirm
      )
    },
    [onConfirm]
  )

  const draftIds = useMemo(() => idSet(draftKey), [draftKey])

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
    // A chat that only has a draft (never sent) shows too, and one waiting
    // for its deletion's undo window does not.
    if (deletedIds[t.id]) return false
    const isHydrated = messagesLoadedByThread[t.id] === true
    if (!shouldShowThreadInSidebar(t, isHydrated) && !draftIds.has(t.id)) {
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

  // Separate swarm threads from regular threads
  const swarmThreads = filtered.filter((t) => t.title?.startsWith("[Swarm:"))
  const regularCandidates = filtered.filter(
    (t) => !t.title?.startsWith("[Swarm:")
  )

  // Pinned chats lead the list and snoozed ones wait at the bottom; neither
  // shows in its project. The folder list has no Inactive section.
  const runningIds = idSet(streamingKey)
  for (const thread of regularCandidates) {
    if (thread.session?.activeTurnId) runningIds.add(thread.id)
  }
  const sections = partitionChatList({
    threads: regularCandidates,
    pinnedIds: pinnedThreadIds,
    filedIds: null,
    snoozes: snoozedThreads,
    runningIds,
    waitingIds: idSet(waitingKey),
    closedPullRequestIds: NO_IDS,
    now,
    settleAfterMs: Number.POSITIVE_INFINITY,
  })
  const regularThreads = regularCandidates.filter(
    (thread) => !sections.hidden.has(thread.id)
  )

  // Group regular threads by projectName
  const projectGroups = new Map<string, typeof threads>()
  for (const thread of regularThreads) {
    const key = thread.projectName || "BetterC0de"
    if (!projectGroups.has(key)) projectGroups.set(key, [])
    projectGroups.get(key)!.push(thread)
  }

  // The visible order, for Ctrl/Cmd+1…9 and Shift+click ranges: pinned
  // chats, then the rows of open projects (with their open forks).
  const orderKey = [
    ...sections.pinned.map((thread) => thread.id),
    ...Array.from(projectGroups.entries()).flatMap(
      ([projectName, projectThreads]) => {
        if (!openProjects.has(projectName)) return []
        const tree = buildSessionTree(projectThreads)
        return visibleTreeIds(
          !minimal || allShownProjects.has(projectName)
            ? tree
            : tree.slice(0, PROJECT_VISIBLE_THREADS)
        )
      }
    ),
  ].join("\n")
  useEffect(() => {
    publishChatListOrder("folders", orderKey ? orderKey.split("\n") : [])
  }, [orderKey])
  useEffect(() => () => releaseChatListOrder("folders"), [])

  // A selection keeps only chats the list still shows, and ends with it.
  const listedKey = regularCandidates
    .filter(
      (thread) => !sections.snoozed.some((s) => s.thread.id === thread.id)
    )
    .map((thread) => thread.id)
    .join("\n")
  useEffect(() => {
    useChatSelectionStore.getState().prune(idSet(listedKey))
  }, [listedKey])
  useEffect(() => () => useChatSelectionStore.getState().clear(), [])

  if (filtered.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/40">
        {search.trim()
          ? `No chats matching "${search.trim()}"`
          : "No conversations yet"}
      </div>
    )
  }

  const rowCallbacks = {
    openThread,
    handleRename,
    handleShare,
    handleArchive,
    deleteThread,
    onConfirm,
  }

  // Stays in view while the list scrolls under it.
  const bulkBar = selecting ? (
    <div className="sticky top-0 z-10 bg-sidebar pt-0.5">
      <ChatBulkBar backIds={sections.back} onConfirm={onConfirm} />
    </div>
  ) : null

  const snoozedSection = (
    <SnoozedSection
      items={sections.snoozed}
      openThread={openThread}
      className={minimal ? "px-2 pt-2" : "pt-2"}
    />
  )

  if (minimal) {
    // Simple UI mode — threads grouped under their project folder as
    // collapsible folders, but with the minimal styling from the rest
    // of the sidebar (no dividers, clean foreground colors, compact
    // row heights, left-aligned at 12 px to match quick actions).
    return (
      <>
        {bulkBar}
        <PinnedChats
          threads={sections.pinned}
          className="px-2"
          renderRow={(thread) => (
            <ThreadListRow
              thread={thread}
              threadId={thread.id}
              title={thread.title}
              back={sections.back.has(thread.id)}
              {...rowCallbacks}
            />
          )}
        />
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
              expanded={openProjects.has(projectName)}
              showAll={allShownProjects.has(projectName)}
              onToggleExpanded={toggleProject}
              onToggleShowAll={toggleShowAll}
              backIds={sections.back}
              openThread={openThread}
              handleRename={handleRename}
              handleShare={handleShare}
              handleArchive={handleArchive}
              deleteThread={deleteThread}
              onConfirm={onConfirm}
            />
          )
        )}
        {snoozedSection}
      </>
    )
  }

  return (
    <>
      {bulkBar}
      <PinnedChats
        threads={sections.pinned}
        renderRow={(thread) => (
          <ExtendedProjectRow
            threadId={thread.id}
            title={thread.title}
            updatedAt={thread.updatedAt}
            back={sections.back.has(thread.id)}
            {...rowCallbacks}
          />
        )}
      />
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
          <Collapsible
            key={projectName}
            open={openProjects.has(projectName)}
            onOpenChange={() => toggleProject(projectName)}
          >
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
                          description: `All ${projectThreads.length} chat(s) in "${projectName}" will be deleted. Undo is available for a few seconds.`,
                          action: () => {
                            deleteChats(projectThreads.map((t) => t.id))
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
                <div
                  role="listbox"
                  aria-label={projectName}
                  aria-multiselectable="true"
                  className="ml-3 border-l border-border/50 pl-1"
                >
                  <SessionTreeRows
                    nodes={buildSessionTree(projectThreads)}
                    variant="extended"
                    backIds={sections.back}
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
      {snoozedSection}
    </>
  )
}

/** How many threads a project shows before folding behind "Show more". */
const PROJECT_VISIBLE_THREADS = 5

interface ProjectSectionProps {
  projectName: string
  threads: ChatThread[]
  /** Open, and showing every chat (both held by the list). */
  expanded: boolean
  showAll: boolean
  onToggleExpanded: (projectName: string) => void
  onToggleShowAll: (projectName: string) => void
  /** Chats back from a snooze, which carry a mark. */
  backIds: ReadonlySet<string>
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
  expanded,
  showAll,
  onToggleExpanded,
  onToggleShowAll,
  backIds,
  openThread,
  handleRename,
  handleShare,
  handleArchive,
  deleteThread,
  onConfirm,
}: ProjectSectionProps) {
  // Sections start COLLAPSED — the folder row is the toggle; chats only
  // show once the user opens a project.
  const containsActive = useChatStore((s) =>
    threads.some((t) => t.id === s.activeThreadId)
  )
  const sessionTree = useMemo(() => buildSessionTree(threads), [threads])
  const visible = showAll
    ? sessionTree
    : sessionTree.slice(0, PROJECT_VISIBLE_THREADS)

  return (
    <div className="px-2 pb-1">
      {/* The fill spans the whole row, actions included, so its right edge
          lines up with the chat rows below. */}
      <div
        className={cn(
          "group/project flex w-full items-center rounded-md pr-1 transition-colors duration-75 hover:bg-foreground/[0.06]",
          containsActive && "bg-foreground/[0.07]"
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onToggleExpanded(projectName)}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
        >
          {expanded ? (
            <FolderOpenIcon
              className="size-3.5 shrink-0 text-sidebar-foreground/70"
              strokeWidth={1.75}
            />
          ) : (
            <FolderIcon
              className="size-3.5 shrink-0 text-sidebar-foreground/60"
              strokeWidth={1.75}
            />
          )}
          <span className="truncate text-[12px] font-medium text-sidebar-foreground/90">
            {projectName}
          </span>
          <span className="ml-auto shrink-0 text-[10px] text-sidebar-foreground/35 tabular-nums">
            {threads.length}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${projectName} actions`}
              className="ml-0.5 size-5 shrink-0 text-muted-foreground/50 opacity-0 transition-[color,opacity] group-hover/project:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
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
                    description: `All ${threads.length} chat(s) in "${projectName}" will be deleted. Undo is available for a few seconds.`,
                    action: () => {
                      deleteChats(threads.map((t) => t.id))
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
          // Chat titles start under the project name; a guide line under the
          // folder icon ties them to their project.
          <div className="relative space-y-px pt-0.5">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0.5 bottom-1 left-[14.5px] w-px bg-sidebar-border/70"
            />
            <div
              role="listbox"
              aria-label={projectName}
              aria-multiselectable="true"
              className="space-y-px"
            >
              <SessionTreeRows
                nodes={visible}
                variant="minimal"
                backIds={backIds}
                openThread={openThread}
                handleRename={handleRename}
                handleShare={handleShare}
                handleArchive={handleArchive}
                deleteThread={deleteThread}
                onConfirm={onConfirm}
              />
            </div>
            {sessionTree.length > PROJECT_VISIBLE_THREADS && (
              <button
                type="button"
                aria-expanded={showAll}
                onClick={() => onToggleShowAll(projectName)}
                className="flex h-6 cursor-pointer items-center gap-1 pl-[30px] text-left text-[11px] text-sidebar-foreground/40 transition-colors duration-75 hover:text-sidebar-foreground"
              >
                {showAll
                  ? "Show less"
                  : `Show ${sessionTree.length - PROJECT_VISIBLE_THREADS} more`}
                <ChevronDownIcon
                  className={cn(
                    "size-3 transition-transform duration-150",
                    showAll && "rotate-180"
                  )}
                />
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
  /** Chats back from a snooze, which carry a mark. */
  backIds: ReadonlySet<string>
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
  backIds,
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
    thread: node.value,
    threadId: node.value.id,
    title: node.value.title,
    childCount: node.children.length,
    expanded,
    onToggle: hasChildren ? toggle : undefined,
    back: backIds.has(node.value.id),
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
            backIds={backIds}
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
  thread: ChatThread
  threadId: string
  title: string
  childCount?: number
  expanded?: boolean
  onToggle?: () => void
  /** Back from a snooze and not opened yet. */
  back?: boolean
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
  thread,
  threadId,
  title,
  childCount = 0,
  expanded = true,
  onToggle,
  back = false,
  openThread,
  handleRename,
  handleShare,
  handleArchive,
  deleteThread,
  onConfirm,
}: ThreadListRowProps) {
  const active = useChatStore((s) => s.activeThreadId === threadId)
  // Includes turns the backend still holds open (another device, or a stream
  // that has not reattached yet).
  const isRunning = useThreadIsRunning(threadId)
  const attention = useThreadAttention(threadId)
  const attentionEnabled = useSettingsStore((s) => s.attentionBadges)
  const { selected, menuOpen, setMenuOpen, rowProps } = useChatRowBehavior({
    threadId,
    title,
    openThread,
  })
  const draft = useChatHasDraft(threadId)
  const slot = useChatJumpSlot(threadId)
  useClearBackWhenActive(threadId, active, back)
  const pullRequest = useThreadPullRequest(
    thread.projectPath || thread.worktreePath,
    thread.branch
  )
  const displayTitle = title || "New Task"
  const truncated =
    displayTitle.length > 34 ? displayTitle.slice(0, 34) + "…" : displayTitle
  return (
    <HoverCard openDelay={450} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            // The status glyph sits in the folder icon's 14px column, on the
            // guide line, so titles start exactly under the project name
            // (8px + 14px + 8px gap).
            "group relative flex h-[26px] cursor-pointer items-center gap-2 rounded-md pr-1 pl-2 transition-colors duration-75",
            ROW_FOCUS_CLASS,
            selected
              ? SELECTED_ROW_CLASS
              : active
                ? "bg-foreground/[0.06]"
                : "hover:bg-foreground/[0.04]"
          )}
          {...rowProps}
        >
          <ThreadStatusGlyph
            running={isRunning}
            waiting={attentionEnabled && (attention?.total ?? 0) > 0}
            pullRequest={pullRequest}
            active={active}
            threadId={threadId}
          />
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
          {back ? <ChatBackMark /> : null}
          {draft ? <ChatDraftMark /> : null}
          {slot !== null ? <ChatJumpHint slot={slot} /> : null}
          {pullRequest ? (
            <span className="shrink-0 text-[9.5px] text-sidebar-foreground/45 tabular-nums">
              #{pullRequest.number}
            </span>
          ) : null}
          {onToggle ? (
            <button
              type="button"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${childCount} forks`}
              aria-expanded={expanded}
              className="flex h-4 shrink-0 items-center gap-0.5 rounded px-0.5 text-[9px] text-sidebar-foreground/45 tabular-nums hover:bg-foreground/[0.06] hover:text-sidebar-foreground"
              onClick={(event) => {
                event.stopPropagation()
                onToggle()
              }}
            >
              {childCount}
              {expanded ? (
                <ChevronDownIcon className="size-3" />
              ) : (
                <ChevronRightIcon className="size-3" />
              )}
            </button>
          ) : null}
          <CompareMarker threadId={threadId} />
          <AttentionBadge threadId={threadId} className="shrink-0" />
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${displayTitle} actions`}
                className="size-5 shrink-0 text-muted-foreground/50 opacity-0 transition-[color,opacity] group-hover:opacity-100 group-focus-visible:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <EllipsisIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right">
              <ChatOrganizeMenuItems threadId={threadId} />
              <DropdownMenuSeparator />
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
                  runThreadAction(
                    "delete",
                    {
                      title: "Delete chat?",
                      description: `"${title || "New Chat"}" will be deleted. Undo is available for a few seconds.`,
                      action: () => deleteThread(threadId),
                    },
                    onConfirm
                  )
                }}
              >
                <Trash2Icon className="size-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={10}
        collisionPadding={12}
        className={cn(MENU_PANEL, MENU_WIDTH_MD)}
        onClick={(event) => event.stopPropagation()}
      >
        <ThreadDetailsCard
          thread={thread}
          pullRequest={pullRequest}
          running={isRunning}
        />
      </HoverCardContent>
    </HoverCard>
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
  /** Back from a snooze and not opened yet. */
  back?: boolean
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
  back = false,
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
  const { selected, menuOpen, setMenuOpen, rowProps } = useChatRowBehavior({
    threadId,
    title,
    openThread,
  })
  const draft = useChatHasDraft(threadId)
  const slot = useChatJumpSlot(threadId)
  useClearBackWhenActive(threadId, active, back)
  const raw = title || "New Chat"
  const displayTitle = raw.length > 40 ? raw.slice(0, 40) + "..." : raw
  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center rounded-md py-1 pr-1 pl-3",
        ROW_FOCUS_CLASS,
        selected && SELECTED_ROW_CLASS
      )}
      {...rowProps}
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
        {back ? <ChatBackMark className="ml-1" /> : null}
        {draft ? <ChatDraftMark className="ml-1" /> : null}
      </div>
      <AttentionBadge threadId={threadId} className="mr-1" />
      {isStreaming ? (
        <Spinner variant="bars" size={14} className="text-primary" />
      ) : (
        <span />
      )}
      {slot !== null ? (
        <ChatJumpHint slot={slot} className="mx-1.5" />
      ) : (
        <span className="px-1.5 text-[9px] whitespace-nowrap text-muted-foreground/50 tabular-nums">
          {timeAgo(updatedAt)}
        </span>
      )}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${raw} actions`}
            className="size-5 shrink-0 text-muted-foreground/35 transition-colors hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <EllipsisIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <ChatOrganizeMenuItems threadId={threadId} />
          <DropdownMenuSeparator />
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
              runThreadAction(
                "delete",
                {
                  title: "Delete chat?",
                  description: `"${title || "New Chat"}" will be deleted. Undo is available for a few seconds.`,
                  action: () => deleteThread(threadId),
                },
                onConfirm
              )
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
