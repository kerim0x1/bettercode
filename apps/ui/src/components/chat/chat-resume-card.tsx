import { useState, type KeyboardEvent } from "react"
import {
  Loader2Icon,
  PlayIcon,
  RotateCcwIcon,
  TimerResetIcon,
  XIcon,
} from "lucide-react"
import type { ChatResumeAction, ThreadResume } from "@betterc0de/schema"
import { Button } from "@/components/ui/button"
import { handleError } from "@/lib/errors/handle"
import {
  formatResetTime,
  resumeStatusText,
  resumeTitle,
} from "@/lib/chat-resume"
import {
  controlChatResume,
  useResumeClock,
  useThreadResume,
} from "@/lib/chat-resume-store"
import { cn } from "@/lib/utils"

/**
 * Shown above the composer while a usage limit (or a restart) has stopped
 * the chat and BetterC0de may resume it (`@/lib/chat-resume-store`). A
 * two-way choice, "Resume at 14:30" or "Don't resume", preselected from
 * Settings → Chat; "Resume now" sends the message at once. Hidden while the
 * resumed turn runs: the transcript shows its note then.
 */
export function ChatResumeCard({ threadId }: { threadId: string | null }) {
  const resume = useThreadResume(threadId)
  const now = useResumeClock(resume !== null)
  const [pending, setPending] = useState<ChatResumeAction | null>(null)
  if (!threadId || !resume || resume.status === "resuming") return null

  const act = (action: ChatResumeAction) => {
    if (pending) return
    setPending(action)
    void controlChatResume(threadId, action)
      .catch((error: unknown) => handleError(error, { source: "chat-resume" }))
      .finally(() => setPending(null))
  }
  const limit = resume.reason !== "restart"
  const Icon = limit ? TimerResetIcon : RotateCcwIcon
  // The choice only means something until the reset has passed.
  const choosable =
    limit &&
    resume.resumable &&
    (resume.mode === "auto" || resume.resetAt === null || resume.resetAt > now)

  return (
    <section
      aria-label={resumeTitle(resume)}
      className="mx-auto mb-2 w-full max-w-[900px] min-w-0 rounded-2xl border border-border/50 bg-sidebar px-3 py-2.5 text-foreground"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-warning"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium">{resumeTitle(resume)}</p>
          <p
            aria-live="polite"
            className="mt-0.5 text-[11.5px] text-muted-foreground"
          >
            {resumeStatusText(resume, now)}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          title="Dismiss"
          disabled={pending !== null}
          className="shrink-0 text-muted-foreground"
          onClick={() => act("dismiss")}
        >
          <XIcon />
        </Button>
      </div>
      {choosable || resume.resumable ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-[26px]">
          {choosable ? (
            <ResumeChoice
              resume={resume}
              now={now}
              disabled={pending !== null}
              onChoose={(mode) => act(mode === "auto" ? "schedule" : "cancel")}
            />
          ) : null}
          {resume.resumable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending !== null}
              aria-busy={pending === "now"}
              className="h-7 rounded-lg px-2.5 text-[12px]"
              onClick={() => act("now")}
            >
              {pending === "now" ? (
                <Loader2Icon
                  aria-hidden="true"
                  className="size-3.5 motion-safe:animate-spin"
                />
              ) : (
                <PlayIcon aria-hidden="true" className="size-3.5" />
              )}
              Resume now
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

const CHOICES = ["auto", "off"] as const

/**
 * "Resume at 14:30" / "Don't resume", in the segmented style of the
 * Appearance mode switch. Arrow keys move the choice, as in any radio group.
 */
function ResumeChoice({
  resume,
  now,
  disabled,
  onChoose,
}: {
  resume: ThreadResume
  now: number
  disabled: boolean
  onChoose: (mode: ThreadResume["mode"]) => void
}) {
  const label = (mode: ThreadResume["mode"]) =>
    mode === "off"
      ? "Don't resume"
      : resume.resetAt !== null && resume.resetAt > now
        ? `Resume at ${formatResetTime(resume.resetAt, now)}`
        : "Resume automatically"
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0
    if (!step) return
    event.preventDefault()
    const index = CHOICES.indexOf(resume.mode)
    const next = CHOICES[(index + step + CHOICES.length) % CHOICES.length]!
    onChoose(next)
    const group = event.currentTarget
    requestAnimationFrame(() =>
      group.querySelector<HTMLButtonElement>(`[data-choice="${next}"]`)?.focus()
    )
  }
  return (
    <div
      role="radiogroup"
      aria-label="When to resume"
      onKeyDown={onKeyDown}
      className="flex items-center gap-0.5 rounded-[10px] border border-border/60 bg-card/70 p-[3px]"
    >
      {CHOICES.map((mode) => {
        const selected = resume.mode === mode
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            data-choice={mode}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!selected) onChoose(mode)
            }}
            className={cn(
              "flex h-6 items-center rounded-md px-2.5 text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-60",
              selected
                ? "bg-primary/15 font-medium text-primary"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
          >
            {label(mode)}
          </button>
        )
      })}
    </div>
  )
}
