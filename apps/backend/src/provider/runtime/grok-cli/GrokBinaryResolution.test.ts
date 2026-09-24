import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  resolveGrokBinary,
  resolveGrokBinaryAsync,
} from "./GrokBinaryResolution"

const tempRoots: string[] = []
const originalPath = process.env.PATH
let fakeHome: string

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

beforeEach(() => {
  fakeHome = makeTempDir("betterc0de-grok-home-")
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome)
})

afterEach(() => {
  vi.restoreAllMocks()
  process.env.PATH = originalPath
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe("resolveGrokBinary", () => {
  it("rejects relative configured paths before a session changes its cwd", async () => {
    const dir = makeTempDir("betterc0de-grok-relative-")
    const binary = path.join(dir, "grok.exe")
    fs.writeFileSync(binary, "fake binary")
    // Keep this test independent of Windows long-path/8.3 alias formatting.
    const relative = "grok.exe"
    expect(resolveGrokBinary(relative)).toBeNull()
    await expect(resolveGrokBinaryAsync(relative)).resolves.toBeNull()
  })

  it("pins relative PATH entries to the directory that was inspected", async () => {
    const dir = makeTempDir("betterc0de-grok-relative-shim-")
    const binary = path.join(
      dir,
      process.platform === "win32" ? "grok.cmd" : "grok"
    )
    fs.writeFileSync(binary, "node node_modules/@xai-official/grok/bin/grok.js")
    process.env.PATH = path.relative(process.cwd(), dir)
    expect(resolveGrokBinary()).toMatchObject({ binaryPath: binary })
    await expect(resolveGrokBinaryAsync()).resolves.toMatchObject({
      binaryPath: binary,
    })
  })

  it("accepts an explicit configured path only when the file exists", () => {
    const dir = makeTempDir("betterc0de-grok-config-")
    const binary = path.join(dir, "my-grok.exe")
    fs.writeFileSync(binary, "MZ fake", "utf8")

    expect(resolveGrokBinary(binary)).toMatchObject({
      binaryPath: path.normalize(binary),
      source: "config",
    })
    expect(resolveGrokBinary(path.join(dir, "missing.exe"))).toBeNull()
  })

  it("trusts the xAI installer location ~/.grok/bin", () => {
    const binDir = path.join(fakeHome, ".grok", "bin")
    fs.mkdirSync(binDir, { recursive: true })
    const binary = path.join(
      binDir,
      process.platform === "win32" ? "grok.exe" : "grok"
    )
    fs.writeFileSync(binary, "fake binary", "utf8")

    expect(resolveGrokBinary(null)).toMatchObject({
      binaryPath: binary,
      source: "xai-home",
    })
  })

  it("rejects a foreign PATH shim like grok-dev (the process-storm incident)", () => {
    const shimDir = makeTempDir("betterc0de-grok-shim-")
    const shimName = process.platform === "win32" ? "grok.cmd" : "grok"
    fs.writeFileSync(
      path.join(shimDir, shimName),
      // Real-world content shape of the offending npm shim.
      '@ECHO off\nnode "%~dp0\\node_modules\\grok-dev\\dist\\index.js" %*\n',
      "utf8"
    )
    process.env.PATH = shimDir

    expect(resolveGrokBinary(null)).toBeNull()
  })

  it("accepts a PATH shim that provably targets @xai-official/grok", () => {
    const shimDir = makeTempDir("betterc0de-grok-shim-")
    const shimName = process.platform === "win32" ? "grok.cmd" : "grok"
    const shimPath = path.join(shimDir, shimName)
    fs.writeFileSync(
      shimPath,
      '@ECHO off\nnode "%~dp0\\node_modules\\@xai-official\\grok\\bin\\grok.js" %*\n',
      "utf8"
    )
    process.env.PATH = shimDir

    expect(resolveGrokBinary(null)).toMatchObject({
      binaryPath: path.normalize(shimPath),
      source: "path-shim",
    })
  })

  it("finds an xAI shim in a macOS user install directory with Finder's minimal PATH", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" })
    try {
      const binDir = path.join(fakeHome, ".local", "bin")
      fs.mkdirSync(binDir, { recursive: true })
      const binary = path.join(binDir, "grok")
      fs.writeFileSync(
        binary,
        "node node_modules/@xai-official/grok/bin/grok.js"
      )
      process.env.PATH = makeTempDir("betterc0de-finder-path-")

      expect(resolveGrokBinary()).toMatchObject({ binaryPath: binary })
      await expect(resolveGrokBinaryAsync()).resolves.toMatchObject({
        binaryPath: binary,
      })
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })

  it("accepts a global npm symlink only when it resolves into @xai-official/grok", async () => {
    const root = makeTempDir("betterc0de-grok-npm-link-")
    const binDir = path.join(root, "bin")
    const packageDir = path.join(
      root,
      "lib",
      "node_modules",
      "@xai-official",
      "grok",
      "bin"
    )
    fs.mkdirSync(binDir, { recursive: true })
    fs.mkdirSync(packageDir, { recursive: true })
    const target = path.join(packageDir, "grok.js")
    fs.writeFileSync(target, "#!/usr/bin/env node\n")
    const binary = path.join(
      binDir,
      process.platform === "win32" ? "grok.cmd" : "grok"
    )
    if (process.platform === "win32") {
      // Creating file symlinks requires special privileges on Windows CI.
      fs.writeFileSync(binary, "shim")
      vi.spyOn(fs, "lstatSync").mockReturnValue({
        isSymbolicLink: () => true,
      } as fs.Stats)
      vi.spyOn(fs, "realpathSync").mockReturnValue(target)
      vi.spyOn(fs.promises, "lstat").mockResolvedValue({
        isSymbolicLink: () => true,
      } as fs.Stats)
      vi.spyOn(fs.promises, "realpath").mockResolvedValue(target)
    } else {
      fs.symlinkSync(target, binary)
    }
    process.env.PATH = binDir

    expect(resolveGrokBinary()).toMatchObject({ binaryPath: binary })
    await expect(resolveGrokBinaryAsync()).resolves.toMatchObject({
      binaryPath: binary,
    })
  })

  it("rejects a global npm symlink into a different package", async () => {
    const root = makeTempDir("betterc0de-grok-foreign-link-")
    const binDir = path.join(root, "bin")
    const packageDir = path.join(root, "lib", "node_modules", "grok-dev", "bin")
    fs.mkdirSync(binDir, { recursive: true })
    fs.mkdirSync(packageDir, { recursive: true })
    const target = path.join(packageDir, "grok.js")
    fs.writeFileSync(target, "#!/usr/bin/env node\n")
    const binary = path.join(
      binDir,
      process.platform === "win32" ? "grok.cmd" : "grok"
    )
    if (process.platform === "win32") {
      fs.writeFileSync(binary, "shim")
      vi.spyOn(fs, "lstatSync").mockReturnValue({
        isSymbolicLink: () => true,
      } as fs.Stats)
      vi.spyOn(fs, "realpathSync").mockReturnValue(target)
      vi.spyOn(fs.promises, "lstat").mockResolvedValue({
        isSymbolicLink: () => true,
      } as fs.Stats)
      vi.spyOn(fs.promises, "realpath").mockResolvedValue(target)
    } else {
      fs.symlinkSync(target, binary)
    }
    process.env.PATH = binDir

    expect(resolveGrokBinary()).toBeNull()
    await expect(resolveGrokBinaryAsync()).resolves.toBeNull()
  })

  it("does not scan past the frontmost PATH hit", () => {
    // Foreign shim first on PATH, verified xAI shim later: the shell would
    // run the foreign one, so we must not "helpfully" pick the later one.
    const foreignDir = makeTempDir("betterc0de-grok-foreign-")
    const xaiDir = makeTempDir("betterc0de-grok-xai-")
    const shimName = process.platform === "win32" ? "grok.cmd" : "grok"
    fs.writeFileSync(
      path.join(foreignDir, shimName),
      'node "%~dp0\\node_modules\\grok-dev\\dist\\index.js" %*\n',
      "utf8"
    )
    fs.writeFileSync(
      path.join(xaiDir, shimName),
      'node "%~dp0\\node_modules\\@xai-official\\grok\\bin\\grok.js" %*\n',
      "utf8"
    )
    process.env.PATH = `${foreignDir}${path.delimiter}${xaiDir}`

    expect(resolveGrokBinary(null)).toBeNull()
  })

  it("resolves trusted shims asynchronously without sync filesystem probes", async () => {
    const shimDir = makeTempDir("betterc0de-grok-async-shim-")
    const shimName = process.platform === "win32" ? "grok.cmd" : "grok"
    const shimPath = path.join(shimDir, shimName)
    fs.writeFileSync(
      shimPath,
      'node "%~dp0\\node_modules\\@xai-official\\grok\\bin\\grok.js" %*\n',
      "utf8"
    )
    process.env.PATH = shimDir
    const statSync = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("sync stat must not run")
    })
    const openSync = vi.spyOn(fs, "openSync").mockImplementation(() => {
      throw new Error("sync open must not run")
    })

    await expect(resolveGrokBinaryAsync(null)).resolves.toMatchObject({
      binaryPath: path.normalize(shimPath),
      source: "path-shim",
    })
    expect(statSync).not.toHaveBeenCalled()
    expect(openSync).not.toHaveBeenCalled()
  })
})
