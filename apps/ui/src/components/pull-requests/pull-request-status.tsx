import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  type LucideIcon,
} from "lucide-react"
import type {
  GitHubCheckSummary,
  GitHubPullRequestState,
  GitHubReviewDecision,
} from "@betterc0de/schema/http-contracts"
import {
  checkSummaryLook,
  pullRequestStateLook,
  reviewDecisionLook,
  STATUS_TONE_CLASS,
} from "@/lib/pull-requests"
import { cn } from "@/lib/utils"

/**
 * The small status marks of a pull request, shared by the Pull Requests
 * page, the create dialog and the chat's pull request chip. Every colour has
 * a text or an accessible name beside it.
 */

const STATE_ICON: Record<GitHubPullRequestState, LucideIcon> = {
  open: GitPullRequestIcon,
  draft: GitPullRequestDraftIcon,
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
}

export function PullRequestStateIcon({
  state,
  className,
}: {
  state: GitHubPullRequestState
  className?: string
}) {
  const look = pullRequestStateLook(state)
  const Icon = STATE_ICON[state]
  return (
    <Icon
      role="img"
      aria-label={look.label}
      className={cn(
        "size-3.5 shrink-0",
        STATUS_TONE_CLASS[look.tone],
        className
      )}
      strokeWidth={2}
    />
  )
}

/** The state as a quiet pill: icon and word in the state's colour. */
export function PullRequestStateChip({
  state,
}: {
  state: GitHubPullRequestState
}) {
  const look = pullRequestStateLook(state)
  const Icon = STATE_ICON[state]
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-medium",
        STATUS_TONE_CLASS[look.tone]
      )}
    >
      <Icon aria-hidden="true" className="size-3" strokeWidth={2} />
      {look.label}
    </span>
  )
}

const CHECK_ICON = {
  pass: CircleCheckIcon,
  fail: CircleXIcon,
  pending: CircleDashedIcon,
} as const

/** Checks on the head commit: an icon and `passed/total`, named in full for screen readers. */
export function CheckSummaryBadge({
  checks,
  showLabel = false,
}: {
  checks: GitHubCheckSummary
  showLabel?: boolean
}) {
  const look = checkSummaryLook(checks)
  if (look.state === "none") return null
  const Icon = CHECK_ICON[look.state]
  return (
    <span
      title={look.label}
      aria-label={look.label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11px] tabular-nums",
        STATUS_TONE_CLASS[look.tone]
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          look.state === "pending" &&
            "[animation-duration:3s] motion-safe:animate-spin"
        )}
        strokeWidth={2}
      />
      <span aria-hidden="true">{showLabel ? look.label : look.short}</span>
    </span>
  )
}

export function ReviewDecisionBadge({
  decision,
}: {
  decision: GitHubReviewDecision | null
}) {
  const look = reviewDecisionLook(decision)
  if (!look) return null
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full bg-muted/60 px-2 py-0.5 text-[10.5px] font-medium",
        STATUS_TONE_CLASS[look.tone]
      )}
    >
      {look.label}
    </span>
  )
}
