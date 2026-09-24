import { routingTestServices } from "../../testUtils/routing-services"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import { registerChatRoutes } from "./chat"
import { isScratchWorkspacePath } from "../../services/scratchWorkspace"

const cleanupDirectories: string[] = []

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

describe("chat send workspace and permission trust boundary", () => {
  it("confines remote compaction configuration reads to approved workspaces", async () => {
    const registered = await temporaryDirectory("compaction-registered")
    const outside = await temporaryDirectory("compaction-outside")
    const app = chatApp({
      projects: [registered],
      threadProjectPath: registered,
      startTurn: vi.fn(),
    })
    const read = (cwd: string | undefined, token: string) =>
      app.request("/chat/compaction/decision", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          threadId: "thread-1",
          cwd,
          incomingContent: "continue",
        }),
      })
    const denied = await read(outside, "remote-secret")
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      code: "workspace_not_registered",
    })
    expect((await read(registered, "remote-secret")).status).toBe(200)
    expect((await read(undefined, "remote-secret")).status).toBe(200)
    expect((await read(outside, "desktop-secret")).status).toBe(200)
  })

  it("rejects an unregistered caller-selected workspace before dispatch", async () => {
    const registered = await temporaryDirectory("registered")
    const outside = await temporaryDirectory("outside")
    const startTurn = vi.fn()
    const app = chatApp({
      projects: [registered],
      threadProjectPath: registered,
      startTurn,
    })

    const response = await send(app, {
      projectPath: outside,
    })

    expect(response.status).toBe(403)
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("cannot switch a bound thread to another approved project", async () => {
    const first = await temporaryDirectory("first")
    const second = await temporaryDirectory("second")
    const startTurn = vi.fn()
    const app = chatApp({
      projects: [first, second],
      threadProjectPath: first,
      startTurn,
    })

    const response = await send(app, { projectPath: second })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: "workspace_binding_mismatch",
    })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it("uses a ready thread worktree as the authoritative execution root", async () => {
    const baseRepo = await temporaryDirectory("base")
    const worktreePath = await temporaryDirectory("worktree")
    const worktree = registeredWorktree(baseRepo, worktreePath)
    const startTurn = vi.fn(() => completedTurn())
    const app = chatApp({
      projects: [baseRepo],
      threadProjectPath: baseRepo,
      worktree,
      startTurn,
    })

    const wrongRoot = await send(app, { projectPath: baseRepo })
    expect(wrongRoot.status).toBe(403)
    expect(startTurn).not.toHaveBeenCalled()

    const accepted = await send(app, { projectPath: worktreePath })
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    expect(startTurn).toHaveBeenCalledTimes(1)
    const dispatchedInput = (
      startTurn.mock.calls[0] as unknown as [unknown, Record<string, unknown>]
    )[1]
    expect(dispatchedInput).toMatchObject({
      projectPath: await fs.realpath(worktreePath),
      appMode: "agent",
    })
  })

  it("enforces Agent trust for omitted app mode before provider recovery", async () => {
    const registered = await temporaryDirectory("untrusted")
    const startTurn = vi.fn()
    const evaluateTurnTrust = vi.fn(() => ({
      decision: "deny" as const,
      source: "workspace_trust" as const,
      toolName: "AgentMode",
      reason: "Agent Mode is disabled for this untrusted workspace.",
    }))
    const app = chatApp({
      projects: [registered],
      threadProjectPath: registered,
      startTurn,
      agentPermissions: {
        evaluateTurnTrust,
        hasRestrictiveGrants: vi.fn(() => false),
      },
    })

    const response = await send(app, { projectPath: registered })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: "workspace_untrusted",
    })
    expect(evaluateTurnTrust).toHaveBeenCalledWith({
      workspacePath: await fs.realpath(registered),
      appMode: "agent",
    })
    expect(startTurn).not.toHaveBeenCalled()
  })

  // A chat with no project folder used to be refused outright, which made
  // "just talk to me about an idea" impossible. It now runs in a private
  // scratch workspace instead — which is also what keeps it safe, since the
  // adapters would otherwise fall back to BetterC0de's own directory.
  it("runs a project-less agent turn in a scratch workspace", async () => {
    const dataDir = await temporaryDirectory("scratch-data")
    const startTurn = vi.fn(() => completedTurn())
    const evaluateTurnTrust = vi.fn((_input: { workspacePath?: unknown }) => ({
      decision: "allow" as const,
      source: "default" as const,
    }))
    const app = chatApp({
      projects: [dataDir],
      threadProjectPath: null,
      startTurn,
      agentPermissions: {
        evaluateTurnTrust,
        hasRestrictiveGrants: vi.fn(() => false),
      },
    })

    const response = await send(app, {})

    expect(response.status).toBe(200)
    expect(startTurn).toHaveBeenCalled()

    const workspacePath = evaluateTurnTrust.mock.calls[0]?.[0]
      ?.workspacePath as string
    expect(workspacePath).toBeTruthy()
    // Inside the app's own scratch tree, never the process working directory.
    expect(
      isScratchWorkspacePath(await fs.realpath(dataDir), workspacePath)
    ).toBe(true)
    expect(workspacePath).not.toBe(process.cwd())
    // And it really exists, so the provider has a directory to run in.
    expect((await fs.stat(workspacePath)).isDirectory()).toBe(true)
  })

  it("lowers restrictive workspaces before dispatch while preserving stricter chat modes", async () => {
    const registered = await temporaryDirectory("restrictive")
    const startTurn = vi.fn(() => completedTurn())
    const app = chatApp({
      projects: [registered],
      threadProjectPath: registered,
      startTurn,
      agentPermissions: {
        evaluateTurnTrust: vi.fn(() => ({
          decision: "allow" as const,
          source: "default" as const,
        })),
        hasRestrictiveGrants: vi.fn(() => true),
      },
    })

    for (const request of [
      {
        permissionLevel: undefined,
        expectedPermissionLevel: "ask-on-edit",
      },
      {
        permissionLevel: "bypass",
        expectedPermissionLevel: "ask-on-edit",
      },
      {
        permissionLevel: "read-only",
        expectedPermissionLevel: "read-only",
      },
      {
        permissionLevel: "bypass",
        chatMode: "plan",
        expectedPermissionLevel: "ask-on-edit",
      },
      {
        permissionLevel: "bypass",
        chatMode: "security",
        expectedPermissionLevel: "ask-on-edit",
      },
    ]) {
      const response = await send(app, {
        projectPath: registered,
        permissionLevel: request.permissionLevel,
        ...(request.chatMode ? { chatMode: request.chatMode } : {}),
      })
      expect(response.status).toBe(200)
      const dispatchedInput = (
        startTurn.mock.calls.at(-1) as unknown as [
          unknown,
          Record<string, unknown>,
        ]
      )[1]
      expect(dispatchedInput).toMatchObject({
        projectPath: await fs.realpath(registered),
        appMode: "agent",
        permissionLevel: request.expectedPermissionLevel,
        ...(request.chatMode ? { chatMode: request.chatMode } : {}),
      })
    }

    // Regression: an ask/deny grant used to be ignored outside Agent Mode, so
    // an Editor-mode turn kept `bypass` — which maps Codex onto
    // `approvalPolicy: "never"` + `danger-full-access`, meaning it never emits
    // an approval request for the hub to intercept and the user's deny grant
    // was silently inert. Grants are scoped to a workspace, not to a UI tab.
    for (const appMode of ["editor", "design"]) {
      const response = await send(app, {
        projectPath: registered,
        appMode,
        permissionLevel: "bypass",
      })
      expect(response.status).toBe(200)
      const dispatched = (
        startTurn.mock.calls.at(-1) as unknown as [
          unknown,
          Record<string, unknown>,
        ]
      )[1]
      expect(dispatched).toMatchObject({
        appMode,
        permissionLevel: "ask-on-edit",
      })
    }
  })
})

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), `betterc0de-chat-trust-${label}-`)
  )
  cleanupDirectories.push(directory)
  return directory
}

function registeredWorktree(baseRepoPath: string, worktreePath: string) {
  return {
    worktree_id: "worktree-1",
    thread_id: "thread-1",
    worktree_path: worktreePath,
    branch: "agent/thread-1/task",
    base_branch: "main",
    base_repo_path: baseRepoPath,
    state: "ready",
    delete_branch_on_remove: 0,
    created_at: "2026-07-24T00:00:00.000Z",
    updated_at: "2026-07-24T00:00:00.000Z",
  }
}

function chatApp(input: {
  readonly projects: readonly string[]
  readonly threadProjectPath: string | null
  readonly worktree?: ReturnType<typeof registeredWorktree>
  readonly startTurn: ReturnType<typeof vi.fn>
  readonly agentPermissions?: Record<string, unknown>
}): Hono {
  const app = new Hono()
  const worktree = input.worktree ?? null
  registerChatRoutes(app, {
    ...routingTestServices(),
    config: {
      dataDir: input.projects[0] ?? process.cwd(),
      authToken: "desktop-secret",
    },
    remoteAccess: {
      authenticate: (token: string) =>
        token === "remote-secret" ? { id: "remote-session" } : null,
    },
    settings: {
      get: () => ({ auto_save_conversations: false }),
    },
    projectProjections: {
      listAll: () =>
        input.projects.map((projectPath) => ({ path: projectPath })),
    },
    threads: {
      listProjects: () => [],
      getThreadProjectPath: () => input.threadProjectPath,
    },
    worktrees: {
      findForThread: () => worktree,
    },
    worktreeRegistry: {
      listAll: () => (worktree ? [worktree] : []),
      findByThread: () => worktree,
    },
    providerSessionBindings: {
      getLatestForThread: () => null,
      getLatestForThreadProvider: () => null,
    },
    providerHub: {
      has: () => true,
      assertCanStartTurn: vi.fn(),
      startTurn: input.startTurn,
    },
    providers: {
      resolveProviderKind: vi.fn(),
    },
    ...(input.agentPermissions
      ? { agentPermissions: input.agentPermissions }
      : {}),
  } as unknown as AppState)
  return app
}

function completedTurn() {
  const completion = Promise.resolve()
  return {
    turnId: "turn-1",
    completion,
    settled: completion,
  }
}

async function send(
  app: Hono,
  overrides: Record<string, unknown>
): Promise<Response> {
  return await app.request("/chat/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "thread-1",
      providerKind: "claude",
      providerInstanceId: "claude-main",
      message: "continue",
      modelId: "claude-opus",
      history: [],
      ...overrides,
    }),
  })
}
