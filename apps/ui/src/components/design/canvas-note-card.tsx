import { useRef, type PointerEvent as ReactPointerEvent } from "react"
import { DropdownMenu } from "radix-ui"
import {
  CheckIcon,
  GripHorizontalIcon,
  LinkIcon,
  Link2OffIcon,
  TrashIcon,
} from "lucide-react"
import {
  NOTE_COLORS,
  resizeNote,
  type CanvasNote,
  type NoteColor,
} from "@/lib/canvas-notes"
import type { CanvasPoint } from "@/lib/project-canvas"
import { MENU_PANEL, MENU_ITEM } from "@/components/ui/menu-chrome"
import { cn } from "@/lib/utils"

/**
 * Colours are written out in full because Tailwind cannot see a template
 * like `bg-${color}-400/15`. Each note carries a tinted surface, a matching
 * hairline and a slightly stronger accent for its own chrome.
 */
const NOTE_SURFACE: Record<NoteColor, string> = {
  amber: "bg-amber-300/[0.14] ring-amber-200/20",
  sky: "bg-sky-300/[0.13] ring-sky-200/20",
  emerald: "bg-emerald-300/[0.13] ring-emerald-200/20",
  rose: "bg-rose-300/[0.13] ring-rose-200/20",
  slate: "bg-foreground/[0.07] ring-border/70",
}

/**
 * A saturated hairline along the top edge. A tint alone is ambiguous on a
 * near-black canvas — yellow in particular turns olive — so the colour also
 * appears at full strength where it cannot be washed out.
 */
const NOTE_ACCENT: Record<NoteColor, string> = {
  amber: "bg-amber-300/70",
  sky: "bg-sky-300/70",
  emerald: "bg-emerald-300/70",
  rose: "bg-rose-300/70",
  slate: "bg-muted-foreground/50",
}

const NOTE_SWATCH: Record<NoteColor, string> = {
  amber: "bg-amber-300",
  sky: "bg-sky-300",
  emerald: "bg-emerald-300",
  rose: "bg-rose-300",
  slate: "bg-muted-foreground",
}

/** Chrome is quiet until the note is hovered or something inside has focus. */
const CHROME =
  "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"

const ICON_BUTTON =
  "flex size-6 items-center justify-center rounded-md text-foreground/70 transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring active:scale-[0.96]"

export interface NoteCardTarget {
  threadId: string
  label: string
}

export function CanvasNoteCard({
  note,
  origin,
  targets,
  panActive,
  zoom,
  onChange,
  onRemove,
  onMoveStart,
  onPin,
  onUnpin,
}: {
  note: CanvasNote
  /** Where the note actually sits; a pinned one follows its card. */
  origin: CanvasPoint
  /** Cards on the board a note can be pinned to. */
  targets: NoteCardTarget[]
  panActive: boolean
  zoom: number
  onChange: (note: CanvasNote) => void
  onRemove: (id: string) => void
  onMoveStart: (event: ReactPointerEvent, origin: CanvasPoint) => void
  onPin: (id: string, threadId: string) => void
  onUnpin: (id: string) => void
}) {
  const resize = useRef<{
    pointerId: number
    startX: number
    startY: number
    width: number
    height: number
  } | null>(null)
  const pinnedTarget = targets.find(
    (target) => target.threadId === note.pinnedTo
  )

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    resize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: note.width,
      height: note.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const duringResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = resize.current
    if (!current || current.pointerId !== event.pointerId) return
    const scale = Math.max(zoom, 0.01)
    onChange(
      resizeNote(note, {
        width: current.width + (event.clientX - current.startX) / scale,
        height: current.height + (event.clientY - current.startY) / scale,
      })
    )
  }
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resize.current?.pointerId !== event.pointerId) return
    resize.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* The capture is already gone when the pointer left the window. */
    }
  }

  return (
    <div
      data-canvas-note={note.id}
      className={cn(
        "group relative flex flex-col rounded-2xl shadow-[0_12px_32px_-20px_rgba(0,0,0,0.95)] ring-1",
        NOTE_SURFACE[note.color]
      )}
      style={{ width: note.width, height: note.height }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-x-3 top-0 h-[2px] rounded-b-full",
          NOTE_ACCENT[note.color]
        )}
      />
      {/* A grip strip, not a toolbar: at rest the note is just its text. */}
      <div
        data-canvas-controls
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("button,[role=menu],[data-note-resize]")
          )
            return
          onMoveStart(event, origin)
        }}
        className={cn(
          "absolute inset-x-0 top-0 z-10 flex h-8 items-center gap-1 rounded-t-2xl px-2",
          panActive ? "cursor-grab" : "cursor-grab active:cursor-grabbing"
        )}
      >
        <GripHorizontalIcon
          className={cn("size-3.5 text-foreground/35", CHROME)}
          strokeWidth={2}
        />
        <div className="flex-1" />
        <div className={cn("flex items-center gap-0.5", CHROME)}>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label="Note colour"
                title="Note colour"
                className={ICON_BUTTON}
              >
                <span
                  className={cn(
                    "size-3 rounded-full ring-1 ring-black/20",
                    NOTE_SWATCH[note.color]
                  )}
                />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className={cn(MENU_PANEL, "z-50 flex gap-1 p-1.5")}
              >
                {NOTE_COLORS.map((color) => (
                  <DropdownMenu.Item
                    key={color}
                    aria-label={`Colour ${color}`}
                    onSelect={() => onChange({ ...note, color })}
                    className="flex size-6 cursor-default items-center justify-center rounded-md transition-colors duration-150 outline-none data-highlighted:bg-accent"
                  >
                    <span
                      className={cn(
                        "size-3.5 rounded-full ring-1",
                        NOTE_SWATCH[color],
                        note.color === color
                          ? "ring-foreground/60"
                          : "ring-black/20"
                      )}
                    />
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label={
                  pinnedTarget
                    ? `Pinned to ${pinnedTarget.label}`
                    : "Pin to a card"
                }
                title={
                  pinnedTarget
                    ? `Pinned to ${pinnedTarget.label}`
                    : "Pin to a card"
                }
                className={ICON_BUTTON}
              >
                <LinkIcon className="size-3.5" strokeWidth={1.5} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className={cn(MENU_PANEL, "z-50 min-w-56 text-foreground")}
              >
                <div className="px-2 pt-1 pb-1.5 text-[10px] text-muted-foreground">
                  Pin to a card
                </div>
                {targets.length === 0 && (
                  <div className="px-2 pb-1.5 text-[11px] text-muted-foreground">
                    Add a repo or chat first.
                  </div>
                )}
                {targets.map((target) => (
                  <DropdownMenu.Item
                    key={target.threadId}
                    className={cn(
                      MENU_ITEM,
                      "flex cursor-default items-center outline-none data-highlighted:bg-accent"
                    )}
                    onSelect={() => onPin(note.id, target.threadId)}
                  >
                    <span className="flex-1 truncate">{target.label}</span>
                    {target.threadId === note.pinnedTo && (
                      <CheckIcon
                        className="size-3.5 text-primary"
                        strokeWidth={2}
                      />
                    )}
                  </DropdownMenu.Item>
                ))}
                {note.pinnedTo && (
                  <DropdownMenu.Item
                    className={cn(
                      MENU_ITEM,
                      "flex cursor-default items-center outline-none data-highlighted:bg-accent"
                    )}
                    onSelect={() => onUnpin(note.id)}
                  >
                    <Link2OffIcon className="size-3.5" strokeWidth={1.5} />
                    Unpin
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          <button
            type="button"
            aria-label="Delete note"
            title="Delete note"
            onClick={() => onRemove(note.id)}
            className={cn(ICON_BUTTON, "hover:text-red-300")}
          >
            <TrashIcon className="size-3.5" strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <textarea
        value={note.text}
        placeholder="Write a note…"
        spellCheck={false}
        onChange={(event) => onChange({ ...note, text: event.target.value })}
        className="min-h-0 flex-1 resize-none bg-transparent px-4 pt-8 pb-3 text-[13px] leading-[1.55] text-foreground/90 outline-none placeholder:text-foreground/35"
      />

      {pinnedTarget && (
        <div className="flex items-center gap-1.5 px-4 pb-3">
          <span className="flex min-w-0 items-center gap-1 rounded-md bg-foreground/[0.07] px-1.5 py-0.5 text-[10px] text-foreground/70">
            <LinkIcon className="size-2.5 shrink-0" strokeWidth={2} />
            <span className="truncate">{pinnedTarget.label}</span>
          </span>
        </div>
      )}

      <div
        data-note-resize
        onPointerDown={beginResize}
        onPointerMove={duringResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-hidden="true"
        className={cn(
          "absolute right-0 bottom-0 flex size-6 cursor-nwse-resize touch-none items-end justify-end p-1.5",
          CHROME
        )}
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          className="text-foreground/40"
        >
          <path
            d="M7 1v6H1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  )
}
