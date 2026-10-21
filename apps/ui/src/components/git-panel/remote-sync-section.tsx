import type { GitStatus } from "@betterc0de/schema"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  CloudDownloadIcon,
  CloudUploadIcon,
  Loader2Icon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"
import {
  describeRemoteSync,
  pluralCommits,
  remoteSyncStatusText,
} from "./git-panel-utils"

/** Fetch / Push (or Publish) / Pull toolbar with the remote status line. */
export function RemoteSyncSection({
  status,
  isPushing,
  isPulling,
  isCommitting,
  isFetching,
  lastFetchedAt,
  onFetch,
  onPush,
  onPull,
}: {
  status: GitStatus
  isPushing: boolean
  isPulling: boolean
  isCommitting: boolean
  isFetching: boolean
  lastFetchedAt: Date | null
  onFetch: () => void
  onPush: () => void
  onPull: () => void
}) {
  const {
    ahead,
    behind,
    upstream,
    pushTitle,
    pullTitle,
    remoteBusy,
    pushDisabled,
    pullDisabled,
  } = describeRemoteSync(status, {
    isPushing,
    isPulling,
    isCommitting,
    isFetching,
  })
  return (
    <div
      className="git-remote-sync"
      role="group"
      aria-label="Remote synchronization"
    >
      <div className="git-remote-heading">
        <span>Remote</span>
        <span
          className="git-remote-upstream"
          title={upstream ?? "Publish this branch to set an upstream"}
        >
          {upstream ?? "Branch not published"}
        </span>
      </div>
      {/* One toolbar row: Fetch is the quiet check, Push/Pull are
          the real actions. Whichever has pending work gets the
          filled treatment so the eye lands on it. */}
      <div className="git-remote-actions">
        <Button
          variant="outline"
          size="xs"
          className="git-remote-fetch gap-1.5"
          onClick={onFetch}
          disabled={remoteBusy}
          aria-label="Fetch remote updates"
          aria-busy={isFetching}
          title="Fetch remote updates to check for incoming commits without changing your files"
        >
          <RefreshCwIcon
            className={cn("size-3.5", isFetching && "animate-spin")}
            aria-hidden="true"
          />
          <span>{isFetching ? "Fetching…" : "Fetch"}</span>
        </Button>
        <Button
          variant={!upstream || ahead > 0 ? "default" : "outline"}
          size="xs"
          className="git-remote-button ml-auto gap-1.5"
          data-pending={!upstream || ahead > 0 ? "true" : undefined}
          onClick={onPush}
          disabled={pushDisabled}
          title={pushTitle}
          aria-busy={isPushing}
        >
          {isPushing ? (
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <CloudUploadIcon
              className="size-3.5"
              strokeWidth={2}
              aria-hidden="true"
            />
          )}
          <span>
            {isPushing
              ? !upstream
                ? "Publishing…"
                : "Pushing…"
              : !upstream
                ? "Publish"
                : "Push"}
          </span>
          {upstream && ahead > 0 && (
            <span
              className="git-remote-count"
              aria-label={`${pluralCommits(ahead)} to push`}
            >
              {ahead}
            </span>
          )}
        </Button>
        <Button
          variant={behind > 0 ? "default" : "outline"}
          size="xs"
          className="git-remote-button gap-1.5"
          data-pending={behind > 0 ? "true" : undefined}
          onClick={onPull}
          disabled={pullDisabled}
          title={pullTitle}
          aria-busy={isPulling}
        >
          {isPulling ? (
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <CloudDownloadIcon
              className="size-3.5"
              strokeWidth={2}
              aria-hidden="true"
            />
          )}
          <span>{isPulling ? "Pulling…" : "Pull"}</span>
          {behind > 0 && (
            <span
              className="git-remote-count"
              aria-label={`${pluralCommits(behind)} to pull`}
            >
              {behind}
            </span>
          )}
        </Button>
      </div>
      <p
        className="git-remote-status"
        role="status"
        title={
          lastFetchedAt
            ? `Last fetched at ${lastFetchedAt.toLocaleTimeString()}`
            : undefined
        }
      >
        {remoteSyncStatusText({ isFetching, lastFetchedAt, upstream, behind })}
      </p>
    </div>
  )
}

/** Dismissable error of the last fetch, push or pull. */
export function RemoteErrorAlert({
  error,
  onDismiss,
}: {
  error: string
  onDismiss: () => void
}) {
  return (
    <div
      role="alert"
      className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
    >
      <span className="flex-1 leading-snug">{error}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/20"
        title="Dismiss"
        aria-label="Dismiss error"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}
