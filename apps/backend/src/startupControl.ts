/**
 * Startup control frames from the standalone backend to whatever started it.
 *
 * Forked by the Electron shell, the backend has a private IPC channel. The
 * shell asks for the frames there (`BETTERC0DE_STARTUP_CONTROL=ipc`) and
 * accepts readiness only from that channel, so no log line can pose as it,
 * and the bearer token never passes through stderr, which the shell writes to
 * its log. Without that request (`node dist/index.js`, the backend startup
 * smoke test, an older shell) the same frames are JSON lines on stderr, in
 * their established shapes.
 */

/** Set by the shell in the backend's environment to ask for IPC frames. */
export const STARTUP_CONTROL_ENV = "BETTERC0DE_STARTUP_CONTROL"

/**
 * The channel the host asked for: this process's IPC channel when the host
 * set `BETTERC0DE_STARTUP_CONTROL=ipc` and forked it with one, otherwise none
 * (stderr). The variable is removed so the backend's own children never see
 * it.
 */
export function startupControlChannelFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  host: StartupControlChannel = process
): StartupControlChannel {
  const requested = env[STARTUP_CONTROL_ENV]
  delete env[STARTUP_CONTROL_ENV]
  return requested === "ipc" && typeof host.send === "function" ? host : {}
}

/** `type` of every startup frame sent over the IPC channel. */
export const BACKEND_STARTUP_MESSAGE_TYPE = "betterc0de/backend-startup"
/** Version of the frame format; the shell ignores frames it does not know. */
export const BACKEND_STARTUP_PROTOCOL = 1

export type BackendStartupFrame =
  | { readonly status: "starting" }
  | { readonly status: "ready"; readonly port: number; readonly token: string }
  | { readonly status: "error"; readonly message: string }

/** The parts of `process` the frames are sent through. */
export interface StartupControlChannel {
  readonly connected?: boolean
  send?(message: unknown, callback?: (error: Error | null) => void): boolean
}

export interface StartupControlOptions {
  /** Where frames go; none (the default) means stderr. */
  readonly channel?: StartupControlChannel
  readonly stderr?: { write(chunk: string): unknown }
  /** Upper bound for the IPC delivery callback (the process may exit next). */
  readonly timeoutMs?: number
}

/** The frame as an IPC message. */
export function startupControlMessage(
  frame: BackendStartupFrame
): Record<string, unknown> {
  return {
    type: BACKEND_STARTUP_MESSAGE_TYPE,
    protocol: BACKEND_STARTUP_PROTOCOL,
    ...frame,
  }
}

/** The frame as the stderr line a channel-less run has always written. */
export function startupControlLine(frame: BackendStartupFrame): string {
  switch (frame.status) {
    case "starting":
      return JSON.stringify({
        control: BACKEND_STARTUP_MESSAGE_TYPE,
        status: "starting",
        protocol: BACKEND_STARTUP_PROTOCOL,
      })
    case "ready":
      return JSON.stringify({
        port: frame.port,
        token: frame.token,
        status: "ready",
      })
    case "error":
      return JSON.stringify({ status: "error", message: frame.message })
  }
}

/**
 * Send one startup frame. Resolves `"ipc"` once the channel accepted it (or
 * after `timeoutMs`, so a caller about to exit is never held up), or
 * `"stderr"` when there is no channel.
 */
export function sendStartupControl(
  frame: BackendStartupFrame,
  options: StartupControlOptions = {}
): Promise<"ipc" | "stderr"> {
  const channel: StartupControlChannel = options.channel ?? {}
  const stderr = options.stderr ?? process.stderr
  if (typeof channel.send === "function" && channel.connected !== false) {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve("ipc")
      }
      const timer = setTimeout(finish, options.timeoutMs ?? 2_000)
      timer.unref?.()
      try {
        channel.send?.(startupControlMessage(frame), () => finish())
      } catch {
        // The host is gone; its own exit handling reports the failure.
        finish()
      }
    })
  }
  stderr.write(`${startupControlLine(frame)}\n`)
  return Promise.resolve("stderr")
}
