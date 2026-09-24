const encoder = new TextEncoder()

/** A request's size as the desktop's body limit counts it: the UTF-8 bytes of its JSON. */
export function requestBytes(body: unknown): number {
  return encoder.encode(JSON.stringify(body)).length
}

/**
 * The newest part of `history` that fits into the request along with the
 * rest of `body`; the oldest entries go first. Empty when the request is too
 * large even without history, which the desktop then refuses (413).
 */
export function historyThatFits<T>(
  body: Record<string, unknown>,
  history: readonly T[],
  maxBytes: number
): T[] {
  // The entries' JSON, and a comma between each two, go into the request's
  // empty history array.
  const sizes = history.map((entry) => requestBytes(entry))
  let total =
    requestBytes({ ...body, history: [] }) +
    sizes.reduce((sum, size) => sum + size, 0) +
    Math.max(0, history.length - 1)
  let start = 0
  while (start < history.length && total > maxBytes) {
    const remaining = history.length - start
    total -= (sizes[start] ?? 0) + (remaining > 1 ? 1 : 0)
    start += 1
  }
  return history.slice(start)
}
