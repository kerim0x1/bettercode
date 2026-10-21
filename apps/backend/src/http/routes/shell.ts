import type { Context, Hono } from "hono"
import path from "node:path"
import { Readable } from "node:stream"
import type { AppState } from "../../appState"
import type { ServerConfig } from "../../config"
import { detectShells, type RunShellOutput } from "../../services/shell"
import {
  getProjectShell,
  getProjectToolOutputLimits,
  listProjectPermissions,
} from "../../services/workspace"
import {
  shellRunSchema,
  shellAbortSchema,
  terminalOpenSchema,
  terminalWriteSchema,
  terminalResizeSchema,
  terminalReadSchema,
  shellCapabilityRequestSchema,
  toolOutputArchiveIdSchema,
} from "../validation"
import {
  classifyTool,
  evaluatePermission,
  normalizeLevel,
} from "../../provider/permissions"
import { evaluateProjectPermissionRules } from "../../provider/project-permission-rules"
import { sanitizeError } from "../errors"
import { createRateLimiter } from "../middleware/rateLimit"
import {
  LOCAL_SHELL_CAPABILITY_IDENTITY,
  ShellCapabilityIssuer,
  type ShellCapabilityIdentity,
} from "../../security/shellCapability"
import { constantTimeEqual } from "../../security/token"
import {
  resolveRequestIdentity,
  type RemoteRequestIdentity,
} from "../../remote/http"
import type { RemoteAccessService } from "../../remote/service"
import { remoteTerminalRefusal } from "../remoteTerminalPolicy"
import {
  ToolOutputArchiveStore,
  type ToolOutputArchiveReservation,
} from "../../services/tool-output-archive-store"
import { logger } from "../../observability/logger"
import {
  acquireCheckpointRecoveryMutationLease,
  withCheckpointRecoveryMutation,
  type CheckpointRecoveryFenceState,
} from "../checkpointRecoveryFence"
import type { WorkspaceRecoveryLease } from "../../services/workspace-recovery-gate"
import type { WorkspaceRegistryState } from "../../services/workspace/authorization"
import { contractJson, contractResult } from "../contracts"
import { resolveApprovedWorkspaceRoot } from "./workspace"

/**
 * What the shell routes need from the backend: the registry that approves a
 * command's or a terminal's workspace, the recovery fence a mutation holds,
 * the terminal grant for paired devices, the terminals and shell commands
 * themselves and the taint a process tree that cannot be ended raises.
 */
export type ShellRouteState = WorkspaceRegistryState &
  CheckpointRecoveryFenceState &
  Pick<AppState, "taintBackend" | "settings" | "terminalPtys" | "shellSessions">

/**
 * Per-session token-bucket limiter for shell endpoints. Each session can
 * burst up to 10 commands, then sustains 10 commands/second. A caller with
 * no sessionId shares the `anonymous` bucket — sufficient for genuine
 * one-off probes (e.g. /shell/detect's first call) and tight enough that a
 * compromised renderer can't loop /shell/run unbounded.
 *
 * Every JSON answer is checked against its shared contract
 * (`@betterc0de/schema/http-contracts`, `shell-contracts.ts`). Requests are
 * parsed here, with the contracts' schemas, because the order of the checks
 * (identity, rate limit, workspace, capability) is part of the security.
 */
export function registerShellRoutes(
  api: Hono,
  config: ServerConfig,
  remoteAccess: RemoteAccessService | undefined,
  state: ShellRouteState
): void {
  const shellRateLimiter = createRateLimiter({
    capacity: 10,
    refillPerSecond: 10,
  })
  // Input to a terminal the caller already owns: every keystroke (coalesced
  // while one is on its way) needs its own `pty-write` capability, so typing
  // has a bucket of its own instead of draining the one that guards running
  // commands and opening terminals.
  const terminalInputRateLimiter = createRateLimiter({
    capacity: 64,
    refillPerSecond: 32,
  })
  const capabilityIssuer = new ShellCapabilityIssuer()
  const archiveStore = new ToolOutputArchiveStore({
    directory: path.join(config.dataDir, "tool-output"),
  })
  const acquireWorkspaceMutationLease = (
    cwd: string
  ): Promise<WorkspaceRecoveryLease | null> =>
    acquireCheckpointRecoveryMutationLease(state, { workspaces: [cwd] })
  const withWorkspaceMutation = <T>(
    cwd: string,
    operation: () => Promise<T> | T
  ): Promise<T> =>
    withCheckpointRecoveryMutation(state, { workspaces: [cwd] }, operation)
  void archiveStore.start().catch((error) => {
    logger.error({ err: error }, "tool output archive store failed to start")
  })
  const identityOf = (c: Context): RemoteRequestIdentity | null =>
    resolveRequestIdentity(c, config, remoteAccess)
  /**
   * Capabilities are bound to the identity that minted them. The desktop
   * host (bearer or capability header, or an unauthenticated unit-test
   * request) is one principal; each paired session is its own.
   */
  const capabilityIdentityOf = (
    identity: RemoteRequestIdentity | null
  ): ShellCapabilityIdentity =>
    identity?.kind === "remote" && identity.session
      ? `remote:${identity.session.id}`
      : LOCAL_SHELL_CAPABILITY_IDENTITY
  /**
   * The 403 to send a paired device that has no terminal grant (see
   * `remoteTerminalRefusal`), or `null` when the caller may proceed.
   */
  const refuseRemoteTerminal = (
    c: Context,
    identity: RemoteRequestIdentity | null,
    extra: Record<string, unknown> = {}
  ): Response | null => {
    const refusal = remoteTerminalRefusal(c, config, identity, state.settings)
    return refusal ? c.json({ ...refusal, ...extra }, 403) : null
  }
  // Every workspace/route failure goes through sanitizeError so the shape
  // (`{ error, code? }`, nominal HttpError message, masked internals) is the
  // same one parseAndHandle and app.onError produce.
  const errorResponse = (c: Context, err: unknown, operation: string) => {
    const { message, statusCode, code } = sanitizeError(err, operation, {
      path: c.req.path,
    })
    return c.json(
      code !== undefined ? { error: message, code } : { error: message },
      statusCode as 400 | 403 | 404 | 409 | 429 | 500 | 503 | 507
    )
  }

  /**
   * Human-origin capabilities are the proof that the *user at the keyboard*
   * typed a command. On the desktop only the Electron main process can
   * present the capability header (it never reaches renderer JS or the
   * network). A paired remote device authenticates with a bearer, which
   * proves possession of a session, not a human at this machine — so it is
   * refused unless the desktop owner has explicitly granted paired devices a
   * terminal (`remote_access_allow_terminal`), and even then only a full
   * session qualifies. The minted capability is bound to that identity.
   */
  api.post("/shell/capability", async (c) => {
    const identity = identityOf(c)
    if (identity?.kind === "remote") {
      const refused = refuseRemoteTerminal(c, identity)
      if (refused) return refused
    } else {
      const capabilitySecret =
        c.req.header("X-BetterC0de-Human-Capability") ?? ""
      const trustedDesktop = Boolean(
        config.authToken &&
        constantTimeEqual(capabilitySecret, config.authToken)
      )
      if (!trustedDesktop) {
        return c.json(
          {
            error: "Shell capabilities require trusted desktop IPC.",
            code: "desktop_only",
          },
          403
        )
      }
    }
    const raw = await c.req.json().catch(() => ({}))
    const result = shellCapabilityRequestSchema.safeParse(raw)
    if (!result.success) {
      return c.json({ error: result.error.message }, 400)
    }
    const limiter =
      result.data.operation === "pty-write"
        ? terminalInputRateLimiter
        : shellRateLimiter
    const limit = limiter.consume(
      shellRateLimitKey(c, config, remoteAccess, identity)
    )
    if (!limit.allowed) {
      return c.json(
        {
          error: "Too many shell capability requests — rate limit exceeded.",
          retryAfterMs: limit.retryAfterMs,
        },
        429
      )
    }
    let capabilityRequest = result.data
    if (
      capabilityRequest.operation === "run" ||
      capabilityRequest.operation === "pty-open"
    ) {
      try {
        capabilityRequest = {
          ...capabilityRequest,
          cwd: await resolveApprovedWorkspaceRoot(state, capabilityRequest.cwd),
        }
      } catch (err) {
        return errorResponse(c, err, "shell capability")
      }
    }
    return contractResult(c, "shellCapability", {
      capability: capabilityIssuer.issue(
        capabilityRequest,
        capabilityIdentityOf(identity)
      ),
    })
  })

  api.get("/shell/output/:archiveId", async (c) => {
    const identity = identityOf(c)
    if (!identity) return c.json({ error: "unauthorized" }, 401)

    const parsedId = toolOutputArchiveIdSchema.safeParse(
      c.req.param("archiveId")
    )
    // Use one not-found response for malformed, missing, and foreign IDs so
    // the route does not become an ownership oracle.
    if (!parsedId.success) {
      return c.json({ error: "Tool output archive not found." }, 404)
    }
    const ownerId = shellRateLimitKey(c, config, remoteAccess, identity)
    try {
      const archive = await archiveStore.openForRead(parsedId.data, ownerId)
      if (!archive) {
        return c.json({ error: "Tool output archive not found." }, 404)
      }
      c.header("Cache-Control", "private, no-store")
      c.header("Content-Type", "text/plain; charset=utf-8")
      c.header("Content-Length", String(archive.size))
      c.header(
        "Content-Disposition",
        `attachment; filename="${archive.filename}"`
      )
      c.header("X-Content-Type-Options", "nosniff")
      c.header("Content-Security-Policy", "default-src 'none'")
      return c.body(Readable.toWeb(archive.stream) as ReadableStream)
    } catch (error) {
      const { message, statusCode } = sanitizeError(
        error,
        "tool output archive download",
        { path: "/shell/output/:archiveId" }
      )
      return c.json({ error: message }, statusCode as 400 | 404 | 500 | 503)
    }
  })

  api.post("/shell/run", async (c) => {
    const raw = await c.req.json().catch(() => ({}))
    const result = shellRunSchema.safeParse(raw)
    if (!result.success) {
      return c.json({ error: result.error.message }, 400)
    }
    const body = result.data

    const identity = identityOf(c)
    const owner = shellOwnerContext(c, config, remoteAccess, identity)
    const ownerId = owner.ownerId
    const limit = shellRateLimiter.consume(ownerId)
    if (!limit.allowed) {
      return c.json(
        {
          error: "Too many shell requests — rate limit exceeded.",
          retryAfterMs: limit.retryAfterMs,
        },
        429
      )
    }

    let cwd: string
    try {
      cwd = await resolveApprovedWorkspaceRoot(state, body.cwd)
    } catch (err) {
      return errorResponse(c, err, "shell run")
    }

    // Gate: classify the command and require an explicit permission level
    // that allows execution. Human-origin terminal calls from the IDE UI
    // pass `humanOrigin:true` + `permissionLevel:"bypass"` so the user can
    // always run commands they typed themselves. Programmatic / LLM callers
    // must obtain user approval and set the permission level accordingly.
    const cls = classifyTool("Bash", { command: body.command })
    const level = normalizeLevel(body.permissionLevel)
    const requestedBypass = level === "bypass"
    // A remote session is human-origin only when the desktop owner granted
    // paired devices a terminal; otherwise it gets the ordinary
    // classification below and no bypass, whatever it asserts.
    if (identity?.kind === "remote" && (body.humanOrigin || requestedBypass)) {
      const refused = refuseRemoteTerminal(c, identity, {
        decision: "deny",
        permissionLevel: level,
      })
      if (refused) return refused
    }
    const requestedHumanBypass = body.humanOrigin && level === "bypass"
    const humanBypass = Boolean(
      requestedHumanBypass &&
      body.humanCapability &&
      capabilityIssuer.consume(
        body.humanCapability,
        {
          operation: "run",
          command: body.command,
          cwd,
          launch: { shell: body.shell, env: body.env },
        },
        capabilityIdentityOf(identity)
      )
    )
    if (requestedBypass && !humanBypass) {
      return c.json(
        {
          error:
            "Shell bypass requires a trusted, operation-bound user capability.",
          decision: "deny",
          permissionLevel: level,
        },
        403
      )
    }
    const decision = humanBypass ? "allow" : evaluatePermission(level, cls)
    if (decision !== "allow") {
      return c.json(
        {
          error:
            decision === "deny"
              ? `Shell command blocked by permission policy (${level}).`
              : `Shell command requires approval — use the agent's approval flow or the terminal UI.`,
          decision,
          permissionLevel: level,
        },
        403
      )
    }

    if (!humanBypass) {
      let projectRule: Awaited<
        ReturnType<typeof resolveProjectShellPermissionRule>
      >
      try {
        projectRule = await resolveProjectShellPermissionRule(cwd, body.command)
      } catch (err) {
        const { message } = sanitizeError(
          err,
          "project shell permission policy",
          { path: "/shell/run" }
        )
        return c.json(
          {
            error: `Project shell permission policy could not be loaded: ${message}`,
            decision: "deny",
            permissionLevel: level,
          },
          503
        )
      }
      if (projectRule && projectRule.action !== "allow") {
        return c.json(
          {
            error:
              projectRule.action === "deny"
                ? `Shell command blocked by BetterC0de project permission rule (${projectRule.sourcePath}).`
                : `Shell command requires approval by BetterC0de project permission rule (${projectRule.sourcePath}).`,
            decision: projectRule.action,
            permissionLevel: level,
            projectPermission: {
              permission: projectRule.permission,
              pattern: projectRule.pattern,
              action: projectRule.action,
              sourcePath: projectRule.sourcePath,
            },
          },
          403
        )
      }
    }

    let archiveReservation: ToolOutputArchiveReservation | undefined
    try {
      return await withWorkspaceMutation(cwd, async () => {
        archiveReservation = await archiveStore.reserve(ownerId)
        const out = await state.shellSessions.runCommand({
          command: body.command,
          cwd,
          shell: await resolveProjectShell(cwd, body.shell),
          env: body.env,
          timeoutMs: body.timeoutMs,
          sessionId: body.sessionId,
          ownerId,
          ownerExpiresAt: owner.expiresAt,
          isOwnerActive: owner.isActive,
          clientInstanceId: clientInstanceIdOf(c),
          archivePath: archiveReservation.filePath,
          maxArchiveBytes: archiveStore.maxArchiveBytes,
        })
        return contractResult(
          c,
          "shellRun",
          await applyProjectToolOutputLimits(
            out,
            cwd,
            archiveStore,
            archiveReservation
          )
        )
      })
    } catch (err) {
      if (archiveReservation) {
        await archiveStore.discard(archiveReservation).catch(() => undefined)
      }
      const { message, statusCode } = sanitizeError(err, "shell run", {
        path: "/shell/run",
        sessionId: body.sessionId,
      })
      return c.json(
        { error: message },
        statusCode as 400 | 403 | 404 | 409 | 429 | 500 | 503 | 507
      )
    }
  })

  // Cancel a running shell session — renderer sends the sessionId it got
  // back from /shell/run (or passed in on that call). Returns 200 on match,
  // 404 otherwise so the UI can tell "already finished" from "abort sent".
  api.post("/shell/abort", async (c) => {
    const raw = await c.req.json().catch(() => ({}))
    const result = shellAbortSchema.safeParse(raw)
    if (!result.success) {
      return c.json({ error: result.error.message }, 400)
    }
    const sessionId = result.data.sessionId

    const owner = shellOwnerContext(c, config, remoteAccess)
    const ownerId = owner.ownerId
    const limit = shellRateLimiter.consume(ownerId)
    if (!limit.allowed) {
      return c.json(
        {
          error: "Too many shell requests — rate limit exceeded.",
          retryAfterMs: limit.retryAfterMs,
        },
        429
      )
    }

    const found = state.shellSessions.abortSession(sessionId, ownerId)
    return contractResult(
      c,
      "shellAbort",
      { aborted: found },
      found ? 200 : 404
    )
  })

  api.get("/shell/detect", async (c) => {
    const limit = shellRateLimiter.consume(
      shellRateLimitKey(c, config, remoteAccess)
    )
    if (!limit.allowed) {
      return c.json(
        {
          error: "Too many shell detection requests — rate limit exceeded.",
          retryAfterMs: limit.retryAfterMs,
        },
        429
      )
    }
    // The detector builds plain records; the contract checks them.
    return contractJson(c, "shellDetect", await detectShells())
  })

  api.post("/shell/pty/open", async (c) => {
    const raw = await c.req.json().catch(() => ({}))
    const result = terminalOpenSchema.safeParse(raw)
    if (!result.success) {
      return c.json({ error: result.error.message }, 400)
    }
    const body = result.data

    const identity = identityOf(c)
    const owner = shellOwnerContext(c, config, remoteAccess, identity)
    const ownerId = owner.ownerId
    const limit = shellRateLimiter.consume(ownerId)
    if (!limit.allowed) {
      return c.json(
        {
          error: "Too many terminal requests — rate limit exceeded.",
          retryAfterMs: limit.retryAfterMs,
        },
        429
      )
    }
    const level = normalizeLevel(body.permissionLevel)
    // Same gate as /shell/run: a paired device opens a PTY only with the
    // desktop owner's explicit grant and a full session.
    const refused = refuseRemoteTerminal(c, identity, {
      decision: "deny",
      permissionLevel: level,
    })
    if (refused) return refused

    let cwd: string
    try {
      cwd = await resolveApprovedWorkspaceRoot(state, body.cwd)
    } catch (err) {
      return errorResponse(c, err, "terminal open")
    }

    const humanBypass = Boolean(
      body.humanOrigin &&
      level === "bypass" &&
      body.humanCapability &&
      capabilityIssuer.consume(
        body.humanCapability,
        {
          operation: "pty-open",
          cwd,
          sessionId: body.sessionId,
          command: body.command,
          launch: { shell: body.shell, args: body.args, env: body.env },
        },
        capabilityIdentityOf(identity)
      )
    )
    if (!humanBypass) {
      return c.json(
        {
          error: "Terminal PTY sessions must be opened by direct user input.",
          decision: "deny",
          permissionLevel: level,
        },
        403
      )
    }

    let workspaceLease: WorkspaceRecoveryLease | null = null
    let leaseTransferred = false
    try {
      workspaceLease = await acquireWorkspaceMutationLease(cwd)
      const snapshot = state.terminalPtys.openSession({
        sessionId: body.sessionId,
        ownerId,
        ...(ownerId === DESKTOP_SHELL_OWNER ? { ownerIsDesktop: true } : {}),
        ownerExpiresAt: owner.expiresAt,
        clientInstanceId: clientInstanceIdOf(c),
        cwd,
        shell: await resolveProjectShell(cwd, body.shell),
        command: body.command,
        args: body.args,
        env: body.env,
        cols: body.cols,
        rows: body.rows,
        onProcessExit: () => workspaceLease?.release(),
        onProcessTreeFailure: (error) =>
          state.taintBackend(error, "terminal pty process tree"),
      })
      leaseTransferred = true
      if (owner.isActive && !owner.isActive()) {
        await state.terminalPtys.shutdownForOwner(ownerId)
        throw Object.assign(
          new Error("Terminal session owner is no longer active."),
          {
            statusCode: 403,
            code: "TERMINAL_PTY_OWNER_INACTIVE",
          }
        )
      }
      return contractResult(c, "terminalOpen", snapshot)
    } catch (err) {
      const { message, statusCode } = sanitizeError(err, "terminal open", {
        path: "/shell/pty/open",
        sessionId: body.sessionId,
      })
      return c.json(
        { error: message },
        statusCode as 400 | 403 | 404 | 409 | 429 | 500 | 503
      )
    } finally {
      if (!leaseTransferred) workspaceLease?.release()
    }
  })

  api.post("/shell/pty/read", async (c) => {
    const raw = await c.req.json().catch(() => ({}))
    const result = terminalReadSchema.safeParse(raw)
    if (!result.success) {
      return c.json({ error: result.error.message }, 400)
    }
    const body = result.data
    // Revoking the grant ends the stream, not just new input: the host tears
    // the PTY down, and until that lands the device may not read from it.
    const identity = identityOf(c)
    const refused = refuseRemoteTerminal(c, identity)
    if (refused) return refused
    const ownerId = shellRateLimitKey(c, config, remoteAccess, identity)
    const snapshot = state.terminalPtys.readSession(
      body.sessionId,
      body.cursor ?? 0,
      ownerId
    )
    if (!snapshot) return c.json({ error: "Terminal session not found." }, 404)
    return contractResult(c, "terminalRead", snapshot)
  })

  api.post("/shell/pty/write", async (c) => {
    const raw = await c.req.json().catch(() => ({}))
    const result = terminalWriteSchema.safeParse(raw)
    if (!result.success) {
      return c.json({ error: result.error.message }, 400)
    }
    const body = result.data
    const identity = identityOf(c)
    const level = normalizeLevel(body.permissionLevel)
    // Revoking the grant (or downgrading the session) cuts off input to a
    // PTY the device already opened; the session itself stays owner-bound.
    const refused = refuseRemoteTerminal(c, identity, {
      decision: "deny",
      permissionLevel: level,
    })
    if (refused) return refused
    const ownerId = shellRateLimitKey(c, config, remoteAccess, identity)
    const sessionCwd = state.terminalPtys.sessionCwd(body.sessionId, ownerId)
    if (!sessionCwd) {
      return c.json({ error: "Terminal session not found." }, 404)
    }
    return await withWorkspaceMutation(sessionCwd, () => {
      const humanBypass = Boolean(
        body.humanOrigin &&
        level === "bypass" &&
        body.humanCapability &&
        capabilityIssuer.consume(
          body.humanCapability,
          {
            operation: "pty-write",
            sessionId: body.sessionId,
            data: body.data,
          },
          capabilityIdentityOf(identity)
        )
      )
      if (!humanBypass) {
        return c.json(
          {
            error: "Terminal PTY writes must be direct user input.",
            decision: "deny",
            permissionLevel: level,
          },
          403
        )
      }
      const ok = state.terminalPtys.writeSession(
        body.sessionId,
        body.data,
        ownerId
      )
      return contractResult(c, "terminalWrite", { ok }, ok ? 200 : 404)
    })
  })

  api.post("/shell/pty/resize", async (c) => {
    const raw = await c.req.json().catch(() => ({}))
    const result = terminalResizeSchema.safeParse(raw)
    if (!result.success) {
      return c.json({ error: result.error.message }, 400)
    }
    const body = result.data
    const identity = identityOf(c)
    const refused = refuseRemoteTerminal(c, identity)
    if (refused) return refused
    const ownerId = shellRateLimitKey(c, config, remoteAccess, identity)
    const ok = state.terminalPtys.resizeSession(
      body.sessionId,
      body.cols,
      body.rows,
      ownerId
    )
    return contractResult(c, "terminalResize", { ok }, ok ? 200 : 404)
  })

  api.post("/shell/pty/close", async (c) => {
    const raw = await c.req.json().catch(() => ({}))
    const result = shellAbortSchema.safeParse(raw)
    if (!result.success) {
      return c.json({ error: result.error.message }, 400)
    }
    // Once the grant is gone the host owns the teardown (see
    // `remoteTerminalRevocationOwners`); the device has nothing left to close.
    const identity = identityOf(c)
    const refused = refuseRemoteTerminal(c, identity)
    if (refused) return refused
    const ok = state.terminalPtys.closeSession(
      result.data.sessionId,
      shellRateLimitKey(c, config, remoteAccess, identity)
    )
    return contractResult(c, "terminalClose", { ok }, ok ? 200 : 404)
  })

  /**
   * End every terminal and shell run one renderer instance started. The
   * desktop owner is a single shared principal, so without this a renderer
   * that crashed or reloaded left its PTYs (a dev server, say) running with
   * nothing attached, still counted against the per-owner limit. A renderer
   * identifies itself with the `X-BetterC0de-Client-Instance` header on the
   * requests that start them; its host releases that id when the renderer is
   * gone. Only the owner's own resources are touched.
   */
  api.post("/shell/client/release", async (c) => {
    const raw = await c.req.json().catch(() => ({}))
    const clientInstanceId =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? normalizeClientInstanceId(
            (raw as { clientInstanceId?: unknown }).clientInstanceId
          )
        : null
    if (!clientInstanceId) {
      return c.json({ error: "A valid clientInstanceId is required." }, 400)
    }
    const identity = identityOf(c)
    const ownerId = shellRateLimitKey(c, config, remoteAccess, identity)
    const limit = shellRateLimiter.consume(ownerId)
    if (!limit.allowed) {
      return c.json(
        {
          error: "Too many shell requests — rate limit exceeded.",
          retryAfterMs: limit.retryAfterMs,
        },
        429
      )
    }
    const [terminals, runs] = await Promise.allSettled([
      state.terminalPtys.shutdownForClientInstance(ownerId, clientInstanceId),
      state.shellSessions.closeSessionsForClientInstance(
        ownerId,
        clientInstanceId
      ),
    ])
    for (const outcome of [terminals, runs]) {
      if (outcome.status === "rejected") {
        logger.warn(
          { err: outcome.reason, clientInstanceId },
          "releasing a renderer's shell resources was incomplete"
        )
      }
    }
    return contractResult(c, "shellClientRelease", {
      terminals: terminals.status === "fulfilled" ? terminals.value : 0,
      runs: runs.status === "fulfilled" ? runs.value : 0,
      complete: terminals.status === "fulfilled" && runs.status === "fulfilled",
    })
  })
}

const CLIENT_INSTANCE_HEADER = "X-BetterC0de-Client-Instance"

/** The owner of everything the desktop app itself starts (bearer or capability). */
const DESKTOP_SHELL_OWNER = "local-owner"

function normalizeClientInstanceId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value)
    ? value
    : null
}

function clientInstanceIdOf(c: Context): string | undefined {
  return (
    normalizeClientInstanceId(c.req.header(CLIENT_INSTANCE_HEADER)) ?? undefined
  )
}

async function applyProjectToolOutputLimits(
  output: RunShellOutput,
  cwd: string,
  archiveStore: ToolOutputArchiveStore,
  archiveReservation: ToolOutputArchiveReservation
): Promise<
  Omit<RunShellOutput, "archivePath" | "archiveTruncated"> & {
    readonly stdoutTruncated?: boolean
    readonly stderrTruncated?: boolean
    readonly combinedTruncated?: boolean
    readonly outputArchiveId?: string
    readonly outputDownloadUrl?: string
    readonly outputArchiveTruncated?: boolean
  }
> {
  const limits = await getProjectToolOutputLimits(cwd).catch(() => ({
    maxLines: 2_000,
    maxBytes: 50 * 1024,
  }))
  const stdoutNeedsTruncation = toolOutputRequiresTruncation(
    output.stdout,
    limits,
    output.stdoutTruncated === true
  )
  const stderrNeedsTruncation = toolOutputRequiresTruncation(
    output.stderr,
    limits,
    output.stderrTruncated === true
  )
  const shouldRetainArchive =
    stdoutNeedsTruncation ||
    stderrNeedsTruncation ||
    output.archiveTruncated === true

  let outputArchiveId: string | undefined
  let outputDownloadUrl: string | undefined
  if (
    shouldRetainArchive &&
    output.archivePath === archiveReservation.filePath
  ) {
    try {
      const committed = await archiveStore.commit(archiveReservation)
      outputArchiveId = committed.id
      outputDownloadUrl = `/api/v1/shell/output/${committed.id}`
    } catch (error) {
      logger.error({ err: error }, "tool output archive commit failed")
    }
  } else {
    await archiveStore.discard(archiveReservation).catch((error) => {
      logger.warn({ err: error }, "tool output archive discard failed")
    })
  }

  const stdout = truncateToolOutputText(output.stdout, limits, {
    archiveId: outputArchiveId,
    archiveDownloadUrl: outputDownloadUrl,
    archiveTruncated: output.archiveTruncated === true,
    forceTruncated: output.stdoutTruncated === true,
  })
  const stderr = truncateToolOutputText(output.stderr, limits, {
    archiveId: outputArchiveId,
    archiveDownloadUrl: outputDownloadUrl,
    archiveTruncated: output.archiveTruncated === true,
    forceTruncated: output.stderrTruncated === true,
  })
  const combined = !stderr.text.trim()
    ? stdout.text
    : !stdout.text.trim()
      ? stderr.text
      : `${stdout.text}\n${stderr.text}`.replace(/\s+$/, "")
  const {
    archivePath: _archivePath,
    archiveTruncated: _archiveTruncated,
    ...publicOutput
  } = output
  return {
    ...publicOutput,
    stdout: stdout.text,
    stderr: stderr.text,
    combined,
    ...(stdout.truncated ? { stdoutTruncated: true } : {}),
    ...(stderr.truncated ? { stderrTruncated: true } : {}),
    ...(stdout.truncated || stderr.truncated
      ? { combinedTruncated: true }
      : {}),
    ...(outputArchiveId ? { outputArchiveId } : {}),
    ...(outputDownloadUrl ? { outputDownloadUrl } : {}),
    ...(output.archiveTruncated ? { outputArchiveTruncated: true } : {}),
  }
}

function toolOutputRequiresTruncation(
  text: string,
  limits: { readonly maxLines: number; readonly maxBytes: number },
  forceTruncated: boolean
): boolean {
  if (forceTruncated) return true
  if (!text) return false
  return (
    text.split("\n").length > limits.maxLines ||
    Buffer.byteLength(text, "utf8") > limits.maxBytes
  )
}

function truncateToolOutputText(
  text: string,
  limits: { readonly maxLines: number; readonly maxBytes: number },
  options: {
    readonly archiveId?: string
    readonly archiveDownloadUrl?: string
    readonly archiveTruncated: boolean
    readonly forceTruncated: boolean
  }
): { text: string; truncated: boolean } {
  if (!text && !options.forceTruncated) return { text, truncated: false }
  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf8")
  if (
    !options.forceTruncated &&
    lines.length <= limits.maxLines &&
    totalBytes <= limits.maxBytes
  ) {
    return { text, truncated: false }
  }

  const preview: string[] = []
  let usedBytes = 0
  let hitBytes = false
  for (let i = 0; i < lines.length && i < limits.maxLines; i += 1) {
    const nextBytes = Buffer.byteLength(lines[i], "utf8") + (i > 0 ? 1 : 0)
    if (usedBytes + nextBytes > limits.maxBytes) {
      hitBytes = true
      break
    }
    preview.push(lines[i])
    usedBytes += nextBytes
  }

  const removed = hitBytes
    ? totalBytes - usedBytes
    : lines.length - preview.length
  const unit = hitBytes ? "bytes" : "lines"
  const truncationSummary =
    removed > 0
      ? `...${removed} ${unit} truncated...`
      : "...additional output omitted from the in-memory response..."
  const archiveNotice =
    options.archiveId && options.archiveDownloadUrl
      ? options.archiveTruncated
        ? `The retained output archive reached its safety cap and is partial (archive ${options.archiveId}).`
        : `Full output retained as archive ${options.archiveId}.`
      : "The full output archive could not be created."
  const archiveDownload =
    options.archiveId && options.archiveDownloadUrl
      ? `Authenticated download: ${options.archiveDownloadUrl}`
      : null
  return {
    text: [
      preview.join("\n"),
      "",
      truncationSummary,
      "",
      archiveNotice,
      archiveDownload,
      "Use the authenticated archive instead of rerunning solely to recover truncated output.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n")
      .replace(/^\n+/, ""),
    truncated: true,
  }
}

async function resolveProjectShell(
  cwd: string,
  explicitShell?: string
): Promise<string | undefined> {
  if (explicitShell?.trim()) return explicitShell
  try {
    return await getProjectShell(cwd)
  } catch {
    return undefined
  }
}

async function resolveProjectShellPermissionRule(
  cwd: string,
  command: string
): Promise<{
  readonly permission: string
  readonly pattern: string
  readonly action: "ask" | "allow" | "deny"
  readonly sourcePath: string
} | null> {
  const rules = await listProjectPermissions(cwd)
  return evaluateProjectPermissionRules(rules, {
    permission: "bash",
    pattern: command,
  })
}

function shellRateLimitKey(
  c: Context,
  config: ServerConfig,
  remoteAccess: RemoteAccessService | undefined,
  knownIdentity = resolveRequestIdentity(c, config, remoteAccess)
): string {
  return shellOwnerContext(c, config, remoteAccess, knownIdentity).ownerId
}

interface ShellOwnerContext {
  readonly ownerId: string
  readonly expiresAt?: number
  readonly isActive?: () => boolean
}

function shellOwnerContext(
  c: Context,
  config: ServerConfig,
  remoteAccess: RemoteAccessService | undefined,
  knownIdentity: RemoteRequestIdentity | null = resolveRequestIdentity(
    c,
    config,
    remoteAccess
  )
): ShellOwnerContext {
  if (knownIdentity?.kind === "remote" && knownIdentity.session) {
    const sessionId = knownIdentity.session.id
    const expiresAt = Date.parse(knownIdentity.session.expiresAt)
    return {
      ownerId: `remote:${sessionId}`,
      ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
      isActive: () => remoteAccess?.isSessionActive(sessionId) === true,
    }
  }
  return {
    ownerId:
      knownIdentity?.kind === "local" ? DESKTOP_SHELL_OWNER : "unauthenticated",
  }
}
