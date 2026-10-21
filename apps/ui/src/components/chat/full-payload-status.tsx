import { Spinner } from "@/components/ui/spinner"
import type { FullMessagePayloadStatus } from "@/hooks/use-full-message-payload"
import { cn } from "@/lib/utils"

/**
 * The line shown in place of a diff or an attachment whose payload a light
 * transcript page left out, while `useFullMessagePayload` reads it.
 */
export function FullPayloadStatus({
  status,
  onRetry,
  subject,
  className,
}: {
  status: FullMessagePayloadStatus
  onRetry: () => void
  /** What is being loaded, e.g. "diff" or "attachment". */
  subject: string
  className?: string
}) {
  if (status === "idle") return null
  return (
    <div
      aria-live="polite"
      className={cn(
        "flex items-center gap-1.5 text-[11px] text-muted-foreground",
        className
      )}
    >
      {status === "loading" && (
        <>
          <Spinner className="size-3" />
          <span>Loading {subject}…</span>
        </>
      )}
      {status === "error" && (
        <>
          <span>Couldn’t load this {subject}.</span>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Try again
          </button>
        </>
      )}
      {status === "unavailable" && (
        <span>This {subject} is no longer stored.</span>
      )}
    </div>
  )
}
