import { useEffect, useState } from "react"
import { PlusIcon, XIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useChatStore } from "@/lib/chat-store"
import type { ChatSubmitPayload } from "@/hooks/use-chat-submit"
import {
  AUTONOMOUS_DEFAULT_TIME_BUDGET_MIN,
  AUTONOMOUS_MAX_ITERATIONS,
  type AutonomousTask,
} from "@/lib/chat/types"

/**
 * Start-dialog for an Autonomous Work run.
 *
 * The user enters a structured checklist of tasks, picks limits (max
 * iterations + wall-clock budget), and hits Start. We commit the fields to
 * the chat store and fire the initial user message via `handleSubmit` so the
 * assistant kicks off the run like any other turn — then `useAutonomousLoop`
 * takes over, watching `isStreaming` transitions and firing follow-ups until
 * a termination condition is hit.
 *
 * Opening the dialog mid-run (user re-opens to edit tasks) re-hydrates from
 * the current store snapshot. Start re-commits and re-triggers.
 */
export function AutonomousWorkDialog({
  open,
  onOpenChange,
  handleSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  handleSubmit: (args: ChatSubmitPayload) => void
}) {
  const [rows, setRows] = useState<AutonomousTask[]>([])
  const [maxIter, setMaxIter] = useState<number>(AUTONOMOUS_MAX_ITERATIONS)
  const [timeBudget, setTimeBudget] = useState<number>(
    AUTONOMOUS_DEFAULT_TIME_BUDGET_MIN
  )

  // Hydrate from store every time the dialog opens. This lets the user
  // reopen to adjust tasks / limits for an in-flight or paused run without
  // losing what they had.
  useEffect(() => {
    if (!open) return
    const s = useChatStore.getState()
    const existing = s.autonomousTaskList
    setRows(
      existing && existing.length > 0
        ? existing.map((t) => ({ ...t }))
        : [{ id: crypto.randomUUID(), text: "", done: false }]
    )
    setMaxIter(s.autonomousMaxIterations || AUTONOMOUS_MAX_ITERATIONS)
    setTimeBudget(
      typeof s.autonomousTimeBudgetMin === "number"
        ? s.autonomousTimeBudgetMin
        : AUTONOMOUS_DEFAULT_TIME_BUDGET_MIN
    )
  }, [open])

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      { id: crypto.randomUUID(), text: "", done: false },
    ])

  const removeRow = (id: string) =>
    setRows((prev) =>
      prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)
    )

  const updateRow = (id: string, text: string) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, text } : r)))

  const nonEmpty = rows.filter((r) => r.text.trim().length > 0)
  const canStart = nonEmpty.length > 0 && maxIter >= 1 && timeBudget >= 0

  const onStart = () => {
    if (!canStart) return
    const cleaned: AutonomousTask[] = nonEmpty.map((r) => ({
      id: r.id,
      text: r.text.trim(),
      done: false,
    }))

    const s = useChatStore.getState()
    const threadId =
      s.activeThreadId ?? s.createThread("New Chat", "BetterC0de")
    s.setAutonomousTaskList(cleaned)
    s.setAutonomousMaxIterations(maxIter)
    s.setAutonomousTimeBudget(timeBudget)
    s.setAutonomousIterations(0)
    s.setAutonomousStopReason(null)
    // setAutonomousMode resets status to "idle"; then setAutonomousStatus
    // stamps startedAt on the idle→working transition.
    s.setAutonomousMode(true)
    s.setAutonomousTask(cleaned[0]?.text ?? null)
    s.setAutonomousStatus("working")

    const taskListBlock = cleaned
      .map((t) => `- [${t.done ? "x" : " "}] ${t.id}: ${t.text}`)
      .join("\n")

    const budgetLine =
      timeBudget > 0
        ? `Wall-clock budget: ${timeBudget} minutes. Max iterations: ${maxIter}.`
        : `No wall-clock limit. Max iterations: ${maxIter}.`

    const introPrompt = [
      "[Autonomous Work — run started]",
      "",
      "You are running in autonomous mode. Work through the task list below",
      "without waiting for user confirmation between turns.",
      "",
      budgetLine,
      "",
      "Task list:",
      taskListBlock,
      "",
      "Protocol:",
      "- Start by laying out a short plan (3–7 bullets) covering all tasks.",
      "- Execute the highest-priority unchecked task, using tools as needed.",
      "- When you finish a task, emit a marker `[TASK_DONE:<id>]` on its own",
      "  line so the harness can tick it off.",
      "- After each turn the harness will send a follow-up until all tasks",
      "  are done or a limit is hit.",
      "- If blocked by a missing detail, pick the safest assumption and",
      "  note it, then keep moving.",
    ].join("\n")

    onOpenChange(false)
    handleSubmit({ threadId, text: introPrompt, files: [] })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>Autonomous Work</DialogTitle>
        <DialogDescription>
          Run a structured task list autonomously. The assistant iterates turn
          by turn until every task is done or a limit is hit.
        </DialogDescription>

        <div className="flex flex-col gap-4 py-1">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">
                Task list
              </label>
              <span className="text-[10px] text-muted-foreground/70">
                {nonEmpty.length} task{nonEmpty.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {rows.map((row, i) => (
                <div key={row.id} className="flex items-center gap-1.5">
                  <span className="w-5 shrink-0 text-right text-[10px] text-muted-foreground/60 tabular-nums">
                    {i + 1}.
                  </span>
                  <Input
                    value={row.text}
                    onChange={(e) => updateRow(row.id, e.target.value)}
                    placeholder={`Task ${i + 1}`}
                    className="h-8 text-xs"
                    autoFocus={i === 0 && !row.text}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeRow(row.id)}
                    disabled={rows.length <= 1}
                    aria-label="Remove task"
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 self-start text-xs"
              onClick={addRow}
            >
              <PlusIcon className="size-3.5" />
              Add task
            </Button>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex flex-1 flex-col gap-1">
              <label
                htmlFor="autonomous-max-iter"
                className="text-xs font-medium text-muted-foreground"
              >
                Max iterations
              </label>
              <Input
                id="autonomous-max-iter"
                type="number"
                min={1}
                step={1}
                value={maxIter}
                onChange={(e) =>
                  setMaxIter(Math.max(1, Number(e.target.value) || 1))
                }
                className="h-8 text-xs"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label
                htmlFor="autonomous-time-budget"
                className="text-xs font-medium text-muted-foreground"
              >
                Time budget (min, 0 = unlimited)
              </label>
              <Input
                id="autonomous-time-budget"
                type="number"
                min={0}
                step={5}
                value={timeBudget}
                onChange={(e) =>
                  setTimeBudget(Math.max(0, Number(e.target.value) || 0))
                }
                className="h-8 text-xs"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onStart} disabled={!canStart}>
            Start run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
