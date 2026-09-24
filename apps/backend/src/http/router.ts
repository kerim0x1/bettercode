import { randomBytes } from "node:crypto"
import { remoteClientNeedsUpdate } from "@betterc0de/schema/remote-protocol"
import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { routePath } from "hono/route"
import type { AppState } from "../appState"
import type { ServerConfig } from "../config"
import { getBackendLoggingSettings, logger } from "../observability/logger"
import {
  backendMetrics,
  HTTP_REQUEST_DURATION_MS,
  HTTP_REQUESTS_TOTAL,
} from "../observability/metrics"
import { isAllowedBrowserOrigin } from "../security/origin"
import { constantTimeEqual } from "../security/token"
import { registerHealthRoute, registerRuntimeRoutes } from "./routes/runtime"
import { registerSettingsRoutes } from "./routes/settings"
import { registerThemesRoutes } from "./routes/themes"
import { registerThreadsRoutes } from "./routes/threads"
import { registerProjectsRoutes } from "./routes/projects"
import { registerProvidersRoutes } from "./routes/providers"
import { registerChatRoutes } from "./routes/chat"
import { registerOrchestratorRoutes } from "./routes/orchestrator"
import { registerPermissionsRoutes } from "./routes/permissions"
import { registerGitRoutes } from "./routes/git"
import { registerWorkspaceRoutes } from "./routes/workspace"
import { registerFilesystemRoutes } from "./routes/filesystem"
import { registerShellRoutes } from "./routes/shell"
import { registerUsageRoutes } from "./routes/usage"
import { sanitizeError } from "./errors"
import { createRateLimiter, rateLimitMiddleware } from "./middleware/rateLimit"
import {
  bootstrapRateLimitKeys,
  clientUpdateRequiredBody,
  createPairingAdmissionMiddleware,
  isClientUpdateGateExempt,
  isDesktopOnlyRequest,
  isInsecureNonLoopbackRequest,
  isReadOnlyRemoteRequestAllowed,
  isRemoteRequestTransportAllowed,
  requestClientInfo,
  requestIdentity,
  requiresReadOnlyRemoteAccess,
  registerRemotePublicRoutes,
  registerRemoteRoutes,
  resolveRequestIdentity,
} from "../remote/http"
import { API_BODY_LIMIT_BYTES } from "../remote/protocol"
import { registerRemoteWebRoutes } from "../remote/web"

/** Generate a short 8-char hex request ID (4 random bytes). */
function reqId(): string {
  return randomBytes(4).toString("hex")
}

function shouldTraceHttpRequests(): boolean {
  return getBackendLoggingSettings().traceHttp
}

function shouldLogHttpRequest(status: number, durationMs: number): boolean {
  return shouldTraceHttpRequests() || status >= 400 || durationMs >= 1_000
}

const PAIRING_BODY_LIMIT_BYTES = 16 * 1024

/**
 * Per-identity key for authenticated endpoints that call out to third
 * parties on the caller's behalf. Each paired device gets its own bucket;
 * the desktop renderer shares one.
 */
function identityRateLimitKey(state: AppState, config: ServerConfig) {
  return (c: Context): string => {
    const identity = requestIdentity(c, config, state)
    return identity?.kind === "remote" && identity.session
      ? `remote:${identity.session.id}`
      : "local"
  }
}

function buildApiRoutes(state: AppState, config: ServerConfig): Hono {
  const api = new Hono()
  const keyForIdentity = identityRateLimitKey(state, config)
  // Every accepted call is an outbound request carrying a user secret to a
  // provider; a loop here is either a bug or an abuse vector, never a need.
  api.use(
    "/providers/validate-key",
    rateLimitMiddleware(
      createRateLimiter({ capacity: 10, refillPerSecond: 0.5 }),
      {
        key: keyForIdentity,
        message: "Too many key validation requests — rate limit exceeded.",
      }
    )
  )
  api.use(
    "/settings/deepgram-token",
    rateLimitMiddleware(
      createRateLimiter({ capacity: 10, refillPerSecond: 0.5 }),
      {
        key: keyForIdentity,
        message: "Too many transcription token requests — rate limit exceeded.",
      }
    )
  )
  registerRemoteRoutes(api, config, state)
  registerRuntimeRoutes(api, state)
  registerSettingsRoutes(api, state)
  registerThemesRoutes(api, config)
  registerThreadsRoutes(api, state)
  registerProjectsRoutes(api, state)
  registerProvidersRoutes(api, state)
  registerChatRoutes(api, state)
  registerOrchestratorRoutes(api, state)
  registerPermissionsRoutes(api, state)
  registerGitRoutes(api, state)
  registerWorkspaceRoutes(api, state)
  registerFilesystemRoutes(api, state)
  registerShellRoutes(api, config, state.remoteAccess, state)
  registerUsageRoutes(api, config)
  return api
}

/** Root Hono app — CORS + Bearer auth on the versioned /api/v1 surface. */
export function buildApp(
  config: ServerConfig,
  state: AppState,
  opts?: { wsClientCount?: () => number; webRoot?: string }
): Hono {
  if (!config.authToken) throw new Error("buildApp: authToken must be set")
  const app = new Hono()
  app.onError((err, c) => {
    // Centralized fallback for any error that escapes a route handler.
    // sanitizeError exposes only nominal HttpError messages. Duck-typed
    // service failures preserve a bounded status/code but keep their message
    // internal. Unknown failures become a generic 500; pino receives only
    // non-sensitive error metadata.
    const { message, statusCode, code } = sanitizeError(err, "request", {
      path: c.req.path,
      method: c.req.method,
    })
    const body =
      code !== undefined ? { error: message, code } : { error: message }
    return c.json(body, statusCode as 400 | 401 | 403 | 404 | 500)
  })

  // Hold one application-work lease for the complete Hono response path.
  // Register this before every route so keep-alive requests already accepted
  // by Node cannot start fresh work once graceful shutdown begins.
  app.use("*", async (c, next) => {
    const release = state.requestAdmission?.tryEnter()
    if (state.requestAdmission && !release) {
      c.header("Connection", "close")
      return c.json({ error: "service draining" }, 503)
    }
    try {
      return await next()
    } finally {
      release?.()
    }
  })

  /* ── Public health endpoint (before auth) ─────────────────────────── */
  registerHealthRoute(app, { state, wsClientCount: opts?.wsClientCount })

  const bodyTooLarge = (c: Context) =>
    c.json({ error: "request body too large", code: "request_too_large" }, 413)
  const pairingAdmission = createPairingAdmissionMiddleware(config)
  app.use("/api/v1/remote/pair", pairingAdmission)
  app.use("/api/v1/remote/mobile/pair", pairingAdmission)
  app.use(
    "/api/v1/remote/pair",
    bodyLimit({ maxSize: PAIRING_BODY_LIMIT_BYTES, onError: bodyTooLarge })
  )
  app.use(
    "/api/v1/remote/mobile/pair",
    bodyLimit({ maxSize: PAIRING_BODY_LIMIT_BYTES, onError: bodyTooLarge })
  )
  app.use(
    "/api/*",
    bodyLimit({ maxSize: API_BODY_LIMIT_BYTES, onError: bodyTooLarge })
  )

  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin")
    const localProcessRequest = hasLocalProcessBearer(
      c.req.header("Authorization"),
      config.authToken
    )
    const localBearerPreflight =
      c.req.method === "OPTIONS" &&
      (c.req.header("Access-Control-Request-Headers") ?? "")
        .split(",")
        .some((header) => header.trim().toLowerCase() === "authorization")
    const allowed = isAllowedBrowserOrigin(origin, config.allowedOrigins, {
      requestHost: c.req.header("Host"),
      allowSameHost: state.remoteAccess?.enabled() === true,
      allowLoopback: localProcessRequest || localBearerPreflight,
      allowOpaque: localProcessRequest,
    })
    if (!allowed) return c.json({ error: "origin not allowed" }, 403)
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin)
      c.header("Access-Control-Allow-Credentials", "true")
      c.header("Vary", "Origin")
      c.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS"
      )
      c.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-BetterC0de-Client"
      )
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204)
    return next()
  })

  // Validate origins before refusing work during shutdown, so trusted renderers
  // receive the actual 503 response instead of an opaque CORS failure.
  app.use("*", async (c, next) => {
    if (state.taintedRef?.() || state.drainingRef?.()) {
      c.header("Connection", "close")
      return c.json({ error: "service draining" }, 503)
    }
    return next()
  })

  // Bootstrap is public and hashes any presented credential, so it is
  // bounded — but one peer address is not one device: a tunnel or reverse
  // proxy puts every paired device behind the same IP, and a single per-peer
  // bucket let one chatty client lock the rest out. Each presented credential
  // gets its own bucket (a burst of 30, then one request per second); every
  // caller behind one address shares a much larger peer bucket (600, refilled
  // at 10/s — the hashing bound); loopback is never throttled.
  const bootstrapPeerLimiter = createRateLimiter({
    capacity: 600,
    refillPerSecond: 10,
    maxKeys: 2_000,
  })
  const bootstrapSessionLimiter = createRateLimiter({
    capacity: 30,
    refillPerSecond: 1,
    maxKeys: 4_000,
  })
  app.use("/api/v1/remote/bootstrap", async (c, next) => {
    const keys = bootstrapRateLimitKeys(c, config)
    if (keys === null) return next()
    // The device's own bucket decides first. A device that is already
    // throttled must not keep draining the shared peer bucket — behind one
    // tunnel that bucket belongs to every other paired device too.
    const session = keys.session
      ? bootstrapSessionLimiter.consume(keys.session)
      : null
    const peer =
      session === null || session.allowed
        ? bootstrapPeerLimiter.consume(keys.peer)
        : null
    if (peer?.allowed) return next()
    const retryAfterMs = Math.max(
      peer?.retryAfterMs ?? 0,
      session?.retryAfterMs ?? 0
    )
    c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
    return c.json(
      {
        error: "Too many bootstrap requests — rate limit exceeded.",
        code: "rate_limited",
        retryAfterMs,
      },
      429
    )
  })

  // These two endpoints intentionally precede the authenticated API
  // middleware. They reveal only the auth posture and exchange a one-time,
  // short-lived pairing credential for an HttpOnly browser session.
  registerRemotePublicRoutes(app, config, state)

  app.use("/api/*", async (c, next) => {
    if (!isRemoteRequestTransportAllowed(c, config)) {
      return c.json(
        {
          error: "secure transport required",
          code: "secure_transport_required",
        },
        426
      )
    }
    // Resolved once here and cached on the context; routes read it back
    // through `requestIdentity` instead of re-authenticating.
    const identity = resolveRequestIdentity(c, config, state.remoteAccess)
    if (!identity) {
      return c.json({ error: "unauthorized", code: "unauthorized" }, 401)
    }
    if (identity.kind === "local" && isInsecureNonLoopbackRequest(c, config)) {
      return c.json(
        {
          error: "desktop credentials require secure transport",
          code: "secure_transport_required",
        },
        426
      )
    }
    if (identity.kind === "remote") {
      // The phone app names its version on every request. Apps that predate
      // the header are served while the minimum still includes them.
      const client = requestClientInfo(c)
      if (client && identity.session) {
        state.remoteAccess?.noteClient(identity.session.id, client)
      }
      if (remoteClientNeedsUpdate(client) && !isClientUpdateGateExempt(c)) {
        return c.json(clientUpdateRequiredBody(), 426)
      }
    }
    if (identity.kind === "remote" && isDesktopOnlyRequest(c)) {
      return c.json(
        {
          error: "This endpoint is only available to the desktop host.",
          code: "desktop_only",
        },
        403
      )
    }
    if (
      requiresReadOnlyRemoteAccess(c, config, identity) &&
      !isReadOnlyRemoteRequestAllowed(c)
    ) {
      return c.json(
        {
          error: "remote session is restricted to read-only monitoring",
          code: "remote_read_only",
        },
        403
      )
    }
    return next()
  })

  /* ── HTTP request/response logging (after auth, skips OPTIONS) ── */
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next()

    const id = reqId()
    const start = performance.now()

    try {
      await next()
    } catch (err) {
      const duration = Math.round(performance.now() - start)
      recordHttpMetrics(
        c.req.method,
        requestMetricPath(c),
        500,
        duration,
        "failure"
      )
      throw err
    }

    const duration = Math.round(performance.now() - start)
    const status = c.res.status
    recordHttpMetrics(
      c.req.method,
      requestMetricPath(c),
      status,
      duration,
      status >= 500 ? "failure" : "success"
    )

    if (shouldLogHttpRequest(status, duration)) {
      const log =
        status >= 500 ? logger.error : status >= 400 ? logger.warn : logger.info
      log(
        {
          reqId: id,
          method: c.req.method,
          path: c.req.path,
          status,
          durationMs: duration,
        },
        "http request"
      )
    }
  })

  // Single versioned mount.  The client used to fall back to an
  // unversioned `/api` path on 404 — that silently masked contract drift
  // and has been removed (see src/services/backend/runtime.ts).  All
  // current and future surfaces live under `/api/v1`.
  app.route("/api/v1", buildApiRoutes(state, config))
  registerRemoteWebRoutes(app, config, opts?.webRoot)
  return app
}

function hasLocalProcessBearer(
  authorization: string | undefined,
  expectedToken: string | undefined
): boolean {
  if (!expectedToken || !authorization?.startsWith("Bearer ")) return false
  const token = authorization.slice("Bearer ".length).trim()
  return token.length > 0 && constantTimeEqual(token, expectedToken)
}

function requestMetricPath(c: Context): string {
  if (c.res.status === 404) return "unmatched"
  const template = routePath(c)
  if (template && template !== "*" && template !== "/*") return template
  return "unknown"
}

function recordHttpMetrics(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  outcome: "success" | "failure"
): void {
  const attributes = { method, path, status }
  backendMetrics.recordDuration(
    HTTP_REQUEST_DURATION_MS,
    durationMs,
    attributes
  )
  backendMetrics.incrementCounter(HTTP_REQUESTS_TOTAL, {
    ...attributes,
    outcome,
  })
}
