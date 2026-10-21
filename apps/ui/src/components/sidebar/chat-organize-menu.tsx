import type { MouseEvent } from "react"
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  CalendarClockIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import {
  pinChats,
  snoozeChats,
  unpinChats,
  unsnoozeChats,
} from "@/lib/chat-list-actions"
import { openCustomSnooze } from "@/lib/chat-list-dialogs"
import { arePinned } from "@/lib/chat-pins"
import {
  SNOOZE_PRESETS,
  snoozeEntryFor,
  snoozePresetTime,
} from "@/lib/chat-snooze"
import { useSettingsStore } from "@/lib/settings-store"

/**
 * Pin / Unpin and the Snooze submenu, shared by every chat menu in the
 * sidebar (rows, cards, the folder list) and by the bulk bar. Items stop
 * their clicks: the menus are portaled, and a click would otherwise bubble
 * to the row and open the chat.
 */

function stop(event: MouseEvent) {
  event.stopPropagation()
}

/** "15:30" or "Tue 09:00", the time a preset would wake the chat. */
function presetHint(date: Date, now: Date): string {
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`
}

export function PinMenuItem({ threadIds }: { threadIds: string[] }) {
  const pinned = useSettingsStore((state) =>
    arePinned(state.pinnedThreadIds, threadIds)
  )
  const Icon = pinned ? PinOffIcon : PinIcon
  return (
    <DropdownMenuItem
      onClick={(event) => {
        stop(event)
        if (pinned) unpinChats(threadIds)
        else pinChats(threadIds)
      }}
    >
      <Icon className="size-3.5" />
      {pinned ? "Unpin" : "Pin"}
    </DropdownMenuItem>
  )
}

/** The presets, Custom… and, for a snoozed chat, Unsnooze. */
export function SnoozeMenuItems({ threadIds }: { threadIds: string[] }) {
  const snoozed = useSettingsStore((state) =>
    threadIds.some((id) => snoozeEntryFor(state.snoozedThreads, id))
  )
  const now = new Date()
  return (
    <>
      {SNOOZE_PRESETS.map((preset) => {
        const until = snoozePresetTime(preset.id, now)
        return (
          <DropdownMenuItem
            key={preset.id}
            onClick={(event) => {
              stop(event)
              snoozeChats(threadIds, snoozePresetTime(preset.id, new Date()))
            }}
          >
            {preset.label}
            {preset.id === "1h" || preset.id === "3h" ? (
              <DropdownMenuShortcut className="tracking-normal tabular-nums">
                {presetHint(until, now)}
              </DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        )
      })}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={(event) => {
          stop(event)
          openCustomSnooze(threadIds)
        }}
      >
        <CalendarClockIcon className="size-3.5" />
        Custom…
      </DropdownMenuItem>
      {snoozed ? (
        <DropdownMenuItem
          onClick={(event) => {
            stop(event)
            unsnoozeChats(threadIds)
          }}
        >
          <AlarmClockOffIcon className="size-3.5" />
          Unsnooze
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

export function SnoozeMenuSub({ threadIds }: { threadIds: string[] }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger onClick={stop}>
        <AlarmClockIcon className="size-3.5" />
        Snooze
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-52">
        <SnoozeMenuItems threadIds={threadIds} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Pin / Unpin and Snooze, as the first items of a chat's menu. */
export function ChatOrganizeMenuItems({ threadId }: { threadId: string }) {
  const ids = [threadId]
  return (
    <>
      <PinMenuItem threadIds={ids} />
      <SnoozeMenuSub threadIds={ids} />
    </>
  )
}
