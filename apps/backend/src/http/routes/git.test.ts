import { routingTestServices } from "../../testUtils/routing-services"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"

const openTargetMocks = vi.hoisted(() => ({
  detectOpenTargets: vi.fn(),
  launchOpenTarget: vi.fn(),
}))
const gitMocks = vi.hoisted(() => ({
  commit: vi.fn(),
  stage: vi.fn(),
}))

// Only the spawning entry points are mocked; the target-id sets stay real so
// the route validates against exactly what the service knows.
vi.mock("../../services/openTargets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/openTargets")>()),
  ...openTargetMocks,
}))
vi.mock("../../services/git", () => gitMocks)

import type { ServerConfig } from "../../config"
import type { RemoteAccessService } from "../../remote/service"
import { SHELL_TARGET_IDS, TARGET_IDS } from "../../services/openTargets"
import { registerGitRoutes } from "./git"

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

async function registeredWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bc0de-git-route-"))
  temporaryDirectories.push(directory)
  return directory
}

function stateWithRoots(
  roots: readonly string[],
  extra: Record<string, unknown> = {}
): AppState {
  return {
    ...routingTestServices(),
    projectProjections: { listAll: () => roots.map((p) => ({ path: p })) },
    threads: { listProjects: () => [] },
    worktreeRegistry: { listAll: () => [] },
    ...extra,
  } as unknown as AppState
}

async function postJson(
  app: Hono,
  route: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return await app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

const REMOTE_COOKIE = { Cookie: "betterc0de_remote_session=remote-token" }

/** A registered root plus the identity plumbing a paired device needs. */
function remoteState(
  roots: readonly string[],
  options: { accessLevel?: "full" | "read_only"; allowTerminal?: boolean }
): AppState {
  const config: ServerConfig = {
    host: "0.0.0.0",
    port: 3773,
    dataDir: "/tmp/betterc0de-git-route",
    dbPath: "/tmp/betterc0de-git-route/db",
    settingsPath: "/tmp/betterc0de-git-route/settings.json",
    authPath: "/tmp/betterc0de-git-route/auth.json",
    logsDir: "/tmp/betterc0de-git-route/logs",
    providerLogsDir: "/tmp/betterc0de-git-route/logs/provider",
    providerEventLogPath: "/tmp/betterc0de-git-route/logs/provider/events.log",
    authToken: "desktop-secret",
  }
  const remoteAccess = {
    authenticate: (token: string) =>
      token === "remote-token"
        ? {
            id: "remote-session",
            label: "Phone",
            accessLevel: options.accessLevel ?? "full",
            createdAt: "2026-09-11T00:00:00.000Z",
            lastSeenAt: "2026-09-11T00:00:00.000Z",
            expiresAt: "2027-09-11T00:00:00.000Z",
          }
        : null,
    isSessionActive: () => true,
  } as unknown as RemoteAccessService
  return stateWithRoots(roots, {
    config,
    remoteAccess,
    settings: {
      get: () => ({
        remote_access_allow_terminal: options.allowTerminal === true,
      }),
    },
  })
}

describe("git open-target routes", () => {
  beforeEach(() => {
    openTargetMocks.detectOpenTargets.mockReset()
    openTargetMocks.launchOpenTarget.mockReset()
  })

  it("confines open-editor to registered roots without requiring workspace trust", async () => {
    const registered = await registeredWorkspace()
    const outside = await registeredWorkspace()
    // Opening a folder in an editor is how a user *decides* to trust it; an
    // untrusted workspace must still launch. This policy refuses everything.
    const assertWorkspaceTrusted = vi.fn(() => {
      throw Object.assign(
        new Error("The workspace is untrusted and cannot Git mutation."),
        { statusCode: 403, code: "workspace_untrusted" }
      )
    })
    const app = new Hono()
    registerGitRoutes(
      app,
      stateWithRoots([registered], {
        agentPermissions: { assertWorkspaceTrusted },
      })
    )
    openTargetMocks.launchOpenTarget.mockResolvedValue({ ok: true })

    const unregistered = await postJson(app, "/git/open-editor", {
      editor: "vscode",
      path: outside,
    })
    expect(unregistered.status).toBe(403)
    expect(await unregistered.json()).toMatchObject({
      code: "workspace_not_registered",
    })
    expect(openTargetMocks.launchOpenTarget).not.toHaveBeenCalled()

    const allowed = await postJson(app, "/git/open-editor", {
      editor: "vscode",
      path: registered,
    })
    expect(allowed.status, await allowed.clone().text()).toBe(200)
    const canonical = await fs.realpath(registered)
    expect(openTargetMocks.launchOpenTarget).toHaveBeenCalledWith(
      "vscode",
      canonical
    )
    expect(assertWorkspaceTrusted).not.toHaveBeenCalled()
  })

  it("rejects unknown open-editor target ids before touching the filesystem", async () => {
    const registered = await registeredWorkspace()
    const app = new Hono()
    registerGitRoutes(app, stateWithRoots([registered]))

    const response = await postJson(app, "/git/open-editor", {
      editor: "calc.exe",
      path: registered,
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: "open_target_unknown" })
    expect(openTargetMocks.launchOpenTarget).not.toHaveBeenCalled()
  })

  it("accepts exactly the target ids the launch service knows", async () => {
    const registered = await registeredWorkspace()
    const app = new Hono()
    registerGitRoutes(app, stateWithRoots([registered]))
    openTargetMocks.launchOpenTarget.mockResolvedValue({ ok: true })

    // Parity: the route no longer keeps its own copy of the id list, so
    // every id the service can launch must pass the route's precheck.
    expect(TARGET_IDS.size).toBeGreaterThan(0)
    for (const editor of TARGET_IDS) {
      const response = await postJson(app, "/git/open-editor", {
        editor,
        path: registered,
      })
      expect(response.status, editor).toBe(200)
    }
    expect(openTargetMocks.launchOpenTarget).toHaveBeenCalledTimes(
      TARGET_IDS.size
    )
    for (const shellTarget of SHELL_TARGET_IDS) {
      expect(TARGET_IDS.has(shellTarget), shellTarget).toBe(true)
    }
  })

  it("keeps host windows desktop-only for paired devices and gates shells on the terminal grant", async () => {
    const registered = await registeredWorkspace()
    openTargetMocks.launchOpenTarget.mockResolvedValue({ ok: true })

    // No grant: neither an editor window nor a terminal window on the host.
    const ungranted = new Hono()
    registerGitRoutes(ungranted, remoteState([registered], {}))
    const editor = await postJson(
      ungranted,
      "/git/open-editor",
      { editor: "vscode", path: registered },
      REMOTE_COOKIE
    )
    expect(editor.status).toBe(403)
    expect(await editor.json()).toMatchObject({ code: "desktop_only" })
    const terminal = await postJson(
      ungranted,
      "/git/open-editor",
      { editor: "terminal", path: registered },
      REMOTE_COOKIE
    )
    expect(terminal.status).toBe(403)
    expect(await terminal.json()).toMatchObject({
      code: "remote_terminal_disabled",
    })
    expect(openTargetMocks.launchOpenTarget).not.toHaveBeenCalled()

    // Grant on, but a read-only session: still no shell.
    const readOnly = new Hono()
    registerGitRoutes(
      readOnly,
      remoteState([registered], {
        allowTerminal: true,
        accessLevel: "read_only",
      })
    )
    const readOnlyTerminal = await postJson(
      readOnly,
      "/git/open-editor",
      { editor: "git-bash", path: registered },
      REMOTE_COOKIE
    )
    expect(readOnlyTerminal.status).toBe(403)
    expect(await readOnlyTerminal.json()).toMatchObject({
      code: "remote_terminal_disabled",
    })
    expect(openTargetMocks.launchOpenTarget).not.toHaveBeenCalled()

    // Grant on with a full session: the shell targets follow the grant,
    // editors stay desktop-only, and the desktop itself is untouched.
    const granted = new Hono()
    registerGitRoutes(
      granted,
      remoteState([registered], { allowTerminal: true })
    )
    const grantedTerminal = await postJson(
      granted,
      "/git/open-editor",
      { editor: "terminal", path: registered },
      REMOTE_COOKIE
    )
    expect(grantedTerminal.status, await grantedTerminal.clone().text()).toBe(
      200
    )
    const grantedEditor = await postJson(
      granted,
      "/git/open-editor",
      { editor: "vscode", path: registered },
      REMOTE_COOKIE
    )
    expect(grantedEditor.status).toBe(403)
    const desktop = await postJson(
      granted,
      "/git/open-editor",
      { editor: "vscode", path: registered },
      { Authorization: "Bearer desktop-secret" }
    )
    expect(desktop.status, await desktop.clone().text()).toBe(200)
    expect(openTargetMocks.launchOpenTarget).toHaveBeenCalledTimes(2)
  })
})

describe("git mutation serialisation", () => {
  beforeEach(() => {
    gitMocks.commit.mockReset()
    gitMocks.stage.mockReset()
  })

  it("runs two mutations on one checkout one after the other", async () => {
    const registered = await registeredWorkspace()
    const app = new Hono()
    registerGitRoutes(app, stateWithRoots([registered]))
    // Whichever mutation wins the lock first blocks on `gate`; the lock is
    // FIFO on acquisition, not on request arrival, so the test only asserts
    // that no other mutation on this checkout starts while one is running.
    const events: string[] = []
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let started = 0
    const run = async (label: string) => {
      const index = started++
      events.push(`start:${label}`)
      if (index === 0) await gate
      events.push(`end:${label}`)
    }
    gitMocks.commit.mockImplementation(
      async (_cwd: string, message: string) => {
        await run(message)
        return { ok: true }
      }
    )
    gitMocks.stage.mockImplementation(() => run("stage"))

    const requests = [
      postJson(app, "/git/commit", { cwd: registered, message: "first" }),
      postJson(app, "/git/commit", { cwd: registered, message: "second" }),
      postJson(app, "/git/stage", { cwd: registered, paths: ["a"] }),
    ]
    // Only a precondition: the first request has passed routing and the
    // workspace checks. That exceeded vi.waitFor's 1 s default on the macOS
    // Intel runner; the serialisation assertions below are what matter.
    await vi.waitFor(() => expect(started).toBe(1), { timeout: 10_000 })
    // Give the queued requests every chance to (wrongly) enter the repo.
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(events).toHaveLength(1)
    expect(events[0]).toMatch(/^start:/)

    releaseGate()
    const responses = await Promise.all(requests)
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ])
    expect(events).toHaveLength(6)
    for (let index = 0; index < events.length; index += 2) {
      const label = events[index]!.slice("start:".length)
      expect(events[index]).toBe(`start:${label}`)
      expect(events[index + 1]).toBe(`end:${label}`)
    }
  })
})

describe("git open-target detection", () => {
  beforeEach(() => {
    openTargetMocks.detectOpenTargets.mockReset()
  })

  it("awaits an explicit async refresh and preserves the response shape", async () => {
    openTargetMocks.detectOpenTargets.mockResolvedValue([
      {
        id: "vscode",
        label: "VS Code",
        group: "editor",
        available: true,
      },
    ])
    const app = new Hono()
    registerGitRoutes(app, {} as AppState)

    const response = await app.request("/git/open-targets?refresh=true")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      targets: [
        {
          id: "vscode",
          label: "VS Code",
          group: "editor",
          available: true,
        },
      ],
    })
    expect(openTargetMocks.detectOpenTargets).toHaveBeenCalledWith({
      refresh: true,
    })
  })
})
