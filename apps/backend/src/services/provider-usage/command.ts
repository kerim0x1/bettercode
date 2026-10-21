import { spawn, type ChildProcess } from "node:child_process"
import { logger } from "../../observability/logger"
import { terminateProviderChildProcessTree } from "../../provider/runtime/ChildProcessTermination"
import { sanitizedChildEnvironment } from "../../security/childEnvironment"
import {
  buildWindowsCmdArgs,
  requiresWindowsCmdWrapper,
  resolveComSpec,
} from "../../security/windowsCommandLine"

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
  /** Set when stdout went past its byte limit and was cut. */
  stdoutTruncated?: boolean
}

export interface RunCommandOptions {
  /** Byte limit for stdout; 256 KiB unless set. */
  readonly maxOutputBytes?: number
  /** Working directory; the backend's own unless set. */
  readonly cwd?: string
}

/**
 * Run a provider CLI without a shell and with a bounded output buffer.
 *
 * On timeout the whole process tree is terminated before the result is
 * returned: on Windows the CLI usually runs under a `cmd.exe /c` wrapper, so
 * killing only the direct child left the node-based CLI running (blocked on
 * an auth or Keychain prompt, say) after every timeout. POSIX children run
 * in their own process group for the same reason.
 */
export function runCommand(
  binaryPath: string,
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const viaCmd = requiresWindowsCmdWrapper(binaryPath)
    let command: string
    let commandArgs: string[]
    let child: ChildProcess
    try {
      command = viaCmd ? resolveComSpec() : binaryPath
      commandArgs = viaCmd ? buildWindowsCmdArgs(binaryPath, args) : [...args]
      child = spawn(command, commandArgs, {
        cwd: options.cwd ?? process.cwd(),
        env: sanitizedChildEnvironment(),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: viaCmd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({
        status: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      })
      return
    }

    // Raw bytes, decoded once at the end: decoding chunk by chunk turned a
    // multi-byte character split across two reads into U+FFFD.
    const stdout = new BoundedOutput(options.maxOutputBytes ?? MAX_OUTPUT_BYTES)
    const stderr = new BoundedOutput(MAX_OUTPUT_BYTES)
    let settled = false
    const finish = (status: number | null, extraStderr?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (extraStderr) stderr.append(Buffer.from(extraStderr, "utf8"))
      resolve({
        status,
        stdout: stdout.text(),
        stderr: stderr.text(),
        ...(stdout.truncated ? { stdoutTruncated: true } : {}),
      })
    }
    const timer = setTimeout(() => {
      if (settled) return
      void terminateProviderChildProcessTree(child)
        .catch((error) => {
          logger.warn(
            { err: error, pid: child.pid ?? null },
            "provider usage command could not be fully terminated after its timeout"
          )
        })
        .finally(() => finish(null))
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk))
    child.on("error", (error) => {
      finish(null, error.message)
    })
    child.on("close", (status) => finish(status))
  })
}

class BoundedOutput {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  /** Output arrived past the limit and was dropped. */
  truncated = false

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    const remaining = this.maxBytes - this.bytes
    if (remaining <= 0) {
      if (chunk.byteLength > 0) this.truncated = true
      return
    }
    if (chunk.byteLength > remaining) this.truncated = true
    const kept =
      chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
    this.chunks.push(kept)
    this.bytes += kept.byteLength
  }

  /** UTF-8 text; a character cut by the byte limit is dropped, not mangled. */
  text(): string {
    const decoded = Buffer.concat(this.chunks, this.bytes).toString("utf8")
    return this.bytes >= this.maxBytes
      ? decoded.replace(/\uFFFD$/, "")
      : decoded
  }
}

export function commandOutput(result: CommandResult): string {
  const stdout = result.stdout.trimEnd()
  const stderr = result.stderr.trimEnd()
  if (stdout && stderr) return `${stdout}\n\n${stderr}`
  return stdout || stderr
}
