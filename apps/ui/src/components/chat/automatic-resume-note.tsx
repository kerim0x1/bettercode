import { RotateCcwIcon, TimerResetIcon } from "lucide-react"
import type { ChatMessage } from "@betterc0de/schema"

/**
 * A message BetterC0de sent by itself to resume the chat
 * (`ChatMessage.automatic`): after a usage limit reset, or after a restart
 * cut the turn off. Shown as a divider note like a model switch, not as a
 * bubble the user typed; the message itself stays readable beside it.
 */
export function AutomaticResumeNote({
  message,
}: {
  message: Pick<ChatMessage, "automatic" | "content">
}) {
  const restart = message.automatic === "restart"
  const Icon = restart ? RotateCcwIcon : TimerResetIcon
  return (
    <div
      role="note"
      className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground/70"
    >
      <span className="h-px min-w-6 flex-1 bg-border/45" aria-hidden="true" />
      <span className="flex min-w-0 shrink items-center gap-1.5">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0">
          {restart
            ? "Continued after the app restarted"
            : "Resumed after the limit reset"}
        </span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate" title={message.content}>
          “{message.content}”
        </span>
      </span>
      <span className="h-px min-w-6 flex-1 bg-border/45" aria-hidden="true" />
    </div>
  )
}
