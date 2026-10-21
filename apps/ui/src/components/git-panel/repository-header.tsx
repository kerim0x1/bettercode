import type { GitStatus } from "@betterc0de/schema"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ChevronDownIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react"
import type { GitPanelTab } from "./git-panel-utils"

const GIT_PANEL_TABS = ["changes", "log", "branches"] as const

/** Branch name, clean/changed state and the +/− totals of the working tree. */
export function RepositorySummary({
  isAgent,
  status,
  totalChanges,
  totalAdditions,
  totalDeletions,
  onRefresh,
}: {
  isAgent: boolean
  status: GitStatus
  totalChanges: number
  totalAdditions: number
  totalDeletions: number
  onRefresh: () => void
}) {
  return (
    <div
      className={cn(
        "git-repository-summary flex items-center gap-2 px-3 py-1.5 text-[10.5px] text-muted-foreground",
        !isAgent && "border-t border-border/60"
      )}
    >
      <GitBranchIcon className="size-3 shrink-0" strokeWidth={1.75} />
      <span className="truncate font-medium text-foreground">
        {status.branch || "main"}
      </span>
      {status.is_clean ? (
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          clean
        </span>
      ) : (
        <span className="flex items-center gap-2 tabular-nums">
          <span>
            {totalChanges} change{totalChanges !== 1 ? "s" : ""}
          </span>
          {totalAdditions > 0 && (
            <span className="text-success">+{totalAdditions}</span>
          )}
          {totalDeletions > 0 && (
            <span className="text-destructive">−{totalDeletions}</span>
          )}
        </span>
      )}
      {!isAgent && (
        <button
          type="button"
          onClick={() => onRefresh()}
          className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-accent-foreground"
          title="Refresh"
          aria-label="Refresh git status"
        >
          <RefreshCwIcon className="size-3" />
        </button>
      )}
    </div>
  )
}

/** Changes / Log / Branches switcher (with a refresh button in agent mode). */
export function GitViewTabs({
  isAgent,
  activeTab,
  totalChanges,
  onTabChange,
  onRefresh,
}: {
  isAgent: boolean
  activeTab: GitPanelTab
  totalChanges: number
  onTabChange: (tab: GitPanelTab) => void
  onRefresh: () => void
}) {
  return (
    <div className={isAgent ? "diff-toolbar" : undefined}>
      <div
        className={
          isAgent
            ? "diff-tabs"
            : "mx-3 mb-2 flex rounded-lg bg-muted/30 p-0.5 text-[11px]"
        }
        role="group"
        aria-label="Git view"
      >
        {GIT_PANEL_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            aria-pressed={activeTab === tab}
            onClick={() => onTabChange(tab)}
            className={
              isAgent
                ? "capitalize"
                : cn(
                    "flex-1 rounded-md px-2 py-1 font-medium capitalize transition-colors",
                    activeTab === tab
                      ? "bg-muted text-foreground shadow-sm ring-1 ring-border/50 ring-inset"
                      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  )
            }
          >
            {tab}
            {isAgent && tab === "changes" && <span>{totalChanges}</span>}
          </button>
        ))}
      </div>
      {isAgent && (
        <button
          type="button"
          className="diff-toolbar-button ml-auto"
          aria-label="Refresh git status"
          title="Refresh git status"
          onClick={() => onRefresh()}
        >
          <RefreshCwIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** The editor sidebar's header: branch switcher button, refresh and totals. */
export function EditorGitHeader({
  status,
  totalChanges,
  totalAdditions,
  totalDeletions,
  onManageBranches,
  onRefresh,
}: {
  status: GitStatus
  totalChanges: number
  totalAdditions: number
  totalDeletions: number
  onManageBranches: () => void
  onRefresh: () => void
}) {
  return (
    <div className="px-3 pb-2">
      <div className="flex h-8 items-center gap-2">
        <button
          type="button"
          onClick={() => onManageBranches()}
          title="Manage branches"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-xs font-medium hover:text-foreground"
        >
          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{status.branch || "No branch"}</span>
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh git status"
          onClick={() => onRefresh()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
        <span>
          {status.is_clean
            ? "Working tree clean"
            : `${totalChanges} changed files`}
        </span>
        {totalAdditions > 0 && (
          <span className="text-success">
            +{totalAdditions.toLocaleString()}
          </span>
        )}
        {totalDeletions > 0 && (
          <span className="text-destructive">
            −{totalDeletions.toLocaleString()}
          </span>
        )}
      </div>
    </div>
  )
}
