import {
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs"
import os from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { writeHeapSnapshot } from "node:v8"
import type { Hono } from "hono"
import type { AppState } from "../../appState"
import { backendMetrics } from "../../observability/metrics"
import { logger } from "../../observability/logger"
import { isLocalOwnerRequest } from "../../remote/http"
import { createCliStatusReader } from "../../services/cli-status"
import { readBackendVersion } from "../../version"

/* ── Package version (read once at module load) ───────────────────────── */
const pkgVersion = readBackendVersion()

const startedAt = Date.now()
const HEAP_SNAPSHOT_RATE_LIMIT_MS = 5 * 60 * 1000
const HEAP_SNAPSHOT_RETENTION_COUNT = 3

export interface HealthRouteOptions {
  state: AppState
  /** Returns the number of authenticated WebSocket clients. */
  wsClientCount?: () => number
}

/**
 * Public health-check endpoint mounted BEFORE auth middleware so that
 * monitoring tools (load-balancers, uptime checkers, k8s probes) can
 * reach it without a Bearer token.
 */
export function registerHealthRoute(app: Hono, opts: HealthRouteOptions): void {
  app.get("/health", (c) => {
    const { state } = opts

    /* DB liveness — a trivial SELECT 1 against SQLite */
    const dbStatus = databaseLiveness(state)

    return c.json(
      {
        status: dbStatus === "ok" ? "ok" : "error",
        db: dbStatus,
      },
      dbStatus === "ok" ? 200 : 503
    )
  })
}

export function registerRuntimeRoutes(api: Hono, state: AppState): void {
  let heapSnapshotInFlight = false
  let nextHeapSnapshotAllowedAt = 0
  const readCliStatus = createCliStatusReader(state.providerRegistry)
  api.get("/runtime/health", (c) => {
    const dbStatus = databaseLiveness(state)
    return c.json(
      { status: dbStatus === "ok" ? "ok" : "error", db: dbStatus },
      dbStatus === "ok" ? 200 : 503
    )
  })
  api.get("/runtime/capabilities", (c) =>
    c.json({
      capabilities: ["chat.send", "git", "workspace", "shell"],
      backend: "node",
    })
  )
  api.get("/runtime/debug-info", (c) => {
    const config = state.config
    // The router already refuses this route to remote sessions
    // (`desktop_only`). Redact host-identifying fields anyway so a future
    // allowlist change cannot leak them by accident.
    const localOwner = isLocalOwnerRequest(c, state.config, state)
    const redacted = "[redacted]"
    return c.json({
      app: {
        name: "BetterC0de",
        version: pkgVersion,
        backend: "node",
        startedAt,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      },
      system: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        type: os.type(),
        hostname: localOwner ? os.hostname() : redacted,
      },
      process: {
        pid: process.pid,
        node: process.version,
        memory: process.memoryUsage(),
        versions: {
          node: process.versions.node,
          v8: process.versions.v8,
          uv: process.versions.uv,
          modules: process.versions.modules,
        },
        cwd: process.cwd(),
      },
      terminal: {
        term: process.env.TERM ?? null,
        program: process.env.TERM_PROGRAM ?? null,
        shell: process.env.SHELL ?? null,
      },
      envOverrides: {
        betterc0deHome: process.env.BETTERC0DE_HOME ? "set" : "unset",
        betterc0deDataDir: process.env.BETTERC0DE_DATA_DIR ? "set" : "unset",
      },
      paths: localOwner
        ? {
            dataDir: config.dataDir,
            dbPath: config.dbPath,
            settingsPath: config.settingsPath,
            authPath: config.authPath,
            logsDir: config.logsDir,
            providerLogsDir: config.providerLogsDir,
            providerEventLogPath: config.providerEventLogPath,
          }
        : {
            dataDir: redacted,
            dbPath: redacted,
            settingsPath: redacted,
            authPath: redacted,
            logsDir: redacted,
            providerLogsDir: redacted,
            providerEventLogPath: redacted,
          },
      database: {
        path: localOwner ? config.dbPath : redacted,
      },
      metrics: backendMetrics.snapshot(),
      betterc0de: {
        ...buildBetterC0deRuntimePaths(),
        ...buildBetterC0deRuntimePluginInfo(),
      },
    })
  })

  api.get("/runtime/metrics", (c) =>
    c.json({
      collectedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      memory: process.memoryUsage(),
      metrics: backendMetrics.snapshot(),
    })
  )

  api.post("/runtime/heap-snapshot", (c) => {
    if (state.config.runtimeHeapSnapshotsEnabled !== true) {
      return c.json({ error: "heap snapshots are disabled" }, 404)
    }
    if (!isLocalOwnerRequest(c, state.config, state)) {
      return c.json({ error: "heap snapshots are local-owner only" }, 403)
    }
    const now = Date.now()
    if (heapSnapshotInFlight) {
      return c.json({ error: "heap snapshot already in progress" }, 409)
    }
    if (now < nextHeapSnapshotAllowedAt) {
      c.header(
        "Retry-After",
        String(Math.max(1, Math.ceil((nextHeapSnapshotAllowedAt - now) / 1000)))
      )
      return c.json({ error: "heap snapshot rate limit exceeded" }, 429)
    }
    heapSnapshotInFlight = true
    try {
      const snapshot = writeRuntimeHeapSnapshot(state.config)
      nextHeapSnapshotAllowedAt = now + HEAP_SNAPSHOT_RATE_LIMIT_MS
      return c.json(snapshot)
    } finally {
      heapSnapshotInFlight = false
    }
  })

  /*
   * Cold CLI probes are asynchronous and singleflight-coalesced. Completed
   * snapshots use a short TTL; explicit refresh bypasses it. If an external
   * credential store or CLI misses the response deadline, the reader serves
   * the previous snapshot instead of holding the HTTP event loop open.
   */
  api.get("/cli/status", async (c) => {
    const refresh = c.req.query("refresh") === "true"
    return c.json(await readCliStatus({ refresh }))
  })
}

function databaseLiveness(state: AppState): "ok" | "error" {
  try {
    state.db.prepare("SELECT 1").get()
    return "ok"
  } catch {
    return "error"
  }
}

export function buildBetterC0deRuntimePaths(
  env: NodeJS.ProcessEnv = process.env
): {
  configDir: string
  configDirSource: "default" | "BETTERC0DE_CONFIG_DIR" | "legacy"
  dataDir: string
  stateDir: string
  cacheDir: string
  binDir: string
  logDir: string
  reposDir: string
  dbPath: string
  dbPathSource: "default" | "BETTERC0DE_DB" | "legacy"
  authPath: string
  mcpAuthPath: string
  pluginMetaPath: string
} {
  const betterC0deConfigDirOverride = env.BETTERC0DE_CONFIG_DIR?.trim()
  const legacyConfigDirOverride = env.BetterC0de_CONFIG_DIR?.trim()
  const configDirOverride =
    betterC0deConfigDirOverride || legacyConfigDirOverride
  const configDir = configDirOverride
    ? resolve(expandHomePath(configDirOverride))
    : betterC0deXdgDir(env, "XDG_CONFIG_HOME", ".config")
  const configDirSource = betterC0deConfigDirOverride
    ? "BETTERC0DE_CONFIG_DIR"
    : legacyConfigDirOverride
      ? "legacy"
      : "default"
  const dataDir = betterC0deDataDir(env)
  const stateDir = betterC0deXdgDir(env, "XDG_STATE_HOME", ".local/state")
  const cacheDir = betterC0deXdgDir(env, "XDG_CACHE_HOME", ".cache")
  const binDir = join(cacheDir, "bin")
  const logDir = join(dataDir, "log")
  const reposDir = join(dataDir, "repos")
  const authPath = join(dataDir, "auth.json")
  const mcpAuthPath = join(dataDir, "mcp-auth.json")
  const pluginMetaOverride =
    env.BETTERC0DE_PLUGIN_META_FILE?.trim() ||
    env.BetterC0de_PLUGIN_META_FILE?.trim()
  const pluginMetaPath = pluginMetaOverride
    ? resolve(expandHomePath(pluginMetaOverride))
    : join(stateDir, "plugin-meta.json")
  const betterC0deDbOverride = env.BETTERC0DE_DB?.trim()
  const legacyDbOverride = env.BetterC0de_DB?.trim()
  const override = betterC0deDbOverride || legacyDbOverride
  if (override) {
    return {
      configDir,
      configDirSource,
      dataDir,
      stateDir,
      cacheDir,
      binDir,
      logDir,
      reposDir,
      dbPath:
        override === ":memory:" || isAbsolute(override)
          ? override
          : join(dataDir, override),
      dbPathSource: betterC0deDbOverride ? "BETTERC0DE_DB" : "legacy",
      authPath,
      mcpAuthPath,
      pluginMetaPath,
    }
  }
  return {
    configDir,
    configDirSource,
    dataDir,
    stateDir,
    cacheDir,
    binDir,
    logDir,
    reposDir,
    dbPath: join(dataDir, "betterc0de.db"),
    dbPathSource: "default",
    authPath,
    mcpAuthPath,
    pluginMetaPath,
  }
}

export function buildBetterC0deRuntimePluginInfo(
  env: NodeJS.ProcessEnv = process.env
): {
  pureMode: boolean
  defaultPluginsDisabled: boolean
  externalPlugins: "enabled" | "disabled-by-pure"
  defaultPlugins: "enabled" | "disabled-by-env"
} {
  const pureMode = isTruthyEnvFlag(env.BETTERC0DE_PURE ?? env.BetterC0de_PURE)
  const defaultPluginsDisabled = isTruthyEnvFlag(
    env.BETTERC0DE_DISABLE_DEFAULT_PLUGINS ??
      env.BetterC0de_DISABLE_DEFAULT_PLUGINS
  )
  return {
    pureMode,
    defaultPluginsDisabled,
    externalPlugins: pureMode ? "disabled-by-pure" : "enabled",
    defaultPlugins: defaultPluginsDisabled ? "disabled-by-env" : "enabled",
  }
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
}

function betterC0deXdgDir(
  env: NodeJS.ProcessEnv,
  envName: "XDG_CONFIG_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME",
  fallback: ".config" | ".local/state" | ".cache"
): string {
  const override = env[envName]?.trim()
  return join(
    resolve(expandHomePath(override || join(os.homedir(), fallback))),
    "betterc0de"
  )
}

function betterC0deDataDir(env: NodeJS.ProcessEnv): string {
  const xdgData = env.XDG_DATA_HOME?.trim()
  if (xdgData) return join(resolve(expandHomePath(xdgData)), "betterc0de")
  if (process.platform === "win32") {
    return join(
      env.LOCALAPPDATA || join(os.homedir(), "AppData", "Local"),
      "BetterC0de"
    )
  }
  return join(os.homedir(), ".local", "share", "betterc0de")
}

function expandHomePath(value: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(os.homedir(), value.slice(2))
  }
  return value
}

export interface RuntimeHeapSnapshotResult {
  path: string
  bytes: number
}

export interface RuntimeHeapSnapshotDeps {
  chmodSync?: (path: string, mode: number) => void
  mkdirSync?: (
    path: string,
    options: { recursive: true; mode?: number }
  ) => void
  now?: () => Date
  pid?: number
  readdirSync?: (path: string) => string[]
  statSync?: (path: string) => { size: number; mtimeMs?: number }
  unlinkSync?: (path: string) => void
  writeHeapSnapshot?: (path: string) => string
}

export function writeRuntimeHeapSnapshot(
  config: { logsDir: string },
  deps: RuntimeHeapSnapshotDeps = {}
): RuntimeHeapSnapshotResult {
  const mkdir = deps.mkdirSync ?? mkdirSync
  const chmod = deps.chmodSync ?? chmodSync
  const now = deps.now ?? (() => new Date())
  const pid = deps.pid ?? process.pid
  const readdir = deps.readdirSync ?? readdirSync
  const stat = deps.statSync ?? statSync
  const unlink = deps.unlinkSync ?? unlinkSync
  const write = deps.writeHeapSnapshot ?? writeHeapSnapshot

  const snapshotDir = join(config.logsDir, "heap-snapshots")
  mkdir(snapshotDir, { recursive: true, mode: 0o700 })
  // A heap snapshot can contain live credentials. Protect the directory
  // before V8 opens the file, rather than chmodding only after the synchronous
  // write has already exposed it under the process umask.
  chmod(snapshotDir, 0o700)
  const timestamp = now().toISOString().replace(/[:.]/g, "-")
  const filepath = join(snapshotDir, `heap-${pid}-${timestamp}.heapsnapshot`)
  const path = write(filepath)
  try {
    chmod(path, 0o600)
  } catch (error) {
    try {
      unlink(path)
    } catch {
      // Preserve the original permissions failure.
    }
    throw error
  }
  pruneRuntimeHeapSnapshots(snapshotDir, path, HEAP_SNAPSHOT_RETENTION_COUNT, {
    readdir,
    stat,
    unlink,
  })
  return {
    path,
    bytes: stat(path).size,
  }
}

function pruneRuntimeHeapSnapshots(
  logsDir: string,
  currentPath: string,
  retain: number,
  deps: {
    readdir: (path: string) => string[]
    stat: (path: string) => { size: number; mtimeMs?: number }
    unlink: (path: string) => void
  }
): void {
  try {
    const snapshots = deps
      .readdir(logsDir)
      .filter((name) => /^heap-.*\.heapsnapshot$/.test(name))
      .map((name) => {
        const path = join(logsDir, name)
        return {
          path,
          mtimeMs:
            deps.stat(path).mtimeMs ?? (path === currentPath ? Infinity : 0),
        }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
    for (const snapshot of snapshots.slice(Math.max(1, retain))) {
      deps.unlink(snapshot.path)
    }
  } catch (error) {
    logger.warn(
      { err: error, logsDir },
      "heap snapshot retention cleanup failed"
    )
  }
}
