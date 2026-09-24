#!/usr/bin/env node

// Collects the per-platform installer artifacts of a release run into one
// directory that can be uploaded to a GitHub release as-is, and refuses when
// the set is incomplete or inconsistent.
//
//   node scripts/assemble-release.mjs <artifacts-dir> <output-dir> [--android]
//
// <artifacts-dir> holds one sub-directory per build job (the layout
// actions/download-artifact produces). The script:
//   - fails when two jobs produced a file with the same name. The two macOS
//     runners each used to emit both architectures' file names from their
//     single-arch app, and the last upload won: 0.1.0-beta.2 shipped an
//     Intel build as `arm64.dmg`.
//   - merges the per-arch latest-mac.yml files. electron-builder writes one
//     per run, and each lists only that runner's architecture; published
//     unmerged, one Mac architecture would be offered the other's update.
//   - checks every file listed in latest*.yml exists with the recorded
//     sha512 and size, so the update feed cannot point at a different binary.
//   - requires the installers users download for every supported target.
//   - takes the phone app only as BetterC0de-Remote-<version>.apk whose
//     signers present the pinned release certificate
//     (apps/mobile/signing/android-release.json). A test-key build, or one
//     of another version, is refused by name. `--android` makes the APK
//     required.
//   - writes a single SHA256SUMS.txt computed from the final files.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import YAML from "yaml"

import { apkSigners } from "./android-apk.mjs"
import { apkFileName, readReleaseCertificate } from "./mobile-android.mjs"

export const REQUIRED_ASSETS = [
  { description: "Windows x64 installer", pattern: /^BetterC0de-Setup-.+\.exe$/ },
  { description: "Windows update metadata", pattern: /^latest\.yml$/ },
  { description: "macOS x64 disk image", pattern: /^BetterC0de-(?!.*arm64).+\.dmg$/ },
  { description: "macOS arm64 disk image", pattern: /^BetterC0de-.+-arm64\.dmg$/ },
  { description: "macOS x64 update archive", pattern: /^BetterC0de-(?!.*arm64).+-mac\.zip$/ },
  { description: "macOS arm64 update archive", pattern: /^BetterC0de-.+-arm64-mac\.zip$/ },
  { description: "macOS update metadata", pattern: /^latest-mac\.yml$/ },
  { description: "Linux AppImage", pattern: /^BetterC0de-.+\.AppImage$/ },
  { description: "Linux .deb", pattern: /^betterc0de_.+_amd64\.deb$/ },
  { description: "Linux .rpm", pattern: /^betterc0de-.+\.x86_64\.rpm$/ },
  { description: "Linux tarball", pattern: /^betterc0de-.+\.tar\.gz$/ },
  { description: "Linux update metadata", pattern: /^latest-linux\.yml$/ },
]

const MERGED_METADATA = new Set(["latest-mac.yml"])
// Per-job checksum files are replaced by one computed from the final set.
const PER_JOB_CHECKSUMS = /^SHA256SUMS(?:-.+)?\.txt$/
const CHECKSUMMED = /\.(?:exe|dmg|zip|AppImage|deb|rpm|gz|apk)$/i

/** Groups files by name across job directories: name → [absolute paths]. */
export function collectArtifacts(artifactsDir) {
  const byName = new Map()
  for (const job of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
    if (!job.isDirectory()) continue
    for (const entry of fs.readdirSync(path.join(artifactsDir, job.name), { withFileTypes: true })) {
      if (!entry.isFile() || PER_JOB_CHECKSUMS.test(entry.name)) continue
      const file = path.join(artifactsDir, job.name, entry.name)
      byName.set(entry.name, [...(byName.get(entry.name) ?? []), file])
    }
  }
  return byName
}

export function findCollisions(byName) {
  return [...byName.entries()]
    .filter(([name, files]) => files.length > 1 && !MERGED_METADATA.has(name))
    .map(([name, files]) => ({ name, files }))
}

/** Merges electron-builder update-info documents from single-arch builds. */
export function mergeUpdateInfo(documents) {
  if (documents.length === 0) throw new Error("No update metadata to merge")
  const versions = new Set(documents.map((document) => document.version))
  if (versions.size !== 1) {
    throw new Error(`Update metadata disagrees on the version: ${[...versions].join(", ")}`)
  }

  const files = []
  for (const document of documents) {
    for (const file of document.files ?? []) {
      const existing = files.find((candidate) => candidate.url === file.url)
      if (!existing) files.push(file)
      else if (existing.sha512 !== file.sha512) {
        throw new Error(`Two builds list ${file.url} with different contents`)
      }
    }
  }
  files.sort((left, right) => left.url.localeCompare(right.url))

  // `path`/`sha512` at the top level are the pre-`files` format. Point them at
  // the x64 archive, which also runs on Apple Silicon through Rosetta.
  const legacy =
    files.find((file) => file.url.endsWith(".zip") && !/arm64/.test(file.url)) ??
    files.find((file) => file.url.endsWith(".zip")) ??
    files[0]
  const releaseDate = documents
    .map((document) => document.releaseDate)
    .filter(Boolean)
    .sort()
    .at(-1)

  return {
    ...documents[0],
    files,
    path: legacy.url,
    sha512: legacy.sha512,
    ...(releaseDate ? { releaseDate } : {}),
  }
}

export function requiredAssetGaps(names, required = REQUIRED_ASSETS) {
  return required
    .filter(({ pattern }) => !names.some((name) => pattern.test(name)))
    .map(({ description }) => description)
}

function fileSha512(file) {
  return createHash("sha512").update(fs.readFileSync(file)).digest("base64")
}

function fileSha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

export function verifyUpdateInfo(metadataName, document, outputDir) {
  const problems = []
  for (const file of document.files ?? []) {
    const target = path.join(outputDir, file.url)
    if (!fs.existsSync(target)) {
      problems.push(`${metadataName} lists ${file.url}, which is not in the release`)
      continue
    }
    if (file.size !== undefined && fs.statSync(target).size !== file.size) {
      problems.push(`${metadataName}: ${file.url} size does not match`)
    }
    if (fileSha512(target) !== file.sha512) {
      problems.push(`${metadataName}: ${file.url} sha512 does not match the file`)
    }
  }
  return problems
}

/**
 * What keeps the phone app's APK out of a release. The name decides which
 * build it is (only the release-signed one has no suffix); the certificates
 * in its APK Signing Block must be the pinned release certificate. Whether
 * the signatures are valid was checked with apksigner when it was built.
 */
export function androidApkProblems(outputDir, names, { version, required, releaseCertificate }) {
  const expected = apkFileName(version, "release")
  const problems = []
  for (const name of names.filter((candidate) => /\.apk$/i.test(candidate))) {
    if (name !== expected) {
      problems.push(`${name} cannot be published: a release carries only ${expected}, signed with the release key`)
      continue
    }
    const signers = apkSigners(fs.readFileSync(path.join(outputDir, name)))
    if (signers.length === 0) {
      problems.push(`${name} has no APK Signature Scheme v2 or v3 signature`)
    } else if (!releaseCertificate) {
      problems.push(`${name}: no release certificate is pinned in apps/mobile/signing/android-release.json`)
    } else {
      for (const { scheme, certificates } of signers) {
        if (certificates[0] !== releaseCertificate.sha256) {
          problems.push(
            `${name}: its ${scheme} signer presents ${certificates[0] ?? "no certificate"}, not the release certificate ${releaseCertificate.sha256}`
          )
        }
      }
    }
  }
  if (required && !names.includes(expected)) problems.push(`missing: Android app (${expected})`)
  return problems
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")).version
}

export function assembleRelease(
  artifactsDir,
  outputDir,
  { android = { required: false, version: packageVersion(), releaseCertificate: readReleaseCertificate() } } = {}
) {
  const byName = collectArtifacts(artifactsDir)
  const collisions = findCollisions(byName)
  if (collisions.length > 0) {
    throw new Error(
      `Several build jobs produced the same file name; publishing would keep only one of them:\n${collisions
        .map(({ name, files }) => `  ${name}: ${files.map((file) => path.relative(artifactsDir, file)).join(", ")}`)
        .join("\n")}`
    )
  }

  fs.rmSync(outputDir, { recursive: true, force: true })
  fs.mkdirSync(outputDir, { recursive: true })
  for (const [name, files] of byName) {
    if (MERGED_METADATA.has(name)) {
      const merged = mergeUpdateInfo(files.map((file) => YAML.parse(fs.readFileSync(file, "utf8"))))
      fs.writeFileSync(path.join(outputDir, name), YAML.stringify(merged, { lineWidth: 0 }))
    } else {
      fs.copyFileSync(files[0], path.join(outputDir, name))
    }
  }

  const names = fs.readdirSync(outputDir).sort()
  const problems = requiredAssetGaps(names).map((description) => `missing: ${description}`)
  problems.push(...androidApkProblems(outputDir, names, android))
  for (const name of names.filter((candidate) => /^latest.*\.yml$/.test(candidate))) {
    const document = YAML.parse(fs.readFileSync(path.join(outputDir, name), "utf8"))
    problems.push(...verifyUpdateInfo(name, document, outputDir))
  }
  if (problems.length > 0) {
    throw new Error(`The release is not publishable:\n${problems.map((problem) => `  ${problem}`).join("\n")}`)
  }

  const sums = names
    .filter((name) => CHECKSUMMED.test(name))
    .map((name) => `${fileSha256(path.join(outputDir, name))}  ${name}`)
  fs.writeFileSync(path.join(outputDir, "SHA256SUMS.txt"), `${sums.join("\n")}\n`)
  return fs.readdirSync(outputDir).sort()
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const entry = path.resolve(process.argv[1])
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry
}

if (isEntryPoint()) {
  const args = process.argv.slice(2)
  const [artifactsDir, outputDir] = args.filter((arg) => !arg.startsWith("--"))
  const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--android")
  if (!artifactsDir || !outputDir || unknown.length > 0) {
    process.stderr.write("Usage: node scripts/assemble-release.mjs <artifacts-dir> <output-dir> [--android]\n")
    process.exit(2)
  }
  try {
    const android = {
      required: args.includes("--android"),
      version: packageVersion(),
      releaseCertificate: readReleaseCertificate(),
    }
    const files = assembleRelease(path.resolve(artifactsDir), path.resolve(outputDir), { android })
    process.stdout.write(`Release assembled (${files.length} files):\n${files.map((file) => `  ${file}`).join("\n")}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
