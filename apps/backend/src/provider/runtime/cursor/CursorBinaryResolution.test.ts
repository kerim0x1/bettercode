import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  resolveCursorBinary,
  resolveCursorBinaryAsync,
} from "./CursorBinaryResolution"

const cleanup: string[] = []
const originalPath = process.env.PATH

beforeEach(() => {
  const home = tempDir("home")
  vi.spyOn(os, "homedir").mockReturnValue(home)
  vi.stubEnv("LOCALAPPDATA", home)
})

function tempDir(label: string): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `betterc0de-cursor-${label}-`)
  )
  cleanup.push(directory)
  return directory
}

function writeFile(directory: string, name: string, contents: string): string {
  const filePath = path.join(directory, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of cleanup.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe("resolveCursorBinary", () => {
  it("trusts an explicit configured path that exists", () => {
    const directory = tempDir("config")
    const binary = writeFile(directory, "my-cursor", "#!/bin/sh\n")
    expect(resolveCursorBinary(binary)).toEqual({
      binaryPath: path.normalize(binary),
      source: "config",
    })
  })

  it("rejects a relative configured path even when the file exists", () => {
    const directory = tempDir("relative")
    writeFile(directory, "cursor-agent.cmd", "#!/bin/sh\n")
    // Use a deliberately relative value. On hosted Windows runners the temp
    // directory may be exposed through a different 8.3 alias than cwd, which
    // makes path.relative return an absolute string despite both paths being
    // on the same drive.
    const relative = "cursor-agent.cmd"
    expect(path.isAbsolute(relative)).toBe(false)
    expect(resolveCursorBinary(relative)).toBeNull()
  })

  it("rejects an explicit path that does not exist", () => {
    expect(
      resolveCursorBinary(path.join(tempDir("missing"), "nope"))
    ).toBeNull()
  })

  it("finds the vendor-named binary on PATH", () => {
    const directory = tempDir("path")
    const name =
      process.platform === "win32" ? "cursor-agent.exe" : "cursor-agent"
    const binary = writeFile(directory, name, "binary")
    process.env.PATH = directory
    expect(resolveCursorBinary(null)).toEqual({
      binaryPath: path.normalize(binary),
      source: "path",
    })
  })

  it.skipIf(process.platform !== "win32")(
    "finds the native Windows installer shim without PATH and ignores Grok's agent",
    async () => {
      const localAppData = tempDir("windows-install")
      vi.stubEnv("LOCALAPPDATA", localAppData)
      const installDir = path.join(localAppData, "cursor-agent")
      fs.mkdirSync(installDir)
      const binary = writeFile(
        installDir,
        "cursor-agent.cmd",
        "@echo off\r\npowershell -File cursor-agent.ps1 %*\r\n"
      )
      const grokDir = tempDir("grok-agent")
      writeFile(grokDir, "agent.exe", "foreign binary")
      process.env.PATH = grokDir

      const expected = {
        binaryPath: path.normalize(binary),
        source: "cursor-home",
      }
      expect(resolveCursorBinary(null)).toEqual(expected)
      expect(await resolveCursorBinaryAsync(null)).toEqual(expected)
    }
  )

  // The bug this module exists for: on a machine with xAI's Grok Build
  // installed, a bare `agent` on PATH is Grok's binary, not Cursor's. Probing
  // it would start a foreign coding agent and report Cursor as broken.
  it("refuses a bare `agent` that belongs to another vendor", () => {
    const directory = tempDir("foreign")
    const name = process.platform === "win32" ? "agent.cmd" : "agent"
    writeFile(directory, name, "@node %~dp0/../grok-dev/bin/agent.js %*")
    process.env.PATH = directory
    expect(resolveCursorBinary(null)).toBeNull()
    expect(resolveCursorBinary("agent")).toBeNull()
  })

  it("accepts a bare `agent` whose shim names Cursor", () => {
    const directory = tempDir("shim")
    const name = process.platform === "win32" ? "agent.cmd" : "agent"
    const binary = writeFile(
      directory,
      name,
      '#!/bin/sh\nexec node /opt/cursor-agent/dist/index.js "$@"\n'
    )
    process.env.PATH = directory
    expect(resolveCursorBinary(null)).toEqual({
      binaryPath: path.normalize(binary),
      source: "path-shim",
    })
  })

  it("rejects a compiled `agent` executable it cannot inspect", () => {
    const directory = tempDir("compiled")
    const name = process.platform === "win32" ? "agent.exe" : "agent"
    fs.writeFileSync(
      path.join(directory, name),
      Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x01, 0x02])
    )
    process.env.PATH = directory
    expect(resolveCursorBinary(null)).toBeNull()
  })

  it("prefers the vendor-named binary over an ambiguous one", () => {
    const directory = tempDir("both")
    const ambiguous = process.platform === "win32" ? "agent.cmd" : "agent"
    writeFile(directory, ambiguous, "@node %~dp0/../grok-dev/bin/agent.js %*")
    const vendor =
      process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent"
    const binary = writeFile(directory, vendor, "#!/bin/sh\n")
    process.env.PATH = directory
    expect(resolveCursorBinary(null)?.binaryPath).toBe(path.normalize(binary))
  })

  it("resolves identically through the async path", async () => {
    const directory = tempDir("async")
    const name =
      process.platform === "win32" ? "cursor-agent.cmd" : "cursor-agent"
    const binary = writeFile(directory, name, "#!/bin/sh\n")
    process.env.PATH = directory
    expect(await resolveCursorBinaryAsync(null)).toEqual(
      resolveCursorBinary(null)
    )
    expect((await resolveCursorBinaryAsync(null))?.binaryPath).toBe(
      path.normalize(binary)
    )
  })
})
