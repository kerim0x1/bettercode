import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getCursorParameterizedModelPickerUnsupportedMessage,
  parseCursorAboutOutput,
  parseCursorCliConfigChannel,
  parseCursorVersionDate,
  probeCursorProviderStatus,
} from "./CursorProviderStatus"
import * as termination from "../ChildProcessTermination"

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true })
})

async function makeProbe(
  directoryName: string,
  source: string
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-status-"))
  directories.push(root)
  vi.spyOn(os, "homedir").mockReturnValue(root)
  const directory = path.join(root, directoryName)
  await fs.mkdir(directory)
  const script = path.join(directory, "probe.cjs")
  await fs.writeFile(script, source)
  const binary = path.join(
    directory,
    process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent"
  )
  await fs.writeFile(
    binary,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o700 }
  )
  return binary
}

describe("CursorProviderStatus", () => {
  it("probes configured shim paths containing spaces and shell operators literally", async () => {
    const binaryPath = await makeProbe(
      "Cursor Agent & CLI",
      'console.log(JSON.stringify({cliVersion:"2026.04.08",userEmail:"safe@example.com"}))'
    )
    const result = await probeCursorProviderStatus({ binaryPath })
    expect(result.auth).toMatchObject({
      status: "authenticated",
      email: "safe@example.com",
    })
  })

  it("does not reuse authentication status across different provider environments", async () => {
    const binaryPath = await makeProbe(
      "cli",
      'console.log(JSON.stringify({cliVersion:"2026.04.08",userEmail:process.env.CURSOR_TEST_EMAIL}))'
    )
    const first = await probeCursorProviderStatus({
      binaryPath,
      env: { ...process.env, CURSOR_TEST_EMAIL: "first@example.com" },
    })
    const second = await probeCursorProviderStatus({
      binaryPath,
      env: { ...process.env, CURSOR_TEST_EMAIL: "second@example.com" },
    })
    expect(first.auth.email).toBe("first@example.com")
    expect(second.auth.email).toBe("second@example.com")
  })

  it("rejects probe output that exceeds the shared byte budget", async () => {
    const binaryPath = await makeProbe(
      "large",
      'console.log(JSON.stringify({cliVersion:"2026.04.08",userEmail:"x".repeat(300*1024)})); setInterval(() => {}, 1000)'
    )
    const result = await probeCursorProviderStatus({ binaryPath })
    expect(result.auth.status).toBe("unknown")
    expect(result.auth.email).toBeUndefined()
  })

  it("retains failed probe cleanup and blocks another spawn until retry succeeds", async () => {
    const binaryPath = await makeProbe("cleanup", "")
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 42,
      exitCode: null,
      signalCode: null,
    }) as unknown as childProcess.ChildProcess
    const nextChild = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 43,
      exitCode: 0,
      signalCode: null,
    }) as unknown as childProcess.ChildProcess
    const spawn = vi
      .mocked(childProcess.spawn)
      .mockClear()
      .mockImplementationOnce(() => {
        queueMicrotask(() =>
          child.stdout!.emit("data", Buffer.alloc(300 * 1024))
        )
        return child
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          nextChild.stdout!.emit(
            "data",
            JSON.stringify({
              cliVersion: "2026.04.08",
              userEmail: "recovered@example.com",
            })
          )
          nextChild.emit("close", 0)
        })
        return nextChild
      })
    const cleanup = vi
      .spyOn(termination, "terminateProviderChildProcessTree")
      .mockImplementationOnce(async () => {
        // A concurrent close notification must not overwrite cleanup failure.
        child.emit("close", 0)
        throw new Error("tree cleanup failed")
      })
      .mockRejectedValueOnce(new Error("tree still running"))
      .mockResolvedValueOnce(undefined)
    expect((await probeCursorProviderStatus({ binaryPath })).status).toBe(
      "error"
    )
    if (process.platform === "win32") {
      Object.assign(child, { exitCode: 0 })
      expect((await probeCursorProviderStatus({ binaryPath })).status).toBe(
        "error"
      )
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledTimes(1)
      // Continue the independent live-root retry branch with the same mock.
      Object.assign(child, { exitCode: null })
    }
    expect((await probeCursorProviderStatus({ binaryPath })).status).toBe(
      "error"
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    expect((await probeCursorProviderStatus({ binaryPath })).auth.email).toBe(
      "recovered@example.com"
    )
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(cleanup.mock.calls.map(([target]) => target)).toEqual([
      child,
      child,
      child,
    ])
  })

  it("accepts JSON surrounded by a UTF-8 BOM and whitespace", () => {
    const json = JSON.stringify({
      cliVersion: "2026.04.08",
      userEmail: "user@example.com",
      subscriptionTier: "pro",
    })
    const parse = (stdout: string) =>
      parseCursorAboutOutput({ stdout, stderr: "", code: 0 })
    expect(parse("\uFEFF \n" + json + "\n")).toEqual(parse(json))
    expect(parse(json).auth.status).toBe("authenticated")
  })

  it("parses authenticated JSON `agent about` output with subscription metadata", () => {
    expect(
      parseCursorAboutOutput({
        stdout: JSON.stringify({
          cliVersion: "2026.04.08-abcdef",
          userEmail: "user@example.com",
          subscriptionTier: "Team",
        }),
        stderr: "",
        code: 0,
      })
    ).toEqual({
      version: "2026.04.08-abcdef",
      status: "ready",
      auth: {
        status: "authenticated",
        email: "user@example.com",
        type: "Team",
        label: "Cursor Team Subscription",
      },
    })
  })

  it("parses unauthenticated JSON and plain text `agent about` output", () => {
    expect(
      parseCursorAboutOutput({
        stdout: JSON.stringify({
          cliVersion: "2026.04.08-abcdef",
          userEmail: null,
        }),
        stderr: "",
        code: 0,
      })
    ).toEqual({
      version: "2026.04.08-abcdef",
      status: "error",
      auth: { status: "unauthenticated" },
      message:
        "Cursor Agent is not authenticated. Run `agent login` and try again.",
    })

    expect(
      parseCursorAboutOutput({
        stdout: [
          "About Cursor CLI",
          "",
          "CLI Version         2026.04.08-abcdef",
          "User Email          Not logged in",
        ].join("\n"),
        stderr: "",
        code: 0,
      })
    ).toEqual({
      version: "2026.04.08-abcdef",
      status: "error",
      auth: { status: "unauthenticated" },
      message:
        "Cursor Agent is not authenticated. Run `agent login` and try again.",
    })
  })

  it("keeps auth unknown when the user email field is absent", () => {
    expect(
      parseCursorAboutOutput({
        stdout: "CLI Version         2026.04.08-abcdef\n",
        stderr: "",
        code: 0,
      })
    ).toEqual({
      version: "2026.04.08-abcdef",
      status: "ready",
      auth: { status: "unknown" },
    })
  })

  it("detects Cursor parameterized model picker version and channel requirements", () => {
    expect(parseCursorVersionDate("2026.04.08-abcdef")).toBe(20260408)
    expect(parseCursorCliConfigChannel('{"channel":"lab"}')).toBe("lab")

    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.03.20-abcdef",
        channel: "stable",
      })
    ).toBe(
      'Cursor Agent CLI version 2026.03.20-abcdef is too old for Cursor ACP parameterized model picker. Cursor Agent CLI channel is "stable", but parameterized model picker is only available on the lab channel. Run `agent set-channel lab && agent update` and use Cursor Agent CLI 2026.04.08 or newer.'
    )
  })
})
