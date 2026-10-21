import { GitCommitVerticalIcon } from "lucide-react"
import type { GitLogEntry } from "./git-panel-utils"

/** The "log" tab: the latest commits of the checked-out branch. */
export function HistorySection({ logEntries }: { logEntries: GitLogEntry[] }) {
  return (
    <div className="space-y-0">
      {logEntries.length === 0 && (
        <p className="px-3 py-3 text-center text-[10px] text-muted-foreground/50">
          No commits
        </p>
      )}
      {logEntries.map((entry) => (
        <div
          key={entry.hash}
          className="git-log-entry flex items-start gap-2 border-b border-border/20 px-3 py-1.5 transition-colors hover:bg-accent/50"
        >
          <GitCommitVerticalIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground/40" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] leading-snug">{entry.message}</p>
            <div className="mt-0.5 flex items-center gap-2 text-[9.5px] text-muted-foreground/60">
              <span className="rounded bg-muted/60 px-1 py-px font-mono tabular-nums">
                {entry.hash?.slice(0, 7)}
              </span>
              <span className="truncate">{entry.author}</span>
              <span className="shrink-0">
                {entry.date ? new Date(entry.date).toLocaleDateString() : ""}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
