import { providerHandoffMessageIds, type ChatMessage } from "@betterc0de/schema"

// Shared with the phone app, which hides the same messages.
export { providerHandoffMessageIds }

export const COMPACTED_CONTEXT_HEADING = "# Compacted Session Context"

export function previousVisibleUserMessage(
  messages: readonly ChatMessage[],
  beforeIndex: number
): ChatMessage | undefined {
  const hiddenIds = providerHandoffMessageIds(messages)
  for (let index = beforeIndex - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === "user" && !hiddenIds.has(message.id)) return message
  }
  return undefined
}

export interface ActiveContextSlice<T> {
  readonly messages: T[]
  readonly compactionIndex: number | null
}

export function activeContextMessages<
  T extends {
    readonly role: string
    readonly content: string
    readonly compactedContext?: boolean
  },
>(messages: ReadonlyArray<T>): ActiveContextSlice<T> {
  let compactionIndex: number | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message?.role === "assistant" &&
      (message.compactedContext === true ||
        isLegacyCompactionCheckpoint(messages, index))
    ) {
      compactionIndex = index
      break
    }
  }

  return {
    messages:
      compactionIndex === null
        ? [...messages]
        : messages.slice(compactionIndex),
    compactionIndex,
  }
}

function isLegacyCompactionCheckpoint<
  T extends { readonly role: string; readonly content: string },
>(messages: ReadonlyArray<T>, index: number): boolean {
  const message = messages[index]
  const previous = messages[index - 1]
  return Boolean(
    message?.content.startsWith(COMPACTED_CONTEXT_HEADING) &&
    previous?.role === "user" &&
    /^\/compact(?:\s|$)/iu.test(previous.content.trim())
  )
}
