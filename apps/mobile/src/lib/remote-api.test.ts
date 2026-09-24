import type { ConnectionProfile } from "@/types/remote"
import { afterEach, describe, expect, it, vi } from "vitest"
import { pairMobile, remoteApi } from "./remote-api"

const profile: ConnectionProfile = {
  baseUrl: "http://localhost:4321",
  environmentId: "desktop",
  sessionToken: "session",
  pairedAt: "2026-09-05",
  session: {
    id: "s",
    label: "phone",
    createdAt: "2026-09-05",
    lastSeenAt: "2026-09-05",
    expiresAt: "2027-09-05",
  },
}
afterEach(() => vi.unstubAllGlobals())
describe("mobile HTTP contracts", () => {
  it.each([null, {}, { authenticated: true, session: { id: "session" } }])(
    "rejects malformed successful pairing and session responses: %j",
    async (payload) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () => new Response(JSON.stringify(payload), { status: 200 })
        )
      )
      await expect(
        pairMobile(profile.baseUrl, "one-time", "Phone")
      ).rejects.toThrow("Invalid backend pairing response")
      await expect(remoteApi(profile).bootstrap()).rejects.toThrow(
        "Invalid backend session response"
      )
    }
  )

  it("accepts complete pairing and session metadata", async () => {
    const session = {
      enabled: true,
      authenticated: true,
      authentication: "remote",
      environmentId: profile.environmentId,
      session: profile.session,
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...session,
              tokenType: "Bearer",
              sessionToken: profile.sessionToken,
            }),
            { status: 200 }
          )
      )
    )
    expect(
      await pairMobile(profile.baseUrl, "one-time", "Phone")
    ).toMatchObject({ sessionToken: "session" })
    expect(await remoteApi(profile).bootstrap()).toEqual(session)
  })
  it("rejects malformed thread responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify([{ id: "t" }]), { status: 200 })
        )
    )
    await expect(remoteApi(profile).listThreads()).rejects.toThrow(
      "Invalid backend response"
    )
  })
  it("does not retry an accepted dispatch with an invalid reply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{"status":"streaming"}', { status: 200 })
      )
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      remoteApi(profile).sendMessage({
        threadId: "t",
        message: "hello",
        modelId: "model",
      })
    ).rejects.toThrow("Invalid backend response")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it("accepts empty 204 thread writes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    )
    await expect(
      remoteApi(profile).createThread({
        id: "t",
        title: "Hello",
        projectName: "Repo",
        projectPath: "/repo",
        messages: [],
        createdAt: "2026-09-05T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z",
      })
    ).resolves.toBeUndefined()
  })
})
