import { CopyIcon, PlayIcon, SearchIcon } from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ClipboardIcon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { MessageResponse } from "@/components/ai-elements/message"
import { usePlanStreamingState } from "@/hooks/use-chat-streaming-state"
import type { SetPlanModalContent } from "@/lib/plan-modal"

/**
 * Per-pane Plans tab. Derives its plan list from the pane's own thread via
 * `usePlanStreamingState` (the same cached plan derivation ChatColumn reads),
 * so each pane shows its own plans independent of the globally active thread,
 * without re-rendering on ordinary answer deltas. Markup lifted from
 * the former global WorkspaceRightPanel plan tab.
 */
export function PlanListBody({
  threadId,
  setPlanModalContent,
}: {
  threadId: string | null
  setPlanModalContent: SetPlanModalContent
}) {
  const { allPlans, isPlanStreaming } = usePlanStreamingState(threadId)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-2">
        <HugeiconsIcon
          icon={ClipboardIcon}
          strokeWidth={2}
          className="size-4 text-sky-400"
        />
        <span className="flex-1 text-xs font-medium text-sidebar-foreground">
          Plans
        </span>
        <span className="text-[10px] text-muted-foreground">
          {allPlans.length}
        </span>
        {isPlanStreaming && (
          <span className="animate-pulse text-[10px] text-primary">Live</span>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {allPlans.length === 0 ? (
          <p className="text-xs text-muted-foreground/70">
            No plans yet. Use plan mode to generate one.
          </p>
        ) : (
          allPlans
            .slice()
            .reverse()
            .map((plan, reversedIdx) => {
              const planNumber = allPlans.length - reversedIdx
              return (
                <div
                  key={plan.id}
                  className="overflow-hidden rounded-lg border border-sidebar-border bg-sidebar"
                >
                  <div className="flex items-center gap-2 border-b border-sidebar-border px-3 py-1.5">
                    <span className="text-[10px] font-medium text-muted-foreground">
                      Plan #{planNumber}
                    </span>
                    {plan.streaming && (
                      <span className="animate-pulse text-[10px] text-primary">
                        Live
                      </span>
                    )}
                    {plan.createdAt && !plan.streaming && (
                      <span className="text-[10px] text-muted-foreground/60">
                        {new Date(plan.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                    <div className="flex-1" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => {
                            navigator.clipboard
                              .writeText(plan.content)
                              .catch(() => {
                                /* clipboard may be unavailable */
                              })
                          }}
                          className="text-sidebar-foreground hover:text-foreground"
                        >
                          <CopyIcon className="size-3.5" strokeWidth={1.5} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">Copy</TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="space-y-3 p-3">
                    <div className="plan-preview-prose text-xs leading-relaxed text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      <MessageResponse>{plan.preview}</MessageResponse>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="xs"
                        className="flex-1 gap-1.5"
                        variant="outline"
                        onClick={() =>
                          setPlanModalContent({
                            threadId,
                            content: plan.content,
                            sourceProposedPlan: plan.sourceProposedPlan ?? null,
                            implemented: plan.implemented ?? false,
                            implementedAt: plan.implementedAt ?? null,
                            implementationThreadId:
                              plan.implementationThreadId ?? null,
                          })
                        }
                      >
                        <SearchIcon className="size-3.5" strokeWidth={1.5} />
                        Open
                      </Button>
                      <Button
                        size="xs"
                        className="flex-1 gap-1.5"
                        onClick={() =>
                          setPlanModalContent({
                            threadId,
                            content: plan.content,
                            sourceProposedPlan: plan.sourceProposedPlan ?? null,
                            implemented: plan.implemented ?? false,
                            implementedAt: plan.implementedAt ?? null,
                            implementationThreadId:
                              plan.implementationThreadId ?? null,
                          })
                        }
                        disabled={plan.implemented}
                      >
                        <PlayIcon className="size-3.5" strokeWidth={1.5} />
                        {plan.implemented ? "Implemented" : "Implement"}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
        )}
      </div>
    </div>
  )
}
