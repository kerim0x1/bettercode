import assert from "node:assert/strict"
import test from "node:test"

import {
  chunk,
  normalizeBase,
  selectFormattableFiles,
} from "./check-format.mjs"

test("format gate selects only formatted source types, once, in stable order", () => {
  assert.deepEqual(
    selectFormattableFiles([
      "apps/ui/src/b.tsx",
      "apps/backend/src/a.ts",
      "apps/backend/src/a.ts",
      "scripts/release-check.mjs",
      "README.md",
      "",
      "   ",
      "apps\\ui\\src\\windows.ts",
      "package.json",
    ]),
    ["apps/backend/src/a.ts", "apps/ui/src/b.tsx", "apps/ui/src/windows.ts"]
  )
})

test("format gate batches files so Windows command lines stay under the limit", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([], 3), [])
  assert.throws(() => chunk([1], 0), RangeError)
})

test("format gate ignores empty and all-zero base revisions", () => {
  // GitHub reports 0000000000000000000000000000000000000000 as `before` for
  // the first push of a branch; treating it as a commit would fail the run.
  assert.equal(normalizeBase(undefined), null)
  assert.equal(normalizeBase(""), null)
  assert.equal(normalizeBase("0000000000000000000000000000000000000000"), null)
  assert.equal(normalizeBase(" abc123 "), "abc123")
  assert.equal(normalizeBase("HEAD^1"), "HEAD^1")
})
