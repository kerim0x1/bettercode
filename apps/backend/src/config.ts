import path from "node:path"
import os from "node:os"
import { DEFAULT_PORT, PORT_FALLBACK_COUNT } from "./constants"
import { parseAllowedOrigins } from "./security/origin"

/**
 * Server configuration. When the desktop app starts the backend it passes
 * `dataDir` and `runtimeHome` explicitly (`BETTERC0DE_DATA_DIR` and
 * `BETTERC0DE_RUNTIME_HOME`, both resolved by
 * `apps/shell/shared/runtime-paths.cjs`); standalone `node dist/index.js`
 * runs compute the defaults here and land on the same paths, so both entry
 * points read and write the same SQLite file and desktop configuration.
 */
export interface ServerConfig {
  /** HTTP/WS host. Loopback unless the user explicitly enables remote access. */
  host: string
  /** Preferred port; fallbacks are host:port+1, host:port+2, then 0 (any). */
  port: number
  /** Base data directory containing the SQLite DB + `settings.json`. */
  dataDir: string
  /**
   * The desktop configuration folder: `mcp-servers.json`, `hooks.json`,
   * `rules.md`, `skills/` and `subagents/`. This backend owns those files
   * (services/desktop-config); everything that reads them takes the folder
   * from here. Resolved once by `createServerConfig`; absent only from
   * hand-built test configs, which then have no desktop configuration.
   */
  runtimeHome?: string
  /** Full path to the SQLite database file. */
  dbPath: string
  /** Full path to `settings.json`. */
  settingsPath: string
  /** Full path to `auth.json` — separate file for OAuth tokens. Encrypted at
   *  rest with the same master key the settings file uses (provisioned via
   *  Electron `safeStorage`). */
  authPath: string
  /** Base logs directory under the active data directory. */
  logsDir: string
  /** Provider observability log directory. */
  providerLogsDir: string
  /** Provider event log base path; thread logs live beside it. */
  providerEventLogPath: string
  /** Bearer token issued at process start (filled in later by generateToken). */
  authToken?: string
  /** Additional browser origins allowed for explicit remote deployments. */
  allowedOrigins?: string[]
  /**
   * Trust X-Forwarded-* only when an operator has placed the backend behind
   * a known reverse proxy. Disabled by default because these headers are
   * client-controlled on a directly exposed listener.
   */
  trustProxyHeaders?: boolean
  /**
   * Trust X-Forwarded-* from loopback TCP peers only. Set while Tailscale
   * Serve is enabled in settings: that proxy terminates TLS on this machine
   * and forwards to 127.0.0.1, so its headers are the only way to tell a
   * tailnet phone from the desktop renderer. Never widens a remote peer.
   */
  trustLoopbackProxyHeaders?: boolean
  /**
   * This machine's own Tailscale addresses, from the last `tailscale status`.
   * A plaintext request whose TCP peer *and* local socket address are both
   * tailnet addresses arrived through the WireGuard tunnel from an
   * authenticated peer: private transport, no TLS required. Checking the
   * local side against these exact addresses is what rules out an ISP CGNAT
   * interface that merely shares the 100.64/10 range.
   */
  tailnetSelfAddresses?: () => ReadonlySet<string>
  /**
   * Explicit escape hatch for direct, plaintext LAN access. The secure
   * default requires TLS (normally through a reverse proxy) off loopback.
   */
  allowInsecureRemoteAccess?: boolean
  /** Heap snapshots contain secrets and are disabled unless explicitly opted in. */
  runtimeHeapSnapshotsEnabled?: boolean
}

/**
 * Default on-disk data directory. Follows the BetterC0de layout — same path on
 * every OS so docs, debugging, and the plugin sibling directory
 * (`~/.betterc0de/plugins/`) all line up:
 *   - `~/.betterc0de/userdata/`
 *
 * `BETTERC0DE_HOME=/custom/root` swaps the base — the backend then writes
 * to `/custom/root/userdata/`. `BETTERC0DE_DATA_DIR=/absolute/path` is still
 * honoured by `createServerConfig` as an even higher-priority override that
 * skips the `/userdata` suffix entirely (power-users, tests, CI).
 *
 * Startup migrates legacy directories only into the standard production or
 * development userdata path. Explicit custom profiles stay isolated; this
 * directory resolver never chooses an existing legacy path as a fallback.
 */
function defaultDataDir(): string {
  const override = (process.env.BETTERC0DE_HOME ?? "").trim()
  const base = override ? override : path.join(os.homedir(), ".betterc0de")
  return path.join(base, "userdata")
}

/**
 * The desktop configuration folder, decided once for the whole backend:
 *
 * 1. `explicit` (`BETTERC0DE_RUNTIME_HOME`): what the desktop resolved and
 *    writes its configuration to. It must be an absolute path.
 * 2. `BETTERC0DE_HOME`, the profile root a standalone run shares with the
 *    desktop.
 * 3. The parent of a data directory named `userdata` (the standard layout,
 *    `<home>/userdata`).
 * 4. The data directory itself, for a standalone run with a custom
 *    `BETTERC0DE_DATA_DIR` and no home.
 *
 * Before this was resolved here, three readers guessed it separately from
 * the data directory, so a desktop profile with a custom data directory lost
 * its hooks, skills and rules while its MCP servers were read elsewhere.
 */
export function resolveRuntimeHome(
  dataDir: string,
  explicit?: string | null
): string {
  const configured = explicit?.trim()
  if (configured) {
    if (!path.isAbsolute(configured) || configured.includes("\0")) {
      throw new Error(
        "BETTERC0DE_RUNTIME_HOME must be an absolute filesystem path"
      )
    }
    return path.resolve(configured)
  }
  const home = process.env.BETTERC0DE_HOME?.trim()
  if (home && path.isAbsolute(home) && !home.includes("\0")) {
    return path.resolve(home)
  }
  const resolvedDataDir = path.resolve(dataDir)
  return path.basename(resolvedDataDir).toLowerCase() === "userdata"
    ? path.dirname(resolvedDataDir)
    : resolvedDataDir
}

export function createServerConfig(
  options: {
    dataDir?: string
    runtimeHome?: string
    port?: number
    host?: string
  } = {}
): ServerConfig {
  const dataDir =
    options.dataDir ?? process.env.BETTERC0DE_DATA_DIR ?? defaultDataDir()
  const runtimeHome = resolveRuntimeHome(
    dataDir,
    options.runtimeHome ?? process.env.BETTERC0DE_RUNTIME_HOME
  )
  const port = options.port ?? DEFAULT_PORT
  const logsDir = path.join(dataDir, "logs")
  const providerLogsDir = path.join(logsDir, "provider")
  return {
    host: options.host ?? "127.0.0.1",
    port,
    dataDir,
    runtimeHome,
    dbPath: path.join(dataDir, "betterc0de.db"),
    settingsPath: path.join(dataDir, "settings.json"),
    authPath: path.join(dataDir, "auth.json"),
    logsDir,
    providerLogsDir,
    providerEventLogPath: path.join(providerLogsDir, "events.log"),
    allowedOrigins: parseAllowedOrigins(process.env.BETTERC0DE_ALLOWED_ORIGINS),
    trustProxyHeaders: envFlag(process.env.BETTERC0DE_TRUST_PROXY),
    allowInsecureRemoteAccess: envFlag(
      process.env.BETTERC0DE_ALLOW_INSECURE_REMOTE_ACCESS
    ),
    runtimeHeapSnapshotsEnabled: envFlag(
      process.env.BETTERC0DE_ENABLE_HEAP_SNAPSHOTS
    ),
  }
}

/** Candidate ports tried in order at bind time. `0` = OS-assigned. */
export function candidatePorts(basePort: number): number[] {
  const ports = [basePort]
  for (let i = 1; i <= PORT_FALLBACK_COUNT; i++) ports.push(basePort + i)
  ports.push(0) // OS-assigned fallback
  return ports
}

function envFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "")
}
