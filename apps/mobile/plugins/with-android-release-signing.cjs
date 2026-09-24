"use strict"

// Signs Android release builds with the key given in the environment, and
// makes sure a release build cannot be signed with anything else.
//
// The generated android/app/build.gradle signs `release` with the debug
// keystore that ships in every React Native template, whose password is
// public. This plugin gives `release` its own signing config and fails any
// release packaging task when that config is incomplete, so a debug-signed
// APK can never come out of a release build by accident:
//
//   BETTERC0DE_ANDROID_KEYSTORE            path to the keystore (.p12 or .jks)
//   BETTERC0DE_ANDROID_KEYSTORE_PASSWORD
//   BETTERC0DE_ANDROID_KEY_ALIAS
//   BETTERC0DE_ANDROID_KEY_PASSWORD
//
// scripts/mobile-android.mjs sets them, either to the BetterC0de release key
// or to a throwaway test key. Debug builds (expo run:android) are unchanged.
//
// The edit is anchored on the template's exact structure: if a template
// update moves the blocks, prebuild fails here instead of silently leaving
// the debug signature in place.

const { withAppBuildGradle } = require("expo/config-plugins")

const MARKER = "betterc0de-release-signing"
const SIGNING_ENV = [
  "BETTERC0DE_ANDROID_KEYSTORE",
  "BETTERC0DE_ANDROID_KEYSTORE_PASSWORD",
  "BETTERC0DE_ANDROID_KEY_ALIAS",
  "BETTERC0DE_ANDROID_KEY_PASSWORD",
]

/** Index just past the brace that closes the one opened at `open`, skipping strings and comments. */
function matchingBrace(source, open) {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (char === "/" && next === "/") {
      index = source.indexOf("\n", index)
      if (index === -1) break
    } else if (char === "/" && next === "*") {
      index = source.indexOf("*/", index + 2) + 1
      if (index === 0) break
    } else if (char === '"' || char === "'") {
      for (index += 1; index < source.length && source[index] !== char; index += 1) {
        if (source[index] === "\\") index += 1
      }
    } else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  throw new Error("android/app/build.gradle has an unbalanced block.")
}

/** The one `name { … }` block between `from` and `to`; anything else is an unexpected template. */
function uniqueBlock(source, name, from, to) {
  const pattern = new RegExp(`(^|\\n)([ \\t]*)${name}[ \\t]*\\{`, "g")
  const matches = []
  for (const match of source.slice(from, to).matchAll(pattern)) {
    const start = from + match.index + match[1].length
    const open = start + match[0].length - match[1].length - 1
    matches.push({ start, open, end: matchingBrace(source, open), indent: match[2] })
  }
  // Only direct children count: a nested block of the same name is not a match.
  const direct = matches.filter(
    (candidate) => !matches.some((other) => other !== candidate && other.open < candidate.open && candidate.end <= other.end)
  )
  if (direct.length !== 1) {
    throw new Error(
      `${MARKER}: expected one "${name} { … }" block in android/app/build.gradle, found ${direct.length}. ` +
        "The React Native template changed; update apps/mobile/plugins/with-android-release-signing.cjs."
    )
  }
  return direct[0]
}

function releaseSigningConfig(indent, eol) {
  const inner = `${indent}    `
  return [
    `${indent}release {`,
    `${inner}// ${MARKER}: see apps/mobile/plugins/with-android-release-signing.cjs`,
    `${inner}def releaseKeystore = System.getenv("BETTERC0DE_ANDROID_KEYSTORE")`,
    `${inner}if (releaseKeystore) {`,
    `${inner}    storeFile file(releaseKeystore)`,
    `${inner}    storePassword System.getenv("BETTERC0DE_ANDROID_KEYSTORE_PASSWORD")`,
    `${inner}    keyAlias System.getenv("BETTERC0DE_ANDROID_KEY_ALIAS")`,
    `${inner}    keyPassword System.getenv("BETTERC0DE_ANDROID_KEY_PASSWORD")`,
    `${inner}}`,
    `${indent}}`,
  ].join(eol)
}

const RELEASE_GUARD = `
// ${MARKER}: without a complete signing config a release APK would be
// unsigned, or signed with the template's public debug key. Refuse it.
gradle.taskGraph.whenReady { graph ->
    def releaseTasks = graph.allTasks.findAll { task ->
        task.project == project && task.name ==~ /(assemble|bundle|package|install)Release/
    }
    if (releaseTasks.isEmpty()) {
        return
    }
    def missing = [${SIGNING_ENV.map((name) => `"${name}"`).join(", ")}].findAll { !System.getenv(it) }
    if (!missing.isEmpty()) {
        throw new GradleException("Refusing to build a release without a signing key (missing: \${missing.join(', ')}). Build it with: node scripts/mobile-android.mjs build")
    }
    def keystore = file(System.getenv("BETTERC0DE_ANDROID_KEYSTORE"))
    if (!keystore.isFile()) {
        throw new GradleException("BETTERC0DE_ANDROID_KEYSTORE is not a file: \${keystore}")
    }
}
`

function applyReleaseSigning(gradle) {
  if (gradle.includes(MARKER)) return gradle
  // Templates are extracted with LF, but a checkout or an editor may have
  // converted the file; keep whatever it uses.
  const eol = gradle.includes("\r\n") ? "\r\n" : "\n"

  const android = uniqueBlock(gradle, "android", 0, gradle.length)
  const signingConfigs = uniqueBlock(gradle, "signingConfigs", android.open + 1, android.end - 1)
  const debugSigning = uniqueBlock(gradle, "debug", signingConfigs.open + 1, signingConfigs.end - 1)
  uniqueBlockAbsent(gradle, "release", signingConfigs.open + 1, signingConfigs.end - 1)

  const buildTypes = uniqueBlock(gradle, "buildTypes", android.open + 1, android.end - 1)
  const releaseBuildType = uniqueBlock(gradle, "release", buildTypes.open + 1, buildTypes.end - 1)
  const debugSignature = /(\n[ \t]*signingConfig[ \t]+)signingConfigs\.debug([ \t]*\r?\n)/g
  const releaseBody = gradle.slice(releaseBuildType.open, releaseBuildType.end)
  const signatures = [...releaseBody.matchAll(debugSignature)]
  if (signatures.length !== 1) {
    throw new Error(
      `${MARKER}: expected the release build type to use "signingConfig signingConfigs.debug" once, found ${signatures.length}.`
    )
  }
  const signedRelease = releaseBody.replace(debugSignature, "$1signingConfigs.release$2")

  // Apply the later edit first so the earlier offsets stay valid.
  let result =
    gradle.slice(0, releaseBuildType.open) + signedRelease + gradle.slice(releaseBuildType.end)
  result =
    result.slice(0, debugSigning.end) +
    eol +
    releaseSigningConfig(debugSigning.indent, eol) +
    result.slice(debugSigning.end)
  return `${result.replace(/\s*$/, eol)}${RELEASE_GUARD.replaceAll("\n", eol)}`
}

function uniqueBlockAbsent(source, name, from, to) {
  if (new RegExp(`(^|\\n)[ \\t]*${name}[ \\t]*\\{`).test(source.slice(from, to))) {
    throw new Error(`${MARKER}: android/app/build.gradle already defines signingConfigs.${name}.`)
  }
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== "groovy") {
      throw new Error(`${MARKER}: expected a Groovy build.gradle, got ${modConfig.modResults.language}.`)
    }
    modConfig.modResults.contents = applyReleaseSigning(modConfig.modResults.contents)
    return modConfig
  })
}

module.exports = withAndroidReleaseSigning
module.exports.applyReleaseSigning = applyReleaseSigning
module.exports.SIGNING_ENV = SIGNING_ENV
