import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ArchiveIcon, CheckIcon, Loader2Icon, SparklesIcon } from "lucide-react"

/**
 * Commit message field with Generate / Stash / Commit actions, the
 * generation progress line and the commit error.
 */
export function CommitBox({
  stagedCount,
  totalChanges,
  commitMsg,
  commitError,
  isCommitting,
  isGeneratingCommit,
  wrapActions,
  onCommitMsgChange,
  onCommitErrorChange,
  onCommit,
  onGenerateCommitMessage,
  onStash,
}: {
  stagedCount: number
  totalChanges: number
  commitMsg: string
  commitError: string | null
  isCommitting: boolean
  isGeneratingCommit: boolean
  /** Let the action bar wrap (editor and agent panels are narrow). */
  wrapActions: boolean
  onCommitMsgChange: (message: string) => void
  onCommitErrorChange: (error: string | null) => void
  onCommit: () => void
  onGenerateCommitMessage: () => void
  onStash: () => void
}) {
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-1 text-[10px] text-muted-foreground">
        <span className="text-[11px] font-medium text-foreground">Commit</span>
        <span className="tabular-nums">
          {stagedCount > 0
            ? `${stagedCount} staged`
            : `${totalChanges} changed`}
        </span>
      </div>
      {/* Composer card: textarea + action bar share one surface so the
          whole thing reads as a single form field (chat-composer pattern)
          instead of a box with a loose row of buttons underneath. No
          border — the muted fill alone separates it from the panel. */}
      <div
        className={cn(
          "git-commit-card flex flex-col overflow-hidden rounded-lg bg-muted/40 transition-[box-shadow,background-color] focus-within:bg-muted/60 focus-within:ring-2 focus-within:ring-ring/25",
          commitError && "ring-2 ring-destructive/40"
        )}
      >
        <textarea
          aria-label="Commit message"
          readOnly={isGeneratingCommit || isCommitting}
          aria-busy={isGeneratingCommit}
          value={commitMsg}
          onChange={(e) => {
            onCommitMsgChange(e.target.value)
            if (commitError) onCommitErrorChange(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onCommit()
          }}
          placeholder={"Summary of the changes\n\n- What changed and why"}
          rows={Math.min(12, Math.max(4, commitMsg.split("\n").length + 1))}
          className="max-h-80 min-h-24 w-full resize-y bg-transparent px-3 py-2.5 text-xs leading-relaxed outline-none placeholder:text-muted-foreground/60"
        />
        <div
          className={cn(
            "git-commit-actions flex items-center gap-1 px-1.5 pb-1.5",
            wrapActions && "flex-wrap"
          )}
        >
          <Button
            variant="outline"
            size="xs"
            className="gap-1.5"
            disabled={isGeneratingCommit || isCommitting || totalChanges === 0}
            onClick={onGenerateCommitMessage}
            title="Generate a commit message from the reviewed changes"
          >
            {isGeneratingCommit ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SparklesIcon className="size-3.5" />
            )}
            {isGeneratingCommit ? "Generating…" : "Generate"}
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            className="ml-auto"
            onClick={onStash}
            title="Stash uncommitted changes"
            aria-label="Stash uncommitted changes"
          >
            <ArchiveIcon className="size-3.5" />
          </Button>
          <Button
            size="xs"
            className="gap-1.5 px-3"
            disabled={
              !commitMsg.trim() ||
              isCommitting ||
              isGeneratingCommit ||
              totalChanges === 0
            }
            onClick={onCommit}
            title="Commit (Ctrl+Enter)"
          >
            {isCommitting ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
            Commit
          </Button>
        </div>
      </div>
      {isGeneratingCommit && (
        <p role="status" className="mt-1.5 text-[11px] text-muted-foreground">
          Reading changes and writing a commit summary…
        </p>
      )}
      {commitError && (
        <p
          role="alert"
          className="mt-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
        >
          {commitError}
        </p>
      )}
    </>
  )
}
