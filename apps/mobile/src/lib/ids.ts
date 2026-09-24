/**
 * Ids the phone makes for chats and messages. The desktop uses a message's
 * id to recognise a retry (it is the dispatch id, unique across all chats),
 * so they combine the time with enough randomness not to collide.
 */
export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
