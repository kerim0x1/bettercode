import assert from "node:assert/strict"
import test from "node:test"

import { extractReleaseNotes } from "./release-notes.mjs"

const changelog = `# Changelog

## [Unreleased]

### Added
- Something in progress.

## [0.1.0-beta.3] - 2026-10-01

### Fixed
- The arm64 disk image contains an arm64 app.

## [0.1.0-beta.2] - 2026-09-22

- Earlier notes.
`

test("the section for a version runs up to the next heading", () => {
  assert.equal(
    extractReleaseNotes(changelog, "0.1.0-beta.3"),
    "### Fixed\n- The arm64 disk image contains an arm64 app."
  )
  assert.equal(extractReleaseNotes(changelog, "v0.1.0-beta.2"), "- Earlier notes.")
})

test("a missing or empty section yields null", () => {
  assert.equal(extractReleaseNotes(changelog, "0.2.0"), null)
  assert.equal(extractReleaseNotes("## [1.0.0]\n\n## [0.9.0]\n- x\n", "1.0.0"), null)
})

test("version dots are literal, so 0.1.0 does not match 0x1y0", () => {
  assert.equal(extractReleaseNotes("## [0x1y0]\n- wrong\n", "0.1.0"), null)
})
