import { randomUUID } from "node:crypto"

export type ShellCapabilityScope =
  | {
      readonly operation: "run"
      readonly command: string
      readonly cwd: string
    }
  | {
      readonly operation: "pty-open"
      readonly cwd: string
      readonly sessionId?: string
      readonly command?: string
    }
  | {
      readonly operation: "pty-write"
      readonly sessionId: string
      readonly data: string
    }

/**
 * Who a capability was minted for: `"local"` for the desktop host, or
 * `remote:<sessionId>` for a paired device. A token is only good for the
 * identity that requested it — a desktop-minted token replayed by a remote
 * session (or the reverse) is refused even when the operation matches, so a
 * leaked token cannot be spent by a different principal.
 */
export type ShellCapabilityIdentity = "local" | `remote:${string}`

export const LOCAL_SHELL_CAPABILITY_IDENTITY: ShellCapabilityIdentity = "local"

interface CapabilityRecord {
  readonly scope: string
  readonly identity: ShellCapabilityIdentity
  readonly expiresAt: number
}

function scopeKey(scope: ShellCapabilityScope): string {
  switch (scope.operation) {
    case "run":
      return JSON.stringify([scope.operation, scope.cwd, scope.command])
    case "pty-open":
      return JSON.stringify([
        scope.operation,
        scope.cwd,
        scope.sessionId ?? "",
        scope.command ?? "",
      ])
    case "pty-write":
      return JSON.stringify([scope.operation, scope.sessionId, scope.data])
  }
}

export class ShellCapabilityIssuer {
  private readonly capabilities = new Map<string, CapabilityRecord>()
  private readonly ttlMs: number

  constructor(options: { readonly ttlMs?: number } = {}) {
    this.ttlMs = Math.max(1, options.ttlMs ?? 10_000)
  }

  issue(
    scope: ShellCapabilityScope,
    identity: ShellCapabilityIdentity = LOCAL_SHELL_CAPABILITY_IDENTITY
  ): string {
    this.pruneExpired()
    const token = randomUUID()
    this.capabilities.set(token, {
      scope: scopeKey(scope),
      identity,
      expiresAt: Date.now() + this.ttlMs,
    })
    return token
  }

  consume(
    token: string,
    scope: ShellCapabilityScope,
    identity: ShellCapabilityIdentity = LOCAL_SHELL_CAPABILITY_IDENTITY
  ): boolean {
    const record = this.capabilities.get(token)
    if (!record) return false
    if (record.expiresAt <= Date.now()) {
      this.capabilities.delete(token)
      return false
    }
    // A mismatched identity does not burn the token: the legitimate holder
    // may still spend it, and the mismatch is refused rather than absorbed.
    if (record.identity !== identity) return false
    if (record.scope !== scopeKey(scope)) return false
    this.capabilities.delete(token)
    return true
  }

  private pruneExpired(): void {
    const now = Date.now()
    for (const [token, record] of this.capabilities) {
      if (record.expiresAt <= now) this.capabilities.delete(token)
    }
  }
}
