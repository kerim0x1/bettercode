import { lazy, Suspense, useEffect, useState } from "react"
import {
  BellRingIcon,
  ExternalLinkIcon,
  GitCommitVerticalIcon,
  GitPullRequestCreateIcon,
  PanelTopIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PullRequestStateIcon } from "@/components/pull-requests/pull-request-status"
import {
  setPullRequestWake,
  WAKE_LABEL,
} from "@/components/pull-requests/pull-request-wake-switch"
import { useChatStore } from "@/lib/chat-store"
import {
  usePullRequestWake,
  usePullRequestWakeStore,
} from "@/lib/pull-request-wake-store"
import { openPullRequestsPage } from "@/lib/pull-requests-page"
import { openSourceReference } from "@/lib/source-opener"
import {
  pullRequestState,
  useThreadPullRequest,
} from "@/lib/thread-pull-request"
import { cn } from "@/lib/utils"
import { isRemoteRuntime } from "@/services/backend/runtime"

// Loaded on first use: the header mounts with every chat, the dialog rarely.
const CreatePullRequestDialog = lazy(() =>
  import("@/components/pull-requests/create-pull-request-dialog").then(
    (module) => ({ default: module.CreatePullRequestDialog })
  )
)

/**
 * A chat's pull request in its header. With a pull request: its state icon
 * and `#number` (a ringing bell while wake-ups are on), opening a menu to
 * view it in the app or on GitHub and to turn wake-ups on CI failures and
 * reviews on or off. Without one, on a chat that records a branch: a create
 * button with "Create pull request" and "Commit, push & create PR".
 */
export function ThreadPullRequestChip({
  threadId,
  className,
}: {
  threadId: string | null | undefined
  className?: string
}) {
  const thread = useChatStore((state) =>
    threadId
      ? (state.threads.find((entry) => entry.id === threadId) ?? null)
      : null
  )
  const cwd = thread?.worktreePath?.trim() || thread?.projectPath?.trim() || ""
  // Keyed like the sidebar rows, so they share one poll per project.
  const pullRequest = useThreadPullRequest(
    thread?.projectPath || thread?.worktreePath,
    thread?.branch
  )
  const watch = usePullRequestWake(threadId)
  const wakeLoaded = usePullRequestWakeStore((state) => state.loaded)
  const [dialog, setDialog] = useState<{ commitFirst: boolean } | null>(null)
  const remote = isRemoteRuntime()

  useEffect(() => {
    if (pullRequest && !wakeLoaded && !remote)
      void usePullRequestWakeStore.getState().refresh()
  }, [pullRequest, wakeLoaded, remote])

  if (!thread || !threadId || !cwd || !thread.branch) return null
  const waking = watch?.enabled === true

  if (!pullRequest) {
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "text-muted-foreground hover:text-foreground",
                className
              )}
              aria-label="Create pull request"
              title="Create pull request"
            >
              <GitPullRequestCreateIcon
                className="size-3.5"
                strokeWidth={1.75}
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem
              onSelect={() => setDialog({ commitFirst: false })}
            >
              <GitPullRequestCreateIcon />
              Create pull request…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDialog({ commitFirst: true })}>
              <GitCommitVerticalIcon />
              Commit, push & create PR…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {dialog ? (
          <Suspense fallback={null}>
            <CreatePullRequestDialog
              open
              onOpenChange={(open) => {
                if (!open) setDialog(null)
              }}
              cwd={cwd}
              threadId={threadId}
              commitFirst={dialog.commitFirst}
            />
          </Suspense>
        ) : null}
      </>
    )
  }

  const state = pullRequestState(pullRequest)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Pull request #${pullRequest.number}${waking ? ", wake-ups on" : ""}`}
          title={pullRequest.title}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none aria-expanded:bg-muted/50",
            className
          )}
        >
          <PullRequestStateIcon state={state} className="size-3" />
          {`#${pullRequest.number}`}
          {waking ? (
            <BellRingIcon
              aria-hidden="true"
              className="size-3 text-primary"
              strokeWidth={2}
            />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <div className="px-2.5 pt-1.5 pb-1">
          <p className="line-clamp-2 text-[12px] leading-snug font-medium">
            {pullRequest.title || pullRequest.branch}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
            #{pullRequest.number} · {pullRequest.branch}
          </p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            openPullRequestsPage({ cwd, number: pullRequest.number })
          }
        >
          <PanelTopIcon />
          View pull request
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void openSourceReference(pullRequest.url)}
        >
          <ExternalLinkIcon />
          Open on GitHub
        </DropdownMenuItem>
        {!remote && (state === "open" || state === "draft" || waking) ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={waking}
              onCheckedChange={(checked) =>
                void setPullRequestWake(threadId, checked === true)
              }
            >
              <BellRingIcon />
              {WAKE_LABEL}
            </DropdownMenuCheckboxItem>
            {watch?.message ? (
              <p
                role="status"
                className="px-2.5 pt-0.5 pb-1.5 text-[11px] leading-snug text-muted-foreground"
              >
                {watch.message}
              </p>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
