"use strict"

// BetterC0de Remote ships with every desktop release and carries the same
// version (the root package.json). The stores accept less than semver:
//
// - iOS `CFBundleShortVersionString` allows one to three integers only, so
//   every prerelease of X.Y.Z is uploaded as X.Y.Z; EAS numbers the builds.
// - Android `versionCode` is a single integer that must grow with every
//   release a device should accept as an update, including prereleases:
//
//     versionCode = major·10⁷ + minor·10⁵ + patch·10³ + stage
//     stage       = 100 + n (alpha.n) | 300 + n (beta.n) | 500 + n (rc.n) | 900 (final)
//
//   0.1.0-beta.2 → 100302, 0.1.0 → 100900, 1.2.3 → 10203900. With minor,
//   patch and n ≤ 99 and major ≤ 209, the largest code (2 099 999 900) stays
//   below Google Play's ceiling of 2 100 000 000.
//
// Anything else (other prerelease labels, build metadata, leading zeros) is
// rejected rather than mapped, so a release can never go out with a code
// that sorts before an earlier one.

const STAGE_BASE = { alpha: 100, beta: 300, rc: 500 }
const FINAL_STAGE = 900
const MAX_MAJOR = 209
const MAX_COMPONENT = 99
const MAX_VERSION_CODE = 2_100_000_000

const NUMBER = "(0|[1-9]\\d*)"
const RELEASE_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(alpha|beta|rc)\\.${NUMBER})?$`)

/** @param {unknown} version */
function parseReleaseVersion(version) {
  const text = String(version ?? "").trim()
  const match = RELEASE_VERSION.exec(text)
  if (!match) {
    throw new Error(
      `Unsupported release version "${text}": use X.Y.Z or X.Y.Z-alpha.N, -beta.N or -rc.N.`
    )
  }
  const [, major, minor, patch, label, number] = match
  const parsed = {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: label ? { label, number: Number(number) } : null,
  }
  if (parsed.major > MAX_MAJOR) {
    throw new Error(`Release version "${text}": the major version must be at most ${MAX_MAJOR}.`)
  }
  for (const [name, value] of [
    ["minor", parsed.minor],
    ["patch", parsed.patch],
    ["prerelease number", parsed.prerelease?.number ?? 0],
  ]) {
    if (value > MAX_COMPONENT) {
      throw new Error(`Release version "${text}": the ${name} must be at most ${MAX_COMPONENT}.`)
    }
  }
  return parsed
}

/** @param {unknown} version */
function androidVersionCode(version) {
  const { major, minor, patch, prerelease } = parseReleaseVersion(version)
  const stage = prerelease ? STAGE_BASE[prerelease.label] + prerelease.number : FINAL_STAGE
  return major * 10_000_000 + minor * 100_000 + patch * 1_000 + stage
}

/** @param {unknown} version */
function iosMarketingVersion(version) {
  const { major, minor, patch } = parseReleaseVersion(version)
  return `${major}.${minor}.${patch}`
}

module.exports = {
  MAX_VERSION_CODE,
  androidVersionCode,
  iosMarketingVersion,
  parseReleaseVersion,
}
