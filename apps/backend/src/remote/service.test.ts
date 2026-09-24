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
})
