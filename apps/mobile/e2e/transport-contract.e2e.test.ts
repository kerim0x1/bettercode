import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { parseGitDiff } from "@betterc0de/schema/git-diff"
import { httpContracts } from "@betterc0de/schema/http-contracts"
import {
  REMOTE_API_VERSION,
  REMOTE_FEATURES,
} from "@betterc0de/schema/remote-protocol"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assessCompatibility, hasFeature } from "@/lib/compat"
import { parseRemoteBootstrap } from "@/lib/remote-session"
import { sha256Hex } from "@/lib/sha256"
import { createDemoTransport } from "@/transport/demo"
import { RemoteApiError } from "@/transport/live/http"
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
  /**
   * A project folder with a README.md and a src folder. It is a git
   * repository with a staged file, a changed file with two separate
   * changes, a new file and at least one commit.
   */
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
    initialiseRepository(root)
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

const NOTES = Array.from({ length: 20 }, (_, index) => `Note ${index + 1}`)

/**
 * The demo's shape of repository: a commit, then a staged package.json, a
 * notes file changed in two places far apart, and a new file.
 */
function initialiseRepository(root: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git("init", "--initial-branch=main")
  git("config", "user.name", "Contract Test")
  git("config", "user.email", "contract@example.com")
  git("config", "core.autocrlf", "false")
  fs.writeFileSync(path.join(root, "notes.md"), `${NOTES.join("\n")}\n`)
  git("add", "-A")
  git("commit", "-m", "Start the contract project")
  fs.writeFileSync(
    path.join(root, "package.json"),
    '{ "name": "contract-project", "version": "1.1.0" }\n'
  )
  git("add", "package.json")
  const notes = [...NOTES]
  notes[2] = "Note 3, revised"
  notes[17] = "Note 18, revised"
  fs.writeFileSync(path.join(root, "notes.md"), `${notes.join("\n")}\n`)
  fs.writeFileSync(
    path.join(root, "src", "extra.ts"),
    "export const extra = 1\n"
  )
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

  it("reads the repository's status, diffs, branches and history as the contracts describe them", async () => {
    const root = fixture.projectRoot
    const status = await fixture.api.gitStatus(root)
    expect(() => httpContracts.gitStatus.response.parse(status)).not.toThrow()
    expect(status.branch).toBe("main")
    expect(status.staged).toContain("package.json")
    expect(status.modified.length).toBeGreaterThan(0)
    expect(status.untracked.length).toBeGreaterThan(0)
    expect(status.is_clean).toBe(false)

    const unstaged = await fixture.api.gitDiff(root)
    expect(() => httpContracts.gitDiff.response.parse(unstaged)).not.toThrow()
    expect(unstaged.truncated).toBe(false)
    expect(parseGitDiff(unstaged.diff).map((file) => file.name)).toEqual(
      status.modified
    )
    const staged = await fixture.api.gitDiff(root, true)
    expect(parseGitDiff(staged.diff).map((file) => file.name)).toEqual(
      status.staged
    )

    const branches = await fixture.api.listBranches(root)
    expect(branches.current).toBe("main")
    expect(branches.branches).toContain("main")
    const log = await fixture.api.gitLog(root, 5)
    expect(() =>
      httpContracts.gitLog.response.parse({ commits: log })
    ).not.toThrow()
    expect(log.length).toBeGreaterThan(0)
    expect(log[0]!.hash).toMatch(/^[0-9a-f]{40}$/)
  })

  it("stages one change of a file with two, and unstages it again", async () => {
    const root = fixture.projectRoot
    const file = parseGitDiff((await fixture.api.gitDiff(root)).diff).find(
      (candidate) => candidate.hunks.length === 2
    )
    expect(file).toBeDefined()
    const [first, second] = file!.hunks
    const lines = (hunk: typeof first) =>
      hunk!.lines.map((line) => `${line.type}${line.content}`)

    const staged = await fixture.api.gitApplyHunk({
      cwd: root,
      path: file!.name,
      source: "unstaged",
      action: "accept",
      patch: first!.patch,
    })
    expect(() =>
      httpContracts.gitHunkApply.response.parse(staged)
    ).not.toThrow()
    expect(staged).toMatchObject({ ok: true, action: "accept", applied: true })
    const stagedFile = parseGitDiff(
      (await fixture.api.gitDiff(root, true)).diff
    ).find((candidate) => candidate.name === file!.name)
    expect(stagedFile?.hunks.map(lines)).toEqual([lines(first)])
    const left = parseGitDiff((await fixture.api.gitDiff(root)).diff).find(
      (candidate) => candidate.name === file!.name
    )
    expect(left?.hunks.map(lines)).toEqual([lines(second)])

    // The same change again is gone from the working tree's diff.
    await expect(
      fixture.api.gitApplyHunk({
        cwd: root,
        path: file!.name,
        source: "unstaged",
        action: "accept",
        patch: first!.patch,
      })
    ).rejects.toMatchObject({ status: 409, code: "git_hunk_conflict" })

    await fixture.api.gitApplyHunk({
      cwd: root,
      path: file!.name,
      source: "staged",
      action: "unstage",
      patch: stagedFile!.hunks[0]!.patch,
    })
    expect(
      parseGitDiff((await fixture.api.gitDiff(root)).diff).find(
        (candidate) => candidate.name === file!.name
      )?.hunks
    ).toHaveLength(2)
  })

  it("stages and unstages a new file", async () => {
    const root = fixture.projectRoot
    const [untracked] = (await fixture.api.gitStatus(root)).untracked
    await fixture.api.gitStage(root, [untracked!])
    expect((await fixture.api.gitStatus(root)).staged).toContain(untracked)
    await fixture.api.gitUnstage(root, [untracked!])
    expect((await fixture.api.gitStatus(root)).untracked).toContain(untracked)
  })

  it("commits what is staged, and refuses to commit nothing in the desktop's words", async () => {
    const root = fixture.projectRoot
    await fixture.api.gitCommit(root, "Contract commit\n\nThrough the phone.")
    const status = await fixture.api.gitStatus(root)
    expect(status.staged).toEqual([])
    expect(status.modified.length).toBeGreaterThan(0)
    expect((await fixture.api.gitLog(root, 1))[0]?.message).toBe(
      "Contract commit"
    )
    const refused = await fixture.api
      .gitCommit(root, "Nothing")
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(RemoteApiError)
    expect(refused).toMatchObject({
      status: 400,
      code: "git_nothing_to_commit",
      message:
        "Nothing to commit — stage changes first or modify a tracked file.",
    })
  })

  it("creates a branch and switches back", async () => {
    const root = fixture.projectRoot
    await fixture.api.gitCheckout(root, "contract-branch", true)
    expect(await fixture.api.gitStatus(root)).toMatchObject({
      branch: "contract-branch",
      upstream: null,
    })
    await fixture.api.gitCheckout(root, "main")
    expect((await fixture.api.listBranches(root)).branches).toEqual(
      expect.arrayContaining(["main", "contract-branch"])
    )
  })

  it("creates, saves, renames and deletes files as the desktop allows", async () => {
    const root = fixture.projectRoot
    const names = async (...parts: string[]) =>
      (
        await fixture.api.listDirectory(fixture.join(root, ...parts))
      ).entries.map((entry) => entry.name)

    // A new file only where none exists; its folder comes with it.
    await fixture.api.writeFile(root, "notes/new.md", "# New\n", null)
    const created = await fixture.api.readFile(
      root,
      fixture.join(root, "notes", "new.md")
    )
    expect(created.content).toBe("# New\n")
    expect(created.sha256).toMatch(/^[0-9a-f]{64}$/)
    await expect(
      fixture.api.writeFile(root, "notes/new.md", "Again\n", null)
    ).rejects.toMatchObject({ status: 409, code: "WORKSPACE_PATH_CHANGED" })

    // A save only over the bytes that were read.
    await fixture.api.writeFile(
      root,
      "notes/new.md",
      "# Newer\n",
      created.sha256
    )
    await expect(
      fixture.api.writeFile(root, "notes/new.md", "# Stale\n", created.sha256)
    ).rejects.toMatchObject({ status: 409, code: "WORKSPACE_PATH_CHANGED" })

    await fixture.api.createFolder(root, "notes/empty")
    expect(await names("notes")).toEqual(["empty", "new.md"])

    // A rename, never onto something that exists.
    await fixture.api.movePath(root, "notes/new.md", "notes/renamed.md")
    expect(await names("notes")).toEqual(["empty", "renamed.md"])
    await expect(
      fixture.api.movePath(root, "notes/renamed.md", "README.md")
    ).rejects.toMatchObject({ status: 409, code: "EEXIST" })

    // A folder goes with everything in it.
    await fixture.api.deletePath(root, "notes", true)
    expect(await names()).not.toContain("notes")
  })

  it("reads a saved text back with the SHA-256 the phone computes for it", async () => {
    // The editor saves over the hash of the text it saved, without reading
    // the file again: the desktop must hash exactly those bytes.
    const root = fixture.projectRoot
    for (const text of [
      "plain\n",
      "﻿windows\r\nlines\r\n",
      "mixed\r\nbreaks\nand a lone\rcarriage return",
      "tab\t, Grüße, 世界, \u{1F600}\n",
      "",
    ]) {
      await fixture.api.writeFile(root, "notes/hash.txt", text)
      const read = await fixture.api.readFile(
        root,
        fixture.join(root, "notes", "hash.txt")
      )
      expect(read.content, JSON.stringify(text)).toBe(text)
      expect(read.sha256, JSON.stringify(text)).toBe(sha256Hex(text))
      // So the next save, made over that hash, goes through.
      await fixture.api.writeFile(
        root,
        "notes/hash.txt",
        `${text}more\n`,
        sha256Hex(text)
      )
    }
    await fixture.api.deletePath(root, "notes", true)
  })

  it("searches the text of files with the desktop's options", async () => {
    const root = fixture.projectRoot
    await fixture.api.writeFile(
      root,
      "search/sample.ts",
      "const Needle = 1\nconst needle = 2\nconst needles = 3\n",
      null
    )
    const lines = async (query: string, options = {}) =>
      (
        await fixture.api.searchContent(root, query, {
          include: "search/**",
          ...options,
        })
      ).results.flatMap((file) => file.matches.map((match) => match.line))

    const found = await fixture.api.searchContent(root, "needle", {
      include: "search/**",
    })
    expect(() =>
      httpContracts.workspaceSearchContent.response.parse(found)
    ).not.toThrow()
    expect(found.truncated).toBe(false)
    expect(found.results.map((file) => [file.path, file.name])).toEqual([
      ["search/sample.ts", "sample.ts"],
    ])
    expect(found.results[0]!.matches[0]).toMatchObject({
      line: 1,
      column: 7,
      length: 6,
      preview: "const Needle = 1",
      previewColumn: 7,
      previewLength: 6,
    })
    expect(await lines("needle")).toEqual([1, 2, 3])
    expect(await lines("needle", { caseSensitive: true })).toEqual([2, 3])
    expect(await lines("needle", { wholeWord: true })).toEqual([1, 2])
    expect(await lines("need+les", { regex: true })).toEqual([3])
    expect(await lines("needle", { include: "*.md" })).toEqual([])

    await fixture.api.deletePath(root, "search", true)
  })

  // Last: it renames the shared chat and deletes one of its own.
  it("renames a chat, and deletes one", async () => {
    const bootstrap = parseRemoteBootstrap(await fixture.api.bootstrap())
    expect(hasFeature(bootstrap.protocol, REMOTE_FEATURES.threadsRename)).toBe(
      true
    )
    const renamed = await fixture.api.renameThread(
      fixture.threadId,
      "  Renamed through the contract  "
    )
    expect(() =>
      httpContracts.renameThread.response.parse(renamed)
    ).not.toThrow()
    expect(renamed).toMatchObject({
      threadId: fixture.threadId,
      title: "Renamed through the contract",
    })
    const thread = await fixture.api.getThread(fixture.threadId)
    expect(thread).toMatchObject({
      title: "Renamed through the contract",
      // Nothing else about the chat changes.
      projectPath: fixture.projectRoot,
    })

    const now = new Date().toISOString()
    await fixture.api.createThread({
      id: "contract-delete",
      title: "To delete",
      projectName: "contract-project",
      projectPath: fixture.projectRoot,
      messages: [],
      createdAt: now,
      updatedAt: now,
    })
    expect(await fixture.api.getThread("contract-delete")).not.toBeNull()
    await fixture.api.deleteThread("contract-delete")
    expect(await fixture.api.getThread("contract-delete")).toBeNull()
  })
})
