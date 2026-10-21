import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  scanAppendOnlyWithCache,
  scanWithCache,
  usageCachePath,
  type AppendScan,
} from "./cache"
import { forEachLine } from "./jsonl"

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
      fs.readFileSync(usageCachePath(dataDir, "test"), "utf8")
    ) as { scope: string; entries: Record<string, unknown> }
    expect(stored.scope).toBe("test")
    expect(Object.keys(stored.entries)).toEqual([kept])
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
    expect(fs.readdirSync(dataDir)).toEqual([])
  })

  it("keeps each scope in its own file and removes the legacy shared file", async () => {
    const legacy = path.join(dataDir, "usage-stats-cache.json")
    fs.writeFileSync(legacy, JSON.stringify({ version: 5, scopes: {} }), "utf8")
    const claude = write("claude.jsonl", "claude")
    const codex = write("codex.jsonl", "codex")
    await scanWithCache({
      dataDir,
      scope: "claude",
      files: [claude],
      compute: async () => 6,
    })
    await scanWithCache({
      dataDir,
      scope: "codex",
      files: [codex],
      compute: async () => 5,
    })
    expect(fs.existsSync(legacy)).toBe(false)
    const claudeFile = JSON.parse(
      fs.readFileSync(usageCachePath(dataDir, "claude"), "utf8")
    ) as { entries: Record<string, unknown> }
    expect(Object.keys(claudeFile.entries)).toEqual([claude])
    const codexFile = JSON.parse(
      fs.readFileSync(usageCachePath(dataDir, "codex"), "utf8")
    ) as { entries: Record<string, unknown> }
    expect(Object.keys(codexFile.entries)).toEqual([codex])
    expect(
      fs.readdirSync(dataDir).filter((name) => name.endsWith(".tmp"))
    ).toEqual([])
  })

  it("preserves both providers when their scans overlap", async () => {
    const claude = write("claude.jsonl", "claude")
    const codex = write("codex.jsonl", "codex")
    let finishClaude!: () => void
    const pending = new Promise<void>((resolve) => {
      finishClaude = resolve
    })
    const first = scanWithCache({
      dataDir,
      scope: "claude",
      files: [claude],
      compute: async () => {
        await pending
        return 6
      },
    })
    await scanWithCache({
      dataDir,
      scope: "codex",
      files: [codex],
      compute: async () => 5,
    })
    finishClaude()
    await first

    for (const [scope, file, value] of [
      ["claude", claude, 6],
      ["codex", codex, 5],
    ] as const) {
      const cached = await scanWithCache({
        dataDir,
        scope,
        files: [file],
        compute: async () => {
          throw new Error("Unchanged transcripts must not be read again")
        },
      })
      expect(cached.values).toEqual([value])
      expect(cached.reused).toBe(1)
    }
  })
})

describe("scanAppendOnlyWithCache", () => {
  let dataDir = ""
  let workDir = ""

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-append-"))
    dataDir = path.join(root, "userdata")
    workDir = path.join(root, "files")
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(workDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(path.dirname(dataDir), { recursive: true, force: true })
  })

  /** Counts lines; records where each scan started. */
  function lineCounter(starts: number[]) {
    return async (
      file: string,
      from: AppendScan<number> | null
    ): Promise<AppendScan<number> | null> => {
      starts.push(from?.offset ?? 0)
      let lines = from?.value ?? 0
      const offset = await forEachLine(
        file,
        () => {
          lines += 1
        },
        { from: from?.offset ?? 0, completeLinesOnly: true }
      )
      return offset === null ? null : { value: lines, offset }
    }
  }

  function touchLater(file: string): void {
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000))
  }

  it("reads only what was appended since the last scan", async () => {
    const file = path.join(workDir, "chat.jsonl")
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n', "utf8")
    const starts: number[] = []
    const scan = lineCounter(starts)
    const options = { dataDir, scope: "append", files: [file], scan }

    expect((await scanAppendOnlyWithCache(options)).values).toEqual([2])
    fs.appendFileSync(file, '{"a":3}\n', "utf8")
    touchLater(file)
    expect((await scanAppendOnlyWithCache(options)).values).toEqual([3])
    expect(starts).toEqual([0, 16])
  })

  it("leaves a line still being written for the next scan", async () => {
    const file = path.join(workDir, "chat.jsonl")
    fs.writeFileSync(file, '{"a":1}\n{"a":', "utf8")
    const scan = lineCounter([])
    const options = { dataDir, scope: "append", files: [file], scan }

    expect((await scanAppendOnlyWithCache(options)).values).toEqual([1])
    fs.appendFileSync(file, "2}\n", "utf8")
    touchLater(file)
    expect((await scanAppendOnlyWithCache(options)).values).toEqual([2])
  })

  it("starts over when the file was rewritten", async () => {
    const file = path.join(workDir, "chat.jsonl")
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n', "utf8")
    const starts: number[] = []
    const scan = lineCounter(starts)
    const options = { dataDir, scope: "append", files: [file], scan }
    await scanAppendOnlyWithCache(options)

    fs.writeFileSync(file, '{"b":1}\n{"b":2}\n{"b":3}\n', "utf8")
    touchLater(file)
    expect((await scanAppendOnlyWithCache(options)).values).toEqual([3])
    expect(starts).toEqual([0, 0])
  })
})
