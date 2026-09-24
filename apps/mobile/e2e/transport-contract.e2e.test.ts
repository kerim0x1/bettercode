import fs from "node:fs"
import path from "node:path"
import { httpContracts } from "@betterc0de/schema/http-contracts"
import {
  REMOTE_API_VERSION,
  REMOTE_FEATURES,
} from "@betterc0de/schema/remote-protocol"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assessCompatibility, hasFeature } from "@/lib/compat"
import { parseRemoteBootstrap } from "@/lib/remote-session"
import { createDemoTransport } from "@/transport/demo"
import type { RemoteApi } from "@/transport/types"
import {
  RELEASE_VERSION,
  startTestDesktop,
  type TestDesktop,
} from "./support/desktop"

// The demo stands in for a desktop wherever the app is shown without one
// (App Review, screen tests, device flows). Every answer the screens rely
// on is checked here against the demo and against a real desktop, so the
// demo cannot drift from what a paired phone sees.

interface Fixture {
  readonly api: RemoteApi
  /** A project folder with a README.md and a src folder. */
  readonly projectRoot: string
  /** A chat in that project with at least two messages. */
  readonly threadId: string
  /** Joins paths the way the desktop's platform does. */
  readonly join: (...parts: string[]) => string
  readonly stop: () => Promise<void>
}

async function demoFixture(): Promise<Fixture> {
  const transport = createDemoTransport({ chunkDelayMs: 0 })
  return {
    api: transport.api,
    projectRoot: "/Users/demo/code/weather-app",
    threadId: "demo-dark-mode",
    join: path.posix.join,
    stop: async () => transport.dispose(),
  }
}

async function liveFixture(): Promise<Fixture> {
  const desktop: TestDesktop = await startTestDesktop()
  try {
    const root = desktop.workspace
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.writeFileSync(path.join(root, "README.md"), "# Contract project\n")
    fs.writeFileSync(
      path.join(root, "package.json"),
      '{ "name": "contract-project" }\n'
    )
    fs.writeFileSync(
      path.join(root, "src", "app.ts"),
      "export const app = true\n"
    )
    await desktop.saveThread("contract-thread", "2026-09-01T10:00:00.000Z")
    for (const [index, role] of (["user", "assistant"] as const).entries()) {
      await desktop.asDesktop("POST", "/threads/contract-thread/messages", {
        id: `contract-message-${index}`,
        role,
        content: `${role} message`,
        createdAt: `2026-09-01T10:00:0${index}.000Z`,
      })
    }
    const { api } = await desktop.pairPhone()
    return {
      api,
      projectRoot: root,
      threadId: "contract-thread",
      join: path.join,
      stop: () => desktop.stop(),
    }
  } catch (error) {
    await desktop.stop()
    throw error
  }
}

describe.each([
  ["demo", demoFixture],
  ["live", liveFixture],
] as const)("the %s desktop", (_kind, setUp) => {
  let fixture: Fixture

  beforeAll(async () => {
    fixture = await setUp()
  })

  afterAll(async () => {
    await fixture?.stop()
  })

  it("answers the session check as a paired desktop this app can use", async () => {
    const bootstrap = parseRemoteBootstrap(await fixture.api.bootstrap())
    expect(bootstrap).toMatchObject({
      enabled: true,
      authenticated: true,
      authentication: "remote",
      session: { accessLevel: "full" },
    })
    expect(bootstrap.protocol).toMatchObject({
      apiVersion: REMOTE_API_VERSION,
      capabilities: { accessLevel: "full" },
    })
    expect(hasFeature(bootstrap.protocol, REMOTE_FEATURES.threadsGet)).toBe(
      true
    )
    expect(assessCompatibility(bootstrap.protocol, RELEASE_VERSION)).toEqual({
      kind: "ok",
    })

    const status = await fixture.api.status()
    expect(status).toMatchObject({
      enabled: true,
      authentication: "remote",
      currentSessionId: bootstrap.session?.id,
    })
  })

  it("lists chats newest first, as the shared contract describes them", async () => {
    const page = await fixture.api.listThreadsPage()
    expect(() =>
      httpContracts.listThreads.response.parse(page.threads)
    ).not.toThrow()
    expect(page.threads.map((thread) => thread.id)).toContain(fixture.threadId)
    const updated = page.threads.map((thread) => thread.updatedAt)
    expect(updated).toEqual([...updated].sort().reverse())
    expect(page.nextCursor).toBeNull()
  })

  it("finds a chat by id, and none for an unknown id", async () => {
    const thread = await fixture.api.getThread(fixture.threadId)
    expect(() => httpContracts.getThread.response.parse(thread)).not.toThrow()
    expect(thread).toMatchObject({
      id: fixture.threadId,
      projectPath: fixture.projectRoot,
    })
    expect(await fixture.api.getThread("no-such-chat")).toBeNull()
  })

  it("returns a chat's messages oldest first, and its activities", async () => {
    const messages = await fixture.api.listMessages(fixture.threadId)
    expect(() =>
      httpContracts.listMessages.response.parse(messages)
    ).not.toThrow()
    expect(messages.length).toBeGreaterThanOrEqual(2)
    const created = messages.map((message) => message.createdAt)
    expect(created).toEqual([...created].sort())
    const activities = await fixture.api.listActivities(fixture.threadId)
    expect(() =>
      httpContracts.listActivities.response.parse(activities)
    ).not.toThrow()
  })

  it("lists the chat's project", async () => {
    const projects = await fixture.api.listProjects()
    expect(projects.map((project) => project.path)).toContain(
      fixture.projectRoot
    )
  })

  it("lists a project folder with folders first", async () => {
    const listing = await fixture.api.listDirectory(fixture.projectRoot)
    expect(listing.path).toBe(fixture.projectRoot)
    const names = listing.entries.map((entry) => entry.name)
    expect(names).toEqual(
      expect.arrayContaining(["src", "README.md", "package.json"])
    )
    const firstFile = listing.entries.findIndex((entry) => !entry.isDir)
    expect(
      listing.entries.slice(firstFile).every((entry) => !entry.isDir)
    ).toBe(true)
    const src = listing.entries.find((entry) => entry.name === "src")
    expect(src).toMatchObject({
      isDir: true,
      path: fixture.join(fixture.projectRoot, "src"),
    })

    const inner = await fixture.api.listDirectory(
      fixture.join(fixture.projectRoot, "src")
    )
    expect(inner.parent).toBe(fixture.projectRoot)
  })

  it("finds files by name, ignoring case", async () => {
    const found = await fixture.api.searchFiles(fixture.projectRoot, "readme")
    expect(found.entries).toContainEqual(
      expect.objectContaining({
        name: "README.md",
        path: fixture.join(fixture.projectRoot, "README.md"),
      })
    )
  })

  it("reads a file, and refuses one that does not exist", async () => {
    const readme = fixture.join(fixture.projectRoot, "README.md")
    const file = await fixture.api.readFile(fixture.projectRoot, readme)
    expect(file.content.length).toBeGreaterThan(0)
    expect(file.size).toBe(Buffer.byteLength(file.content))
    const bootstrap = await fixture.api.bootstrap()
    if (hasFeature(bootstrap.protocol, REMOTE_FEATURES.workspaceWriteIfMatch)) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    await expect(
      fixture.api.readFile(
        fixture.projectRoot,
        fixture.join(fixture.projectRoot, "missing.txt")
      )
    ).rejects.toThrow()
  })
})
