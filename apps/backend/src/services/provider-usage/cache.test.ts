import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scanWithCache } from "./cache"

describe("scanWithCache", () => {
  let dataDir = ""
  let workDir = ""

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cache-"))
    dataDir = path.join(root, "userdata")
    workDir = path.join(root, "files")
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(workDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(path.dirname(dataDir), { recursive: true, force: true })
  })

  function write(name: string, body: string): string {
    const file = path.join(workDir, name)
    fs.writeFileSync(file, body, "utf8")
    return file
  }

  const options = (files: string[], compute: (file: string) => number) => ({
    dataDir,
    scope: "test",
    files,
    compute: async (file: string) => compute(file),
  })

  it("computes once and reuses the cached aggregate", async () => {
    const file = write("a.jsonl", "one")
    let computations = 0
    const compute = (target: string) => {
      computations += 1
      return fs.readFileSync(target, "utf8").length
    }

    const first = await scanWithCache(options([file], compute))
    expect(first.values).toEqual([3])
    expect(first.scanned).toBe(1)

    const second = await scanWithCache(options([file], compute))
    expect(second.values).toEqual([3])
    expect(second.reused).toBe(1)
    expect(computations).toBe(1)
  })

  it("recomputes a file whose fingerprint moved", async () => {
    const file = write("a.jsonl", "one")
    const compute = (target: string) => fs.readFileSync(target, "utf8").length
    await scanWithCache(options([file], compute))

    fs.writeFileSync(file, "one more", "utf8")
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000))
    const rescan = await scanWithCache(options([file], compute))
    expect(rescan.values).toEqual([8])
    expect(rescan.scanned).toBe(1)
  })

  it("drops files that disappeared and keeps the rest", async () => {
    const kept = write("keep.jsonl", "aa")
    const gone = write("gone.jsonl", "bbbb")
    const compute = (target: string) => fs.readFileSync(target, "utf8").length
    await scanWithCache(options([kept, gone], compute))

    fs.rmSync(gone)
    const rescan = await scanWithCache(options([kept, gone], compute))
    expect(rescan.values).toEqual([2])

    const stored = JSON.parse(
      fs.readFileSync(path.join(dataDir, "usage-stats-cache.json"), "utf8")
    ) as { scopes: Record<string, Record<string, unknown>> }
    expect(Object.keys(stored.scopes.test ?? {})).toEqual([kept])
  })

  it("still scans when no data directory is available", async () => {
    const file = write("a.jsonl", "one")
    const result = await scanWithCache({
      dataDir: null,
      scope: "test",
      files: [file],
      compute: async () => 42,
    })
    expect(result.values).toEqual([42])
    expect(fs.existsSync(path.join(dataDir, "usage-stats-cache.json"))).toBe(
      false
    )
  })
})
