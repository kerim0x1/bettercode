import { BrandMark } from "@/components/settings/brand-mark"
import { useChatStore } from "@/lib/chat-store"
import { CONVERSATION_IMPORT_PROVIDER_NAMES } from "@/lib/conversation-import"

/**
 * The line at the top of an imported chat's transcript: which CLI it came
 * from and when, and what continuing it does. Renders nothing for other
 * chats.
 */
export function ImportedThreadNote({ threadId }: { threadId: string }) {
  const source = useChatStore(
    (state) =>
      state.threads.find((thread) => thread.id === threadId)?.importedFrom ??
      null
  )
  if (!source) return null

  const name = CONVERSATION_IMPORT_PROVIDER_NAMES[source.provider]
  const importedAt = new Date(source.importedAt)
  const date = Number.isFinite(importedAt.getTime())
    ? importedAt.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null
  const omitted = source.omittedMessages ?? 0

  return (
    <div
      role="note"
      className="mx-auto flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 px-3 text-center text-[11px] text-muted-foreground"
    >
      <BrandMark id={source.provider} />
      <span className="text-foreground/80">
        Imported from {name}
        {date ? ` on ${date}` : ""}.
      </span>
      <span>
        {source.resumable
          ? "New messages continue the original session."
          : "New messages start a new session with this conversation as context."}
      </span>
      {omitted > 0 ? (
        <span>
          {omitted === 1
            ? "1 older message was left out."
            : `${omitted} older messages were left out.`}
        </span>
      ) : null}
    </div>
  )
}
