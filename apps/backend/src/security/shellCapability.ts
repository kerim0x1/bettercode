import { createHash, randomUUID } from "node:crypto"

/**
 * What a shell or PTY launch runs with besides its command: the shell, the
 * PTY's argument vector and the command-scoped environment. A run or PTY
 * capability always binds all three; an absent `launch` or field means "the
 * default", so redeeming a capability with another shell, argument vector or
 * environment than it was minted for is refused.
 */
export interface ShellCapabilityLaunch {
  readonly shell?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export type ShellCapabilityScope =
  | {
      readonly operation: "run"
      readonly command: string
      readonly cwd: string
      readonly launch?: ShellCapabilityLaunch
    }
  | {
      readonly operation: "pty-open"
      readonly cwd: string
      readonly sessionId?: string
      readonly command?: string
      readonly launch?: ShellCapabilityLaunch
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

function launchKey(launch: ShellCapabilityLaunch | undefined): unknown[] {
  const env = Object.entries(launch?.env ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )
  return [
    launch?.shell?.trim() ?? "",
    launch?.args ? [...launch.args] : [],
    // A digest keeps long environment values out of the in-memory key.
    createHash("sha256").update(JSON.stringify(env)).digest("hex"),
  ]
}

function scopeKey(scope: ShellCapabilityScope): string {
  switch (scope.operation) {
    case "run":
      return JSON.stringify([
        scope.operation,
        scope.cwd,
        scope.command,
        ...launchKey(scope.launch),
      ])
    case "pty-open":
      return JSON.stringify([
        scope.operation,
        scope.cwd,
        scope.sessionId ?? "",
        scope.command ?? "",
        ...launchKey(scope.launch),
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
