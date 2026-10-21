import { copyText } from "@/lib/clipboard"
import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import {
  ChevronDownIcon,
  CopyIcon,
  CheckIcon,
  XIcon,
  Undo2Icon,
  ExternalLinkIcon,
} from "lucide-react"
import { getFileIconUrl } from "@/lib/file-icons"
import { useChatStore, getThreadStream } from "@/lib/chat-store"
import { useCheckpointStore } from "@/lib/checkpoint-store"
import { createLogger } from "@/lib/logger"
import { openSourceTarget } from "@/lib/source-opener"
import { resolveSourceTarget } from "@/lib/source-target"
import { workspaceRelativeEditorPath } from "@/lib/editor-path"

const log = createLogger("file-changes-bar") // M11

export interface FileDiff {
  path: string
  additions: number
  deletions: number
  oldText: string
  newText: string
  isNew: boolean
}

type FileChangeStatus = "pending" | "accepted" | "rejected"

// Resolved rows show their Accepted/Rejected badge for BADGE_MS, then
// collapse over EXIT_MS (must match the duration-300 on the row wrapper)
// before being dropped from the list entirely.
const BADGE_MS = 550
const EXIT_MS = 300

/** Unified file changes component with per-file accept/reject */
export function FileChangesBar({ threadId }: { threadId: string | null }) {
  const streamingDiffs = useChatStore(
    (s) => getThreadStream(s, threadId).streamingDiffs
  )
  const activeTurnId = useChatStore(
    (s) => getThreadStream(s, threadId).activeTurnId
  )
  const thread = useChatStore((s) => s.threads.find((t) => t.id === threadId))
  const lastMsg = thread?.messages?.findLast((m) => m.role === "assistant")
  const savedDiffs = lastMsg?.diffs || []
  const diffs = streamingDiffs.length > 0 ? streamingDiffs : savedDiffs
  const turnId = streamingDiffs.length > 0 ? activeTurnId : lastMsg?.turnId
  const messageId =
    streamingDiffs.length === 0 || (turnId && lastMsg?.turnId === turnId)
      ? lastMsg?.id
      : undefined

  if (!threadId || !thread || diffs.length === 0) return null

  // Keep review state when a live turn becomes a saved message. A different
  // thread/turn gets a new instance, including fresh timers and verdicts.
  const sourceKey = JSON.stringify([threadId, turnId ?? messageId ?? "stream"])
  return (
    <ThreadFileChanges
      key={sourceKey}
      threadId={threadId}
      turnId={turnId}
      messageId={messageId}
      workspacePath={thread?.worktreePath || thread?.projectPath || ""}
      diffs={diffs}
    />
  )
}

function ThreadFileChanges({
  threadId,
  turnId,
  messageId,
  workspacePath,
  diffs,
}: {
  threadId: string
  turnId: string | null | undefined
  messageId: string | undefined
  workspacePath: string
  diffs: FileDiff[]
}) {
  const [resolved, setResolved] = useState<
    Record<string, "accepted" | "rejected">
  >({})
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [gone, setGone] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingReverts = useRef(new Set<string>())
  const timersRef = useRef<number[]>([])
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      timersRef.current.forEach(clearTimeout)
      timersRef.current = []
    }
  }, [])

  const fileMap = new Map<string, FileDiff>()
  for (const d of diffs) {
    const existing = fileMap.get(d.path)
    if (existing) {
      existing.additions += d.additions
      existing.deletions += d.deletions
      existing.oldText +=
        (existing.oldText && d.oldText ? "\n" : "") + d.oldText
      existing.newText +=
        (existing.newText && d.newText ? "\n" : "") + d.newText
    } else {
      fileMap.set(d.path, { ...d })
    }
  }
  const files = [...fileMap.values()]
  const visibleFiles = files.filter((f) => !gone.has(f.path))
  const pendingFiles = files.filter((f) => !resolved[f.path])
  const totalAdd = visibleFiles.reduce((s, f) => s + f.additions, 0)
  const totalDel = visibleFiles.reduce((s, f) => s + f.deletions, 0)
  const allResolved = files.length > 0 && files.every((f) => gone.has(f.path))

  const handleDismiss = () => {
    // Dismissing UI must not erase provider diffs needed for finalization/replay.
    setDismissed(true)
  }

  if (dismissed || allResolved) return null

  const resolve = (path: string, verdict: "accepted" | "rejected") => {
    if (resolved[path]) return
    setResolved((prev) => ({ ...prev, [path]: verdict }))
    timersRef.current.push(
      window.setTimeout(() => {
        setLeaving((prev) => new Set(prev).add(path))
      }, BADGE_MS)
    )
    timersRef.current.push(
      window.setTimeout(() => {
        setGone((prev) => new Set(prev).add(path))
      }, BADGE_MS + EXIT_MS)
    )
  }

  const handleAcceptFile = (path: string) => {
    if (pendingReverts.current.has(path)) return
    resolve(path, "accepted")
  }

  const handleRejectFile = async (path: string) => {
    if (resolved[path] || pendingReverts.current.has(path)) return
    pendingReverts.current.add(path)
    setError(null)
    try {
      const target = resolveSourceTarget(
        { kind: "file", filePath: path },
        { workspacePath }
      )
      if (!target || target.kind !== "file")
        throw new Error("File is outside this chat's workspace.")
      const checkpoints = useCheckpointStore.getState().checkpoints
      const checkpoint = checkpoints.findLast(
        (cp) =>
          cp.threadId === threadId &&
          (!cp.projectPath ||
            workspaceRelativeEditorPath(workspacePath, cp.projectPath) ===
              "") &&
          ((turnId && cp.turnId === turnId) ||
            (messageId && cp.messageId === messageId))
      )
      const snapshot = Object.entries(checkpoint?.files ?? {}).find(
        ([filePath]) => {
          const saved = resolveSourceTarget(
            { kind: "file", filePath },
            { workspacePath }
          )
          return (
            saved?.kind === "file" &&
            workspaceRelativeEditorPath(target.filePath, saved.filePath) === ""
          )
        }
      )
      if (!snapshot)
        throw new Error(
          "No file snapshot is available for this chat turn. Use its restore checkpoint action."
        )
      const relativePath = workspaceRelativeEditorPath(
        workspacePath,
        target.filePath
      )
      if (!relativePath)
        throw new Error("Cannot resolve this file inside the chat's workspace.")
      const { writeFile } = await import("@/services/backend")
      await writeFile(workspacePath, relativePath, snapshot[1])
      if (mountedRef.current) resolve(path, "rejected")
    } catch (e) {
      log.warn("Failed to revert file change:", path, e)
      if (mountedRef.current)
        setError(
          `Could not revert ${path}: ${e instanceof Error ? e.message : String(e)}`
        )
    } finally {
      pendingReverts.current.delete(path)
    }
  }

  const handleAcceptAll = () => {
    pendingFiles.forEach((f) => handleAcceptFile(f.path))
  }

  const handleRejectAll = () => {
    pendingFiles.forEach((f) => handleRejectFile(f.path))
  }

  const handleReview = (path: string) => {
    void openSourceTarget(
      { kind: "file", filePath: path },
      { workspacePath }
    ).then((opened) => {
      if (!opened) log.warn("Failed to open file for review:", path)
    })
  }

  const allLeaving = files.every((f) => leaving.has(f.path) || gone.has(f.path))

  return (
    <div
      data-review-thread={threadId}
      className={cn(
        "mx-4 mb-2 overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-opacity duration-300",
        allLeaving && "opacity-0"
      )}
    >
      {/* Header — title + aggregate stats + bulk actions, all theme-token
          styled so it sits next to the chat composer instead of fighting
          it with colored chrome. Only the +/- numbers carry color (the
          universal diff convention). */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <span className="text-[12px] font-semibold text-foreground">
          Review File Changes
        </span>
        <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground tabular-nums">
          {visibleFiles.length}
        </span>
        <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
          {totalAdd > 0 && (
            <span className="text-emerald-500">+{totalAdd}</span>
          )}
          {totalDel > 0 && <span className="text-rose-500">−{totalDel}</span>}
        </span>
        <div className="flex-1" />
        {/* Bulk actions — neutral pills; only visible while something is
            still pending so the header quiets down once everything's
            resolved and the card is on its way out. */}
        {pendingFiles.length > 0 && (
          <>
            <button
              type="button"
              onClick={handleAcceptAll}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/50 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <CheckIcon className="size-3.5" strokeWidth={2} />
              Accept all
            </button>
            <button
              type="button"
              onClick={handleRejectAll}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Undo2Icon className="size-3.5" strokeWidth={2} />
              Reject all
            </button>
          </>
        )}
        <button
          type="button"
          onClick={handleDismiss}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title="Dismiss"
          aria-label="Dismiss"
        >
          <XIcon className="size-3.5" strokeWidth={2} />
        </button>
      </div>
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {/* File list — each row lives in a grid wrapper so it can collapse
          to zero height (grid-template-rows 1fr → 0fr) once resolved,
          regardless of whether its diff is expanded. */}
      <div className="max-h-64 overflow-y-auto overscroll-contain">
        {visibleFiles.map((f) => (
          <div
            key={f.path}
            className={cn(
              "grid [grid-template-rows:1fr] transition-all duration-300",
              leaving.has(f.path) && "[grid-template-rows:0fr] opacity-0"
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <FileChangeItem
                diff={f}
                status={resolved[f.path] ?? "pending"}
                onOpen={() => handleReview(f.path)}
                onAccept={() => handleAcceptFile(f.path)}
                onReject={() => handleRejectFile(f.path)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function FileChangeItem({
  diff,
  status = "pending",
  onOpen,
  onAccept,
  onReject,
  workspaceRoot,
}: {
  diff: FileDiff
  status?: FileChangeStatus
  onOpen?: () => void
  onAccept?: () => void
  onReject?: () => void
  workspaceRoot?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const normalizedPath = diff.path.replace(/\\/g, "/")
  const fileName = normalizedPath.split("/").pop() || normalizedPath
  const hasLines = Boolean(diff.oldText || diff.newText)
  // The transcript can contain thousands of files. Parse content only when
  // the user opens or copies this file's diff.
  const readLines = () => [
    ...diff.oldText
      .split("\n")
      .filter(Boolean)
      .map((text) => ({ type: "del" as const, text })),
    ...diff.newText
      .split("\n")
      .filter(Boolean)
      .map((text) => ({ type: "add" as const, text })),
  ]
  const diffLines = open ? readLines() : []

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (
      !(await copyText(
        readLines()
          .map((l) => `${l.type === "del" ? "-" : "+"} ${l.text}`)
          .join("\n")
      ))
    )
      return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const dirPath = normalizedPath.includes("/")
    ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/") + 1)
    : ""
  const handleOpen =
    onOpen ??
    (() => {
      void openSourceTarget(
        { kind: "file", filePath: diff.path },
        { workspacePath: workspaceRoot }
      )
    })

  return (
    <div className="group border-b border-border last:border-b-0">
      {/* File row — resolved rows get a faint verdict tint while their
          badge is shown, then the parent collapses them away. */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 transition-colors",
          status === "pending" && "hover:bg-accent/40",
          status === "accepted" && "bg-emerald-500/[0.05]",
          status === "rejected" && "bg-rose-500/[0.05]"
        )}
      >
        {/* Expand toggle */}
        {hasLines ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="shrink-0 rounded text-muted-foreground transition-colors hover:text-foreground"
            aria-label={open ? "Collapse diff" : "Expand diff"}
            aria-expanded={open}
          >
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                !open && "-rotate-90"
              )}
              strokeWidth={2}
            />
          </button>
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <img
          src={getFileIconUrl(fileName)}
          alt=""
          className="size-4 shrink-0"
          onError={(e) => {
            ;(e.target as HTMLImageElement).style.display = "none"
          }}
        />
        <button
          type="button"
          onClick={() => (hasLines ? setOpen(!open) : handleOpen())}
          title={diff.path}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
        >
          <span className="truncate text-[12px] font-medium text-foreground">
            {fileName}
          </span>
          {dirPath && (
            <span className="truncate text-[10.5px] text-muted-foreground">
              {dirPath}
            </span>
          )}
        </button>

        {/* +/- diff stats — the only colored elements per the user's
            explicit ask. No backgrounds, no rings — just text. */}
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
          {diff.additions > 0 && (
            <span className="text-emerald-500">+{diff.additions}</span>
          )}
          {diff.deletions > 0 && (
            <span className="text-rose-500">−{diff.deletions}</span>
          )}
        </span>

        {/* "new" tag — neutral pill */}
        {diff.isNew && (
          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[9.5px] font-medium tracking-wider text-secondary-foreground uppercase">
            new
          </span>
        )}

        {/* Transient verdict badge — tinted with the same emerald/rose
            the diff numbers already use, shown briefly before the row
            animates out. */}
        {status === "accepted" && (
          <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-medium tracking-wider text-emerald-500 uppercase">
            Accepted
          </span>
        )}
        {status === "rejected" && (
          <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[9.5px] font-medium tracking-wider text-rose-500 uppercase">
            Rejected
          </span>
        )}

        {/* Action buttons — theme-token hovers; accept/reject hint their
            meaning on hover via the diff colors */}
        <div className="flex shrink-0 items-center gap-0.5">
          {status === "pending" && onAccept && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onAccept()
              }}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-emerald-500"
              title="Accept changes"
            >
              <CheckIcon className="size-3.5" strokeWidth={2} />
            </button>
          )}
          {status === "pending" && onReject && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onReject()
              }}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
              title="Reject & revert changes"
            >
              <Undo2Icon className="size-3.5" strokeWidth={2} />
            </button>
          )}
          {hasLines && (
            <button
              type="button"
              onClick={handleCopy}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              title="Copy diff"
            >
              {copied ? (
                <CheckIcon className="size-3.5" strokeWidth={2} />
              ) : (
                <CopyIcon className="size-3.5" strokeWidth={2} />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              handleOpen()
            }}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            title="Open in editor"
          >
            <ExternalLinkIcon className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Expanded diff lines — VS-Code-style: subtle row tint + 2px
          left-edge accent stripe. Numbers stay green/red, body text
          stays foreground tone for readability. */}
      {open && diffLines.length > 0 && (
        <div className="max-h-64 overflow-auto overscroll-contain border-t border-border bg-card/50 font-mono text-[11px] leading-[1.6]">
          {diffLines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "relative flex px-3 py-px",
                line.type === "del"
                  ? "bg-rose-500/[0.06]"
                  : "bg-emerald-500/[0.06]"
              )}
            >
              <span
                className={cn(
                  "pointer-events-none absolute inset-y-0 left-0 w-[2px]",
                  line.type === "del" ? "bg-rose-500/50" : "bg-emerald-500/50"
                )}
              />
              <span
                className={cn(
                  "w-4 shrink-0 pr-1.5 text-right select-none",
                  line.type === "del"
                    ? "text-rose-400/70"
                    : "text-emerald-400/70"
                )}
              >
                {line.type === "del" ? "−" : "+"}
              </span>
              <span className="flex-1 whitespace-pre text-foreground/90">
                {line.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
