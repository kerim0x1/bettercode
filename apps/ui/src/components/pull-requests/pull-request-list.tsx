import { useEffect, useMemo, useState } from "react"
import {
  ExternalLinkIcon,
  GitBranchIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  CheckSummaryBadge,
  PullRequestStateIcon,
  ReviewDecisionBadge,
} from "@/components/pull-requests/pull-request-status"
import { useChatStore } from "@/lib/chat-store"
import { githubSetupHint } from "@/lib/pull-request-create"
import {
  filterCounts,
  filterPullRequests,
  flattenPullRequests,
  overviewProblems,
  pullRequestProjectFolders,
  updatedAgo,
  type ListedPullRequest,
  type PullRequestFilter,
} from "@/lib/pull-requests"
import { usePullRequestsStore } from "@/lib/pull-requests-store"
import { openSourceReference } from "@/lib/source-opener"
import { cn } from "@/lib/utils"

const FILTERS: ReadonlyArray<{ id: PullRequestFilter; label: string }> = [
  { id: "mine", label: "Mine" },
  { id: "review", label: "Review requested" },
  { id: "all", label: "All open" },
]

const GH_CLI_URL = "https://cli.github.com"

/** The project folders of the user's chats, recomputed only when they change. */
export function usePullRequestFolders(): string[] {
  const key = useChatStore((state) =>
    pullRequestProjectFolders(state.threads).join("\n")
  )
  return useMemo(() => (key ? key.split("\n") : []), [key])
}

/**
 * The open pull requests of every project, newest activity first: a
 * Mine / Review requested / All open switch with counts, a search over
 * title, number, author, branch, repository and labels, and one row per
 * pull request with its checks and review state.
 */
export function PullRequestList({
  onOpen,
}: {
  onOpen: (pullRequest: ListedPullRequest) => void
}) {
  const folders = usePullRequestFolders()
  const { overview, loading, error, load } = usePullRequestsStore()
  const [filter, setFilter] = useState<PullRequestFilter>("all")
  const [query, setQuery] = useState("")

  useEffect(() => {
    void load(folders)
  }, [folders, load])

  const all = useMemo(
    () => flattenPullRequests(overview?.repositories ?? []),
    [overview]
  )
  const viewer = overview?.viewerLogin ?? null
  const counts = useMemo(() => filterCounts(all, viewer), [all, viewer])
  const visible = useMemo(
    () => filterPullRequests(all, { filter, query, viewerLogin: viewer }),
    [all, filter, query, viewer]
  )
  const problems = useMemo(
    () => overviewProblems(overview?.repositories ?? []),
    [overview]
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-1">
        <div
          role="tablist"
          aria-label="Which pull requests"
          className="flex items-center gap-0.5 rounded-xl bg-foreground/[0.05] p-1"
        >
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              aria-controls="pull-request-list"
              onClick={() => setFilter(item.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none active:scale-[0.96] motion-reduce:active:scale-100",
                filter === item.id
                  ? "bg-foreground/[0.08] font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {item.label}
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {counts[item.id]}
              </span>
            </button>
          ))}
        </div>
        <label className="flex h-8 w-full max-w-72 items-center gap-2 rounded-xl bg-muted/40 px-2.5 text-[12px] text-muted-foreground focus-within:bg-muted/60 focus-within:ring-2 focus-within:ring-ring/30">
          <SearchIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault()
                setQuery("")
              }
            }}
            aria-label="Search pull requests"
            placeholder="Search title, #number, author, branch"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        </label>
      </div>

      {problems.cli ? (
        <Alert>
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>
            {problems.cli.status === "gh_missing"
              ? "GitHub CLI isn't installed"
              : "GitHub CLI isn't signed in"}
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-2 text-xs">
            <span>
              {githubSetupHint(problems.cli.status) ?? problems.cli.message}
            </span>
            <span className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="xs"
                disabled={loading}
                onClick={() => void load(folders, { refresh: true })}
              >
                Check again
              </Button>
              {problems.cli.status === "gh_missing" ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="gap-1.5"
                  onClick={() => void openSourceReference(GH_CLI_URL)}
                >
                  <ExternalLinkIcon aria-hidden="true" className="size-3" />
                  Get GitHub CLI
                </Button>
              ) : null}
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-foreground"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <Button
            variant="ghost"
            size="xs"
            disabled={loading}
            onClick={() => void load(folders, { refresh: true })}
          >
            Retry
          </Button>
        </div>
      ) : null}

      <div id="pull-request-list" role="tabpanel" aria-busy={loading}>
        {visible.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {visible.map((pullRequest) => (
              <li key={`${pullRequest.slug}#${pullRequest.number}`}>
                <PullRequestRow
                  pullRequest={pullRequest}
                  onOpen={() => onOpen(pullRequest)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyList
            loading={loading && !overview}
            hasProjects={folders.length > 0}
            filter={filter}
            searching={Boolean(query.trim())}
            hasAny={all.length > 0}
          />
        )}
      </div>

      {problems.errors.map((problem) => (
        <p
          key={problem.slug}
          className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
        >
          <TriangleAlertIcon
            aria-hidden="true"
            className="mt-px size-3 shrink-0 text-warning"
          />
          <span>
            <span className="font-mono">{problem.slug}</span>: {problem.message}
          </span>
        </p>
      ))}
      {problems.withoutRemote > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {problems.withoutRemote === 1
            ? "1 project has no GitHub remote and isn't listed."
            : `${problems.withoutRemote} projects have no GitHub remote and aren't listed.`}
        </p>
      ) : null}
    </div>
  )
}

function PullRequestRow({
  pullRequest,
  onOpen,
}: {
  pullRequest: ListedPullRequest
  onOpen: () => void
}) {
  const updated = updatedAgo(pullRequest.updatedAt)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group/pr flex w-full items-start gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border/40 hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
    >
      <PullRequestStateIcon
        state={pullRequest.state}
        className="mt-0.5 size-4"
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
            {pullRequest.title}
          </span>
          {pullRequest.labels.slice(0, 3).map((label) => (
            <span
              key={label}
              className="hidden shrink-0 rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground sm:inline"
            >
              {label}
            </span>
          ))}
        </span>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="truncate font-mono">{pullRequest.slug}</span>
          <span className="tabular-nums">#{pullRequest.number}</span>
          {pullRequest.author ? <span>{pullRequest.author}</span> : null}
          <span className="flex min-w-0 items-center gap-1">
            <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="max-w-48 truncate font-mono">
              {pullRequest.headBranch}
            </span>
            <span aria-hidden="true">→</span>
            <span className="sr-only">into</span>
            <span className="max-w-32 truncate font-mono">
              {pullRequest.baseBranch}
            </span>
          </span>
          {updated ? <span>updated {updated}</span> : null}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="flex items-center gap-2">
          {pullRequest.reviewRequested ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-primary">
              Your review
            </span>
          ) : null}
          <ReviewDecisionBadge decision={pullRequest.reviewDecision} />
          <CheckSummaryBadge checks={pullRequest.checks} />
        </span>
        <span className="text-[10.5px] text-muted-foreground tabular-nums">
          <span className="text-success">+{pullRequest.additions}</span>{" "}
          <span className="text-destructive">−{pullRequest.deletions}</span>
        </span>
      </span>
    </button>
  )
}

function EmptyList({
  loading,
  hasProjects,
  filter,
  searching,
  hasAny,
}: {
  loading: boolean
  hasProjects: boolean
  filter: PullRequestFilter
  searching: boolean
  hasAny: boolean
}) {
  const text = loading
    ? "Reading pull requests…"
    : !hasProjects
      ? "Open a project with a GitHub remote to see its pull requests here."
      : searching
        ? "No pull requests match your search."
        : filter === "mine"
          ? "You have no open pull requests in these projects."
          : filter === "review"
            ? "Nobody is waiting for your review."
            : hasAny
              ? "No pull requests."
              : "No open pull requests in your projects."
  return (
    <p
      role="status"
      className="rounded-xl border border-dashed border-border/60 px-4 py-10 text-center text-[12px] text-muted-foreground"
    >
      {text}
    </p>
  )
}
