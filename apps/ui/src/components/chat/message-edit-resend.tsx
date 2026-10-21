import React from "react"
import {
  CircleStopIcon,
  CopyIcon,
  InfoIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  MousePointerClickIcon,
  PaperclipIcon,
  PencilIcon,
  RotateCcwIcon,
  SendHorizontalIcon,
  XIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { copyText } from "@/lib/clipboard"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MessageAction } from "@/components/ai-elements/message"
import type { ChatMessage } from "@/lib/chat-store"
import type { ChatSubmitPayload } from "@/lib/chat/types"
import {
  applyBetterC0deInputShortcut,
  resolveBetterC0deInputShortcut,
} from "@/lib/betterc0de-input-keybindings"
import {
  editableAttachments,
  fileRevertBlockerText,
  previewRewind,
  rewindAndResend,
  type RewindPreview,
} from "@/lib/message-rewind"

/**
 * Edit and resend for the user's own messages: a quiet hover toolbar under
 * the bubble (Edit, and a menu with Edit and Copy) and the inline editor
 * that takes the bubble's place. Sending rewinds the chat to just before the
 * message (`lib/message-rewind.ts`) and sends the edited text as a new turn.
 */
export function UserMessageActions({
  message,
  onEdit,
}: {
  message: Pick<ChatMessage, "content">
  onEdit: () => void
}) {
  return (
    // Hover actions: visible on pointer hover, keyboard focus, an open menu,
    // and always on touch screens without hover.
    <div className="-mt-1 flex h-6 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 motion-safe:transition-opacity [@media(hover:none)]:opacity-100">
      <MessageAction
        tooltip="Edit and resend"
        size="icon-xs"
        className="text-muted-foreground hover:text-foreground"
        onClick={onEdit}
      >
        <PencilIcon className="size-3.5" />
      </MessageAction>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Message actions"
            className="text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40">
          <DropdownMenuItem onClick={onEdit}>
            <PencilIcon className="size-3.5" /> Edit and resend
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyText(message.content)}>
            <CopyIcon className="size-3.5" /> Copy text
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

type EditorPhase = "editing" | "checking" | "choosing" | "sending"

/**
 * The inline editor in place of a user message. Enter sends and Shift,
 * Ctrl or Alt+Enter add a line, as in the composer; Escape cancels. The
 * message's attachments are kept unless removed here.
 */
export function InlineMessageEditor({
  threadId,
  message,
  workspaceRoot,
  onCancel,
  onResend,
}: {
  threadId: string
  message: ChatMessage
  workspaceRoot?: string | null
  onCancel: () => void
  onResend: (payload: ChatSubmitPayload) => unknown
}) {
  const [text, setText] = React.useState(message.content)
  const attachments = React.useMemo(
    () => editableAttachments(message),
    [message]
  )
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [phase, setPhase] = React.useState<EditorPhase>("editing")
  const [preview, setPreview] = React.useState<RewindPreview | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const errorId = React.useId()
  const hintId = React.useId()

  const focusText = React.useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [])

  React.useEffect(() => {
    focusText()
    // Opened from the message menu, which restores focus to its trigger as
    // it closes; take it back once that has happened.
    const frame = requestAnimationFrame(focusText)
    return () => cancelAnimationFrame(frame)
  }, [focusText])

  const keptKeys = React.useMemo(
    () =>
      new Set(
        attachments
          .map((attachment) => attachment.key)
          .filter((key) => !removed.has(key))
      ),
    [attachments, removed]
  )
  const keepsFile = attachments.some(
    (attachment) => attachment.kind === "file" && keptKeys.has(attachment.key)
  )
  const canSend = phase === "editing" && (text.trim().length > 0 || keepsFile)
  const busy = phase === "checking" || phase === "sending"

  const send = async (revertFiles: boolean, stopRunningTurn: boolean) => {
    setPhase("sending")
    setError(null)
    try {
      // Once the chat is rewound this message (and with it this editor) is
      // gone; the send finishes on its own.
      await rewindAndResend({
        threadId,
        messageId: message.id,
        text,
        keptAttachmentKeys: keptKeys,
        revertFiles,
        stopRunningTurn,
        resend: onResend,
      })
    } catch (failure) {
      setPreview(null)
      setPhase("editing")
      setError(
        failure instanceof Error
          ? failure.message
          : "The message couldn't be resent."
      )
      requestAnimationFrame(focusText)
    }
  }

  const submit = async () => {
    if (!canSend) return
    setPhase("checking")
    setError(null)
    try {
      const next = await previewRewind(threadId, message.id, workspaceRoot)
      if (next.changedFiles.length > 0 || next.running) {
        setPreview(next)
        setPhase("choosing")
        return
      }
      await send(false, false)
    } catch (failure) {
      setPhase("editing")
      setError(
        failure instanceof Error
          ? failure.message
          : "The chat couldn't be checked before resending."
      )
      requestAnimationFrame(focusText)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (!busy) onCancel()
      return
    }
    if (event.key !== "Enter") return
    const target = event.currentTarget
    const shortcut = resolveBetterC0deInputShortcut(event, {
      value: target.value,
      selectionStart: target.selectionStart ?? 0,
      selectionEnd: target.selectionEnd ?? 0,
    })
    event.preventDefault()
    if (shortcut === "newline") {
      const edit = applyBetterC0deInputShortcut(
        {
          value: target.value,
          selectionStart: target.selectionStart ?? 0,
          selectionEnd: target.selectionEnd ?? 0,
        },
        shortcut
      )
      setText(edit.value)
      requestAnimationFrame(() =>
        textareaRef.current?.setSelectionRange(
          edit.selectionStart,
          edit.selectionEnd
        )
      )
      return
    }
    void submit()
  }

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-foreground",
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30"
      )}
    >
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={busy}
        aria-label="Edit message"
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        className="max-h-[min(50vh,24rem)] min-h-12 overflow-y-auto rounded-none border-0 bg-transparent p-0 text-[length:var(--message-font-size)] focus-visible:border-0 focus-visible:ring-0 md:text-[length:var(--message-font-size)] dark:bg-transparent"
      />

      {attachments.length > 0 ? (
        <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => {
            const isRemoved = removed.has(attachment.key)
            const Icon =
              attachment.kind === "element"
                ? MousePointerClickIcon
                : PaperclipIcon
            return (
              <li
                key={attachment.key}
                className={cn(
                  "inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-foreground/[0.03] py-0.5 pr-0.5 pl-2 text-[11px]",
                  isRemoved && "text-muted-foreground"
                )}
              >
                <Icon className="size-3 shrink-0" aria-hidden="true" />
                <span
                  className={cn(
                    "min-w-0 truncate",
                    isRemoved && "line-through"
                  )}
                  title={attachment.label}
                >
                  {attachment.label}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 text-muted-foreground hover:text-foreground"
                  disabled={busy}
                  aria-label={
                    isRemoved
                      ? `Keep ${attachment.label}`
                      : `Remove ${attachment.label}`
                  }
                  onClick={() =>
                    setRemoved((current) => {
                      const next = new Set(current)
                      if (next.has(attachment.key)) next.delete(attachment.key)
                      else next.add(attachment.key)
                      return next
                    })
                  }
                >
                  {isRemoved ? (
                    <RotateCcwIcon className="size-3" />
                  ) : (
                    <XIcon className="size-3" />
                  )}
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <p id={hintId} className="text-[10.5px] text-muted-foreground">
          Sending removes the messages after this one. Enter to send ·
          Shift+Enter for a new line · Esc to cancel
          {attachments.length > 0
            ? " · Attachments you keep are sent again"
            : ""}
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={() => void submit()}
            disabled={!canSend}
            aria-busy={busy || undefined}
          >
            {busy ? (
              <Loader2Icon
                className="size-3 motion-safe:animate-spin"
                aria-hidden="true"
              />
            ) : (
              <SendHorizontalIcon className="size-3" aria-hidden="true" />
            )}
            {phase === "sending" ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <ResendChoiceDialog
        preview={phase === "choosing" || phase === "sending" ? preview : null}
        sending={phase === "sending"}
        onCancel={() => {
          setPreview(null)
          setPhase("editing")
          requestAnimationFrame(focusText)
        }}
        onChoose={(revertFiles) =>
          void send(revertFiles, preview?.running === true)
        }
      />
    </div>
  )
}

/**
 * Asked before a resend that changes more than the chat: when files changed
 * after the message ("Keep file changes" or "Revert files too", the latter
 * disabled with its reason when there is no checkpoint), or when a turn is
 * running and has to stop first.
 */
function ResendChoiceDialog({
  preview,
  sending,
  onCancel,
  onChoose,
}: {
  preview: RewindPreview | null
  sending: boolean
  onCancel: () => void
  onChoose: (revertFiles: boolean) => void
}) {
  const blockerId = React.useId()
  const files = preview?.changedFiles ?? []
  const hasFiles = files.length > 0
  const truncated = preview?.changedFilesTruncated === true
  const fileCount = `${files.length}${truncated ? "+" : ""} file${
    files.length === 1 && !truncated ? "" : "s"
  }`
  const revertAvailable = preview?.plan.fileRevert.available === true
  const blocker = fileRevertBlockerText(
    preview?.plan.fileRevert.blocker ?? null
  )
  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !sending) onCancel()
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {hasFiles ? "Files changed after this message" : "Stop and resend?"}
          </DialogTitle>
          <DialogDescription>
            Resending removes the messages after this one from the chat and from
            the agent's memory.
          </DialogDescription>
        </DialogHeader>

        {preview?.running ? (
          <p className="flex items-start gap-2 text-xs text-warning">
            <CircleStopIcon
              className="mt-px size-3.5 shrink-0"
              aria-hidden="true"
            />
            A turn is running in this chat. It is stopped first.
          </p>
        ) : null}

        {hasFiles ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-xs">
              The agent changed {fileCount} after this message:
            </p>
            <ul className="max-h-36 overflow-y-auto rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
              {files.map((file) => (
                <li key={file} className="truncate" title={file}>
                  {file}
                </li>
              ))}
              {truncated ? <li className="font-sans">and more</li> : null}
            </ul>
            {revertAvailable ? (
              <p className="text-xs text-muted-foreground">
                Revert files too restores the whole project folder to that
                point, including edits you made yourself, and deletes files
                created since. BetterC0de saves a snapshot first.
              </p>
            ) : blocker ? (
              <p
                id={blockerId}
                className="flex items-start gap-1.5 text-xs text-muted-foreground"
              >
                <InfoIcon
                  className="mt-px size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {blocker}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={sending}>
            Cancel
          </Button>
          {hasFiles ? (
            <>
              <Button
                variant="outline"
                onClick={() => onChoose(false)}
                disabled={sending}
              >
                Keep file changes
              </Button>
              <Button
                variant="destructive"
                onClick={() => onChoose(true)}
                disabled={sending || !revertAvailable}
                aria-describedby={
                  !revertAvailable && blocker ? blockerId : undefined
                }
              >
                Revert files too
              </Button>
            </>
          ) : (
            <Button onClick={() => onChoose(false)} disabled={sending}>
              Stop and resend
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
