import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { registerThreadsRoutes } from "./threads"

const cleanupDirectories: string[] = []

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

describe("thread worktree trust boundary", () => {
  it("rejects string destructive flags before invoking the worktree manager", async () => {
    const baseRepoPath = await temporaryDirectory("boolean-base")
    const worktreePath = await temporaryDirectory("boolean-worktree")
    const assertWorkspaceTrusted = vi.fn()
    const { app, removeForThread, resetForThread } = worktreeApp({
      baseRepoPath,
      worktreePath,
      assertWorkspaceTrusted,
    })
    for (const [route, body] of [
      ["/threads/thread-1/worktree/remove", { deleteBranch: "false" }],
      ["/threads/thread-1/worktree/remove", { force: "false" }],
      ["/threads/thread-1/worktree/reset", { clean: "false" }],
      ["/threads/thread-1/worktree/reset", { updateSubmodules: "false" }],
    ] as const) {
      expect((await post(app, route, body)).status).toBe(400)
    }
    expect(removeForThread).not.toHaveBeenCalled()
    expect(resetForThread).not.toHaveBeenCalled()
    expect(assertWorkspaceTrusted).not.toHaveBeenCalled()
  })

  it("trust-checks canonical base and worktree roots before create/remove/reset", async () => {
    const baseRepoPath = await temporaryDirectory("base")
    const worktreePath = await temporaryDirectory("worktree")
    const assertWorkspaceTrusted = vi.fn()
    const { app, createForThread, removeForThread, resetForThread } =
      worktreeApp({
        baseRepoPath,
        worktreePath,
        assertWorkspaceTrusted,
      })

    expect(
      (
        await post(app, "/threads/create-thread/worktree", {
          baseRepoPath: path.join(baseRepoPath, "."),
          baseBranch: "main",
        })
      ).status
    ).toBe(200)
    expect(
      (
        await post(app, "/threads/thread-1/worktree/remove", {
          deleteBranch: false,
          force: true,
        })
      ).status
    ).toBe(200)
    expect(
      (
        await post(app, "/threads/thread-1/worktree/reset", {
          clean: true,
          updateSubmodules: true,
        })
      ).status
    ).toBe(200)

    const canonicalBase = await fs.realpath(baseRepoPath)
    const canonicalWorktree = await fs.realpath(worktreePath)
    expect(assertWorkspaceTrusted.mock.calls).toEqual([
      [
        {
          workspacePath: canonicalBase,
          operation: "create a thread worktree",
        },
      ],
      [
        {
          workspacePath: canonicalBase,
          operation: "remove a thread worktree",
        },
      ],
      [
        {
          workspacePath: canonicalWorktree,
          operation: "remove a thread worktree",
        },
      ],
      [
        {
          workspacePath: canonicalBase,
          operation: "reset a thread worktree",
        },
      ],
      [
        {
          workspacePath: canonicalWorktree,
          operation: "reset a thread worktree",
        },
      ],
    ])
    expect(createForThread).toHaveBeenCalledWith({
      threadId: "create-thread",
      baseRepoPath: canonicalBase,
      baseBranch: "main",
      firstMessage: null,
    })
    expect(removeForThread).toHaveBeenCalledTimes(1)
    expect(resetForThread).toHaveBeenCalledTimes(1)
  })

  it("blocks all worktree mutations before their managers run", async () => {
    const baseRepoPath = await temporaryDirectory("blocked-base")
    const worktreePath = await temporaryDirectory("blocked-worktree")
    const assertWorkspaceTrusted = vi.fn(() => {
      throw Object.assign(new Error("workspace is untrusted"), {
        statusCode: 403,
        code: "workspace_untrusted",
      })
    })
    const { app, createForThread, removeForThread, resetForThread } =
      worktreeApp({
        baseRepoPath,
        worktreePath,
        assertWorkspaceTrusted,
      })

    for (const [route, body] of [
      ["/threads/create-thread/worktree", { baseRepoPath, baseBranch: "main" }],
      [
        "/threads/thread-1/worktree/remove",
        { deleteBranch: false, force: true },
      ],
      [
        "/threads/thread-1/worktree/reset",
        { clean: true, updateSubmodules: true },
      ],
    ] as const) {
      const response = await post(app, route, body)
      expect(response.status, route).toBe(403)
      expect(await response.json()).toMatchObject({
        code: "workspace_untrusted",
      })
    }
    expect(createForThread).not.toHaveBeenCalled()
    expect(removeForThread).not.toHaveBeenCalled()
    expect(resetForThread).not.toHaveBeenCalled()
  })
})

function worktreeApp(input: {
  readonly baseRepoPath: string
  readonly worktreePath: string
  readonly assertWorkspaceTrusted: ReturnType<typeof vi.fn>
}) {
  const entry = {
    worktree_id: "worktree-1",
    thread_id: "thread-1",
    worktree_path: input.worktreePath,
    branch: "agent/thread-1/task",
    base_branch: "main",
    base_repo_path: input.baseRepoPath,
    state: "ready",
    delete_branch_on_remove: 0,
    created_at: "2026-07-24T00:00:00.000Z",
    updated_at: "2026-07-24T00:00:00.000Z",
  }
  const createForThread = vi.fn(async () => ({
    worktreeId: "created-worktree",
    threadId: "create-thread",
    worktreePath: input.worktreePath,
    branch: "agent/create-thread/task",
    baseBranch: "main",
    headSha: null,
  }))
  const removeForThread = vi.fn(async () => undefined)
  const resetForThread = vi.fn(async () => ({
    worktreeId: entry.worktree_id,
    threadId: entry.thread_id,
    worktreePath: entry.worktree_path,
    branch: entry.branch,
    baseBranch: entry.base_branch,
    headSha: null,
  }))
  const app = new Hono()
  registerThreadsRoutes(app, {
    projectProjections: {
      listAll: () => [{ path: input.baseRepoPath }],
    },
    threads: {
      listProjects: () => [],
      getThreadProjectPath: () => input.baseRepoPath,
    },
    worktreeRegistry: {
      listAll: () => [entry],
      findByThread: (threadId: string) =>
        threadId === entry.thread_id ? entry : null,
    },
    worktrees: {
      findForThread: (threadId: string) =>
        threadId === entry.thread_id ? entry : null,
      createForThread,
      removeForThread,
      resetForThread,
    },
    agentPermissions: {
      assertWorkspaceTrusted: input.assertWorkspaceTrusted,
    },
  } as unknown as AppState)
  return { app, createForThread, removeForThread, resetForThread }
}

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), `betterc0de-worktree-trust-${label}-`)
  )
  cleanupDirectories.push(directory)
  return directory
}

async function post(
  app: Hono,
  route: string,
  body: Record<string, unknown>
): Promise<Response> {
  return await app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
