import { useState } from "react"
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ChevronDownIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { unsnoozeChats } from "@/lib/chat-list-actions"
import { formatSnoozeTime } from "@/lib/chat-snooze"
import { cn } from "@/lib/utils"

/**
 * Snoozed chats, folded at the very bottom of a chat list: the header reads
 * like Inactive (label, count, rule, chevron) and starts closed. Each row
 * shows when the chat comes back; Unsnooze on the row brings it back now,
 * and opening it ends the snooze too.
 */

const SNOOZED_OPEN_STORAGE_KEY = "betterc0de:sidebar:snoozed-open"

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(SNOOZED_OPEN_STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(SNOOZED_OPEN_STORAGE_KEY, String(open))
  } catch {
    // Storage is optional; the section still folds for this session.
  }
}

export function SnoozedSection({
  items,
  openThread,
  className,
}: {
  items: ReadonlyArray<{
    thread: { id: string; title: string; projectName?: string }
    until: string
  }>
  openThread: (threadId: string, title?: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(readOpen)
  if (items.length === 0) return null
  const now = new Date()
  return (
    <section aria-label="Snoozed chats" className={cn("pt-1", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() =>
          setOpen((current) => {
            writeOpen(!current)
            return !current
          })
        }
        className="group/snoozed flex h-6 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="text-[11px] font-medium text-sidebar-foreground/45 transition-colors duration-75 group-hover/snoozed:text-sidebar-foreground/75">
          Snoozed
        </span>
        <span className="text-[10px] text-sidebar-foreground/30 tabular-nums">
          {items.length}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-sidebar-border" />
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 text-sidebar-foreground/40 transition-transform duration-150 group-hover/snoozed:text-sidebar-foreground/75 motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>
      {open ? (
        <ul className="betterc0de-settled-scroll mt-1 -mr-2 flex max-h-[240px] flex-col gap-px overflow-y-auto [scrollbar-gutter:stable]">
          {items.map(({ thread, until }) => {
            const title = thread.title || "New Task"
            const back = formatSnoozeTime(new Date(until), now)
            return (
              <li
                key={thread.id}
                className="group relative grid grid-cols-[16px_minmax(0,1fr)] items-center gap-x-2 rounded-md py-1 pr-1.5 pl-1.5 transition-colors duration-75 hover:bg-foreground/[0.04]"
              >
                <AlarmClockIcon
                  aria-hidden="true"
                  className="size-3.5 justify-self-center text-sidebar-foreground/40"
                  strokeWidth={1.75}
                />
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    title={`${title}, back ${back}`}
                    onClick={() =>
                      openThread(thread.id, thread.title || undefined)
                    }
                    className="min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left text-[12px] leading-4 text-sidebar-foreground/55 transition-colors duration-75 group-hover:text-sidebar-foreground/90 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {title}
                  </button>
                  <span className="shrink-0 text-[10.5px] leading-4 whitespace-nowrap text-sidebar-foreground/35 tabular-nums transition-opacity duration-75 group-focus-within:opacity-0 group-hover:opacity-0">
                    {back}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Unsnooze ${title}`}
                    title="Unsnooze"
                    className="absolute top-1/2 right-1 size-5 -translate-y-1/2 text-muted-foreground/60 opacity-0 transition-[color,opacity] group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground"
                    onClick={() => unsnoozeChats([thread.id])}
                  >
                    <AlarmClockOffIcon className="size-3" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
