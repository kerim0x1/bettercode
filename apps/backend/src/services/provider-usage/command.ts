import { spawn, type ChildProcess } from "node:child_process"
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
}

/** Run a provider CLI without a shell and with a bounded output buffer. */
export function runCommand(
  binaryPath: string,
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const viaCmd = requiresWindowsCmdWrapper(binaryPath)
    const command = viaCmd ? resolveComSpec() : binaryPath
    const commandArgs = viaCmd
      ? buildWindowsCmdArgs(binaryPath, args)
      : [...args]
    let child: ChildProcess
    try {
      child = spawn(command, commandArgs, {
        cwd: process.cwd(),
        env: sanitizedChildEnvironment(),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: viaCmd,
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

    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (status: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    }
    const timer = setTimeout(() => {
      if (settled) return
      child.kill()
      finish(null)
    }, timeoutMs)
    const append = (value: string, chunk: unknown) =>
      (value + String(chunk)).slice(0, MAX_OUTPUT_BYTES)
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk)
    })
    child.on("error", (error) => {
      stderr = append(stderr, error.message)
      finish(null)
    })
    child.on("close", (status) => finish(status))
  })
}

export function commandOutput(result: CommandResult): string {
  const stdout = result.stdout.trimEnd()
  const stderr = result.stderr.trimEnd()
  if (stdout && stderr) return `${stdout}\n\n${stderr}`
  return stdout || stderr
}
