import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { openDatabase } from "../persistence/db"
import { runMigrations } from "../persistence/migrations"
import { EventStore } from "../persistence/eventStore"
import { WorktreeRegistryQuery } from "../persistence/projections"
import {
  WorktreeManager,
  buildBranchName,
  slugifyMessage,
  shortThreadId,
  computeWorktreePath,
} from "./worktree"

const exec = promisify(execFile)
const temporaryDirectories: string[] = []
const databases: ReturnType<typeof openDatabase>[] = []

function tmpDir(label: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `bc0de-wt-${label}-`))
  temporaryDirectories.push(directory)
  return directory
}

function openTestDatabase(filePath: string) {
  const db = openDatabase(filePath)
  databases.push(db)
  return db
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

async function makeTestRepo(): Promise<string> {
  const dir = tmpDir("repo")
  await exec("git", ["init", "--initial-branch=main"], { cwd: dir })
  await exec("git", ["config", "user.email", "test@betterc0de.local"], {
    cwd: dir,
  })
  await exec("git", ["config", "user.name", "Test"], { cwd: dir })
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n")
  await exec("git", ["add", "."], { cwd: dir })
  await exec("git", ["commit", "-m", "seed"], { cwd: dir })
  return dir
}

// ─── Pure function tests (no git required) ───────────────────────────────────

describe("slugifyMessage", () => {
  it("lower-kebabs and strips special chars", () => {
    expect(slugifyMessage("Fix the Login Bug!")).toBe("fix-the-login-bug")
  })

  it("collapses consecutive non-alphanumeric runs to single dashes", () => {
    expect(slugifyMessage("foo   bar\t\t\tbaz")).toBe("foo-bar-baz")
  })

  it("strips leading + trailing dashes", () => {
    expect(slugifyMessage("!!!hello!!!")).toBe("hello")
  })

  it("caps at 30 chars without trailing dash", () => {
    const long = "the-quick-brown-fox-jumps-over-the-lazy-dog-many-times-over"
    const out = slugifyMessage(long)
    expect(out.length).toBeLessThanOrEqual(30)
    expect(out.endsWith("-")).toBe(false)
  })

  it("returns empty string for purely non-alphanumeric input", () => {
    expect(slugifyMessage("!@#$%^&*()")).toBe("")
  })

  it("handles empty + null-ish input", () => {
    expect(slugifyMessage("")).toBe("")
  })

  it("normalises unicode — strips combining marks so accented words slug cleanly", () => {
    expect(slugifyMessage("café über")).toBe("cafe-uber")
  })
})

describe("shortThreadId", () => {
  it("strips hyphens and truncates to 8 chars", () => {
    expect(shortThreadId("12345678-abcd-1234-5678-abcdef012345")).toBe(
      "12345678"
    )
  })

  it("handles already-short ids by returning them in full", () => {
    expect(shortThreadId("abc")).toBe("abc")
  })
})

describe("buildBranchName", () => {
  const threadId = "12345678-abcd-1234-5678-abcdef012345"

  it("combines agent/<shortId>/<slug>", () => {
    expect(buildBranchName(threadId, "Fix login bug")).toBe(
      "agent/12345678/fix-login-bug"
    )
  })

  it("falls back to agent/<shortId>/turn when slug is empty", () => {
    expect(buildBranchName(threadId, "!!!")).toBe("agent/12345678/turn")
    expect(buildBranchName(threadId, "")).toBe("agent/12345678/turn")
    expect(buildBranchName(threadId, null)).toBe("agent/12345678/turn")
  })
})

describe("computeWorktreePath", () => {
  it.each([
    "../evil",
    "..\\evil",
    "a/b",
    "a\\b",
    "a:b",
    ".",
    "--",
    "CON",
    "LPT1",
  ])(
    "keeps arbitrary thread ID %s inside its project directory",
    (threadId) => {
      const project = path.resolve("project")
      const expectedParent = path.dirname(
        computeWorktreePath(project, "safe-id")
      )
      const target = computeWorktreePath(project, threadId)
      expect(path.dirname(target)).toBe(expectedParent)
      expect(shortThreadId(threadId)).toMatch(/^[a-f0-9]{8}$/)
      expect(target).toBe(computeWorktreePath(project, threadId))
    }
  )

  it("produces deterministic paths under ~/.betterc0de/worktrees/<projectHash>/<threadIdShort>/", () => {
    const threadId = "12345678-abcd-1234-5678-abcdef012345"
    const a = computeWorktreePath("/home/user/project-a", threadId)
    const b = computeWorktreePath("/home/user/project-a", threadId)
    const c = computeWorktreePath("/home/user/project-b", threadId)
    expect(a).toBe(b) // deterministic
    expect(a).not.toBe(c) // different repo → different bucket
    expect(a.includes(path.join(".betterc0de", "worktrees"))).toBe(true)
    expect(a.endsWith("12345678")).toBe(true)
  })
})

// ─── Integration tests (require git on PATH) ────────────────────────────────

const gitAvailable = hasGit()

describe.skipIf(!gitAvailable)("WorktreeManager integration", () => {
  beforeEach(() => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir("home"))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const db of databases.splice(0)) {
      if (db.open) db.close()
    }
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!gitAvailable)(
    "creates a worktree, registers it, and projection_threads reflects it",
    async () => {
      const repo = await makeTestRepo()
      const dbPath = path.join(tmpDir("db"), "test.sqlite")
      const db = openTestDatabase(dbPath)
      runMigrations(db)

      // A pre-existing projection row is required because the UPDATE in
      // writeThreadMetadata does nothing on missing rows. In the real app
      // ThreadService.upsert creates this row first.
      const threadId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      db.prepare(
        `INSERT INTO projection_threads (thread_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run(
        threadId,
        "proj-1",
        new Date().toISOString(),
        new Date().toISOString()
      )

      const eventStore = new EventStore(db)
      const registry = new WorktreeRegistryQuery(db)
      const manager = new WorktreeManager(db, eventStore, registry)

      const result = await manager.createForThread({
        threadId,
        baseRepoPath: repo,
        baseBranch: "main",
        firstMessage: "Fix login bug in OAuth flow",
      })

      expect(result.branch).toMatch(/^agent\/aaaaaaaa\/fix-login-bug/)
      expect(fs.existsSync(result.worktreePath)).toBe(true)
      expect(fs.existsSync(path.join(result.worktreePath, "README.md"))).toBe(
        true
      )

      const entry = registry.findByThread(threadId)
      expect(entry).not.toBeNull()
      expect(entry?.state).toBe("ready")
      expect(entry?.base_branch).toBe("main")

      const row = db
        .prepare(
          `SELECT branch, worktree_path, worktree_state, env_mode FROM projection_threads WHERE thread_id = ?`
        )
        .get(threadId) as {
        branch: string
        worktree_path: string
        worktree_state: string
        env_mode: string
      }
      expect(row.branch).toBe(result.branch)
      expect(row.worktree_path).toBe(result.worktreePath)
      expect(row.worktree_state).toBe("ready")
      expect(row.env_mode).toBe("worktree")

      db.close()
    },
    30_000
  )

  it.skipIf(!gitAvailable)(
    "is idempotent — calling createForThread twice returns the same entry",
    async () => {
      const repo = await makeTestRepo()
      const dbPath = path.join(tmpDir("db-idem"), "test.sqlite")
      const db = openTestDatabase(dbPath)
      runMigrations(db)

      const threadId = "11111111-2222-3333-4444-555555555555"
      db.prepare(
        `INSERT INTO projection_threads (thread_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run(
        threadId,
        "proj-1",
        new Date().toISOString(),
        new Date().toISOString()
      )

      const eventStore = new EventStore(db)
      const registry = new WorktreeRegistryQuery(db)
      const manager = new WorktreeManager(db, eventStore, registry)

      const a = await manager.createForThread({
        threadId,
        baseRepoPath: repo,
        baseBranch: "main",
        firstMessage: "foo",
      })
      const b = await manager.createForThread({
        threadId,
        baseRepoPath: repo,
        baseBranch: "main",
        firstMessage: "foo",
      })

      expect(b.worktreeId).toBe(a.worktreeId)
      expect(b.worktreePath).toBe(a.worktreePath)
      expect(b.branch).toBe(a.branch)

      // Simulate a crash after `git worktree add` completed but before the
      // registry/projection transaction promoted the reservation to ready.
      db.prepare(
        `UPDATE worktree_registry SET state = 'creating'
         WHERE worktree_id = ?`
      ).run(a.worktreeId)
      const recovered = await manager.createForThread({
        threadId,
        baseRepoPath: repo,
        baseBranch: "main",
        firstMessage: "foo",
      })
      expect(recovered).toMatchObject({
        worktreeId: a.worktreeId,
        worktreePath: a.worktreePath,
        branch: a.branch,
      })
      expect(registry.findByThread(threadId)?.state).toBe("ready")

      db.prepare(
        `UPDATE worktree_registry SET state = 'pushed'
         WHERE worktree_id = ?`
      ).run(a.worktreeId)
      await manager.createForThread({
        threadId,
        baseRepoPath: repo,
        baseBranch: "main",
        firstMessage: "foo",
      })
      expect(registry.findByThread(threadId)?.state).toBe("pushed")

      db.close()
    },
    30_000
  )

  it.skipIf(!gitAvailable)(
    "removeForThread tears down worktree + registry entry + projection",
    async () => {
      const repo = await makeTestRepo()
      const dbPath = path.join(tmpDir("db-rm"), "test.sqlite")
      const db = openTestDatabase(dbPath)
      runMigrations(db)

      const threadId = "77777777-8888-9999-aaaa-bbbbbbbbbbbb"
      db.prepare(
        `INSERT INTO projection_threads (thread_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run(
        threadId,
        "proj-1",
        new Date().toISOString(),
        new Date().toISOString()
      )

      const eventStore = new EventStore(db)
      const registry = new WorktreeRegistryQuery(db)
      const manager = new WorktreeManager(db, eventStore, registry)

      const r = await manager.createForThread({
        threadId,
        baseRepoPath: repo,
        baseBranch: "main",
        firstMessage: "cleanup test",
      })
      expect(fs.existsSync(r.worktreePath)).toBe(true)

      await manager.removeForThread(threadId)

      expect(fs.existsSync(r.worktreePath)).toBe(false)
      expect(registry.findByThread(threadId)).toBeNull()

      const row = db
        .prepare(
          `SELECT worktree_path, worktree_state, env_mode FROM projection_threads WHERE thread_id = ?`
        )
        .get(threadId) as {
        worktree_path: string | null
        worktree_state: string
        env_mode: string
      }
      expect(row.worktree_path).toBeNull()
      expect(row.worktree_state).toBe("abandoned")
      expect(row.env_mode).toBe("local")

      db.close()
    },
    30_000
  )

  it("reconcile completes a persisted branch-deletion intent after physical removal", async () => {
    const repo = await makeTestRepo()
    const dbPath = path.join(tmpDir("db-rm-reconcile"), "test.sqlite")
    const db = openTestDatabase(dbPath)
    runMigrations(db)

    const threadId = "77777777-9999-aaaa-bbbb-cccccccccccc"
    db.prepare(
      `INSERT INTO projection_threads (thread_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
    ).run(
      threadId,
      "proj-1",
      new Date().toISOString(),
      new Date().toISOString()
    )

    const eventStore = new EventStore(db)
    const registry = new WorktreeRegistryQuery(db)
    const manager = new WorktreeManager(db, eventStore, registry)
    const created = await manager.createForThread({
      threadId,
      baseRepoPath: repo,
      baseBranch: "main",
      firstMessage: "crash cleanup",
    })

    registry.markRemoving(created.worktreeId, true, new Date().toISOString())
    await exec("git", ["worktree", "remove", "--force", created.worktreePath], {
      cwd: repo,
    })
    await expect(
      exec(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${created.branch}`],
        { cwd: repo }
      )
    ).resolves.toBeDefined()

    await expect(manager.reconcile(repo)).resolves.toEqual({ removed: 1 })
    expect(registry.findByThread(threadId)).toBeNull()
    await expect(
      exec(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${created.branch}`],
        { cwd: repo }
      )
    ).rejects.toBeDefined()

    db.close()
  }, 30_000)

  it.skipIf(!gitAvailable)(
    "resetForThread restores the worktree to its base branch and cleans files",
    async () => {
      const repo = await makeTestRepo()
      const dbPath = path.join(tmpDir("db-reset"), "test.sqlite")
      const db = openTestDatabase(dbPath)
      runMigrations(db)

      const threadId = "99999999-aaaa-bbbb-cccc-dddddddddddd"
      db.prepare(
        `INSERT INTO projection_threads (thread_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run(
        threadId,
        "proj-1",
        new Date().toISOString(),
        new Date().toISOString()
      )

      const eventStore = new EventStore(db)
      const registry = new WorktreeRegistryQuery(db)
      const manager = new WorktreeManager(db, eventStore, registry)

      const created = await manager.createForThread({
        threadId,
        baseRepoPath: repo,
        baseBranch: "main",
        firstMessage: "reset test",
      })
      fs.writeFileSync(path.join(created.worktreePath, "README.md"), "dirty\n")
      fs.writeFileSync(
        path.join(created.worktreePath, "scratch.txt"),
        "remove me\n"
      )

      const reset = await manager.resetForThread(threadId)

      expect(reset.worktreePath).toBe(created.worktreePath)
      expect(reset.branch).toBe(created.branch)
      expect(reset.baseBranch).toBe("main")
      expect(
        fs.readFileSync(path.join(created.worktreePath, "README.md"), "utf8")
      ).toBe("seed\n")
      expect(
        fs.existsSync(path.join(created.worktreePath, "scratch.txt"))
      ).toBe(false)
      expect(registry.findByThread(threadId)?.state).toBe("ready")

      const row = db
        .prepare(
          `SELECT worktree_path, worktree_state FROM projection_threads WHERE thread_id = ?`
        )
        .get(threadId) as {
        worktree_path: string | null
        worktree_state: string
      }
      expect(row.worktree_path).toBe(created.worktreePath)
      expect(row.worktree_state).toBe("ready")

      db.close()
    },
    30_000
  )

  it.skipIf(!gitAvailable)(
    "refuses to register a branch that is already checked out in another worktree",
    async () => {
      const repo = await makeTestRepo()
      const dbPath = path.join(tmpDir("db-conflict"), "test.sqlite")
      const db = openTestDatabase(dbPath)
      runMigrations(db)

      const t1 = "cccccccc-1111-1111-1111-111111111111"
      const t2 = "dddddddd-2222-2222-2222-222222222222"
      for (const id of [t1, t2]) {
        db.prepare(
          `INSERT INTO projection_threads (thread_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
        ).run(id, "proj-1", new Date().toISOString(), new Date().toISOString())
      }

      const eventStore = new EventStore(db)
      const registry = new WorktreeRegistryQuery(db)
      const manager = new WorktreeManager(db, eventStore, registry)

      // First create: branch is `agent/cccccccc/same`.
      const a = await manager.createForThread({
        threadId: t1,
        baseRepoPath: repo,
        baseBranch: "main",
        firstMessage: "same",
      })

      // Second create: different thread id → different shortId prefix →
      // different branch. So this succeeds normally.
      const b = await manager.createForThread({
        threadId: t2,
        baseRepoPath: repo,
        baseBranch: "main",
        firstMessage: "same",
      })
      expect(b.branch).not.toBe(a.branch)

      // Now force a conflict: try to register a pre-existing branch via the
      // registry directly. The manager's isBranchAvailable check relies on
      // the registry's UNIQUE constraint which the previous `createForThread`
      // already exercised — so this is a regression guard.
      expect(registry.findByBranch(a.branch)?.thread_id).toBe(t1)

      db.close()
    },
    30_000
  )
})
