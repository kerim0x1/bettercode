import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { releaseTagsInPush } from "./pre-push.mjs"

const root = path.resolve(import.meta.dirname, "..")
const zeros = "0".repeat(40)
const sha = "a".repeat(40)

test("only release tags trigger the pre-push release check", () => {
  const input = [
    `refs/heads/main ${sha} refs/heads/main ${"b".repeat(40)}`,
    `refs/tags/v0.1.0-beta.3 ${sha} refs/tags/v0.1.0-beta.3 ${zeros}`,
    `refs/tags/nightly ${sha} refs/tags/nightly ${zeros}`,
    `refs/tags/v1.2 ${sha} refs/tags/v1.2 ${zeros}`,
    "",
  ].join("\n")
  assert.deepEqual(releaseTagsInPush(input), [{ tag: "v0.1.0-beta.3", sha }])
})

test("deleting a release tag is not a release", () => {
  assert.deepEqual(
    releaseTagsInPush(`(delete) ${zeros} refs/tags/v1.0.0 ${sha}\n`),
    []
  )
})

test("Windows line endings and build metadata are accepted", () => {
  assert.deepEqual(
    releaseTagsInPush(`refs/tags/v2.0.0+build.5 ${sha} refs/tags/v2.0.0+build.5 ${zeros}\r\n`),
    [{ tag: "v2.0.0+build.5", sha }]
  )
})

test("the husky hook runs the pre-push script with husky disabled for nested installs", () => {
  const hook = fs.readFileSync(path.join(root, ".husky", "pre-push"), "utf8")
  // release:check runs `npm ci`, whose prepare script would otherwise
  // rewrite the hook files this shell is still executing.
  assert.match(hook, /HUSKY=0 node scripts\/pre-push\.mjs/)
  assert.doesNotMatch(hook, /\r/, "the hook must keep LF line endings to run under sh")
})
