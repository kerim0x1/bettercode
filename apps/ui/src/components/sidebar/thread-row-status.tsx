import type { ReactNode } from "react"
import {
  Clock3Icon,
  FolderGit2Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  type LucideIcon,
} from "lucide-react"
import type { ChatThread } from "@betterc0de/schema"
import { Spinner } from "@/components/kibo-ui/spinner"
import { MENU_SEPARATOR } from "@/components/ui/menu-chrome"
import { useThreadAttention } from "@/lib/attention-store"
import { builtinProviders } from "@/lib/builtin-providers"
import { useChatStore } from "@/lib/chat-store"
import { useThreadLimitLabel } from "@/lib/chat-resume-store"
import { useThreadRunningElapsed } from "@/lib/chat/running-selectors"
import { timeAgo } from "@/lib/format"
import { getModelInfo } from "@/lib/get-model-info"
import { logoNeedsDarkInvert } from "@/lib/logo-invert"
import { openSourceReference } from "@/lib/source-opener"
import {
  pullRequestState,
  type PullRequestState,
} from "@/lib/thread-pull-request"
import type { GitPullRequest } from "@/services/backend/gitApi"
import { cn } from "@/lib/utils"

/**
 * The sidebar thread row's status column and its hover card.
 *
 * The glyph sits on the project's guide line, one per chat: working, waiting
 * for you, the branch's pull request, or a quiet ring. The card behind it
 * holds what a one-line row has no room for: branch, pull request, worktree
 * and model.
 */

const PULL_REQUEST_LOOK: Record<
  PullRequestState,
  { icon: LucideIcon; label: string; text: string }
> = {
  open: { icon: GitPullRequestIcon, label: "Open", text: "text-success" },
  draft: {
    icon: GitPullRequestDraftIcon,
    label: "Draft",
    text: "text-muted-foreground",
  },
  // GitHub's merged purple: a state's own colour, like a provider logo.
  merged: {
    icon: GitMergeIcon,
    label: "Merged",
    text: "text-purple-700 dark:text-purple-400",
  },
  closed: {
    icon: GitPullRequestClosedIcon,
    label: "Closed",
    text: "text-destructive",
  },
}

export function ThreadStatusGlyph({
  running,
  waiting,
  pullRequest,
  active,
  threadId,
  className,
}: {
  running: boolean
  waiting: boolean
  pullRequest: GitPullRequest | null
  active: boolean
  /** Shows "Limited" while a usage limit holds the chat. */
  threadId?: string
  className?: string
}) {
  const limited = useThreadLimitLabel(threadId)
  let glyph: ReactNode
  let label: string
  if (running) {
    glyph = <Spinner variant="bars" size={12} className="text-primary" />
    label = "Working"
  } else if (waiting) {
    glyph = <span className="size-[7px] rounded-full bg-warning" />
    label = "Waiting for you"
  } else if (limited) {
    glyph = <Clock3Icon className="size-3 text-warning" strokeWidth={2} />
    label = limited
  } else if (pullRequest) {
    const look = PULL_REQUEST_LOOK[pullRequestState(pullRequest)]
    const Icon = look.icon
    glyph = <Icon className={cn("size-3", look.text)} strokeWidth={2} />
    label = `Pull request #${pullRequest.number}, ${look.label.toLowerCase()}`
  } else {
    glyph = (
      <span
        className={cn(
          "size-[7px] rounded-full border",
          active
            ? "border-sidebar-foreground bg-sidebar-foreground"
            : "border-sidebar-foreground/40"
        )}
      />
    )
    label = active ? "Open" : "Idle"
  }
  return (
    // Masks the guide line behind it, like the fork toggle did.
    <span
      role="img"
      aria-label={label}
      className={cn(
        "relative z-10 grid size-3.5 shrink-0 place-items-center rounded-full bg-sidebar",
        className
      )}
    >
      {glyph}
    </span>
  )
}

/** The hover card's body; it mounts only while the card is open. */
export function ThreadDetailsCard({
  thread,
  pullRequest,
  running,
}: {
  thread: ChatThread
  pullRequest: GitPullRequest | null
  running: boolean
}) {
  const runningFor = useThreadRunningElapsed(thread.id)
  const attention = useThreadAttention(thread.id)
  const selectedModel = useChatStore(
    (state) => state.settingsByThread[thread.id]?.selectedModel
  )
  const modelId = lastAnsweredModel(thread) ?? selectedModel
  const modelInfo = getModelInfo(modelId)
  const provider = builtinProviders.find(
    (entry) =>
      (entry.providerKind ?? entry.id).toLowerCase() ===
      (thread.session?.providerKind ?? "").toLowerCase()
  )
  const modelName = modelInfo?.name ?? modelId ?? provider?.name ?? null
  const modelLogo = modelInfo?.logo || provider?.logo || ""
  const branch =
    thread.branch ||
    (thread.worktreePath
      ? thread.worktreePath.split(/[/\\]/).pop() || null
      : null)
  const waiting = (attention?.total ?? 0) > 0
  const limited = useThreadLimitLabel(thread.id)

  return (
    <>
      <div className="px-2 pt-1 pb-1.5">
        <p className="line-clamp-2 text-[12px] leading-snug font-medium text-popover-foreground">
          {thread.title || "New Task"}
        </p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="truncate">{thread.projectName || "BetterC0de"}</span>
          <span aria-hidden="true">·</span>
          {running ? (
            <span className="shrink-0 text-primary tabular-nums">
              Working{runningFor ? ` ${runningFor}` : ""}
            </span>
          ) : waiting ? (
            <span className="shrink-0 text-warning">Waiting for you</span>
          ) : limited ? (
            <span className="shrink-0 text-warning tabular-nums">
              {limited}
            </span>
          ) : (
            <span className="shrink-0 tabular-nums">
              {timeAgo(thread.updatedAt)}
            </span>
          )}
        </p>
      </div>
      <div className={MENU_SEPARATOR} />
      <div className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 px-2 pt-1 pb-1.5 text-[11px] text-popover-foreground">
        <GitBranchIcon
          aria-label="Branch"
          className="size-3.5 text-muted-foreground"
        />
        <span
          className={cn(
            "truncate font-mono text-[10.5px]",
            !branch && "font-sans text-muted-foreground/70"
          )}
        >
          {branch ?? "No branch recorded"}
        </span>
        {pullRequest ? <PullRequestRow pullRequest={pullRequest} /> : null}
        {thread.worktreePath ? (
          <>
            <FolderGit2Icon
              aria-label="Worktree"
              className="size-3.5 text-muted-foreground"
            />
            <span
              className="truncate font-mono text-[10.5px] text-muted-foreground"
              title={thread.worktreePath}
            >
              {shortPath(thread.worktreePath)}
            </span>
          </>
        ) : null}
        {modelName ? (
          <>
            {modelLogo ? (
              <img
                src={modelLogo}
                alt=""
                className={cn(
                  "size-3.5 object-contain",
                  logoNeedsDarkInvert(modelLogo) && "dark:invert"
                )}
              />
            ) : (
              <span />
            )}
            <span className="truncate">{modelName}</span>
          </>
        ) : null}
      </div>
    </>
  )
}

/** `⇄ #212` in the state's colour, for a task card's meta row. */
export function PullRequestBadge({
  pullRequest,
}: {
  pullRequest: GitPullRequest
}) {
  const look = PULL_REQUEST_LOOK[pullRequestState(pullRequest)]
  const Icon = look.icon
  return (
    <span
      aria-label={`Pull request #${pullRequest.number}, ${look.label.toLowerCase()}`}
      className={cn(
        "flex shrink-0 items-center gap-1 text-[10px] font-medium tabular-nums",
        look.text
      )}
    >
      <Icon aria-hidden="true" className="size-3" strokeWidth={2} />
      {`#${pullRequest.number}`}
    </span>
  )
}

function PullRequestRow({ pullRequest }: { pullRequest: GitPullRequest }) {
  const look = PULL_REQUEST_LOOK[pullRequestState(pullRequest)]
  const Icon = look.icon
  return (
    <>
      <Icon aria-hidden="true" className={cn("size-3.5", look.text)} />
      <button
        type="button"
        title={pullRequest.url}
        onClick={(event) => {
          event.stopPropagation()
          void openSourceReference(pullRequest.url)
        }}
        className="group/pr -mx-1 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-[var(--radius)] px-1 py-0.5 text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
      >
        <span className="shrink-0 text-muted-foreground tabular-nums">
          #{pullRequest.number}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {pullRequest.title || pullRequest.branch}
        </span>
        <span className={cn("shrink-0 text-[10px] font-medium", look.text)}>
          {look.label}
        </span>
      </button>
    </>
  )
}

function lastAnsweredModel(thread: ChatThread): string | undefined {
  const messages = thread.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant" && message.modelId) return message.modelId
  }
  return undefined
}

/** The last two path segments, so a worktree reads at a glance. */
function shortPath(value: string): string {
  const segments = value.replace(/\\/g, "/").split("/").filter(Boolean)
  const tail = segments.slice(-2).join("/")
  return segments.length > 2 ? `…/${tail}` : tail
}
