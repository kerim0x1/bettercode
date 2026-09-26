import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { resolveCursorBinaryAsync } from "./CursorBinaryResolution"
import {
  buildWindowsCmdArgs,
  requiresWindowsCmdWrapper,
  resolveComSpec,
} from "../../../security/windowsCommandLine"
import {
  appendBoundedProcessOutput,
  createBoundedProcessOutput,
  processOutputLimitError,
} from "../BoundedProcessOutput"
import { terminateProviderChildProcessTree } from "../ChildProcessTermination"

const ABOUT_TIMEOUT_MS = 8_000
const CURSOR_NOT_INSTALLED_MESSAGE =
  "Cursor Agent CLI was not found. Install it from cursor.com/install, or set its full path in Settings → Providers."

export interface CursorCommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export interface CursorProviderAuth {
  readonly status: "authenticated" | "unauthenticated" | "unknown"
  readonly type?: string
  readonly label?: string
  readonly email?: string
}

export interface CursorAboutResult {
  readonly version: string | null
  readonly status: "ready" | "warning" | "error"
  readonly auth: CursorProviderAuth
  readonly message?: string
}

export interface CursorProviderStatusProbe extends CursorAboutResult {
  readonly installed: boolean
  readonly configured: boolean
}

interface CursorAboutJsonPayload {
  readonly cliVersion?: unknown
  readonly subscriptionTier?: unknown
  readonly userEmail?: unknown
}

/**
 * Probe results cache for 60s and callers with the same identity share an
 * in-flight probe. Child commands run one at a time. Without this, every
 * `listInstances` (30s frontend poll × several
 * mounted hooks × StrictMode) spawned its own `agent about` child — and
 * on Windows a timed-out probe orphaned the whole grandchild tree (the
 * SIGTERM only hit the cmd wrapper). That combination was a process
 * storm on app start.
 */
const STATUS_CACHE_TTL_MS = 60_000
const statusCache = new Map<
  string,
  { ts: number; result: CursorProviderStatusProbe }
>()
const statusInFlight = new Map<string, Promise<CursorProviderStatusProbe>>()
const STATUS_CACHE_MAX_ENTRIES = 32
let activeStatusCommand: ChildProcess | null = null
let failedStatusCommand: ChildProcess | null = null
let statusCleanupInFlight: Promise<void> | null = null

/**
 * Test isolation. The cleanup fence above is process-wide on purpose: once a
 * Windows root has exited, an unconfirmed tree cleanup blocks every later
 * probe. Between tests that fence must not carry over, or one test's slow
 * real process-tree cleanup fails the next test's first probe.
 */
export function __resetCursorStatusProbeStateForTests(): void {
  statusCache.clear()
  statusInFlight.clear()
  activeStatusCommand = null
  failedStatusCommand = null
  statusCleanupInFlight = null
}

export function probeCursorProviderStatus(input: {
  readonly binaryPath: string
  readonly env?: NodeJS.ProcessEnv
  readonly refresh?: boolean
}): Promise<CursorProviderStatusProbe> {
  const env = { ...(input.env ?? process.env) }
  // Account, configuration and PATH may differ between provider instances.
  // Hash the snapshot so cache keys do not retain plaintext credentials.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        input.binaryPath,
        Object.entries(env).sort(([left], [right]) =>
          left.localeCompare(right)
        ),
      ])
    )
    .digest("hex")
  const cached = statusCache.get(key)
  if (
    !input.refresh &&
    !failedStatusCommand &&
    cached &&
    Date.now() - cached.ts < STATUS_CACHE_TTL_MS
  ) {
    return Promise.resolve(cached.result)
  }
  const inFlight = statusInFlight.get(key)
  if (inFlight) return inFlight
  const promise = probeCursorProviderStatusUncached({ ...input, env })
    .then((result) => {
      // Busy probes and failed cleanup must be retried by the next status poll.
      if (result.status === "error") {
        statusCache.delete(key)
        return result
      }
      statusCache.delete(key)
      statusCache.set(key, { ts: Date.now(), result })
      while (statusCache.size > STATUS_CACHE_MAX_ENTRIES) {
        statusCache.delete(statusCache.keys().next().value!)
      }
      return result
    })
    .finally(() => {
      if (statusInFlight.get(key) === promise) statusInFlight.delete(key)
    })
  statusInFlight.set(key, promise)
  return promise
}

async function probeCursorProviderStatusUncached(input: {
  readonly binaryPath: string
  readonly env?: NodeJS.ProcessEnv
}): Promise<CursorProviderStatusProbe> {
  const env = input.env ?? process.env
  // Resolve on disk before spawning: the bare name `agent` belongs to other
  // vendors on some machines, and probing it would run their agent instead.
  const resolved = await resolveCursorBinaryAsync(input.binaryPath)
  if (!resolved) {
    return {
      installed: false,
      configured: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: CURSOR_NOT_INSTALLED_MESSAGE,
    }
  }
  const command = resolved.binaryPath
  const aboutResult = await runCursorAboutCommand(command, env).catch(
    (
      error: unknown
    ): CursorCommandResult & { readonly commandMissing?: boolean } => ({
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: -1,
      commandMissing: isCommandMissingError(error),
    })
  )

  if ("commandMissing" in aboutResult && aboutResult.commandMissing) {
    return {
      installed: false,
      configured: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: CURSOR_NOT_INSTALLED_MESSAGE,
    }
  }

  if (aboutResult.code === -1 && /timed out/i.test(aboutResult.stderr)) {
    return {
      installed: true,
      configured: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message:
        "Cursor Agent CLI is installed but timed out while running `agent about`.",
    }
  }

  if (aboutResult.code === -1) {
    return {
      installed: true,
      configured: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message:
        "Cursor Agent status could not be verified. Retry the status check.",
    }
  }

  const parsed = parseCursorAboutOutput(aboutResult)
  const configured =
    parsed.status !== "error" && parsed.auth.status !== "unauthenticated"

  return {
    installed: true,
    configured,
    version: parsed.version,
    status: parsed.status,
    auth: parsed.auth,
    ...(parsed.message ? { message: parsed.message } : {}),
  }
}

export function parseCursorAboutOutput(
  result: CursorCommandResult
): CursorAboutResult {
  const json = parseCursorAboutJsonPayload(result.stdout)
  const transcript = [result.stdout, result.stderr].join("\n")
  if (
    !json &&
    /unknown command|unrecognized command|unexpected argument/i.test(transcript)
  ) {
    return {
      status: "warning",
      version: null,
      auth: { status: "unknown" },
      message:
        "The `agent about` command is unavailable in this version of the Cursor Agent CLI.",
    }
  }
  const field = (value: unknown) =>
    typeof value === "string" ? value.trim() : undefined
  const plain = json ? "" : stripAnsi(transcript)
  const version =
    (json ? field(json.cliVersion) : extractAboutField(plain, "CLI Version")) ??
    null
  const email = json
    ? field(json.userEmail)
    : extractAboutField(plain, "User Email")
  const explicitlyLoggedOut =
    json && hasOwn(json, "userEmail") && json.userEmail == null
  if (
    explicitlyLoggedOut ||
    (email !== undefined && isUnauthenticatedCursorEmail(email))
  ) {
    return unauthenticatedCursorAbout(version)
  }
  const metadata = json
    ? cursorAuthMetadata(field(json.subscriptionTier))
    : undefined
  if (email) {
    return {
      auth: { ...metadata, status: "authenticated", email },
      status: "ready",
      version,
    }
  }
  if (result.code !== 0) {
    return {
      auth: { status: "unknown" },
      status: "warning",
      version,
      message: "Could not verify Cursor Agent authentication status.",
    }
  }
  return { auth: { ...metadata, status: "unknown" }, status: "ready", version }
}

async function runCursorAboutCommand(
  binaryPath: string,
  env: NodeJS.ProcessEnv
): Promise<CursorCommandResult> {
  const jsonResult = await runCommand(
    binaryPath,
    ["about", "--format", "json"],
    {
      env,
      timeoutMs: ABOUT_TIMEOUT_MS,
    }
  )
  if (!isCursorAboutJsonFormatUnsupported(jsonResult)) return jsonResult
  return runCommand(binaryPath, ["about"], {
    env,
    timeoutMs: ABOUT_TIMEOUT_MS,
  })
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number }
): Promise<CursorCommandResult> {
  if (failedStatusCommand) {
    if (
      process.platform === "win32" &&
      (failedStatusCommand.exitCode !== null ||
        failedStatusCommand.signalCode !== null)
    ) {
      // An exited root no longer identifies its descendants safely. Retain
      // the fence instead of mistaking the helper's early return for cleanup.
      throw new Error(
        "Cursor status process-tree cleanup remains unconfirmed after its root exited."
      )
    }
    if (!statusCleanupInFlight) {
      const child = failedStatusCommand
      const cleanup = terminateProviderChildProcessTree(child)
        .then(() => {
          if (failedStatusCommand === child) failedStatusCommand = null
        })
        .finally(() => {
          if (statusCleanupInFlight === cleanup) statusCleanupInFlight = null
        })
      statusCleanupInFlight = cleanup
    }
    await statusCleanupInFlight
  }
  if (activeStatusCommand)
    throw new Error("Another Cursor status command is already running.")
  return new Promise((resolve, reject) => {
    const viaCmd = requiresWindowsCmdWrapper(command)
    const child = spawn(
      viaCmd ? resolveComSpec() : command,
      viaCmd ? buildWindowsCmdArgs(command, args) : [...args],
      {
        env: options.env,
        shell: false,
        windowsVerbatimArguments: viaCmd,
        detached: process.platform !== "win32",
        windowsHide: true,
      }
    )
    activeStatusCommand = child
    const output = createBoundedProcessOutput()
    let settled = false
    let terminating = false
    const finish = (error?: Error, code?: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (activeStatusCommand === child) activeStatusCommand = null
      if (error) reject(error)
      else
        resolve({
          stdout: output.stdout,
          stderr: output.stderr,
          code: code ?? -1,
        })
    }
    const beginTermination = (error: Error) => {
      if (settled || terminating) return
      terminating = true
      clearTimeout(timer)
      void terminateProviderChildProcessTree(child).then(
        () => finish(error),
        (cleanupError) => {
          failedStatusCommand = child
          finish(
            new AggregateError(
              [error, cleanupError],
              `${error.message} Process-tree cleanup also failed.`
            )
          )
        }
      )
    }
    const timer = setTimeout(() => {
      beginTermination(
        new Error(`Command timed out after ${options.timeoutMs}ms.`)
      )
    }, options.timeoutMs)

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      if (
        !settled &&
        !terminating &&
        !appendBoundedProcessOutput(output, "stdout", chunk)
      ) {
        beginTermination(
          processOutputLimitError("Cursor status probe", output.byteCap)
        )
      }
    })
    child.stderr?.on("data", (chunk) => {
      if (
        !settled &&
        !terminating &&
        !appendBoundedProcessOutput(output, "stderr", chunk)
      ) {
        beginTermination(
          processOutputLimitError("Cursor status probe", output.byteCap)
        )
      }
    })
    child.on("error", (error) => {
      if (!terminating) finish(error)
    })
    child.on("close", (code) => {
      if (!terminating) finish(undefined, code)
    })
  })
}

function parseCursorAboutJsonPayload(
  raw: string
): CursorAboutJsonPayload | undefined {
  try {
    const value: unknown = JSON.parse(raw.trim())
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as CursorAboutJsonPayload)
      : undefined
  } catch {
    return undefined
  }
}

function isCursorAboutJsonFormatUnsupported(
  result: CursorCommandResult
): boolean {
  return /(?:unknown option|unexpected argument|unrecognized option|unknown argument) '--format'/i.test(
    [result.stdout, result.stderr].join("\n")
  )
}

const ANSI_SEQUENCE_RE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]|${String.fromCharCode(27)}\\].*?${String.fromCharCode(7)}`,
  "g"
)

function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE_RE, "")
}

function extractAboutField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}\\s{2,}(.+)$`, "mi")
  return regex.exec(plain)?.[1]?.trim()
}

function unauthenticatedCursorAbout(version: string | null): CursorAboutResult {
  return {
    version,
    status: "error",
    auth: { status: "unauthenticated" },
    message:
      "Cursor Agent is not authenticated. Run `agent login` and try again.",
  }
}

function isUnauthenticatedCursorEmail(value: string): boolean {
  const lower = value.toLowerCase()
  return (
    lower === "not logged in" ||
    lower.includes("login required") ||
    lower.includes("authentication required")
  )
}

function cursorAuthMetadata(
  subscriptionType: string | undefined
): Pick<CursorProviderAuth, "label" | "type"> | undefined {
  if (!subscriptionType) return undefined
  const label = cursorSubscriptionLabel(subscriptionType)
  return {
    type: subscriptionType,
    label: `Cursor ${label ?? toTitleCaseWords(subscriptionType)} Subscription`,
  }
}

function cursorSubscriptionLabel(
  subscriptionType: string | undefined
): string | undefined {
  if (!subscriptionType) return
  const key = subscriptionType.replace(/[\s_-]/g, "").toLowerCase()
  if (!key) return
  const standard = ["Team", "Pro", "Free", "Business", "Enterprise"]
  return (
    standard.find((label) => label.toLowerCase() === key) ??
    toTitleCaseWords(subscriptionType)
  )
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function isCommandMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = (error as { code?: unknown }).code
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase()
  return code === "ENOENT" || message.includes("enoent")
}
