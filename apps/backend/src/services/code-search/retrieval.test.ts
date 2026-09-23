import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { collectWorkspaceData } from "./retrieval"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true })
})
async function fixture(files: Record<string, string>) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "betterc0de-retrieval-"))
  )
  roots.push(root)
  // Bounded setup concurrency keeps this fixture useful on Windows as well.
  const entries = Object.entries(files)
  for (let i = 0; i < entries.length; i += 16)
    await Promise.all(
      entries.slice(i, i + 16).map(async ([name, content]) => {
        await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
        await fs.writeFile(path.join(root, name), content)
      })
    )
  return root
}
const signal = () => new AbortController().signal

describe("local code retrieval", () => {
  it("finds implementations among importers and excerpts their behavior", async () => {
    const source = [
      'import { ProviderHub } from "./hub"',
      ...Array.from({ length: 40 }, (_, i) => `// unrelated header ${i}`),
      "export function dispatchProviderTurn(hub: ProviderHub) {",
      "  return hub.dispatchTurn()",
      "}",
    ].join("\n")
    const root = await fixture({
      ...Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [
          `ui/component-${i}.ts`,
          `import { ProviderHub } from "./hub"\nexport const component${i} = true`,
        ])
      ),
      "lib/provider-events/dispatch.ts": source,
    })
    const result = await collectWorkspaceData({
      root,
      signal: signal(),
      search: {
        query: "Where does ProviderHub dispatch turns?",
        keywords: ["ProviderHub", "dispatch"],
      },
    })
    expect(result.coverage.incomplete).toBe(false)
    expect(result.candidates[0]?.path).toBe("lib/provider-events/dispatch.ts")
    const match = result.candidates[0]!
    expect(match.excerpt).toContain("return hub.dispatchTurn()")
    expect(match.excerpt).not.toContain("import {")
    expect(match.startLine).toBeGreaterThan(30)
    expect(
      source
        .split("\n")
        .slice(match.startLine - 1, match.endLine)
        .join("\n")
    ).toBe(match.excerpt)
  })

  it("deduplicates before the shortlist and prefers the matching canonical path", async () => {
    const source = "export function dispatchTurn() { return true }"
    const root = await fixture({
      ...Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [
          `copies/duplicate-${i}.ts`,
          source,
        ])
      ),
      "lib/provider-events.ts": source,
      "lib/different.ts": "export function dispatchTurn() { return false }",
    })
    const result = await collectWorkspaceData({
      root,
      signal: signal(),
      search: { query: "provider-events dispatchTurn" },
    })
    expect(result).toMatchObject({
      lexicalMatchCount: 82,
      uniqueMatchCount: 2,
      coverage: { duplicateFiles: 80 },
    })
    expect(result.candidates.map((candidate) => candidate.path).sort()).toEqual(
      ["lib/different.ts", "lib/provider-events.ts"]
    )
  })

  it("excludes shadow trees and nested Git roots but allows the selected worktree", async () => {
    const root = await fixture({
      ".git": "gitdir: elsewhere",
      "src/actual.ts": "dispatchTurn()",
      ".kilo/shadow/private.ts": "dispatchTurn()",
      ".worktrees/branch/private.ts": "dispatchTurn()",
      "nested/.git": "gitdir: elsewhere",
      "nested/private.ts": "dispatchTurn()",
      "submodule/.git/config": "[core]",
      "submodule/private.ts": "dispatchTurn()",
    })
    const result = await collectWorkspaceData({ root, signal: signal() })
    expect(result.files).toEqual(["src/actual.ts"])
    expect(result.coverage).toMatchObject({
      excludedWorktrees: 2,
      incomplete: false,
    })
    const selected = await collectWorkspaceData({
      root: await fs.realpath(path.join(root, "nested")),
      signal: signal(),
    })
    expect(selected.files).toEqual(["private.ts"])
  })

  it("restricts traversal to requested prefixes and keeps ancestor ignore rules", async () => {
    const root = await fixture({
      ".gitignore": "src/ignored.ts\n",
      "src/keep.ts": "dispatchTurn()",
      "src/ignored.ts": "dispatchTurn()",
      "other/.git": "gitdir: elsewhere",
      "other/private.ts": "dispatchTurn()",
      "src/unrequested/deep.ts": "dispatchTurn()",
      "packages/second.ts": "dispatchTurn(); // different",
    })
    const result = await collectWorkspaceData({
      root,
      signal: signal(),
      pathPrefixes: ["src/keep", "packages/"],
      search: { query: "dispatchTurn" },
    })
    expect(result.candidates.map((c) => c.path).sort()).toEqual([
      "packages/second.ts",
      "src/keep.ts",
    ])
    expect(result.coverage).toMatchObject({
      eligibleFiles: 2,
      scannedFiles: 2,
      excludedWorktrees: 0,
      incomplete: false,
    })
  })

  it("covers 1,400 files exceeding the former 8 MiB limit, including a late implementation", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 1399 }, (_, i) => [
        `components/file-${i}.ts`,
        `import { ProviderHub } from "./hub"\n// ${i} ${"padding ".repeat(1000)}\n`,
      ])
    )
    const root = await fixture({
      ...files,
      "lib/provider-events/dispatch.ts":
        "export function dispatchTurn(hub: ProviderHub) { return hub.dispatch() }",
    })
    const started = performance.now()
    const result = await collectWorkspaceData({
      root,
      signal: signal(),
      search: { query: "ProviderHub dispatchTurn provider-events" },
    })
    expect(result.coverage).toMatchObject({
      eligibleFiles: 1400,
      scannedFiles: 1400,
      incomplete: false,
    })
    expect(result.coverage.readBytes).toBeGreaterThan(8 * 1024 * 1024)
    expect(result.candidates[0]?.path).toBe("lib/provider-events/dispatch.ts")
    console.info(
      `Retrieval fixture: 1400 files, ${result.coverage.readBytes} bytes, ${Math.round(performance.now() - started)} ms`
    )
  }, 30_000)
})
