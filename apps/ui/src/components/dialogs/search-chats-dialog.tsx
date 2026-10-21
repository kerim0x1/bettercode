import { useEffect, useMemo, useState } from "react"
import { FolderOpenIcon, MessageSquareTextIcon, SearchIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/lib/chat-store"
import { timeAgo } from "@/lib/format"
import { listProjects } from "@/services/backend/coreApi"

interface ProjectSearchItem {
  id?: string
  name: string
  path: string
  updatedAt?: string
}

/**
 * Command-palette-style full-text search over the chat history.
 *
 * Opens whenever `chatSearch` is non-empty (the parent sets it to a single
 * space to "open empty", to avoid having to track a separate open flag).
 * Escape / closing the dialog clears `chatSearch` back to "".
 *
 * Results are capped at 20 matches and include a short snippet of the
 * matching message — this keeps the palette responsive on projects with
 * long histories without paginating.
 */
export function SearchChatsDialog({
  chatSearch,
  setChatSearch,
  minimalChat,
}: {
  chatSearch: string
  setChatSearch: (value: string) => void
  minimalChat: boolean
}) {
  const open = chatSearch !== ""
  const threads = useChatStore((state) => state.threads)
  const setActiveThread = useChatStore((state) => state.setActiveThread)
  const createThread = useChatStore((state) => state.createThread)
  const [projects, setProjects] = useState<ProjectSearchItem[]>([])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    listProjects()
      .then((items) => {
        if (cancelled) return
        setProjects(normalizeProjects(items))
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const q = (chatSearch || "").trim().toLowerCase()
  const threadResults = useMemo(() => {
    if (!q) return []
    return threads
      .filter(
        (thread) =>
          thread.title?.toLowerCase().includes(q) ||
          thread.projectName?.toLowerCase().includes(q) ||
          thread.projectPath?.toLowerCase().includes(q) ||
          thread.messages?.some((message) =>
            message.content?.toLowerCase().includes(q)
          )
      )
      .slice(0, 20)
  }, [q, threads])
  const projectResults = useMemo(() => {
    if (!q) return []
    return projects
      .filter(
        (project) =>
          project.name.toLowerCase().includes(q) ||
          project.path.toLowerCase().includes(q)
      )
      .slice(0, 8)
  }, [projects, q])

  const openThread = (threadId: string, title?: string) => {
    setActiveThread(threadId)
    window.dispatchEvent(
      new CustomEvent("betterc0de:open-thread", {
        detail: { threadId, label: title },
      })
    )
    setChatSearch("")
  }

  const openProject = (project: ProjectSearchItem) => {
    const existing = findLatestProjectThread(threads, project)
    if (existing) {
      openThread(existing.id, existing.title)
      return
    }
    const threadId = createThread(
      "New Chat",
      project.name || "Project",
      project.path || undefined
    )
    openThread(threadId, "New Chat")
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) setChatSearch("")
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          "gap-0 overflow-hidden p-0",
          minimalChat ? "sm:max-w-2xl" : "sm:max-w-4xl"
        )}
        style={{ fontSize: "16px" }}
      >
        <DialogTitle className="sr-only">Search Chats</DialogTitle>
        <DialogDescription className="sr-only">
          Search through chat history
        </DialogDescription>
        <div
          className={cn(
            "flex items-center gap-3 border-b border-border/40",
            minimalChat ? "px-4 py-3" : "px-5 py-4"
          )}
        >
          <SearchIcon
            className={cn(
              "text-muted-foreground",
              minimalChat ? "size-4" : "size-5"
            )}
          />
          <input
            autoFocus
            type="text"
            value={chatSearch === " " ? "" : chatSearch}
            onChange={(e) => setChatSearch(e.target.value || " ")}
            onKeyDown={(e) => e.key === "Escape" && setChatSearch("")}
            placeholder="Search chats, messages, projects..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/40"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div
          className={cn(
            "overflow-y-auto",
            minimalChat ? "max-h-[55vh]" : "max-h-[70vh]"
          )}
        >
          {(() => {
            if (!q)
              return (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                  Type to search...
                </p>
              )
            if (threadResults.length === 0 && projectResults.length === 0)
              return (
                <p className="px-4 py-8 text-center text-xs text-muted-foreground">
                  No results for "{chatSearch.trim()}"
                </p>
              )
            return (
              <>
                {projectResults.map((project) => (
                  <button
                    key={`project:${project.path || project.name}`}
                    type="button"
                    onClick={() => openProject(project)}
                    className={cn(
                      "flex w-full items-start gap-3 border-b border-border/20 text-left transition-colors hover:bg-muted/50",
                      minimalChat ? "px-3 py-2" : "px-4 py-3"
                    )}
                  >
                    <FolderOpenIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/40" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {project.name || "Project"}
                      </p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {project.path || "No folder path"}
                      </p>
                    </div>
                    <span className="shrink-0 text-[9px] text-muted-foreground/30">
                      Project
                    </span>
                  </button>
                ))}
                {threadResults.map((thread) => {
                  const matchMsg = thread.messages?.find((message) =>
                    message.content?.toLowerCase().includes(q)
                  )
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      onClick={() => openThread(thread.id, thread.title)}
                      className={cn(
                        "flex w-full items-start gap-3 border-b border-border/20 text-left transition-colors last:border-0 hover:bg-muted/50",
                        minimalChat ? "px-3 py-2" : "px-4 py-3"
                      )}
                    >
                      <MessageSquareTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/40" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {thread.title || "New Chat"}
                        </p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {thread.projectName}
                        </p>
                        {matchMsg && (
                          <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground/60">
                            {matchMsg.content.slice(0, 120)}...
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 text-[9px] text-muted-foreground/30">
                        {timeAgo(thread.updatedAt)}
                      </span>
                    </button>
                  )
                })}
              </>
            )
          })()}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function normalizeProjects(items: unknown[]): ProjectSearchItem[] {
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null
      const record = item as Record<string, unknown>
      const name = typeof record.name === "string" ? record.name : ""
      const path = typeof record.path === "string" ? record.path : ""
      if (!name && !path) return null
      return {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        name: name || basename(path) || "Project",
        path,
        ...(typeof record.updatedAt === "string"
          ? { updatedAt: record.updatedAt }
          : {}),
      }
    })
    .filter((item): item is ProjectSearchItem => Boolean(item))
}

function findLatestProjectThread(
  threads: ReturnType<typeof useChatStore.getState>["threads"],
  project: ProjectSearchItem
) {
  return [...threads]
    .filter((thread) =>
      project.path
        ? thread.projectPath === project.path
        : thread.projectName === project.name
    )
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )[0]
}

function basename(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? ""
}
