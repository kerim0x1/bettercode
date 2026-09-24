import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { PREBUILD_TEMPLATE } from "./mobile-prebuild.mjs"

const root = path.resolve(import.meta.dirname, "..")
const mobileRoot = path.join(root, "apps", "mobile")
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const eas = readJson(path.join(mobileRoot, "eas.json"))
const mobilePackage = readJson(path.join(mobileRoot, "package.json"))

test("EAS builds use the pinned Node and prebuild template", () => {
  const pinnedNode = fs.readFileSync(path.join(root, ".nvmrc"), "utf8").trim()
  assert.equal(eas.build.base.node, pinnedNode, "eas.json must build with the Node version in .nvmrc")
  assert.equal(eas.build.base.prebuildCommand, `prebuild --template ${PREBUILD_TEMPLATE}`)
})

test("the pinned template belongs to the installed Expo SDK", () => {
  const templateSdk = /@(\d+)\./.exec(PREBUILD_TEMPLATE)?.[1]
  const expoSdk = /(\d+)\./.exec(mobilePackage.dependencies.expo)?.[1]
  assert.ok(templateSdk && expoSdk)
  assert.equal(templateSdk, expoSdk, `${PREBUILD_TEMPLATE} does not match expo ${mobilePackage.dependencies.expo}`)
})

test("store build numbers come from EAS, so parallel builds cannot reuse one", () => {
  assert.equal(eas.cli.appVersionSource, "remote")
  assert.equal(eas.build.production.autoIncrement, true)
  assert.equal(eas.cli.requireCommit, true, "a store build must be traceable to a commit")
})

test("EAS installs the monorepo without desktop-only downloads and hooks", () => {
  assert.deepEqual(
    Object.fromEntries(
      ["BETTERC0DE_SKIP_POSTINSTALL", "ELECTRON_SKIP_BINARY_DOWNLOAD", "HUSKY"].map((name) => [name, eas.build.base.env[name]])
    ),
    { BETTERC0DE_SKIP_POSTINSTALL: "1", ELECTRON_SKIP_BINARY_DOWNLOAD: "1", HUSKY: "0" }
  )
  for (const [name, profile] of Object.entries(eas.build)) {
    if (name !== "base") assert.equal(profile.extends, "base", `${name} must extend base`)
  }
})

test("prebuild has no package.json script it would rewrite", () => {
  // @expo/cli's prebuild replaces exactly these values and would leave the
  // tree dirty, which the release pre-push hook refuses.
  const rewritten = {
    android: ["expo start --android", "react-native run-android"],
    ios: ["expo start --ios", "react-native run-ios"],
  }
  for (const [script, values] of Object.entries(rewritten)) {
    assert.ok(!values.includes(mobilePackage.scripts[script]), `apps/mobile scripts.${script}`)
  }
})

test("the native projects are generated, never committed", () => {
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/)
  for (const entry of ["/apps/mobile/android/", "/apps/mobile/ios/", "/apps/mobile/build/"]) {
    assert.ok(gitignore.includes(entry), `.gitignore must list ${entry}`)
  }
  assert.equal(fs.existsSync(path.join(mobileRoot, "app.json")), false, "app.config.ts is the only app config")
})

test("store and signing credentials are git-ignored", () => {
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/)
  for (const entry of ["*.p8", "*.p12", "*.jks", "*.keystore", "google-services.json", "GoogleService-Info.plist", ".env.*"]) {
    assert.ok(gitignore.includes(entry), `.gitignore must list ${entry}`)
  }
})
