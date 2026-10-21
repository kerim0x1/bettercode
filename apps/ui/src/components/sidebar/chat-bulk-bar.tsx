import type { ReactNode } from "react"
import {
  AlarmClockIcon,
  ArchiveIcon,
  CheckCheckIcon,
  FolderIcon,
  FolderInputIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SnoozeMenuItems } from "@/components/sidebar/chat-organize-menu"
import {
  archiveChats,
  deleteChats,
  moveChatsToFolder,
  togglePinnedChats,
  unsnoozeChats,
} from "@/lib/chat-list-actions"
import { useChatSelectionStore } from "@/lib/chat-list-selection"
import { canAddChatFolder, type ChatFolder } from "@/lib/chat-folders"
import { arePinned } from "@/lib/chat-pins"
import { useSettingsStore } from "@/lib/settings-store"
import { cn } from "@/lib/utils"

/**
 * The bar at the top of a chat list while chats are selected: the count,
 * then Pin/Unpin, Snooze, Move to folder (Compact list), Archive, Delete
 * (one confirmation for all), Mark as seen when some came back from a
 * snooze, and Clear. Icon buttons with tooltips and labels; Escape or a
 * plain click on a chat also clears the selection.
 */
export function ChatBulkBar({
  folders,
  backIds,
  onNewFolder,
  onConfirm,
}: {
  /** Compact list: the folders for Move to folder. */
  folders?: ChatFolder[]
  /** Chats back from a snooze, for Mark as seen. */
  backIds?: ReadonlySet<string>
  onNewFolder?: (threadIds: string[]) => void
  onConfirm?: (dialog: {
    title: string
    description: string
    action: () => void
  }) => void
}) {
  const ids = useChatSelectionStore((state) => state.ids)
  const clear = useChatSelectionStore((state) => state.clear)
  const allPinned = useSettingsStore((state) =>
    arePinned(state.pinnedThreadIds, ids)
  )
  if (ids.length === 0) return null
  const seenIds = backIds ? ids.filter((id) => backIds.has(id)) : []

  const remove = () => {
    const run = () => {
      deleteChats(ids)
      clear()
    }
    const dialog = {
      title: ids.length === 1 ? "Delete chat?" : `Delete ${ids.length} chats?`,
      description:
        ids.length === 1
          ? "It leaves the sidebar now and is deleted after a few seconds unless you undo."
          : "They leave the sidebar now and are deleted after a few seconds unless you undo.",
      action: run,
    }
    if (onConfirm) onConfirm(dialog)
    else run()
  }

  return (
    <div
      role="toolbar"
      aria-label="Selected chats"
      className="mx-2 mb-1.5 flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-sidebar-accent/70 pr-1 pl-2.5 ring-1 ring-sidebar-border/70 ring-inset"
    >
      <span
        aria-live="polite"
        className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-sidebar-foreground tabular-nums"
      >
        {ids.length} selected
      </span>
      <BulkButton
        label={allPinned ? "Unpin" : "Pin"}
        onClick={() => togglePinnedChats(ids)}
      >
        {allPinned ? <PinOffIcon /> : <PinIcon />}
      </BulkButton>
      <DropdownMenu>
        <BulkMenuTrigger label="Snooze">
          <AlarmClockIcon />
        </BulkMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuLabel>
            Snooze {ids.length === 1 ? "1 chat" : `${ids.length} chats`}
          </DropdownMenuLabel>
          <SnoozeMenuItems threadIds={ids} />
        </DropdownMenuContent>
      </DropdownMenu>
      {folders ? (
        <DropdownMenu>
          <BulkMenuTrigger label="Move to folder">
            <FolderInputIcon />
          </BulkMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-60">
            {folders.map((folder) => (
              <DropdownMenuItem
                key={folder.id}
                onClick={() => {
                  moveChatsToFolder(ids, { folderId: folder.id })
                  clear()
                }}
              >
                <FolderIcon className="size-3.5" />
                <span className="truncate">{folder.name}</span>
              </DropdownMenuItem>
            ))}
            {folders.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              disabled={!onNewFolder || !canAddChatFolder(folders)}
              onClick={() => onNewFolder?.(ids)}
            >
              <FolderPlusIcon className="size-3.5" />
              New folder…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={
                !ids.some((id) =>
                  folders.some((folder) => folder.thread_ids.includes(id))
                )
              }
              onClick={() => {
                moveChatsToFolder(ids, null)
                clear()
              }}
            >
              <FolderMinusIcon className="size-3.5" />
              Take out of folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {seenIds.length > 0 ? (
        <BulkButton
          label="Mark as seen"
          onClick={() => unsnoozeChats(seenIds, { seen: true })}
        >
          <CheckCheckIcon />
        </BulkButton>
      ) : null}
      <BulkButton
        label="Archive"
        onClick={() => {
          archiveChats(ids)
          clear()
        }}
      >
        <ArchiveIcon />
      </BulkButton>
      <BulkButton label="Delete" destructive onClick={remove}>
        <Trash2Icon />
      </BulkButton>
      <BulkButton label="Clear selection" onClick={clear}>
        <XIcon />
      </BulkButton>
    </div>
  )
}

const BULK_BUTTON_CLASS =
  "size-6 rounded-md text-sidebar-foreground/70 hover:bg-foreground/[0.07] hover:text-foreground [&_svg]:size-3.5"

function BulkButton({
  label,
  destructive = false,
  onClick,
  children,
}: {
  label: string
  destructive?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className={cn(
            BULK_BUTTON_CLASS,
            destructive && "hover:bg-destructive/10 hover:text-destructive"
          )}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

function BulkMenuTrigger({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className={BULK_BUTTON_CLASS}
          >
            {children}
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
