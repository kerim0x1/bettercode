import { ListOrderedIcon, PlayIcon, XIcon } from "lucide-react"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import { handleError } from "@/lib/errors/handle"

export function QueuedMessages({ threadId }: { threadId: string | null }) {
  const all = useMessageQueueStore((state) => state.messages)
  const messages = all.filter((message) => message.threadId === threadId)
  if (!threadId || messages.length === 0) return null
  const paused = messages.some(
    (message) => message.status === "paused" || message.status === "failed"
  )
  const act = (action: () => void) => {
    try {
      action()
    } catch (error) {
      handleError(error, { source: "message-queue" })
    }
  }
  return (
    <section
      aria-label="Queued messages"
      className="mb-2 rounded-xl border border-border/50 bg-sidebar px-3 py-2 text-xs"
    >
      <div className="mb-1.5 flex items-center gap-2 text-muted-foreground">
        <ListOrderedIcon className="size-3.5" />
        <span>
          {messages.length} queued ·{" "}
          {paused ? "Paused" : "Send after the current turn"}
        </span>
        {paused && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 text-foreground hover:bg-accent"
            onClick={() =>
              act(() => useMessageQueueStore.getState().resume(threadId))
            }
          >
            <PlayIcon className="size-3" /> Resume
          </button>
        )}
      </div>
      <ol className="max-h-36 space-y-1 overflow-y-auto">
        {messages.map((message, index) => (
          <li key={message.id} className="flex items-start gap-2 rounded py-1">
            <span className="pt-0.5 text-muted-foreground">{index + 1}.</span>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 break-words whitespace-pre-wrap">
                {message.payload.visibleText ?? message.payload.text}
              </p>
              {message.payload.files.length > 0 && (
                <p className="text-muted-foreground">
                  {message.payload.files.length} attachment(s)
                </p>
              )}
              {message.payload.browserElements.length > 0 && (
                <p className="text-muted-foreground">
                  {message.payload.browserElements.length} tagged element(s)
                </p>
              )}
              {message.error && (
                <p className="mt-0.5 text-muted-foreground">{message.error}</p>
              )}
            </div>
            <button
              type="button"
              aria-label={`Remove queued message ${index + 1}`}
              disabled={message.status === "sending"}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              onClick={() =>
                act(() => useMessageQueueStore.getState().remove(message.id))
              }
            >
              <XIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
