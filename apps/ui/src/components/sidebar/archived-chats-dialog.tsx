import { useEffect, useMemo, useState } from "react"
import {
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  EyeIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"
import type { ChatThread } from "@betterc0de/schema"
import { MessageResponse } from "@/components/ai-elements/message"
import { Spinner } from "@/components/kibo-ui/spinner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  chatListLabel,
  deleteChats,
  unarchiveChats,
  undoChatListChange,
} from "@/lib/chat-list-actions"
import {
  setArchivedChatsOpen,
  useChatListDialogsStore,
} from "@/lib/chat-list-dialogs"
import { openChatFromList } from "@/lib/chat-list-nav"
import { useChatStore } from "@/lib/chat-store"
import { timeAgo } from "@/lib/format"
import { usePendingDeletesStore } from "@/lib/pending-thread-deletes"
import { useSettingsStore } from "@/lib/settings-store"
import { cn } from "@/lib/utils"

/**
 * Archived chats: Settings → General → Chats & History and the sidebar's
 * Chat list menu open it. A search and a project filter narrow the list;
 * each chat can be read here without leaving the archive (a read-only
 * transcript), restored, or deleted. A modal hides the toasts' Undo, so
 * the dialog shows its own Undo line after a change; Ctrl/Cmd+Z works too.
 */
export function ArchivedChatsDialog() {
  const open = useChatListDialogsStore((state) => state.archivedOpen)
  return (
    <Dialog open={open} onOpenChange={setArchivedChatsOpen}>
      {open ? <ArchivedChatsContent /> : null}
    </Dialog>
  )
}

const ALL_PROJECTS = null

function projectOf(thread: ChatThread): string {
  return thread.projectName || "BetterC0de"
}

function ArchivedChatsContent() {
  const threads = useChatStore((state) => state.threads)
  const archivedIds = useSettingsStore((state) => state.archivedThreadIds)
  const confirmDelete = useSettingsStore((state) => state.confirmDelete)
  const hidden = usePendingDeletesStore((state) => state.hidden)
  const [query, setQuery] = useState("")
  const [project, setProject] = useState<string | null>(ALL_PROJECTS)
  const [readingId, setReadingId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{
    text: string
    undoId: string
  } | null>(null)

  // Newest archive first.
  const archived = useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]))
    return [...archivedIds].reverse().flatMap((id) => {
      const thread = byId.get(id)
      return thread && !hidden[id] ? [thread] : []
    })
  }, [threads, archivedIds, hidden])

  const projects = useMemo(
    () =>
      [...new Set(archived.map(projectOf))].sort((a, b) => a.localeCompare(b)),
    [archived]
  )

  const q = query.trim().toLowerCase()
  const shown = archived.filter(
    (thread) =>
      (project === ALL_PROJECTS || projectOf(thread) === project) &&
      (!q ||
        thread.title?.toLowerCase().includes(q) ||
        projectOf(thread).toLowerCase().includes(q))
  )

  const reading = readingId
    ? (archived.find((thread) => thread.id === readingId) ?? null)
    : null

  const restore = (thread: ChatThread) => {
    const label = chatListLabel([thread.id])
    const undoId = unarchiveChats([thread.id], { toast: false })
    if (undoId) setNotice({ text: `Restored ${label}.`, undoId })
    setReadingId(null)
  }

  const remove = (thread: ChatThread) => {
    if (confirmDelete && confirmingId !== thread.id) {
      setConfirmingId(thread.id)
      return
    }
    setConfirmingId(null)
    const label = chatListLabel([thread.id])
    const undoId = deleteChats([thread.id], { toast: false })
    if (undoId) {
      setNotice({
        text: `Deleted ${label}. It is gone for good in a few seconds.`,
        undoId,
      })
    }
    setReadingId(null)
  }

  return (
    <DialogContent className="gap-4 sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Archived chats</DialogTitle>
        <DialogDescription>
          Archived chats stay out of the sidebar until you restore them.
        </DialogDescription>
      </DialogHeader>

      {reading ? (
        <ArchivedChatReader
          thread={reading}
          onBack={() => setReadingId(null)}
          onRestore={() => restore(reading)}
          onRestoreAndOpen={() => {
            restore(reading)
            setArchivedChatsOpen(false)
            openChatFromList(reading.id, reading.title || undefined)
          }}
        />
      ) : (
        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search archived chats"
                placeholder="Search archived chats"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 pl-8 text-[13px]"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 max-w-44 min-w-0 justify-between gap-1.5 text-[12px]"
                >
                  <span className="truncate">{project ?? "All projects"}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[190px]">
                <DropdownMenuCheckboxItem
                  checked={project === ALL_PROJECTS}
                  onCheckedChange={() => setProject(ALL_PROJECTS)}
                >
                  All projects
                </DropdownMenuCheckboxItem>
                {projects.length > 0 ? <DropdownMenuSeparator /> : null}
                {projects.map((name) => (
                  <DropdownMenuCheckboxItem
                    key={name}
                    checked={project === name}
                    onCheckedChange={() => setProject(name)}
                  >
                    <span className="truncate">{name}</span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {shown.length === 0 ? (
            <p className="py-8 text-center text-[12px] text-muted-foreground">
              {archived.length === 0
                ? "No archived chats."
                : "No archived chats match."}
            </p>
          ) : (
            <ul
              aria-label="Archived chats"
              className="-mx-2 max-h-[min(55vh,440px)] overflow-y-auto"
            >
              {shown.map((thread) => {
                const title = thread.title || "New Chat"
                const confirming = confirmingId === thread.id
                return (
                  <li
                    key={thread.id}
                    className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50"
                  >
                    <button
                      type="button"
                      onClick={() => setReadingId(thread.id)}
                      className="min-w-0 flex-1 cursor-pointer rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {title}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {projectOf(thread)} · {timeAgo(thread.updatedAt)}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Read ${title}`}
                      title="Read"
                      onClick={() => setReadingId(thread.id)}
                    >
                      <EyeIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Restore ${title}`}
                      title="Restore"
                      onClick={() => restore(thread)}
                    >
                      <ArchiveRestoreIcon />
                    </Button>
                    <Button
                      variant={confirming ? "destructive" : "ghost"}
                      size={confirming ? "xs" : "icon-xs"}
                      aria-label={
                        confirming
                          ? `Confirm delete ${title}`
                          : `Delete ${title}`
                      }
                      title={confirming ? undefined : "Delete"}
                      onBlur={() => {
                        if (confirming) setConfirmingId(null)
                      }}
                      onClick={() => remove(thread)}
                      className={cn(
                        !confirming &&
                          "hover:bg-destructive/10 hover:text-destructive"
                      )}
                    >
                      <Trash2Icon />
                      {confirming ? "Delete?" : null}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {notice ? (
        <p
          role="status"
          className="-mt-1 flex items-center gap-2 text-[12px] text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">{notice.text}</span>
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0"
            onClick={() => {
              undoChatListChange(notice.undoId)
              setNotice(null)
            }}
          >
            Undo
          </Button>
        </p>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={() => setArchivedChatsOpen(false)}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

/** A read-only transcript of an archived chat, loaded on demand. */
function ArchivedChatReader({
  thread,
  onBack,
  onRestore,
  onRestoreAndOpen,
}: {
  thread: ChatThread
  onBack: () => void
  onRestore: () => void
  onRestoreAndOpen: () => void
}) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading")
  useEffect(() => {
    let cancelled = false
    setState("loading")
    useChatStore
      .getState()
      .ensureFullThreadMessages(thread.id, { payloads: false })
      .then(
        () => {
          if (!cancelled) setState("ready")
        },
        () => {
          if (!cancelled) setState("failed")
        }
      )
    return () => {
      cancelled = true
    }
  }, [thread.id])

  const messages = (thread.messages ?? []).filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.content.trim()
  )

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to archived chats"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-foreground">
            {thread.title || "New Chat"}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {projectOf(thread)} · Read-only
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onRestore}>
          <ArchiveRestoreIcon className="size-3.5" />
          Restore
        </Button>
        <Button variant="secondary" size="sm" onClick={onRestoreAndOpen}>
          Restore and open
        </Button>
      </div>
      <div
        aria-label="Transcript"
        aria-busy={state === "loading"}
        className="max-h-[min(55vh,440px)] overflow-y-auto rounded-xl border border-border/60 bg-background/40 p-3"
      >
        {state === "loading" && messages.length === 0 ? (
          <p className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
            <Spinner variant="bars" size={12} />
            Loading the chat…
          </p>
        ) : state === "failed" && messages.length === 0 ? (
          <p role="alert" className="py-6 text-[12px] text-destructive">
            Couldn&apos;t load this chat.
          </p>
        ) : messages.length === 0 ? (
          <p className="py-6 text-[12px] text-muted-foreground">
            This chat has no messages.
          </p>
        ) : (
          <ol className="grid gap-4">
            {messages.map((message) => (
              <li key={message.id} className="grid gap-1">
                <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                  {message.role === "user" ? "You" : "Assistant"}
                </span>
                {message.role === "user" ? (
                  <p className="rounded-lg bg-muted/50 px-3 py-2 text-[13px] break-words whitespace-pre-wrap text-foreground">
                    {message.content}
                  </p>
                ) : (
                  <div className="text-[13px]">
                    <MessageResponse>{message.content}</MessageResponse>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}
