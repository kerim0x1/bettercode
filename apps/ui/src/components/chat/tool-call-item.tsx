import { useEffect, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  Loader2Icon,
  MaximizeIcon,
  XIcon,
  XCircleIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format-duration"
import { toolActionIcon } from "@/lib/tool-step-icon"
import { getLanguage } from "@/lib/editor-store"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  describeProviderToolActivity,
  extractToolOutputText,
} from "@betterc0de/schema/tool-activity"
import { formatProviderActivityLabel } from "@/lib/provider-label"
import { openSourceTarget } from "@/lib/source-opener"
import { toolFailureText } from "@/lib/execution-diagnostics"
import { ExecutionFailure } from "./execution-failure"

export type ToolCallData = {
  id: string
  name: string
  /** Latest provider title; ACP providers change it per event. */
  title?: string
  /** The provider's own classification of the call (ACP `kind`). */
  kind?: string
  input: unknown
  output?: unknown
  state?: string
  providerKind?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  error?: string
  outputPreview?: string
  outputTruncated?: boolean
  outputBytes?: number
  outputLineCount?: number
  turnId?: string
  providerInstanceId?: string
  sessionId?: string
  taskId?: string
  parentTaskId?: string
  agentId?: string
  parentAgentId?: string
  parentToolId?: string
}

/**
 * Renders a single tool call as a slim timeline row inside a
 * {@link ToolCallGroup} dropdown.
 *
 * The row shows the tool icon, a compact summary of the most relevant input
 * (file name / shell command / search pattern) and the completion state.
 * Clicking the row toggles an inline 200px-tall code preview; the maximize
 * button opens the full content in a fullscreen overlay for when the tool
 * wrote/returned a long file.
 *
 * Edit / Patch tools render a semantic destructive/success diff; Write /
 * Read / Bash render the relevant raw
 * content. A streaming tool shows a pulsing caret and a spinner until its
 * output arrives. The per-row provider badge is off by default — the group
 * header carries the provider label unless a turn mixes providers.
 */
export function ToolCallItem({
  tc,
  defaultOpen = false,
  streaming = false,
  showGenericOutput = false,
  shellToolPartsExpanded = false,
  editToolPartsExpanded = false,
  showProviderBadge = false,
  workspaceRoot,
}: {
  tc: ToolCallData
  defaultOpen?: boolean
  streaming?: boolean
  showGenericOutput?: boolean
  shellToolPartsExpanded?: boolean
  editToolPartsExpanded?: boolean
  showProviderBadge?: boolean
  workspaceRoot?: string | null
}) {
  const normalizedToolName = tc.name.toLowerCase()
  const defaultExpanded = shouldExpandToolCallByDefault({
    toolName: normalizedToolName,
    defaultOpen,
    shellToolPartsExpanded,
    editToolPartsExpanded,
  })
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [fullscreen, setFullscreen] = useState(false)
  const inp = tc.input as Record<string, unknown> | null
  const description = describeProviderToolActivity({
    toolName: tc.name,
    title: tc.title,
    kind: tc.kind,
    input: tc.input,
    output: tc.output,
    fallbackSummary: tc.name,
  })
  const action = description.action
  // Only a file gets an editor link. A search scope or a listed directory is
  // context for the row, not something the editor can open.
  const filePath =
    (action === "read" || action === "file_change") && description.path
      ? description.path.replace(/\\/g, "/")
      : ""
  const directoryPath =
    action === "list" && description.path
      ? description.path.replace(/\\/g, "/")
      : ""
  const command = description.command ?? ""
  const pattern = description.pattern ?? ""
  const scope = description.scope ? displayScope(description.scope) : ""
  const fileName = lastPathSegment(filePath || directoryPath)
  const displayName = description.summary
  const displayDetail = description.detail ?? ""
  const Icon = toolActionIcon(action, tc.name)
  const isError = tc.state === "output-error" || !!tc.error
  const isDone = !!tc.output || tc.state === "output-available" || isError
  const toolName = normalizedToolName
  const providerLabel = formatProviderActivityLabel(tc, "Tool")
  const durationLabel =
    typeof tc.durationMs === "number"
      ? formatDuration(tc.durationMs)
      : tc.startedAt && !tc.completedAt && streaming
        ? "running"
        : ""

  // Determine what code to show. The classified action decides; the name
  // heuristics only cover tools the classifier files under "other".
  const hasEditInput =
    typeof inp?.old_string === "string" || typeof inp?.new_string === "string"
  const isEdit =
    action === "file_change"
      ? hasEditInput
      : action === "other" &&
        (toolName.includes("edit") || toolName.includes("patch"))
  const isWrite =
    action === "file_change"
      ? !hasEditInput
      : action === "other" && toolName.includes("write")
  const isRead =
    action === "read" ||
    action === "list" ||
    (action === "other" &&
      (toolName.includes("read") || toolName.includes("cat")))
  const isBash =
    action === "command" || (action === "other" && isShellToolName(toolName))
  const isSearch = action === "search"
  const isGenericTool = !isWrite && !isEdit && !isRead && !isBash && !isSearch
  const canShowPreview = !isGenericTool || showGenericOutput || isError
  const hasCodePreview =
    canShowPreview &&
    !!(inp || tc.output !== undefined || tc.outputPreview || tc.error)

  useEffect(() => {
    setExpanded(defaultExpanded)
  }, [defaultExpanded])

  const outputText =
    typeof tc.outputPreview === "string"
      ? tc.outputPreview
      : (extractToolOutputText(tc.output) ?? stringifyPreview(tc.output))
  const codeContent = isWrite
    ? String(inp?.content || inp?.contents || "")
    : isEdit
      ? String(inp?.new_string || "")
      : isRead || isSearch
        ? outputText
        : isBash
          ? outputText || command
          : outputText || stringifyPreview(inp)

  const oldContent = isEdit ? String(inp?.old_string || "") : ""
  const failureText = toolFailureText(tc.error)
  const failureDetail =
    failureText && !/^tool failed\.?$/i.test(failureText)
      ? failureText
      : toolFailureText(tc.output) || outputText
  const failureSummary =
    failureDetail?.split(/\r?\n/, 1)[0]?.slice(0, 240) ||
    "The tool reported a failure without an error message. Expand the step to inspect its input and output."
  const lang = filePath ? getLanguage(filePath) : isBash ? "shell" : "plaintext"

  return (
    <>
      <div className="overflow-hidden">
        {/* Header row */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => hasCodePreview && setExpanded(!expanded)}
            title={[providerLabel, filePath || displayDetail || pattern]
              .filter(Boolean)
              .join(" · ")}
            aria-expanded={hasCodePreview ? expanded : undefined}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors duration-150",
              hasCodePreview
                ? "cursor-pointer hover:bg-muted/40"
                : "cursor-default"
            )}
          >
            <Icon
              className={cn(
                "size-3.5 shrink-0",
                isError ? "text-destructive/70" : "text-muted-foreground/70"
              )}
            />
            {showProviderBadge && (
              <span
                title={providerLabel}
                className="max-w-[120px] shrink-0 truncate rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground"
              >
                {providerLabel}
              </span>
            )}
            <span
              className={cn(
                "shrink-0 font-medium",
                isError ? "text-destructive" : "text-foreground/85"
              )}
            >
              {displayName}
            </span>
            {fileName && (
              <span className="min-w-0 truncate rounded bg-muted/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                {fileName}
              </span>
            )}
            {!fileName && displayDetail && (
              <code className="min-w-0 truncate rounded bg-muted/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                {displayDetail}
              </code>
            )}
            {!fileName && !displayDetail && pattern && (
              <code className="min-w-0 truncate rounded bg-muted/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                {pattern}
              </code>
            )}
            {isSearch && scope && (
              <span
                className="min-w-0 shrink truncate text-[10px] text-muted-foreground/60"
                title={description.scope}
              >
                in {scope}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
              {durationLabel && (
                <span className="hidden text-[10px] text-muted-foreground/50 tabular-nums sm:inline">
                  {durationLabel}
                </span>
              )}
              {streaming && !isDone && (
                <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
              )}
              {isError ? (
                <XCircleIcon className="size-3 text-destructive" />
              ) : isDone ? (
                <CheckIcon className="size-3 text-success/80" />
              ) : null}
              {hasCodePreview && (
                <ChevronDownIcon
                  className={cn(
                    "size-3 text-muted-foreground/40 transition-transform duration-200",
                    expanded && "rotate-180"
                  )}
                />
              )}
            </div>
          </button>
          {filePath && (
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none"
              onClick={() => {
                void openSourceTarget(
                  { kind: "file", filePath },
                  { workspacePath: workspaceRoot }
                )
              }}
              title={`Open ${filePath}`}
              aria-label={`Open ${filePath} in editor`}
            >
              <ExternalLinkIcon className="size-3" />
            </button>
          )}
        </div>

        {isError && (
          <ExecutionFailure
            title="Tool failed"
            message={failureSummary}
            details={
              failureDetail && failureDetail !== failureSummary
                ? failureDetail
                : undefined
            }
            context={[providerLabel, command || filePath || displayDetail]
              .filter(Boolean)
              .join("\n")}
          />
        )}

        {/* Inline code preview */}
        {expanded && codeContent && (
          <div className="relative mt-0.5 mb-1 ml-[22px] animate-in overflow-hidden rounded-md border border-border/30 bg-muted/15 duration-200 fade-in slide-in-from-top-1">
            {/* Expand button */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setFullscreen(true)
              }}
              className="absolute top-1.5 right-1.5 z-10 rounded-md bg-muted/80 p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <MaximizeIcon className="size-3" />
            </button>

            {/* Edit diff view */}
            {isEdit && oldContent && (
              <div className="max-h-[200px] overflow-y-auto">
                <pre className="px-3 py-2 font-mono text-[10px] leading-relaxed">
                  {oldContent.split("\n").map((line, i) => (
                    <div
                      key={`old-${i}`}
                      className="text-destructive/70 line-through"
                    >{`- ${line}`}</div>
                  ))}
                  {codeContent.split("\n").map((line, i) => (
                    <div
                      key={`new-${i}`}
                      className="text-success/80"
                    >{`+ ${line}`}</div>
                  ))}
                </pre>
              </div>
            )}

            {/* Write / Read / Bash content */}
            {(!isEdit || !oldContent) && (
              <div className="max-h-[200px] overflow-y-auto">
                <pre className="px-3 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-foreground/80">
                  {codeContent.slice(0, 5000)}
                  {tc.outputTruncated && (
                    <span className="mt-2 block text-muted-foreground">
                      Output truncated in chat preview.
                    </span>
                  )}
                  {streaming && !isDone && (
                    <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary" />
                  )}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Fullscreen Modal */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-[100] flex flex-col bg-background/95 backdrop-blur-sm"
          onClick={() => setFullscreen(false)}
        >
          <div
            className="flex shrink-0 items-center gap-3 border-b border-border/40 px-5 py-3"
            onClick={(e) => e.stopPropagation()}
          >
            <Icon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">{displayName}</span>
            {filePath && (
              <code className="font-mono text-xs text-muted-foreground">
                {filePath}
              </code>
            )}
            {lang !== "plaintext" && (
              <Badge variant="outline" className="text-[9px]">
                {lang}
              </Badge>
            )}
            <div className="flex-1" />
            {streaming && !isDone && (
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <Loader2Icon className="size-2.5 animate-spin" />
                Streaming
              </Badge>
            )}
            {isError ? (
              <Badge
                variant="outline"
                className="gap-1 border-destructive/30 text-[10px] text-destructive"
              >
                <XCircleIcon className="size-2.5" />
                Failed
              </Badge>
            ) : (
              isDone && (
                <Badge
                  variant="outline"
                  className="gap-1 border-success/30 text-[10px] text-success"
                >
                  <CheckIcon className="size-2.5" />
                  Done
                </Badge>
              )
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setFullscreen(false)}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto p-4"
            onClick={(e) => e.stopPropagation()}
          >
            {isEdit && oldContent ? (
              <pre className="font-mono text-xs leading-relaxed">
                {oldContent.split("\n").map((line, i) => (
                  <div
                    key={`old-${i}`}
                    className="bg-destructive/5 px-2 text-destructive/70"
                  >{`- ${line}`}</div>
                ))}
                <div className="h-2" />
                {codeContent.split("\n").map((line, i) => (
                  <div
                    key={`new-${i}`}
                    className="bg-success/5 px-2 text-success/80"
                  >{`+ ${line}`}</div>
                ))}
              </pre>
            ) : (
              <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {codeContent}
                {tc.outputTruncated && (
                  <span className="mt-3 block text-muted-foreground">
                    Output truncated in chat preview.
                  </span>
                )}
                {streaming && !isDone && (
                  <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-primary" />
                )}
              </pre>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export function shouldExpandToolCallByDefault({
  toolName,
  defaultOpen = false,
  shellToolPartsExpanded = false,
  editToolPartsExpanded = false,
}: {
  toolName: string
  defaultOpen?: boolean
  shellToolPartsExpanded?: boolean
  editToolPartsExpanded?: boolean
}): boolean {
  const normalized = toolName.toLowerCase()
  if (defaultOpen) return true
  if (shellToolPartsExpanded && isShellToolName(normalized)) return true
  if (editToolPartsExpanded && isEditToolName(normalized)) return true
  return false
}

function isShellToolName(toolName: string): boolean {
  return (
    toolName.includes("bash") ||
    toolName.includes("shell") ||
    toolName.includes("exec") ||
    toolName.includes("command")
  )
}

function isEditToolName(toolName: string): boolean {
  return (
    toolName.includes("edit") ||
    toolName.includes("write") ||
    toolName.includes("patch")
  )
}

function lastPathSegment(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
  return normalized.split("/").pop() || normalized
}

/**
 * A search scope as the row shows it: a glob stays whole because its last
 * segment ("*.ts") says nothing about where the search ran; a directory or
 * file collapses to its name, the full path stays in the tooltip.
 */
function displayScope(scope: string): string {
  return /[*?{[]/.test(scope) ? scope : lastPathSegment(scope)
}

function stringifyPreview(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export { formatDuration } from "@/lib/format-duration"
