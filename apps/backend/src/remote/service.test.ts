import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openDatabase, type Db } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { RemoteAccessService } from "./service"

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function serviceFixture(
  options: { enabled?: boolean; sessionTtlMs?: number } = {}
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-remote-service-")
  )
  const db = openDatabase(path.join(directory, "test.sqlite"))
  runMigrations(db)
  let enabled = options.enabled ?? true
  let now = new Date("2026-07-21T12:00:00.000Z")
  const service = new RemoteAccessService(db, {
    isEnabled: () => enabled,
    now: () => now,
    sessionTtlMs: options.sessionTtlMs,
  })
  cleanups.push(() => {
    void service.close()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    db,
    service,
    setEnabled(value: boolean) {
      enabled = value
    },
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds)
    },
  }
}

function storedCredentialHashes(db: Db, table: string): string[] {
  return (
    db.prepare(`SELECT credential_hash FROM ${table}`).all() as Array<{
      credential_hash: string
    }>
  ).map((row) => row.credential_hash)
}

describe("RemoteAccessService", () => {
  it("exchanges a short-lived pairing code once and stores only credential hashes", () => {
    const { db, service } = serviceFixture()
    const grant = service.issuePairingGrant({ label: "My phone" })

    expect(grant.credential).toMatch(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/)
    expect(storedCredentialHashes(db, "remote_pairing_grants")).not.toContain(
      grant.credential.replaceAll("-", "")
    )

    const issued = service.consumePairingCredential(grant.credential, {
      label: "Safari on iPhone",
    })
    expect(issued).toMatchObject({ label: "Safari on iPhone" })
    expect(issued?.token).toMatch(/^bc_remote_/)
    expect(service.consumePairingCredential(grant.credential)).toBeNull()
    expect(storedCredentialHashes(db, "remote_access_sessions")).not.toContain(
      issued?.token
    )
    expect(service.authenticate(issued!.token)).toMatchObject({
      id: issued!.id,
      label: "Safari on iPhone",
    })
  })

  it("revokes one browser independently and preserves the stable environment id", () => {
    const { service } = serviceFixture()
    const environmentId = service.environmentId()
    expect(service.environmentId()).toBe(environmentId)

    const first = service.consumePairingCredential(
      service.issuePairingGrant().credential,
      { label: "Phone" }
    )!
    const second = service.consumePairingCredential(
      service.issuePairingGrant().credential,
      { label: "Tablet" }
    )!

    expect(service.listSessions()).toHaveLength(2)
    expect(service.revokeSession(first.id)).toBe(true)
    expect(service.authenticate(first.token)).toBeNull()
    expect(service.authenticate(second.token)?.id).toBe(second.id)
    expect(service.listSessions()).toEqual([
      expect.objectContaining({ id: second.id }),
    ])
  })

  it("rejects expired sessions and gates all credentials when hosting is disabled", () => {
    const { service, advance, setEnabled } = serviceFixture({
      sessionTtlMs: 60_000,
    })
    const issued = service.consumePairingCredential(
      service.issuePairingGrant().credential
    )!

    setEnabled(false)
    expect(service.authenticate(issued.token)).toBeNull()
    expect(() => service.issuePairingGrant()).toThrow(/disabled/i)

    setEnabled(true)
    advance(60_001)
    expect(service.authenticate(issued.token)).toBeNull()
  })

  it("fails closed on malformed persisted expiries without scheduling a hot loop", () => {
    const { db, service } = serviceFixture()
    const issued = service.consumePairingCredential(
      service.issuePairingGrant().credential
    )!
    const grant = service.issuePairingGrant()
    db.prepare(
      "UPDATE remote_pairing_grants SET expires_at = ? WHERE pairing_id = ?"
    ).run("not-a-date", grant.id)
    db.prepare(
      "UPDATE remote_access_sessions SET expires_at = ? WHERE session_id = ?"
    ).run("not-a-date", issued.id)
    const schedule = vi.spyOn(globalThis, "setTimeout")
    try {
      expect(service.consumePairingCredential(grant.credential)).toBeNull()
      expect(service.authenticate(issued.token)).toBeNull()
      expect(service.isSessionActive(issued.id)).toBe(false)
      service.listSessions()
      expect(schedule).toHaveBeenCalled()
      expect(
        schedule.mock.calls.every(
          ([, delay]) => Number.isFinite(delay) && delay! >= 1_000
        )
      ).toBe(true)
    } finally {
      schedule.mockRestore()
    }
  })

  it("publishes revocations and supports credential-free session revalidation", () => {
    const { service } = serviceFixture()
    const issued = service.consumePairingCredential(
      service.issuePairingGrant().credential
    )!
    const revoked: string[][] = []
    const unsubscribe = service.subscribeToSessionRevocations((sessionIds) => {
      revoked.push([...sessionIds])
    })

    expect(service.isSessionActive(issued.id)).toBe(true)
    expect(service.revokeSession(issued.id)).toBe(true)
    expect(service.isSessionActive(issued.id)).toBe(false)
    expect(revoked).toEqual([[issued.id]])

    unsubscribe()
  })

  it("awaits asynchronous owner cleanup before revocation completes", async () => {
    const { service } = serviceFixture()
    const issued = service.consumePairingCredential(
      service.issuePairingGrant().credential
    )!
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    service.subscribeToSessionRevocations(() => cleanup)

    let completed = false
    const revoking = service.revokeSessionAndWait(issued.id).then((result) => {
      completed = true
      return result
    })
    await Promise.resolve()
    expect(completed).toBe(false)

    releaseCleanup()
    await expect(revoking).resolves.toBe(true)
  })

  it("publishes expiry as a revocation before reporting the session inactive", async () => {
    const { service, advance } = serviceFixture({ sessionTtlMs: 60_000 })
    const issued = service.consumePairingCredential(
      service.issuePairingGrant().credential
    )!
    const revoked: string[][] = []
    service.subscribeToSessionRevocations((sessionIds) => {
      revoked.push([...sessionIds])
    })

    advance(60_001)
    expect(service.isSessionActive(issued.id)).toBe(false)
    await service.waitForSessionRevocation(issued.id)
    expect(revoked).toEqual([[issued.id]])
  })

  it("throttles the expiry sweep on the authentication hot path", () => {
    const { service, advance } = serviceFixture({ sessionTtlMs: 60_000 })
    const issued = service.consumePairingCredential(
      service.issuePairingGrant().credential
    )!
    const revoked: string[][] = []
    service.subscribeToSessionRevocations((sessionIds) => {
      revoked.push([...sessionIds])
    })

    // A sweep at t+59s (more than 30s after issue) finds nothing to expire.
    advance(59_000)
    expect(service.authenticate(issued.token)).not.toBeNull()

    // One second later the session is expired: authentication refuses it on
    // its own `expires_at`, but the sweep (a write transaction) is skipped
    // because the previous one ran 1s ago.
    advance(1_001)
    expect(service.authenticate(issued.token)).toBeNull()
    expect(service.isSessionActive(issued.id)).toBe(false)
    expect(revoked).toEqual([])

    // Once the interval has elapsed the next hot-path call sweeps and the
    // revocation is published.
    advance(30_000)
    expect(service.isSessionActive(issued.id)).toBe(false)
    expect(revoked).toEqual([[issued.id]])
  })

  it("persists read-only access on sessions issued for insecure transport", () => {
    const { service } = serviceFixture()
    const issued = service.consumePairingCredential(
      service.issuePairingGrant().credential,
      { accessLevel: "read_only" }
    )!

    expect(issued.accessLevel).toBe("read_only")
    expect(service.authenticate(issued.token)?.accessLevel).toBe("read_only")
    expect(service.listSessions()).toEqual([
      expect.objectContaining({
        id: issued.id,
        accessLevel: "read_only",
      }),
    ])
  })

  it("removes expired session audit rows after the retention period", () => {
    const { db, service, advance } = serviceFixture({ sessionTtlMs: 60_000 })
    service.consumePairingCredential(service.issuePairingGrant().credential)
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM remote_access_sessions")
          .get() as {
          count: number
        }
      ).count
    ).toBe(1)

    advance(31 * 24 * 60 * 60 * 1000)
    service.listSessions()

    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM remote_access_sessions")
          .get() as {
          count: number
        }
      ).count
    ).toBe(0)
  })

  it("caps pairing links at one hour", () => {
    const { service } = serviceFixture()
    const grant = service.issuePairingGrant({ ttlMs: 24 * 60 * 60 * 1000 })
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(
      60 * 60 * 1000
    )
  })

  it("lists, withdraws and bulk-revokes unredeemed pairing links without exposing codes", () => {
    const { db, service, advance } = serviceFixture()
    const redeemed = service.issuePairingGrant({ label: "Redeemed" })
    service.consumePairingCredential(redeemed.credential)
    const expiring = service.issuePairingGrant({
      label: "Expiring",
      ttlMs: 60_000,
    })
    advance(1_000)
    const first = service.issuePairingGrant({ label: "First" })
    advance(1_000)
    const second = service.issuePairingGrant({ label: "Second" })

    expect(service.listPairingGrants()).toEqual([
      {
        id: second.id,
        label: "Second",
        createdAt: second.createdAt,
        expiresAt: second.expiresAt,
      },
      {
        id: first.id,
        label: "First",
        createdAt: first.createdAt,
        expiresAt: first.expiresAt,
      },
      {
        id: expiring.id,
        label: "Expiring",
        createdAt: expiring.createdAt,
        expiresAt: expiring.expiresAt,
      },
    ])
    advance(60_000)
    expect(service.listPairingGrants().map((grant) => grant.id)).toEqual([
      second.id,
      first.id,
    ])

    expect(service.revokePairingGrant(first.id)).toBe(true)
    expect(service.revokePairingGrant(first.id)).toBe(false)
    expect(service.revokePairingGrant(redeemed.id)).toBe(false)
    expect(service.revokePairingGrant("")).toBe(false)
    expect(service.consumePairingCredential(first.credential)).toBeNull()
    expect(service.listPairingGrants().map((grant) => grant.id)).toEqual([
      second.id,
    ])

    // Bulk revocation covers the still-pending link and the expired one;
    // redeemed and already-revoked links are left as they were.
    expect(service.revokePendingPairingGrants()).toBe(2)
    expect(service.listPairingGrants()).toEqual([])
    expect(service.consumePairingCredential(second.credential)).toBeNull()
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM remote_pairing_grants WHERE revoked_at IS NULL"
          )
          .get() as { count: number }
      ).count
    ).toBe(1)
  })

  it("ends every device and pending link when hosting is turned off, for good", () => {
    const { service, setEnabled } = serviceFixture()
    const device = service.consumePairingCredential(
      service.issuePairingGrant().credential
    )!
    const shared = service.issuePairingGrant({ label: "Shared QR code" })
    const revoked: string[][] = []
    service.subscribeToSessionRevocations((sessionIds) => {
      revoked.push([...sessionIds])
    })

    setEnabled(false)
    expect(service.revokeAllAccess()).toEqual({
      sessions: 1,
      pairingGrants: 1,
    })
    expect(revoked).toEqual([[device.id]])

    // Re-enabling hosting does not revive anything issued before.
    setEnabled(true)
    expect(service.authenticate(device.token)).toBeNull()
    expect(service.consumePairingCredential(shared.credential)).toBeNull()
    expect(service.listSessions()).toEqual([])
  })

  it("retires a session left unused for a week, and counts revalidation as use", async () => {
    const { service, advance } = serviceFixture()
    const day = 24 * 60 * 60 * 1000
    const idle = service.consumePairingCredential(
      service.issuePairingGrant().credential,
      { label: "Forgotten phone" }
    )!
    const socket = service.consumePairingCredential(
      service.issuePairingGrant().credential,
      { label: "Connected phone" }
    )!
    const revoked: string[][] = []
    service.subscribeToSessionRevocations((sessionIds) => {
      revoked.push([...sessionIds])
    })

    // Six days of silence are fine, and any use restarts the clock.
    advance(6 * day)
    expect(service.authenticate(idle.token)?.id).toBe(idle.id)
    expect(service.isSessionActive(socket.id)).toBe(true)
    advance(6 * day)
    expect(service.isSessionActive(socket.id)).toBe(true)
    expect(service.authenticate(idle.token)?.id).toBe(idle.id)

    // A week without any use retires the session before its 30-day expiry,
    // and connected clients hear about it like any other revocation.
    advance(7 * day + 1)
    expect(service.authenticate(idle.token)).toBeNull()
    await service.waitForSessionRevocation(idle.id)
    expect(revoked.flat()).toContain(idle.id)
    expect(service.isSessionActive(idle.id)).toBe(false)
    expect(service.isSessionActive(socket.id)).toBe(false)
    expect(service.listSessions()).toEqual([])
  })

  it("remembers which app uses a session, writing only when it changes", () => {
    const { db, service } = serviceFixture()
    const issued = service.consumePairingCredential(
      service.issuePairingGrant().credential,
      { label: "Pixel" }
    )!
    expect(service.authenticate(issued.token)?.client).toBeNull()

    const phone = {
      name: "betterc0de-remote",
      version: "0.1.0-beta.3",
      platform: "android",
    }
    const clientColumns = () =>
      db
        .prepare(
          "SELECT client_name, client_version, client_platform FROM remote_access_sessions WHERE session_id = ?"
        )
        .get(issued.id)
    service.noteClient(issued.id, phone)
    expect(clientColumns()).toEqual({
      client_name: "betterc0de-remote",
      client_version: "0.1.0-beta.3",
      client_platform: "android",
    })
    expect(service.authenticate(issued.token)?.client).toEqual(phone)
    expect(service.listSessions()).toEqual([
      expect.objectContaining({ id: issued.id, client: phone }),
    ])

    // Every request reports the app; an unchanged report costs no write.
    db.prepare(
      "UPDATE remote_access_sessions SET client_version = 'marker' WHERE session_id = ?"
    ).run(issued.id)
    service.noteClient(issued.id, phone)
    expect(clientColumns()).toMatchObject({ client_version: "marker" })

    const updated = { ...phone, version: "0.1.0-beta.4" }
    service.noteClient(issued.id, updated)
    expect(service.listSessions()[0]?.client).toEqual(updated)

    // A revoked session keeps what it last reported.
    service.revokeSession(issued.id)
    service.noteClient(issued.id, { ...phone, version: "9.9.9" })
    expect(clientColumns()).toMatchObject({ client_version: "0.1.0-beta.4" })
  })
})
