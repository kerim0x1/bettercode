import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import {
  REMOTE_API_VERSION,
  REMOTE_CLIENT_HEADER,
  REMOTE_FEATURES,
  REMOTE_MIN_CLIENT_VERSION,
  formatRemoteClientHeader,
  type RemoteClientInfo,
  type RemoteProtocol,
} from "@betterc0de/schema/remote-protocol"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { DEFAULT_MAX_REQUEST_BYTES, assessCompatibility } from "@/lib/compat"
import { requestBytes } from "@/lib/request-size"
import { createLiveApi, pairMobile } from "@/transport/live/api"
import { RemoteApiError, httpJson } from "@/transport/live/http"
import { RemoteSocket } from "@/transport/live/socket"
import type { ChannelState, RemoteApi } from "@/transport/types"
import { CLIENT, startTestDesktop, type TestDesktop } from "./support/desktop"

// The phone app's own network client (src/transport/live) against a real
// desktop backend: pairing, the protocol block, paging, files, the live
// socket, the update gate and revocation.

const OUTDATED_CLIENT: RemoteClientInfo = { ...CLIENT, version: "0.0.1" }

let desktop: TestDesktop
/** The phone most tests share; only tests that end a session pair their own. */
let phone: Awaited<ReturnType<TestDesktop["pairPhone"]>>

beforeAll(async () => {
  desktop = await startTestDesktop()
  phone = await desktop.pairPhone()
})

afterAll(async () => {
  await desktop?.stop()
})

async function refusal(promise: Promise<unknown>): Promise<RemoteApiError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(RemoteApiError)
  return error as RemoteApiError
}

/**
 * The desktop's answer to a POST that declares `contentLength` bytes, sent
 * without its body and outside fetch's connection pool. The desktop judges
 * the size by that header before it reads a byte. A body it will not read
 * would otherwise be cut off with a reset, which on Windows can also discard
 * the answer that had already arrived.
 */
function answerToDeclaredSize(
  route: string,
  contentLength: number,
  sessionToken: string
): Promise<{ status: number | undefined; code: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${desktop.baseUrl}/api/v1${route}`,
      {
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": contentLength,
          Authorization: `Bearer ${sessionToken}`,
          [REMOTE_CLIENT_HEADER]: formatRemoteClientHeader(CLIENT),
        },
      },
      (response) => {
        let text = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => (text += chunk))
        response.on("end", () => {
          request.destroy()
          resolve({
            status: response.statusCode,
            code: (JSON.parse(text) as { code?: unknown }).code,
          })
        })
      }
    )
    request.on("error", reject)
    request.flushHeaders()
  })
}

/** The live socket with its callbacks recorded. */
function openSocket(sessionToken: string, client: RemoteClientInfo = CLIENT) {
  const states: ChannelState[] = []
  const protocols: (RemoteProtocol | null)[] = []
  const events = { unauthorized: 0, updateRequired: 0 }
  const socket = new RemoteSocket(
    { baseUrl: desktop.baseUrl, sessionToken, client },
    {
      onFrame: () => undefined,
      onState: (state) => states.push(state),
      onProtocol: (protocol) => protocols.push(protocol),
      onUnauthorized: () => (events.unauthorized += 1),
      onUpdateRequired: () => (events.updateRequired += 1),
    }
  )
  socket.start()
  return { socket, states, protocols, events }
}

describe("the phone app against a real desktop", () => {
  it("pairs, then sees the same desktop and protocol on every check", async () => {
    const { paired, api } = phone
    expect(paired.sessionToken).toMatch(/^bc_remote_/)
    expect(paired.session.accessLevel).toBe("full")
    expect(paired.protocol).toMatchObject({
      apiVersion: REMOTE_API_VERSION,
      minClientVersion: REMOTE_MIN_CLIENT_VERSION,
      capabilities: { accessLevel: "full", terminalGranted: false },
    })
    expect(paired.protocol?.capabilities?.features).toEqual(
      expect.arrayContaining([
        REMOTE_FEATURES.threadsGet,
        REMOTE_FEATURES.workspaceWriteIfMatch,
      ])
    )
    expect(assessCompatibility(paired.protocol, CLIENT.version)).toEqual({
      kind: "ok",
    })

    const bootstrap = await api.bootstrap()
    expect(bootstrap).toMatchObject({
      enabled: true,
      authenticated: true,
      authentication: "remote",
      environmentId: paired.environmentId,
      session: { id: paired.session.id },
    })
    expect(bootstrap.protocol).toEqual(paired.protocol)
  })

  it("pages through more chats than one page holds, and finds one by id", async () => {
    const { api } = phone
    const start = Date.parse("2026-09-01T00:00:00.000Z")
    const ids = Array.from(
      { length: 105 },
      (_, index) => `e2e-thread-${String(index).padStart(3, "0")}`
    )
    for (const [index, id] of ids.entries()) {
      await desktop.saveThread(
        id,
        new Date(start + index * 1_000).toISOString()
      )
    }

    const first = await api.listThreadsPage()
    expect(first.threads).toHaveLength(100)
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = await api.listThreadsPage(first.nextCursor)
    expect(second.nextCursor).toBeNull()
    const listed = [...first.threads, ...second.threads].map(
      (thread) => thread.id
    )
    expect(new Set(listed).size).toBe(listed.length)
    expect(listed.filter((id) => id.startsWith("e2e-thread-")).sort()).toEqual(
      ids
    )
    // Newest first.
    expect(listed[0]).toBe("e2e-thread-104")

    expect(await api.getThread("e2e-thread-007")).toMatchObject({
      id: "e2e-thread-007",
      projectPath: desktop.workspace,
    })
    expect(await api.getThread("no-such-chat")).toBeNull()
  })

  it("loads a long chat newest first and earlier messages on demand", async () => {
    const { api } = phone
    const id = "e2e-long-chat"
    await desktop.saveThread(id, "2026-09-02T00:00:00.000Z")
    for (let index = 0; index < 5; index += 1) {
      await desktop.asDesktop("POST", `/threads/${id}/messages`, {
        id: `e2e-message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Message ${index}`,
        createdAt: new Date(
          Date.parse("2026-09-02T00:00:00.000Z") + index * 1_000
        ).toISOString(),
      })
    }

    const newest = await api.listMessages(id, { limit: 2 })
    expect(newest.map((message) => message.content)).toEqual([
      "Message 3",
      "Message 4",
    ])
    // Each message carries its `sequence`, which the shared type leaves out.
    const oldestShown = (newest[0] as { sequence?: number } | undefined)
      ?.sequence
    expect(oldestShown).toEqual(expect.any(Number))
    const earlier = await api.listMessages(id, {
      limit: 2,
      beforeSequence: oldestShown,
    })
    expect(earlier.map((message) => message.content)).toEqual([
      "Message 1",
      "Message 2",
    ])
    expect(
      (await api.listMessages(id)).map((message) => message.content)
    ).toEqual(["Message 0", "Message 1", "Message 2", "Message 3", "Message 4"])
  })

  it("browses and reads the files of a chat's project", async () => {
    const { api } = phone
    const { workspace } = desktop
    await desktop.saveThread("e2e-files", "2026-09-03T00:00:00.000Z")
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(workspace, "src", "hello.ts"),
      'export const hello = "world"\n'
    )

    const listing = await api.listDirectory(workspace)
    expect(listing.entries.map((entry) => entry.name)).toContain("src")
    const found = await api.searchFiles(workspace, "hello")
    expect(found.entries.map((entry) => entry.name)).toContain("hello.ts")
    const file = await api.readFile(
      workspace,
      path.join(workspace, "src", "hello.ts")
    )
    expect(file.content).toBe('export const hello = "world"\n')
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)

    // Only registered projects are readable.
    const outside = await refusal(api.listDirectory(os.tmpdir()))
    expect(outside.status).toBe(403)
  })

  it("keeps the live socket's protocol current and stops it when the phone signs out", async () => {
    const { paired, api } = await desktop.pairPhone()
    const live = openSocket(paired.sessionToken)
    await vi.waitFor(() => expect(live.states).toContain("live"))
    expect(live.protocols.at(-1)).toMatchObject({
      capabilities: { terminalGranted: false },
    })

    await desktop.setSettings({ remote_access_allow_terminal: true })
    await vi.waitFor(() =>
      expect(live.protocols.at(-1)?.capabilities?.terminalGranted).toBe(true)
    )
    await desktop.setSettings({ remote_access_allow_terminal: false })
    await vi.waitFor(() =>
      expect(live.protocols.at(-1)?.capabilities?.terminalGranted).toBe(false)
    )

    expect(await api.logout()).toEqual({ loggedOut: true })
    await vi.waitFor(() => expect(live.events.unauthorized).toBe(1))
    expect(live.events.updateRequired).toBe(0)
    expect(await api.bootstrap()).toMatchObject({ authenticated: false })
    live.socket.stop()
  })

  it("closes the socket of a phone the desktop revokes", async () => {
    const { paired } = await desktop.pairPhone()
    const live = openSocket(paired.sessionToken)
    await vi.waitFor(() => expect(live.states).toContain("live"))
    await desktop.asDesktop("DELETE", `/remote/sessions/${paired.session.id}`)
    await vi.waitFor(() => expect(live.events.unauthorized).toBe(1))
    live.socket.stop()
  })

  it("asks an outdated app to update without spending its pairing code", async () => {
    const { baseUrl } = desktop
    const code = await desktop.pairingCode()
    const refused = await refusal(
      pairMobile(baseUrl, code, "Old phone", OUTDATED_CLIENT)
    )
    expect(refused).toMatchObject({
      status: 426,
      code: "client_update_required",
    })
    expect(refused.details.minClientVersion).toBe(REMOTE_MIN_CLIENT_VERSION)

    // After the update, the same code still pairs.
    const paired = await pairMobile(baseUrl, code, "Updated phone", CLIENT)
    const outdated: RemoteApi = createLiveApi({
      baseUrl,
      token: paired.sessionToken,
      client: OUTDATED_CLIENT,
    })
    // The check still answers, and tells the app why it cannot go on.
    const bootstrap = await outdated.bootstrap()
    expect(bootstrap.authenticated).toBe(true)
    expect(
      assessCompatibility(bootstrap.protocol, OUTDATED_CLIENT.version)
    ).toEqual({
      kind: "app_update_required",
      minClientVersion: REMOTE_MIN_CLIENT_VERSION,
    })
    expect(await refusal(outdated.listThreadsPage())).toMatchObject({
      status: 426,
      code: "client_update_required",
    })

    const live = openSocket(paired.sessionToken, OUTDATED_CLIENT)
    await vi.waitFor(() => expect(live.events.updateRequired).toBe(1))
    expect(live.events.unauthorized).toBe(0)
    expect(live.states).not.toContain("live")
    live.socket.stop()
  })

  // Turning Remote Access off ends every session, so this runs last.
  it("counts a request's size as the phone does, and refuses one past its limit", async () => {
    // The phone fits photos and history into what the desktop says it takes.
    const limit = phone.paired.protocol?.capabilities?.maxRequestBytes
    expect(limit).toBe(DEFAULT_MAX_REQUEST_BYTES)
    const connection = {
      baseUrl: desktop.baseUrl,
      token: phone.paired.sessionToken,
      client: CLIENT,
    }
    /** A body of exactly `bytes` bytes, as the phone counts them. */
    const bodyOf = (bytes: number) => ({
      padding: "x".repeat(bytes - requestBytes({ padding: "" })),
    })
    expect(requestBytes(bodyOf(limit!))).toBe(limit)

    // At the limit the desktop reads the request, and refuses it only for
    // what it says (it is no chat message).
    const at = await refusal(
      httpJson(connection, "/chat/send", {
        method: "POST",
        body: bodyOf(limit!),
      })
    )
    expect(at.status).toBe(400)
    // One byte more is refused before it is read.
    expect(
      await answerToDeclaredSize(
        "/chat/send",
        requestBytes(bodyOf(limit! + 1)),
        phone.paired.sessionToken
      )
    ).toEqual({ status: 413, code: "request_too_large" })
  })

  it("reports Remote Access as off, and the pairing as ended once it is back on", async () => {
    const { api } = phone
    await desktop.setSettings({ remote_access_enabled: false })
    expect(await api.bootstrap()).toMatchObject({ enabled: false })

    await desktop.setSettings({ remote_access_enabled: true })
    expect(await api.bootstrap()).toMatchObject({
      enabled: true,
      authenticated: false,
    })
  })
})
