import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  forEachLine,
  forEachMatchingLine,
  lastMatchingLines,
  listJsonlFiles,
} from "./jsonl"

describe("forEachMatchingLine", () => {
  let dir = ""

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-jsonl-"))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function write(body: string): string {
    const file = path.join(dir, "chat.jsonl")
    fs.writeFileSync(file, body, "utf8")
    return file
  }

  async function matching(
    file: string,
    marker: string,
    options: Parameters<typeof forEachMatchingLine>[3] = {}
  ): Promise<{ lines: string[]; result: number | null }> {
    const lines: string[] = []
    const result = await forEachMatchingLine(
      file,
      marker,
      (line) => lines.push(line),
      options
    )
    return { lines, result }
  }

  it("returns only the lines with the marker, decoded whole", async () => {
    const file = write(
      [
        '{"type":"user","text":"skip"}',
        '{"type":"assistant","text":"Grüße 👋"}',
        "",
        '{"type":"assistant","text":"two"}',
        '{"type":"system"}',
      ].join("\n") + "\n"
    )
    const { lines, result } = await matching(file, '"type":"assistant"')
    expect(lines).toEqual([
      '{"type":"assistant","text":"Grüße 👋"}',
      '{"type":"assistant","text":"two"}',
    ])
    expect(result).toBe(fs.statSync(file).size)
  })

  it("finds the same lines as forEachLine across chunk boundaries and long lines", async () => {
    // Lines of many lengths, one longer than the 4 MiB read size, so matches
    // sit on, before and after each chunk boundary and in a carried line.
    const rows: string[] = []
    let size = 0
    let index = 0
    while (size < 12 * 1024 * 1024) {
      const length =
        index === 6
          ? 5_000_000
          : index % 7 === 0
            ? 1_500_000
            : (index * 7919) % 9000
      const pad = "x".repeat(length)
      const row =
        index % 3 === 0
          ? `{"type":"assistant","n":${index},"pad":"${pad}"}`
          : `{"type":"user","n":${index},"pad":"${pad}"}`
      rows.push(row)
      size += row.length + 1
      index += 1
    }
    const file = write(rows.join("\n") + "\n")
    const expected: string[] = []
    await forEachLine(file, (line) => {
      if (line.includes('"type":"assistant"')) expected.push(line)
    })
    const { lines } = await matching(file, '"type":"assistant"')
    expect(lines.length).toBe(expected.length)
    expect(lines).toEqual(expected)
  })

  it("leaves a line still being written and resumes after the last newline", async () => {
    const first = '{"type":"assistant","n":1}\n'
    const file = write(`${first}{"type":"assistant","n":`)
    const { lines, result } = await matching(file, '"type":"assistant"', {
      completeLinesOnly: true,
    })
    expect(lines).toEqual(['{"type":"assistant","n":1}'])
    expect(result).toBe(Buffer.byteLength(first))

    fs.appendFileSync(file, '2}\n{"type":"user"}\n', "utf8")
    const resumed = await matching(file, '"type":"assistant"', {
      from: result ?? 0,
      completeLinesOnly: true,
    })
    expect(resumed.lines).toEqual(['{"type":"assistant","n":2}'])
    expect(resumed.result).toBe(fs.statSync(file).size)
  })

  it("passes a last line without a newline unless asked to leave it", async () => {
    const file = write('{"a":1}\n{"type":"assistant","n":3}')
    const { lines } = await matching(file, '"type":"assistant"')
    expect(lines).toEqual(['{"type":"assistant","n":3}'])
  })

  it("reads only the tail when asked to", async () => {
    const file = write(
      '{"rate_limits":1}\n{"rate_limits":2}\n{"rate_limits":3}\n'
    )
    // 35 bytes from the end is one byte into the second row.
    const { lines } = await matching(file, '"rate_limits"', { fromEnd: 35 })
    // The cut row still holds the marker; the caller's parse drops it.
    expect(lines).toEqual(['"rate_limits":2}', '{"rate_limits":3}'])
  })

  it("answers null for a file that cannot be opened", async () => {
    const { lines, result } = await matching(
      path.join(dir, "missing.jsonl"),
      "x"
    )
    expect(result).toBeNull()
    expect(lines).toEqual([])
  })
})

describe("lastMatchingLines", () => {
  async function* chunked(body: string, size: number): AsyncGenerator<Buffer> {
    const bytes = Buffer.from(body, "utf8")
    for (let start = 0; start < bytes.length; start += size) {
      yield bytes.subarray(start, start + size)
    }
  }

  const body =
    [
      '{"a":1,"total":"first"}',
      '{"limits":"old"}',
      '{"a":2,"total":"Grüße","limits":"new"}',
      '{"other":true}',
      '{"a":3,"total":"last"}',
    ].join("\n") + "\n"

  it.each([1, 3, 7, 64, 4096])(
    "finds the newest line for each marker in %i-byte chunks",
    async (size) => {
      expect(
        await lastMatchingLines(chunked(body, size), [
          '"total"',
          '"limits"',
          '"missing"',
        ])
      ).toEqual([
        '{"a":3,"total":"last"}',
        '{"a":2,"total":"Grüße","limits":"new"}',
        null,
      ])
    }
  )

  it("takes a last line without a newline", async () => {
    expect(
      await lastMatchingLines(chunked('{"x":1}\n{"x":2}', 4), ['"x"'])
    ).toEqual(['{"x":2}'])
  })
})

describe("listJsonlFiles", () => {
  let root = ""

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-list-"))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("finds transcripts in nested folders and skips other files", async () => {
    const files = [
      path.join(root, "a", "one.jsonl"),
      path.join(root, "a", "sub", "two.jsonl"),
      path.join(root, "b", "three.jsonl"),
    ]
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, "{}\n")
    }
    fs.writeFileSync(path.join(root, "a", "notes.txt"), "")
    expect((await listJsonlFiles(root)).sort()).toEqual([...files].sort())
    expect(await listJsonlFiles(path.join(root, "missing"))).toEqual([])
  })
})
