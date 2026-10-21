import {
  useCallback,
  useEffect,
  useState,
  type DragEvent,
  type ReactNode,
} from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  FolderIcon,
  FolderMinusIcon,
  FolderOpenIcon,
  PencilIcon,
} from "lucide-react"
import type { ChatThread } from "@betterc0de/schema"
import { draggedThreadIds } from "@/components/sidebar/chat-row-behavior"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { THREAD_DRAG_TYPE } from "@/components/layout/panes/pane-drop-zone"
import type { ChatFolder } from "@/lib/chat-folders"
import { cn } from "@/lib/utils"

/**
 * The compact chat list's own folders, pinned above the rest of the list.
 *
 * A folder keeps its chats in the order the user gave them, and they never
 * move to Inactive. Folders and their chats reorder by dragging: a chat
 * dropped on a folder's header joins it at the end, dropped between two of
 * its chats lands there, and dropped on the list below leaves its folder; a
 * folder dropped above or below another moves there. A 2px `primary` line
 * shows where a drop lands. The folder menu (rename, move up/down, remove)
 * and the chat menu's "Move to folder" do the same without a pointer.
 * Dragging a row that is part of a multi-selection moves every selected
 * chat, in the list's order.
 */

export const FOLDER_DRAG_TYPE = "application/betterc0de-chat-folder"

const COLLAPSED_STORAGE_KEY = "betterc0de:sidebar:collapsed-folders"

/** `ids`: the dragged chats (a selection), `id` the row under the pointer. */
type Drag = { kind: "thread" | "folder"; id: string; ids: string[] }

type DropTarget =
  | { kind: "into"; folderId: string }
  | { kind: "thread"; folderId: string; beforeThreadId: string | null }
  | { kind: "folder"; beforeId: string | null }
  | { kind: "unfile" }

export type ChatFolderPlacement = {
  folderId: string
  beforeThreadId?: string | null
} | null

function sameTarget(a: DropTarget | null, b: DropTarget): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b)
}

function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY)
    const ids: unknown = raw ? JSON.parse(raw) : []
    return new Set(
      Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []
    )
  } catch {
    return new Set()
  }
}

function writeCollapsed(ids: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Storage is optional; folders still fold for this session.
  }
}

/** Upper or lower half of the element under the pointer. */
function lowerHalf(event: DragEvent): boolean {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY > rect.top + rect.height / 2
}

/** Where a dragged chat or folder lands: a 2px `primary` line. */
export function DropLine({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-1 z-20 h-0.5 rounded-full bg-primary",
        className
      )}
    />
  )
}

export function TaskFolders({
  folders,
  threadsById,
  filtering,
  header,
  labelFeed = false,
  renderRow,
  onPlaceThreads,
  onMoveFolder,
  onShiftFolder,
  onRenameFolder,
  onRemoveFolder,
  onVisibleOrderChange,
  children,
}: {
  folders: ChatFolder[]
  /** The chats the folders show (filters applied; pinned and snoozed out). */
  threadsById: ReadonlyMap<string, ChatThread>
  /** A search or project filter is on: folders without a match hide. */
  filtering: boolean
  /** Above the folders (the Pinned group), inside the drag area. */
  header?: ReactNode
  /** Label the unfiled chats "Chats" even without folders. */
  labelFeed?: boolean
  renderRow: (thread: ChatThread) => ReactNode
  onPlaceThreads: (threadIds: string[], placement: ChatFolderPlacement) => void
  onMoveFolder: (folderId: string, beforeId: string | null) => void
  onShiftFolder: (folderId: string, step: -1 | 1) => void
  onRenameFolder: (folderId: string) => void
  onRemoveFolder: (folderId: string) => void
  /** The chats of open folders, top to bottom (Ctrl/Cmd+number order). */
  onVisibleOrderChange?: (threadIds: string[]) => void
  /** The unfiled chats and Inactive; dropping a chat here unfiles it. */
  children: ReactNode
}) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const filed = new Set(folders.flatMap((folder) => folder.thread_ids))
  const shown = folders
    .map((folder) => ({
      folder,
      threads: folder.thread_ids.flatMap((id) => {
        const thread = threadsById.get(id)
        return thread ? [thread] : []
      }),
    }))
    .filter((entry) => !filtering || entry.threads.length > 0)

  const visibleOrderKey = shown
    .filter((entry) => !collapsed.has(entry.folder.id))
    .flatMap((entry) => entry.threads.map((thread) => thread.id))
    .join("\n")
  useEffect(() => {
    onVisibleOrderChange?.(visibleOrderKey ? visibleOrderKey.split("\n") : [])
  }, [visibleOrderKey, onVisibleOrderChange])

  const clear = useCallback(() => {
    setDrag(null)
    setTarget(null)
  }, [])

  // A drop elsewhere (a pane) or a cancelled drag ends here too. A row that
  // moved to another folder remounts, and its own dragend never bubbles up.
  useEffect(() => {
    if (!drag) return
    const done = () => window.setTimeout(clear, 0)
    window.addEventListener("drop", done, true)
    window.addEventListener("dragend", done, true)
    return () => {
      window.removeEventListener("drop", done, true)
      window.removeEventListener("dragend", done, true)
    }
  }, [drag, clear])

  const aim = (next: DropTarget) =>
    setTarget((current) => (sameTarget(current, next) ? current : next))

  /** This list's own drag of that kind; anything else passes through. */
  const accepts = (event: DragEvent, kind: Drag["kind"]) =>
    drag?.kind === kind &&
    event.dataTransfer.types.includes(
      kind === "thread" ? THREAD_DRAG_TYPE : FOLDER_DRAG_TYPE
    )

  const allow = (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = "move"
  }

  const drop = (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const landing = target
    clear()
    if (!landing) return
    if (landing.kind === "folder") {
      const folderId = event.dataTransfer.getData(FOLDER_DRAG_TYPE)
      if (folderId) onMoveFolder(folderId, landing.beforeId)
      return
    }
    const threadIds = draggedThreadIds(event)
    if (threadIds.length === 0) return
    if (landing.kind === "unfile") onPlaceThreads(threadIds, null)
    else if (landing.kind === "into") {
      onPlaceThreads(threadIds, { folderId: landing.folderId })
    } else {
      onPlaceThreads(threadIds, {
        folderId: landing.folderId,
        beforeThreadId: landing.beforeThreadId,
      })
    }
  }

  const toggle = (folderId: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(folderId)) next.add(folderId)
      writeCollapsed(next)
      return next
    })

  const unfiling = target?.kind === "unfile"

  return (
    <div
      className="flex min-h-full flex-col"
      onDragStart={(event) => {
        const threadIds = draggedThreadIds(event)
        if (threadIds.length > 0) {
          setDrag({ kind: "thread", id: threadIds[0]!, ids: threadIds })
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setTarget(null)
        }
      }}
    >
      {header ? (
        // Aiming at the header (Pinned) leaves no folder line behind.
        <div onDragOver={() => setTarget(null)}>{header}</div>
      ) : null}
      {shown.length > 0 ? (
        <div className="flex flex-col gap-1 pb-1">
          {shown.map(({ folder, threads }, index) => {
            const nextFolderId = shown[index + 1]?.folder.id ?? null
            const open = !collapsed.has(folder.id)
            const into =
              target?.kind === "into" && target.folderId === folder.id
            const intoHandlers = {
              onDragOver: (event: DragEvent) => {
                if (!accepts(event, "thread")) return
                allow(event)
                aim({ kind: "into", folderId: folder.id })
              },
              onDrop: (event: DragEvent) => {
                if (drag?.kind === "thread") drop(event)
              },
            }
            return (
              <div
                key={folder.id}
                className={cn(
                  "relative",
                  drag?.kind === "folder" &&
                    drag.id === folder.id &&
                    "opacity-50"
                )}
                onDragOver={(event) => {
                  if (!accepts(event, "folder")) return
                  allow(event)
                  aim({
                    kind: "folder",
                    beforeId: lowerHalf(event) ? nextFolderId : folder.id,
                  })
                }}
                onDrop={(event) => {
                  if (drag?.kind === "folder") drop(event)
                }}
              >
                {target?.kind === "folder" && target.beforeId === folder.id ? (
                  <DropLine className="-top-[3px]" />
                ) : null}
                <FolderHeader
                  folder={folder}
                  count={threads.length}
                  open={open}
                  highlighted={into}
                  first={index === 0}
                  last={index === shown.length - 1}
                  onToggle={() => toggle(folder.id)}
                  onDragStart={(event) => {
                    event.stopPropagation()
                    event.dataTransfer.effectAllowed = "move"
                    event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id)
                    setDrag({ kind: "folder", id: folder.id, ids: [] })
                  }}
                  onShift={(step) => onShiftFolder(folder.id, step)}
                  onRename={() => onRenameFolder(folder.id)}
                  onRemove={() => onRemoveFolder(folder.id)}
                  {...intoHandlers}
                />
                {open ? (
                  // Chats sit on a guide line under the folder icon, like
                  // the folder list's project rows.
                  <div
                    className="relative space-y-px pt-0.5"
                    {...(threads.length > 0
                      ? {
                          role: "listbox",
                          "aria-label": folder.name,
                          "aria-multiselectable": true,
                        }
                      : {})}
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute top-0.5 bottom-1 left-[14.5px] w-px bg-sidebar-border/70"
                    />
                    {threads.map((thread, row) => (
                      <div
                        key={thread.id}
                        className={cn(
                          "relative",
                          drag?.kind === "thread" &&
                            drag.ids.includes(thread.id) &&
                            "opacity-50"
                        )}
                        onDragOver={(event) => {
                          if (!accepts(event, "thread")) return
                          allow(event)
                          aim({
                            kind: "thread",
                            folderId: folder.id,
                            beforeThreadId: lowerHalf(event)
                              ? (threads[row + 1]?.id ?? null)
                              : thread.id,
                          })
                        }}
                        onDrop={(event) => {
                          if (drag?.kind === "thread") drop(event)
                        }}
                      >
                        {target?.kind === "thread" &&
                        target.folderId === folder.id &&
                        target.beforeThreadId === thread.id ? (
                          <DropLine className="-top-px" />
                        ) : null}
                        {renderRow(thread)}
                        {target?.kind === "thread" &&
                        target.folderId === folder.id &&
                        target.beforeThreadId === null &&
                        row === threads.length - 1 ? (
                          <DropLine className="-bottom-px" />
                        ) : null}
                      </div>
                    ))}
                    {threads.length === 0 ? (
                      <p
                        className="py-1 pl-[30px] text-[11px] text-sidebar-foreground/35"
                        {...intoHandlers}
                      >
                        Drag chats here
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {target?.kind === "folder" &&
                target.beforeId === null &&
                index === shown.length - 1 ? (
                  <DropLine className="-bottom-[3px]" />
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

      <div
        className={cn(
          "flex flex-1 flex-col rounded-md transition-colors duration-75",
          unfiling && "bg-primary/[0.06] ring-1 ring-primary/30 ring-inset"
        )}
        onDragOver={(event) => {
          if (
            !accepts(event, "thread") ||
            !drag?.ids.some((id) => filed.has(id))
          ) {
            return
          }
          allow(event)
          aim({ kind: "unfile" })
        }}
        onDrop={(event) => {
          if (target?.kind === "unfile") drop(event)
        }}
      >
        {shown.length > 0 || labelFeed ? (
          <div className="flex h-7 items-center gap-2 px-2 pt-1 text-[11px] font-medium text-sidebar-foreground/45">
            Chats
            {unfiling ? (
              <span className="ml-auto font-normal text-primary">
                Take out of folder
              </span>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  )
}

function FolderHeader({
  folder,
  count,
  open,
  highlighted,
  first,
  last,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop,
  onShift,
  onRename,
  onRemove,
}: {
  folder: ChatFolder
  count: number
  open: boolean
  /** A chat is about to be dropped into this folder. */
  highlighted: boolean
  first: boolean
  last: boolean
  onToggle: () => void
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onShift: (step: -1 | 1) => void
  onRename: () => void
  onRemove: () => void
}) {
  const Icon = open ? FolderOpenIcon : FolderIcon
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "group/folder relative flex h-7 items-center rounded-md pr-1 transition-colors duration-75",
        highlighted
          ? "bg-primary/10 ring-1 ring-primary/40 ring-inset"
          : "hover:bg-foreground/[0.04]"
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pl-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Icon
          aria-hidden="true"
          strokeWidth={1.75}
          className={cn(
            "size-3.5 shrink-0",
            highlighted ? "text-primary" : "text-sidebar-foreground/60"
          )}
        />
        <span className="truncate text-[12px] font-medium text-sidebar-foreground/90">
          {folder.name}
        </span>
        <span className="shrink-0 text-[10px] text-sidebar-foreground/35 tabular-nums">
          {count}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${folder.name} actions`}
            className="size-5 shrink-0 text-muted-foreground/60 opacity-0 transition-[color,opacity] group-hover/folder:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <EllipsisIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem onClick={onRename}>
            <PencilIcon className="size-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem disabled={first} onClick={() => onShift(-1)}>
            <ArrowUpIcon className="size-3.5" />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={last} onClick={() => onShift(1)}>
            <ArrowDownIcon className="size-3.5" />
            Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onRemove}>
            <FolderMinusIcon className="size-3.5" />
            Remove folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
