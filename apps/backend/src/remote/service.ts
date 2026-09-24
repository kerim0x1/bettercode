import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import {
  formatRemoteClientHeader,
  type RemoteClientInfo,
} from "@betterc0de/schema/remote-protocol"
import type { Db } from "../persistence/db"
import { logger } from "../observability/logger"

const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
const PAIRING_LENGTH = 12
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
const SESSION_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** Hot-path expiry sweep cadence; the exact-time timer covers the gap. */
const EXPIRY_SWEEP_INTERVAL_MS = 30 * 1000

export const REMOTE_SESSION_COOKIE = "betterc0de_remote_session"

interface PairingGrantRow {
  pairing_id: string
  credential_hash: string
  label: string
  created_at: string
  expires_at: string
  consumed_at: string | null
  revoked_at: string | null
}

interface RemoteSessionRow {
  session_id: string
  credential_hash: string
  label: string
  access_level: RemoteAccessLevel
  created_at: string
  last_seen_at: string
  expires_at: string
  revoked_at: string | null
  client_name: string | null
  client_version: string | null
  client_platform: string | null
}

export type RemoteAccessLevel = "full" | "read_only"

export interface RemotePairingGrant {
  id: string
  credential: string
  label: string
  createdAt: string
  expiresAt: string
}

export interface RemoteAccessSession {
  id: string
  label: string
  accessLevel: RemoteAccessLevel
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  /** The app that last identified itself on this session (phone app only). */
  client?: RemoteClientInfo | null
}

export interface IssuedRemoteSession extends RemoteAccessSession {
  token: string
}

export interface RemoteAccessServiceOptions {
  isEnabled: () => boolean
  now?: () => Date
  pairingTtlMs?: number
  sessionTtlMs?: number
}

export type RemoteSessionRevocationListener = (
  sessionIds: readonly string[]
) => void | Promise<void>

function credentialHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function normalizePairingCredential(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function pairingCredential(): string {
  let raw = ""
  while (raw.length < PAIRING_LENGTH) {
    raw += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]
  }
  return raw.match(/.{1,4}/g)?.join("-") ?? raw
}

function sessionToken(): string {
  return `bc_remote_${randomBytes(32).toString("base64url")}`
}

function safeLabel(value: string | undefined, fallback: string): string {
  let sanitized = ""
  for (const character of value ?? "") {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint >= 32 && codePoint !== 127) sanitized += character
  }
  const trimmed = sanitized.trim()
  return (trimmed || fallback).slice(0, 80)
}

function toSession(row: RemoteSessionRow): RemoteAccessSession {
  return {
    id: row.session_id,
    label: row.label,
    accessLevel: row.access_level,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    client:
      row.client_name && row.client_version
        ? {
            name: row.client_name,
            version: row.client_version,
            platform: row.client_platform,
          }
        : null,
  }
}

/**
 * Persistent remote-access credentials.
 *
 * Pairing links are deliberately separate from steady-state sessions. A
 * short-lived grant can be consumed once; the resulting opaque session token
 * is returned to the browser as an HttpOnly cookie, while SQLite stores only
 * its SHA-256 digest. Revoking one device never rotates Electron's private
 * process bearer or disconnects other devices.
 */
export class RemoteAccessService {
  private readonly now: () => Date
  private readonly pairingTtlMs: number
  private readonly sessionTtlMs: number
  private readonly revocationListeners =
    new Set<RemoteSessionRevocationListener>()
  private readonly revocationSettlements = new Map<string, Promise<void>>()
  private expirationTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private lastCleanupAtMs = Number.NEGATIVE_INFINITY
  private lastExpirySweepAtMs = Number.NEGATIVE_INFINITY
  /** Last client identification written per session, so a request costs no write. */
  private readonly notedClients = new Map<string, string>()

  // Every statement is prepared once. `authenticate` runs on every remote
  // HTTP request and WebSocket revalidation tick; re-preparing SQL there was
  // measurable, and the expiry sweep it triggered was a write transaction.
  private readonly selectMetadataStmt
  private readonly insertMetadataStmt
  private readonly insertPairingGrantStmt
  private readonly selectPairingGrantByHashStmt
  private readonly consumePairingGrantStmt
  private readonly insertSessionStmt
  private readonly selectSessionByHashStmt
  private readonly touchSessionStmt
  private readonly noteClientStmt
  private readonly selectSessionLivenessStmt
  private readonly listActiveSessionsStmt
  private readonly revokeSessionStmt
  private readonly selectOtherActiveSessionsStmt
  private readonly selectAllActiveSessionsStmt
  private readonly revokeOtherSessionsStmt
  private readonly revokeAllSessionsStmt
  private readonly purgePairingGrantsStmt
  private readonly purgeSessionsStmt
  private readonly selectExpiredSessionsStmt
  private readonly expireSessionsStmt
  private readonly selectNextExpiryStmt

  constructor(
    private readonly db: Db,
    private readonly options: RemoteAccessServiceOptions
  ) {
    this.now = options.now ?? (() => new Date())
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS

    this.selectMetadataStmt = db.prepare(
      "SELECT value FROM remote_access_metadata WHERE key = ?"
    )
    this.insertMetadataStmt = db.prepare(
      "INSERT INTO remote_access_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING"
    )
    this.insertPairingGrantStmt = db.prepare(
      `INSERT INTO remote_pairing_grants
        (pairing_id, credential_hash, label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    this.selectPairingGrantByHashStmt = db.prepare(
      `SELECT pairing_id, credential_hash, label, created_at, expires_at,
              consumed_at, revoked_at
         FROM remote_pairing_grants
        WHERE credential_hash = ?`
    )
    this.consumePairingGrantStmt = db.prepare(
      `UPDATE remote_pairing_grants
          SET consumed_at = ?
        WHERE pairing_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`
    )
    this.insertSessionStmt = db.prepare(
      `INSERT INTO remote_access_sessions
        (session_id, credential_hash, label, access_level, created_at,
         last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    this.selectSessionByHashStmt = db.prepare(
      `SELECT session_id, credential_hash, label, access_level, created_at,
              last_seen_at, expires_at, revoked_at,
              client_name, client_version, client_platform
         FROM remote_access_sessions
        WHERE credential_hash = ?`
    )
    this.touchSessionStmt = db.prepare(
      `UPDATE remote_access_sessions
          SET last_seen_at = ?
        WHERE session_id = ? AND revoked_at IS NULL`
    )
    this.noteClientStmt = db.prepare(
      `UPDATE remote_access_sessions
          SET client_name = ?, client_version = ?, client_platform = ?
        WHERE session_id = ? AND revoked_at IS NULL`
    )
    this.selectSessionLivenessStmt = db.prepare(
      `SELECT expires_at, revoked_at
         FROM remote_access_sessions
        WHERE session_id = ?`
    )
    this.listActiveSessionsStmt = db.prepare(
      `SELECT session_id, credential_hash, label, access_level, created_at,
              last_seen_at, expires_at, revoked_at,
              client_name, client_version, client_platform
         FROM remote_access_sessions
        WHERE revoked_at IS NULL AND expires_at > ?
        ORDER BY last_seen_at DESC, created_at DESC`
    )
    this.revokeSessionStmt = db.prepare(
      `UPDATE remote_access_sessions
          SET revoked_at = ?
        WHERE session_id = ? AND revoked_at IS NULL`
    )
    this.selectOtherActiveSessionsStmt = db.prepare(
      `SELECT session_id
         FROM remote_access_sessions
        WHERE revoked_at IS NULL AND expires_at > ? AND session_id <> ?`
    )
    this.selectAllActiveSessionsStmt = db.prepare(
      `SELECT session_id
         FROM remote_access_sessions
        WHERE revoked_at IS NULL AND expires_at > ?`
    )
    this.revokeOtherSessionsStmt = db.prepare(
      `UPDATE remote_access_sessions
          SET revoked_at = ?
        WHERE revoked_at IS NULL AND expires_at > ? AND session_id <> ?`
    )
    this.revokeAllSessionsStmt = db.prepare(
      `UPDATE remote_access_sessions
          SET revoked_at = ?
        WHERE revoked_at IS NULL AND expires_at > ?`
    )
    this.purgePairingGrantsStmt = db.prepare(
      `DELETE FROM remote_pairing_grants
        WHERE expires_at < ? OR consumed_at < ? OR revoked_at < ?`
    )
    this.purgeSessionsStmt = db.prepare(
      `DELETE FROM remote_access_sessions
        WHERE expires_at < ? OR revoked_at < ?`
    )
    this.selectExpiredSessionsStmt = db.prepare(
      `SELECT session_id
         FROM remote_access_sessions
        WHERE revoked_at IS NULL AND expires_at <= ?`
    )
    this.expireSessionsStmt = db.prepare(
      `UPDATE remote_access_sessions
          SET revoked_at = expires_at
        WHERE revoked_at IS NULL AND expires_at <= ?`
    )
    this.selectNextExpiryStmt = db.prepare(
      `SELECT MIN(expires_at) AS expires_at
         FROM remote_access_sessions
        WHERE revoked_at IS NULL`
    )

    this.scheduleNextSessionExpiry()
  }

  enabled(): boolean {
    return this.options.isEnabled()
  }

  subscribeToSessionRevocations(
    listener: RemoteSessionRevocationListener
  ): () => void {
    this.revocationListeners.add(listener)
    return () => {
      this.revocationListeners.delete(listener)
    }
  }

  environmentId(): string {
    const existing = this.selectMetadataStmt.get("environment_id") as
      | { value: string }
      | undefined
    if (existing?.value) return existing.value

    const id = randomUUID()
    this.insertMetadataStmt.run("environment_id", id)
    const persisted = this.selectMetadataStmt.get("environment_id") as
      | { value: string }
      | undefined
    return persisted?.value ?? id
  }

  issuePairingGrant(
    input: {
      label?: string
      ttlMs?: number
    } = {}
  ): RemotePairingGrant {
    if (!this.enabled()) throw new Error("Remote access is disabled")
    this.cleanupExpired()

    const createdAt = this.now()
    const ttlMs = Math.max(
      60_000,
      Math.min(input.ttlMs ?? this.pairingTtlMs, 24 * 60 * 60 * 1000)
    )
    const expiresAt = new Date(createdAt.getTime() + ttlMs)
    const label = safeLabel(input.label, "Pairing link")

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const credential = pairingCredential()
      const id = randomUUID()
      try {
        this.insertPairingGrantStmt.run(
          id,
          credentialHash(normalizePairingCredential(credential)),
          label,
          createdAt.toISOString(),
          expiresAt.toISOString()
        )
        return {
          id,
          credential,
          label,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        }
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code !== "SQLITE_CONSTRAINT_UNIQUE") throw error
      }
    }
    throw new Error("Could not allocate a unique pairing credential")
  }

  consumePairingCredential(
    credential: string,
    input: {
      label?: string
      sessionTtlMs?: number
      accessLevel?: RemoteAccessLevel
    } = {}
  ): IssuedRemoteSession | null {
    if (!this.enabled()) return null
    const normalized = normalizePairingCredential(credential)
    if (normalized.length !== PAIRING_LENGTH) return null

    const consume = this.db.transaction(() => {
      const now = this.now()
      const row = this.selectPairingGrantByHashStmt.get(
        credentialHash(normalized)
      ) as PairingGrantRow | undefined
      if (
        !row ||
        row.consumed_at !== null ||
        row.revoked_at !== null ||
        !(Date.parse(row.expires_at) > now.getTime())
      ) {
        return null
      }

      const consumed = this.consumePairingGrantStmt.run(
        now.toISOString(),
        row.pairing_id
      )
      if (consumed.changes !== 1) return null

      const token = sessionToken()
      const sessionId = randomUUID()
      const requestedSessionTtlMs = input.sessionTtlMs ?? this.sessionTtlMs
      const sessionTtlMs = Math.max(
        60_000,
        Math.min(requestedSessionTtlMs, this.sessionTtlMs)
      )
      const expiresAt = new Date(now.getTime() + sessionTtlMs)
      const label = safeLabel(input.label, "Remote browser")
      const accessLevel = input.accessLevel ?? "full"
      this.insertSessionStmt.run(
        sessionId,
        credentialHash(token),
        label,
        accessLevel,
        now.toISOString(),
        now.toISOString(),
        expiresAt.toISOString()
      )
      return {
        id: sessionId,
        token,
        label,
        accessLevel,
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        client: null,
      }
    })

    const issued = consume()
    if (issued) this.scheduleNextSessionExpiry()
    return issued
  }

  /**
   * Hot path: one indexed read, a `last_seen_at` write at most once a
   * minute, and the expiry sweep at most every `EXPIRY_SWEEP_INTERVAL_MS`.
   * Correctness does not depend on the sweep — an expired row is refused
   * here by its own `expires_at`, and the exact-time timer still publishes
   * the revocation for connected sockets.
   */
  authenticate(token: string): RemoteAccessSession | null {
    if (!this.enabled() || !token || token.length > 256) return null
    const now = this.now()
    this.sweepExpiredIfDue(now)
    this.purgeRetiredRowsIfDue(now)
    const row = this.selectSessionByHashStmt.get(credentialHash(token)) as
      | RemoteSessionRow
      | undefined
    if (
      !row ||
      row.revoked_at !== null ||
      !(Date.parse(row.expires_at) > now.getTime())
    ) {
      return null
    }

    if (
      now.getTime() - Date.parse(row.last_seen_at) >=
      LAST_SEEN_WRITE_INTERVAL_MS
    ) {
      const nextLastSeen = now.toISOString()
      this.touchSessionStmt.run(nextLastSeen, row.session_id)
      row.last_seen_at = nextLastSeen
    }
    return toSession(row)
  }

  /**
   * Records which app (and version) uses a session, so the desktop can show
   * which paired phone needs an update. Written only when it changes.
   */
  noteClient(sessionId: string, client: RemoteClientInfo): void {
    const noted = formatRemoteClientHeader(client)
    if (this.notedClients.get(sessionId) === noted) return
    this.noteClientStmt.run(
      client.name,
      client.version,
      client.platform,
      sessionId
    )
    if (this.notedClients.size >= 1_000) this.notedClients.clear()
    this.notedClients.set(sessionId, noted)
  }

  isSessionActive(sessionId: string): boolean {
    if (!this.enabled() || !sessionId || sessionId.length > 100) return false
    const now = this.now()
    this.sweepExpiredIfDue(now)
    const row = this.selectSessionLivenessStmt.get(sessionId) as
      | Pick<RemoteSessionRow, "expires_at" | "revoked_at">
      | undefined
    return (
      row !== undefined &&
      row.revoked_at === null &&
      Date.parse(row.expires_at) > now.getTime()
    )
  }

  listSessions(): RemoteAccessSession[] {
    this.cleanupExpired()
    const now = this.now().toISOString()
    const rows = this.listActiveSessionsStmt.all(now) as RemoteSessionRow[]
    return rows.map(toSession)
  }

  revokeSession(sessionId: string): boolean {
    const result = this.revokeSessionStmt.run(
      this.now().toISOString(),
      sessionId
    )
    if (result.changes === 1) this.emitSessionRevocations([sessionId])
    this.scheduleNextSessionExpiry()
    return result.changes === 1
  }

  async revokeSessionAndWait(sessionId: string): Promise<boolean> {
    const revoked = this.revokeSession(sessionId)
    if (revoked) await this.waitForSessionRevocation(sessionId)
    return revoked
  }

  revokeOtherSessions(currentSessionId?: string): number {
    return this.revokeOtherSessionRecords(currentSessionId).count
  }

  async revokeOtherSessionsAndWait(currentSessionId?: string): Promise<number> {
    const revoked = this.revokeOtherSessionRecords(currentSessionId)
    await Promise.all(
      revoked.sessionIds.map((sessionId) =>
        this.waitForSessionRevocation(sessionId)
      )
    )
    return revoked.count
  }

  waitForSessionRevocation(sessionId: string): Promise<void> {
    return this.revocationSettlements.get(sessionId) ?? Promise.resolve()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.expirationTimer) {
      clearTimeout(this.expirationTimer)
      this.expirationTimer = null
    }
    const results = await Promise.allSettled(
      this.revocationSettlements.values()
    )
    this.revocationListeners.clear()
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Remote session cleanup did not settle before service close"
      )
    }
  }

  private revokeOtherSessionRecords(currentSessionId?: string): {
    readonly count: number
    readonly sessionIds: readonly string[]
  } {
    this.expireSessions()
    const now = this.now().toISOString()
    const sessionIds = (
      currentSessionId
        ? this.selectOtherActiveSessionsStmt.all(now, currentSessionId)
        : this.selectAllActiveSessionsStmt.all(now)
    ) as Array<{ session_id: string }>
    const result = currentSessionId
      ? this.revokeOtherSessionsStmt.run(now, now, currentSessionId)
      : this.revokeAllSessionsStmt.run(now, now)
    if (result.changes > 0) {
      this.emitSessionRevocations(sessionIds.map((row) => row.session_id))
    }
    this.scheduleNextSessionExpiry()
    return {
      count: result.changes,
      sessionIds: sessionIds.map((row) => row.session_id),
    }
  }

  private cleanupExpired(): void {
    const now = this.now()
    this.expireSessions(now)
    this.purgeRetiredRowsIfDue(now)
  }

  /** Audit-row retention: at most once per `CLEANUP_INTERVAL_MS`. */
  private purgeRetiredRowsIfDue(now: Date): void {
    if (now.getTime() - this.lastCleanupAtMs < CLEANUP_INTERVAL_MS) return
    const pairingCutoff = new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1000
    ).toISOString()
    const sessionCutoff = new Date(
      now.getTime() - SESSION_AUDIT_RETENTION_MS
    ).toISOString()
    const cleanup = this.db.transaction(() => {
      this.purgePairingGrantsStmt.run(
        pairingCutoff,
        pairingCutoff,
        pairingCutoff
      )
      this.purgeSessionsStmt.run(sessionCutoff, sessionCutoff)
    })
    cleanup()
    this.lastCleanupAtMs = now.getTime()
  }

  private sweepExpiredIfDue(now: Date): void {
    if (now.getTime() - this.lastExpirySweepAtMs < EXPIRY_SWEEP_INTERVAL_MS) {
      return
    }
    this.expireSessions(now)
  }

  private expireSessions(now = this.now()): readonly string[] {
    const timestamp = now.toISOString()
    this.lastExpirySweepAtMs = now.getTime()
    const expire = this.db.transaction(() => {
      const rows = this.selectExpiredSessionsStmt.all(timestamp) as Array<{
        session_id: string
      }>
      if (rows.length === 0) return [] as string[]
      this.expireSessionsStmt.run(timestamp)
      return rows.map((row) => row.session_id)
    })
    const sessionIds = expire()
    if (sessionIds.length > 0) this.emitSessionRevocations(sessionIds)
    this.scheduleNextSessionExpiry()
    return sessionIds
  }

  private scheduleNextSessionExpiry(): void {
    if (this.closed) return
    if (this.expirationTimer) {
      clearTimeout(this.expirationTimer)
      this.expirationTimer = null
    }
    const row = this.selectNextExpiryStmt.get() as
      | { expires_at: string | null }
      | undefined
    if (!row?.expires_at) return
    const expiresAtMs = Date.parse(row.expires_at)
    // Corrupted timestamps cannot authenticate and must not become Node's
    // 1ms NaN timer. Keep a bounded sweep so other valid sessions still expire.
    const remaining = Number.isFinite(expiresAtMs)
      ? Math.max(0, expiresAtMs - this.now().getTime())
      : EXPIRY_SWEEP_INTERVAL_MS
    this.expirationTimer = setTimeout(
      () => {
        this.expirationTimer = null
        try {
          this.expireSessions()
        } catch (error) {
          logger.error(
            { err: error },
            "remote session expiration cleanup failed"
          )
          this.scheduleNextSessionExpiry()
        }
      },
      Math.min(Math.max(1, remaining), 2_147_000_000)
    )
    this.expirationTimer.unref?.()
  }

  private emitSessionRevocations(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return
    const listenerOperations: Promise<void>[] = []
    for (const listener of this.revocationListeners) {
      try {
        listenerOperations.push(Promise.resolve(listener(sessionIds)))
      } catch (error) {
        listenerOperations.push(Promise.reject(error))
      }
    }
    const currentSettlement = Promise.allSettled(listenerOperations).then(
      (results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        )
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            `Remote cleanup failed for ${sessionIds.length} revoked session(s)`
          )
        }
      }
    )
    for (const sessionId of sessionIds) {
      const previous = this.revocationSettlements.get(sessionId)
      const settlement = previous
        ? Promise.allSettled([previous, currentSettlement]).then((results) => {
            const failures = results.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : []
            )
            if (failures.length > 0) {
              throw new AggregateError(
                failures,
                `Remote cleanup failed for session '${sessionId}'`
              )
            }
          })
        : currentSettlement
      this.revocationSettlements.set(sessionId, settlement)
      void settlement.then(
        () => {
          if (this.revocationSettlements.get(sessionId) === settlement) {
            this.revocationSettlements.delete(sessionId)
          }
        },
        (error) => {
          logger.warn(
            { err: error, sessionId },
            "remote session revocation listener failed"
          )
          if (this.revocationSettlements.get(sessionId) === settlement) {
            this.revocationSettlements.delete(sessionId)
          }
        }
      )
    }
  }
}
