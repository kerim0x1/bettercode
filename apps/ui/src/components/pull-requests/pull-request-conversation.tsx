import { useId, useState } from "react"
import { BotIcon, Loader2Icon } from "lucide-react"
import type {
  GitHubConversationItem,
  GitHubPullRequestDetail,
  GitHubReviewState,
} from "@betterc0de/schema/http-contracts"
import { MessageResponse } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { pullRequestErrorMessage } from "@/lib/pull-request-create"
import {
  STATUS_TONE_CLASS,
  updatedAgo,
  type StatusTone,
} from "@/lib/pull-requests"
import { cn } from "@/lib/utils"
import {
  githubCommentOnPullRequest,
  githubReviewPullRequest,
} from "@/services/backend/github-api"

const REVIEW_LOOK: Record<
  GitHubReviewState,
  { label: string; tone: StatusTone }
> = {
  approved: { label: "approved", tone: "success" },
  changes_requested: { label: "requested changes", tone: "danger" },
  commented: { label: "reviewed", tone: "muted" },
  dismissed: { label: "review dismissed", tone: "muted" },
  pending: { label: "pending review", tone: "muted" },
}

/** Two letters for an author's avatar tile. */
function initials(login: string | null): string {
  if (!login) return "?"
  const clean = login.replace(/^app\//, "").replace(/\[bot\]$/, "")
  return clean.slice(0, 2).toUpperCase()
}

function Author({ login, isBot }: { login: string | null; isBot: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground"
      >
        {isBot ? <BotIcon className="size-3.5" /> : initials(login)}
      </span>
      <span className="truncate text-[12px] font-medium text-foreground">
        {login ?? "Someone"}
      </span>
    </span>
  )
}

/** Markdown from GitHub, drawn like an agent's reply. */
function GitHubMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-[13px] leading-relaxed">
      <MessageResponse>{text}</MessageResponse>
    </div>
  )
}

function ConversationItem({ item }: { item: GitHubConversationItem }) {
  const review = item.reviewState ? REVIEW_LOOK[item.reviewState] : null
  const ago = updatedAgo(item.createdAt)
  return (
    <li className="rounded-xl border border-border/50 bg-card/40">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        <Author login={item.author} isBot={item.authorIsBot} />
        {review ? (
          <span
            className={cn(
              "shrink-0 text-[11.5px]",
              STATUS_TONE_CLASS[review.tone]
            )}
          >
            {review.label}
          </span>
        ) : (
          <span className="shrink-0 text-[11.5px] text-muted-foreground">
            commented
          </span>
        )}
        {ago ? (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {ago}
          </span>
        ) : null}
      </div>
      {item.body.trim() ? (
        <div className="px-3 py-2.5">
          <GitHubMarkdown text={item.body} />
        </div>
      ) : null}
    </li>
  )
}

/**
 * A pull request's description and conversation (comments and reviews,
 * oldest first), then a composer to comment, approve or request changes.
 * Reviewing your own pull request is GitHub's refusal, so those two buttons
 * say so instead of failing.
 */
export function PullRequestConversation({
  cwd,
  detail,
  onChanged,
}: {
  cwd: string
  detail: GitHubPullRequestDetail
  /** Something was posted: reload the pull request. */
  onChanged: () => void
}) {
  const id = useId()
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState<
    null | "comment" | "approve" | "request_changes"
  >(null)
  const [error, setError] = useState<string | null>(null)
  const ownPullRequest = detail.viewerIsAuthor
  const closed = detail.state === "merged" || detail.state === "closed"

  const post = async (action: "comment" | "approve" | "request_changes") => {
    if (busy) return
    setBusy(action)
    setError(null)
    try {
      if (action === "comment") {
        await githubCommentOnPullRequest({ cwd, number: detail.number, body })
      } else {
        await githubReviewPullRequest({
          cwd,
          number: detail.number,
          event: action,
          body,
        })
      }
      setBody("")
      onChanged()
    } catch (failure) {
      setError(pullRequestErrorMessage(failure))
    } finally {
      setBusy(null)
    }
  }

  const reviewBlocked = ownPullRequest
    ? "You can't review your own pull request."
    : closed
      ? "This pull request is no longer open."
      : null

  return (
    <div className="flex flex-col gap-3">
      <article className="rounded-xl border border-border/50 bg-card/40">
        <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
          <Author login={detail.author} isBot={detail.authorIsBot} />
          <span className="shrink-0 text-[11.5px] text-muted-foreground">
            opened this pull request
          </span>
          {detail.createdAt ? (
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {updatedAgo(detail.createdAt)}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2.5">
          {detail.body.trim() ? (
            <GitHubMarkdown text={detail.body} />
          ) : (
            <p className="text-[12px] text-muted-foreground italic">
              No description.
            </p>
          )}
          {detail.bodyTruncated ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              The description is shortened here; the rest is on GitHub.
            </p>
          ) : null}
        </div>
      </article>

      {detail.conversationTruncated ? (
        <p className="text-center text-[11px] text-muted-foreground">
          Earlier comments are on GitHub.
        </p>
      ) : null}
      {detail.conversation.length > 0 ? (
        <ol className="flex flex-col gap-3" aria-label="Conversation">
          {detail.conversation.map((item) => (
            <ConversationItem key={`${item.kind}:${item.id}`} item={item} />
          ))}
        </ol>
      ) : null}

      <div className="flex flex-col gap-2 rounded-xl border border-border/50 bg-card/40 p-3">
        <label
          htmlFor={id}
          className="text-xs font-medium text-muted-foreground"
        >
          Add to the conversation
        </label>
        <Textarea
          id={id}
          value={body}
          disabled={busy !== null}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              body.trim()
            )
              void post("comment")
          }}
          placeholder="Leave a comment (Markdown)"
          className="max-h-60 min-h-20 rounded-xl text-[13px]"
        />
        {error ? (
          <p role="alert" className="text-[12px] text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {reviewBlocked ? (
            <span className="mr-auto text-[11px] text-muted-foreground">
              {reviewBlocked}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="xs"
            disabled={Boolean(reviewBlocked) || busy !== null || !body.trim()}
            aria-busy={busy === "request_changes"}
            title="Submit a review that asks for changes (needs a message)"
            onClick={() => void post("request_changes")}
          >
            {busy === "request_changes" ? (
              <Loader2Icon
                aria-hidden="true"
                className="size-3 motion-safe:animate-spin"
              />
            ) : null}
            Request changes
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={Boolean(reviewBlocked) || busy !== null}
            aria-busy={busy === "approve"}
            title="Approve, with the message above as the review's comment"
            onClick={() => void post("approve")}
          >
            {busy === "approve" ? (
              <Loader2Icon
                aria-hidden="true"
                className="size-3 motion-safe:animate-spin"
              />
            ) : null}
            Approve
          </Button>
          <Button
            size="xs"
            disabled={busy !== null || !body.trim()}
            aria-busy={busy === "comment"}
            title="Comment (Ctrl+Enter)"
            onClick={() => void post("comment")}
          >
            {busy === "comment" ? (
              <Loader2Icon
                aria-hidden="true"
                className="size-3 motion-safe:animate-spin"
              />
            ) : null}
            Comment
          </Button>
        </div>
      </div>
    </div>
  )
}
