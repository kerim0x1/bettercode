import { useCallback, useEffect, useId, useState } from "react"
import {
  BotIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleXIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitMergeIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react"
import type {
  GitHubCheckRun,
  GitHubCheckStatus,
  GitHubPullRequestDetail,
} from "@betterc0de/schema/http-contracts"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { PullRequestConversation } from "@/components/pull-requests/pull-request-conversation"
import { PullRequestFiles } from "@/components/pull-requests/pull-request-files"
import {
  CheckSummaryBadge,
  PullRequestStateChip,
  ReviewDecisionBadge,
} from "@/components/pull-requests/pull-request-status"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { handleError } from "@/lib/errors"
import { pullRequestErrorMessage } from "@/lib/pull-request-create"
import { askAgentToReview, workOnPullRequest } from "@/lib/pull-request-work"
import { STATUS_TONE_CLASS, updatedAgo } from "@/lib/pull-requests"
import { openSourceReference } from "@/lib/source-opener"
import { refreshPullRequests } from "@/lib/thread-pull-request"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import {
  githubMergePullRequest,
  githubPullRequestDetail,
  githubSetPullRequestState,
} from "@/services/backend/github-api"

type DetailTab = "conversation" | "checks" | "files"
type MergeMethod = "merge" | "squash" | "rebase"

const MERGE_LABEL: Record<MergeMethod, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
}

const CHECK_LOOK: Record<
  GitHubCheckStatus,
  { icon: typeof CircleCheckIcon; label: string; className: string }
> = {
  pass: {
    icon: CircleCheckIcon,
    label: "Passed",
    className: STATUS_TONE_CLASS.success,
  },
  fail: {
    icon: CircleXIcon,
    label: "Failed",
    className: STATUS_TONE_CLASS.danger,
  },
  cancelled: {
    icon: CircleXIcon,
    label: "Cancelled",
    className: STATUS_TONE_CLASS.muted,
  },
  pending: {
    icon: CircleDashedIcon,
    label: "Running",
    className: STATUS_TONE_CLASS.warning,
  },
  skipped: {
    icon: CircleMinusIcon,
    label: "Skipped",
    className: STATUS_TONE_CLASS.muted,
  },
  neutral: {
    icon: CircleMinusIcon,
    label: "Neutral",
    className: STATUS_TONE_CLASS.muted,
  },
}

/**
 * One pull request: its header (state, author, branches, checks, review),
 * the actions (open on GitHub, work on it in a new chat, ask the agent to
 * review it, close or reopen, merge with a method the repository allows),
 * and Conversation, Checks and Files tabs.
 */
export function PullRequestDetailView({
  cwd,
  number,
}: {
  cwd: string
  number: number
}) {
  const [detail, setDetail] = useState<GitHubPullRequestDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<DetailTab>("conversation")
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    githubPullRequestDetail(cwd, number)
      .then((value) => {
        if (active) setDetail(value)
      })
      .catch((failure: unknown) => {
        if (active) setError(pullRequestErrorMessage(failure))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [cwd, number, attempt])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])

  if (!detail) {
    return error ? (
      <Alert variant="destructive">
        <AlertTitle>Couldn't open pull request #{number}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2 text-xs">
          <span>{error}</span>
          <span>
            <Button variant="outline" size="xs" onClick={reload}>
              Try again
            </Button>
          </span>
        </AlertDescription>
      </Alert>
    ) : (
      <p
        role="status"
        className="py-16 text-center text-xs text-muted-foreground"
      >
        Loading pull request #{number}…
      </p>
    )
  }

  const tabs: ReadonlyArray<{ id: DetailTab; label: string; count: number }> = [
    {
      id: "conversation",
      label: "Conversation",
      count: detail.conversation.length,
    },
    { id: "checks", label: "Checks", count: detail.checkRuns.length },
    { id: "files", label: "Files changed", count: detail.changedFiles },
  ]

  return (
    <div className="flex flex-col gap-4">
      <PullRequestHeader detail={detail} loading={loading} onReload={reload} />
      <PullRequestActions cwd={cwd} detail={detail} onChanged={reload} />
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      <div
        role="tablist"
        aria-label="Pull request view"
        className="flex w-fit items-center gap-0.5 rounded-xl bg-foreground/[0.05] p-1"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls="pull-request-view"
            onClick={() => setTab(item.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none active:scale-[0.96] motion-reduce:active:scale-100",
              tab === item.id
                ? "bg-foreground/[0.08] font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {item.label}
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {item.count}
            </span>
          </button>
        ))}
      </div>
      <div id="pull-request-view" role="tabpanel" aria-label={tab}>
        {tab === "conversation" ? (
          <PullRequestConversation
            cwd={cwd}
            detail={detail}
            onChanged={reload}
          />
        ) : tab === "checks" ? (
          <ChecksList runs={detail.checkRuns} />
        ) : (
          <PullRequestFiles
            cwd={cwd}
            number={number}
            headSha={detail.headSha}
          />
        )}
      </div>
    </div>
  )
}

function PullRequestHeader({
  detail,
  loading,
  onReload,
}: {
  detail: GitHubPullRequestDetail
  loading: boolean
  onReload: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-[18px] leading-snug font-semibold text-foreground">
          {detail.title}{" "}
          <span className="font-normal text-muted-foreground tabular-nums">
            #{detail.number}
          </span>
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Reload the pull request"
          title="Reload"
          disabled={loading}
          onClick={onReload}
        >
          <RefreshCwIcon
            className={cn("size-3.5", loading && "motion-safe:animate-spin")}
          />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-muted-foreground">
        <PullRequestStateChip state={detail.state} />
        <span className="flex items-center gap-1">
          {detail.authorIsBot ? (
            <BotIcon aria-hidden="true" className="size-3.5" />
          ) : null}
          <span className="font-medium text-foreground">
            {detail.author ?? "Someone"}
          </span>
          wants to merge into
        </span>
        <span className="flex min-w-0 items-center gap-1 font-mono text-[11px]">
          <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate rounded bg-muted/60 px-1">
            {detail.baseBranch}
          </span>
          <span aria-hidden="true">←</span>
          <span className="sr-only">from</span>
          <span className="truncate rounded bg-muted/60 px-1">
            {detail.headBranch}
          </span>
        </span>
        <span className="font-mono text-[11px]">{detail.repository.slug}</span>
        {detail.updatedAt ? (
          <span>updated {updatedAgo(detail.updatedAt)}</span>
        ) : null}
        <span className="tabular-nums">
          <span className="text-success">+{detail.additions}</span>{" "}
          <span className="text-destructive">−{detail.deletions}</span>
        </span>
        <ReviewDecisionBadge decision={detail.reviewDecision} />
        <CheckSummaryBadge checks={detail.checks} showLabel />
      </div>
    </div>
  )
}

function PullRequestActions({
  cwd,
  detail,
  onChanged,
}: {
  cwd: string
  detail: GitHubPullRequestDetail
  onChanged: () => void
}) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState<null | "work" | "review" | "state">(null)
  const open = detail.state === "open" || detail.state === "draft"

  const run = async (
    kind: "work" | "review" | "state",
    action: () => Promise<void>
  ) => {
    if (busy) return
    setBusy(kind)
    try {
      await action()
    } catch (failure) {
      toast.error(pullRequestErrorMessage(failure))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={busy !== null || !open}
          aria-busy={busy === "work"}
          title={
            detail.isCrossRepository
              ? "Check the branch out in a new chat's worktree. It comes from a fork: the folder starts untrusted, and pushing won't update the pull request."
              : "Check the branch out in a new chat's worktree"
          }
          onClick={() =>
            void run("work", async () => {
              const result = await workOnPullRequest(cwd, detail)
              if (result.crossRepository)
                toast.info("Checked out from a fork", {
                  description:
                    "Read the code before you trust the folder: until then the agent can't work there. Pushing this branch won't update the pull request; push to the fork yourself.",
                })
            })
          }
        >
          {busy === "work" ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-3.5 motion-safe:animate-spin"
            />
          ) : (
            <FolderGit2Icon aria-hidden="true" className="size-3.5" />
          )}
          Work on this PR
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={busy !== null}
          aria-busy={busy === "review"}
          title="Open a read-only chat that reviews this pull request"
          onClick={() =>
            void run("review", async () => {
              await askAgentToReview(cwd, detail)
            })
          }
        >
          {busy === "review" ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-3.5 motion-safe:animate-spin"
            />
          ) : (
            <BotIcon aria-hidden="true" className="size-3.5" />
          )}
          Ask the agent to review
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => void openSourceReference(detail.url)}
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          Open on GitHub
        </Button>
        {detail.state !== "merged" ? (
          <Button
            variant={open ? "destructive" : "outline"}
            size="sm"
            className="ml-auto"
            disabled={busy !== null}
            aria-busy={busy === "state"}
            onClick={() =>
              void run("state", async () => {
                const ok = await confirm({
                  title: open
                    ? `Close pull request #${detail.number}?`
                    : `Reopen pull request #${detail.number}?`,
                  description: open
                    ? "It stays on GitHub and can be reopened. Its branch is kept."
                    : "It goes back to the open pull requests with its branch.",
                  confirmLabel: open ? "Close pull request" : "Reopen",
                  destructive: open,
                })
                if (!ok) return
                await githubSetPullRequestState({
                  cwd,
                  number: detail.number,
                  action: open ? "close" : "reopen",
                })
                refreshPullRequests()
                onChanged()
              })
            }
          >
            {open ? "Close" : "Reopen"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <MergeBox cwd={cwd} detail={detail} onMerged={onChanged} />
      ) : null}
    </div>
  )
}

/** Why merging is not possible yet, or null. */
function mergeBlocker(detail: GitHubPullRequestDetail): string | null {
  if (detail.state === "draft")
    return "This pull request is a draft. Mark it ready for review on GitHub first."
  if (detail.mergeable === "conflicting")
    return "This branch has conflicts with the base branch. Resolve them first."
  if (detail.repository.viewerPermission === "READ")
    return "You can't merge here: your GitHub access to this repository is read-only."
  return null
}

function MergeBox({
  cwd,
  detail,
  onMerged,
}: {
  cwd: string
  detail: GitHubPullRequestDetail
  onMerged: () => void
}) {
  const confirm = useConfirm()
  const ids = { method: useId(), branch: useId() }
  const allowed = (["squash", "merge", "rebase"] as const).filter(
    (method) => detail.repository.mergeMethods[method]
  )
  const [method, setMethod] = useState<MergeMethod>(allowed[0] ?? "merge")
  // The repository's own setting decides the default.
  const [deleteBranch, setDeleteBranch] = useState(
    detail.repository.deleteBranchOnMerge
  )
  const [merging, setMerging] = useState(false)
  const blocker = mergeBlocker(detail)
  const checksFailing = detail.checks.failed > 0
  const checksRunning = detail.checks.pending > 0

  const merge = async () => {
    const ok = await confirm({
      title: `Merge pull request #${detail.number}?`,
      description: `${MERGE_LABEL[method]} into ${detail.baseBranch}${deleteBranch && !detail.isCrossRepository ? `, then delete ${detail.headBranch} on GitHub` : ""}.${checksFailing ? " Some checks are failing." : checksRunning ? " Some checks are still running." : ""}`,
      confirmLabel: "Merge",
    })
    if (!ok) return
    setMerging(true)
    try {
      const result = await githubMergePullRequest({
        cwd,
        number: detail.number,
        method,
        deleteBranch: deleteBranch && !detail.isCrossRepository,
        ...(detail.headSha ? { headSha: detail.headSha } : {}),
      })
      toast.success(`Pull request #${detail.number} merged`, {
        description: result.message ?? undefined,
      })
      refreshPullRequests()
      onMerged()
    } catch (failure) {
      handleError(new Error(pullRequestErrorMessage(failure)), {
        source: "pull-request-merge",
      })
    } finally {
      setMerging(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/50 bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <GitMergeIcon
          aria-hidden="true"
          className={cn("size-4 shrink-0", STATUS_TONE_CLASS.merged)}
        />
        <div className="flex min-w-48 flex-1 items-center gap-2">
          <label htmlFor={ids.method} className="sr-only">
            Merge method
          </label>
          <Select
            value={method}
            onValueChange={(value) => setMethod(value as MergeMethod)}
            disabled={merging || allowed.length < 2}
          >
            <SelectTrigger
              id={ids.method}
              size="sm"
              className="w-full max-w-64 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {allowed.map((value) => (
                <SelectItem key={value} value={value} className="text-xs">
                  {MERGE_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!detail.isCrossRepository ? (
          <div className="flex items-center gap-2">
            <Switch
              id={ids.branch}
              size="sm"
              checked={deleteBranch}
              disabled={merging}
              onCheckedChange={setDeleteBranch}
              aria-label="Delete the branch after merging"
            />
            <label htmlFor={ids.branch} className="text-xs">
              Delete branch
            </label>
          </div>
        ) : null}
        <Button
          size="sm"
          className="gap-1.5"
          disabled={Boolean(blocker) || merging}
          aria-busy={merging}
          onClick={() => void merge()}
        >
          {merging ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-3.5 motion-safe:animate-spin"
            />
          ) : null}
          Merge
        </Button>
      </div>
      {blocker ? (
        <p className="text-[11.5px] text-muted-foreground">{blocker}</p>
      ) : checksFailing || checksRunning ? (
        <p
          className={cn(
            "text-[11.5px]",
            checksFailing ? STATUS_TONE_CLASS.danger : STATUS_TONE_CLASS.warning
          )}
        >
          {checksFailing
            ? "Some checks are failing. GitHub may refuse the merge if they are required."
            : "Some checks are still running."}
        </p>
      ) : null}
    </div>
  )
}

function ChecksList({ runs }: { runs: readonly GitHubCheckRun[] }) {
  if (runs.length === 0) {
    return (
      <p
        role="status"
        className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-[12px] text-muted-foreground"
      >
        No checks ran on the latest commit.
      </p>
    )
  }
  return (
    <ul className="flex flex-col divide-y divide-border/40 rounded-xl border border-border/50 bg-card/40">
      {runs.map((run, index) => {
        const look = CHECK_LOOK[run.status]
        const Icon = look.icon
        return (
          <li
            key={`${run.workflow ?? ""}:${run.name}:${index}`}
            className="flex items-center gap-3 px-3 py-2"
          >
            <Icon
              role="img"
              aria-label={look.label}
              className={cn(
                "size-4 shrink-0",
                look.className,
                run.status === "pending" &&
                  "[animation-duration:3s] motion-safe:animate-spin"
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-foreground">
                {run.name}
              </span>
              {run.workflow ? (
                <span className="block truncate text-[11px] text-muted-foreground">
                  {run.workflow}
                </span>
              ) : null}
            </span>
            <span className={cn("shrink-0 text-[11px]", look.className)}>
              {look.label}
            </span>
            {run.url ? (
              <Button
                variant="ghost"
                size="xs"
                className="gap-1"
                aria-label={`Details of ${run.name}`}
                onClick={() => void openSourceReference(run.url!)}
              >
                <ExternalLinkIcon aria-hidden="true" className="size-3" />
                Details
              </Button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
