#!/usr/bin/env node

// Generates the native projects of the mobile app, apps/mobile/android and
// apps/mobile/ios, from app.config.ts and its config plugins (Expo's
// "continuous native generation"). Both folders are build output: they are
// git-ignored and recreated from scratch on every run.
//
//   node scripts/mobile-prebuild.mjs            android and ios
//   node scripts/mobile-prebuild.mjs android    one platform
//
// The template is pinned. expo 56.0.16 bundles the template of the next SDK
// (expo-template-bare-minimum 57.0.8, React Native 0.86), and prebuilding
// with it generates a native project for the wrong React Native. EAS builds
// use the same pin through eas.json's prebuildCommand; a test keeps the two
// equal.
//
// Prebuild also rewrites package.json scripts that it recognises. The
// scripts are chosen so that it has nothing to rewrite, and this script
// fails if prebuild changed any tracked file anyway: the release pre-push
// hook refuses a dirty tree.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const PREBUILD_TEMPLATE = "expo-template-bare-minimum@56.0.36"
export const PLATFORMS = ["android", "ios"]

const root = path.resolve(import.meta.dirname, "..")
const mobileRoot = path.join(root, "apps", "mobile")
/** Files prebuild may edit that are tracked in git. */
const GUARDED_FILES = ["package.json", "app.config.ts", "tsconfig.json"].map((file) => path.join(mobileRoot, file))

/**
 * Expo generates iOS projects only on macOS and Linux (it skips them on
 * Windows with a warning), so "all" means Android alone there, and asking
 * for iOS explicitly is an error rather than a silent no-op.
 */
export function parsePlatforms(argv, hostPlatform = process.platform) {
  const requested = argv.filter((arg) => !arg.startsWith("-"))
  if (requested.length === 0 || requested.includes("all")) {
    return hostPlatform === "win32" ? ["android"] : [...PLATFORMS]
  }
  for (const platform of requested) {
    if (!PLATFORMS.includes(platform)) {
      throw new Error(`Unknown platform "${platform}": use ${PLATFORMS.join(", ")} or all.`)
    }
  }
  if (hostPlatform === "win32" && requested.includes("ios")) {
    throw new Error("Expo generates the iOS project only on macOS or Linux; iOS builds from Windows go through EAS.")
  }
  return [...new Set(requested)]
}

function expoCli() {
  const require = createRequire(path.join(mobileRoot, "package.json"))
  return path.join(path.dirname(require.resolve("expo/package.json")), "bin", "cli")
}

export function prebuild(platforms, { env = process.env } = {}) {
  const before = new Map(GUARDED_FILES.map((file) => [file, fs.readFileSync(file)]))
  const args = [
    expoCli(),
    "prebuild",
    "--clean",
    "--no-install",
    "--template",
    PREBUILD_TEMPLATE,
    "--platform",
    platforms.length === 1 ? platforms[0] : "all",
  ]
  process.stdout.write(`$ expo ${args.slice(1).join(" ")}  (in apps/mobile)\n`)
  const result = spawnSync(process.execPath, args, {
    cwd: mobileRoot,
    stdio: "inherit",
    env: {
      ...env,
      // The tracked files are compared below instead of prompting about a
      // dirty git tree, which would block unattended runs.
      EXPO_NO_GIT_STATUS: "1",
      EXPO_NO_TELEMETRY: env.EXPO_NO_TELEMETRY ?? "1",
    },
  })
  if (result.error) throw new Error(`expo prebuild could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`expo prebuild failed (${result.status ?? result.signal})`)

  const changed = GUARDED_FILES.filter((file) => !before.get(file).equals(fs.readFileSync(file)))
  if (changed.length > 0) {
    for (const file of changed) fs.writeFileSync(file, before.get(file))
    throw new Error(
      `expo prebuild modified tracked files (restored): ${changed.map((file) => path.relative(root, file)).join(", ")}. ` +
        "Move the change into app.config.ts or a config plugin."
    )
  }
  for (const platform of platforms) {
    if (!fs.existsSync(path.join(mobileRoot, platform))) {
      throw new Error(`expo prebuild did not create apps/mobile/${platform}.`)
    }
  }
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  const self = fileURLToPath(import.meta.url)
  const entry = path.resolve(process.argv[1])
  return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry
}

if (isEntryPoint()) {
  try {
    prebuild(parsePlatforms(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
