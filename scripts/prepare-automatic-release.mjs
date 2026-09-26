#!/usr/bin/env node

// Prepare a versioned commit after green CI on main. The protected main branch
// only accepts pull requests, so the workflow pushes a tag pointing at this
// commit without moving main, then explicitly dispatches Release.

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import mobileVersion from "../apps/mobile/config/version.cjs"
import { extractReleaseNotes } from "./release-notes.mjs"

const root = path.resolve(import.meta.dirname, "..")
const { androidVersionCode, parseReleaseVersion } = mobileVersion

export const MANIFEST_PATHS = [
  "package.json",
  "apps/backend/package.json",
  "apps/mobile/package.json",
  "apps/shell/package.json",
  "apps/ui/package.json",
  "packages/schema/package.json",
  "packages/util/package.json",
]

const MAX_COMPONENT = 99
const MAX_MAJOR = 209
const MAINTENANCE_NOTES =
  "### Changed\n\n- Maintenance changes merged into main."

export function latestReleaseTag(tags) {
  let latest = null
  let latestCode = -1
  for (const tag of tags) {
    if (!tag.startsWith("v")) continue
    try {
      const code = androidVersionCode(tag.slice(1))
      if (code > latestCode) {
        latest = tag
        latestCode = code
      }
    } catch {
      // Ignore tags that are not BetterC0de release versions.
    }
  }
  return latest
}

export function nextAutoReleaseVersion(version) {
  const parsed = parseReleaseVersion(version)
  let { major, minor, patch } = parsed
  const stage = parsed.prerelease
  if (stage && stage.number < MAX_COMPONENT) {
    return (
      String(major) +
      "." +
      String(minor) +
      "." +
      String(patch) +
      "-" +
      stage.label +
      "." +
      String(stage.number + 1)
    )
  }
  if (patch < MAX_COMPONENT) patch += 1
  else if (minor < MAX_COMPONENT) {
    minor += 1
    patch = 0
  } else {
    major += 1
    minor = 0
    patch = 0
  }
  if (major > MAX_MAJOR) {
    throw new Error(
      "The Android versionCode range is exhausted; choose a new version scheme."
    )
  }
  const base = String(major) + "." + String(minor) + "." + String(patch)
  return stage ? base + "-" + stage.label + ".0" : base
}

function bulletEntries(notes) {
  const entries = []
  let section = ""
  let lines = null
  const flush = () => {
    if (lines) entries.push({ section, text: lines.join("\n").trim() })
    lines = null
  }
  for (const line of notes.split("\n")) {
    if (line.startsWith("## ")) {
      flush()
      section = ""
    } else if (line.startsWith("### ")) {
      flush()
      section = line.trim()
    } else if (line.startsWith("- ")) {
      flush()
      lines = [line]
    } else if (lines) {
      lines.push(line)
    }
  }
  flush()
  return entries
}

export function notesSincePreviousRelease(pending, previousNotes) {
  if (!previousNotes) return pending.trim()
  const currentEntries = bulletEntries(pending)
  if (currentEntries.length === 0) return pending.trim()
  const published = new Set(
    bulletEntries(previousNotes).map(({ text }) => text.replace(/\s+/g, " "))
  )
  const added = currentEntries.filter(
    ({ text }) => !published.has(text.replace(/\s+/g, " "))
  )
  const sections = []
  let lastSection = null
  for (const entry of added) {
    if (entry.section && entry.section !== lastSection) {
      sections.push(entry.section)
    }
    sections.push(entry.text)
    lastSection = entry.section
  }
  return sections.join("\n\n")
}

function releasedHistory(changelog) {
  const source = changelog.replaceAll("\r\n", "\n")
  const unreleased = /^## \[Unreleased\][^\n]*$/m.exec(source)
  if (!unreleased)
    throw new Error("The previous tag has no Unreleased heading.")
  const followingHeading = /^## \[[^\]]+\]/gm
  followingHeading.lastIndex = unreleased.index + unreleased[0].length
  const next = followingHeading.exec(source)
  if (!next) throw new Error("The previous tag has no release history.")
  return source.slice(next.index).trim()
}

export function stageReleaseChangelog(
  changelog,
  version,
  date,
  previousNotes = null,
  previousChangelog = null
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Release date must use YYYY-MM-DD.")
  }
  const eol = changelog.includes("\r\n") ? "\r\n" : "\n"
  const source = changelog.replaceAll("\r\n", "\n")
  const unreleased = /^## \[Unreleased\][^\n]*$/gm
  const heading = unreleased.exec(source)
  if (!heading || unreleased.exec(source)) {
    throw new Error("CHANGELOG.md must have exactly one Unreleased heading.")
  }
  const afterHeading = heading.index + heading[0].length
  const followingHeading = /^## \[[^\]]+\]/gm
  followingHeading.lastIndex = afterHeading
  const next = followingHeading.exec(source)
  if (!next) throw new Error("CHANGELOG.md needs a previous version section.")

  const publishedNotes = previousChangelog
    ? releasedHistory(previousChangelog)
    : previousNotes
  const pending = notesSincePreviousRelease(
    source.slice(afterHeading, next.index),
    publishedNotes
  )
  const before = source.slice(0, heading.index)
  const rest = source.slice(next.index).trimEnd()
  const history = previousChangelog ? releasedHistory(previousChangelog) : rest
  const targetHeading = "## [" + version + "]"
  let result

  if (
    rest.startsWith(targetHeading + " - ") ||
    rest.startsWith(targetHeading + "\n")
  ) {
    // A maintainer may already have bumped the manifests and written notes.
    // Fold any subsequent Unreleased notes into that still-untagged version.
    const headingEnd = rest.indexOf("\n")
    if (headingEnd < 0)
      throw new Error("The existing release heading has no body.")
    const laterHeading = /^## \[[^\]]+\]/gm
    laterHeading.lastIndex = headingEnd + 1
    const later = laterHeading.exec(rest)
    const existing = notesSincePreviousRelease(
      rest.slice(headingEnd + 1, later?.index ?? rest.length),
      publishedNotes
    )
    const body =
      [pending, existing].filter(Boolean).join("\n\n") || MAINTENANCE_NOTES
    const tail = previousChangelog
      ? "\n\n" + history
      : later
        ? "\n\n" + rest.slice(later.index)
        : ""
    result =
      before +
      "## [Unreleased]\n\n" +
      rest.slice(0, headingEnd) +
      "\n\n" +
      body +
      tail +
      "\n"
  } else {
    if (source.includes(targetHeading)) {
      throw new Error(
        "CHANGELOG.md already has a nonadjacent section for " + version + "."
      )
    }
    result =
      before +
      "## [Unreleased]\n\n" +
      targetHeading +
      " - " +
      date +
      "\n\n" +
      (pending || MAINTENANCE_NOTES) +
      "\n\n" +
      history +
      "\n"
  }
  if (!extractReleaseNotes(result, version)) {
    throw new Error("The prepared release has no changelog notes.")
  }
  return result.replaceAll("\n", eol)
}

export function planAutomaticRelease({
  manifests,
  lock,
  changelog,
  existingTags,
  previousNotes = null,
  previousChangelog = null,
  date,
}) {
  const current = manifests["package.json"]?.version
  parseReleaseVersion(current)
  if (lock.version !== current) {
    throw new Error("The package lock root version differs from package.json.")
  }
  for (const manifestPath of MANIFEST_PATHS) {
    const manifest = manifests[manifestPath]
    if (!manifest || manifest.version !== current) {
      throw new Error(manifestPath + " does not match the root version.")
    }
    const lockKey =
      manifestPath === "package.json"
        ? ""
        : path.dirname(manifestPath).replaceAll("\\", "/")
    if (lock.packages?.[lockKey]?.version !== current) {
      throw new Error(
        "package-lock.json entry " + lockKey + " has another version."
      )
    }
  }

  const latestTag = latestReleaseTag(existingTags)
  const target =
    latestTag &&
    androidVersionCode(current) <= androidVersionCode(latestTag.slice(1))
      ? nextAutoReleaseVersion(latestTag.slice(1))
      : current
  const tag = "v" + target
  if (existingTags.includes(tag)) {
    throw new Error(
      tag + " already exists; a failed release must be retried, not replaced."
    )
  }
  const targetCode = androidVersionCode(target)
  for (const previousTag of existingTags) {
    let previousCode
    try {
      previousCode = androidVersionCode(previousTag.replace(/^v/, ""))
    } catch {
      // Unrelated tags do not participate in the release version sequence.
      continue
    }
    if (previousCode >= targetCode) {
      throw new Error(tag + " does not advance past " + previousTag + ".")
    }
  }

  const nextManifests = Object.fromEntries(
    MANIFEST_PATHS.map((manifestPath) => [
      manifestPath,
      { ...manifests[manifestPath], version: target },
    ])
  )
  const nextLock = structuredClone(lock)
  nextLock.version = target
  for (const manifestPath of MANIFEST_PATHS) {
    const lockKey =
      manifestPath === "package.json"
        ? ""
        : path.dirname(manifestPath).replaceAll("\\", "/")
    nextLock.packages[lockKey].version = target
  }
  return {
    version: target,
    tag,
    manifests: nextManifests,
    lock: nextLock,
    changelog: stageReleaseChangelog(
      changelog,
      target,
      date,
      previousNotes,
      previousChangelog
    ),
  }
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"))
}

function writeJson(relativePath, value) {
  const file = path.join(root, relativePath)
  const eol = fs.readFileSync(file, "utf8").includes("\r\n") ? "\r\n" : "\n"
  fs.writeFileSync(
    file,
    JSON.stringify(value, null, 2).replaceAll("\n", eol) + eol
  )
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const entry = path.resolve(process.argv[1])
  return process.platform === "win32"
    ? self.toLowerCase() === entry.toLowerCase()
    : self === entry
}

if (isEntryPoint()) {
  const manifests = Object.fromEntries(
    MANIFEST_PATHS.map((manifestPath) => [manifestPath, readJson(manifestPath)])
  )
  const existingTags = execFileSync("git", ["tag", "--list", "v*"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const latestTag = latestReleaseTag(existingTags)
  const previousChangelog = latestTag
    ? execFileSync("git", ["show", latestTag + ":CHANGELOG.md"], {
        cwd: root,
        encoding: "utf8",
      })
    : null
  const plan = planAutomaticRelease({
    manifests,
    lock: readJson("package-lock.json"),
    changelog: fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
    existingTags,
    previousChangelog,
    date: new Date().toISOString().slice(0, 10),
  })
  for (const manifestPath of MANIFEST_PATHS) {
    writeJson(manifestPath, plan.manifests[manifestPath])
  }
  writeJson("package-lock.json", plan.lock)
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), plan.changelog)
  process.stdout.write(plan.tag + "\n")
}
