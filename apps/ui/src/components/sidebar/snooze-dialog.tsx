import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { chatListLabel, snoozeChats } from "@/lib/chat-list-actions"
import {
  closeCustomSnooze,
  useChatListDialogsStore,
} from "@/lib/chat-list-dialogs"
import {
  formatSnoozeTime,
  parseSnoozeInput,
  snoozeInputValues,
  snoozePresetTime,
} from "@/lib/chat-snooze"

/**
 * The snooze menus' **Custom…**: a date and a time (the platform pickers),
 * starting at tomorrow 9:00. A time that is not in the future is refused
 * with a message under the fields.
 */
export function SnoozeCustomDialog() {
  const threadIds = useChatListDialogsStore((state) => state.snoozeThreadIds)
  return (
    <Dialog
      open={threadIds !== null}
      onOpenChange={(open) => {
        if (!open) closeCustomSnooze()
      }}
    >
      {threadIds ? (
        <SnoozeCustomForm key={threadIds.join("\n")} threadIds={threadIds} />
      ) : null}
    </Dialog>
  )
}

function SnoozeCustomForm({ threadIds }: { threadIds: string[] }) {
  const [initial] = useState(() =>
    snoozeInputValues(snoozePresetTime("tomorrow", new Date()))
  )
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const [error, setError] = useState<string | null>(null)
  const until = parseSnoozeInput(date, time)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!until) {
      setError("Choose a date and a time.")
      return
    }
    if (until.getTime() <= Date.now()) {
      setError("Choose a time in the future.")
      return
    }
    snoozeChats(threadIds, until)
    closeCustomSnooze()
  }

  return (
    <DialogContent className="sm:max-w-sm">
      <form onSubmit={submit} className="grid gap-5">
        <DialogHeader>
          <DialogTitle>Snooze until</DialogTitle>
          <DialogDescription>
            {threadIds.length === 1
              ? `${chatListLabel(threadIds)} leaves the chat list until then. A new message or a request for you brings it back sooner.`
              : `${chatListLabel(threadIds)} leave the chat list until then. A new message or a request for you brings one back sooner.`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="snooze-date" className="text-xs">
              Date
            </Label>
            <Input
              id="snooze-date"
              type="date"
              value={date}
              min={snoozeInputValues(new Date()).date}
              aria-invalid={error !== null}
              onChange={(event) => {
                setDate(event.target.value)
                setError(null)
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="snooze-time" className="text-xs">
              Time
            </Label>
            <Input
              id="snooze-time"
              type="time"
              value={time}
              aria-invalid={error !== null}
              onChange={(event) => {
                setTime(event.target.value)
                setError(null)
              }}
            />
          </div>
        </div>
        {error ? (
          <p role="alert" className="-mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : until ? (
          <p className="-mt-2 text-xs text-muted-foreground" aria-live="polite">
            Back {formatSnoozeTime(until, new Date())}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={closeCustomSnooze}>
            Cancel
          </Button>
          <Button type="submit">Snooze</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
