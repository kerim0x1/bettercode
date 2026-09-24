import { routingTestServices } from "../testUtils/routing-services"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { checkpointRefForThreadTurn } from "@betterc0de/schema"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import { buildApp } from "./router"
import { captureCheckpoint } from "../services/git"

function makeConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 3773,
    dataDir: "/tmp/betterc0de-test",
    dbPath: "/tmp/betterc0de-test/betterc0de.db",
    settingsPath: "/tmp/betterc0de-test/settings.json",
    authPath: "/tmp/betterc0de-test/auth.json",
    logsDir: "/tmp/betterc0de-test/logs",
    providerLogsDir: "/tmp/betterc0de-test/logs/provider",
    providerEventLogPath: "/tmp/betterc0de-test/logs/provider/events.log",
    authToken: "secret",
  }
}

interface TestCommandReceipt {
  command_id: string
  status: string
  result_json: string | null
  request_hash: string | null
  created_at: string
}

function makeState(
  receipts = new Map<string, TestCommandReceipt>(),
  approvedRoots: readonly string[] = []
): AppState {
  return {
    ...routingTestServices(),
    providerRegistry: { all: () => [] },
    db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
    projectProjections: {
      listAll: () =>
        approvedRoots.map((projectPath) => ({ path: projectPath })),
    },
    threads: { listProjects: () => [] },
    worktreeRegistry: { listAll: () => [] },
    receiptStore: {
      find: (commandId: string) => receipts.get(commandId) ?? null,
      insert: (receipt: {
        command_id: string
        status: string
        result_json: string | null
        request_hash: string | null
        created_at: string
      }) => {
        if (receipts.has(receipt.command_id)) throw new Error("duplicate")
        receipts.set(receipt.command_id, receipt)
      },
      complete: (input: {
        commandId: string
        requestHash: string
        resultJson: string
      }) => {
        const receipt = receipts.get(input.commandId)
        if (
          !receipt ||
          receipt.status !== "prepared" ||
          receipt.request_hash !== input.requestHash
        ) {
          return false
        }
        receipt.status = "completed"
        receipt.result_json = input.resultJson
        return true
      },
    },
  } as unknown as AppState
}

describe("git checkpoint routes", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reads lifecycle checkpoints but rejects raw capture, restore and deletion", async () => {
    const cwd = createRepo(tempDirs)
    const app = buildApp(makeConfig(), makeState(undefined, [cwd]))
    const headers = {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    }
    const fromRef = checkpointRefForThreadTurn("thread-route", 0)
    const toRef = checkpointRefForThreadTurn("thread-route", 1)

    await captureCheckpoint({ cwd, checkpointRef: fromRef })

    fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8")
    await captureCheckpoint({ cwd, checkpointRef: toRef })
    const baselineCommit = runGit(cwd, ["rev-parse", fromRef])
    const captureResponse = await app.request(
      "/api/v1/git/checkpoints/capture",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ cwd, checkpointRef: fromRef }),
      }
    )
    expect(captureResponse.status).toBe(410)
    expect(await captureResponse.json()).toMatchObject({
      code: "checkpoint_capture_requires_turn_lifecycle",
    })
    expect(runGit(cwd, ["rev-parse", fromRef])).toBe(baselineCommit)

    expect(
      await postJson(app, "/api/v1/git/checkpoints/has", headers, {
        cwd,
        checkpointRef: toRef,
      })
    ).toEqual({ exists: true })

    const diff = await postJson(app, "/api/v1/git/checkpoints/diff", headers, {
      cwd,
      fromCheckpointRef: fromRef,
      toCheckpointRef: toRef,
    })
    expect(diff).toMatchObject({ diff: expect.stringContaining("+v2") })

    const restoreResponse = await app.request(
      "/api/v1/git/checkpoints/restore",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          cwd,
          checkpointRef: fromRef,
        }),
      }
    )
    expect(restoreResponse.status).toBe(410)
    expect(await restoreResponse.json()).toMatchObject({
      code: "checkpoint_restore_requires_thread_saga",
    })
    expect(fs.readFileSync(path.join(cwd, "README.md"), "utf8")).toBe("v2\n")

    const deleteResponse = await app.request("/api/v1/git/checkpoints/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({
        cwd,
        checkpointRefs: [fromRef, toRef],
      }),
    })
    expect(deleteResponse.status).toBe(410)
    expect(await deleteResponse.json()).toMatchObject({
      code: "checkpoint_delete_requires_cleanup_saga",
    })
  }, 30_000)

  it("returns the cleanup-saga error before any raw checkpoint deletion", async () => {
    const app = buildApp(makeConfig(), {
      ...makeState(),
      checkpointReverts: {
        blockingThreadForCwd: () => "thread-recovery",
      },
    } as unknown as AppState)
    const checkpointRef = checkpointRefForThreadTurn("thread-recovery", 1)

    const response = await app.request("/api/v1/git/checkpoints/delete", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cwd: "/repo",
        checkpointRefs: [checkpointRef],
      }),
    })

    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({
      code: "checkpoint_delete_requires_cleanup_saga",
    })
  })
})

describe("git branch and worktree routes", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("blocks every Git mutation for an explicitly untrusted workspace", async () => {
    const cwd = createRepo(tempDirs)
    fs.writeFileSync(path.join(cwd, "README.md"), "untrusted edit\n", "utf8")
    const app = buildApp(makeConfig(), {
      ...makeState(undefined, [cwd]),
      agentPermissions: {
        assertWorkspaceTrusted: (input: {
          workspacePath: string
          operation: string
        }) => {
          throw Object.assign(
            new Error(
              `Workspace '${input.workspacePath}' is not trusted for ${input.operation}.`
            ),
            { statusCode: 403, code: "workspace_untrusted" }
          )
        },
      },
    } as unknown as AppState)

    const response = await app.request("/api/v1/git/stage-all", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cwd }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "workspace_untrusted" })
    expect(runGit(cwd, ["diff", "--cached"])).toBe("")
  })

  it("renames branches and manages worktrees through the HTTP API", async () => {
    const cwd = createRepo(tempDirs)
    const worktreeParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-worktree-route-")
    )
    tempDirs.push(worktreeParent)
    const worktreePath = path.join(worktreeParent, "feature")
    const app = buildApp(
      makeConfig(),
      makeState(undefined, [cwd, worktreeParent])
    )
    const headers = {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    }

    expect(
      await postJson(app, "/api/v1/git/branch/rename", headers, {
        cwd,
        oldName: "main",
        newName: "trunk",
      })
    ).toEqual({ ok: true })
    expect(runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(
      "trunk"
    )

    expect(
      await postJson(app, "/api/v1/git/worktrees/create", headers, {
        cwd,
        worktreePath,
        branch: "feature/test",
        baseBranch: "trunk",
      })
    ).toEqual({
      path: fs.realpathSync.native(worktreePath),
      branch: "feature/test",
      base: "trunk",
    })

    const worktrees = (await postJson(app, "/api/v1/git/worktrees", headers, {
      cwd,
    })) as Array<{ path: string; branch: string | null }>
    expect(
      worktrees.some(
        (worktree) =>
          worktree.path === fs.realpathSync.native(worktreePath) &&
          worktree.branch === "feature/test"
      )
    ).toBe(true)

    expect(
      await postJson(app, "/api/v1/git/worktrees/remove", headers, {
        cwd,
        worktreePath,
        force: true,
      })
    ).toEqual({ ok: true })
  })

  it("refuses worktree create and remove outside a registered root", async () => {
    const cwd = createRepo(tempDirs)
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-worktree-outside-")
    )
    tempDirs.push(outside)
    const worktreePath = path.join(outside, "feature")
    const app = buildApp(makeConfig(), makeState(undefined, [cwd]))
    const headers = {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    }
    const create = await app.request("/api/v1/git/worktrees/create", {
      method: "POST",
      headers,
      body: JSON.stringify({
        cwd,
        worktreePath,
        branch: "feature/test",
        baseBranch: "main",
      }),
    })
    expect(create.status).toBe(403)
    expect(await create.json()).toMatchObject({
      code: "workspace_not_registered",
    })
    expect(fs.existsSync(worktreePath)).toBe(false)

    fs.mkdirSync(worktreePath)
    const remove = await app.request("/api/v1/git/worktrees/remove", {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd, worktreePath, force: true }),
    })
    expect(remove.status).toBe(403)
    expect(await remove.json()).toMatchObject({
      code: "workspace_not_registered",
    })
    expect(fs.existsSync(worktreePath)).toBe(true)
  })
})

describe("git hunk routes", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("applies only a current exact hunk and reports stale review conflicts", async () => {
    const cwd = createRepo(tempDirs)
    const receipts = new Map<string, TestCommandReceipt>()
    const app = buildApp(makeConfig(), makeState(receipts, [cwd]))
    const headers = {
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    }
    fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8")

    const diffResponse = (await postJson(app, "/api/v1/git/diff", headers, {
      cwd,
    })) as { diff: string }
    const [patch] = testHunkPatches(diffResponse.diff)
    expect(patch).toBeTruthy()

    const acceptRequest = {
      cwd,
      path: "README.md",
      source: "unstaged",
      action: "accept",
      patch,
      operationId: "accept-readme-v2",
    }
    const concurrentResults = await Promise.all([
      postJson(app, "/api/v1/git/hunks/apply", headers, acceptRequest),
      postJson(app, "/api/v1/git/hunks/apply", headers, acceptRequest),
    ])
    for (const result of concurrentResults) {
      expect(result).toMatchObject({
        ok: true,
        action: "accept",
        patchId: expect.stringMatching(/^[a-f0-9]{64}$/),
        applied: true,
      })
    }
    expect(
      concurrentResults.filter(
        (result) =>
          typeof result === "object" &&
          result !== null &&
          "replayed" in result &&
          result.replayed === true
      )
    ).toHaveLength(1)

    // Simulate a process dying after Git accepted the patch but before the
    // durable receipt transitioned from prepared to completed.
    const receipt = receipts.get("git-hunk:accept-readme-v2")
    expect(receipt).toBeTruthy()
    if (!receipt) throw new Error("Expected a prepared hunk receipt")
    receipt.status = "prepared"
    receipt.result_json = null

    expect(
      await postJson(app, "/api/v1/git/hunks/apply", headers, acceptRequest)
    ).toMatchObject({
      ok: true,
      action: "accept",
      applied: true,
      replayed: true,
    })
    expect(runGit(cwd, ["diff", "--cached"])).toContain("+v2")

    runGit(cwd, ["restore", "--staged", "README.md"])
    fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8")
    const conflict = await app.request("/api/v1/git/hunks/apply", {
      method: "POST",
      headers,
      body: JSON.stringify({
        cwd,
        path: "README.md",
        source: "unstaged",
        action: "reject",
        patch,
      }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({
      code: "git_hunk_conflict",
    })
    expect(fs.readFileSync(path.join(cwd, "README.md"), "utf8")).toBe("v3\n")
  })
})

async function postJson(
  app: ReturnType<typeof buildApp>,
  pathName: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const response = await app.request(pathName, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return response.json()
}

function createRepo(tempDirs: string[]): string {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-checkpoint-route-")
  )
  tempDirs.push(cwd)
  runGit(cwd, ["init", "--initial-branch=main"])
  runGit(cwd, ["config", "user.email", "test@example.com"])
  runGit(cwd, ["config", "user.name", "Test User"])
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8")
  runGit(cwd, ["add", "."])
  runGit(cwd, ["commit", "-m", "Initial"])
  return cwd
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
}

function testHunkPatches(diffText: string): string[] {
  const lines = diffText
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/g, "")
    .split("\n")
  const starts = lines
    .map((line, index) => (line.startsWith("@@ ") ? index : -1))
    .filter((index) => index >= 0)
  if (starts.length === 0) return []
  const header = lines
    .slice(0, starts[0])
    .filter((line) => !line.startsWith("index "))
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    return `${[...header, ...lines.slice(start, end)].join("\n")}\n`
  })
}
