#!/usr/bin/env node

// Prints (or writes) the CHANGELOG.md section for one version, and fails
// when there is none. The release workflow uses the section as the GitHub
// release notes, and the pre-push hook refuses a release tag without one.
//
//   node scripts/release-notes.mjs <version> [output-file]

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(import.meta.dirname, "..")

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The body of `## [<version>]` up to the next `## ` heading, or null. */
export function extractReleaseNotes(changelog, version) {
  const heading = new RegExp(`^## \\[${escapeRegExp(version.replace(/^v/, ""))}\\](?:[^\\n]*)$`, "m")
  const match = heading.exec(changelog)
  if (!match) return null
  const rest = changelog.slice(match.index + match[0].length)
  const next = rest.search(/^## /m)
  const body = (next < 0 ? rest : rest.slice(0, next)).trim()
  return body || null
}

export function readReleaseNotes(version) {
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")
  return extractReleaseNotes(changelog, version)
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const entry = path.resolve(process.argv[1])
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry
}

if (isEntryPoint()) {
  const [version, outputFile] = process.argv.slice(2)
  if (!version) {
    process.stderr.write("Usage: node scripts/release-notes.mjs <version> [output-file]\n")
    process.exit(2)
  }
  const notes = readReleaseNotes(version)
  if (!notes) {
    process.stderr.write(
      `CHANGELOG.md has no entry for ${version}. Add a "## [${version.replace(/^v/, "")}] - YYYY-MM-DD" section before releasing.\n`
    )
    process.exit(1)
  }
  if (outputFile) fs.writeFileSync(outputFile, `${notes}\n`)
  else process.stdout.write(`${notes}\n`)
}
