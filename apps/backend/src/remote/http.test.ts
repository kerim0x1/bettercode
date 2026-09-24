import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultSettings } from "@betterc0de/schema"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import { buildApp } from "../http/router"
import { openDatabase } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { RemoteAccessService } from "./service"
import type { TailscaleRemoteAccess, TailscaleRemoteState } from "./tailscale"
import { stopAllToolOutputArchiveStores } from "../services/tool-output-archive-store"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fixture(
  options: {
    allowInsecureRemoteAccess?: boolean
    trustProxyHeaders?: boolean
    trustLoopbackProxyHeaders?: boolean
    tailscaleServe?: boolean
    tailscale?: TailscaleRemoteAccess
  } = {}
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-remote-http-")
  )
  const db = openDatabase(path.join(directory, "test.sqlite"))
  runMigrations(db)
  let values = {
    ...defaultSettings(),
    remote_access_enabled: true,
    remote_access_custom_url: "",
    remote_access_tailscale_serve: options.tailscaleServe === true,
  }
  const settings = {
    get: () => values,
    getPublic: () => values,
    updatePublic: vi.fn(async (patch: Record<string, unknown>) => {
      values = { ...values, ...patch } as typeof values
      return values
    }),
  }
  const config: ServerConfig = {
    host: "0.0.0.0",
    port: 3773,
    dataDir: directory,
    dbPath: path.join(directory, "test.sqlite"),
    settingsPath: path.join(directory, "settings.json"),
    authPath: path.join(directory, "auth.json"),
    logsDir: path.join(directory, "logs"),
    providerLogsDir: path.join(directory, "logs", "provider"),
    providerEventLogPath: path.join(
      directory,
      "logs",
      "provider",
      "events.log"
    ),
    authToken: "desktop-secret",
    allowInsecureRemoteAccess: options.allowInsecureRemoteAccess,
    trustProxyHeaders: options.trustProxyHeaders,
    trustLoopbackProxyHeaders: options.trustLoopbackProxyHeaders,
  }
  const remoteAccess = new RemoteAccessService(db, {
    isEnabled: () => values.remote_access_enabled,
  })
  const state = {
    config,
    db,
    settings,
    remoteAccess,
    tailscale: options.tailscale,
    providerRegistry: { all: () => [] },
    threads: { persistUserMessageForTurn: vi.fn() },
  } as unknown as AppState
  const app = buildApp(config, state)
  cleanups.push(async () => {
    await stopAllToolOutputArchiveStores()
    await remoteAccess.close()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { app, settings, config }
}

/** Endpoint ids minus this machine's own LAN interfaces (non-deterministic). */
function stableEndpointIds(endpoints: Array<{ id: string }>): string[] {
  return endpoints
    .map((endpoint) => endpoint.id)
    .filter((id) => !id.startsWith("network:"))
}

function desktopHeaders(): Record<string, string> {
  return {
    Authorization: "Bearer desktop-secret",
    "Content-Type": "application/json",
  }
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie")
  if (!header) throw new Error("missing session cookie")
  return header.split(";", 1)[0]!
}

describe("remote access HTTP flow", () => {
  it.each([
    "/remote/pair",
    "/remote/mobile/pair",
    "/remote/pairing-links",
    "/remote/tailscale/serve",
  ])("rejects non-object request bodies for %s", async (route) => {
    const tailscale = fakeTailscale()
    const { app, settings } = fixture({ tailscale })
    for (const body of [null, [], 42]) {
      const response = await app.request(`/api/v1${route}`, {
        method: "POST",
        headers: desktopHeaders(),
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
    }
    expect(tailscale.enableServe).not.toHaveBeenCalled()
    expect(tailscale.disableServe).not.toHaveBeenCalled()
    expect(settings.updatePublic).not.toHaveBeenCalled()
  })

  it("pairs once, authenticates the full API with a cookie, and supports revocation", async () => {
    const { app } = fixture()
    const grantResponse = await app.request("/api/v1/remote/pairing-links", {
      method: "POST",
      headers: desktopHeaders(),
      body: JSON.stringify({ label: "Test link" }),
    })
    expect(grantResponse.status).toBe(200)
    const grant = (await grantResponse.json()) as {
      credential: string
      links: Array<{ url: string; isDefault: boolean }>
    }
    expect(grant.links.some((link) => link.url.includes("#token="))).toBe(true)

    const pairResponse = await app.request("/api/v1/remote/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: grant.credential, label: "Phone" }),
    })
    expect(pairResponse.status).toBe(200)
    expect(await pairResponse.clone().json()).not.toHaveProperty("sessionToken")
    const cookie = cookieFrom(pairResponse)

    const apiResponse = await app.request("/api/v1/runtime/health", {
      headers: {
        Cookie: cookie,
        Origin: "http://127.0.0.1:3773",
        Host: "127.0.0.1:3773",
      },
    })
    expect(apiResponse.status).toBe(200)

    const replayResponse = await app.request("/api/v1/remote/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: grant.credential }),
    })
    expect(replayResponse.status).toBe(401)

    const sessionsResponse = await app.request("/api/v1/remote/sessions", {
      headers: desktopHeaders(),
    })
    const sessions = (await sessionsResponse.json()) as {
      sessions: Array<{ id: string; label: string }>
    }
    expect(sessions.sessions).toEqual([
      expect.objectContaining({ label: "Phone" }),
    ])

    const revokeResponse = await app.request(
      `/api/v1/remote/sessions/${sessions.sessions[0]!.id}`,
      { method: "DELETE", headers: desktopHeaders() }
    )
    expect(revokeResponse.status).toBe(200)
    expect(await revokeResponse.json()).toEqual({ revoked: true })

    const revokedApiResponse = await app.request("/api/v1/runtime/health", {
      headers: { Cookie: cookie },
    })
    expect(revokedApiResponse.status).toBe(401)
  })

  it("pairs a native client with a no-store bearer credential", async () => {
    const { app } = fixture()
    const grantResponse = await app.request("/api/v1/remote/pairing-links", {
      method: "POST",
      headers: desktopHeaders(),
      body: JSON.stringify({ label: "Mobile link" }),
    })
    const grant = (await grantResponse.json()) as { credential: string }

    const pairResponse = await app.request("/api/v1/remote/mobile/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: grant.credential, label: "Pixel" }),
    })
    expect(pairResponse.status).toBe(200)
    expect(pairResponse.headers.get("cache-control")).toBe("no-store")
    expect(pairResponse.headers.get("set-cookie")).toBeNull()
    const paired = (await pairResponse.json()) as {
      sessionToken: string
      tokenType: string
      session: { label: string }
    }
    expect(paired.tokenType).toBe("Bearer")
    expect(paired.sessionToken).toMatch(/^bc_remote_/)
    expect(paired.session.label).toBe("Pixel")

    const apiResponse = await app.request("/api/v1/runtime/health", {
      headers: { Authorization: `Bearer ${paired.sessionToken}` },
    })
    expect(apiResponse.status).toBe(200)

    const replayResponse = await app.request("/api/v1/remote/mobile/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: grant.credential }),
    })
    expect(replayResponse.status).toBe(401)
  })

  it("keeps access administration and listener settings owner-only", async () => {
    const { app, settings } = fixture()
    const grantResponse = await app.request("/api/v1/remote/pairing-links", {
      method: "POST",
      headers: desktopHeaders(),
      body: "{}",
    })
    const grant = (await grantResponse.json()) as { credential: string }
    const pairResponse = await app.request("/api/v1/remote/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: grant.credential }),
    })
    const cookie = cookieFrom(pairResponse)

    const createFromRemote = await app.request("/api/v1/remote/pairing-links", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    })
    expect(createFromRemote.status).toBe(403)

    const settingsFromRemote = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { remote_access_enabled: false } }),
    })
    expect(settingsFromRemote.status).toBe(403)
    expect(settings.updatePublic).not.toHaveBeenCalled()

    const ordinarySetting = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { theme: "light" } }),
    })
    expect(ordinarySetting.status).toBe(200)
  })

  it("pairs a full session over plain HTTP from a private network, and refuses a public peer", async () => {
    const { app } = fixture()
    const grantResponse = await app.request("/api/v1/remote/pairing-links", {
      method: "POST",
      headers: desktopHeaders(),
      body: "{}",
    })
    const grant = (await grantResponse.json()) as {
      credential: string
      links: Array<{ endpointId: string; url: string }>
    }
    // Loopback is always there; whatever else this machine advertises
    // without the plaintext flag must be a private-network address.
    expect(
      grant.links.some((link) => link.url.startsWith("http://127.0.0.1:3773"))
    ).toBe(true)
    for (const link of grant.links) {
      const host = new URL(link.url).hostname
      if (host === "127.0.0.1") continue
      expect(link.endpointId.startsWith("network:")).toBe(true)
      expect(host).toMatch(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/)
    }

    // A paired phone on the home Wi-Fi receives a full session.
    const lanPeer = { incoming: { socket: { remoteAddress: "192.168.1.40" } } }
    const paired = await app.request(
      "http://192.168.1.20:3773/api/v1/remote/mobile/pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: grant.credential }),
      },
      lanPeer
    )
    expect(paired.status).toBe(200)
    const session = (await paired.json()) as {
      sessionToken: string
      session: { accessLevel: string }
    }
    expect(session.session.accessLevel).toBe("full")
    const mutation = await app.request(
      "http://192.168.1.20:3773/api/v1/settings",
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ patch: { theme: "dark" } }),
      },
      lanPeer
    )
    expect(mutation.status).toBe(200)

    // A port forwarded from the router: plaintext from a public address is
    // still refused, with or without a valid code.
    const secondGrant = (await (
      await app.request("/api/v1/remote/pairing-links", {
        method: "POST",
        headers: desktopHeaders(),
        body: "{}",
      })
    ).json()) as { credential: string }
    const publicPeer = await app.request(
      "http://203.0.113.20:3773/api/v1/remote/pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: secondGrant.credential }),
      },
      { incoming: { socket: { remoteAddress: "198.51.100.7" } } }
    )
    expect(publicPeer.status).toBe(426)
    expect(await publicPeer.json()).toEqual({
      error: "secure transport required",
    })
    // No socket at all (an in-process caller asking for a LAN host name)
    // is not a private peer either.
    const noPeer = await app.request(
      "http://192.168.1.40:3773/api/v1/remote/pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: secondGrant.credential }),
      }
    )
    expect(noPeer.status).toBe(426)
  })

  it("limits explicitly enabled public plaintext sessions to short read-only monitoring", async () => {
    const { app } = fixture({ allowInsecureRemoteAccess: true })
    const grantResponse = await app.request("/api/v1/remote/pairing-links", {
      method: "POST",
      headers: desktopHeaders(),
      body: "{}",
    })
    const grant = (await grantResponse.json()) as { credential: string }
    const pairedAt = Date.now()
    const publicPeer = {
      incoming: { socket: { remoteAddress: "198.51.100.7" } },
    }
    const pairResponse = await app.request(
      "http://203.0.113.20:3773/api/v1/remote/pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: grant.credential }),
      },
      publicPeer
    )

    expect(pairResponse.status).toBe(200)
    const paired = (await pairResponse.clone().json()) as {
      session: { accessLevel: string; expiresAt: string }
    }
    expect(paired.session.accessLevel).toBe("read_only")
    // The TTL starts when the service issues the session, a few milliseconds
    // after this request-side timestamp.
    expect(Date.parse(paired.session.expiresAt) - pairedAt).toBeLessThanOrEqual(
      60 * 60 * 1000 + 1_000
    )
    const cookie = cookieFrom(pairResponse)

    const health = await app.request("/api/v1/runtime/health", {
      headers: { Cookie: cookie },
    })
    expect(health.status).toBe(200)

    const mutation = await app.request("/api/v1/settings", {
      method: "PATCH",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { theme: "dark" } }),
    })
    expect(mutation.status).toBe(403)
    expect(await mutation.json()).toEqual({
      error: "remote session is restricted to read-only monitoring",
    })

    const leakedDesktopCredential = await app.request(
      "http://203.0.113.20:3773/api/v1/runtime/health",
      { headers: desktopHeaders() },
      publicPeer
    )
    expect(leakedDesktopCredential.status).toBe(426)
  })

  it("does not infer TLS from an absolute HTTPS request target on a plaintext socket", async () => {
    const { app } = fixture()
    const response = await app.request(
      "https://remote.example/api/v1/remote/mobile/pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "AAAA-BBBB-CCCC" }),
      },
      { incoming: { socket: { remoteAddress: "203.0.113.9" } } }
    )
    expect(response.status).toBe(426)
    expect(await response.json()).toEqual({
      error: "secure transport required",
    })
  })

  it("reads the forwarded client from the hop the trusted proxy wrote, not the one the client sent", async () => {
    const loopbackPeer = {
      incoming: { socket: { remoteAddress: "127.0.0.1" } },
    }
    const pairUrl = "http://127.0.0.1:3773/api/v1/remote/pair"
    const trusted = fixture({ trustProxyHeaders: true })
    const pair = async (headers: Record<string, string>) => {
      const grant = await trusted.app.request("/api/v1/remote/pairing-links", {
        method: "POST",
        headers: desktopHeaders(),
        body: "{}",
      })
      const { credential } = (await grant.json()) as { credential: string }
      return trusted.app.request(
        pairUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ credential }),
        },
        loopbackPeer
      )
    }

    // A public client prepended a LAN address to the chain; the proxy
    // appended the peer it really accepted. The proxy's entry is the
    // rightmost one and wins, so this is still a public plaintext peer.
    const spoofed = await pair({
      "X-Forwarded-For": "192.168.1.40, 203.0.113.9",
    })
    expect(spoofed.status).toBe(426)

    // `X-Real-IP` is client-controlled even behind a trusted proxy.
    const realIp = await pair({
      "X-Forwarded-For": "203.0.113.9",
      "X-Real-IP": "192.168.1.40",
    })
    expect(realIp.status).toBe(426)

    // Only the protocol appended by the trusted hop is authoritative, too.
    const forgedProtocol = await pair({
      "X-Forwarded-For": "203.0.113.9",
      "X-Forwarded-Proto": "https, http",
    })
    expect(forgedProtocol.status).toBe(426)
    const secureProtocol = await pair({
      "X-Forwarded-For": "203.0.113.9",
      "X-Forwarded-Proto": "http, https",
    })
    expect(secureProtocol.status).toBe(200)

    // A LAN client the proxy really saw keeps the private-network policy.
    const lan = await pair({ "X-Forwarded-For": "203.0.113.9, 192.168.1.40" })
    expect(lan.status).toBe(200)
    expect(
      ((await lan.json()) as { session: { accessLevel: string } }).session
        .accessLevel
    ).toBe("full")
  })

  it("classifies a request behind a same-host reverse proxy by the forwarded client", async () => {
    // The proxy terminates TLS on this machine, so every request reaches the
    // backend from 127.0.0.1 over plaintext with a loopback Host header.
    const loopbackPeer = {
      incoming: { socket: { remoteAddress: "127.0.0.1" } },
    }
    const pairUrl = "http://127.0.0.1:3773/api/v1/remote/pair"
    const issueGrant = async (app: ReturnType<typeof fixture>["app"]) => {
      const response = await app.request("/api/v1/remote/pairing-links", {
        method: "POST",
        headers: desktopHeaders(),
        body: "{}",
      })
      return ((await response.json()) as { credential: string }).credential
    }

    // Trusted proxy, forwarded client is not loopback: plaintext pairing is
    // refused by default, exactly as it would be for a direct remote peer.
    const trusted = fixture({ trustProxyHeaders: true })
    const refused = await trusted.app.request(
      pairUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.9",
        },
        body: JSON.stringify({ credential: await issueGrant(trusted.app) }),
      },
      loopbackPeer
    )
    expect(refused.status).toBe(426)

    // ...and when plaintext is explicitly allowed the session is downgraded
    // to short read-only monitoring, never issued as a full one.
    const trustedPlaintext = fixture({
      trustProxyHeaders: true,
      allowInsecureRemoteAccess: true,
    })
    const downgraded = await trustedPlaintext.app.request(
      pairUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.9",
        },
        body: JSON.stringify({
          credential: await issueGrant(trustedPlaintext.app),
        }),
      },
      loopbackPeer
    )
    expect(downgraded.status).toBe(200)
    expect(
      ((await downgraded.json()) as { session: { accessLevel: string } })
        .session.accessLevel
    ).toBe("read_only")

    // Proxy not trusted: the header is attacker-controlled and ignored, so
    // the loopback TCP peer stays loopback and pairs a full session.
    const untrusted = fixture()
    const ignored = await untrusted.app.request(
      pairUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.9",
        },
        body: JSON.stringify({ credential: await issueGrant(untrusted.app) }),
      },
      loopbackPeer
    )
    expect(ignored.status).toBe(200)
    expect(
      ((await ignored.json()) as { session: { accessLevel: string } }).session
        .accessLevel
    ).toBe("full")

    // A remote TCP peer never becomes loopback by sending `Host: localhost`.
    const hostOnly = fixture()
    const spoofedHost = await hostOnly.app.request(
      "http://localhost:3773/api/v1/remote/pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: await issueGrant(hostOnly.app) }),
      },
      { incoming: { socket: { remoteAddress: "203.0.113.9" } } }
    )
    expect(spoofedHost.status).toBe(426)
  })

  it("does not let spoofed forwarding headers bypass the pairing limiter", async () => {
    const { app } = fixture()
    const statuses: number[] = []
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await app.request("/api/v1/remote/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": `203.0.113.${attempt + 1}`,
        },
        body: JSON.stringify({ credential: "AAAA-BBBB-CCCC" }),
      })
      statuses.push(response.status)
    }

    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401))
    expect(statuses[8]).toBe(429)
  })

  it("applies the dedicated small body limit to public pairing", async () => {
    const { app } = fixture()
    const response = await app.request("/api/v1/remote/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "x", padding: "x".repeat(17 * 1024) }),
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "request body too large" })
  })

  it("does not accept a cookie from a different loopback origin port", async () => {
    const { app } = fixture()
    const grantResponse = await app.request("/api/v1/remote/pairing-links", {
      method: "POST",
      headers: desktopHeaders(),
      body: "{}",
    })
    const grant = (await grantResponse.json()) as { credential: string }
    const pairResponse = await app.request("/api/v1/remote/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: grant.credential }),
    })
    const cookie = cookieFrom(pairResponse)

    const response = await app.request(
      "http://127.0.0.1:3773/api/v1/runtime/health",
      {
        headers: {
          Cookie: cookie,
          Origin: "http://127.0.0.1:5173",
        },
      }
    )
    expect(response.status).toBe(403)
  })
})

function fakeTailscale(
  overrides: Partial<TailscaleRemoteState> = {}
): TailscaleRemoteAccess & {
  describe: ReturnType<typeof vi.fn>
  enableServe: ReturnType<typeof vi.fn>
  disableServe: ReturnType<typeof vi.fn>
} {
  const described: TailscaleRemoteState = {
    installed: true,
    state: "running",
    magicDnsName: "desk.tail1234.ts.net",
    tailnetIpv4Addresses: ["100.88.45.82"],
    selfAddresses: ["100.88.45.82", "fd7a:115c:a1e0::be3b:2d52"],
    httpsCertificates: true,
    serveEnabled: true,
    serveActive: true,
    servePort: 443,
    httpsBaseUrl: "https://desk.tail1234.ts.net",
    ...overrides,
  }
  return {
    status: vi.fn().mockResolvedValue(described),
    selfAddresses: () =>
      new Set(described.state === "running" ? described.selfAddresses : []),
    describe: vi.fn().mockResolvedValue(described),
    enableServe: vi.fn().mockResolvedValue(undefined),
    disableServe: vi.fn().mockResolvedValue(undefined),
  }
}

describe("remote access through Tailscale Serve", () => {
  const tailscaleProxyPeer = {
    incoming: { socket: { remoteAddress: "127.0.0.1" } },
  }
  const tailscaleHeaders = {
    "Content-Type": "application/json",
    // What `tailscale serve` adds when it proxies an HTTPS request from a
    // tailnet device to the loopback backend.
    "X-Forwarded-For": "100.101.102.103",
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "desk.tail1234.ts.net",
  }
  const pairUrl = "http://desk.tail1234.ts.net/api/v1/remote/mobile/pair"
  const issueGrant = async (app: ReturnType<typeof fixture>["app"]) => {
    const response = await app.request("/api/v1/remote/pairing-links", {
      method: "POST",
      headers: desktopHeaders(),
      body: "{}",
    })
    return ((await response.json()) as { credential: string }).credential
  }

  it("pairs a full session for a tailnet device while serve is enabled", async () => {
    const { app } = fixture({ trustLoopbackProxyHeaders: true })
    const pairResponse = await app.request(
      pairUrl,
      {
        method: "POST",
        headers: tailscaleHeaders,
        body: JSON.stringify({ credential: await issueGrant(app) }),
      },
      tailscaleProxyPeer
    )
    expect(pairResponse.status).toBe(200)
    const paired = (await pairResponse.json()) as {
      sessionToken: string
      session: { accessLevel: string }
    }
    expect(paired.session.accessLevel).toBe("full")

    // The paired phone keeps its full session on ordinary API calls, and is
    // still a remote client, never the desktop owner.
    const settingsPatch = await app.request(
      "http://desk.tail1234.ts.net/api/v1/settings",
      {
        method: "PATCH",
        headers: {
          ...tailscaleHeaders,
          Authorization: `Bearer ${paired.sessionToken}`,
        },
        body: JSON.stringify({ patch: { theme: "dark" } }),
      },
      tailscaleProxyPeer
    )
    expect(settingsPatch.status).toBe(200)
    const ownerOnly = await app.request(
      "http://desk.tail1234.ts.net/api/v1/remote/pairing-links",
      {
        method: "POST",
        headers: {
          ...tailscaleHeaders,
          Authorization: `Bearer ${paired.sessionToken}`,
        },
        body: "{}",
      },
      tailscaleProxyPeer
    )
    expect(ownerOnly.status).toBe(403)
  })

  it("ignores the same forwarded headers while serve is off", async () => {
    // Without the setting the headers are attacker-controlled: the request
    // is judged as a loopback peer asking for a non-loopback host, which is
    // plaintext off loopback and therefore refused.
    const { app } = fixture()
    const response = await app.request(
      pairUrl,
      {
        method: "POST",
        headers: tailscaleHeaders,
        body: JSON.stringify({ credential: await issueGrant(app) }),
      },
      tailscaleProxyPeer
    )
    expect(response.status).toBe(426)
  })

  it("never lets a remote TCP peer claim the proxy headers", async () => {
    const { app } = fixture({ trustLoopbackProxyHeaders: true })
    // A public peer forging the same headers: the forwarded proto is ignored
    // and plaintext from a public address stays refused.
    const response = await app.request(
      pairUrl,
      {
        method: "POST",
        headers: tailscaleHeaders,
        body: JSON.stringify({ credential: await issueGrant(app) }),
      },
      { incoming: { socket: { remoteAddress: "198.51.100.7" } } }
    )
    expect(response.status).toBe(426)
  })

  it("advertises the tailnet HTTPS endpoint only with a live serve mapping", async () => {
    const served = fixture({ tailscaleServe: true, tailscale: fakeTailscale() })
    const status = (await (
      await served.app.request("/api/v1/remote/status", {
        headers: desktopHeaders(),
      })
    ).json()) as {
      endpoints: Array<{ id: string; httpBaseUrl: string; isDefault: boolean }>
    }
    expect(stableEndpointIds(status.endpoints)).toEqual([
      "tailscale-ip",
      "tailscale",
      "loopback",
    ])
    expect(
      status.endpoints.find((endpoint) => endpoint.id === "tailscale")
    ).toMatchObject({
      httpBaseUrl: "https://desk.tail1234.ts.net",
      isDefault: false,
    })
    const grant = (await (
      await served.app.request("/api/v1/remote/pairing-links", {
        method: "POST",
        headers: desktopHeaders(),
        body: "{}",
      })
    ).json()) as { links: Array<{ endpointId: string; url: string }> }
    const httpsLink = grant.links.find(
      (link) => link.endpointId === "tailscale"
    )
    expect(httpsLink?.url).toMatch(
      /^https:\/\/desk\.tail1234\.ts\.net\/#token=/
    )

    // Setting on, but Tailscale reports no mapping: no dead link.
    const inactive = fixture({
      tailscaleServe: true,
      tailscale: fakeTailscale({ serveActive: false }),
    })
    const inactiveStatus = (await (
      await inactive.app.request("/api/v1/remote/status", {
        headers: desktopHeaders(),
      })
    ).json()) as { endpoints: Array<{ id: string }> }
    expect(stableEndpointIds(inactiveStatus.endpoints)).toEqual([
      "tailscale-ip",
      "loopback",
    ])

    // Setting off: Tailscale is not even consulted.
    const idle = fakeTailscale()
    const off = fixture({ tailscale: idle })
    await off.app.request("/api/v1/remote/status", {
      headers: desktopHeaders(),
    })
    expect(idle.describe).not.toHaveBeenCalled()
  })

  it("lets only the desktop owner flip serve, and persists after the CLI accepted", async () => {
    const tailscale = fakeTailscale({ serveEnabled: false, serveActive: false })
    const { app, settings, config } = fixture({ tailscale })

    const enable = await app.request("/api/v1/remote/tailscale/serve", {
      method: "POST",
      headers: desktopHeaders(),
      body: JSON.stringify({ enabled: true }),
    })
    expect(enable.status).toBe(200)
    expect(tailscale.enableServe).toHaveBeenCalledWith(config.port)
    expect(settings.get().remote_access_tailscale_serve).toBe(true)

    // A refusing CLI leaves the setting untouched.
    tailscale.disableServe.mockRejectedValueOnce(new Error("Tailscale refused"))
    const failed = await app.request("/api/v1/remote/tailscale/serve", {
      method: "POST",
      headers: desktopHeaders(),
      body: JSON.stringify({ enabled: false }),
    })
    expect(failed.status).toBe(502)
    expect(settings.get().remote_access_tailscale_serve).toBe(true)

    // A paired device can read the resulting endpoint but not the switch.
    const grant = (await (
      await app.request("/api/v1/remote/pairing-links", {
        method: "POST",
        headers: desktopHeaders(),
        body: "{}",
      })
    ).json()) as { credential: string }
    const paired = (await (
      await app.request("/api/v1/remote/mobile/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: grant.credential }),
      })
    ).json()) as { sessionToken: string }
    const remoteHeaders = {
      Authorization: `Bearer ${paired.sessionToken}`,
      "Content-Type": "application/json",
    }
    expect(
      (
        await app.request("/api/v1/remote/tailscale", {
          headers: remoteHeaders,
        })
      ).status
    ).toBe(403)
    expect(
      (
        await app.request("/api/v1/remote/tailscale/serve", {
          method: "POST",
          headers: remoteHeaders,
          body: JSON.stringify({ enabled: false }),
        })
      ).status
    ).toBe(403)
    expect(
      (
        await app.request("/api/v1/settings", {
          method: "PATCH",
          headers: remoteHeaders,
          body: JSON.stringify({
            patch: { remote_access_tailscale_serve: false },
          }),
        })
      ).status
    ).toBe(403)
    expect(settings.get().remote_access_tailscale_serve).toBe(true)
  })
})

describe("remote access over the tailnet address", () => {
  // The phone's tailnet address connecting to this machine's tailnet address:
  // what the WireGuard interface delivers.
  const tailnetPeer = {
    incoming: {
      socket: { remoteAddress: "100.70.55.96", localAddress: "100.88.45.82" },
    },
  }
  const pairUrl = "http://100.88.45.82:3773/api/v1/remote/mobile/pair"
  const issueGrant = async (app: ReturnType<typeof fixture>["app"]) => {
    const response = await app.request("/api/v1/remote/pairing-links", {
      method: "POST",
      headers: desktopHeaders(),
      body: "{}",
    })
    return ((await response.json()) as { credential: string }).credential
  }
  const withTailnet = (overrides: Partial<TailscaleRemoteState> = {}) => {
    const tailscale = fakeTailscale({
      serveEnabled: false,
      serveActive: false,
      ...overrides,
    })
    const fx = fixture({ tailscale })
    fx.config.tailnetSelfAddresses = () => tailscale.selfAddresses()
    return fx
  }

  it("pairs a full session over plain HTTP inside the tunnel", async () => {
    const { app } = withTailnet()
    const pairResponse = await app.request(
      pairUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: await issueGrant(app) }),
      },
      tailnetPeer
    )
    expect(pairResponse.status).toBe(200)
    const paired = (await pairResponse.json()) as {
      sessionToken: string
      session: { accessLevel: string; expiresAt: string }
    }
    expect(paired.session.accessLevel).toBe("full")
    expect(Date.parse(paired.session.expiresAt) - Date.now()).toBeGreaterThan(
      20 * 24 * 60 * 60 * 1000
    )

    // Not read-only: the phone can operate the host through the tunnel.
    const mutation = await app.request(
      "http://100.88.45.82:3773/api/v1/settings",
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${paired.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ patch: { theme: "dark" } }),
      },
      tailnetPeer
    )
    expect(mutation.status).toBe(200)

    // A browser on the tailnet gets a cookie that is not marked Secure —
    // there is no TLS on this hop, and a Secure cookie would never be sent.
    const browserPair = await app.request(
      "http://100.88.45.82:3773/api/v1/remote/pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: await issueGrant(app) }),
      },
      tailnetPeer
    )
    expect(browserPair.status).toBe(200)
    expect(browserPair.headers.get("set-cookie") ?? "").not.toMatch(
      /;\s*Secure/i
    )
  })

  it("refuses the same peer when the packets did not arrive on our tailnet address", async () => {
    const { app } = withTailnet()
    // A CGNAT-looking peer hitting the LAN interface: not the tunnel.
    const viaLan = await app.request(
      "http://192.168.1.20:3773/api/v1/remote/mobile/pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: await issueGrant(app) }),
      },
      {
        incoming: {
          socket: {
            remoteAddress: "100.70.55.96",
            localAddress: "192.168.1.20",
          },
        },
      }
    )
    expect(viaLan.status).toBe(426)

    // Both sides in 100.64/10, but the local one is not an address Tailscale
    // gave this machine (an ISP CGNAT interface): still not the tunnel.
    const viaIspCgnat = await app.request(
      "http://100.64.9.9:3773/api/v1/remote/mobile/pair",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: await issueGrant(app) }),
      },
      {
        incoming: {
          socket: { remoteAddress: "100.70.55.96", localAddress: "100.64.9.9" },
        },
      }
    )
    expect(viaIspCgnat.status).toBe(426)

    // A LAN peer is not the tunnel, but it is private transport in its own
    // right, so it still pairs — through the LAN rule, not the tailnet one.
    const lanPeer = await app.request(
      pairUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: await issueGrant(app) }),
      },
      {
        incoming: {
          socket: {
            remoteAddress: "192.168.1.40",
            localAddress: "100.88.45.82",
          },
        },
      }
    )
    expect(lanPeer.status).toBe(200)
  })

  it("is not tailnet transport while Tailscale is not running", async () => {
    const stopped = withTailnet({ state: "stopped" })
    const response = await stopped.app.request(
      pairUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: await issueGrant(stopped.app) }),
      },
      tailnetPeer
    )
    expect(response.status).toBe(426)

    const noTailscale = fixture()
    const unknown = await noTailscale.app.request(
      pairUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: await issueGrant(noTailscale.app) }),
      },
      tailnetPeer
    )
    expect(unknown.status).toBe(426)
  })

  it("advertises the tailnet address as the recommended plain-HTTP endpoint", async () => {
    const { app } = withTailnet()
    const status = (await (
      await app.request("/api/v1/remote/status", { headers: desktopHeaders() })
    ).json()) as {
      endpoints: Array<{
        id: string
        httpBaseUrl: string
        isDefault: boolean
        reachability: string
      }>
    }
    expect(stableEndpointIds(status.endpoints)).toEqual([
      "tailscale-ip",
      "loopback",
    ])
    expect(status.endpoints[0]).toMatchObject({
      id: "tailscale-ip",
      httpBaseUrl: "http://100.88.45.82:3773",
      reachability: "private-network",
      isDefault: true,
    })
    const grant = (await (
      await app.request("/api/v1/remote/pairing-links", {
        method: "POST",
        headers: desktopHeaders(),
        body: "{}",
      })
    ).json()) as {
      links: Array<{ endpointId: string; url: string; isDefault: boolean }>
    }
    expect(grant.links[0]).toMatchObject({
      endpointId: "tailscale-ip",
      isDefault: true,
    })
    expect(grant.links[0]?.url).toMatch(
      /^http:\/\/100\.88\.45\.82:3773\/#token=/
    )

    // Serve on top: both tailnet links, the IP stays the default.
    const both = withTailnet({ serveEnabled: true, serveActive: true })
    await both.settings.updatePublic({ remote_access_tailscale_serve: true })
    const served = (await (
      await both.app.request("/api/v1/remote/status", {
        headers: desktopHeaders(),
      })
    ).json()) as { endpoints: Array<{ id: string; isDefault: boolean }> }
    expect(stableEndpointIds(served.endpoints)).toEqual([
      "tailscale-ip",
      "tailscale",
      "loopback",
    ])
    expect(served.endpoints.find((endpoint) => endpoint.isDefault)?.id).toBe(
      "tailscale-ip"
    )
  })
})
