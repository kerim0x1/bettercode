import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appendBoundedOutput,
  ensurePosixProcessGroupTerminated,
  MAX_CAPTURED_OUTPUT_BYTES,
  resolveDefaultShellTimeoutMs,
  resolveGitBashPath,
  resolveShellCommandLaunch,
  runShellCommand,
} from "./shell"
import { ShellCapabilityIssuer } from "../security/shellCapability"

describe("shell command launch resolution", () => {
  it("bounds captured command output", () => {
    const first = appendBoundedOutput(
      "",
      Buffer.alloc(MAX_CAPTURED_OUTPUT_BYTES, 65)
    )
    const overflow = appendBoundedOutput(first.text, Buffer.from("overflow"))

    expect(Buffer.byteLength(overflow.text, "utf8")).toBe(
      MAX_CAPTURED_OUTPUT_BYTES
    )
    expect(overflow.truncated).toBe(true)
  })

  it("keeps the capture limit byte-accurate when truncating unicode", () => {
    const output = appendBoundedOutput("", "😀😀😀", 5)

    expect(output.truncated).toBe(true)
    expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(5)
  })

  it("reports the running byte count so callers need not re-measure", () => {
    const first = appendBoundedOutput("", "héllo", 1024)
    expect(first.bytes).toBe(Buffer.byteLength("héllo", "utf8"))

    const second = appendBoundedOutput(first.text, "!", 1024, first.bytes)
    expect(second.bytes).toBe(first.bytes + 1)
    expect(second.text).toBe("héllo!")

    const capped = appendBoundedOutput(
      second.text,
      "😀😀",
      second.bytes + 4,
      second.bytes
    )
    expect(capped.truncated).toBe(true)
    expect(capped.bytes).toBe(Buffer.byteLength(capped.text, "utf8"))
    expect(capped.bytes).toBeLessThanOrEqual(second.bytes + 4)
  })

  it("issues one-shot capabilities bound to the requested operation", () => {
    const issuer = new ShellCapabilityIssuer({ ttlMs: 5_000 })
    const scope = {
      operation: "run" as const,
      command: "echo ok",
      cwd: "/repo",
    }
    const token = issuer.issue(scope)

    expect(issuer.consume(token, { ...scope, command: "echo changed" })).toBe(
      false
    )
    expect(issuer.consume(token, scope)).toBe(true)
    expect(issuer.consume(token, scope)).toBe(false)
  })

  it("runs zsh commands through zsh instead of falling back to bash", () => {
    expect(resolveShellCommandLaunch("zsh", "echo ok")).toEqual({
      shell: "zsh",
      binary: "zsh",
      args: ["-c", "echo ok"],
    })
  })

  it.runIf(process.platform === "win32")(
    "passes the Windows default shell a verbatim cmd.exe /s /c line",
    () => {
      const launch = resolveShellCommandLaunch(
        "cmd",
        'node x.cjs -m "fix: thing"'
      )
      expect(launch.shell).toBe("cmd")
      expect(launch.windowsVerbatimArguments).toBe(true)
      expect(launch.args).toEqual([
        "/d",
        "/s",
        "/c",
        '"node x.cjs -m "fix: thing""',
      ])
      // Node's own quoting must stay off; it is what turned `"` into `\"`.
      expect(launch.args.join(" ")).not.toContain('\\"')
    }
  )

  it.runIf(process.platform !== "win32")(
    "accepts absolute unix shell paths from BetterC0de project config",
    () => {
      const shellPath = path.join(path.sep, "bin", "sh")
      expect(resolveShellCommandLaunch(shellPath, "echo ok")).toEqual({
        shell: "sh",
        binary: shellPath,
        args: ["-c", "echo ok"],
      })
    }
  )

  it("accepts BetterC0de_GIT_BASH_PATH as the Git Bash override on Windows", () => {
    expect(
      resolveGitBashPath({
        platform: "win32",
        env: {
          BetterC0de_GIT_BASH_PATH: "C:\\Tools\\Git\\bin\\bash.exe",
          BETTERC0DE_GIT_BASH: "C:\\Other\\Git\\bin\\bash.exe",
        } as NodeJS.ProcessEnv,
        exists: (candidate) => candidate === "C:\\Tools\\Git\\bin\\bash.exe",
      })
    ).toBe("C:\\Tools\\Git\\bin\\bash.exe")
  })

  it("uses BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS as the default timeout", () => {
    expect(
      resolveDefaultShellTimeoutMs({
        BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: "300000",
      } as NodeJS.ProcessEnv)
    ).toBe(300_000)
  })

  it.each(["", "0", "-1", "1.5", "abc"])(
    "ignores invalid BetterC0de default shell timeout value %j",
    (value) => {
      expect(
        resolveDefaultShellTimeoutMs({
          BetterC0de_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: value,
        } as NodeJS.ProcessEnv)
      ).toBe(120_000)
    }
  )
})

describe("shell process-tree termination", () => {
  it("escalates a surviving POSIX group after its root exits", async () => {
    vi.useFakeTimers()
    let alive = true
    const kill = vi.spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number
    ) => {
      expect(pid).toBe(-4444)
      if (signal === 0) {
        if (alive) return true
        throw Object.assign(new Error("gone"), { code: "ESRCH" })
      }
      if (signal === "SIGKILL") alive = false
      return true
    }) as typeof process.kill)
    try {
      const termination = ensurePosixProcessGroupTerminated(4444)
      await vi.advanceTimersByTimeAsync(300)
      await expect(termination).resolves.toBeUndefined()
      expect(kill).toHaveBeenCalledWith(-4444, "SIGTERM")
      expect(kill).toHaveBeenCalledWith(-4444, "SIGKILL")
    } finally {
      kill.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe("shell command argument delivery", () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function writeArgvScript(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betterc0de-shell-argv-"))
    tempDirs.push(dir)
    const script = path.join(dir, "argv.cjs")
    fs.writeFileSync(
      script,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n",
      "utf8"
    )
    return script
  }

  it("preserves a pre-existing archive when exclusive creation fails", async () => {
    const script = writeArgvScript()
    const archivePath = path.join(path.dirname(script), "existing-output.txt")
    fs.writeFileSync(archivePath, "pre-existing output")
    const result = await runShellCommand({
      command: `node "${script}"`,
      cwd: path.dirname(script),
      archivePath,
    })
    expect(result.success).toBe(true)
    expect(result.archivePath).toBeUndefined()
    expect(fs.readFileSync(archivePath, "utf8")).toBe("pre-existing output")
  })

  // Reproduces the review finding: through `cmd /c` with Node's default
  // quoting, `-m "fix: thing"` reached the child as `-m`, `"fix:`, `thing"`.
  it("delivers a quoted argument intact through the default shell", async () => {
    const script = writeArgvScript()
    const result = await runShellCommand({
      command: `node "${script}" -m "fix: thing" plain`,
      cwd: path.dirname(script),
      timeoutMs: 30_000,
    })

    expect(result.success).toBe(true)
    expect(JSON.parse(result.stdout)).toEqual(["-m", "fix: thing", "plain"])
  }, 30_000)

  // Windows PowerShell starts slowly on a busy CI runner (6-8 s beside the
  // rest of the suite). The command's own timeout must end before the
  // test's, so a slow start fails as a timeout with the shell ended, not as
  // an abandoned test whose shell still holds the temporary folder.
  it.runIf(process.platform === "win32")(
    "delivers a quoted argument intact through PowerShell",
    async () => {
      const script = writeArgvScript()
      const result = await runShellCommand({
        command: `node "${script}" -m "fix: thing" plain`,
        cwd: path.dirname(script),
        shell: "powershell",
        timeoutMs: 60_000,
      })

      expect(result.timedOut).toBe(false)
      expect(result.success).toBe(true)
      expect(JSON.parse(result.stdout)).toEqual(["-m", "fix: thing", "plain"])
    },
    90_000
  )

  // A child that reads stdin must see EOF immediately instead of blocking on
  // an open pipe until the shell timeout kills it.
  it("gives the child a closed stdin", async () => {
    const script = writeArgvScript()
    const stdinScript = path.join(path.dirname(script), "stdin.cjs")
    fs.writeFileSync(
      stdinScript,
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('EOF'))\n",
      "utf8"
    )
    const startedAt = Date.now()
    const result = await runShellCommand({
      command: `node "${stdinScript}"`,
      cwd: path.dirname(script),
      timeoutMs: 20_000,
    })

    expect(result.timedOut).toBe(false)
    expect(result.success).toBe(true)
    expect(result.stdout).toBe("EOF")
    expect(Date.now() - startedAt).toBeLessThan(15_000)
  }, 30_000)
})
