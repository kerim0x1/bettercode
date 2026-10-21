import React from "react"
import {
  CornerUpLeftIcon,
  GitForkIcon,
  GitMergeIcon,
  InfoIcon,
  Loader2Icon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { useChatStore } from "@/lib/chat-store"
import { handleError } from "@/lib/errors/handle"
import {
  isUserFork,
  mergeBackBlocker,
  mergeForkBack,
} from "@/lib/thread-branching"
import { chatContentWidth } from "./chat-layout"

/**
 * A slim header for a forked chat: which chat it came from (a link back),
 * that it works in the same folder or worktree, and **Merge back**, which
 * hands the fork's last answer and changed files to the parent. Renders
 * nothing for other chats.
 */
export function ForkLineageBar({
  threadId,
  minimalChat,
}: {
  threadId: string | null
  minimalChat: boolean
}) {
  const parentThreadId = useChatStore((state) => {
    const thread = threadId
      ? state.threads.find((candidate) => candidate.id === threadId)
      : undefined
    return thread && isUserFork(thread, state.settingsByThread[thread.id])
      ? (thread.parentThreadId ?? null)
      : null
  })
  if (!threadId || !parentThreadId) return null
  return (
    <ForkLineageBarContent
      threadId={threadId}
      parentThreadId={parentThreadId}
      minimalChat={minimalChat}
    />
  )
}

function ForkLineageBarContent({
  threadId,
  parentThreadId,
  minimalChat,
}: {
  threadId: string
  parentThreadId: string
  minimalChat: boolean
}) {
  const confirm = useConfirm()
  const [merging, setMerging] = React.useState(false)
  const parentTitle = useChatStore(
    (state) =>
      state.threads.find((thread) => thread.id === parentThreadId)?.title ??
      null
  )
  const sharesWorktree = useChatStore((state) =>
    Boolean(
      state.threads.find((thread) => thread.id === threadId)?.worktreePath
    )
  )
  const parentMissing = parentTitle === null
  const parentLabel = parentTitle?.trim() || "Untitled chat"
  const workspaceNote = sharesWorktree
    ? "This fork works in the same worktree as its parent, so file changes and checkpoint restores affect both chats."
    : "This fork works in the same folder as its parent, so file changes and checkpoint restores affect both chats."

  const openParent = () =>
    useChatStore.getState().setActiveThread(parentThreadId)

  const mergeBack = async () => {
    const blocker = mergeBackBlocker(threadId)
    if (blocker) {
      handleError(new Error(blocker), { source: "fork-merge-back" })
      return
    }
    const confirmed = await confirm({
      title: "Merge back to parent?",
      description: `Sends this fork's last answer and the list of files it changed to “${parentLabel}” as a new message, then opens that chat. If it is busy, the message waits in its queue until the current turn ends.`,
      confirmLabel: "Merge back",
    })
    if (!confirmed) return
    setMerging(true)
    try {
      await mergeForkBack(threadId)
    } catch (error) {
      handleError(error, { source: "fork-merge-back" })
    } finally {
      setMerging(false)
    }
  }

  return (
    <div
      className={cn(
        "mx-auto w-full shrink-0 px-4 pt-2",
        chatContentWidth(minimalChat)
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 py-1 pr-1 pl-2.5 text-[11px] text-muted-foreground">
        <GitForkIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span
          className="min-w-0 truncate"
          title={parentMissing ? undefined : parentLabel}
        >
          Fork of{" "}
          <span className="font-medium text-foreground/85">
            {parentMissing ? "a chat that is no longer available" : parentLabel}
          </span>
        </span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={workspaceNote}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <InfoIcon className="size-3" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              <p>{workspaceNote}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!parentMissing ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={openParent}
              className="text-muted-foreground hover:text-foreground"
            >
              <CornerUpLeftIcon aria-hidden="true" />
              <span className="max-[480px]:sr-only">Open parent</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => void mergeBack()}
            // A running fork is refused with its reason when clicked; a
            // disabled button could not say why.
            disabled={parentMissing || merging}
            aria-busy={merging || undefined}
            title="Send this fork's last answer and changed files to its parent"
          >
            {merging ? (
              <Loader2Icon
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
            ) : (
              <GitMergeIcon aria-hidden="true" />
            )}
            Merge back
          </Button>
        </div>
      </div>
    </div>
  )
}
