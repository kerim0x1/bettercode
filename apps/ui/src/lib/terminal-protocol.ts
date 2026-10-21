import type { TerminalPtySnapshot } from "@betterc0de/schema/http-contracts"
import { HttpError, TimeoutError } from "@/lib/errors/types"

/**
 * How the desktop terminal reads the backend's PTY routes
 * (`/shell/pty/*`): what one read adds to the screen, how soon to read
 * again, which failures to retry, and what to call a terminal.
 */

export interface TerminalSnapshotUpdate {
  /** Output to write, in order. */
  readonly output: string
  /** Where the next read starts. */
  readonly nextCursor: number
  /** Output between the cursor and the first event kept was dropped. */
  readonly skipped: boolean
  /** Set once the process has ended. */
  readonly exit: { readonly exitCode: number | null } | null
}

/**
 * What one read of `/shell/pty/read` (or the open's own snapshot) means for
 * a terminal that has shown everything up to `cursor`. The service's own
 * notes (the command line it started) are not output.
 */
export function readTerminalSnapshot(
  cursor: number,
  snapshot: Pick<TerminalPtySnapshot, "events" | "nextCursor" | "status">
): TerminalSnapshotUpdate {
  const events = snapshot.events.filter((event) => event.seq > cursor)
  const first = events[0]
  let output = ""
  let exit: TerminalSnapshotUpdate["exit"] = null
  for (const event of events) {
    if (event.type === "data" && event.data) output += event.data
    else if (event.type === "exit") exit = { exitCode: event.exitCode ?? null }
  }
  // An ended process whose exit event was dropped, or whose process tree
  // could not be cleaned up, has ended all the same.
  if (!exit && snapshot.status !== "running") exit = { exitCode: null }
  return {
    output,
    nextCursor: Math.max(cursor, snapshot.nextCursor, events.at(-1)?.seq ?? 0),
    skipped: first !== undefined && first.seq > cursor + 1,
    exit,
  }
}

/** Reading again right after output, then less often while it stays quiet. */
const POLL_ACTIVE_MS = 25
const POLL_IDLE_MS = [50, 100, 200, 350, 500] as const
/** A terminal nobody looks at only needs its output and its exit noticed. */
const POLL_HIDDEN_MS = 1_500
const POLL_FAILURE_MAX_MS = 5_000

export function terminalPollDelay(state: {
  /** Reads in a row that brought nothing new. */
  readonly idleReads: number
  /** Failed reads in a row. */
  readonly failures: number
  readonly visible: boolean
}): number {
  if (state.failures > 0) {
    return Math.min(
      POLL_FAILURE_MAX_MS,
      250 * 2 ** Math.min(state.failures - 1, 5)
    )
  }
  if (state.idleReads === 0) return POLL_ACTIVE_MS
  if (!state.visible) return POLL_HIDDEN_MS
  return POLL_IDLE_MS[Math.min(state.idleReads, POLL_IDLE_MS.length) - 1]!
}

/** The text of an error without Electron's "Error invoking remote method" wrapper. */
export function terminalErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "")
  const message = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, "")
    .replace(/^(?:Error|TypeError):\s*/, "")
    .trim()
  return message || "The terminal could not be started."
}

/**
 * The desktop's main process mints a terminal capability only right after a
 * click or key press in the window (`apps/shell/shared/app-ipc.cjs`): a
 * terminal opened without one waits for the user to start it.
 */
export function isGestureRequiredError(error: unknown): boolean {
  return /recent click or key press/i.test(terminalErrorMessage(error))
}

/** The PTY is gone: closed, ended, or the backend restarted. */
export function isTerminalGoneError(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404
}

/**
 * A read that will not work again: the PTY is gone, or no longer this
 * caller's to read (a paired browser whose terminal grant was withdrawn).
 */
export function isTerminalUnreadableError(error: unknown): boolean {
  return (
    error instanceof HttpError && (error.status === 404 || error.status === 403)
  )
}

/** Worth sending again: rate limited, timed out or briefly unreachable. */
export function isRetryableTerminalError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 429 || error.status === 502 || error.status === 503
  }
  if (error instanceof TimeoutError) return true
  if (error instanceof TypeError) return true
  // The main process words the backend's refusal of a capability itself.
  return /\(429\)|rate limit|backend is not ready/i.test(
    terminalErrorMessage(error)
  )
}

/**
 * Up to `maxChars` of `input` for one write, never ending on the first half
 * of a surrogate pair.
 */
export function takeTerminalInputChunk(
  input: string,
  maxChars: number
): string {
  if (input.length <= maxChars) return input
  const end = maxChars
  const code = input.charCodeAt(end - 1)
  const cut = code >= 0xd800 && code <= 0xdbff ? end - 1 : end
  return input.slice(0, Math.max(1, cut))
}

/**
 * Whether the text before the cursor ends like a shell waiting for a
 * command (`PS C:\repo>`, `user@host:~$`, `%`, `❯`, a REPL's `>>>`). Used to
 * ask before closing a terminal that is still running something; a prompt
 * this misses only adds a question.
 */
export function looksLikeShellPrompt(textBeforeCursor: string): boolean {
  const trimmed = textBeforeCursor.replace(/\s+$/, "")
  return /[$#%>❯➜»λ]$/u.test(trimmed)
}

const SHELL_NAMES: Readonly<Record<string, string>> = {
  cmd: "cmd",
  powershell: "PowerShell",
  pwsh: "PowerShell 7",
  gitbash: "Git Bash",
  wsl: "WSL",
  bash: "bash",
  zsh: "zsh",
  sh: "sh",
  fish: "fish",
}

const WINDOWS_SHELLS = new Set(["cmd", "powershell", "pwsh", "gitbash", "wsl"])

/** A shell id from `/shell/detect` or a PTY snapshot, as a tab names it. */
export function shellDisplayName(shell: string | undefined): string {
  if (!shell || shell === "custom") return "Terminal"
  return SHELL_NAMES[shell] ?? shell
}

/** Shells the backend starts through Windows' ConPTY. */
export function isWindowsShell(shell: string | undefined): boolean {
  return Boolean(shell && WINDOWS_SHELLS.has(shell))
}

const MAX_TITLE_CHARS = 80

/**
 * A title a program set (OSC 0/2), fit for a tab: control characters out,
 * and an executable's path shortened to its name (`cmd.exe` sets
 * `C:\WINDOWS\system32\cmd.exe`).
 */
export function cleanTerminalTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  const text = title.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  const executable = /^(?:[A-Za-z]:)?[\\/].*[\\/]([^\\/]+?)(?:\.exe)?$/i.exec(
    text
  )
  const name = executable ? executable[1]! : text
  return name.slice(0, MAX_TITLE_CHARS)
}

/** A terminal's own name: what its program reports, or its shell's. */
export function terminalDisplayName(
  terminal: {
    readonly processTitle?: string
    readonly shellKind?: string
    readonly shell?: string
  },
  titlesEnabled: boolean
): string {
  if (!titlesEnabled) return "Terminal"
  return (
    terminal.processTitle ||
    shellDisplayName(terminal.shellKind ?? terminal.shell)
  )
}
