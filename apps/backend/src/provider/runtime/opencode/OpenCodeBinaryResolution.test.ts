import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveOpenCodeBinaryAsync } from "./OpenCodeBinaryResolution"

const tempRoots: string[] = []
const originalPath = process.env.PATH
const originalAppData = process.env.APPDATA
const originalLocalAppData = process.env.LOCALAPPDATA
let fakeHome: string

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function binaryName(): string {
  return process.platform === "win32" ? "opencode.exe" : "opencode"
}

beforeEach(() => {
  fakeHome = makeTempDir("betterc0de-opencode-home-")
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome)
  // The Windows known-path list reads APPDATA/LOCALAPPDATA directly, so a real
  // global npm install must not leak into these tests.
  process.env.APPDATA = path.join(fakeHome, "AppData", "Roaming")
  process.env.LOCALAPPDATA = path.join(fakeHome, "AppData", "Local")
})

afterEach(() => {
  vi.restoreAllMocks()
  process.env.PATH = originalPath
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("resolveOpenCodeBinaryAsync", () => {
  it("prefers an explicit absolute path over a PATH hit", async () => {
    const pathDir = makeTempDir("betterc0de-opencode-path-")
    fs.writeFileSync(path.join(pathDir, binaryName()), "fake binary")
    process.env.PATH = pathDir
    const explicitDir = makeTempDir("betterc0de-opencode-config-")
    const explicit = path.join(explicitDir, "my-opencode")
    fs.writeFileSync(explicit, "fake binary")

    await expect(
      resolveOpenCodeBinaryAsync(`  ${explicit}  `)
    ).resolves.toEqual({
      binaryPath: path.normalize(explicit),
      source: "config",
    })
  })

  it("returns null when an explicit path does not exist", async () => {
    const dir = makeTempDir("betterc0de-opencode-missing-")

    await expect(
      resolveOpenCodeBinaryAsync(path.join(dir, "opencode-missing"))
    ).resolves.toBeNull()
  })

  it("finds the Bun installer shim under the home directory", async () => {
    const binDir = path.join(fakeHome, ".bun", "bin")
    fs.mkdirSync(binDir, { recursive: true })
    const binary = path.join(binDir, binaryName())
    fs.writeFileSync(binary, "fake binary")
    // Finder-launched apps have a minimal PATH; the known location must win.
    process.env.PATH = makeTempDir("betterc0de-opencode-empty-path-")

    await expect(resolveOpenCodeBinaryAsync(null)).resolves.toEqual({
      binaryPath: path.normalize(binary),
      source: "known-path",
    })
  })

  it("falls back to a PATH entry", async () => {
    // Keep the system-wide macOS/Linux install locations out of this test so
    // a developer machine with OpenCode installed still exercises PATH.
    const stat = fs.promises.stat.bind(fs.promises)
    vi.spyOn(fs.promises, "stat").mockImplementation(((file: fs.PathLike) => {
      const text = String(file)
      if (
        text === "/usr/local/bin/opencode" ||
        text === "/opt/homebrew/bin/opencode"
      ) {
        return Promise.reject(
          Object.assign(new Error("ENOENT"), { code: "ENOENT" })
        )
      }
      return stat(file)
    }) as typeof fs.promises.stat)

    const binDir = makeTempDir("betterc0de-opencode-path-")
    const binary = path.join(binDir, binaryName())
    fs.writeFileSync(binary, "fake binary")
    process.env.PATH = binDir

    await expect(resolveOpenCodeBinaryAsync(null)).resolves.toEqual({
      binaryPath: path.normalize(binary),
      source: "path",
    })
  })
})
