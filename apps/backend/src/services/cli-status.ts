import type { ProviderAdapterRegistry } from "../provider/registry"
import type { CliStatus } from "../cli/detect"
import {
  detectCliAsync,
  detectCodexCliAsync,
  isClaudeCliAuthenticatedAsync,
  isCodexCliAuthenticatedAsync,
  isOpencodeCliAuthenticatedAsync,
} from "../cli/detect"
import {
  probeGrokProviderStatusAsync,
  type GrokProviderStatusProbe,
} from "../provider/runtime/grok-cli/GrokProviderStatus"
import {
  resolveCursorBinaryAsync,
  type ResolvedCursorBinary,
} from "../provider/runtime/cursor/CursorBinaryResolution"

export const CLI_STATUS_CACHE_TTL_MS = 30_000
export const CLI_STATUS_DEADLINE_MS = 8_000

export interface CliStatusSnapshot {
  readonly claude: CliStatus
  readonly codex: CliStatus
  readonly cli: {
    readonly claude: CliStatus
    readonly codex: CliStatus
    readonly "grok-cli": CliStatus
    readonly cursor: CliStatus
    readonly "opencode-cli": CliStatus
  }
  readonly adapters: Readonly<
    Record<string, { readonly configured: boolean; readonly name: string }>
  >
}

export interface CliStatusReaderDependencies {
  readonly detectClaude: (refresh: boolean) => Promise<CliStatus>
  readonly detectCodex: (refresh: boolean) => Promise<CliStatus>
  readonly detectOpencode: (refresh: boolean) => Promise<CliStatus>
  readonly probeGrok: () => Promise<GrokProviderStatusProbe>
  readonly resolveCursor: () => Promise<ResolvedCursorBinary | null>
  readonly now: () => number
  readonly ttlMs: number
  readonly deadlineMs: number
}

export class CliStatusDeadlineError extends Error {
  readonly statusCode = 503
  readonly code = "cli_status_timeout"

  constructor() {
    super("CLI status probe timed out")
    this.name = "CliStatusDeadlineError"
  }
}

interface CliStatusCacheEntry {
  readonly value: CliStatusSnapshot
  readonly expiresAt: number
}

export function createCliStatusReader(
  registry: ProviderAdapterRegistry,
  overrides: Partial<CliStatusReaderDependencies> = {}
): (input?: { readonly refresh?: boolean }) => Promise<CliStatusSnapshot> {
  const dependencies: CliStatusReaderDependencies = {
    detectClaude: (refresh) =>
      detectCliAsync("claude", {
        refresh,
        isAuthenticated: isClaudeCliAuthenticatedAsync,
        authType: "cli",
      }),
    detectCodex: (refresh) =>
      detectCodexCliAsync(null, {
        refresh,
        isAuthenticated: isCodexCliAuthenticatedAsync,
        authType: "cli",
      }),
    detectOpencode: (refresh) =>
      detectCliAsync("opencode", {
        refresh,
        isAuthenticated: isOpencodeCliAuthenticatedAsync,
        authType: "cli",
      }),
    probeGrok: () => probeGrokProviderStatusAsync({ env: process.env }),
    resolveCursor: () => resolveCursorBinaryAsync(null),
    now: Date.now,
    ttlMs: CLI_STATUS_CACHE_TTL_MS,
    deadlineMs: CLI_STATUS_DEADLINE_MS,
    ...overrides,
  }
  const ttlMs = positiveDuration(
    dependencies.ttlMs,
    CLI_STATUS_CACHE_TTL_MS
  )
  const deadlineMs = positiveDuration(
    dependencies.deadlineMs,
    CLI_STATUS_DEADLINE_MS
  )
  let cache: CliStatusCacheEntry | null = null
  let inFlight: Promise<CliStatusSnapshot> | null = null

  return async (input = {}) => {
    const now = dependencies.now()
    if (!input.refresh && cache && now < cache.expiresAt) {
      return cache.value
    }

    const stale = cache?.value ?? null
    if (!inFlight) {
      const probe = probeCliStatus(
        registry,
        dependencies,
        input.refresh === true
      ).then((value) => {
        cache = {
          value,
          expiresAt: dependencies.now() + ttlMs,
        }
        return value
      })
      inFlight = probe
      void probe.then(
        () => {
          if (inFlight === probe) inFlight = null
        },
        () => {
          if (inFlight === probe) inFlight = null
        }
      )
    }

    try {
      return await waitForCliStatus(inFlight, deadlineMs)
    } catch (error) {
      if (stale) return stale
      throw error
    }
  }
}

async function probeCliStatus(
  registry: ProviderAdapterRegistry,
  dependencies: CliStatusReaderDependencies,
  refresh: boolean
): Promise<CliStatusSnapshot> {
  const [claude, codex, opencode, grokProbe, cursorBinary] = await Promise.all([
    dependencies.detectClaude(refresh),
    dependencies.detectCodex(refresh),
    dependencies.detectOpencode(refresh),
    dependencies.probeGrok(),
    dependencies.resolveCursor(),
  ])
  const grokCli: CliStatus = {
    installed: grokProbe.installed,
    version: grokProbe.version,
    binaryPath: grokProbe.binaryPath ?? "",
    authenticated: grokProbe.auth.status === "authenticated",
    authType: grokProbe.auth.status === "authenticated" ? "cli" : null,
  }
  // Cursor keeps its login inside the CLI and only reveals it through
  // `cursor-agent about`, a spawn this path must never take. Install state
  // comes from the filesystem resolver; version and auth stay unknown and
  // the runtime probe (CursorProviderStatus) remains authoritative for them.
  const cursor: CliStatus = {
    installed: cursorBinary !== null,
    version: null,
    binaryPath: cursorBinary?.binaryPath ?? "",
    authenticated: false,
    authType: null,
  }

  return {
    claude,
    codex,
    cli: { claude, codex, "grok-cli": grokCli, cursor, "opencode-cli": opencode },
    adapters: snapshotAdapterConfiguration(registry, {
      anthropic_cli: claude,
      codex,
      "grok-cli": grokCli,
      // Keyed by the adapter's providerKind, not the CLI slot id.
      opencode_cli: opencode,
    }),
  }
}

function snapshotAdapterConfiguration(
  registry: ProviderAdapterRegistry,
  cliByProviderKind: Readonly<Record<string, CliStatus>>
): Record<string, { configured: boolean; name: string }> {
  const adapters: Record<string, { configured: boolean; name: string }> = {}
  for (const adapter of registry.all()) {
    const providerKind = adapter.providerKind()
    const cliStatus = cliByProviderKind[providerKind]
    const declaresCliAuth = adapter.authMeta?.().authType === "cli"
    adapters[providerKind] = {
      configured:
        cliStatus || declaresCliAuth
          ? Boolean(cliStatus?.installed && cliStatus.authenticated)
          : adapter.isConfigured(),
      name: adapter.displayName(),
    }
  }
  return adapters
}

function waitForCliStatus(
  source: Promise<CliStatusSnapshot>,
  deadlineMs: number
): Promise<CliStatusSnapshot> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new CliStatusDeadlineError())
    }, deadlineMs)
    timer.unref?.()

    void source.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function positiveDuration(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}
