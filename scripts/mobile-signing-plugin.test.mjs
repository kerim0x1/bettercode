import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"

const require = createRequire(import.meta.url)
const { applyReleaseSigning, SIGNING_ENV } = require("../apps/mobile/plugins/with-android-release-signing.cjs")

// android/app/build.gradle of expo-template-bare-minimum@56.0.36, the
// template scripts/mobile-prebuild.mjs pins. The package ships it with LF;
// the CRLF case is tested separately below.
const template = fs
  .readFileSync(path.join(import.meta.dirname, "fixtures", "mobile", "sdk56-app-build.gradle"), "utf8")
  .replace(/\r\n/g, "\n")

function block(source, header) {
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `${header} not found`)
  let depth = 0
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`${header} is not closed`)
}

test("the fixture is the template the plugin was written against", () => {
  // The unsafe default this plugin exists to replace.
  const release = block(block(template, "    buildTypes {"), "        release {")
  assert.match(release, /signingConfig signingConfigs\.debug/)
})

test("release builds are signed with the key from the environment", () => {
  const gradle = applyReleaseSigning(template)
  const signing = block(gradle, "    signingConfigs {")
  const releaseSigning = block(signing, "        release {")
  for (const name of SIGNING_ENV) assert.match(releaseSigning, new RegExp(`System\\.getenv\\("${name}"\\)`))
  assert.match(signing, /storePassword 'android'/, "the debug config stays for debug builds")

  const buildTypes = block(gradle, "    buildTypes {")
  assert.match(block(buildTypes, "        release {"), /signingConfig signingConfigs\.release\n/)
  assert.doesNotMatch(block(buildTypes, "        release {"), /signingConfigs\.debug/)
  assert.match(block(buildTypes, "        debug {"), /signingConfig signingConfigs\.debug\n/)
})

test("a release task without a complete signing config fails the build", () => {
  const gradle = applyReleaseSigning(template)
  assert.match(gradle, /gradle\.taskGraph\.whenReady/)
  assert.match(gradle, /\(assemble\|bundle\|package\|install\)Release/)
  for (const name of SIGNING_ENV) assert.ok(gradle.includes(`"${name}"`), name)
  assert.match(gradle, /throw new GradleException\("Refusing to build a release without a signing key/)
})

test("the edit is idempotent and keeps the file balanced", () => {
  const once = applyReleaseSigning(template)
  assert.equal(applyReleaseSigning(once), once)
  const opened = (once.match(/\{/g) ?? []).length
  const closed = (once.match(/\}/g) ?? []).length
  assert.equal(opened, closed)
  // Everything outside the two blocks and the appended guard is untouched.
  assert.ok(once.startsWith(template.slice(0, template.indexOf("    signingConfigs {"))))
})

test("a build.gradle with Windows line endings is signed the same way and keeps them", () => {
  const crlf = template.replace(/\r?\n/g, "\r\n")
  const gradle = applyReleaseSigning(crlf)
  assert.equal(gradle.replace(/\r\n/g, "\n"), applyReleaseSigning(template.replace(/\r\n/g, "\n")))
  assert.doesNotMatch(gradle, /[^\r]\n/, "no bare LF may be mixed into a CRLF file")
})

test("an unexpected template fails prebuild instead of keeping the debug signature", () => {
  assert.throws(() => applyReleaseSigning(template.replace("    signingConfigs {", "    signingConfigz {")), /signingConfigs/)
  assert.throws(
    () =>
      applyReleaseSigning(
        template.replace(
          "            signingConfig signingConfigs.debug\n            def enableShrinkResources",
          "            def enableShrinkResources"
        )
      ),
    /found 0/
  )
  assert.throws(
    () => applyReleaseSigning(template.replace("    buildTypes {", "    buildTypes {\n        release {\n        }")),
    /found 2/
  )
})
