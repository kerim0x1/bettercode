import { beforeEach, expect, it, vi } from "vitest"
import {
  clearStoredProfile,
  readStoredProfile,
  storeProfile,
} from "@/lib/secure-session"
import {
  createLiveTransport,
  pairMobile,
  RemoteApiError,
} from "@/transport/live"
import type { RemoteApi, RemoteTransport } from "@/transport/types"
import type {
  ConnectionProfile,
  RemoteBootstrap,
  RemotePairResponse,
} from "@/types/remote"
import {
  DEMO_PROFILE,
  selectAccessLevel,
  useSessionStore,
} from "./session-store"

vi.mock("@/lib/app-info", () => ({
  APP_VERSION: "0.1.0-beta.3",
  CLIENT_INFO: {
    name: "betterc0de-remote",
    version: "0.1.0-beta.3",
    platform: "ios",
  },
  defaultDeviceLabel: () => "iPad Pro · BetterC0de",
}))
vi.mock("@/lib/secure-session", () => ({
  clearStoredProfile: vi.fn(),
  storeProfile: vi.fn(),
  readStoredProfile: vi.fn(),
}))
vi.mock("@/transport/live", async (original) => ({
  ...(await original<typeof import("@/transport/live")>()),
  createLiveTransport: vi.fn(),
  pairMobile: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function profile(host: string): ConnectionProfile {
  return {
    baseUrl: `https://${host}.test`,
    environmentId: host,
    sessionToken: `${host}-token`,
    pairedAt: "2026-09-19T00:00:00.000Z",
    session: {
      id: `${host}-session`,
      label: host,
      createdAt: "2026-09-19T00:00:00.000Z",
      lastSeenAt: "2026-09-19T00:00:00.000Z",
      expiresAt: "2027-09-19T00:00:00.000Z",
    },
  }
}

const PROTOCOL = {
  apiVersion: 2,
  minClientVersion: "0.1.0-beta.1",
  capabilities: {
    accessLevel: "full" as const,
    terminalGranted: false,
    maxRequestBytes: 2_097_152,
    features: [],
  },
}

function bootstrap(
  p: ConnectionProfile,
  overrides: Partial<RemoteBootstrap> = {}
): RemoteBootstrap {
  return {
    enabled: true,
    authenticated: true,
    authentication: "remote",
    environmentId: p.environmentId,
    session: p.session,
    protocol: PROTOCOL,
    ...overrides,
  }
}

function api(
  check: Promise<RemoteBootstrap>,
  logout = Promise.resolve({ loggedOut: true })
) {
  return {
    bootstrap: vi.fn(() => check),
    logout: vi.fn(() => logout),
  } as unknown as RemoteApi & {
    bootstrap: ReturnType<typeof vi.fn>
    logout: ReturnType<typeof vi.fn>
  }
}

/** A paired session already in memory, talking to `remote`. */
function connect(p: ConnectionProfile, remote: RemoteApi) {
  const transport: RemoteTransport = {
    kind: "live",
    api: remote,
    createChannel: vi.fn(),
  }
  useSessionStore.setState({
    mode: "live",
    profile: p,
    transport,
    state: "online",
  })
  return transport
}

async function pair(host: string, overrides: Partial<RemotePairResponse> = {}) {
  const p = profile(host)
  vi.mocked(createLiveTransport).mockReturnValue({
    kind: "live",
    api: api(Promise.resolve(bootstrap(p))),
    createChannel: vi.fn(),
  })
  vi.mocked(pairMobile).mockResolvedValue({
    enabled: true,
    authenticated: true,
    authentication: "remote",
    tokenType: "Bearer",
    environmentId: host,
    sessionToken: p.sessionToken,
    session: p.session,
    protocol: PROTOCOL,
    ...overrides,
  })
  return useSessionStore.getState().pair("ABCD-EFGH", p.baseUrl)
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(clearStoredProfile).mockResolvedValue()
  vi.mocked(storeProfile).mockResolvedValue()
  await useSessionStore.getState().forget()
  useSessionStore.setState({ notice: null })
  vi.clearAllMocks()
})

it("pairs with the app's identity and a device label", async () => {
  const paired = await pair("desk")
  expect(pairMobile).toHaveBeenCalledWith(
    "https://desk.test",
    "ABCD-EFGH",
    "iPad Pro · BetterC0de",
    { name: "betterc0de-remote", version: "0.1.0-beta.3", platform: "ios" }
  )
  expect(useSessionStore.getState()).toMatchObject({
    mode: "live",
    profile: paired,
    protocol: PROTOCOL,
    compatibility: { kind: "ok" },
    state: "online",
  })
  expect(storeProfile).toHaveBeenCalledWith(paired)
})

it("keeps the same profile when only the last-seen time moved", async () => {
  const p = profile("desk")
  const remote = api(
    Promise.resolve(
      bootstrap(p, {
        session: { ...p.session, lastSeenAt: "2026-09-19T00:01:00.000Z" },
      })
    )
  )
  connect(p, remote)
  expect(await useSessionStore.getState().check()).toBe(true)
  // Same object: screens keyed on the profile do not reload every minute.
  expect(useSessionStore.getState().profile).toBe(p)
  expect(storeProfile).not.toHaveBeenCalled()
})

it("stores a session whose expiry or access changed", async () => {
  const p = profile("desk")
  const next = {
    ...p.session,
    expiresAt: "2027-10-19T00:00:00.000Z",
    accessLevel: "read_only" as const,
  }
  connect(p, api(Promise.resolve(bootstrap(p, { session: next }))))
  await useSessionStore.getState().check()
  expect(useSessionStore.getState().profile?.session).toEqual(next)
  expect(storeProfile).toHaveBeenCalledWith({ ...p, session: next })
})

it("keeps the pairing while Remote Access is off and explains a later sign-out", async () => {
  const p = profile("desk")
  const remote = api(
    Promise.resolve(
      bootstrap(p, {
        enabled: false,
        authenticated: false,
        authentication: null,
        session: null,
      })
    )
  )
  connect(p, remote)
  expect(await useSessionStore.getState().check()).toBe(false)
  expect(useSessionStore.getState()).toMatchObject({
    state: "remote_disabled",
    profile: p,
  })
  expect(clearStoredProfile).not.toHaveBeenCalled()

  // Turned on again, the desktop no longer knows this session.
  remote.bootstrap.mockResolvedValueOnce(
    bootstrap(p, { authenticated: false, authentication: null, session: null })
  )
  expect(await useSessionStore.getState().check()).toBe(false)
  expect(useSessionStore.getState()).toMatchObject({
    state: "unpaired",
    profile: null,
    notice: { kind: "session_ended" },
  })
  expect(clearStoredProfile).toHaveBeenCalledOnce()
})

it("unpairs from an address that now belongs to a different desktop", async () => {
  const p = profile("desk")
  connect(p, api(Promise.resolve(bootstrap(p, { environmentId: "another" }))))
  await useSessionStore.getState().check()
  expect(useSessionStore.getState()).toMatchObject({
    profile: null,
    notice: { kind: "different_desktop" },
  })
})

it("stays paired but offline when the desktop cannot be reached", async () => {
  const p = profile("desk")
  connect(
    p,
    api(Promise.reject(new RemoteApiError("fetch failed", 0, "network")))
  )
  expect(await useSessionStore.getState().check()).toBe(false)
  expect(useSessionStore.getState()).toMatchObject({
    state: "offline",
    profile: p,
  })
  expect(useSessionStore.getState().error).toContain("same network or tailnet")
})

it("asks for an app update without dropping the pairing", async () => {
  const p = profile("desk")
  connect(
    p,
    api(
      Promise.resolve(
        bootstrap(p, { protocol: { ...PROTOCOL, minClientVersion: "0.2.0" } })
      )
    )
  )
  expect(await useSessionStore.getState().check()).toBe(true)
  expect(useSessionStore.getState()).toMatchObject({
    profile: p,
    compatibility: { kind: "app_update_required", minClientVersion: "0.2.0" },
  })

  useSessionStore.getState().markAppUpdateRequired("0.3.0")
  expect(useSessionStore.getState().compatibility).toEqual({
    kind: "app_update_required",
    minClientVersion: "0.3.0",
  })
})

it("treats a desktop without protocol negotiation as legacy", async () => {
  const p = profile("desk")
  connect(p, api(Promise.resolve(bootstrap(p, { protocol: null }))))
  await useSessionStore.getState().check()
  expect(useSessionStore.getState().compatibility).toEqual({
    kind: "legacy_desktop",
  })
})

it("reports read-only access from the desktop's view of the session", () => {
  const p = profile("desk")
  expect(selectAccessLevel({ profile: p, protocol: null })).toBe("full")
  expect(
    selectAccessLevel({
      profile: { ...p, session: { ...p.session, accessLevel: "read_only" } },
      protocol: null,
    })
  ).toBe("read_only")
  expect(
    selectAccessLevel({
      profile: p,
      protocol: {
        ...PROTOCOL,
        capabilities: { ...PROTOCOL.capabilities, accessLevel: "read_only" },
      },
    })
  ).toBe("read_only")
})

it("keeps the pairing and says so when the desktop cannot confirm the sign-out", async () => {
  const p = profile("desk")
  connect(
    p,
    api(
      Promise.resolve(bootstrap(p)),
      Promise.reject(new RemoteApiError("fetch failed", 0, "network"))
    )
  )
  const result = await useSessionStore.getState().logout()
  expect(result).toEqual({
    revoked: false,
    error: expect.stringContaining("same network or tailnet"),
  })
  expect(useSessionStore.getState().profile).toBe(p)
  expect(clearStoredProfile).not.toHaveBeenCalled()
  await useSessionStore.getState().forget()
  expect(useSessionStore.getState().profile).toBeNull()
  expect(clearStoredProfile).toHaveBeenCalledOnce()
})

it("runs the demo without storage or network, and leaves it again", async () => {
  useSessionStore.getState().startDemo()
  const state = useSessionStore.getState()
  expect(state).toMatchObject({
    mode: "demo",
    profile: DEMO_PROFILE,
    state: "online",
    compatibility: { kind: "ok" },
  })
  expect(state.transport?.kind).toBe("demo")
  expect(await state.check()).toBe(true)
  expect(
    (await state.transport!.api.listThreadsPage()).threads.length
  ).toBeGreaterThan(0)
  expect(await useSessionStore.getState().logout()).toEqual({ revoked: true })
  expect(useSessionStore.getState()).toMatchObject({
    mode: null,
    profile: null,
    state: "unpaired",
  })
  expect(storeProfile).not.toHaveBeenCalled()
  expect(clearStoredProfile).not.toHaveBeenCalled()
  expect(createLiveTransport).not.toHaveBeenCalled()
})

// ---------------------------------------------------------------------------
// Ordering: an action that finishes late never undoes a newer one.
// ---------------------------------------------------------------------------

it.each(["forget", "logout"] as const)(
  "does not resurrect a session after %s",
  async (method) => {
    const old = profile("old")
    const check = deferred<RemoteBootstrap>()
    connect(old, api(check.promise))
    const pending = useSessionStore.getState().check()
    await useSessionStore.getState()[method]()
    check.resolve(bootstrap(old))
    expect(await pending).toBe(false)
    expect(useSessionStore.getState()).toMatchObject({
      profile: null,
      state: "unpaired",
      socketState: "idle",
    })
    expect(storeProfile).not.toHaveBeenCalled()
  }
)

it.each(["success", "unauthorized", "expired"])(
  "ignores an old host's %s after a new pairing",
  async (outcome) => {
    const old = profile("old")
    const check = deferred<RemoteBootstrap>()
    connect(old, api(check.promise))
    const pending = useSessionStore.getState().check()
    const current = await pair("new")
    vi.mocked(clearStoredProfile).mockClear()
    if (outcome === "unauthorized")
      check.reject(new RemoteApiError("expired", 401))
    else check.resolve(bootstrap(old, { authenticated: outcome !== "expired" }))
    expect(await pending).toBe(false)
    expect(useSessionStore.getState()).toMatchObject({
      profile: current,
      state: "online",
    })
    expect(clearStoredProfile).not.toHaveBeenCalled()
  }
)

it("orders secure-storage mutations so an in-flight refresh cannot survive forget", async () => {
  const old = profile("old")
  const write = deferred<void>()
  // An expiry change is stored (a moved last-seen time is not, see above).
  connect(
    old,
    api(
      Promise.resolve(
        bootstrap(old, {
          session: { ...old.session, expiresAt: "2027-12-01T00:00:00.000Z" },
        })
      )
    )
  )
  const persisted: string[] = []
  vi.mocked(storeProfile).mockImplementationOnce(async () => {
    await write.promise
    persisted.push("refresh")
  })
  vi.mocked(clearStoredProfile).mockImplementation(async () => {
    persisted.push("clear")
  })
  const checking = useSessionStore.getState().check()
  await vi.waitFor(() => expect(storeProfile).toHaveBeenCalledOnce())
  const forgetting = useSessionStore.getState().forget()
  expect(useSessionStore.getState().profile).toBeNull()
  expect(clearStoredProfile).not.toHaveBeenCalled()
  write.resolve()
  await Promise.all([checking, forgetting])
  expect(persisted).toEqual(["refresh", "clear"])
  expect(useSessionStore.getState().profile).toBeNull()
})

it("ignores hydration that completes after a new pairing", async () => {
  const reading = deferred<ConnectionProfile | null>()
  vi.mocked(readStoredProfile).mockReturnValueOnce(reading.promise)
  const hydrating = useSessionStore.getState().hydrate()
  await vi.waitFor(() => expect(readStoredProfile).toHaveBeenCalledOnce())
  const pairing = pair("new")
  reading.resolve(profile("old"))
  const current = await pairing
  await hydrating
  expect(useSessionStore.getState()).toMatchObject({
    profile: current,
    state: "online",
  })
  // Only the new pairing got a connection; the stale stored one never did.
  expect(
    vi.mocked(createLiveTransport).mock.calls.map(([p]) => p.environmentId)
  ).toEqual(["new"])
})

it("deduplicates concurrent checks in the same session", async () => {
  const old = profile("old")
  const check = deferred<RemoteBootstrap>()
  const remote = api(check.promise)
  connect(old, remote)
  const first = useSessionStore.getState().check()
  const second = useSessionStore.getState().check()
  expect(remote.bootstrap).toHaveBeenCalledOnce()
  check.resolve(bootstrap(old))
  expect(await Promise.all([first, second])).toEqual([true, true])
})

it("does not publish a pairing that finishes after forget", async () => {
  const response = deferred<RemotePairResponse>()
  const p = profile("old")
  vi.mocked(pairMobile).mockReturnValueOnce(response.promise)
  const pairing = useSessionStore.getState().pair("ABCD-EFGH", p.baseUrl)
  const rejected = expect(pairing).rejects.toThrow("superseded")
  await vi.waitFor(() => expect(pairMobile).toHaveBeenCalledOnce())
  await useSessionStore.getState().forget()
  response.resolve({
    enabled: true,
    authenticated: true,
    authentication: "remote",
    tokenType: "Bearer",
    environmentId: p.environmentId,
    sessionToken: p.sessionToken,
    session: p.session,
    protocol: null,
  })
  await rejected
  expect(storeProfile).not.toHaveBeenCalled()
  expect(useSessionStore.getState().profile).toBeNull()
})

it("does not clear a new pairing when an old host's logout finally completes", async () => {
  const old = profile("old")
  const logout = deferred<{ loggedOut: boolean }>()
  connect(old, api(Promise.resolve(bootstrap(old)), logout.promise))
  const loggingOut = useSessionStore.getState().logout()
  const current = await pair("new")
  logout.resolve({ loggedOut: true })
  expect(await loggingOut).toEqual({ revoked: true })
  expect(useSessionStore.getState()).toMatchObject({
    profile: current,
    state: "online",
  })
  expect(storeProfile).toHaveBeenLastCalledWith(current)
  expect(clearStoredProfile).toHaveBeenCalledOnce()
})
