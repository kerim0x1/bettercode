import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const runtime = vi.hoisted(() => ({
  getRemoteBaseUrl: vi.fn((): string | null => null),
  invoke: vi.fn(),
}))

vi.mock("./runtime", () => runtime)

import {
  activePairingLinks,
  describeRemoteClient,
  describeRemoteTerminals,
  endRemoteSessionTerminals,
  getRemoteBootstrap,
  listRemotePairingLinks,
  pairRemoteBrowser,
  remotePairingAccess,
  revokeAllRemotePairingLinks,
  revokeRemotePairingLink,
} from "./remoteApi"

describe("describeRemoteTerminals", () => {
  it("counts a device's open terminals, and says nothing when it has none", () => {
    expect(describeRemoteTerminals(1)).toBe("1 terminal open")
    expect(describeRemoteTerminals(3)).toBe("3 terminals open")
    expect(describeRemoteTerminals(0)).toBeNull()
    // A backend that predates the count sends none.
    expect(describeRemoteTerminals(undefined)).toBeNull()
  })
})

describe("describeRemoteClient", () => {
  it("names the phone app, its version and platform for the device list", () => {
    expect(
      describeRemoteClient({
        name: "betterc0de-remote",
        version: "0.1.0-beta.3",
        platform: "android",
      })
    ).toBe("BetterC0de Remote 0.1.0-beta.3 on Android")
    expect(
      describeRemoteClient({
        name: "betterc0de-remote",
        version: "1.0.0",
        platform: "ios",
      })
    ).toBe("BetterC0de Remote 1.0.0 on iOS")
  })

  it("shows unknown apps and platforms as reported, and nothing for browsers", () => {
    expect(
      describeRemoteClient({
        name: "other-app",
        version: "2.0.0",
        platform: null,
      })
    ).toBe("other-app 2.0.0")
    expect(
      describeRemoteClient({
        name: "betterc0de-remote",
        version: "1.0.0",
        platform: "harmony",
      })
    ).toBe("BetterC0de Remote 1.0.0 on harmony")
    expect(describeRemoteClient(null)).toBeNull()
    expect(describeRemoteClient(undefined)).toBeNull()
  })
})

describe("remotePairingAccess", () => {
  it("gives a full session only over HTTPS, this computer or the tailnet", () => {
    expect(
      remotePairingAccess({
        id: "custom",
        url: "https://betterc0de.example.com/pair#code",
      })
    ).toBe("full")
    expect(
      remotePairingAccess({ id: "loopback", url: "http://127.0.0.1:4100" })
    ).toBe("full")
    expect(
      remotePairingAccess({
        id: "tailscale-ip",
        url: "http://100.101.102.103:4100",
      })
    ).toBe("full")
    expect(
      remotePairingAccess({
        id: "tailscale",
        url: "https://desk.tail1234.ts.net",
      })
    ).toBe("full")
  })

  it("marks plain HTTP on a private or public network as read-only", () => {
    expect(
      remotePairingAccess({
        id: "network:192.168.1.20",
        url: "http://192.168.1.20:4100/pair#code",
      })
    ).toBe("read-only")
    expect(
      remotePairingAccess({ id: "custom", url: "http://203.0.113.9:4100" })
    ).toBe("read-only")
    expect(remotePairingAccess({ id: "custom", url: "not a url" })).toBe(
      "read-only"
    )
  })
})

describe("activePairingLinks", () => {
  it("drops expired links and lists the newest first", () => {
    const now = Date.parse("2026-10-07T12:00:00.000Z")
    expect(
      activePairingLinks(
        [
          {
            id: "old",
            label: "Trusted device",
            createdAt: "2026-10-07T11:50:00.000Z",
            expiresAt: "2026-10-07T12:00:00.000Z",
          },
          {
            id: "first",
            label: "Trusted device",
            createdAt: "2026-10-07T11:55:00.000Z",
            expiresAt: "2026-10-07T12:05:00.000Z",
          },
          {
            id: "second",
            label: "Trusted device",
            createdAt: "2026-10-07T11:58:00.000Z",
            expiresAt: "2026-10-07T12:08:00.000Z",
          },
        ],
        now
      ).map((link) => link.id)
    ).toEqual(["second", "first"])
  })
})

describe("pairing link management", () => {
  beforeEach(() => {
    runtime.invoke.mockReset()
  })

  it("lists unused links from the desktop-only route", async () => {
    const link = {
      id: "grant-1",
      label: "Trusted device",
      createdAt: "2026-10-07T11:55:00.000Z",
      expiresAt: "2026-10-07T12:05:00.000Z",
    }
    runtime.invoke.mockResolvedValueOnce({ pairingLinks: [link] })
    await expect(listRemotePairingLinks()).resolves.toEqual([link])
    expect(runtime.invoke).toHaveBeenCalledWith(
      "/remote/pairing-links",
      expect.objectContaining({ method: "GET" })
    )

    // The answer is checked against the route's contract, not cast.
    runtime.invoke.mockResolvedValueOnce({})
    await expect(listRemotePairingLinks()).rejects.toThrow(
      "Invalid backend response for GET /remote/pairing-links"
    )
  })

  it("revokes one link by id, or every unused link", async () => {
    runtime.invoke.mockResolvedValueOnce({ revoked: true })
    await expect(revokeRemotePairingLink("grant/1")).resolves.toEqual({
      revoked: true,
    })
    expect(runtime.invoke).toHaveBeenLastCalledWith(
      "/remote/pairing-links/grant%2F1",
      expect.objectContaining({ method: "DELETE" })
    )

    runtime.invoke.mockResolvedValueOnce({ revoked: 2 })
    await expect(revokeAllRemotePairingLinks()).resolves.toEqual({
      revoked: 2,
    })
    expect(runtime.invoke).toHaveBeenLastCalledWith(
      "/remote/pairing-links",
      expect.objectContaining({ method: "DELETE" })
    )
  })

  it("names a paired device's session in the path", async () => {
    runtime.invoke.mockResolvedValueOnce({ ended: 2 })
    await expect(endRemoteSessionTerminals("session/1")).resolves.toEqual({
      ended: 2,
    })
    expect(runtime.invoke).toHaveBeenLastCalledWith(
      "/remote/sessions/session%2F1/terminals",
      expect.objectContaining({ method: "DELETE" })
    )
  })
})

describe("public remote routes", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    runtime.getRemoteBaseUrl.mockReturnValue("http://desk.local:4100/")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    runtime.getRemoteBaseUrl.mockReturnValue(null)
  })

  const signedOut = {
    enabled: true,
    authenticated: false,
    authentication: null,
    session: null,
    environmentId: "env-1",
    protocol: { apiVersion: 2, minClientVersion: "0.1.0-beta.1" },
  }

  it("reads the bootstrap with the browser's cookie and checks it", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(signedOut))
    await expect(getRemoteBootstrap()).resolves.toEqual(signedOut)
    expect(fetchMock).toHaveBeenCalledWith(
      "http://desk.local:4100/api/v1/remote/bootstrap",
      expect.objectContaining({ method: "GET", credentials: "include" })
    )

    fetchMock.mockResolvedValueOnce(Response.json({ enabled: "yes" }))
    await expect(getRemoteBootstrap()).rejects.toThrow(
      "Invalid backend response for GET /remote/bootstrap"
    )
  })

  it("pairs with the code and reports the desktop's refusal", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: "pairing code is invalid or expired",
          code: "pairing_code_invalid",
        },
        { status: 401 }
      )
    )
    await expect(pairRemoteBrowser("ABCD-EFGH", "Laptop")).rejects.toThrow(
      "pairing code is invalid or expired"
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body as string)).toEqual({
      credential: "ABCD-EFGH",
      label: "Laptop",
    })
  })
})
