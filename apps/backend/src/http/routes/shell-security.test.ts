import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppState } from "../../appState"
import type { ServerConfig } from "../../config"
import type { RemoteAccessService } from "../../remote/service"
import { runShellCommand, type RunShellInput } from "../../services/shell"
import {
  closeTerminalPtySession,
  openTerminalPtySession,
  readTerminalPtySession,
  resizeTerminalPtySession,
} from "../../services/terminalPty"
import { stopAllToolOutputArchiveStores } from "../../services/tool-output-archive-store"
import { registerShellRoutes } from "./shell"

vi.mock("../../services/shell", () => ({
  abortShellSession: vi.fn(() => false),
  detectShells: vi.fn(async () => []),
  runShellCommand: vi.fn(async (input: { sessionId?: string }) => ({
    success: true,
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    combined: "ok",
    sessionId: input.sessionId ?? "generated",
    aborted: false,
    timedOut: false,
  })),
}))

vi.mock("../../services/workspace", () => ({
  getProjectShell: vi.fn(async () => undefined),
  getProjectToolOutputLimits: vi.fn(async () => ({
    maxLines: 2_000,
    maxBytes: 50 * 1024,
  })),
  listProjectPermissions: vi.fn(async () => []),
}))

vi.mock("../../services/terminalPty", () => ({
  closeTerminalPtySession: vi.fn(() => false),
  openTerminalPtySession: vi.fn(),
  readTerminalPtySession: vi.fn(() => null),
  resizeTerminalPtySession: vi.fn(() => false),
  shutdownTerminalPtySessionsForOwner: vi.fn(async () => undefined),
  terminalPtySessionCwd: vi.fn(() => null),
  writeTerminalPtySession: vi.fn(() => false),
}))

const temporaryDirectories: string[] = []

beforeEach(() => {
  vi.mocked(openTerminalPtySession).mockReset()
  vi.mocked(readTerminalPtySession).mockClear()
  vi.mocked(resizeTerminalPtySession).mockClear()
  vi.mocked(closeTerminalPtySession).mockClear()
  vi.mocked(runShellCommand)
    .mockReset()
    .mockImplementation(async (input: RunShellInput) => ({
      success: true,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      combined: "ok",
      sessionId: input.sessionId ?? "generated",
      aborted: false,
      timedOut: false,
    }))
})

afterEach(async () => {
  await stopAllToolOutputArchiveStores()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function makeApp(
  options: {
    remoteToken?: string
    remoteAccessLevel?: "full" | "read_only"
    /** The desktop owner's `remote_access_allow_terminal` grant. */
    allowRemoteTerminal?: boolean
  } = {}
): {
  app: Hono
  workspace: string
} {
  const api = new Hono()
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-shell-route-")
  )
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "betterc0de-shell-cwd-")
  )
  temporaryDirectories.push(workspace)
  temporaryDirectories.push(dataDir)
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 3773,
    dataDir,
    dbPath: path.join(dataDir, "db"),
    settingsPath: path.join(dataDir, "settings.json"),
    authPath: path.join(dataDir, "auth.json"),
    logsDir: path.join(dataDir, "logs"),
    providerLogsDir: path.join(dataDir, "logs", "provider"),
    providerEventLogPath: path.join(dataDir, "logs", "provider", "events.log"),
    authToken: "secret",
  }
  const remoteAccess = options.remoteToken
    ? ({
        authenticate: (token: string) =>
          token === options.remoteToken
            ? {
                id: "remote-session",
                label: "Paired browser",
                accessLevel: options.remoteAccessLevel ?? "full",
                createdAt: "2026-07-21T12:00:00.000Z",
                lastSeenAt: "2026-07-21T12:00:00.000Z",
                expiresAt: "2027-01-21T12:00:00.000Z",
              }
            : null,
        isSessionActive: () => true,
      } as unknown as RemoteAccessService)
    : undefined
  registerShellRoutes(api, config, remoteAccess, {
    projectProjections: { listAll: () => [{ path: workspace }] },
    threads: { listProjects: () => [] },
    worktreeRegistry: { listAll: () => [] },
    settings: {
      get: () => ({
        remote_access_allow_terminal: options.allowRemoteTerminal === true,
      }),
    },
  } as unknown as AppState)
  return { app: api, workspace }
}

const REMOTE = { Cookie: "betterc0de_remote_session=remote-session-token" }

async function post(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("shell route security boundaries", () => {
  it("requires a matching one-shot capability for human bypass", async () => {
    const { app, workspace } = makeApp()
    const request = {
      command: "echo ok",
      cwd: workspace,
      humanOrigin: true,
      permissionLevel: "bypass",
    }

    expect((await post(app, "/shell/run", request)).status).toBe(403)

    expect(
      (
        await post(app, "/shell/capability", {
          operation: "run",
          command: request.command,
          cwd: request.cwd,
        })
      ).status
    ).toBe(403)

    const grant = await post(
      app,
      "/shell/capability",
      {
        operation: "run",
        command: request.command,
        cwd: request.cwd,
      },
      { "X-BetterC0de-Human-Capability": "secret" }
    )
    expect(grant.status).toBe(200)
    const { capability } = (await grant.json()) as { capability: string }

    expect(
      (
        await post(app, "/shell/run", {
          ...request,
          humanCapability: capability,
        })
      ).status
    ).toBe(200)
    expect(
      (
        await post(app, "/shell/run", {
          ...request,
          humanCapability: capability,
        })
      ).status
    ).toBe(403)
  })

  it("rejects caller-asserted bypass without a trusted human capability", async () => {
    const { app, workspace } = makeApp()

    const response = await post(app, "/shell/run", {
      command: "echo compromised",
      cwd: workspace,
      permissionLevel: "bypass",
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ decision: "deny" })
  })

  it("refuses a paired remote session a terminal until the desktop owner allows it", async () => {
    const { app, workspace } = makeApp({ remoteToken: "remote-session-token" })
    const remote = REMOTE
    const command = "echo from phone"

    // A bearer proves session possession, not a human at this keyboard;
    // with `remote_access_allow_terminal` off (the default) the refusal
    // names the switch rather than a generic desktop-only error.
    const grant = await post(
      app,
      "/shell/capability",
      { operation: "run", command, cwd: workspace },
      remote
    )
    expect(grant.status).toBe(403)
    expect(await grant.json()).toMatchObject({
      code: "remote_terminal_disabled",
    })

    // Asserting human origin / bypass from a remote session is refused
    // outright, even with a (forged) capability token attached.
    const bypass = await post(
      app,
      "/shell/run",
      {
        command,
        cwd: workspace,
        humanOrigin: true,
        permissionLevel: "bypass",
        humanCapability: "forged-capability",
      },
      remote
    )
    expect(bypass.status).toBe(403)
    expect(await bypass.json()).toMatchObject({
      decision: "deny",
      code: "remote_terminal_disabled",
    })

    // Without human origin the command goes through ordinary classification:
    // a shell command is `execute`, which even `allow-edits` only *asks* for.
    const classified = await post(
      app,
      "/shell/run",
      { command, cwd: workspace, permissionLevel: "allow-edits" },
      remote
    )
    expect(classified.status).toBe(403)
    expect(await classified.json()).toMatchObject({ decision: "ask" })

    const pty = await post(
      app,
      "/shell/pty/open",
      {
        sessionId: "remote-pty",
        cwd: workspace,
        humanOrigin: true,
        permissionLevel: "bypass",
        humanCapability: "forged-capability",
      },
      remote
    )
    expect(pty.status).toBe(403)
    expect(await pty.json()).toMatchObject({ code: "remote_terminal_disabled" })
    const write = await post(
      app,
      "/shell/pty/write",
      {
        sessionId: "remote-pty",
        data: "rm -rf /\n",
        humanOrigin: true,
        permissionLevel: "bypass",
        humanCapability: "forged-capability",
      },
      remote
    )
    expect(write.status).toBe(403)
    expect(await write.json()).toMatchObject({
      code: "remote_terminal_disabled",
    })
    expect(runShellCommand).not.toHaveBeenCalled()
    expect(openTerminalPtySession).not.toHaveBeenCalled()
  })

  it("stops a paired device streaming, resizing or closing a PTY once the grant is off", async () => {
    // The device opened the PTY while the grant was on; the desktop owner
    // then turned "Allow terminal from remote devices" off. The host tears
    // the PTY down, and until that lands the device may not touch it.
    const { app } = makeApp({ remoteToken: "remote-session-token" })
    const cases: Array<[string, Record<string, unknown>]> = [
      ["/shell/pty/read", { sessionId: "remote-pty", cursor: 0 }],
      ["/shell/pty/resize", { sessionId: "remote-pty", cols: 80, rows: 24 }],
      ["/shell/pty/close", { sessionId: "remote-pty" }],
    ]
    for (const [route, body] of cases) {
      const response = await post(app, route, body, REMOTE)
      expect(response.status, route).toBe(403)
      expect(await response.json()).toMatchObject({
        code: "remote_terminal_disabled",
      })
    }
    expect(readTerminalPtySession).not.toHaveBeenCalled()
    expect(resizeTerminalPtySession).not.toHaveBeenCalled()
    expect(closeTerminalPtySession).not.toHaveBeenCalled()

    // Read-only session, grant on: same answer.
    const { app: readOnly } = makeApp({
      remoteToken: "remote-session-token",
      remoteAccessLevel: "read_only",
      allowRemoteTerminal: true,
    })
    const readOnlyRead = await post(
      readOnly,
      "/shell/pty/read",
      cases[0]![1],
      REMOTE
    )
    expect(readOnlyRead.status).toBe(403)
    expect(readTerminalPtySession).not.toHaveBeenCalled()

    // Grant on, full session: the request reaches the PTY service, bound to
    // this session's owner id (404 here — the service is mocked empty).
    const { app: granted } = makeApp({
      remoteToken: "remote-session-token",
      allowRemoteTerminal: true,
    })
    const grantedRead = await post(
      granted,
      "/shell/pty/read",
      cases[0]![1],
      REMOTE
    )
    expect(grantedRead.status).toBe(404)
    expect(readTerminalPtySession).toHaveBeenCalledWith(
      "remote-pty",
      0,
      "remote:remote-session"
    )
    // The desktop is unaffected by the remote grant.
    const desktopRead = await post(granted, "/shell/pty/read", cases[0]![1])
    expect(desktopRead.status).toBe(404)
  })

  it("mints an identity-bound terminal capability for a full remote session once allowed", async () => {
    const { app, workspace } = makeApp({
      remoteToken: "remote-session-token",
      allowRemoteTerminal: true,
    })
    vi.mocked(openTerminalPtySession).mockReturnValueOnce({
      sessionId: "phone-pty",
      pid: 4242,
      cwd: workspace,
      shell: "pwsh",
      command: "pwsh",
      args: [],
      status: "running",
      events: [],
    } as never)

    const grant = await post(
      app,
      "/shell/capability",
      { operation: "pty-open", cwd: workspace, sessionId: "phone-pty" },
      REMOTE
    )
    expect(grant.status).toBe(200)
    const { capability } = (await grant.json()) as { capability: string }

    const pty = await post(
      app,
      "/shell/pty/open",
      {
        sessionId: "phone-pty",
        cwd: workspace,
        humanOrigin: true,
        permissionLevel: "bypass",
        humanCapability: capability,
      },
      REMOTE
    )
    expect(pty.status, await pty.clone().text()).toBe(200)
    expect(openTerminalPtySession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "phone-pty",
        ownerId: "remote:remote-session",
      })
    )
  })

  it("keeps the terminal closed to a read-only remote session even when allowed", async () => {
    const { app, workspace } = makeApp({
      remoteToken: "remote-session-token",
      remoteAccessLevel: "read_only",
      allowRemoteTerminal: true,
    })

    const grant = await post(
      app,
      "/shell/capability",
      { operation: "pty-open", cwd: workspace, sessionId: "phone-pty" },
      REMOTE
    )
    expect(grant.status).toBe(403)
    expect(await grant.json()).toMatchObject({
      code: "remote_terminal_disabled",
    })

    const pty = await post(
      app,
      "/shell/pty/open",
      {
        sessionId: "phone-pty",
        cwd: workspace,
        humanOrigin: true,
        permissionLevel: "bypass",
        humanCapability: "forged-capability",
      },
      REMOTE
    )
    expect(pty.status).toBe(403)
    expect(openTerminalPtySession).not.toHaveBeenCalled()
  })

  it("refuses a desktop-minted capability replayed by a paired session", async () => {
    const { app, workspace } = makeApp({
      remoteToken: "remote-session-token",
      allowRemoteTerminal: true,
    })
    const command = "echo replayed"
    const grant = await post(
      app,
      "/shell/capability",
      { operation: "run", command, cwd: workspace },
      { "X-BetterC0de-Human-Capability": "secret" }
    )
    expect(grant.status).toBe(200)
    const { capability } = (await grant.json()) as { capability: string }
    const request = {
      command,
      cwd: workspace,
      humanOrigin: true,
      permissionLevel: "bypass",
      humanCapability: capability,
    }

    // Same operation, same token, different principal: refused, and the
    // token is not burned by the attempt.
    const replay = await post(app, "/shell/run", request, REMOTE)
    expect(replay.status).toBe(403)
    expect(await replay.json()).toMatchObject({ decision: "deny" })
    expect(runShellCommand).not.toHaveBeenCalled()

    const desktop = await post(app, "/shell/run", request)
    expect(desktop.status).toBe(200)
    expect(runShellCommand).toHaveBeenCalledTimes(1)
  })

  it("uses a global shell bucket instead of caller-selected session ids", async () => {
    // Frozen clock: the bucket refills from `Date.now()`, and eleven requests
    // under parallel suite load can take longer than one refill interval,
    // which would admit the eleventh call and turn this into a flake.
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      const { app, workspace } = makeApp()
      const statuses: number[] = []
      for (let index = 0; index < 11; index += 1) {
        statuses.push(
          (
            await post(app, "/shell/run", {
              command: "git status",
              cwd: workspace,
              sessionId: `rotated-${index}`,
            })
          ).status
        )
      }

      // Untrusted shell execution is denied, but rejected calls still consume
      // the caller bucket and rotating a client-selected session ID cannot evade
      // the eleventh-request limit.
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(403))
      expect(statuses[10]).toBe(429)
    } finally {
      vi.useRealTimers()
    }
  })

  it("returns an owner-bound opaque archive URL without exposing its file path", async () => {
    const { app, workspace } = makeApp({ remoteToken: "remote-session-token" })
    vi.mocked(runShellCommand).mockImplementationOnce(
      async (input: RunShellInput) => {
        expect(input.archivePath).toBeTruthy()
        await fs.promises.writeFile(
          input.archivePath!,
          "complete retained output",
          { flag: "wx", mode: 0o600 }
        )
        return {
          success: true,
          stdout: "preview",
          stderr: "",
          exitCode: 0,
          combined: "preview",
          sessionId: input.sessionId ?? "generated",
          aborted: false,
          timedOut: false,
          stdoutTruncated: true,
          combinedTruncated: true,
          archivePath: input.archivePath,
        }
      }
    )
    const command = "echo lots of output"
    const cwd = workspace
    const localAuth = {
      Authorization: "Bearer secret",
      "X-BetterC0de-Human-Capability": "secret",
    }
    const grant = await post(
      app,
      "/shell/capability",
      { operation: "run", command, cwd },
      localAuth
    )
    const { capability } = (await grant.json()) as { capability: string }

    const response = await post(
      app,
      "/shell/run",
      {
        command,
        cwd,
        humanOrigin: true,
        permissionLevel: "bypass",
        humanCapability: capability,
      },
      { Authorization: localAuth.Authorization }
    )

    expect(response.status).toBe(200)
    const output = (await response.json()) as Record<string, unknown>
    expect(output).not.toHaveProperty("archivePath")
    expect(output).not.toHaveProperty("outputPath")
    expect(output.outputArchiveId).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(output.outputDownloadUrl).toBe(
      `/api/v1/shell/output/${output.outputArchiveId}`
    )
    expect(JSON.stringify(output)).not.toContain(temporaryDirectories.at(-1)!)

    const archivePath = `/shell/output/${output.outputArchiveId}`
    expect((await app.request(archivePath)).status).toBe(401)
    expect(
      (
        await app.request(archivePath, {
          headers: {
            Cookie: "betterc0de_remote_session=remote-session-token",
          },
        })
      ).status
    ).toBe(404)

    const download = await app.request(archivePath, {
      headers: { Authorization: "Bearer secret" },
    })
    expect(download.status).toBe(200)
    expect(download.headers.get("cache-control")).toBe("private, no-store")
    expect(download.headers.get("content-length")).toBe(
      String(Buffer.byteLength("complete retained output"))
    )
    expect(download.headers.get("content-disposition")).toMatch(
      /^attachment; filename="tool-output-[A-Za-z0-9_-]{12}\.txt"$/
    )
    await expect(download.text()).resolves.toBe("complete retained output")
  })

  it("removes a partial archive when shell execution fails", async () => {
    const { app, workspace } = makeApp()
    vi.mocked(runShellCommand).mockImplementationOnce(
      async (input: RunShellInput) => {
        await fs.promises.writeFile(input.archivePath!, "partial output", {
          flag: "wx",
          mode: 0o600,
        })
        throw Object.assign(new Error("Shell execution failed."), {
          statusCode: 500,
        })
      }
    )
    const command = "missing-command"
    const cwd = workspace
    const grant = await post(
      app,
      "/shell/capability",
      { operation: "run", command, cwd },
      {
        Authorization: "Bearer secret",
        "X-BetterC0de-Human-Capability": "secret",
      }
    )
    const { capability } = (await grant.json()) as { capability: string }

    const response = await post(
      app,
      "/shell/run",
      {
        command,
        cwd,
        humanOrigin: true,
        permissionLevel: "bypass",
        humanCapability: capability,
      },
      { Authorization: "Bearer secret" }
    )

    expect(response.status).toBe(500)
    await expect(
      fs.promises.readdir(
        path.join(temporaryDirectories.at(-1)!, "tool-output")
      )
    ).resolves.toEqual([])
  })

  it("rejects shell run against an unregistered cwd", async () => {
    const { app } = makeApp()
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "betterc0de-shell-outside-")
    )
    temporaryDirectories.push(outside)
    const response = await post(app, "/shell/run", {
      command: "echo no",
      cwd: outside,
      permissionLevel: "ask-on-edit",
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: "workspace root is not registered",
      code: "workspace_not_registered",
    })
  })
})
