import { createHash, randomBytes } from "node:crypto"

/**
 * A provider plugin's turn runs in the desktop process: `/chat/persist-user`
 * with `prepareTurn` runs the user's "on message send" hooks, records the
 * message and returns the instruction, and the plugin sends the turn. When
 * the plugin fails, the desktop sends the same message through `/chat/send`
 * instead, and its hooks must not run a second time.
 *
 * persist-user therefore hands out a token after the hooks ran. It is
 * single use, lives a few minutes, and is bound to the message the hooks
 * ran for (chat, message id, text, model and provider). A `/chat/send` from
 * the desktop that presents it skips the hooks; every other send runs them
 * as always: no token, an unknown, spent or expired one, one issued for
 * another message, or one presented by a paired device. Only the hash of a
 * token is kept.
 */

/** How long the desktop has to fall back after a plugin failed to start. */
export const PREPARED_TURN_TOKEN_TTL_MS = 5 * 60_000

/** Tokens kept at most; the oldest go first. */
const MAX_PREPARED_TURN_TOKENS = 256

/** The fields of a `/chat/send` body that the hooks ran for. */
export interface PreparedTurnSubject {
  readonly thread_id: string
  readonly user_message_id: string | null
  readonly message: string
  readonly model_id: string
  readonly provider_kind: string
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

function bindingOf(subject: PreparedTurnSubject): string {
  return digest(
    JSON.stringify([
      subject.thread_id,
      subject.user_message_id,
      subject.message,
      subject.model_id,
      subject.provider_kind,
    ])
  )
}

export class PreparedTurnTokens {
  /** By the token's hash: the binding and when it expires. */
  private readonly issued = new Map<
    string,
    { readonly binding: string; readonly expiresAt: number }
  >()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = PREPARED_TURN_TOKEN_TTL_MS
  ) {}

  /**
   * A token for a message whose hooks just ran, or `null` for a message
   * without an id: there is nothing to bind the token to.
   */
  issue(subject: PreparedTurnSubject): string | null {
    if (!subject.user_message_id) return null
    this.prune()
    while (this.issued.size >= MAX_PREPARED_TURN_TOKENS) {
      const oldest = this.issued.keys().next()
      if (oldest.done) break
      this.issued.delete(oldest.value)
    }
    const token = randomBytes(32).toString("base64url")
    this.issued.set(digest(token), {
      binding: bindingOf(subject),
      expiresAt: this.now() + this.ttlMs,
    })
    return token
  }

  /**
   * Spends `token`: `true` only when it is live and was issued for this same
   * message. A token is gone after its first presentation, matching or not.
   */
  consume(
    token: string | null | undefined,
    subject: PreparedTurnSubject
  ): boolean {
    if (!token || !subject.user_message_id) return false
    const key = digest(token)
    const entry = this.issued.get(key)
    if (!entry) return false
    this.issued.delete(key)
    return entry.expiresAt > this.now() && entry.binding === bindingOf(subject)
  }

  /** Live tokens; for tests. */
  get size(): number {
    this.prune()
    return this.issued.size
  }

  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.issued) {
      if (entry.expiresAt <= now) this.issued.delete(key)
    }
  }
}

const tokensByState = new WeakMap<object, PreparedTurnTokens>()

/** The tokens of one backend (one `AppState`). */
export function preparedTurnTokensFor(state: object): PreparedTurnTokens {
  let tokens = tokensByState.get(state)
  if (!tokens) {
    tokens = new PreparedTurnTokens()
    tokensByState.set(state, tokens)
  }
  return tokens
}
