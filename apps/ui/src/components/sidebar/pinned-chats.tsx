import { useState, type DragEvent, type ReactNode } from "react"
import { PinIcon } from "lucide-react"
import { THREAD_DRAG_TYPE } from "@/components/layout/panes/pane-drop-zone"
import {
  draggedThreadIds,
  useChatDragStore,
} from "@/components/sidebar/chat-row-behavior"
import { DropLine } from "@/components/sidebar/task-folders"
import { pinChats } from "@/lib/chat-list-actions"
import { cn } from "@/lib/utils"

/**
 * The Pinned group at the very top of every chat list layout. Pinned chats
 * keep the user's order: drag one to reorder, or drag any chat of the list
 * (a selection too) onto the group to pin it there. A 2px `primary` line
 * shows where it lands. Nothing renders while no chat is pinned, so a drag
 * never shifts the list under the pointer; the chat menu's Pin starts it.
 */
export function PinnedChats<T extends { id: string }>({
  threads,
  renderRow,
  cards = false,
  className,
}: {
  threads: readonly T[]
  renderRow: (thread: T) => ReactNode
  /** Task cards: the cards' spacing. */
  cards?: boolean
  className?: string
}) {
  const dragging = useChatDragStore((state) => state.ids)
  const [beforeId, setBeforeId] = useState<string | null | undefined>(undefined)
  if (threads.length === 0) return null

  // Only the list's own drags: not files or pane tabs.
  const accepts = (event: DragEvent) =>
    dragging !== null && event.dataTransfer.types.includes(THREAD_DRAG_TYPE)

  const aim = (event: DragEvent, next: string | null) => {
    if (!accepts(event)) return
    // Not stopped: the folders below clear their own drop line.
    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
    setBeforeId((current) => (current === next ? current : next))
  }

  const drop = (event: DragEvent) => {
    if (!accepts(event)) return
    event.preventDefault()
    event.stopPropagation()
    const landing = beforeId
    setBeforeId(undefined)
    const ids = draggedThreadIds(event)
    if (ids.length > 0) pinChats(ids, { beforeId: landing ?? null })
  }

  // A drag that ended elsewhere (a pane) leaves no line behind.
  const target = dragging ? beforeId : undefined

  return (
    <section
      aria-label="Pinned chats"
      className={cn("pb-1", className)}
      onDragOver={(event) => {
        // A row below already aimed (and claimed) this event.
        if (event.nativeEvent.defaultPrevented) return
        aim(event, null)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setBeforeId(undefined)
        }
      }}
      onDrop={drop}
    >
      <div className="flex h-7 items-center gap-1.5 px-2 pt-1 text-[11px] font-medium text-sidebar-foreground/45">
        <PinIcon aria-hidden="true" className="size-3" strokeWidth={2} />
        Pinned
        <span className="font-normal text-sidebar-foreground/30 tabular-nums">
          {threads.length}
        </span>
      </div>
      <div
        role="listbox"
        aria-label="Pinned chats"
        aria-multiselectable="true"
        className={cn("flex flex-col", cards ? "gap-1" : "gap-px")}
      >
        {threads.map((thread, index) => (
          <div
            key={thread.id}
            className={cn(
              "relative",
              dragging?.includes(thread.id) && "opacity-50"
            )}
            onDragOver={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              const lower = event.clientY > rect.top + rect.height / 2
              aim(event, lower ? (threads[index + 1]?.id ?? null) : thread.id)
            }}
          >
            {target === thread.id ? (
              <DropLine className={cards ? "-top-[3px]" : "-top-px"} />
            ) : null}
            {renderRow(thread)}
            {target === null && index === threads.length - 1 ? (
              <DropLine className={cards ? "-bottom-[3px]" : "-bottom-px"} />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}
