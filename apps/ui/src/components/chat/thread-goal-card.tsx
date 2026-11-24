import { useEffect, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  Clock3Icon,
  EllipsisIcon,
  InfoIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Repeat2Icon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Target02Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SimpleDropdown,
  SimpleDropdownItem,
} from "@/components/ui/simple-dropdown"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/lib/chat-store"
import {
  useThreadIsRunning,
  useThreadRunningElapsed,
} from "@/lib/chat/running-selectors"
import type { ThreadGoalStatus } from "@/lib/chat/types"
import type { ChatSubmitPayload } from "@/hooks/use-chat-submit"

const GOAL_STATUS_LABELS: Record<ThreadGoalStatus, string> = {
  active: "Goal in progress",
  paused: "Goal paused",
  achieved: "Goal achieved",
  blocked: "Goal blocked",
  usageLimited: "Usage limit reached",
  budgetLimited: "Token budget reached",
  unknown: "Goal status unavailable",
}

export function ThreadGoalCard({
  threadId,
  handleSubmit,
}: {
  threadId: string | null
  handleSubmit: (payload: ChatSubmitPayload) => void
}) {
  const goal = useChatStore((state) =>
    threadId ? state.settingsByThread[threadId]?.goal : null
  )
  const running = useThreadIsRunning(threadId)
  const runningFor = useThreadRunningElapsed(threadId)
  const [collapsed, setCollapsed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const objective = goal?.objective

  useEffect(() => {
    setDraft(objective ?? "")
    setEditing(false)
    setActionsOpen(false)
  }, [objective, threadId])

  if (!goal) return null

  const submitCommand = (text: string) =>
    handleSubmit({ text, files: [], threadId })
  const saveEdit = () => {
    if (!draft.trim()) return
    submitCommand(`/goal edit ${draft.trim()}`)
    setEditing(false)
  }
  const cancelEdit = () => {
    setDraft(goal.objective)
    setEditing(false)
  }
  const managed = goal.source === "betterc0de"
  // The backend publishes a goal only when a cycle settles, so while the first
  // turn runs the stored state still reads "0 turns · Waiting to start." The
  // live stream knows better: show the turn in progress and its clock.
  const working = goal.status === "active" && running
  const nextTurn = (goal.turns ?? 0) + 1
  const note =
    working && (goal.turns ?? 0) === 0
      ? "Working on the first turn."
      : goal.lastReason

  return (
    // Match the composer surround, including its theme token and width.
    <Collapsible
      open={!collapsed}
      onOpenChange={(open) => setCollapsed(!open)}
      asChild
    >
      <section
        aria-label="Thread goal"
        className="mx-auto mb-2 w-full max-w-[1080px] min-w-0 rounded-2xl border border-border/50 bg-sidebar text-foreground"
      >
        <div className="flex min-w-0 items-center gap-1 p-1.5">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              aria-label={collapsed ? "Expand goal" : "Collapse goal"}
              className="h-8 min-w-0 flex-1 justify-start gap-2 rounded-lg px-1.5 text-[11px] font-medium text-muted-foreground transition-colors aria-expanded:bg-transparent aria-expanded:text-muted-foreground"
            >
              <HugeiconsIcon
                icon={Target02Icon}
                strokeWidth={1.8}
                className="size-3.5 shrink-0"
              />
              <span aria-live="polite" className="truncate">
                {GOAL_STATUS_LABELS[goal.status] ?? GOAL_STATUS_LABELS.unknown}
              </span>
              {collapsed && (
                <span className="min-w-0 flex-1 truncate text-left font-normal text-foreground">
                  {goal.objective}
                </span>
              )}
              <ChevronDownIcon
                className={cn(
                  "size-3 shrink-0 transition-transform",
                  collapsed && "-rotate-90"
                )}
              />
            </Button>
          </CollapsibleTrigger>
          {managed && !editing ? (
            <div className="flex shrink-0 items-center gap-1">
              {goal.status !== "unknown" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={
                    goal.status === "active" ? "Pause goal" : "Resume goal"
                  }
                  // A filled pill: the transparent outline vanished on the
                  // card's dark chrome, and the one control that stops the
                  // agent has to be the first thing the eye finds.
                  className="h-7 gap-1.5 rounded-full border-foreground/15 bg-foreground/10 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-foreground/15 hover:text-foreground dark:bg-foreground/10 dark:hover:bg-foreground/15"
                  onClick={() =>
                    submitCommand(
                      goal.status === "active" ? "/goal pause" : "/goal resume"
                    )
                  }
                >
                  {/* Solid glyphs: the outlined bars at 12px read as a
                      hollow box, not as "pause". */}
                  {goal.status === "active" ? (
                    <PauseIcon
                      className="size-3.5"
                      fill="currentColor"
                      strokeWidth={0}
                      aria-hidden
                    />
                  ) : (
                    <PlayIcon
                      className="size-3.5"
                      fill="currentColor"
                      strokeWidth={0}
                      aria-hidden
                    />
                  )}
                  {goal.status === "active" ? "Pause" : "Resume"}
                </Button>
              ) : null}
              <SimpleDropdown
                align="end"
                open={actionsOpen}
                onOpenChange={setActionsOpen}
                className="min-w-36"
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Goal actions"
                    aria-haspopup="menu"
                    aria-expanded={actionsOpen}
                    title="Goal actions"
                    className="size-7 rounded-full border border-foreground/15 bg-foreground/6 text-foreground/80 transition-colors hover:bg-foreground/12 hover:text-foreground dark:hover:bg-foreground/12"
                  >
                    <EllipsisIcon className="size-3.5" strokeWidth={2} />
                  </Button>
                }
              >
                <SimpleDropdownItem
                  onClick={() => {
                    setDraft(goal.objective)
                    setCollapsed(false)
                    setEditing(true)
                  }}
                >
                  <PencilIcon className="size-3.5" />
                  Edit goal
                </SimpleDropdownItem>
                <SimpleDropdownItem
                  onClick={() => submitCommand("/goal clear")}
                >
                  <Trash2Icon className="size-3.5" />
                  Clear goal
                </SimpleDropdownItem>
              </SimpleDropdown>
            </div>
          ) : null}
        </div>
        <CollapsibleContent className="betterc0de-collapsible-content">
          <div className="min-w-0 px-3 pb-3">
            {editing ? (
              <div className="space-y-2">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.ctrlKey || event.metaKey)
                    ) {
                      event.preventDefault()
                      saveEdit()
                    }
                    if (event.key === "Escape") cancelEdit()
                  }}
                  autoFocus
                  aria-label="Goal objective"
                  rows={3}
                  className="min-h-20 resize-y rounded-xl border-border/50 bg-background px-2.5 py-2 text-[13px] leading-5 md:text-[13px]"
                />
                <div className="flex flex-wrap items-center justify-end gap-1">
                  <span className="mr-auto text-[10px] text-muted-foreground">
                    Ctrl / Cmd Enter to save
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Cancel editing"
                    className="h-7 gap-1 rounded-full px-2.5 text-[11px] transition-colors"
                    onClick={cancelEdit}
                  >
                    <XIcon className="size-3" />
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Save goal"
                    disabled={!draft.trim()}
                    className="h-7 gap-1 rounded-full bg-transparent px-2.5 text-[11px] transition-colors"
                    onClick={saveEdit}
                  >
                    <CheckIcon className="size-3" />
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="max-h-28 overflow-y-auto text-[13px] leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap">
                  {goal.objective}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground">
                  {working ? (
                    <span
                      aria-live="polite"
                      className="inline-flex items-center gap-1.5 font-medium text-foreground tabular-nums"
                    >
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full bg-foreground/80"
                      />
                      Turn {nextTurn}
                      {runningFor ? ` · ${runningFor}` : ""}
                    </span>
                  ) : null}
                  {goal.turns !== undefined ? (
                    <span className="inline-flex items-center gap-1.5 tabular-nums">
                      <Repeat2Icon className="size-3" aria-hidden />
                      {goal.turns} {goal.turns === 1 ? "turn" : "turns"}
                    </span>
                  ) : null}
                  {goal.tokens !== undefined ? (
                    <span className="tabular-nums">
                      {goal.tokens.toLocaleString()}
                      {goal.tokenBudget != null
                        ? ` / ${goal.tokenBudget.toLocaleString()}`
                        : ""}{" "}
                      tokens
                    </span>
                  ) : goal.tokenBudget != null ? (
                    <span className="tabular-nums">
                      Budget: {goal.tokenBudget.toLocaleString()} tokens
                    </span>
                  ) : null}
                  {goal.timeUsedSeconds !== undefined ? (
                    <span
                      className="inline-flex items-center gap-1.5 tabular-nums"
                      title="Time spent working"
                    >
                      <Clock3Icon className="size-3" aria-hidden />
                      {formatElapsed(goal.timeUsedSeconds * 1000)}
                    </span>
                  ) : null}
                </div>
                {note ? (
                  <div className="mt-2 flex min-w-0 items-start gap-1.5 text-[11px] leading-[18px] text-muted-foreground">
                    <InfoIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <p className="min-w-0 text-pretty [overflow-wrap:anywhere]">
                      {note}
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${remainder}s`
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`
  if (minutes > 0) return `${minutes}m ${remainder}s`
  return `${remainder}s`
}
