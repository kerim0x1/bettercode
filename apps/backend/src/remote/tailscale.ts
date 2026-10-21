import { execFile } from "node:child_process"
import fs from "node:fs"
import { isIP } from "node:net"
import { stripVTControlCharacters } from "node:util"
import { logger } from "../observability/logger"

/**
 * Tailscale integration for Remote Access.
 *
 * `tailscale status --json` tells us whether the machine is on a tailnet,
 * which addresses are ours and what the MagicDNS name is. The tailnet address
 * is advertised as a plain-HTTP endpoint: WireGuard already encrypts the
 * traffic and Tailscale already authenticated the peer, so
 * `remote/http.ts` treats a request that arrived on one of our tailnet
 * addresses from a tailnet peer as private transport (full session, no
 * TLS). Optionally `tailscale serve` additionally publishes the backend as
 * `https://<machine>.<tailnet>.ts.net` with a certificate Tailscale issues —
 * useful for browsers that want a secure context. That proxy connects from
 * 127.0.0.1 with `X-Forwarded-*`, trusted only while the serve setting is on
 * (`ServerConfig.trustLoopbackProxyHeaders`).
 *
 * The CLI is spawned directly (never through a shell) and its stderr is never
 * logged or returned: `tailscale` prints auth keys and node names there.
 */

export const DEFAULT_TAILSCALE_SERVE_PORT = 443
const STATUS_TIMEOUT_MS = 2_000
const SERVE_TIMEOUT_MS = 10_000
const STATUS_CACHE_TTL_MS = 3_000

export type TailscaleBackendState =
  | "running"
  | "needs-login"
  | "stopped"
  | "unavailable"

export interface TailscaleStatus {
  installed: boolean
  state: TailscaleBackendState
  magicDnsName: string | null
  tailnetIpv4Addresses: string[]
  /** Every address Tailscale assigned to this machine (IPv4 and IPv6). */
  selfAddresses: string[]
  /** The tailnet issues HTTPS certificates (admin console → DNS → HTTPS). */
  httpsCertificates: boolean
}

/** What the desktop shows and the endpoint discovery advertises. */
export interface TailscaleRemoteState extends TailscaleStatus {
  /** `remote_access_tailscale_serve` as persisted. */
  serveEnabled: boolean
  /** Tailscale reports a serve mapping to this backend's port. */
  serveActive: boolean
  servePort: number
  httpsBaseUrl: string | null
}

export type TailscaleStderrDiagnostic =
  | "no-existing-handler"
  | "not-logged-in"
  | "permission-denied"
  | "unknown"

export type TailscaleCommandResult =
  | { ok: true; stdout: string }
  | {
      ok: false
      reason: "not-installed" | "timeout" | "exit"
      exitCode?: number
      diagnostic?: TailscaleStderrDiagnostic
    }

export type TailscaleCommandRunner = (
  args: readonly string[],
  timeoutMs: number
) => Promise<TailscaleCommandResult>

export function classifyTailscaleStderr(
  stderr: string
): TailscaleStderrDiagnostic | undefined {
  if (!stderr.trim()) return
  // CLI output may wrap lines or include terminal styling. Normalize only for
  // classification; neither raw text nor normalized text may reach the client.
  const words = stripVTControlCharacters(stderr)
    .toLowerCase()
    .split(/\s+/)
    .join(" ")
  const contains = (phrase: string) => words.includes(phrase)
  if (contains("handler does not exist")) return "no-existing-handler"
  if (
    ["not logged in", "logged out", "need login", "needs login"].some(contains)
  )
    return "not-logged-in"
  if (
    [
      "permission denied",
      "access denied",
      "access is denied",
      "must be root",
      "operation not permitted",
    ].some(contains)
  )
    return "permission-denied"
  return "unknown"
}

/**
 * The CLI is a real executable everywhere (`tailscale.exe` on Windows), so it
 * is spawned directly. PATH is tried first; the stock install locations cover
 * a desktop that was launched before the installer updated PATH.
 */
export function tailscaleExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files"
    return ["tailscale.exe", `${programFiles}\\Tailscale\\tailscale.exe`]
  }
  if (platform === "darwin") {
    return [
      "tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/usr/local/bin/tailscale",
      "/opt/homebrew/bin/tailscale",
    ]
  }
  return ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale"]
}

function isSpawnNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

/** Real runner: first candidate that exists (or resolves on PATH) wins. */
export function createTailscaleCommandRunner(
  options: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
  } = {}
): TailscaleCommandRunner {
  const candidates = tailscaleExecutableCandidates(
    options.platform,
    options.env
  )
  let resolved: string | null = null

  const attempt = (
    executable: string,
    args: readonly string[],
    timeoutMs: number
  ): Promise<TailscaleCommandResult | "not-found"> =>
    new Promise((resolve) => {
      execFile(
        executable,
        [...args],
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: options.env ?? process.env,
        },
        (error, stdout, stderr) => {
          if (error) {
            if (isSpawnNotFound(error)) return resolve("not-found")
            if ((error as { killed?: boolean }).killed) {
              return resolve({ ok: false, reason: "timeout" })
            }
            const exitCode =
              typeof (error as { code?: unknown }).code === "number"
                ? (error as { code: number }).code
                : -1
            const diagnostic = classifyTailscaleStderr(String(stderr ?? ""))
            return resolve({
              ok: false,
              reason: "exit",
              exitCode,
              ...(diagnostic ? { diagnostic } : {}),
            })
          }
          resolve({ ok: true, stdout: String(stdout ?? "") })
        }
      )
    })

  return async (args, timeoutMs) => {
    const order = resolved
      ? [resolved]
      : candidates.filter(
          (candidate, index) => index === 0 || fs.existsSync(candidate)
        )
    for (const executable of order) {
      const result = await attempt(executable, args, timeoutMs)
      if (result === "not-found") continue
      resolved = executable
      return result
    }
    return { ok: false, reason: "not-installed" }
  }
}

// ── Pure parsers ──────────────────────────────────────────────────────

export function isTailscaleIpv4Address(address: string): boolean {
  if (isIP(address) !== 4) return false
  const octets = address.split(".").map(Number)
  return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127
}

/** Strips IPv4-mapped and bracket forms so socket addresses compare equal. */
export function normalizeSocketAddress(address: string): string {
  return address
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/^::ffff:/i, "")
    .toLowerCase()
}

/**
 * Tailscale hands out 100.64.0.0/10 and the fd7a:115c:a1e0::/48 ULA. Either
 * side of a socket must look like this before it can be tailnet transport;
 * the local side must additionally be one of our own addresses.
 */
export function isTailscaleAddress(address: string): boolean {
  const normalized = normalizeSocketAddress(address)
  return (
    isTailscaleIpv4Address(normalized) ||
    (isIP(normalized) === 6 && normalized.startsWith("fd7a:115c:a1e0:"))
  )
}

function normalizeMagicDnsName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().replace(/\.$/u, "").toLowerCase()
  return normalized.length > 0 ? normalized : null
}

/** Parses `tailscale status --json`. Tolerates missing fields. */
export function parseTailscaleStatus(rawJson: string): TailscaleStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return {
      installed: true,
      state: "unavailable",
      magicDnsName: null,
      tailnetIpv4Addresses: [],
      selfAddresses: [],
      httpsCertificates: false,
    }
  }
  const record = (parsed ?? {}) as {
    BackendState?: unknown
    CertDomains?: unknown
    Self?: { DNSName?: unknown; TailscaleIPs?: unknown } | null
  }
  const backendState =
    typeof record.BackendState === "string" ? record.BackendState : ""
  const state: TailscaleBackendState =
    backendState === "Running"
      ? "running"
      : backendState === "NeedsLogin"
        ? "needs-login"
        : backendState === "Stopped" || backendState === "NoState"
          ? "stopped"
          : "unavailable"
  const rawIps = record.Self?.TailscaleIPs
  const selfAddresses = Array.isArray(rawIps)
    ? rawIps
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalizeSocketAddress)
        .filter(isTailscaleAddress)
    : []
  const tailnetIpv4Addresses = selfAddresses.filter(isTailscaleIpv4Address)
  const certDomains = Array.isArray(record.CertDomains)
    ? record.CertDomains.filter((entry) => typeof entry === "string")
    : []
  return {
    installed: true,
    state,
    magicDnsName: normalizeMagicDnsName(record.Self?.DNSName),
    tailnetIpv4Addresses,
    selfAddresses,
    httpsCertificates: certDomains.length > 0,
  }
}

/**
 * Finds the HTTPS port under which `tailscale serve status --json` proxies to
 * this backend, scanning both background (`Web`) and foreground mappings.
 * Tailscale normalizes the target to `http://127.0.0.1:<port>`, but the
 * match also accepts `localhost`.
 */
export function findTailscaleServeMapping(
  rawJson: string,
  localPort: number
): { servePort: number } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return null
  }
  const target = new RegExp(
    `^(?:https?://)?(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${localPort}/?$`,
    "i"
  )
  const scan = (config: unknown): number | null => {
    const web = (config as { Web?: unknown } | null)?.Web
    if (!web || typeof web !== "object") return null
    for (const [hostPort, entry] of Object.entries(
      web as Record<string, unknown>
    )) {
      const handlers = (entry as { Handlers?: unknown } | null)?.Handlers
      if (!handlers || typeof handlers !== "object") continue
      for (const handler of Object.values(
        handlers as Record<string, unknown>
      )) {
        const proxy = (handler as { Proxy?: unknown } | null)?.Proxy
        if (typeof proxy !== "string" || !target.test(proxy.trim())) continue
        const port = Number.parseInt(
          hostPort.slice(hostPort.lastIndexOf(":") + 1),
          10
        )
        return Number.isInteger(port) && port > 0
          ? port
          : DEFAULT_TAILSCALE_SERVE_PORT
      }
    }
    return null
  }
  const direct = scan(parsed)
  if (direct !== null) return { servePort: direct }
  const foreground = (parsed as { Foreground?: unknown } | null)?.Foreground
  if (foreground && typeof foreground === "object") {
    for (const config of Object.values(foreground as Record<string, unknown>)) {
      const port = scan(config)
      if (port !== null) return { servePort: port }
    }
  }
  return null
}

export function buildTailscaleHttpsBaseUrl(
  magicDnsName: string,
  servePort: number = DEFAULT_TAILSCALE_SERVE_PORT
): string {
  const url = new URL(`https://${magicDnsName}`)
  if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) url.port = String(servePort)
  return url.toString().replace(/\/$/, "")
}

export function tailscaleServeArgs(input: {
  localPort: number
  servePort?: number
}): string[] {
  const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT
  return [
    "serve",
    "--bg",
    `--https=${servePort}`,
    `http://127.0.0.1:${input.localPort}`,
  ]
}

export function tailscaleServeOffArgs(
  servePort: number = DEFAULT_TAILSCALE_SERVE_PORT
): string[] {
  return ["serve", `--https=${servePort}`, "off"]
}

// ── Service ───────────────────────────────────────────────────────────

export class TailscaleCommandError extends Error {
  constructor(
    readonly subcommand: "status" | "serve",
    readonly result: Exclude<TailscaleCommandResult, { ok: true }>
  ) {
    super(describeFailure(subcommand, result))
    this.name = "TailscaleCommandError"
  }
}

function describeFailure(
  subcommand: string,
  result: Exclude<TailscaleCommandResult, { ok: true }>
): string {
  switch (result.reason) {
    case "not-installed":
      return "Tailscale is not installed on this computer"
    case "timeout":
      return `tailscale ${subcommand} did not respond in time`
    default:
      switch (result.diagnostic) {
        case "not-logged-in":
          return "Tailscale is installed but not logged in"
        case "permission-denied":
          return "Tailscale refused the command for this user"
        case "no-existing-handler":
          return "Tailscale Serve had no mapping to remove"
        default:
          return `tailscale ${subcommand} exited with code ${result.exitCode ?? "?"}`
      }
  }
}

export interface TailscaleRemoteAccess {
  status(): Promise<TailscaleStatus>
  /**
   * Our tailnet addresses from the last status read, synchronously, for the
   * per-request transport check. Empty until the first read completes; a
   * stale snapshot triggers a background refresh so a machine that joined
   * or left the tailnet is noticed without a restart.
   */
  selfAddresses(): ReadonlySet<string>
  describe(input: {
    localPort: number
    serveEnabled: boolean
  }): Promise<TailscaleRemoteState>
  /** Idempotent: re-applies the mapping to the current backend port. */
  enableServe(localPort: number): Promise<void>
  disableServe(): Promise<void>
}

const NOT_INSTALLED: TailscaleStatus = {
  installed: false,
  state: "unavailable",
  magicDnsName: null,
  tailnetIpv4Addresses: [],
  selfAddresses: [],
  httpsCertificates: false,
}

/** How long the synchronous address snapshot may age before a refresh. */
const SELF_ADDRESS_REFRESH_MS = 60_000

export function createTailscaleRemoteAccess(
  options: {
    run?: TailscaleCommandRunner
    now?: () => number
    servePort?: number
  } = {}
): TailscaleRemoteAccess {
  const run = options.run ?? createTailscaleCommandRunner()
  const now = options.now ?? Date.now
  const servePort = options.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT
  let cachedStatus: { at: number; value: TailscaleStatus } | null = null
  let inflightStatus: Promise<TailscaleStatus> | null = null

  const status = async (): Promise<TailscaleStatus> => {
    if (cachedStatus && now() - cachedStatus.at < STATUS_CACHE_TTL_MS) {
      return cachedStatus.value
    }
    if (inflightStatus) return inflightStatus
    inflightStatus = (async () => {
      const result = await run(["status", "--json"], STATUS_TIMEOUT_MS)
      let value: TailscaleStatus
      if (result.ok) {
        value = parseTailscaleStatus(result.stdout)
      } else if (result.reason === "not-installed") {
        value = NOT_INSTALLED
      } else {
        value = {
          ...NOT_INSTALLED,
          installed: true,
          state:
            result.diagnostic === "not-logged-in"
              ? "needs-login"
              : "unavailable",
        }
      }
      cachedStatus = { at: now(), value }
      return value
    })().finally(() => {
      inflightStatus = null
    })
    return inflightStatus
  }

  const serveMapping = async (
    localPort: number
  ): Promise<{ servePort: number } | null> => {
    const result = await run(["serve", "status", "--json"], STATUS_TIMEOUT_MS)
    if (!result.ok) return null
    return findTailscaleServeMapping(result.stdout, localPort)
  }

  return {
    status,
    selfAddresses() {
      if (!cachedStatus || now() - cachedStatus.at >= SELF_ADDRESS_REFRESH_MS) {
        void status().catch(() => undefined)
      }
      const known = cachedStatus?.value
      return new Set(
        known && known.state === "running" ? known.selfAddresses : []
      )
    },
    async describe(input) {
      const current = await status()
      const mapping =
        current.state === "running" ? await serveMapping(input.localPort) : null
      const activePort = mapping?.servePort ?? servePort
      return {
        ...current,
        serveEnabled: input.serveEnabled,
        serveActive: mapping !== null,
        servePort: activePort,
        httpsBaseUrl: current.magicDnsName
          ? buildTailscaleHttpsBaseUrl(current.magicDnsName, activePort)
          : null,
      }
    },
    async enableServe(localPort) {
      const result = await run(
        tailscaleServeArgs({ localPort, servePort }),
        SERVE_TIMEOUT_MS
      )
      cachedStatus = null
      if (!result.ok) throw new TailscaleCommandError("serve", result)
    },
    async disableServe() {
      const result = await run(
        tailscaleServeOffArgs(servePort),
        SERVE_TIMEOUT_MS
      )
      cachedStatus = null
      // Nothing to remove is the state we wanted.
      if (!result.ok && result.diagnostic !== "no-existing-handler") {
        throw new TailscaleCommandError("serve", result)
      }
    },
  }
}

/**
 * Boot-time reconcile: the backend port can change between launches, so a
 * persisted serve setting is re-pointed at the port that actually bound.
 * Best effort — a failure is logged, never fatal, and shows up in the
 * Remote Access settings as "not active".
 */
export async function reconcileTailscaleServe(
  tailscale: TailscaleRemoteAccess,
  input: { enabled: boolean; remoteAccessEnabled: boolean; localPort: number }
): Promise<void> {
  if (!input.remoteAccessEnabled) return
  // Prime the address snapshot so the first tailnet request is classified
  // correctly instead of waiting for a settings page to ask for status.
  await tailscale.status().catch(() => undefined)
  if (!input.enabled) return
  try {
    await tailscale.enableServe(input.localPort)
    logger.info({ port: input.localPort }, "Tailscale Serve mapped to backend")
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Tailscale Serve could not be applied at startup"
    )
  }
}
