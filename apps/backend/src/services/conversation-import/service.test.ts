import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openDatabase, type Db } from "../../persistence/db"
import { runMigrations } from "../../persistence/migrations"
import { ThreadActivityProjectionQuery } from "../../persistence/projections"
import { ProviderSessionBindingStore } from "../../provider/runtime/ProviderSessionBindingStore"
import { ThreadService } from "../threads"
import { ConversationImportService } from "./service"
import {
  claudeContinuationKeyFor,
  claudeProjectDirectoryName,
  codexContinuationKeyFor,
  type SessionRoots,
} from "./sources"

// Synthetic Claude Code and Codex homes in a temporary folder; nothing is
// read from the real home folder.

const CLAUDE_ID = "aaaaaaaa-1111-4222-8333-444444444444"
const CODEX_ID = "0199bbbb-2222-7333-8444-555555555555"
const IMPORTED_AT = "2026-05-01T12:00:00.000Z"

let root: string
let project: string
let dataDir: string
let roots: SessionRoots
let db: Db
let threads: ThreadService
let bindings: ProviderSessionBindingStore
let activities: ThreadActivityProjectionQuery

async function runNow<T>(_scope: unknown, run: () => T): Promise<T> {
  return await run()
}

function service(options: { continuationKeys?: boolean } = {}) {
  return new ConversationImportService({
    db,
    threads,
    bindings,
    activities,
    continuationKey: (instanceId) => {
      if (options.continuationKeys === false) return null
      if (instanceId === "claude") return claudeContinuationKeyFor(roots.claude)
      if (instanceId === "codex") return codexContinuationKeyFor(roots.codex)
      return null
    },
    dataDir,
    roots,
    tmpDir: path.join(root, "tmp"),
    withMutation: runNow,
    now: () => new Date(IMPORTED_AT),
  })
}

function writeJsonl(file: string, rows: unknown[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
  )
  return file
}

function writeClaudeSession(cwd: string, id = CLAUDE_ID): string {
  const folder = path.join(
    roots.claude,
    "projects",
    claudeProjectDirectoryName(path.resolve(cwd).normalize("NFC"))
  )
  const common = { isSidechain: false, cwd, sessionId: id }
  return writeJsonl(path.join(folder, `${id}.jsonl`), [
    { type: "permission-mode", permissionMode: "default", sessionId: id },
    {
      ...common,
      type: "user",
      uuid: "u1",
      parentUuid: null,
      timestamp: "2026-03-01T10:00:00.000Z",
      message: { role: "user", content: "Add a dark mode toggle" },
    },
    {
      ...common,
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "2026-03-01T10:00:05.000Z",
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "Added the toggle." }],
      },
    },
  ])
}

function writeCodexSession(cwd: string, id = CODEX_ID): string {
  return writeJsonl(
    path.join(
      roots.codex,
      "sessions",
      "2026",
      "03",
      "02",
      `rollout-2026-03-02T09-00-00-${id}.jsonl`
    ),
    [
      {
        timestamp: "2026-03-02T09:00:00.000Z",
        type: "session_meta",
        payload: {
          id,
          timestamp: "2026-03-02T09:00:00.000Z",
          cwd,
          source: "cli",
        },
      },
      {
        timestamp: "2026-03-02T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Explain the build" }],
        },
      },
      {
        timestamp: "2026-03-02T09:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "It uses Vite." }],
        },
      },
    ]
  )
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bc0de-conversation-import-"))
  project = path.join(root, "work", "demo-app")
  fs.mkdirSync(project, { recursive: true })
  dataDir = path.join(root, "data")
  roots = {
    claude: path.join(root, "home", ".claude"),
    codex: path.join(root, "home", ".codex"),
  }
  db = openDatabase(path.join(dataDir, "test.sqlite"))
  runMigrations(db)
  threads = new ThreadService(db)
  bindings = new ProviderSessionBindingStore(db)
  activities = new ThreadActivityProjectionQuery(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe("ConversationImportService.list", () => {
  it("lists both CLIs' sessions with project, count and resumability", async () => {
    writeClaudeSession(project)
    writeCodexSession(path.join(root, "work", "deleted-folder"))

    const list = await service().list()

    expect(list.complete).toBe(true)
    expect(list.sources).toEqual([
      { provider: "claude", found: true, sessions: 1, skipped: 0 },
      { provider: "codex", found: true, sessions: 1, skipped: 0 },
    ])
    // Newest first.
    expect(list.candidates.map((candidate) => candidate.provider)).toEqual([
      "codex",
      "claude",
    ])
    expect(
      list.candidates.find((candidate) => candidate.provider === "claude")
    ).toMatchObject({
      sessionId: CLAUDE_ID,
      projectPath: project,
      projectName: "demo-app",
      folderExists: true,
      title: "Add a dark mode toggle",
      startedAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-01T10:00:05.000Z",
      messageCount: 2,
      threadId: null,
      resumable: true,
      archived: false,
    })
    expect(
      list.candidates.find((candidate) => candidate.provider === "codex")
    ).toMatchObject({
      sessionId: CODEX_ID,
      folderExists: false,
      messageCount: 2,
      resumable: true,
    })
  })

  it("reports a CLI without a session folder", async () => {
    const list = await service().list({ provider: "claude" })
    expect(list.candidates).toEqual([])
    expect(list.sources).toEqual([
      { provider: "claude", found: false, sessions: 0, skipped: 0 },
    ])
  })

  it("narrows the list to one project folder", async () => {
    writeClaudeSession(project)
    writeCodexSession(path.join(root, "work", "other"))
    const list = await service().list({ project })
    expect(list.candidates.map((candidate) => candidate.sessionId)).toEqual([
      CLAUDE_ID,
    ])
  })

  it("leaves out sessions BetterC0de ran in its own data folder", async () => {
    writeClaudeSession(path.join(dataDir, "scratch", "thread-1"))
    const list = await service().list()
    expect(list.candidates).toEqual([])
  })
})

describe("ConversationImportService.import", () => {
  it("imports a session into a chat that resumes the native session", async () => {
    writeClaudeSession(project)
    const importer = service()
    await importer.list()

    const { results } = await importer.import([
      { provider: "claude", sessionId: CLAUDE_ID },
    ])

    expect(results).toHaveLength(1)
    const result = results[0]!
    expect(result).toMatchObject({
      provider: "claude",
      sessionId: CLAUDE_ID,
      status: "imported",
    })
    const threadId = result.threadId!
    expect(result.thread).toMatchObject({ id: threadId })
    expect(threads.getThreadSummary(threadId)).toMatchObject({
      title: "Add a dark mode toggle",
      projectName: "demo-app",
      projectPath: project,
      createdAt: "2026-03-01T10:00:00.000Z",
      messageCount: 2,
      settings: { selectedProviderId: "claude" },
      importedFrom: {
        provider: "claude",
        sessionId: CLAUDE_ID,
        importedAt: IMPORTED_AT,
        resumable: true,
      },
    })
    const messages = threads.listMessages(threadId) as Array<
      Record<string, unknown>
    >
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Add a dark mode toggle"],
      ["assistant", "Added the toggle."],
    ])
    expect(messages[1]).toMatchObject({ modelId: "claude-test" })

    const binding = bindings.get(threadId, "claude")
    expect(binding).toMatchObject({
      providerKind: "claude",
      providerThreadId: CLAUDE_ID,
      continuationKey: claudeContinuationKeyFor(roots.claude),
      status: "stopped",
      cwd: project,
    })
    expect(binding?.resumeCursor).toMatchObject({
      resume: CLAUDE_ID,
      sessionId: CLAUDE_ID,
    })
    // The CLI compacts the resumed session itself.
    expect(
      activities.latestByThreadKind(threadId, "context-window.updated")?.payload
    ).toMatchObject({ compactsAutomatically: true })
  })

  it("offers a session only once", async () => {
    writeClaudeSession(project)
    const importer = service()
    const first = await importer.import([
      { provider: "claude", sessionId: CLAUDE_ID },
    ])
    const threadId = first.results[0]?.threadId

    const again = await importer.import([
      { provider: "claude", sessionId: CLAUDE_ID },
    ])
    expect(again.results[0]).toMatchObject({ status: "skipped", threadId })

    const list = await importer.list()
    expect(list.candidates[0]).toMatchObject({ sessionId: CLAUDE_ID, threadId })
  })

  it("imports without a folder when the folder is gone, and without a binding the instance can't resume", async () => {
    writeCodexSession(path.join(root, "work", "deleted-folder"))

    // No listing first: the import finds the file by its name.
    const { results } = await service({ continuationKeys: false }).import([
      { provider: "codex", sessionId: CODEX_ID },
    ])

    const threadId = results[0]?.threadId
    expect(results[0]?.status).toBe("imported")
    expect(threads.getThreadSummary(threadId!)).toMatchObject({
      projectPath: "",
      projectName: "BetterC0de",
      settings: { selectedProviderId: "codex" },
      importedFrom: {
        provider: "codex",
        sessionId: CODEX_ID,
        resumable: false,
      },
    })
    expect(bindings.get(threadId!, "codex")).toBeNull()
  })

  it("refuses unknown sessions and BetterC0de's own", async () => {
    writeClaudeSession(path.join(dataDir, "scratch", "thread-1"))
    const { results } = await service().import([
      { provider: "claude", sessionId: "bbbbbbbb-1111-4222-8333-444444444444" },
      { provider: "claude", sessionId: CLAUDE_ID },
    ])
    expect(results.map((result) => result.status)).toEqual(["failed", "failed"])
    expect(results.every((result) => result.threadId === null)).toBe(true)
    expect(results.every((result) => typeof result.error === "string")).toBe(
      true
    )
  })
})
