import { copyText } from "@/lib/clipboard"
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardCheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  ListChecksIcon,
  Loader2Icon,
  PlayIcon,
  SaveIcon,
  SearchIcon,
} from "lucide-react"
import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { unwrapPlanContent } from "@/lib/plan-content"
import {
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "@/lib/proposed-plan"
import { cn } from "@/lib/utils"
import { MessageResponse } from "@/components/ai-elements/message"
import { AgentActivityOrb } from "@/components/ai-elements/agent-activity"
import { useChatStore } from "@/lib/chat-store"
import type {
  SetPlanModalContent,
  SourceProposedPlanReference,
} from "@/lib/plan-modal"

function cleanMarkdownLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
}

function extractPlanSummary(content: string): {
  title: string
  taskCount: number
} {
  const planContent = unwrapPlanContent(content).trim()
  const lines = planContent.split(/\r?\n/)
  const cleanedLines = lines.map(cleanMarkdownLine).filter(Boolean)
  const title =
    (proposedPlanTitle(planContent) ??
      cleanedLines.find((line) => !/^summary$/i.test(line))) ||
    "Implementation Plan"
  const taskLikeLines = cleanedLines.filter((line) =>
    /^(task\s+\d+|phase\s+\d+|\d+\.|step\s+\d+)/i.test(line)
  )
  const checkboxCount = lines.filter((line) =>
    /^\s*[-*]\s*\[[ xX]\]\s+/.test(line)
  ).length
  const numberedCount = lines.filter((line) =>
    /^\s*(?:#{2,6}\s+)?\d+[.)]\s+\S/.test(line)
  ).length
  const taskCount = Math.max(checkboxCount, numberedCount, taskLikeLines.length)

  return { title, taskCount }
}

function planProgress(content: string): number {
  const planContent = unwrapPlanContent(content)
  if (!planContent.trim()) return 8
  const lineCount = planContent.split(/\r?\n/).filter(Boolean).length
  return Math.min(94, 16 + lineCount * 5 + Math.floor(planContent.length / 120))
}

function PlanProgressMeter({ value }: { value: number }) {
  return (
    <div className="flex min-w-[8rem] items-center gap-2 text-[11px] text-muted-foreground">
      <Progress value={value} className="h-1 flex-1 bg-muted" />
      <span className="w-7 text-right tabular-nums">{value}%</span>
    </div>
  )
}

function PlanStreamingSkeleton() {
  return (
    <div className="space-y-2 py-1" aria-hidden="true">
      <div className="h-3 w-2/3 rounded bg-muted-foreground/15" />
      <div className="h-3 w-full rounded bg-muted-foreground/10" />
      <div className="h-3 w-5/6 rounded bg-muted-foreground/10" />
      <div className="h-3 w-3/5 rounded bg-muted-foreground/10" />
    </div>
  )
}

/**
 * Card attached to an assistant message whose content is a structured
 * plan (detected via `isStructuredPlanMarkdown`).
 */
export function PlanImplementationCard({
  content,
  onOpenPlanModal,
  sourceProposedPlan,
  implemented = false,
  implementedAt,
  implementationThreadId,
  streaming = false,
  workspaceRoot,
}: {
  content: string
  onOpenPlanModal: SetPlanModalContent
  sourceProposedPlan?: SourceProposedPlanReference | null
  implemented?: boolean
  implementedAt?: string | null
  implementationThreadId?: string | null
  streaming?: boolean
  workspaceRoot?: string | null
}) {
  const savePathInputId = useId()
  const [copied, setCopied] = useState(false)
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false)
  const [savePath, setSavePath] = useState("")
  const [isSaving, setIsSaving] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const modalContent = content
  const summary = extractPlanSummary(content)
  const planContent = unwrapPlanContent(content)
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planContent)
  const hasPreview = displayedPlanMarkdown.trim().length > 0
  // Collapsed to the header by default — the body only renders while the plan
  // is still streaming in (you're watching it) or once you expand it.
  const showBody = streaming || expanded
  const progress = planProgress(content)
  const exportContents = normalizePlanMarkdownForExport(planContent)
  const downloadFilename = buildProposedPlanMarkdownFilename(planContent)
  const openPlan = () =>
    onOpenPlanModal({
      content: modalContent,
      sourceProposedPlan: sourceProposedPlan ?? null,
      implemented,
      implementedAt: implementedAt ?? null,
      implementationThreadId: implementationThreadId ?? null,
    })
  const openImplementationThread = () => {
    if (!implementationThreadId) return
    useChatStore.getState().setActiveThread(implementationThreadId)
  }
  const copyPlan = async () => {
    try {
      if (!(await copyText(exportContents))) {
        setActionMessage("Could not copy")
        return
      }
      setCopied(true)
      setActionMessage("Copied")
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setActionMessage("Clipboard unavailable")
    }
  }
  const downloadPlan = () => {
    downloadPlanAsTextFile(downloadFilename, exportContents)
    setActionMessage("Downloaded markdown")
  }
  const openSaveDialog = () => {
    if (!workspaceRoot) return
    setSavePath((current) => current || downloadFilename)
    setIsSaveDialogOpen(true)
  }
  const saveToWorkspace = async () => {
    const relativePath = savePath.trim()
    if (!workspaceRoot || !relativePath) return
    setIsSaving(true)
    try {
      const { writeFile } = await import("@/services/backend")
      await writeFile(workspaceRoot, relativePath, exportContents)
      setIsSaveDialogOpen(false)
      setActionMessage(`Saved ${relativePath}`)
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : "Could not save plan"
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      <div
        className={cn(
          // Full transcript width (the column itself is capped by
          // --chat-max-width) — same as PlanApprovalCard, which never had a cap.
          "mt-3 overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-[0_16px_40px_-28px_rgba(0,0,0,0.65)]",
          // Streaming state stays within the two-tone theme (no blue/sky) —
          // just a slightly stronger border + faint fill.
          streaming && "border-border/80 bg-foreground/[0.03]"
        )}
      >
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 px-3.5 py-3",
            showBody && "border-b border-border/45"
          )}
        >
          <button
            type="button"
            onClick={openPlan}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              {/* The plan badge stays the anchor; only active planning animates. */}
              {streaming ? <AgentActivityOrb state="solving" /> : null}
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-muted-foreground uppercase">
                    Plan
                  </span>
                  <span className="truncate text-sm font-semibold text-foreground">
                    {summary.title}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {streaming ? (
                    <span className="agent-activity-text">Planning</span>
                  ) : implemented ? (
                    <span>Implemented</span>
                  ) : (
                    <>
                      <ListChecksIcon className="size-3.5" />
                      <span>
                        {summary.taskCount > 0
                          ? `${summary.taskCount} tasks`
                          : "Ready"}
                      </span>
                    </>
                  )}
                  {actionMessage ? (
                    <span className="truncate text-muted-foreground/70">
                      · {actionMessage}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          </button>
          {streaming ? (
            <div className="order-3 w-full sm:order-none sm:w-36">
              <PlanProgressMeter value={progress} />
            </div>
          ) : null}
          <div className="flex shrink-0 items-center gap-1.5">
            {!streaming && hasPreview ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={expanded ? "Collapse plan" : "Expand plan"}
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? (
                  <ChevronUpIcon className="size-4" />
                ) : (
                  <ChevronDownIcon className="size-4" />
                )}
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Plan actions"
                  disabled={streaming}
                >
                  <EllipsisIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                <DropdownMenuItem onClick={() => void copyPlan()}>
                  {copied ? (
                    <ClipboardCheckIcon className="size-4" />
                  ) : (
                    <CopyIcon className="size-4" />
                  )}
                  {copied ? "Copied" : "Copy plan"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={downloadPlan}>
                  <DownloadIcon className="size-4" />
                  Download markdown
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={openSaveDialog}
                  disabled={!workspaceRoot || isSaving}
                >
                  <SaveIcon className="size-4" />
                  Save to workspace
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5"
              onClick={openPlan}
            >
              <SearchIcon className="size-3.5" />
              Review
            </Button>
            {implemented && implementationThreadId ? (
              <Button
                size="sm"
                className="h-8 gap-1.5 px-2.5"
                onClick={openImplementationThread}
                disabled={streaming}
              >
                <ArrowRightIcon className="size-3.5" />
                Open thread
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8 gap-1.5 px-2.5"
                onClick={openPlan}
                disabled={streaming || implemented}
              >
                <PlayIcon className="size-3.5" />
                {implemented ? "Implemented" : "Implement"}
              </Button>
            )}
          </div>
        </div>

        {showBody ? (
          <div className="px-3.5 py-3">
            <button
              type="button"
              onClick={openPlan}
              className="block w-full text-left transition-opacity hover:opacity-90"
            >
              <div className="plan-preview-prose text-xs leading-relaxed text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                {hasPreview ? (
                  <MessageResponse>{displayedPlanMarkdown}</MessageResponse>
                ) : streaming ? (
                  <PlanStreamingSkeleton />
                ) : null}
              </div>
            </button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSaving) setIsSaveDialogOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to{" "}
              <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <label htmlFor={savePathInputId} className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">
              Workspace path
            </span>
            <Input
              id={savePathInputId}
              value={savePath}
              onChange={(event) => setSavePath(event.target.value)}
              placeholder={downloadFilename}
              spellCheck={false}
              disabled={isSaving}
            />
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveToWorkspace()}
              disabled={isSaving || !savePath.trim()}
            >
              {isSaving ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : null}
              {isSaving ? "Saving" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
