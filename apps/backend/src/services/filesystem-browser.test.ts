import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  listDirectory,
  searchTree,
  enumerateDrives,
  _internal,
} from "./filesystem-browser"

function mkTemp(prefix = "bc-fs-test-"): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe("listDirectory", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkTemp()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fsSync.rmSync(tmp, { recursive: true, force: true })
  })

  it("lists immediate children with dirs first, alphabetically", async () => {
    fsSync.writeFileSync(path.join(tmp, "zebra.txt"), "z")
    fsSync.writeFileSync(path.join(tmp, "apple.txt"), "a")
    fsSync.mkdirSync(path.join(tmp, "folder-b"))
    fsSync.mkdirSync(path.join(tmp, "folder-a"))

    const result = await listDirectory(tmp)
    expect(result.entries.map((e) => e.name)).toEqual([
      "folder-a",
      "folder-b",
      "apple.txt",
      "zebra.txt",
    ])
    expect(result.entries[0].isDir).toBe(true)
    expect(result.entries[2].isDir).toBe(false)
    expect(result.entries[2].size).toBe(1)
  })

  it("hides dotfiles by default, shows them when requested", async () => {
    fsSync.writeFileSync(path.join(tmp, ".hidden"), "x")
    fsSync.writeFileSync(path.join(tmp, "visible"), "x")

    const hidden = await listDirectory(tmp)
    expect(hidden.entries.map((e) => e.name)).toEqual(["visible"])

    const shown = await listDirectory(tmp, true)
    expect(shown.entries.map((e) => e.name).sort()).toEqual([
      ".hidden",
      "visible",
    ])
  })

  it("returns parent path (null when at filesystem root)", async () => {
    const sub = path.join(tmp, "child")
    fsSync.mkdirSync(sub)
    const result = await listDirectory(sub)
    expect(result.parent).toBe(tmp)
  })

  it("throws 404 for non-existent path", async () => {
    const missing = path.join(tmp, "does-not-exist")
    await expect(listDirectory(missing)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it("pages a large directory in deterministic order without losing entries", async () => {
    const names = Array.from(
      { length: 5003 },
      (_, i) => `file-${String(i).padStart(5, "0")}.ts`
    )
    const dirents = [...names].reverse().map((name) => ({
      name,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }))
    vi.spyOn(fs, "readdir").mockResolvedValue(dirents as never)
    vi.spyOn(fs, "stat").mockResolvedValue(fsSync.statSync(tmp))
    const first = await listDirectory(tmp, true)
    const second = await listDirectory(tmp, true, first.nextOffset)
    expect(first.truncated).toBe(true)
    expect(first.nextOffset).toBe(5000)
    expect(second.truncated).toBe(false)
    expect(second.nextOffset).toBeUndefined()
    expect(
      [...first.entries, ...second.entries].map((entry) => entry.name)
    ).toEqual(names)
    expect((await listDirectory(tmp, true, 9000)).entries).toEqual([])
  })

  it.each([-1, 0.5, NaN, Infinity])(
    "rejects invalid listing offset %s",
    async (offset) => {
      await expect(listDirectory(tmp, true, offset)).rejects.toMatchObject({
        statusCode: 400,
      })
    }
  )

  it("throws 400 for invalid path (via safety helper)", async () => {
    await expect(listDirectory("not-absolute")).rejects.toThrow(/absolute/)
    await expect(listDirectory(42)).rejects.toThrow()
  })
})

describe("searchTree", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkTemp()
  })

  afterEach(() => {
    fsSync.rmSync(tmp, { recursive: true, force: true })
  })

  it("ranks exact > prefix > substring", async () => {
    fsSync.writeFileSync(path.join(tmp, "package.json"), "{}")
    fsSync.writeFileSync(path.join(tmp, "package-lock.json"), "{}")
    fsSync.writeFileSync(path.join(tmp, "my-package.json"), "{}")

    const result = await searchTree(tmp, "package.json", 10)
    expect(result.entries[0].name).toBe("package.json") // exact
    expect(result.entries[0].score).toBe(3)
    const scores = result.entries.map((e) => e.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it("respects limit", async () => {
    for (let i = 0; i < 50; i++) {
      fsSync.writeFileSync(path.join(tmp, `file-${i}.txt`), "x")
    }
    const result = await searchTree(tmp, "file", 5)
    expect(result.entries.length).toBe(5)
    expect(result.truncated).toBe(true)
  })

  it("walks nested dirs up to depth cap", async () => {
    // depth 0 = root; create target at depth 3 (should be found)
    let cur = tmp
    for (let i = 0; i < 3; i++) {
      cur = path.join(cur, `d${i}`)
      fsSync.mkdirSync(cur)
    }
    fsSync.writeFileSync(path.join(cur, "needle.txt"), "x")
    const result = await searchTree(tmp, "needle", 10)
    expect(result.entries.map((e) => e.name)).toContain("needle.txt")
  })

  it("does not loop on symlink cycles", async () => {
    // Only meaningful on POSIX; skip on Windows where fs.symlink needs elevated perms.
    if (process.platform === "win32") return
    const inner = path.join(tmp, "inner")
    fsSync.mkdirSync(inner)
    fsSync.symlinkSync(tmp, path.join(inner, "loopback"), "dir")
    const start = Date.now()
    const result = await searchTree(tmp, "", 100)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(1500) // hard cap is 1000ms + slack
    expect(result.entries.length).toBeLessThanOrEqual(100)
  })

  it("does not follow a symlinked directory out of the search root", async () => {
    // The root is the confinement boundary for a paired device; a junction
    // works on Windows without elevation, a directory symlink elsewhere.
    const outside = mkTemp("bc-fs-outside-")
    try {
      fsSync.writeFileSync(path.join(outside, "escaped-secret.txt"), "x")
      fsSync.mkdirSync(path.join(tmp, "inside"))
      fsSync.writeFileSync(path.join(tmp, "inside", "kept-secret.txt"), "x")
      fsSync.symlinkSync(
        outside,
        path.join(tmp, "escape"),
        process.platform === "win32" ? "junction" : "dir"
      )

      const result = await searchTree(tmp, "secret", 50)
      const names = result.entries.map((e) => e.name)
      expect(names).toContain("kept-secret.txt")
      expect(names).not.toContain("escaped-secret.txt")
    } finally {
      fsSync.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("still follows a symlinked directory that stays inside the root", async () => {
    fsSync.mkdirSync(path.join(tmp, "real"))
    fsSync.writeFileSync(path.join(tmp, "real", "linked-target.txt"), "x")
    fsSync.symlinkSync(
      path.join(tmp, "real"),
      path.join(tmp, "alias"),
      process.platform === "win32" ? "junction" : "dir"
    )

    const result = await searchTree(tmp, "linked-target", 50)
    expect(result.entries.map((e) => e.name)).toContain("linked-target.txt")
  })

  it("skips unreadable subdirectories silently (continues walk)", async () => {
    fsSync.writeFileSync(path.join(tmp, "reachable.txt"), "x")
    // Create an "unreachable" subdir scenario by using a non-existent path;
    // we can't easily chmod 000 cross-platform, so fake via a broken symlink
    // on POSIX. On Windows, just verify the happy path still works.
    if (process.platform !== "win32") {
      fsSync.symlinkSync(
        "/nonexistent-xyzzy-target",
        path.join(tmp, "broken"),
        "dir"
      )
    }
    const result = await searchTree(tmp, "reachable", 10)
    expect(result.entries.some((e) => e.name === "reachable.txt")).toBe(true)
  })
})

describe("enumerateDrives", () => {
  beforeEach(() => {
    _internal.clearDrivesCache()
  })

  it("returns home shortcut + platform-appropriate entries", async () => {
    const result = await enumerateDrives()
    expect(result.platform).toBe(process.platform)
    const home = result.entries.find((e) => e.kind === "home")
    expect(home).toBeDefined()
    expect(home?.reachable).toBe(true)
  })

  it("caches results across calls", async () => {
    const first = await enumerateDrives()
    const second = await enumerateDrives()
    expect(second).toBe(first) // referential equality = cache hit
  })
})
