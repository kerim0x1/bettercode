import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { serve } from "@hono/node-server"
import { buildApp } from "../http/router"
import { WsHub } from "../ws/server"
import { createWsRpcHandler } from "../ws/rpc"
import { RemoteTerminalChannel } from "../ws/terminalChannel"
import { logger } from "../observability/logger"
import { describeRemoteProtocol } from "../remote/protocol"
import { REMOTE_SESSION_COOKIE } from "../remote/service"
import type { Settings } from "../settings/schema"
import type { AppState } from "../appState"
import type {
  BootRoot,
  HttpApp,
  SettingsContext,
  TransportContext,
} from "./context"

/**
 * Phase 4: the WebSocket hub with its remote-session authentication, and
 * the RPC handler bound to the finished `AppState`.
 */
export function createTransport(
  root: BootRoot,
  settingsCtx: SettingsContext,
  state: AppState
): TransportContext {
  const { config, startupCleanup } = root
  const { remoteAccess, settings } = settingsCtx
  // ── HTTP + WS ────────────────────────────────────────────────────────
  // Minted by `createBootRoot`; the narrowing no longer carries across the
  // phase boundary, so assert it the same way `token` below already does.
  const hub = new WsHub(config.authToken!, {
    allowedOrigins: config.allowedOrigins,
    allowSameHostOrigins: () => remoteAccess.enabled(),
    trustProxyHeaders: config.trustProxyHeaders,
    trustLoopbackProxyHeaders: () => config.trustLoopbackProxyHeaders === true,
    tailnetSelfAddresses: () => config.tailnetSelfAddresses?.() ?? new Set(),
    allowInsecureRemoteAccess: config.allowInsecureRemoteAccess,
    authenticateToken: (token) => {
      const session = remoteAccess.authenticate(token)
      return session
        ? {
            kind: "remote",
            sessionId: session.id,
            accessLevel: session.accessLevel,
            expiresAt: Date.parse(session.expiresAt),
          }
        : null
    },
    revalidateRemoteSession: (principal) =>
      remoteAccess.isSessionActive(principal.sessionId),
    subscribeToRemoteSessionRevocations: (listener) =>
      remoteAccess.subscribeToSessionRevocations(listener),
    sessionCookieName: REMOTE_SESSION_COOKIE,
    describeProtocol: (principal) =>
      describeRemoteProtocol({
        accessLevel:
          principal.kind === "local" ? "full" : principal.accessLevel,
        terminalAllowed:
          principal.kind === "local" ||
          settings.get().remote_access_allow_terminal === true,
      }),
    noteRemoteClient: (sessionId, client) =>
      remoteAccess.noteClient(sessionId, client),
  })
  startupCleanup.push({
    name: "WebSocket hub",
    run: () => hub.close(),
  })
  // Terminals for paired devices over the WebSocket (ws/terminalChannel.ts).
  const terminals = new RemoteTerminalChannel({
    state,
    terminalGranted: () => settings.get().remote_access_allow_terminal === true,
  })
  const stopForgettingRevokedTerminals =
    remoteAccess.subscribeToSessionRevocations((sessionIds) =>
      terminals.forgetSessions(sessionIds)
    )
  startupCleanup.push({
    name: "remote terminals",
    run: () => {
      stopForgettingRevokedTerminals()
      terminals.dispose()
    },
  })
  // Paired devices learn about a changed terminal grant without reconnecting;
  // a grant taken away ends their terminals, and each device hears why.
  let terminalAllowed = settings.get().remote_access_allow_terminal === true
  const refreshProtocolOnSettingsChange = (next: Settings) => {
    const allowed = next.remote_access_allow_terminal === true
    if (allowed === terminalAllowed) return
    terminalAllowed = allowed
    if (!allowed) terminals.endAll("grant_revoked")
    hub.refreshProtocol()
  }
  settings.on("change", refreshProtocolOnSettingsChange)
  startupCleanup.push({
    name: "protocol updates for paired devices",
    run: () => {
      settings.off("change", refreshProtocolOnSettingsChange)
    },
  })
  hub.setRpcHandler(createWsRpcHandler(state, config, terminals))
  return { hub }
}

/**
 * Phase 7: the Hono app. Built after the retention scheduler and before the
 * background timers — the same point in the sequence as before the split.
 */
export function buildHttpApp(
  root: BootRoot,
  state: AppState,
  hub: WsHub
): HttpApp {
  const { options, config } = root
  const app = buildApp(config, state, {
    wsClientCount: () => hub.clientCount(),
    webRoot: resolveWebRoot(options.webRoot),
  })
  return app
}

/**
 * Where the renderer bundle may live, most explicit first. Exported so the
 * relative candidate — which depends on this file's depth inside `dist/` —
 * is pinned by a test rather than discovered after packaging.
 */
export function webRootCandidates(
  explicit: string | undefined
): Array<string | undefined> {
  return [
    explicit,
    process.env.BETTERC0DE_WEB_ROOT,
    path.resolve(__dirname, "../../../ui/dist"),
    path.resolve(process.cwd(), "apps/ui/dist"),
  ]
}

export function resolveWebRoot(
  explicit: string | undefined
): string | undefined {
  const candidates = webRootCandidates(explicit)
  for (const candidate of candidates) {
    if (!candidate) continue
    const resolved = path.resolve(candidate)
    if (fs.existsSync(path.join(resolved, "index.html"))) return resolved
  }
  return undefined
}

/**
 * Runtime errors on a bound listener taint the backend — unless that
 * candidate is already shutting down, in which case they are expected noise.
 * Returns the listener so the caller can detach exactly this one.
 */
export function attachRuntimeErrorListener(
  server: http.Server,
  port: number,
  taintBackend: BootRoot["taint"]["taintBackend"],
  isShuttingDown: () => boolean
): (error: Error) => void {
  const listener = (error: Error) => {
    if (isShuttingDown()) {
      logger.warn(
        { err: error, port },
        "HTTP server error while listener is shutting down"
      )
      return
    }
    taintBackend(error, "http_server_runtime")
  }
  server.on("error", listener)
  return listener
}

export function bindHttpServer(
  fetchFn: Parameters<typeof serve>[0]["fetch"],
  host: string,
  port: number
): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const onStartupError = (error: Error) => {
      reject(error)
    }
    const server = serve({ fetch: fetchFn, hostname: host, port }, (info) => {
      if (info) {
        server.off("error", onStartupError)
        resolve(server as unknown as http.Server)
      }
    }) as unknown as http.Server
    server.requestTimeout = 15_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 5_000
    server.once("error", onStartupError)
  })
}
