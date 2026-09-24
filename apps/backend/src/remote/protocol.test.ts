import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultSettings } from "@betterc0de/schema"
import {
  REMOTE_API_VERSION,
  REMOTE_FEATURES,
  REMOTE_MIN_CLIENT_VERSION,
  compareReleaseVersions,
  formatRemoteClientHeader,
  parseReleaseVersion,
  parseRemoteClientHeader,
  parseRemoteClientInfo,
  remoteClientNeedsUpdate,
  remoteProtocolSchema,
} from "@betterc0de/schema/remote-protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import { buildApp } from "../http/router"
import { openDatabase } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { readBackendVersion } from "../version"
import {
  API_BODY_LIMIT_BYTES,
  describeRemoteProtocol,
  publicRemoteProtocol,
} from "./protocol"
import { RemoteAccessService } from "./service"

describe("release versions", () => {
  it("orders prereleases before their release, numerically where numeric", () => {
    const ordered = [
      "0.1.0-alpha.1",
      "0.1.0-beta.2",
      "0.1.0-beta.10",
      "0.1.0-rc.1",
      "0.1.0",
      "0.1.1-beta.1",
      "0.2.0",
      "1.0.0",
    ]
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareReleaseVersions(ordered[index - 1]!, ordered[index]!)).toBe(
        -1
      )
      expect(compareReleaseVersions(ordered[index]!, ordered[index - 1]!)).toBe(
        1
      )
    }
    expect(compareReleaseVersions("1.2.3-beta.1+build.7", "1.2.3-beta.1")).toBe(
      0
    )
    expect(compareReleaseVersions("1.0.0-beta", "1.0.0-beta.1")).toBe(-1)
  })

  it("does not order what is not a version", () => {
    for (const value of [
      "",
      "1.2",
      "v1.2.3",
      "01.2.3",
      "1.2.3-beta.01",
      "latest",
    ]) {
      expect(parseReleaseVersion(value)).toBeNull()
      expect(compareReleaseVersions(value, "1.0.0")).toBeNull()
    }
  })
})

describe("client identification", () => {
  it("reads the header the phone app sends and round-trips it", () => {
    const client = parseRemoteClientHeader(
      "betterc0de-remote/0.1.0-beta.3 (ios)"
    )
    expect(client).toEqual({
      name: "betterc0de-remote",
      version: "0.1.0-beta.3",
      platform: "ios",
    })
    expect(formatRemoteClientHeader(client!)).toBe(
      "betterc0de-remote/0.1.0-beta.3 (ios)"
    )
    expect(parseRemoteClientHeader("betterc0de-remote/1.0.0")).toEqual({
      name: "betterc0de-remote",
      version: "1.0.0",
      platform: null,
    })
  })

  it("ignores malformed identification instead of guessing", () => {
    for (const value of [
      undefined,
      "",
      "betterc0de-remote",
      "betterc0de-remote/not-a-version (ios)",
      "Betterc0de-Remote/1.0.0",
      "betterc0de-remote/1.0.0 (iOS 18)",
    ]) {
      expect(parseRemoteClientHeader(value)).toBeNull()
    }
    expect(
      parseRemoteClientInfo({
        name: "betterc0de-remote",
        version: "1.0.0",
        platform: "android",
      })
    ).toEqual({
      name: "betterc0de-remote",
      version: "1.0.0",
      platform: "android",
    })
    expect(
      parseRemoteClientInfo({ name: "betterc0de-remote", version: 1 })
    ).toBeNull()
    expect(parseRemoteClientInfo("betterc0de-remote/1.0.0")).toBeNull()
  })

  it("asks only an identified app below the minimum to update", () => {
    const client = (version: string) => ({
      name: "betterc0de-remote",
      version,
      platform: "ios",
    })
    expect(remoteClientNeedsUpdate(null)).toBe(false)
    expect(remoteClientNeedsUpdate(client(REMOTE_MIN_CLIENT_VERSION))).toBe(
      false
    )
    expect(remoteClientNeedsUpdate(client("9.9.9"))).toBe(false)
    expect(
      remoteClientNeedsUpdate(client("0.1.0-alpha.1"), "0.1.0-beta.1")
    ).toBe(true)
    expect(remoteClientNeedsUpdate(client("0.1.0-beta.9"), "0.1.0")).toBe(true)
  })
})

describe("protocol block", () => {
  it("tells anonymous callers the version and minimum, nothing else", () => {
    expect(publicRemoteProtocol()).toEqual({
      apiVersion: REMOTE_API_VERSION,
      minClientVersion: REMOTE_MIN_CLIENT_VERSION,
    })
  })

  it("describes an authenticated session with the shared schema", () => {
    const protocol = describeRemoteProtocol({
      accessLevel: "full",
      terminalAllowed: true,
    })
    expect(protocol).toEqual({
      apiVersion: REMOTE_API_VERSION,
      minClientVersion: REMOTE_MIN_CLIENT_VERSION,
      backendVersion: readBackendVersion(),
      capabilities: {
        accessLevel: "full",
        terminalGranted: true,
        maxRequestBytes: API_BODY_LIMIT_BYTES,
        features: [
          REMOTE_FEATURES.threadsGet,
          REMOTE_FEATURES.workspaceWriteIfMatch,
          REMOTE_FEATURES.threadsRename,
          REMOTE_FEATURES.preparedTurns,
          REMOTE_FEATURES.terminal,
        ],
      },
    })
  })

  it("never grants a read-only session a terminal", () => {
    const protocol = describeRemoteProtocol({
      accessLevel: "read_only",
      terminalAllowed: true,
    })
    expect(protocol.capabilities).toMatchObject({
      accessLevel: "read_only",
      terminalGranted: false,
    })
  })

  it("lets an older app read a newer desktop's block", () => {
    const newer = remoteProtocolSchema.parse({
      apiVersion: REMOTE_API_VERSION + 1,
      minClientVersion: "0.2.0",
      backendVersion: "0.3.0",
      futureField: { anything: true },
      capabilities: {
        accessLevel: "observer",
        terminalGranted: false,
        maxRequestBytes: 4_194_304,
        features: ["threads.get", "something.new"],
        push: { available: true },
      },
    })
    // An access level the app does not know is treated as read-only.
    expect(newer.capabilities?.accessLevel).toBe("read_only")
    expect(newer.capabilities?.features).toContain("something.new")
  })
})

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const THREAD = {
  id: "thread-1",
  title: "Fix the build",
  projectName: "app",
  projectPath: "/work/app",
  createdAt: "2026-09-24T08:00:00.000Z",
  updatedAt: "2026-09-24T09:00:00.000Z",
  messages: [],
  messageCount: 4,
  session: null,
}

function fixture(options: { allowInsecureRemoteAccess?: boolean } = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-remote-protocol-")
  )
  const db = openDatabase(path.join(directory, "test.sqlite"))
  runMigrations(db)
  let values = { ...defaultSettings(), remote_access_enabled: true }
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
  }
  const remoteAccess = new RemoteAccessService(db, {
    isEnabled: () => values.remote_access_enabled,
  })
  const state = {
    config,
    db,
    settings,
    remoteAccess,
    providerRegistry: { all: () => [] },
    threads: {
      getThreadSummary: vi.fn((id: string) =>
        id === THREAD.id ? THREAD : null
      ),
    },
  } as unknown as AppState
  const app = buildApp(config, state)
  cleanups.push(async () => {
    await remoteAccess.close()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { app, settings }
}

const LAN = "http://192.168.1.20:3773"
const lanPeer = { incoming: { socket: { remoteAddress: "192.168.1.40" } } }
const publicPeer = { incoming: { socket: { remoteAddress: "198.51.100.7" } } }
const APP = "betterc0de-remote/0.1.0-beta.3 (android)"
const TOO_OLD = "betterc0de-remote/0.0.9 (ios)"

async function pairingCode(
  app: ReturnType<typeof fixture>["app"]
): Promise<string> {
  const response = await app.request("/api/v1/remote/pairing-links", {
    method: "POST",
    headers: {
      Authorization: "Bearer desktop-secret",
      "Content-Type": "application/json",
    },
    body: "{}",
  })
  return ((await response.json()) as { credential: string }).credential
}

async function pairPhone(
  app: ReturnType<typeof fixture>["app"],
  { client = APP, peer = lanPeer, origin = LAN } = {}
): Promise<Response> {
  return app.request(
    `${origin}/api/v1/remote/mobile/pair`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BetterC0de-Client": client,
      },
      body: JSON.stringify({
        credential: await pairingCode(app),
        label: "Pixel",
      }),
    },
    peer
  )
}

describe("remote protocol over HTTP", () => {
  it("tells an unpaired caller only the version and minimum", async () => {
    const { app } = fixture()
    const response = await app.request(
      `${LAN}/api/v1/remote/bootstrap`,
      {},
      lanPeer
    )
    const body = (await response.json()) as {
      authenticated: boolean
      protocol: unknown
    }
    expect(body.authenticated).toBe(false)
    expect(body.protocol).toEqual(publicRemoteProtocol())
  })

  it("describes the protocol when pairing and on every bootstrap", async () => {
    const { app, settings } = fixture()
    const paired = await pairPhone(app)
    expect(paired.status).toBe(200)
    const pairing = (await paired.json()) as {
      sessionToken: string
      session: { client: unknown }
      protocol: { capabilities: Record<string, unknown> }
    }
    expect(pairing.session.client).toEqual(parseRemoteClientHeader(APP))
    expect(pairing.protocol.capabilities).toMatchObject({
      accessLevel: "full",
      terminalGranted: false,
    })

    const bootstrap = async () => {
      const response = await app.request(
        `${LAN}/api/v1/remote/bootstrap`,
        {
          headers: {
            Authorization: `Bearer ${pairing.sessionToken}`,
            "X-BetterC0de-Client": APP,
          },
        },
        lanPeer
      )
      return (await response.json()) as {
        protocol: ReturnType<typeof describeRemoteProtocol>
      }
    }
    expect((await bootstrap()).protocol).toEqual(
      describeRemoteProtocol({ accessLevel: "full", terminalAllowed: false })
    )
    await settings.updatePublic({ remote_access_allow_terminal: true })
    expect((await bootstrap()).protocol.capabilities?.terminalGranted).toBe(
      true
    )
  })

  it("shows the desktop which app and version each paired phone runs", async () => {
    const { app } = fixture()
    const pairing = (await (await pairPhone(app)).json()) as {
      sessionToken: string
    }
    const newer = "betterc0de-remote/0.1.0-beta.4 (android)"
    await app.request(
      `${LAN}/api/v1/threads/${THREAD.id}`,
      {
        headers: {
          Authorization: `Bearer ${pairing.sessionToken}`,
          "X-BetterC0de-Client": newer,
        },
      },
      lanPeer
    )
    const sessions = await app.request("/api/v1/remote/sessions", {
      headers: { Authorization: "Bearer desktop-secret" },
    })
    const body = (await sessions.json()) as {
      sessions: Array<{ label: string; client: unknown }>
    }
    expect(body.sessions).toEqual([
      expect.objectContaining({
        label: "Pixel",
        client: parseRemoteClientHeader(newer),
      }),
    ])
  })

  it("asks a too-old app to update without spending the pairing code", async () => {
    const { app } = fixture()
    const credential = await pairingCode(app)
    const pair = (client: string) =>
      app.request(
        `${LAN}/api/v1/remote/mobile/pair`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-BetterC0de-Client": client,
          },
          body: JSON.stringify({ credential }),
        },
        lanPeer
      )
    const refused = await pair(TOO_OLD)
    expect(refused.status).toBe(426)
    expect(await refused.json()).toEqual({
      error:
        "This version of BetterC0de Remote is too old for this desktop. Update the app.",
      code: "client_update_required",
      minClientVersion: REMOTE_MIN_CLIENT_VERSION,
    })
    // The same code still pairs once the app is updated.
    expect((await pair(APP)).status).toBe(200)
  })

  it("refuses API calls from a too-old app but still lets it sign out", async () => {
    const { app } = fixture()
    const pairing = (await (await pairPhone(app)).json()) as {
      sessionToken: string
    }
    const headers = {
      Authorization: `Bearer ${pairing.sessionToken}`,
      "X-BetterC0de-Client": TOO_OLD,
    }
    const refused = await app.request(
      `${LAN}/api/v1/threads/${THREAD.id}`,
      { headers },
      lanPeer
    )
    expect(refused.status).toBe(426)
    expect(((await refused.json()) as { code: string }).code).toBe(
      "client_update_required"
    )
    const loggedOut = await app.request(
      `${LAN}/api/v1/remote/logout`,
      { method: "POST", headers },
      lanPeer
    )
    expect(loggedOut.status).toBe(200)
    expect(await loggedOut.json()).toEqual({ loggedOut: true })
    // An app without the header predates it and is still served.
    const again = (await (await pairPhone(app)).json()) as {
      sessionToken: string
    }
    const legacy = await app.request(
      `${LAN}/api/v1/threads/${THREAD.id}`,
      { headers: { Authorization: `Bearer ${again.sessionToken}` } },
      lanPeer
    )
    expect(legacy.status).toBe(200)
  })

  it("serves one thread, also to a read-only session, and says when it is missing", async () => {
    const { app } = fixture({ allowInsecureRemoteAccess: true })
    const paired = await pairPhone(app, {
      peer: publicPeer,
      origin: "http://203.0.113.20:3773",
    })
    const pairing = (await paired.json()) as {
      sessionToken: string
      protocol: { capabilities: Record<string, unknown> }
    }
    expect(pairing.protocol.capabilities).toMatchObject({
      accessLevel: "read_only",
      terminalGranted: false,
    })
    const headers = {
      Authorization: `Bearer ${pairing.sessionToken}`,
      "X-BetterC0de-Client": APP,
    }
    const thread = await app.request(
      `http://203.0.113.20:3773/api/v1/threads/${THREAD.id}`,
      { headers },
      publicPeer
    )
    expect(thread.status).toBe(200)
    expect(await thread.json()).toMatchObject({
      id: THREAD.id,
      title: THREAD.title,
      messages: [],
    })
    const missing = await app.request(
      "http://203.0.113.20:3773/api/v1/threads/nope",
      { headers },
      publicPeer
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: "thread not found",
      code: "thread_not_found",
    })
    const readOnly = await app.request(
      "http://203.0.113.20:3773/api/v1/settings",
      {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      },
      publicPeer
    )
    expect(readOnly.status).toBe(403)
    expect(((await readOnly.json()) as { code: string }).code).toBe(
      "remote_read_only"
    )
  })
})
