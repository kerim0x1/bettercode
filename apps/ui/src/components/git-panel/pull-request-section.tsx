import { lazy, Suspense, useState } from "react"
import {
  ExternalLinkIcon,
  GitCommitVerticalIcon,
  GitPullRequestCreateIcon,
} from "lucide-react"
import type { GitStatus } from "@betterc0de/schema"
import { Button } from "@/components/ui/button"
import { PullRequestStateIcon } from "@/components/pull-requests/pull-request-status"
import { useChatStore } from "@/lib/chat-store"
import { openPullRequestsPage } from "@/lib/pull-requests-page"
import { openSourceReference } from "@/lib/source-opener"
import {
  pullRequestState,
  useThreadPullRequest,
} from "@/lib/thread-pull-request"
import { threadMatchesPanelCwd } from "./git-panel-utils"

// Loaded on first use, like every dialog that opens from a click.
const CreatePullRequestDialog = lazy(() =>
  import("@/components/pull-requests/create-pull-request-dialog").then(
    (module) => ({ default: module.CreatePullRequestDialog })
  )
)

/**
 * The branch's pull request under Remote: a link to it (in the app and on
 * GitHub) when it has one, else "Create PR" and, with uncommitted changes,
 * "Commit, push & PR", which commits with the message above (or a
 * generated one) first.
 */
export function PullRequestSection({
  cwd,
  status,
  totalChanges,
  commitMessage,
  busy,
  onCommitted,
}: {
  cwd: string
  status: GitStatus
  totalChanges: number
  /** The commit box's message, for "Commit, push & PR". */
  commitMessage: string
  /** A commit, push or pull is running. */
  busy: boolean
  /** The dialog committed the working tree. */
  onCommitted: () => void
}) {
  const pullRequest = useThreadPullRequest(cwd, status.branch || null)
  const threadId = useChatStore((state) => {
    const active = state.activeThreadId
      ? state.threads.find((thread) => thread.id === state.activeThreadId)
      : null
    return active && threadMatchesPanelCwd(active, cwd) ? active.id : null
  })
  const [dialog, setDialog] = useState<{ commitFirst: boolean } | null>(null)
  if (!status.branch) return null
  const state = pullRequest ? pullRequestState(pullRequest) : null
  const open = state === "open" || state === "draft"

  return (
    <div className="git-remote-sync" role="group" aria-label="Pull request">
      <div className="git-remote-heading">
        <span>Pull request</span>
      </div>
      {pullRequest && state ? (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              openPullRequestsPage({ cwd, number: pullRequest.number })
            }
            title={pullRequest.title}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            <PullRequestStateIcon state={state} />
            <span className="shrink-0 text-muted-foreground tabular-nums">
              #{pullRequest.number}
            </span>
            <span className="min-w-0 truncate">{pullRequest.title}</span>
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Open the pull request on GitHub"
            title="Open on GitHub"
            onClick={() => void openSourceReference(pullRequest.url)}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {!open ? (
        <div className="git-remote-actions">
          <Button
            variant="outline"
            size="xs"
            className="gap-1.5"
            disabled={busy}
            onClick={() => setDialog({ commitFirst: false })}
            title="Push this branch and open a pull request on GitHub"
          >
            <GitPullRequestCreateIcon className="size-3.5" aria-hidden="true" />
            Create PR
          </Button>
          {totalChanges > 0 ? (
            <Button
              variant="outline"
              size="xs"
              className="gap-1.5"
              disabled={busy}
              onClick={() => setDialog({ commitFirst: true })}
              title="Commit the changes, push the branch and open a pull request"
            >
              <GitCommitVerticalIcon className="size-3.5" aria-hidden="true" />
              Commit, push & PR
            </Button>
          ) : null}
        </div>
      ) : null}
      {dialog ? (
        <Suspense fallback={null}>
          <CreatePullRequestDialog
            open
            onOpenChange={(next) => {
              if (!next) setDialog(null)
            }}
            cwd={cwd}
            threadId={threadId}
            commitFirst={dialog.commitFirst}
            commitMessage={commitMessage}
            onCommitted={onCommitted}
          />
        </Suspense>
      ) : null}
    </div>
  )
}
