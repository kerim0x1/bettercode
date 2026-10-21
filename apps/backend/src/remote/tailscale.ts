import { execFile } from "node:child_process"
import fs from "node:fs"
import https from "node:https"
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
 * TLS). `tailscale serve` publishes the backend as
 * `https://<machine>.<tailnet>.ts.net` with a certificate Tailscale issues:
 * the recommended way, because tailscaled itself accepts the connection, so
 * it works while the backend listens on loopback only — no firewall rule, no
 * network listener. That proxy connects from 127.0.0.1 with
 * `X-Forwarded-*`, trusted only while the serve setting is on
 * (`ServerConfig.trustLoopbackProxyHeaders`). After turning it on, the name
 * is probed until it answers as this desktop: Tailscale issues the
 * certificate on the first request, which can take a few seconds.
 *
 * The CLI is spawned directly (never through a shell) and its stderr is never
 * logged or returned: `tailscale` prints auth keys and node names there.
 */

export const DEFAULT_TAILSCALE_SERVE_PORT = 443
const STATUS_TIMEOUT_MS = 2_000
const SERVE_TIMEOUT_MS = 10_000
/** Shutdown must not wait long for a CLI that hangs. */
const RELEASE_TIMEOUT_MS = 3_000
const STATUS_CACHE_TTL_MS = 3_000
const PROBE_TIMEOUT_MS = 2_500
/** A name that answered stays good for a while; a miss is retried soon. */
const PROBE_HIT_TTL_MS = 15_000
const PROBE_MISS_TTL_MS = 2_000
/** Public and unauthenticated: answers with this desktop's environment id. */
const PROBE_PATH = "/api/v1/remote/bootstrap"

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
  /** The Tailscale service answered the CLI. */
  serviceRunning: boolean
  /** `CurrentTailnet.MagicDNSEnabled`, when this Tailscale reports it. */
  magicDnsEnabled: boolean | null
}

/** What the desktop shows and the endpoint discovery advertises. */
export interface TailscaleRemoteState extends TailscaleStatus {
  /** `remote_access_tailscale_serve` as persisted. */
  serveEnabled: boolean
  /** Tailscale reports a serve mapping to this backend's port. */
  serveActive: boolean
  servePort: number
  httpsBaseUrl: string | null
  /** The HTTPS name answered as this desktop; `null` when not checked. */
  serveReachable: boolean | null
  /** Why turning on Serve failed last, or what answers instead of us. */
  serveError: string | null
  /** Tailscale's page for allowing Serve on this tailnet. */
  serveConsentUrl: string | null
}

export type TailscaleStderrDiagnostic =
  | "no-existing-handler"
  | "not-logged-in"
  | "permission-denied"
  | "not-running"
  | "unknown"

export type TailscaleCommandResult =
  | { ok: true; stdout: string }
  | {
      ok: false
      reason: "not-installed" | "timeout" | "exit"
      exitCode?: number
      diagnostic?: TailscaleStderrDiagnostic
      /**
       * The CLI asked for Serve or HTTPS to be allowed on the tailnet first
       * and printed Tailscale's page for that. Only ever this exact shape of
       * URL leaves the runner, never other CLI text.
       */
      consentUrl?: string
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
  // "failed to connect to local tailscaled process; is the Tailscale service
  // running?" (Windows), "...; it doesn't appear to be running" (Linux),
  // "failed to connect to local Tailscale service" (macOS).
  if (
    [
      "failed to connect to local",
      "is the tailscale service running",
      "doesn't appear to be running",
    ].some(contains)
  )
    return "not-running"
  return "unknown"
}

const CONSENT_URL =
  /https:\/\/login\.tailscale\.com\/f\/[a-z][a-z0-9-]{0,31}\?node=[A-Za-z0-9_-]{1,64}/

/**
 * When Serve (or HTTPS) is not yet allowed on the tailnet, `tailscale serve`
 * prints Tailscale's page for allowing it and waits. Only a URL of exactly
 * that shape is taken from the output; everything else stays unread.
 */
export function findTailscaleConsentUrl(output: string): string | undefined {
  return CONSENT_URL.exec(stripVTControlCharacters(output))?.[0]
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
            const consentUrl = findTailscaleConsentUrl(
              `${String(stdout ?? "")}\n${String(stderr ?? "")}`
            )
            const consent = consentUrl ? { consentUrl } : {}
            if ((error as { killed?: boolean }).killed) {
              // A serve that waits for the tailnet's consent ends here.
              return resolve({ ok: false, reason: "timeout", ...consent })
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
              ...consent,
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
      serviceRunning: true,
      magicDnsEnabled: null,
    }
  }
  const record = (parsed ?? {}) as {
    BackendState?: unknown
    CertDomains?: unknown
    CurrentTailnet?: { MagicDNSEnabled?: unknown } | null
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
  const magicDnsEnabled = record.CurrentTailnet?.MagicDNSEnabled
  return {
    installed: true,
    state,
    magicDnsName: normalizeMagicDnsName(record.Self?.DNSName),
    tailnetIpv4Addresses,
    selfAddresses,
    httpsCertificates: certDomains.length > 0,
    serviceRunning: true,
    magicDnsEnabled:
      typeof magicDnsEnabled === "boolean" ? magicDnsEnabled : null,
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

// ── HTTPS probe ───────────────────────────────────────────────────────

export type TailscaleProbeResult = "reachable" | "unreachable" | "other"

export interface TailscaleProbeInput {
  magicDnsName: string
  servePort: number
  /**
   * This machine's tailnet address to dial. Tailscale Serve listens on it,
   * and dialing it directly keeps the check independent of whether MagicDNS
   * resolves on this computer; the certificate is still checked against the
   * name.
   */
  address: string | null
  /** This desktop's id; another BetterC0de answering counts as `other`. */
  environmentId: string | null
  timeoutMs: number
}

export type TailscaleHttpsProbe = (
  input: TailscaleProbeInput
) => Promise<TailscaleProbeResult>

/**
 * Asks `https://<name>/api/v1/remote/bootstrap` who answers. A bad-gateway
 * answer means Serve is up but proxies to a backend that is gone, which is
 * a mapping still settling, not someone else's service.
 */
export const probeTailscaleHttps: TailscaleHttpsProbe = (input) =>
  new Promise((resolve) => {
    let settled = false
    const done = (result: TailscaleProbeResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const hostHeader =
      input.servePort === DEFAULT_TAILSCALE_SERVE_PORT
        ? input.magicDnsName
        : `${input.magicDnsName}:${input.servePort}`
    let request: ReturnType<typeof https.request>
    try {
      request = https.request(
        {
          host: input.address ?? input.magicDnsName,
          servername: input.magicDnsName,
          port: input.servePort,
          path: PROBE_PATH,
          method: "GET",
          headers: { Host: hostHeader, Accept: "application/json" },
          timeout: input.timeoutMs,
          // A fresh connection per probe: a pooled one could outlive the
          // certificate Tailscale was still issuing.
          agent: false,
        },
        (response) => {
          const status = response.statusCode ?? 0
          let body = ""
          response.setEncoding("utf8")
          response.on("data", (chunk: string) => {
            if (body.length < 64 * 1024) body += chunk
          })
          response.on("error", () => done("unreachable"))
          response.on("end", () => {
            if (status === 502 || status === 503 || status === 504) {
              return done("unreachable")
            }
            if (status < 200 || status >= 300) return done("other")
            if (!input.environmentId) return done("reachable")
            try {
              const answered = (JSON.parse(body) as { environmentId?: unknown })
                .environmentId
              done(answered === input.environmentId ? "reachable" : "other")
            } catch {
              done("other")
            }
          })
        }
      )
    } catch {
      done("unreachable")
      return
    }
    request.on("timeout", () => {
      request.destroy()
      done("unreachable")
    })
    request.on("error", () => done("unreachable"))
    request.end()
  })

// ── Service ───────────────────────────────────────────────────────────

export class TailscaleCommandError extends Error {
  readonly consentUrl: string | null

  constructor(
    readonly subcommand: "status" | "serve",
    readonly result: Exclude<TailscaleCommandResult, { ok: true }>
  ) {
    super(describeFailure(subcommand, result))
    this.name = "TailscaleCommandError"
    this.consentUrl = result.consentUrl ?? null
  }
}

function describeFailure(
  subcommand: string,
  result: Exclude<TailscaleCommandResult, { ok: true }>
): string {
  if (result.consentUrl) {
    return "Tailscale Serve is not allowed on this tailnet yet. Allow it in Tailscale, then try again."
  }
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
        case "not-running":
          return "The Tailscale service is not running on this computer"
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
    /** Check that the HTTPS name answers as this desktop (cached briefly). */
    probe?: boolean
    environmentId?: string | null
  }): Promise<TailscaleRemoteState>
  /** Idempotent: re-applies the mapping to the current backend port. */
  enableServe(localPort: number): Promise<void>
  disableServe(): Promise<void>
  /**
   * Probes the HTTPS name until it answers as this desktop. Tailscale
   * issues the certificate on the first request to a new mapping, which can
   * take a few seconds. `true` once it answered.
   */
  waitForServe(input: {
    environmentId: string | null
    attempts?: number
    intervalMs?: number
  }): Promise<boolean>
  /**
   * Shutdown: removes the mapping this process applied, so the name stops
   * pointing at a backend that is gone. Never throws.
   */
  releaseServe(): Promise<void>
}

const NOT_INSTALLED: TailscaleStatus = {
  installed: false,
  state: "unavailable",
  magicDnsName: null,
  tailnetIpv4Addresses: [],
  selfAddresses: [],
  httpsCertificates: false,
  serviceRunning: false,
  magicDnsEnabled: null,
}

/** How long the synchronous address snapshot may age before a refresh. */
const SELF_ADDRESS_REFRESH_MS = 60_000

export function createTailscaleRemoteAccess(
  options: {
    run?: TailscaleCommandRunner
    probe?: TailscaleHttpsProbe
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    servePort?: number
  } = {}
): TailscaleRemoteAccess {
  const run = options.run ?? createTailscaleCommandRunner()
  const probe = options.probe ?? probeTailscaleHttps
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const servePort = options.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT
  let cachedStatus: { at: number; value: TailscaleStatus } | null = null
  let inflightStatus: Promise<TailscaleStatus> | null = null
  let cachedProbe: {
    key: string
    at: number
    result: TailscaleProbeResult
  } | null = null
  let lastServeFailure: { message: string; consentUrl: string | null } | null =
    null
  /** This process put a mapping in place that shutdown should take down. */
  let appliedServe = false

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
              : result.diagnostic === "not-running"
                ? "stopped"
                : "unavailable",
          serviceRunning: result.diagnostic === "not-logged-in",
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

  const probeOnce = async (
    current: TailscaleStatus,
    port: number,
    environmentId: string | null,
    useCache: boolean
  ): Promise<TailscaleProbeResult> => {
    if (!current.magicDnsName) return "unreachable"
    const key = `${current.magicDnsName}:${port}:${environmentId ?? ""}`
    if (useCache && cachedProbe?.key === key) {
      const ttl =
        cachedProbe.result === "unreachable"
          ? PROBE_MISS_TTL_MS
          : PROBE_HIT_TTL_MS
      if (now() - cachedProbe.at < ttl) return cachedProbe.result
    }
    const result = await probe({
      magicDnsName: current.magicDnsName,
      servePort: port,
      address: current.tailnetIpv4Addresses[0] ?? null,
      environmentId,
      timeoutMs: PROBE_TIMEOUT_MS,
    }).catch((): TailscaleProbeResult => "unreachable")
    cachedProbe = { key, at: now(), result }
    return result
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
      let serveReachable: boolean | null = null
      let serveError = lastServeFailure?.message ?? null
      if (input.probe && input.serveEnabled && mapping) {
        const probed = await probeOnce(
          current,
          activePort,
          input.environmentId ?? null,
          true
        )
        serveReachable = probed === "reachable"
        if (probed === "other") {
          serveError = `Something other than this desktop answers on https://${current.magicDnsName}${activePort === DEFAULT_TAILSCALE_SERVE_PORT ? "" : `:${activePort}`}.`
        }
      }
      return {
        ...current,
        serveEnabled: input.serveEnabled,
        serveActive: mapping !== null,
        servePort: activePort,
        httpsBaseUrl: current.magicDnsName
          ? buildTailscaleHttpsBaseUrl(current.magicDnsName, activePort)
          : null,
        serveReachable,
        serveError,
        serveConsentUrl: lastServeFailure?.consentUrl ?? null,
      }
    },
    async enableServe(localPort) {
      const result = await run(
        tailscaleServeArgs({ localPort, servePort }),
        SERVE_TIMEOUT_MS
      )
      cachedStatus = null
      cachedProbe = null
      if (!result.ok) {
        const error = new TailscaleCommandError("serve", result)
        lastServeFailure = {
          message: error.message,
          consentUrl: error.consentUrl,
        }
        throw error
      }
      lastServeFailure = null
      appliedServe = true
    },
    async disableServe() {
      const result = await run(
        tailscaleServeOffArgs(servePort),
        SERVE_TIMEOUT_MS
      )
      cachedStatus = null
      cachedProbe = null
      // Nothing to remove is the state we wanted.
      if (!result.ok && result.diagnostic !== "no-existing-handler") {
        throw new TailscaleCommandError("serve", result)
      }
      lastServeFailure = null
      appliedServe = false
    },
    async waitForServe(input) {
      const attempts = Math.max(1, input.attempts ?? 5)
      const intervalMs = input.intervalMs ?? 1_000
      const current = await status()
      if (current.state !== "running" || !current.magicDnsName) return false
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const result = await probeOnce(
          current,
          servePort,
          input.environmentId,
          false
        )
        if (result === "reachable") return true
        if (result === "other") return false
        if (attempt < attempts - 1) await sleep(intervalMs)
      }
      return false
    },
    async releaseServe() {
      if (!appliedServe) return
      appliedServe = false
      cachedProbe = null
      try {
        await run(tailscaleServeOffArgs(servePort), RELEASE_TIMEOUT_MS)
      } catch {
        // Best effort: the next start re-points or removes the mapping.
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
