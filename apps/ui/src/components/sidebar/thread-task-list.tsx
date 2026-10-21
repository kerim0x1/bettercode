import { copyText } from "@/lib/clipboard"
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import {
  ArchiveIcon,
  ChevronDownIcon,
  Clock3Icon,
  CopyIcon,
  EllipsisIcon,
  FolderIcon,
  FolderInputIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  GitBranchIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/kibo-ui/spinner"
import { AttentionBadge } from "@/components/attention/attention-badge"
import { CompareMarker } from "@/components/chat/compare-group"
import { useChatStore } from "@/lib/chat-store"
import { usePrompt } from "@/components/dialogs/prompt-provider"
import {
  useThreadIsRunning,
  useThreadRunningElapsed,
} from "@/lib/chat/running-selectors"
import { isLimitedNow } from "@/lib/chat-resume"
import {
  useChatResumeStore,
  useThreadLimitLabel,
} from "@/lib/chat-resume-store"
import { useSettingsStore } from "@/lib/settings-store"
import { archiveChatDialog, runThreadAction } from "@/lib/thread-confirm"
import { shouldShowThreadInSidebar } from "@/lib/sidebar-thread-visibility"
import { builtinProviders } from "@/lib/builtin-providers"
import { getModelInfo } from "@/lib/get-model-info"
import { logoNeedsDarkInvert } from "@/lib/logo-invert"
import type { ChatThread } from "@betterc0de/schema"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { MENU_PANEL, MENU_WIDTH_MD } from "@/components/ui/menu-chrome"
import { useThreadPullRequest } from "@/lib/thread-pull-request"
import type { GitPullRequest } from "@/services/backend/gitApi"
import {
  addChatFolder,
  canAddChatFolder,
  chatFolderName,
  folderOfThread,
  moveChatFolder,
  newChatFolderId,
  renameChatFolder,
  shiftChatFolder,
  type ChatFolder,
} from "@/lib/chat-folders"
import {
  TaskFolders,
  type ChatFolderPlacement,
} from "@/components/sidebar/task-folders"
import { useAttentionStore, useThreadAttention } from "@/lib/attention-store"
import {
  PullRequestBadge,
  ThreadDetailsCard,
  ThreadStatusGlyph,
} from "@/components/sidebar/thread-row-status"
import {
  archiveChats,
  deleteChats,
  moveChatsToFolder,
  removeChatFolderWithUndo,
} from "@/lib/chat-list-actions"
import {
  openChatFromList,
  publishChatListOrder,
  releaseChatListOrder,
} from "@/lib/chat-list-nav"
import { useChatSelectionStore } from "@/lib/chat-list-selection"
import {
  partitionChatList,
  pullRequestSettleCandidates,
} from "@/lib/chat-list-sections"
import { useClosedPullRequestThreadIds } from "@/lib/chat-list-pull-requests"
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

/**
 * Flat "task feed" layout for the agent sidebar — an alternative to the
 * project-folder tree in {@link SidebarThreadList}, switched via the
 * `chatSidebarLayout` appearance setting.
 *
 * Each chat renders as a card echoing a code-agent task list:
 *   [model logo]  repo-name                         · 2h / Working
 *   Thread title (bold)
 *   [model name]  [⎇ branch]  [⇄ #PR]
 *   [folder] shortened working-directory path
 *
 * The model shown is the real one the thread last answered with (last
 * assistant message's `modelId`), falling back to the thread's selected
 * model — not just the provider. Cards sort newest-first and narrow to a
 * single project via the header dropdown; the active thread gets a filled
 * card, the rest a quiet hairline row. The branch's pull request comes from
 * the GitHub CLI (`lib/thread-pull-request.ts`); hovering a card opens the
 * same details card as the project list.
 *
 * The `compact` variant (`chatSidebarLayout: "compact"`) keeps the feed,
 * header and filter but draws each chat as two quiet lines: the status
 * glyph and title, then repo, branch, pull request and model beneath.
 *
 * The compact variant also keeps the user's own folders above the feed
 * (`task-folders.tsx`, stored in `settings.chat_folders`): their chats stay
 * in place, in the user's order, and never go inactive.
 *
 * Both variants start with the user's pinned chats (`pinned-chats.tsx`) and
 * leave snoozed chats out until they are due (`lib/chat-list-sections.ts`);
 * a chat back from a snooze leads the feed with a Back mark. Chats select
 * with Ctrl/Cmd+click and Shift+click for the bulk bar on top.
 *
 * In both variants a chat untouched for a day, or whose pull request was
 * merged or closed, settles: it leaves the feed for the collapsible
 * "Inactive" section at the bottom, dimmed. A chat that is working, waiting
 * for you or held by a usage limit never settles. Snoozed chats fold below
 * it.
 */

const SETTLED_OPEN_STORAGE_KEY = "betterc0de:sidebar:settled-open"
const NO_IDS: ReadonlySet<string> = new Set()

type ChatState = ReturnType<typeof useChatStore.getState>

/** Ids of chats streaming here, as one string, so the list re-renders only
 *  when a chat starts or stops, not on every streamed token. */
function streamingThreadIdsKey(state: ChatState): string {
  return Object.keys(state.streamingByThread)
    .filter((id) => state.streamingByThread[id]?.isStreaming)
    .sort()
    .join("\n")
}

/** Ids of chats with an unsent draft, as one string (see above). */
function draftThreadIdsKey(state: ChatState): string {
  return Object.keys(state.draftsByThread)
    .filter((id) => (state.draftsByThread[id]?.trim().length ?? 0) > 0)
    .sort()
    .join("\n")
}

/** Ids of chats waiting for an answer, as one string (see above). */
function waitingThreadIdsKey(
  state: ReturnType<typeof useAttentionStore.getState>
): string {
  return Object.keys(state.byThread).sort().join("\n")
}

function idSet(key: string): Set<string> {
  return new Set(key ? key.split("\n") : [])
}

/** Two letters for a project's tile: the first letters of its first and
 *  last word ("Neuer Ordner (2)" → N2), or a single word's first and last
 *  letter ("Documents" → DS). */
function projectInitials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length > 1) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase()
  }
  const word = words[0]
  return (
    word[0] + (word.length > 1 ? word[word.length - 1] : "")
  ).toUpperCase()
}

function readSettledOpen(): boolean {
  try {
    return window.localStorage.getItem(SETTLED_OPEN_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

function writeSettledOpen(open: boolean): void {
  try {
    window.localStorage.setItem(SETTLED_OPEN_STORAGE_KEY, String(open))
  } catch {
    // Storage is optional; the section still folds for this session.
  }
}

/** Compact relative time without the trailing "ago" (e.g. "36m", "2h"). */
function shortAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

/** Provider logo + label for a thread's session provider kind (fallback when
 *  no concrete model is known). */
function providerPresentation(providerKind?: string | null): {
  logo: string
  label: string
} {
  const key = (providerKind ?? "").toLowerCase()
  const match = builtinProviders.find(
    (p) => (p.providerKind ?? p.id).toLowerCase() === key
  )
  return { logo: match?.logo ?? "", label: match?.name ?? "" }
}

/** Logo and name of the thread's model for a row's meta line. The logo
 *  already says Claude, so "Opus 5.5" leaves the branch more room. */
function modelPresentation(
  modelId?: string,
  providerKind?: string | null
): { logo: string; name: string } {
  const modelInfo = getModelInfo(modelId)
  const provider = providerPresentation(providerKind)
  return {
    logo: modelInfo?.logo || provider.logo,
    name: modelInfo
      ? modelInfo.name.replace(/^Claude (?=[A-Z])/, "")
      : provider.label,
  }
}

/** Short branch label: explicit branch, else the worktree folder name. */
function branchLabel(thread: {
  branch?: string | null
  worktreePath?: string | null
}): string | null {
  if (thread.branch) return thread.branch
  if (thread.worktreePath) {
    return thread.worktreePath.split(/[/\\]/).pop() || null
  }
  return null
}

/** Keep the meaningful tail of a path (…/parent/project), ~2 trailing
 *  segments, so the working directory reads at a glance in a narrow column. */
function shortPath(path?: string | null): string | null {
  if (!path) return null
  const segments = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/")
  const clean = segments.filter(Boolean)
  if (clean.length === 0) return null
  const tail = clean.slice(-2).join("/")
  return clean.length > 2 ? `…/${tail}` : tail
}

/** The model the thread most recently answered with, else its selected
 *  model. Skeleton (unhydrated) threads have no messages, so the selected
 *  model from thread settings is the reliable fallback. */
function threadModelId(
  thread: ChatThread,
  selectedModel: string | undefined
): string | undefined {
  const messages = thread.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "assistant" && m.modelId) return m.modelId
  }
  return selectedModel
}

export function SidebarTaskList({
  search = "",
  variant = "cards",
  onConfirm,
  onNewThread,
}: {
  search?: string
  /** Cards, or two-line rows for a denser list. */
  variant?: "cards" | "compact"
  onConfirm?: (opts: {
    title: string
    description: string
    action: () => void
  }) => void
  onNewThread?: () => void
}) {
  const threads = useChatStore((s) => s.threads)
  const messagesLoadedByThread = useChatStore((s) => s.messagesLoadedByThread)
  const settingsByThread = useChatStore((s) => s.settingsByThread)
  const archivedThreadIds = useSettingsStore((s) => s.archivedThreadIds)
  const chatFolders = useSettingsStore((s) => s.chatFolders)
  const pinnedThreadIds = useSettingsStore((s) => s.pinnedThreadIds)
  const snoozedThreads = useSettingsStore((s) => s.snoozedThreads)
  const deletedIds = usePendingDeletesStore((s) => s.hidden)
  const draftKey = useChatStore(draftThreadIdsKey)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [settledOpen, setSettledOpen] = useState(readSettledOpen)
  const [folderOrder, setFolderOrder] = useState<string[]>([])
  const prompt = usePrompt()
  const compact = variant === "compact"
  useSnoozeWakeTick(snoozedThreads)

  // Folder edits read the store at call time, so quick successive edits
  // build on each other instead of on the list this render saw.
  const saveFolders = useCallback(
    (edit: (folders: ChatFolder[]) => ChatFolder[]) => {
      const settings = useSettingsStore.getState()
      const next = edit(settings.chatFolders)
      if (next !== settings.chatFolders) {
        void settings.update({ chat_folders: next })
      }
    },
    []
  )

  // Filing goes through the undoable actions; filing a pinned chat unpins it.
  const placeThreads = useCallback(
    (threadIds: string[], placement: ChatFolderPlacement) =>
      moveChatsToFolder(threadIds, placement),
    []
  )

  const moveToFolder = useCallback(
    (threadId: string, folderId: string | null) =>
      moveChatsToFolder([threadId], folderId ? { folderId } : null),
    []
  )

  const newFolder = useCallback(
    async (threadIds?: string[]) => {
      if (!canAddChatFolder(useSettingsStore.getState().chatFolders)) return
      const count = threadIds?.length ?? 0
      const raw = await prompt({
        title: "New folder",
        description:
          count === 0
            ? "Drag chats onto it, or use a chat's Move to folder."
            : count === 1
              ? "The chat moves into it."
              : `The ${count} chats move into it.`,
        placeholder: "Folder name",
        confirmLabel: "Create",
      })
      const name = raw ? chatFolderName(raw) : null
      if (!name) return
      const folderId = newChatFolderId()
      saveFolders((folders) => addChatFolder(folders, { id: folderId, name }))
      if (threadIds && threadIds.length > 0) {
        moveChatsToFolder(threadIds, { folderId })
        useChatSelectionStore.getState().clear()
      }
    },
    [prompt, saveFolders]
  )

  const renameFolder = useCallback(
    async (folderId: string) => {
      const folder = useSettingsStore
        .getState()
        .chatFolders.find((entry) => entry.id === folderId)
      if (!folder) return
      const raw = await prompt({
        title: "Rename folder",
        defaultValue: folder.name,
        confirmLabel: "Rename",
      })
      const name = raw ? chatFolderName(raw) : null
      if (!name) return
      saveFolders((folders) => renameChatFolder(folders, folderId, name))
    },
    [prompt, saveFolders]
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

  const handleShare = useCallback((threadId: string) => {
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

  // Deletion waits a few seconds for an undo (lib/pending-thread-deletes).
  const handleDelete = useCallback((threadId: string) => {
    deleteChats([threadId])
  }, [])

  // A chat that only has a draft (a new chat never sent) shows too.
  const draftIds = useMemo(() => idSet(draftKey), [draftKey])
  const visibleThreads = useMemo(() => {
    const q = search.trim().toLowerCase()
    return threads
      .filter((t) => {
        if (t.title?.startsWith("__inline-edit-")) return false
        if (deletedIds[t.id]) return false
        const isHydrated = messagesLoadedByThread[t.id] === true
        if (!shouldShowThreadInSidebar(t, isHydrated) && !draftIds.has(t.id)) {
          return false
        }
        if (archivedThreadIds.includes(t.id)) return false
        if (t.title?.startsWith("[Swarm:")) return false
        if (q) {
          const matchTitle = t.title?.toLowerCase().includes(q)
          const matchProject = t.projectName?.toLowerCase().includes(q)
          if (!matchTitle && !matchProject) return false
        }
        return true
      })
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
  }, [
    threads,
    messagesLoadedByThread,
    archivedThreadIds,
    search,
    deletedIds,
    draftIds,
  ])

  const projectNames = useMemo(() => {
    const names = new Set<string>()
    for (const t of visibleThreads) names.add(t.projectName || "BetterC0de")
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [visibleThreads])

  const shown = projectFilter
    ? visibleThreads.filter(
        (t) => (t.projectName || "BetterC0de") === projectFilter
      )
    : visibleThreads

  // Working and waiting chats stay in the feed however old their last
  // update is, and so do chats a usage limit holds: they resume by
  // themselves, and only the feed's rows show "Limited". The rest settle
  // after a day or once their pull request is merged or closed. Pinned,
  // filed and snoozed chats have their own place.
  const streamingKey = useChatStore(streamingThreadIdsKey)
  const waitingKey = useAttentionStore(waitingThreadIdsKey)
  const resumes = useChatResumeStore((s) => s.byThread)
  const now = Date.now()
  const runningIds = idSet(streamingKey)
  for (const thread of shown) {
    if (thread.session?.activeTurnId || isLimitedNow(resumes[thread.id], now)) {
      runningIds.add(thread.id)
    }
  }
  const sectionInput = {
    threads: shown,
    pinnedIds: pinnedThreadIds,
    // Chats in a folder show there, not in the feed (compact only).
    filedIds: compact
      ? new Set(chatFolders.flatMap((folder) => folder.thread_ids))
      : null,
    snoozes: snoozedThreads,
    runningIds,
    waitingIds: idSet(waitingKey),
    now,
  }
  const firstPass = partitionChatList({
    ...sectionInput,
    closedPullRequestIds: NO_IDS,
  })
  // Only chats a pull request could still settle are watched.
  const closedPullRequestIds = useClosedPullRequestThreadIds(
    pullRequestSettleCandidates(firstPass, sectionInput)
  )
  const sections =
    closedPullRequestIds.size > 0
      ? partitionChatList({ ...sectionInput, closedPullRequestIds })
      : firstPass

  // The visible order, for Ctrl/Cmd+1…9 and Shift+click ranges.
  const orderKey = [
    ...sections.pinned.map((thread) => thread.id),
    ...(compact ? folderOrder : []),
    ...sections.recent.map((thread) => thread.id),
    ...(settledOpen ? sections.settled.map((thread) => thread.id) : []),
  ].join("\n")
  useEffect(() => {
    publishChatListOrder(variant, orderKey ? orderKey.split("\n") : [])
  }, [variant, orderKey])
  useEffect(() => () => releaseChatListOrder(variant), [variant])

  // A selection keeps only chats the list still shows (not snoozed,
  // archived, deleted or filtered away), and ends with the layout.
  const snoozedIds = new Set(sections.snoozed.map((entry) => entry.thread.id))
  const listedKey = shown
    .filter((thread) => !snoozedIds.has(thread.id))
    .map((thread) => thread.id)
    .join("\n")
  useEffect(() => {
    useChatSelectionStore.getState().prune(idSet(listedKey))
  }, [listedKey])
  useEffect(() => () => useChatSelectionStore.getState().clear(), [])

  const taskProps = (thread: ChatThread): TaskCardProps => ({
    thread,
    threadId: thread.id,
    title: thread.title,
    projectName: thread.projectName || "BetterC0de",
    projectPath: thread.worktreePath || thread.projectPath,
    branch: branchLabel(thread),
    providerKind: thread.session?.providerKind,
    modelId: threadModelId(thread, settingsByThread[thread.id]?.selectedModel),
    isWorktree: !!thread.worktreePath,
    updatedAt: thread.updatedAt,
    back: sections.back.has(thread.id),
    openThread: openChatFromList,
    handleRename,
    handleShare,
    handleArchive,
    deleteThread: handleDelete,
    onConfirm,
    ...(compact
      ? {
          folders: chatFolders,
          onMoveToFolder: moveToFolder,
          onNewFolder: newFolder,
        }
      : {}),
  })

  const renderItem = (thread: ChatThread, guided = false) =>
    compact ? (
      <TaskRow key={thread.id} {...taskProps(thread)} guided={guided} />
    ) : (
      <TaskCard key={thread.id} {...taskProps(thread)} />
    )

  const filtering = Boolean(projectFilter || search.trim())
  // Folders show even before the first chat, unless a filter hides them.
  const empty =
    shown.length === 0 && !(compact && chatFolders.length > 0 && !filtering)

  const pinnedGroup = (
    <PinnedChats
      threads={sections.pinned}
      cards={!compact}
      renderRow={(thread) => renderItem(thread)}
    />
  )

  const feed = (
    <>
      {!compact && sections.pinned.length > 0 ? (
        <div className="flex h-7 items-center px-2 pt-1 text-[11px] font-medium text-sidebar-foreground/45">
          Chats
        </div>
      ) : null}
      <div
        role="listbox"
        aria-label="Chats"
        aria-multiselectable="true"
        className={cn("flex flex-col", compact ? "gap-px" : "gap-1")}
      >
        {sections.recent.map((thread) => renderItem(thread))}
      </div>
      {sections.settled.length > 0 || sections.snoozed.length > 0 ? (
        // Sits at the bottom of the column while the feed above is short.
        <div className={sections.recent.length > 0 ? "mt-auto pt-4" : "pt-1"}>
          {sections.settled.length > 0 ? (
            <SettledSection
              items={sections.settled.map(taskProps)}
              variant={variant}
              open={settledOpen}
              onToggle={() =>
                setSettledOpen((current) => {
                  writeSettledOpen(!current)
                  return !current
                })
              }
            />
          ) : null}
          <SnoozedSection
            items={sections.snoozed}
            openThread={openChatFromList}
          />
        </div>
      ) : null}
    </>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: project filter + new-thread action. */}
      <div className="flex items-center gap-1 px-3 pt-1 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 min-w-0 flex-1 justify-start gap-1.5 px-1.5 text-[12px] font-medium text-sidebar-foreground hover:bg-foreground/[0.06]"
            >
              <span className="truncate">
                {projectFilter ?? "All projects"}
              </span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[190px]">
            <DropdownMenuCheckboxItem
              checked={projectFilter === null}
              onCheckedChange={() => setProjectFilter(null)}
            >
              All projects
            </DropdownMenuCheckboxItem>
            {projectNames.length > 0 && <DropdownMenuSeparator />}
            {projectNames.map((name) => (
              <DropdownMenuCheckboxItem
                key={name}
                checked={projectFilter === name}
                onCheckedChange={() => setProjectFilter(name)}
              >
                <span className="truncate">{name}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {compact ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New folder"
            title="New folder"
            disabled={!canAddChatFolder(chatFolders)}
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => void newFolder()}
          >
            <FolderPlusIcon className="size-4" />
          </Button>
        ) : null}
        {onNewThread && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New chat"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onNewThread}
          >
            <PlusIcon className="size-4" />
          </Button>
        )}
      </div>

      <ChatBulkBar
        folders={compact ? chatFolders : undefined}
        backIds={sections.back}
        onNewFolder={compact ? (ids) => void newFolder(ids) : undefined}
        onConfirm={onConfirm}
      />

      <div
        data-chat-list=""
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {empty ? (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/40">
            {search.trim()
              ? `No chats matching "${search.trim()}"`
              : "No conversations yet"}
          </div>
        ) : compact ? (
          <TaskFolders
            folders={chatFolders}
            threadsById={
              new Map(
                shown
                  .filter((thread) => !sections.hidden.has(thread.id))
                  .map((thread) => [thread.id, thread])
              )
            }
            filtering={filtering}
            header={pinnedGroup}
            labelFeed={sections.pinned.length > 0}
            renderRow={(thread) => renderItem(thread, true)}
            onPlaceThreads={placeThreads}
            onMoveFolder={(folderId, beforeId) =>
              saveFolders((folders) =>
                moveChatFolder(folders, folderId, beforeId)
              )
            }
            onShiftFolder={(folderId, step) =>
              saveFolders((folders) => shiftChatFolder(folders, folderId, step))
            }
            onRenameFolder={(folderId) => void renameFolder(folderId)}
            onRemoveFolder={removeChatFolderWithUndo}
            onVisibleOrderChange={setFolderOrder}
          >
            {feed}
          </TaskFolders>
        ) : (
          <div className="flex min-h-full flex-col">
            {pinnedGroup}
            {feed}
          </div>
        )}
      </div>
    </div>
  )
}

interface TaskCardProps {
  thread: ChatThread
  threadId: string
  title: string
  projectName: string
  projectPath?: string | null
  branch: string | null
  providerKind?: string | null
  modelId?: string
  isWorktree: boolean
  updatedAt: string
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
  /** Compact list: the folders, for the menu's Move to folder. */
  folders?: ChatFolder[]
  onMoveToFolder?: (threadId: string, folderId: string | null) => void
  onNewFolder?: (threadIds?: string[]) => void
  /** Inside a folder: the status glyph masks the folder's guide line. */
  guided?: boolean
}

/** Pin and Snooze, in the compact list Move to folder, then rename, copy,
 *  archive and delete; shared by the card and the rows. */
function TaskActionsMenuItems({
  threadId,
  title,
  handleRename,
  handleShare,
  handleArchive,
  deleteThread,
  onConfirm,
  folders,
  onMoveToFolder,
  onNewFolder,
}: Pick<
  TaskCardProps,
  | "threadId"
  | "title"
  | "handleRename"
  | "handleShare"
  | "handleArchive"
  | "deleteThread"
  | "onConfirm"
  | "folders"
  | "onMoveToFolder"
  | "onNewFolder"
>) {
  const current = folders ? folderOfThread(folders, threadId) : undefined
  return (
    <>
      <ChatOrganizeMenuItems threadId={threadId} />
      {onMoveToFolder && folders ? (
        <>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger onClick={(e) => e.stopPropagation()}>
              <FolderInputIcon className="size-3.5" />
              Move to folder
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-60">
              {folders.map((folder) => (
                <DropdownMenuItem
                  key={folder.id}
                  disabled={folder.id === current?.id}
                  onClick={(e) => {
                    e.stopPropagation()
                    onMoveToFolder(threadId, folder.id)
                  }}
                >
                  <FolderIcon className="size-3.5" />
                  <span className="truncate">{folder.name}</span>
                </DropdownMenuItem>
              ))}
              {folders.length > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                disabled={!onNewFolder || !canAddChatFolder(folders)}
                onClick={(e) => {
                  e.stopPropagation()
                  void onNewFolder?.([threadId])
                }}
              >
                <FolderPlusIcon className="size-3.5" />
                New folder…
              </DropdownMenuItem>
              {current ? (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation()
                    onMoveToFolder(threadId, null)
                  }}
                >
                  <FolderMinusIcon className="size-3.5" />
                  Take out of folder
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </>
      ) : null}
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
    </>
  )
}

const TaskCard = memo(function TaskCard({
  thread,
  threadId,
  title,
  projectName,
  projectPath,
  branch,
  providerKind,
  modelId,
  isWorktree,
  updatedAt,
  back = false,
  openThread,
  handleRename,
  handleShare,
  handleArchive,
  deleteThread,
  onConfirm,
}: TaskCardProps) {
  const active = useChatStore((s) => s.activeThreadId === threadId)
  // Includes turns the backend still holds open — a run started on another
  // device, or one whose stream has not reattached after a reconnect, used to
  // render as idle here.
  const isStreaming = useThreadIsRunning(threadId)
  const runningFor = useThreadRunningElapsed(threadId)
  const limited = useThreadLimitLabel(threadId)
  const { selected, menuOpen, setMenuOpen, rowProps } = useChatRowBehavior({
    threadId,
    title,
    openThread,
  })
  const draft = useChatHasDraft(threadId)
  const slot = useChatJumpSlot(threadId)
  useClearBackWhenActive(threadId, active, back)
  const modelInfo = getModelInfo(modelId)
  const provider = providerPresentation(providerKind)
  const logo = modelInfo?.logo || provider.logo
  const modelName = modelInfo?.name ?? provider.label
  const displayTitle = title || "New Task"
  const initial = (projectName || "?").charAt(0).toUpperCase()
  const pathLabel = shortPath(projectPath)
  const pullRequest = useThreadPullRequest(
    thread.projectPath || thread.worktreePath,
    thread.branch
  )

  return (
    <HoverCard openDelay={450} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            "group relative cursor-pointer rounded-xl border px-3 py-2.5 transition-colors duration-100",
            ROW_FOCUS_CLASS,
            selected
              ? cn("border-transparent", SELECTED_ROW_CLASS)
              : active
                ? "border-transparent bg-foreground/[0.07]"
                : "border-sidebar-border/60 bg-transparent hover:bg-foreground/[0.035]"
          )}
          {...rowProps}
        >
          {/* Top row: model/provider avatar + repo · status */}
          <div className="flex items-center gap-2">
            <span className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-[5px] bg-foreground/10 text-[8px] font-semibold text-sidebar-foreground/80">
              {logo ? (
                <img
                  src={logo}
                  alt=""
                  className={cn(
                    "size-full object-contain p-px",
                    logoNeedsDarkInvert(logo) && "dark:invert"
                  )}
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).style.display = "none"
                  }}
                />
              ) : (
                initial
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-sidebar-foreground/75">
              {projectName}
            </span>
            {back ? <ChatBackMark /> : null}
            {draft ? <ChatDraftMark /> : null}
            {slot !== null ? (
              <ChatJumpHint slot={slot} />
            ) : isStreaming ? (
              <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-primary">
                <Spinner variant="bars" size={11} />
                Working
                {runningFor ? (
                  <span className="tabular-nums opacity-70">{runningFor}</span>
                ) : null}
              </span>
            ) : limited ? (
              <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-medium whitespace-nowrap text-warning tabular-nums">
                <Clock3Icon aria-hidden="true" className="size-3" />
                {limited}
              </span>
            ) : (
              <span className="shrink-0 text-[10.5px] whitespace-nowrap text-muted-foreground/55 tabular-nums">
                {shortAgo(updatedAt)}
              </span>
            )}
          </div>

          {/* Title */}
          <p
            className={cn(
              "mt-1.5 truncate text-[12.5px] leading-snug font-medium",
              active ? "text-sidebar-foreground" : "text-sidebar-foreground/90"
            )}
          >
            {displayTitle}
          </p>

          {/* Meta row: model pill + branch chip */}
          {(modelName || branch) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pr-6">
              {modelName && (
                <span className="flex max-w-full min-w-0 items-center gap-1 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-sidebar-foreground/80">
                  {logo && (
                    <img
                      src={logo}
                      alt=""
                      className={cn(
                        "size-3 shrink-0",
                        logoNeedsDarkInvert(logo) && "dark:invert"
                      )}
                      onError={(e) => {
                        ;(e.target as HTMLImageElement).style.display = "none"
                      }}
                    />
                  )}
                  <span className="truncate">{modelName}</span>
                </span>
              )}
              {branch && (
                <span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/60">
                  <GitBranchIcon
                    className="size-3 shrink-0"
                    strokeWidth={1.75}
                  />
                  <span className="truncate font-mono">{branch}</span>
                </span>
              )}
              {pullRequest ? (
                <PullRequestBadge pullRequest={pullRequest} />
              ) : null}
              <AttentionBadge
                threadId={threadId}
                className="ml-auto shrink-0"
              />
            </div>
          )}

          {/* Path row: working directory */}
          {pathLabel && (
            <div
              className="mt-1 flex items-center gap-1 pr-6 text-[10px] text-muted-foreground/45"
              title={projectPath ?? undefined}
            >
              <FolderIcon className="size-3 shrink-0" strokeWidth={1.75} />
              <span className="truncate font-mono">{pathLabel}</span>
              {isWorktree && (
                <span className="shrink-0 rounded bg-foreground/[0.06] px-1 py-px text-[8.5px] font-medium text-muted-foreground/60">
                  worktree
                </span>
              )}
            </div>
          )}

          {/* Hover action menu — bottom right, not top right: the top-right corner
          already carries the relative time and the running state, and the
          button sat on top of them. A right click opens it too. */}
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${displayTitle} actions`}
                className="absolute right-2 bottom-2 size-5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50 hover:!text-foreground focus-visible:text-muted-foreground data-[state=open]:text-muted-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                <EllipsisIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <TaskActionsMenuItems
                threadId={threadId}
                title={title}
                handleRename={handleRename}
                handleShare={handleShare}
                handleArchive={handleArchive}
                deleteThread={deleteThread}
                onConfirm={onConfirm}
              />
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
          running={isStreaming}
        />
      </HoverCardContent>
    </HoverCard>
  )
})

/**
 * One chat in the compact feed: the status glyph (working, waiting for you,
 * the branch's pull request, or a ring) beside the title, and one muted line
 * beneath with repo · branch, the pull request number and, at the end, the
 * model. Age or running time sits at the title's end and gives way to the
 * action menu on hover; the hover card has everything else.
 */
/**
 * The second line of a compact or settled row: repo · branch, the pull
 * request number, and the model's logo and name at the end. Repo and model
 * keep their width while branch and pull request take what is left, so a
 * long branch truncates first; they keep a few characters when the sidebar
 * is narrow. `dim` is the settled tone, which brightens with its row.
 */
function TaskMetaLine({
  projectName,
  branch,
  pullRequest,
  modelId,
  providerKind,
  dim = false,
}: {
  projectName: string
  branch: string | null
  pullRequest: GitPullRequest | null
  modelId?: string
  providerKind?: string | null
  dim?: boolean
}) {
  const model = modelPresentation(modelId, providerKind)
  return (
    <div
      className={cn(
        "col-start-2 flex min-w-0 items-center gap-1 text-[10.5px] leading-[14px] transition-colors duration-75",
        dim
          ? "text-sidebar-foreground/35 group-hover:text-sidebar-foreground/50"
          : "text-sidebar-foreground/45"
      )}
    >
      <span className="max-w-[40%] min-w-0 truncate">{projectName}</span>
      <span className="flex min-w-8 flex-1 basis-0 items-center gap-1">
        {branch ? (
          <>
            <span aria-hidden="true" className="opacity-55">
              ·
            </span>
            <span className="min-w-0 truncate font-mono text-[10px]">
              {branch}
            </span>
          </>
        ) : null}
        {pullRequest ? (
          <span className="shrink-0 tabular-nums">#{pullRequest.number}</span>
        ) : null}
      </span>
      {model.name ? (
        <span className="flex max-w-[35%] min-w-0 items-center gap-1 pl-1.5">
          {model.logo ? (
            <img
              src={model.logo}
              alt=""
              className={cn(
                "size-3 shrink-0 object-contain transition-opacity duration-75",
                dim ? "opacity-50 group-hover:opacity-80" : "opacity-80",
                logoNeedsDarkInvert(model.logo) && "dark:invert"
              )}
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = "none"
              }}
            />
          ) : null}
          <span className="truncate">{model.name}</span>
        </span>
      ) : null}
    </div>
  )
}

const TaskRow = memo(function TaskRow({
  thread,
  threadId,
  title,
  projectName,
  branch,
  providerKind,
  modelId,
  updatedAt,
  back = false,
  openThread,
  handleRename,
  handleShare,
  handleArchive,
  deleteThread,
  onConfirm,
  folders,
  onMoveToFolder,
  onNewFolder,
  guided = false,
}: TaskCardProps) {
  const active = useChatStore((s) => s.activeThreadId === threadId)
  const isRunning = useThreadIsRunning(threadId)
  const runningFor = useThreadRunningElapsed(threadId)
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

  return (
    <HoverCard openDelay={450} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            "group relative grid cursor-pointer grid-cols-[14px_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-md py-1 pr-1.5 pl-2 transition-colors duration-75",
            ROW_FOCUS_CLASS,
            selected
              ? SELECTED_ROW_CLASS
              : active
                ? "bg-foreground/[0.06]"
                : "hover:bg-foreground/[0.04]"
          )}
          {...rowProps}
        >
          <span className="flex h-4 items-center">
            <ThreadStatusGlyph
              running={isRunning}
              waiting={attentionEnabled && (attention?.total ?? 0) > 0}
              pullRequest={pullRequest}
              active={active}
              threadId={threadId}
              className={guided ? undefined : "bg-transparent"}
            />
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[12px] leading-4 transition-colors duration-75",
                active
                  ? "font-medium text-sidebar-foreground"
                  : "text-sidebar-foreground/80 group-hover:text-sidebar-foreground"
              )}
            >
              {displayTitle}
            </span>
            <CompareMarker threadId={threadId} />
            {back ? <ChatBackMark /> : null}
            {draft ? <ChatDraftMark /> : null}
            <AttentionBadge threadId={threadId} className="shrink-0" />
            {/* Fades out for the action menu, which takes its place; while
                Ctrl/Cmd is held, the row's jump number stands there. */}
            {slot !== null ? (
              <ChatJumpHint slot={slot} />
            ) : (
              <span
                className={cn(
                  "min-w-5 shrink-0 text-right text-[10.5px] leading-4 whitespace-nowrap tabular-nums transition-opacity duration-75 group-hover:opacity-0 group-focus-visible:opacity-0 group-has-[:focus-visible]:opacity-0 group-has-[[data-state=open]]:opacity-0",
                  isRunning ? "text-primary" : "text-sidebar-foreground/40"
                )}
              >
                {isRunning ? (runningFor ?? "Working") : shortAgo(updatedAt)}
              </span>
            )}
          </div>
          <TaskMetaLine
            projectName={projectName}
            branch={branch}
            pullRequest={pullRequest}
            modelId={modelId}
            providerKind={providerKind}
          />

          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${displayTitle} actions`}
                className="absolute top-0.5 right-1 size-5 text-muted-foreground/60 opacity-0 transition-[color,opacity] group-hover:opacity-100 group-focus-visible:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <EllipsisIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right">
              <TaskActionsMenuItems
                threadId={threadId}
                title={title}
                handleRename={handleRename}
                handleShare={handleShare}
                handleArchive={handleArchive}
                deleteThread={deleteThread}
                onConfirm={onConfirm}
                folders={folders}
                onMoveToFolder={onMoveToFolder}
                onNewFolder={onNewFolder}
              />
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

/**
 * Chats untouched for a day or with a merged or closed pull request, under
 * an "Inactive" rule at the bottom of the feed. The header folds the
 * section; the choice is remembered (held by the list, which needs it for
 * the Ctrl/Cmd+number order).
 */
function SettledSection({
  items,
  variant,
  open,
  onToggle,
}: {
  items: TaskCardProps[]
  variant: "cards" | "compact"
  open: boolean
  onToggle: () => void
}) {
  return (
    <section aria-label="Inactive chats">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="group/settled flex h-6 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="text-[11px] font-medium text-sidebar-foreground/45 transition-colors duration-75 group-hover/settled:text-sidebar-foreground/75">
          Inactive
        </span>
        <span className="text-[10px] text-sidebar-foreground/30 tabular-nums">
          {items.length}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-sidebar-border" />
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 text-sidebar-foreground/40 transition-transform duration-150 group-hover/settled:text-sidebar-foreground/75 motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>
      {open ? (
        // Scrolls on its own past 300px. The scrollbar sits in the list's
        // 8px side padding (a stable gutter pulled out with -mr-2), so the
        // rows keep the feed's width whether they scroll or not.
        <div
          role="listbox"
          aria-label="Inactive chats"
          aria-multiselectable="true"
          className="betterc0de-settled-scroll mt-1 -mr-2 flex max-h-[300px] flex-col gap-px overflow-y-auto [scrollbar-gutter:stable]"
        >
          {items.map((item) => (
            <SettledRow key={item.threadId} {...item} variant={variant} />
          ))}
        </div>
      ) : null}
    </section>
  )
}

/**
 * A settled chat, dimmed until hovered: the project's initials in a grey
 * tile beside the title and its age, and the compact row's meta line
 * beneath (repo · branch, pull request, model). The action menu takes the
 * age's place on hover.
 */
const SettledRow = memo(function SettledRow({
  thread,
  threadId,
  title,
  projectName,
  branch,
  providerKind,
  modelId,
  updatedAt,
  variant,
  openThread,
  handleRename,
  handleShare,
  handleArchive,
  deleteThread,
  onConfirm,
  folders,
  onMoveToFolder,
  onNewFolder,
}: TaskCardProps & { variant: "cards" | "compact" }) {
  const active = useChatStore((s) => s.activeThreadId === threadId)
  const { selected, menuOpen, setMenuOpen, rowProps } = useChatRowBehavior({
    threadId,
    title,
    openThread,
  })
  const draft = useChatHasDraft(threadId)
  const slot = useChatJumpSlot(threadId)
  const pullRequest = useThreadPullRequest(
    thread.projectPath || thread.worktreePath,
    thread.branch
  )
  const displayTitle = title || "New Task"

  return (
    <HoverCard openDelay={450} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            // Compact: the title lines up with the feed's titles; cards: the
            // tile and title line up with a card's logo and repo name.
            "group relative grid shrink-0 cursor-pointer grid-cols-[16px_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-md py-1 pr-1.5 transition-colors duration-75",
            variant === "compact" ? "pl-1.5" : "pl-3",
            ROW_FOCUS_CLASS,
            selected
              ? SELECTED_ROW_CLASS
              : active
                ? "bg-foreground/[0.06]"
                : "hover:bg-foreground/[0.04]"
          )}
          {...rowProps}
        >
          <span className="flex h-4 items-center">
            <span
              aria-hidden="true"
              title={projectName}
              className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-foreground/[0.06] text-[7px] leading-none font-semibold text-sidebar-foreground/45"
            >
              {projectInitials(projectName)}
            </span>
          </span>
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[12px] leading-4 transition-colors duration-75",
                active
                  ? "font-medium text-sidebar-foreground"
                  : "text-sidebar-foreground/55 group-hover:text-sidebar-foreground/90"
              )}
            >
              {displayTitle}
            </span>
            {draft ? <ChatDraftMark /> : null}
            {slot !== null ? (
              <ChatJumpHint slot={slot} />
            ) : (
              <span className="min-w-5 shrink-0 text-right text-[10.5px] leading-4 whitespace-nowrap text-sidebar-foreground/35 tabular-nums transition-opacity duration-75 group-hover:opacity-0 group-focus-visible:opacity-0 group-has-[:focus-visible]:opacity-0 group-has-[[data-state=open]]:opacity-0">
                {shortAgo(updatedAt)}
              </span>
            )}
          </div>
          <TaskMetaLine
            projectName={projectName}
            branch={branch}
            pullRequest={pullRequest}
            modelId={modelId}
            providerKind={providerKind}
            dim
          />

          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${displayTitle} actions`}
                className="absolute top-0.5 right-1 size-5 text-muted-foreground/60 opacity-0 transition-[color,opacity] group-hover:opacity-100 group-focus-visible:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <EllipsisIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right">
              <TaskActionsMenuItems
                threadId={threadId}
                title={title}
                handleRename={handleRename}
                handleShare={handleShare}
                handleArchive={handleArchive}
                deleteThread={deleteThread}
                onConfirm={onConfirm}
                folders={folders}
                onMoveToFolder={onMoveToFolder}
                onNewFolder={onNewFolder}
              />
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
          running={false}
        />
      </HoverCardContent>
    </HoverCard>
  )
})
