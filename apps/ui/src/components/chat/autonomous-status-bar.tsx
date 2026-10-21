import { useState } from "react"
import {
  CheckIcon,
  InfinityIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useChatStore } from "@/lib/chat-store"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import type {
  AutonomousStatus,
  AutonomousStopReason,
  AutonomousTask,
} from "@/lib/chat/types"

/**
 * Status bar shown above the chat input while Autonomous Work is armed
 * (mode on AND status ≠ "idle").
 *
 * Surfaces:
 *  - Current phase (working / paused / completed)
 *  - Iteration counter `<n>/<max>`
 *  - Elapsed time (and budget if set)
 *  - Task list with click-to-toggle checkboxes so the user can manually
 *    tick items if the model forgets a `[TASK_DONE:<id>]` marker
 *  - Stop reason badge once the run ends
 *  - Pause / Resume / Stop controls (Stop records reason = "user")
 *
 * Controls mutate the chat store directly — the parent threads in props only
 * for reactive values, not setters.
 */

function formatStopReason(reason: AutonomousStopReason): string {
  switch (reason) {
    case "completion-signal":
      return "All tasks complete"
    case "time-budget":
      return "Time budget reached"
    case "max-iterations":
      return "Max iterations reached"
    case "user":
      return "Stopped by user"
    case "error":
      return "Error"
  }
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`
  return `${s}s`
}

export function AutonomousStatusBar({
  autonomousMode,
  autonomousStatus,
  autonomousIterations,
  autonomousMaxIterations,
  autonomousTask,
  autonomousTaskList,
  autonomousTimeBudgetMin,
  autonomousStartedAt,
  autonomousStopReason,
}: {
  autonomousMode: boolean
  autonomousStatus: AutonomousStatus
  autonomousIterations: number
  autonomousMaxIterations: number
  autonomousTask: string | null
  autonomousTaskList: AutonomousTask[] | null
  autonomousTimeBudgetMin: number
  autonomousStartedAt: number | null
  autonomousStopReason: AutonomousStopReason | null
}) {
  // Tick once a second so the elapsed-time readout stays live. Visibility
  // hook pauses the timer while the window is hidden; runOnVisible: true
  // snaps the elapsed label to truth on the next visible edge instead of
  // waiting up to a second for the first tick.
  const [, setTick] = useState(0)
  useVisibilityInterval(() => setTick((n) => n + 1), 1000, {
    enabled: autonomousStatus === "working" && !!autonomousStartedAt,
    runOnVisible: true,
  })

  if (!autonomousMode || autonomousStatus === "idle") return null

  const doneCount = autonomousTaskList
    ? autonomousTaskList.filter((t) => t.done).length
    : 0
  const totalCount = autonomousTaskList ? autonomousTaskList.length : 0

  const elapsedMs = autonomousStartedAt ? Date.now() - autonomousStartedAt : 0
  const elapsedLabel = formatElapsed(elapsedMs)
  const budgetLabel =
    autonomousTimeBudgetMin > 0 ? `${autonomousTimeBudgetMin}m` : "∞"

  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          {autonomousStatus === "working" && (
            <RefreshCwIcon className="size-3.5 animate-spin text-primary" />
          )}
          {autonomousStatus === "paused" && (
            <PauseIcon className="size-3.5 text-yellow-500" />
          )}
          {autonomousStatus === "completed" && (
            <CheckIcon className="size-3.5 text-green-500" />
          )}
          <Badge
            variant="outline"
            className="gap-1 border-primary/30 px-1.5 py-0 text-[10px] font-medium"
          >
            <InfinityIcon className="size-3" />
            Autonomous Work
          </Badge>
        </div>

        <span className="text-muted-foreground">
          {autonomousStatus === "working" && "Working…"}
          {autonomousStatus === "paused" && "Paused"}
          {autonomousStatus === "completed" && "Completed"}
        </span>

        <span
          className="font-mono text-muted-foreground"
          title={`Iteration ${autonomousIterations} of ${autonomousMaxIterations}`}
        >
          {autonomousIterations}/{autonomousMaxIterations}
        </span>

        <span
          className="font-mono text-muted-foreground"
          title={`Elapsed ${elapsedLabel} of ${budgetLabel} budget`}
        >
          {elapsedLabel}/{budgetLabel}
        </span>

        {totalCount > 0 && (
          <span className="font-mono text-muted-foreground">
            {doneCount}/{totalCount} done
          </span>
        )}

        {autonomousStatus === "completed" && autonomousStopReason && (
          <Badge
            variant="outline"
            className="gap-1 border-primary/30 px-1.5 py-0 text-[10px]"
          >
            {formatStopReason(autonomousStopReason)}
          </Badge>
        )}

        {!autonomousTaskList && autonomousTask && (
          <span
            className="ml-1 min-w-0 flex-1 truncate text-muted-foreground"
            title={autonomousTask}
          >
            “{autonomousTask}”
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {autonomousStatus === "working" && (
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px]"
              onClick={() =>
                useChatStore.getState().setAutonomousStatus("paused")
              }
            >
              <PauseIcon className="mr-0.5 size-3" /> Pause
            </Button>
          )}
          {autonomousStatus === "paused" && (
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px]"
              onClick={() =>
                useChatStore.getState().setAutonomousStatus("working")
              }
            >
              <PlayIcon className="mr-0.5 size-3" /> Resume
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive"
            onClick={() => {
              const s = useChatStore.getState()
              s.setAutonomousStopReason("user")
              s.resetAutonomous()
            }}
          >
            <SquareIcon className="mr-0.5 size-3" /> Stop
          </Button>
        </div>
      </div>

      {autonomousTaskList && autonomousTaskList.length > 0 && (
        <ul className="flex flex-col gap-0.5 pl-0.5">
          {autonomousTaskList.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <Checkbox
                checked={t.done}
                onCheckedChange={(checked) =>
                  useChatStore
                    .getState()
                    .markAutonomousTaskDone(t.id, checked === true)
                }
                className="size-3.5 shrink-0"
                aria-label={`Toggle task ${t.text}`}
              />
              <span
                className={
                  t.done
                    ? "truncate text-muted-foreground line-through"
                    : "truncate text-foreground"
                }
                title={t.text}
              >
                {t.text || "(empty)"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
