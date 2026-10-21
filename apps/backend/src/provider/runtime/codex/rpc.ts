import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import { EventEmitter } from "node:events"
import { sanitizedChildEnvironment } from "../../../security/childEnvironment"
import { terminateProviderChildProcessTree } from "../ChildProcessTermination"
import { ChildStdinWriter } from "../ChildStdinWriter"
import {
  buildWindowsCmdArgs,
  resolveComSpec,
} from "../../../security/windowsCommandLine"
import { trackChildProcessTree } from "../../../services/child-process-registry"
import { logger } from "../../../observability/logger"
import {
  DEFAULT_NDJSON_LINE_BYTE_CAP,
  NdjsonLineReader,
  dispatchNdjsonNotification,
  identifyOversizedLine,
  type OversizedNdjsonLine,
} from "../NdjsonLineReader"
import { ProcessStderrTail } from "../ProcessStderrTail"

export interface JsonRpcRequest {
  version: 2
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  version: 2
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  version: 2
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface ServerRequestHandler {
  (
    method: string,
    params: unknown,
    respond: (result: unknown) => void,
    respondError: (code: number, message: string) => void
  ): void
}

export interface NotificationHandler {
  (method: string, params: unknown): void
}

export interface StderrHandler {
  (line: string): void
}

export interface SpawnOptions {
  readonly binaryPath: string
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly callTimeoutMs?: number
  readonly stdoutLineByteCap?: number
  readonly args?: ReadonlyArray<string>
}

const DEFAULT_CALL_TIMEOUT_MS = 60_000
const DEFAULT_STDOUT_LINE_CAP = DEFAULT_NDJSON_LINE_BYTE_CAP
const CODEX_APP_SERVER_PROTOCOL_VERSION = 2

interface PendingRequest {
  readonly method: string
  readonly startedAt: number
  readonly timer: NodeJS.Timeout
  readonly resolve: (v: unknown) => void
  readonly reject: (e: Error) => void
}

/**
 * The reply to a server-initiated request (an approval or a question) could
 * not be handed to the app-server: the stdin writer refused it because its
 * backlog bound was exceeded or the pipe is dead. The agent would wait for
 * that reply forever, so the client fails the turn with this instead of
 * dropping it silently.
 */
export class CodexServerResponseRefusedError extends Error {
  readonly method: string
  readonly requestId: number | string

  constructor(method: string, requestId: number | string) {
    super(
      `codex rpc response to server request ${method} (id ${String(requestId)}) was refused by the stdin writer`
    )
    this.name = "CodexServerResponseRefusedError"
    this.method = method
    this.requestId = requestId
  }
}

export class CodexRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdin: ChildStdinWriter | null = null
  /** The child `stdin` was built for; guards against a second writer per pipe. */
  private stdinChild: ChildProcessWithoutNullStreams | null = null
  private closePromise: Promise<void> | null = null
  private cleanupRequiredChild: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private closed = false
  private readonly notificationHandlers = new Map<
    string,
    Set<NotificationHandler>
  >()
  private serverRequestHandler: ServerRequestHandler | null = null
  private stderrHandler: StderrHandler | null = null
  private readonly callTimeoutMs: number
  private readonly stdoutLineCap: number
  private readonly stderrTail = new ProcessStderrTail()
  private untrackChild: (() => void) | null = null

  constructor(private readonly options: SpawnOptions) {
    super()
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    this.stdoutLineCap = options.stdoutLineByteCap ?? DEFAULT_STDOUT_LINE_CAP
  }

  isAlive(): boolean {
    return !this.closed && this.child !== null && this.child.exitCode === null
  }

  /** Redacted tail of the app-server's stderr; empty when it printed nothing. */
  stderrText(maxChars = 2_000): string {
    return this.stderrTail.isEmpty ? "" : this.stderrTail.tail(maxChars)
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method)
    if (!set) {
      set = new Set()
      this.notificationHandlers.set(method, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  setServerRequestHandler(handler: ServerRequestHandler | null): void {
    this.serverRequestHandler = handler
  }

  onStderr(handler: StderrHandler | null): void {
    this.stderrHandler = handler
  }

  async spawnChild(): Promise<void> {
    if (this.child) return
    const { binaryPath, cwd, env, args } = this.options
    const isWindows = process.platform === "win32"
    const directExe =
      isWindows && path.isAbsolute(binaryPath) && /\.exe$/i.test(binaryPath)
    const viaCmd = isWindows && !directExe
    const allArgs = ["app-server", ...(args ?? [])]
    const spawnCommand = viaCmd ? resolveComSpec() : binaryPath
    const spawnArgs = viaCmd
      ? buildWindowsCmdArgs(binaryPath, allArgs)
      : allArgs
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env: sanitizedChildEnvironment(env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: viaCmd,
      detached: !isWindows,
    }) as ChildProcessWithoutNullStreams
    // Child and writer are set together, before the first await: `call()`
    // only checks `this.child`, so a caller racing the spawn event used to
    // build a writer of its own and `attachChild` then built a second one
    // over the same pipe (two drain listeners, two queues).
    this.child = child
    this.stdin = this.createStdinWriter(child)

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (e: Error) => {
          cleanup()
          reject(e)
        }
        const cleanup = () => {
          child.off("spawn", onSpawn)
          child.off("error", onError)
        }
        child.once("spawn", onSpawn)
        child.once("error", onError)
      })
    } catch (error) {
      // Nothing was started: a later close() must not try to terminate a
      // process that never existed, and isAlive() must not report one.
      if (this.child === child) this.child = null
      this.stdin?.markDead("codex child failed to spawn", { silent: true })
      throw error
    }

    // Registered so a backend that dies does not leave the app-server
    // running; released once the tree is confirmed gone in close().
    this.untrackChild?.()
    this.untrackChild = trackChildProcessTree(child, "codex app-server")
    this.attachChild(child)
  }

  /**
   * Wires stream and lifecycle listeners for a spawned child. Split from
   * `spawnChild` so the listener behaviour can be exercised against a fake
   * child in tests without spawning a process.
   */
  private attachChild(child: ChildProcessWithoutNullStreams): void {
    this.child = child
    // Exactly one writer per child. spawnChild built it already; a directly
    // injected child (tests) gets it here, before any write, so an EPIPE from
    // a child that died mid-request never surfaces as an unhandled `error`.
    if (this.stdinChild !== child) this.stdin = this.createStdinWriter(child)

    // One oversized line (the cumulative turn diff of a lockfile change, say)
    // is skipped and fails only the request it belongs to; it no longer
    // tears the app-server down mid-turn.
    const stdout = new NdjsonLineReader(
      this.stdoutLineCap,
      (line) => this.handleLine(line),
      (line) => this.handleOversizedLine(line)
    )
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(chunk))
    child.stdout.on("end", () => stdout.end())

    // Lines are assembled across chunks so a line split between two reads is
    // classified once and whole.
    const emitStderr = (lines: string[]) => {
      for (const line of lines) this.stderrHandler?.(line)
    }
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: Buffer | string) =>
      emitStderr(this.stderrTail.push(chunk))
    )
    child.stderr.on("end", () => emitStderr(this.stderrTail.flush()))

    child.on("exit", (code, signal) => {
      this.closed = true
      this.stdin?.markDead(`codex child exited (code=${code} signal=${signal})`)
      // A root exit during or after tree cleanup does not prove its descendants
      // are gone. Only successful termination may release that retained child.
      if (this.child === child && this.cleanupRequiredChild !== child)
        this.child = null
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(
          new Error(this.formatExitError(entry.method, code, signal))
        )
        this.pending.delete(id)
      }
      this.emit("exit", { code, signal })
    })

    child.on("error", (err) => {
      this.emit("child-error", err)
    })
  }

  async call<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs?: number
  ): Promise<T> {
    if (!this.child || this.closed)
      throw new Error(`codex rpc not alive for call ${method}`)
    const id = this.nextRequestId++
    const req: JsonRpcRequest = {
      version: CODEX_APP_SERVER_PROTOCOL_VERSION,
      jsonrpc: "2.0",
      id,
      method,
      params,
    }
    const payload = JSON.stringify(req) + "\n"
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `codex rpc timeout after ${timeoutMs ?? this.callTimeoutMs} ms: ${method}`
          )
        )
      }, timeoutMs ?? this.callTimeoutMs)
      this.pending.set(id, {
        method,
        startedAt: Date.now(),
        timer,
        resolve: (v) => resolve(v as T),
        reject,
      })
      if (!this.stdinWriter()?.write(payload)) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`codex rpc stdin is closed; cannot send ${method}`))
      }
    })
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.child || this.closed) return
    const msg: JsonRpcNotification = {
      version: CODEX_APP_SERVER_PROTOCOL_VERSION,
      jsonrpc: "2.0",
      method,
      params,
    }
    this.stdinWriter()?.write(JSON.stringify(msg) + "\n")
  }

  /** Writes a response to a server-initiated request, or logs why it can't. */
  private writeServerResponse(resp: JsonRpcResponse, method: string): void {
    const stdin = this.stdinWriter()
    if (!stdin) {
      logger.warn(
        { method, id: resp.id },
        "codex rpc server-request response dropped; child already exited"
      )
      return
    }
    if (stdin.write(JSON.stringify(resp) + "\n")) return
    // The writer refused the reply (backlog bound exceeded, or the pipe died
    // between the check above and the write). The app-server is now waiting
    // on an answer that will never arrive; fail the turn with a message that
    // says so instead of letting it hang.
    const refused = new CodexServerResponseRefusedError(method, resp.id)
    logger.error(
      { method, id: resp.id, pendingBytes: stdin.pendingBytes },
      "codex rpc server-request response refused by the stdin writer; failing the turn"
    )
    this.rejectAllPending(() => refused)
    this.emit("child-error", refused)
  }

  private createStdinWriter(
    child: ChildProcessWithoutNullStreams
  ): ChildStdinWriter {
    this.stdinChild = child
    return new ChildStdinWriter(child.stdin, {
      label: "codex rpc",
      logger,
      onError: (err) => {
        // The pipe is gone but the process may linger without ever exiting:
        // a call waiting on it would otherwise sit out the full 60 s timeout.
        this.rejectAllPending(
          (method) =>
            `codex rpc stdin errored while waiting on ${method}: ${err.message}`
        )
        this.emit("child-error", err)
      },
    })
  }

  private rejectAllPending(failure: (method: string) => string | Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      const reason = failure(entry.method)
      entry.reject(reason instanceof Error ? reason : new Error(reason))
    }
  }

  /**
   * The writer for the live child. Never built lazily for a spawned child —
   * that is done in spawnChild/attachChild — only for a child injected
   * straight into `this.child` by a test, and then once per child.
   */
  private stdinWriter(): ChildStdinWriter | null {
    if (!this.child) return null
    if (this.stdinChild !== this.child) {
      this.stdin = this.createStdinWriter(this.child)
    }
    return this.stdin
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (this.closed && !this.child) return
    this.closed = true
    const child = this.child
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(
        new Error(`codex rpc closed while waiting on ${entry.method}`)
      )
      this.pending.delete(id)
    }
    if (!child) return
    if (
      this.cleanupRequiredChild === child &&
      process.platform === "win32" &&
      (child.exitCode != null || child.signalCode != null)
    ) {
      throw new Error(
        "Codex descendant cleanup remains unconfirmed after the Windows root exited"
      )
    }
    this.cleanupRequiredChild = child
    const operation = (async () => {
      await terminateProviderChildProcessTree(child)
      this.untrackChild?.()
      this.untrackChild = null
      if (this.cleanupRequiredChild === child) this.cleanupRequiredChild = null
      if (this.child === child) this.child = null
    })()
    this.closePromise = operation
    try {
      await operation
    } finally {
      if (this.closePromise === operation) this.closePromise = null
    }
  }

  /**
   * A line over the cap was skipped. Do not drop it silently: a RESPONSE
   * would leave its call waiting for the 60 s timeout ("codex rpc timeout" is
   * misleading for "the payload was too big"), and a server REQUEST would
   * leave the app-server waiting for an answer forever. The envelope is
   * recovered from the head of the line so only that exchange fails.
   */
  private handleOversizedLine(line: OversizedNdjsonLine): void {
    const identity = identifyOversizedLine(line.head)
    const entry =
      typeof identity.id === "number" && !identity.method
        ? this.pending.get(identity.id)
        : undefined
    logger.warn(
      {
        bytes: line.bytes,
        cap: this.stdoutLineCap,
        method: identity.method ?? entry?.method ?? null,
        correlated: Boolean(entry),
      },
      "codex rpc line exceeded the stdout cap and was dropped"
    )
    if (entry && typeof identity.id === "number") {
      this.pending.delete(identity.id)
      clearTimeout(entry.timer)
      entry.reject(
        new Error(
          `codex rpc response for ${entry.method} exceeded the ${this.stdoutLineCap}-byte line cap and was discarded`
        )
      )
      return
    }
    if (identity.id !== null && identity.method) {
      const resp: JsonRpcResponse = {
        version: CODEX_APP_SERVER_PROTOCOL_VERSION,
        jsonrpc: "2.0",
        id: identity.id,
        error: {
          code: -32600,
          message: `Request exceeded the client's ${this.stdoutLineCap}-byte line limit.`,
        },
      }
      this.writeServerResponse(resp, identity.method)
    }
  }

  private handleLine(line: string): void {
    if (!line) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Malformed JSON on a well-formed line is a protocol violation, not
      // routine noise — the stream is newline-delimited JSON by contract.
      logger.warn(
        { bytes: line.length, preview: line.slice(0, 200) },
        "codex rpc line was not valid JSON"
      )
      return
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return
    const hasId = msg.id !== undefined && msg.id !== null
    if (
      hasId &&
      typeof msg.id !== "string" &&
      !(typeof msg.id === "number" && Number.isFinite(msg.id))
    )
      return
    const method = typeof msg.method === "string" ? msg.method : null

    if (hasId && method) {
      const id = msg.id as number | string
      if (this.serverRequestHandler) {
        const respond = (result: unknown) => {
          const resp: JsonRpcResponse = {
            version: CODEX_APP_SERVER_PROTOCOL_VERSION,
            jsonrpc: "2.0",
            id,
            result,
          }
          this.writeServerResponse(resp, method)
        }
        const respondError = (code: number, message: string) => {
          const resp: JsonRpcResponse = {
            version: CODEX_APP_SERVER_PROTOCOL_VERSION,
            jsonrpc: "2.0",
            id,
            error: { code, message },
          }
          this.writeServerResponse(resp, method)
        }
        this.serverRequestHandler(
          method,
          msg.params ?? {},
          respond,
          respondError
        )
      } else {
        // Answer instead of leaving the app-server waiting forever (the ACP
        // client already does this).
        this.writeServerResponse(
          {
            version: CODEX_APP_SERVER_PROTOCOL_VERSION,
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `No handler registered for ${method}`,
            },
          },
          method
        )
      }
      return
    }

    if (hasId && typeof msg.id === "number") {
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string }
        entry.reject(
          new Error(
            `codex rpc error ${err.code ?? ""}: ${err.message ?? "unknown"}`
          )
        )
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    if (method) {
      dispatchNdjsonNotification(
        this.notificationHandlers,
        method,
        msg.params ?? {},
        "codex rpc"
      )
    }
  }

  private formatExitError(
    method: string,
    code: number | null,
    signal: NodeJS.Signals | null
  ): string {
    const stderr = this.stderrTail.tail(1_200).trim()
    const stderrSuffix = stderr
      ? ` stderr=${truncateForMessage(stderr, 1_200)}`
      : ""
    return `codex child exited before responding to ${method} (code=${code} signal=${signal}). command=${this.options.binaryPath} app-server${stderrSuffix}`
  }
}

function truncateForMessage(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3)}...`
}
