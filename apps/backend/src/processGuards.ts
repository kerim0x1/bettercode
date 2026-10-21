import { getMasterKey } from "./settings/crypto"

/**
 * Process-level guards for the standalone backend entry (`index.ts`): the
 * settings-key handshake with the Electron host and the policy for
 * unhandled promise rejections.
 */

export interface SettingsKeyMessage {
  readonly type: "settings-key"
  readonly key: string
}

export function isSettingsKeyMessage(
  message: unknown
): message is SettingsKeyMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "settings-key" &&
    typeof (message as { key?: unknown }).key === "string"
  )
}

export interface SettingsKeyIntake {
  /** Feed every IPC message; returns true when it was the key message. */
  accept(message: unknown): boolean
  /** Resolves with the key (may be empty: no OS credential storage). */
  wait(options: { timeoutMs: number; signal?: AbortSignal }): Promise<string>
}

/**
 * The Electron host sends the settings master key as the first message on
 * the fork IPC channel instead of the environment, where it would stay
 * readable for the process lifetime (`/proc/<pid>/environ`, `ps eww`). The
 * listener is installed at module load, so a message that arrives before
 * startup asks for it is kept.
 */
export function createSettingsKeyIntake(): SettingsKeyIntake {
  let received: string | null = null
  const waiters = new Set<(key: string) => void>()
  return {
    accept(message) {
      if (!isSettingsKeyMessage(message)) return false
      if (received === null) {
        received = message.key
        for (const waiter of waiters) waiter(message.key)
        waiters.clear()
      }
      return true
    },
    wait({ timeoutMs, signal }) {
      if (received !== null) return Promise.resolve(received)
      return new Promise<string>((resolve, reject) => {
        const cancelled = () =>
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Settings key intake was cancelled")
        if (signal?.aborted) {
          reject(cancelled())
          return
        }
        // Every caller of cleanup runs after the timer below is set.
        const cleanup = () => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", onAbort)
          waiters.delete(onKey)
        }
        const onKey = (key: string) => {
          cleanup()
          resolve(key)
        }
        const onAbort = () => {
          cleanup()
          reject(cancelled())
        }
        waiters.add(onKey)
        signal?.addEventListener("abort", onAbort, { once: true })
        const timer = setTimeout(() => {
          cleanup()
          reject(
            new Error(
              `The desktop app did not hand over the settings key within ${Math.round(timeoutMs / 1000)}s`
            )
          )
        }, timeoutMs)
      })
    },
  }
}

/**
 * Load the master key into `settings/crypto`, which reads it once from
 * `BETTERC0DE_SETTINGS_KEY` and caches it. The variable exists only for the
 * duration of this synchronous call, so no child process can inherit it.
 */
export function installSettingsMasterKey(base64Key: string): boolean {
  if (base64Key) process.env.BETTERC0DE_SETTINGS_KEY = base64Key
  else delete process.env.BETTERC0DE_SETTINGS_KEY
  try {
    return getMasterKey() !== null
  } finally {
    delete process.env.BETTERC0DE_SETTINGS_KEY
  }
}

const FATAL_REJECTION_CODES = new Set([
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_FULL",
  "SQLITE_IOERR",
  "ERR_WORKER_OUT_OF_MEMORY",
])

/**
 * Rejections that mean shared state can no longer be trusted: database
 * corruption or I/O failure, and memory exhaustion. Everything else is a
 * bug in one code path and does not justify ending every session.
 */
export function isFatalRejection(reason: unknown): boolean {
  const code =
    typeof reason === "object" && reason !== null
      ? (reason as { code?: unknown }).code
      : undefined
  if (typeof code === "string") {
    // Extended SQLite codes refine a base code: SQLITE_IOERR_WRITE, …
    for (const fatal of FATAL_REJECTION_CODES) {
      if (code === fatal || code.startsWith(`${fatal}_`)) return true
    }
  }
  return (
    reason instanceof RangeError &&
    /Maximum call stack size exceeded|Array buffer allocation failed|Invalid string length/.test(
      reason.message
    )
  )
}

export interface RejectionVerdict {
  readonly fatal: boolean
  readonly recentCount: number
  readonly why?: string
}

/**
 * Decide per unhandled rejection whether the backend keeps running. A
 * single stray rejection is logged and survived; a known fatal cause or a
 * storm of rejections (`maxRejections` within `windowMs`, a sign of a broken
 * loop) still ends the process, and the Electron supervisor restarts it.
 */
export function createUnhandledRejectionPolicy({
  windowMs = 60_000,
  maxRejections = 20,
  now = Date.now,
}: {
  windowMs?: number
  maxRejections?: number
  now?: () => number
} = {}): { classify(reason: unknown): RejectionVerdict } {
  let recent: number[] = []
  return {
    classify(reason) {
      const time = now()
      recent = recent.filter((at) => time - at < windowMs)
      recent.push(time)
      if (isFatalRejection(reason)) {
        return {
          fatal: true,
          recentCount: recent.length,
          why: "storage or memory failure",
        }
      }
      if (recent.length >= maxRejections) {
        return {
          fatal: true,
          recentCount: recent.length,
          why: `${recent.length} unhandled rejections within ${Math.round(windowMs / 1000)}s`,
        }
      }
      return { fatal: false, recentCount: recent.length }
    },
  }
}
