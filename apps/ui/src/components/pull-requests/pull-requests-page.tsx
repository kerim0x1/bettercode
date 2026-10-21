import { ArrowLeftIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PullRequestDetailView } from "@/components/pull-requests/pull-request-detail"
import {
  PullRequestList,
  usePullRequestFolders,
} from "@/components/pull-requests/pull-request-list"
import type { PullRequestsPageTarget } from "@/lib/pull-requests-page"
import { updatedAgo } from "@/lib/pull-requests"
import { usePullRequestsStore } from "@/lib/pull-requests-store"
import { cn } from "@/lib/utils"

const HEADER_BUTTON =
  "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50"

/**
 * Pull Requests as a page in the main area, like Usage: the open pull
 * requests of the user's projects, and one pull request's page when a row
 * (or a chat's pull request chip) opens it. Back returns from a pull
 * request to the list, and from the list to the chat.
 */
export function PullRequestsPage({
  onClose,
  target,
  onTargetChange,
}: {
  onClose: () => void
  target: PullRequestsPageTarget | null
  onTargetChange: (target: PullRequestsPageTarget | null) => void
}) {
  const folders = usePullRequestFolders()
  const loading = usePullRequestsStore((state) => state.loading)
  const loadedAt = usePullRequestsStore((state) => state.loadedAt)
  const load = usePullRequestsStore((state) => state.load)

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 bg-background px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => (target ? onTargetChange(null) : onClose())}
            aria-label={target ? "Back to pull requests" : "Back to chat"}
            title={target ? "Back to pull requests" : "Back to chat"}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-sidebar-accent hover:text-foreground active:scale-[0.96]"
          >
            <ArrowLeftIcon className="size-3.5" strokeWidth={1.5} />
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <GitPullRequestIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              strokeWidth={1.5}
            />
            <h1 className="truncate text-[12px] font-medium">
              {target ? (
                <>
                  <button
                    type="button"
                    className="rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                    onClick={() => onTargetChange(null)}
                  >
                    Pull requests
                  </button>
                  <span className="text-muted-foreground"> / </span>
                  {`#${target.number}`}
                </>
              ) : (
                "Pull requests"
              )}
            </h1>
          </div>
        </div>
        {!target ? (
          <div className="flex items-center gap-2">
            <span
              role="status"
              className="hidden text-[11px] text-muted-foreground sm:inline"
            >
              {loading
                ? "Updating…"
                : loadedAt
                  ? `Updated ${updatedAgo(new Date(loadedAt).toISOString())}`
                  : ""}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load(folders, { refresh: true })}
              disabled={loading}
              className={HEADER_BUTTON}
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  loading && "motion-safe:animate-spin"
                )}
                strokeWidth={1.5}
              />
              Refresh
            </Button>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
        <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-3">
          {target ? (
            <PullRequestDetailView
              key={`${target.cwd}#${target.number}`}
              cwd={target.cwd}
              number={target.number}
            />
          ) : (
            <PullRequestList
              onOpen={(pullRequest) =>
                onTargetChange({
                  cwd: pullRequest.cwd,
                  number: pullRequest.number,
                })
              }
            />
          )}
        </div>
      </div>
    </main>
  )
}
