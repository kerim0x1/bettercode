import { useEffect, useId } from "react"
import { BellRingIcon } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { handleError } from "@/lib/errors"
import {
  usePullRequestWake,
  usePullRequestWakeStore,
} from "@/lib/pull-request-wake-store"
import { isRemoteRuntime } from "@/services/backend/runtime"

export const WAKE_LABEL = "Wake on CI failure or review"
export const WAKE_DESCRIPTION =
  "When a check fails, someone reviews or comments, or the branch stops merging cleanly, this chat gets a message and starts working; while it is busy the message waits in its queue."

/** Turns a chat's pull request wake-ups on or off (desktop only). */
export async function setPullRequestWake(
  threadId: string,
  enabled: boolean
): Promise<void> {
  try {
    await usePullRequestWakeStore.getState().setEnabled(threadId, enabled)
  } catch (error) {
    handleError(error, { source: "pull-request-wake" })
  }
}

/**
 * The wake-up switch as a settings-style row: icon, label, what it does,
 * the watcher's last word, and the switch. Not offered in a paired browser,
 * where the desktop would start the turns.
 */
export function PullRequestWakeSwitch({ threadId }: { threadId: string }) {
  const id = useId()
  const watch = usePullRequestWake(threadId)
  const saving = usePullRequestWakeStore((state) =>
    Boolean(state.saving[threadId])
  )
  const loaded = usePullRequestWakeStore((state) => state.loaded)
  useEffect(() => {
    if (!loaded && !isRemoteRuntime())
      void usePullRequestWakeStore.getState().refresh()
  }, [loaded])
  if (isRemoteRuntime()) return null
  const enabled = watch?.enabled === true
  return (
    <div className="flex items-start gap-3 rounded-xl bg-muted/30 px-3 py-2.5">
      <BellRingIcon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-[13px] font-medium">
          {WAKE_LABEL}
        </label>
        <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
          {WAKE_DESCRIPTION}
        </p>
        {watch?.message ? (
          <p
            role="status"
            className="mt-1 text-[11px] text-muted-foreground/80"
          >
            {watch.message}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        size="sm"
        className="mt-0.5"
        aria-label={WAKE_LABEL}
        checked={enabled}
        disabled={saving}
        onCheckedChange={(checked) =>
          void setPullRequestWake(threadId, checked)
        }
      />
    </div>
  )
}
