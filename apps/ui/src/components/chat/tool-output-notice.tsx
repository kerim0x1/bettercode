import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2Icon } from "lucide-react"
import { formatByteSize } from "@betterc0de/schema/output-bounds"
import { extractToolOutputText } from "@betterc0de/schema/tool-activity"
import { Button } from "@/components/ui/button"
import { HttpError } from "@/lib/errors/types"
import type { ToolFullOutputRef } from "@/lib/tool-full-output"
import { cn } from "@/lib/utils"
import { loadThreadActivityOutput } from "@/services/backend/coreApi"

/** The "Show full output" request of one tool step. */
export type ToolFullOutputState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "loaded"
      text: string
      /** UTF-8 bytes of the whole output. */
      bytes: number
      /** The journal had to shorten the event, so this copy is cut too. */
      truncated: boolean
    }
  | { status: "error"; message: string }

const IDLE: ToolFullOutputState = { status: "idle" }

/** The text the step shows for an output value, as `buildActivityTools` derives it. */
export function fullOutputText(output: unknown): string {
  const text = extractToolOutputText(output)
  if (text !== undefined) return text
  if (typeof output === "string") return output
  if (output === null || output === undefined) return ""
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

export function fullOutputErrorMessage(error: unknown): string {
  // The backend's 404 bodies are written for the user ("… no longer
  // retained."); anything else is a transport failure.
  if (error instanceof HttpError && error.message) return error.message
  return "The full output could not be loaded. Try again in a moment."
}

/**
 * Loads the whole output of a bounded tool activity on request. The state is
 * keyed by the activity, so a row that starts showing another activity
 * starts over; a request still running when the row unmounts or switches
 * activity is aborted.
 */
export function useToolFullOutput(ref: ToolFullOutputRef | undefined): {
  state: ToolFullOutputState
  load: () => void
} {
  const threadId = ref?.threadId
  const activityId = ref?.activityId
  const key = threadId && activityId ? `${threadId}\u0000${activityId}` : ""
  const [entry, setEntry] = useState<{
    key: string
    state: ToolFullOutputState
  } | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      controllerRef.current?.abort()
      controllerRef.current = null
    },
    [key]
  )

  const load = useCallback(() => {
    if (!threadId || !activityId) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setEntry({ key, state: { status: "loading" } })
    loadThreadActivityOutput(threadId, activityId, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return
        setEntry({
          key,
          state: {
            status: "loaded",
            text: fullOutputText(result.output),
            bytes: result.bytes,
            truncated: result.truncated,
          },
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setEntry({
          key,
          state: { status: "error", message: fullOutputErrorMessage(error) },
        })
      })
  }, [threadId, activityId, key])

  return {
    state: entry && entry.key === key && key ? entry.state : IDLE,
    load,
  }
}

/**
 * The line under a tool step's output preview that says the output is cut,
 * by how much, and offers the whole output when the backend still has it.
 * Renders nothing when the output is complete.
 */
export function ToolOutputNotice({
  outputTruncated,
  outputBounded,
  outputBytes,
  canLoadFullOutput,
  fullOutput,
  onLoadFullOutput,
  className,
}: {
  /** The chat preview shows only the start of the output. */
  outputTruncated?: boolean
  /** The output itself was cut in the middle when it was recorded. */
  outputBounded?: boolean
  /** UTF-8 bytes of the whole output, when known. */
  outputBytes?: number
  canLoadFullOutput: boolean
  fullOutput: ToolFullOutputState
  onLoadFullOutput: () => void
  className?: string
}) {
  if (fullOutput.status === "loaded") {
    return (
      <div className={cn("text-[10px] text-muted-foreground", className)}>
        {fullOutput.truncated
          ? `Showing the recorded output (${formatByteSize(fullOutput.bytes)}). The recording was already shortened, so part of the middle is missing.`
          : `Showing the full output (${formatByteSize(fullOutput.bytes)}).`}
      </div>
    )
  }
  if (!outputBounded && !outputTruncated) return null
  if (!outputBounded) {
    return (
      <div className={cn("text-[10px] text-muted-foreground", className)}>
        Output truncated in chat preview.
      </div>
    )
  }

  const size =
    typeof outputBytes === "number"
      ? `${formatByteSize(outputBytes)} total, `
      : ""
  const loading = fullOutput.status === "loading"
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground",
        className
      )}
    >
      <span>{`Output truncated: ${size}the middle is not shown.`}</span>
      {canLoadFullOutput && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-5 rounded-md px-1.5 text-[10px] text-foreground/80"
          disabled={loading}
          aria-busy={loading || undefined}
          onClick={(event) => {
            event.stopPropagation()
            onLoadFullOutput()
          }}
        >
          {loading && (
            <Loader2Icon
              className="size-3 motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          {loading
            ? "Loading full output…"
            : fullOutput.status === "error"
              ? "Try again"
              : "Show full output"}
        </Button>
      )}
      {fullOutput.status === "error" && (
        <span role="alert" className="basis-full text-destructive">
          {fullOutput.message}
        </span>
      )}
    </div>
  )
}
