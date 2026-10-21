import { copyText } from "@/lib/clipboard"
import { memo, useCallback, useMemo, useState, type DragEvent } from "react"
import {
  ArchiveIcon,
  ChevronDownIcon,
  CopyIcon,
  EllipsisIcon,
  FolderIcon,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/kibo-ui/spinner"
import { AttentionBadge } from "@/components/attention/attention-badge"
import { useChatStore } from "@/lib/chat-store"
import { usePrompt } from "@/components/dialogs/prompt-provider"
import {
  useThreadIsRunning,
  useThreadRunningElapsed,
} from "@/lib/chat/running-selectors"
import { useSettingsStore } from "@/lib/settings-store"
import { shouldShowThreadInSidebar } from "@/lib/sidebar-thread-visibility"
import { builtinProviders } from "@/lib/builtin-providers"
import { getModelInfo } from "@/lib/get-model-info"
import { logoNeedsDarkInvert } from "@/lib/logo-invert"
import type { ChatThread } from "@betterc0de/schema"
import { THREAD_DRAG_TYPE } from "@/components/layout/panes/pane-drop-zone"

/**
 * Flat "task feed" layout for the agent sidebar — an alternative to the
 * project-folder tree in {@link SidebarThreadList}, switched via the
 * `chatSidebarLayout` appearance setting.
 *
 * Each chat renders as a card echoing a code-agent task list:
 *   [model logo]  repo-name                         · 2h / Working
 *   Thread title (bold)
 *   [model name]  [⎇ branch]
 *   [folder] shortened working-directory path
 *
 * The model shown is the real one the thread last answered with (last
 * assistant message's `modelId`), falling back to the thread's selected
 * model — not just the provider. Cards sort newest-first and narrow to a
 * single project via the header dropdown; the active thread gets a filled
 * card, the rest a quiet hairline row.
 */

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

export function SidebarTaskList({
  search = "",
  onConfirm,
  onNewThread,
}: {
  search?: string
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
  const setActiveThread = useChatStore((s) => s.setActiveThread)
  const deleteThread = useChatStore((s) => s.deleteThread)
  const archivedThreadIds = useSettingsStore((s) => s.archivedThreadIds)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const prompt = usePrompt()

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

  const handleArchive = useCallback((threadId: string) => {
    const settings = useSettingsStore.getState()
    settings.update({
      archived_thread_ids: [...settings.archivedThreadIds, threadId],
    })
  }, [])

  const visibleThreads = useMemo(() => {
    const q = search.trim().toLowerCase()
    return threads
      .filter((t) => {
        if (t.title?.startsWith("__inline-edit-")) return false
        const isHydrated = messagesLoadedByThread[t.id] === true
        if (!shouldShowThreadInSidebar(t, isHydrated)) return false
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
  }, [threads, messagesLoadedByThread, archivedThreadIds, search])

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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {shown.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground/40">
            {search.trim()
              ? `No chats matching "${search.trim()}"`
              : "No conversations yet"}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {shown.map((thread) => (
              <TaskCard
                key={thread.id}
                threadId={thread.id}
                title={thread.title}
                projectName={thread.projectName || "BetterC0de"}
                projectPath={thread.worktreePath || thread.projectPath}
                branch={branchLabel(thread)}
                providerKind={thread.session?.providerKind}
                modelId={threadModelId(
                  thread,
                  settingsByThread[thread.id]?.selectedModel
                )}
                isWorktree={!!thread.worktreePath}
                updatedAt={thread.updatedAt}
                openThread={openThread}
                handleRename={handleRename}
                handleShare={handleShare}
                handleArchive={handleArchive}
                deleteThread={deleteThread}
                onConfirm={onConfirm}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface TaskCardProps {
  threadId: string
  title: string
  projectName: string
  projectPath?: string | null
  branch: string | null
  providerKind?: string | null
  modelId?: string
  isWorktree: boolean
  updatedAt: string
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

const TaskCard = memo(function TaskCard({
  threadId,
  title,
  projectName,
  projectPath,
  branch,
  providerKind,
  modelId,
  isWorktree,
  updatedAt,
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
  const modelInfo = getModelInfo(modelId)
  const provider = providerPresentation(providerKind)
  const logo = modelInfo?.logo || provider.logo
  const modelName = modelInfo?.name ?? provider.label
  const displayTitle = title || "New Task"
  const initial = (projectName || "?").charAt(0).toUpperCase()
  const pathLabel = shortPath(projectPath)

  return (
    <div
      className={cn(
        "group relative cursor-pointer rounded-xl border px-3 py-2.5 transition-colors duration-100",
        active
          ? "border-transparent bg-foreground/[0.07]"
          : "border-sidebar-border/60 bg-transparent hover:bg-foreground/[0.035]"
      )}
      onClick={() => openThread(threadId, title || undefined)}
      {...threadDragHandlers(threadId, title)}
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
        {isStreaming ? (
          <span className="flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-primary">
            <Spinner variant="bars" size={11} />
            Working
            {runningFor ? (
              <span className="tabular-nums opacity-70">{runningFor}</span>
            ) : null}
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
              <GitBranchIcon className="size-3 shrink-0" strokeWidth={1.75} />
              <span className="truncate font-mono">{branch}</span>
            </span>
          )}
          <AttentionBadge threadId={threadId} className="ml-auto shrink-0" />
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
          button sat on top of them. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute right-2 bottom-2 size-5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50 hover:!text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <EllipsisIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
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
