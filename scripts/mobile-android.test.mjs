import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  EXPECTED_PERMISSIONS,
  MAX_APK_BYTES,
  PACKAGE_NAME,
  apkFileName,
  checkApkContents,
  checkSignature,
  chooseDevice,
  freeEmulatorPort,
  parseAdbDevices,
  parseArgs,
  parseEnvFile,
  readReleaseCertificate,
  releaseSigningSettings,
} from "./mobile-android.mjs"
import { EXPECTED_ANDROID_ABIS } from "./mobile-checks.mjs"

const require = createRequire(import.meta.url)
const { androidVersionCode } = require("../apps/mobile/config/version.cjs")

const RELEASE = "a".repeat(64)
const DEBUG = "fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c"
const TEST_KEY = "b".repeat(64)

test("reads the command, the APK and the signing", () => {
  assert.deepEqual(parseArgs(["build"]), { command: "build", signing: "test-key", apk: null })
  assert.deepEqual(parseArgs(["build", "--signing", "release"]), { command: "build", signing: "release", apk: null })
  assert.deepEqual(parseArgs(["verify", "out.apk", "--signing=release"]), {
    command: "verify",
    signing: "release",
    apk: "out.apk",
  })
  assert.deepEqual(parseArgs(["e2e"]), { command: "e2e", signing: "test-key", apk: null })
  assert.throws(() => parseArgs(["publish"]), /Usage/)
  assert.throws(() => parseArgs(["verify"]), /verify needs the APK/)
  assert.throws(() => parseArgs(["build", "--signing", "debug"]), /--signing takes release or test-key/)
  assert.throws(() => parseArgs(["build", "extra.apk"]), /Unexpected argument/)
  assert.throws(() => parseArgs(["build", "--fast"]), /Unknown option --fast/)
})

test("names only a release-signed APK the way a release publishes it", () => {
  assert.equal(apkFileName("0.1.0-beta.3", "release"), "BetterC0de-Remote-0.1.0-beta.3.apk")
  assert.equal(apkFileName("0.1.0-beta.3", "test-key"), "BetterC0de-Remote-0.1.0-beta.3-test-key.apk")
})

test("takes the release key from the environment first, then .env.signing", () => {
  const file = [
    "# Android release key",
    "CSC_LINK=/elsewhere/mac.p12",
    'BETTERC0DE_ANDROID_KEYSTORE="/keys/release.p12"',
    "export BETTERC0DE_ANDROID_KEYSTORE_PASSWORD='from file'",
    "BETTERC0DE_ANDROID_KEY_ALIAS=betterc0de-release",
  ].join("\n")
  assert.deepEqual(parseEnvFile(file).BETTERC0DE_ANDROID_KEYSTORE_PASSWORD, "from file")
  const { settings, missing } = releaseSigningSettings({ BETTERC0DE_ANDROID_KEY_PASSWORD: "from env" }, file)
  assert.deepEqual(missing, [])
  assert.deepEqual(settings, {
    BETTERC0DE_ANDROID_KEYSTORE: "/keys/release.p12",
    BETTERC0DE_ANDROID_KEYSTORE_PASSWORD: "from file",
    BETTERC0DE_ANDROID_KEY_ALIAS: "betterc0de-release",
    BETTERC0DE_ANDROID_KEY_PASSWORD: "from env",
  })
  assert.equal(
    releaseSigningSettings({ BETTERC0DE_ANDROID_KEYSTORE_PASSWORD: "env wins" }, file).settings
      .BETTERC0DE_ANDROID_KEYSTORE_PASSWORD,
    "env wins"
  )
  assert.throws(() => parseEnvFile("not an assignment"), /Cannot parse this line of \.env\.signing/)
})

test("accepts the keystore as base64 in CI, and names what is missing", () => {
  const env = {
    BETTERC0DE_ANDROID_KEYSTORE_BASE64: "cGtjczEy",
    BETTERC0DE_ANDROID_KEYSTORE_PASSWORD: "p",
    BETTERC0DE_ANDROID_KEY_ALIAS: "a",
    BETTERC0DE_ANDROID_KEY_PASSWORD: "p",
  }
  const fromCi = releaseSigningSettings(env)
  assert.deepEqual(fromCi.missing, [])
  assert.equal(fromCi.keystoreBase64, "cGtjczEy")
  assert.deepEqual(releaseSigningSettings({ BETTERC0DE_ANDROID_KEY_ALIAS: "a" }).missing, [
    "BETTERC0DE_ANDROID_KEYSTORE",
    "BETTERC0DE_ANDROID_KEYSTORE_PASSWORD",
    "BETTERC0DE_ANDROID_KEY_PASSWORD",
  ])
})

test("reads the pinned release certificate, and refuses a malformed pin", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "release-certificate-"))
  try {
    const file = path.join(folder, "android-release.json")
    assert.equal(readReleaseCertificate(file), null)
    fs.writeFileSync(file, JSON.stringify({ sha256: RELEASE, subject: "CN=BetterC0de Remote" }))
    assert.equal(readReleaseCertificate(file).sha256, RELEASE)
    fs.writeFileSync(file, JSON.stringify({ sha256: "AA:BB" }))
    assert.throws(() => readReleaseCertificate(file), /"sha256" must be 64 lowercase hex digits/)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

const signedBy = (sha256, overrides = {}) => ({
  verified: true,
  schemes: { v1: false, v2: true, v3: true },
  signerCount: 1,
  signers: [{ dn: "CN=Test", sha256 }],
  ...overrides,
})

test("a release must carry exactly the pinned certificate", () => {
  const pinned = { sha256: RELEASE }
  assert.deepEqual(
    checkSignature({ signer: signedBy(RELEASE), signing: "release", releaseCertificate: pinned, debugCertificate: DEBUG }),
    []
  )
  assert.match(
    checkSignature({ signer: signedBy(TEST_KEY), signing: "release", releaseCertificate: pinned, debugCertificate: DEBUG })[0],
    /not by the pinned release certificate/
  )
  assert.match(
    checkSignature({ signer: signedBy(RELEASE), signing: "release", releaseCertificate: null, debugCertificate: DEBUG })[0],
    /no release certificate is pinned/
  )
})

test("nothing may carry the template's debug key, and a test build not the release key", () => {
  const pinned = { sha256: RELEASE }
  assert.deepEqual(
    checkSignature({ signer: signedBy(TEST_KEY), signing: "test-key", releaseCertificate: pinned, debugCertificate: DEBUG }),
    []
  )
  assert.deepEqual(
    checkSignature({ signer: signedBy(DEBUG), signing: "test-key", releaseCertificate: pinned, debugCertificate: DEBUG }),
    ["signed with the React Native template's public debug key"]
  )
  assert.deepEqual(
    checkSignature({ signer: signedBy(RELEASE), signing: "test-key", releaseCertificate: pinned, debugCertificate: DEBUG }),
    ["a test build is signed with the release key"]
  )
})

test("an APK needs a verified v2 signature by a single signer", () => {
  const problems = checkSignature({
    signer: signedBy(TEST_KEY, {
      verified: false,
      schemes: { v1: true, v2: false },
      signerCount: 2,
      signers: [{ sha256: TEST_KEY }, { sha256: RELEASE }],
    }),
    signing: "test-key",
    releaseCertificate: null,
    debugCertificate: DEBUG,
  })
  assert.deepEqual(problems, [
    "apksigner does not verify the APK",
    "no APK Signature Scheme v2 signature",
    "2 signers, expected exactly one",
  ])
})

test("checks what the APK declares against the app and React Native", () => {
  const version = "0.1.0-beta.3"
  const requirements = { minSdk: 24, targetSdk: 36 }
  const abis = [...EXPECTED_ANDROID_ABIS].sort()
  const good = {
    badging: {
      packageName: PACKAGE_NAME,
      versionName: version,
      versionCode: androidVersionCode(version),
      minSdk: 24,
      targetSdk: 36,
      nativeCode: abis,
      permissions: [...EXPECTED_PERMISSIONS].sort(),
      debuggable: false,
    },
    abis,
    misaligned: [],
    size: 1024,
    version,
    requirements,
  }
  assert.deepEqual(checkApkContents(good), [])
  const bad = checkApkContents({
    ...good,
    badging: {
      ...good.badging,
      versionCode: 1,
      nativeCode: ["arm64-v8a"],
      permissions: [...good.badging.permissions, "android.permission.RECORD_AUDIO"].sort(),
      debuggable: true,
    },
    misaligned: ["lib/x86_64/libold.so: segments aligned to 4096 bytes"],
  })
  assert.equal(bad.some((problem) => problem.startsWith("versionCode is 1")), true)
  assert.equal(bad.some((problem) => problem.startsWith('native-code is ["arm64-v8a"]')), true)
  assert.equal(bad.some((problem) => problem.includes("RECORD_AUDIO")), true)
  assert.equal(bad.includes("the APK is debuggable"), true)
  assert.equal(bad.includes("not 16 KB page aligned: lib/x86_64/libold.so: segments aligned to 4096 bytes"), true)
  if (MAX_APK_BYTES > 0) {
    assert.match(checkApkContents({ ...good, size: MAX_APK_BYTES + 1 })[0], /over the budget/)
  }
})

test("tests only on the test emulator or the device ANDROID_SERIAL names", () => {
  const attached = ["emulator-5554", "emulator-5556", "R5CT12345"]
  const avds = { "emulator-5554": "Medium_Phone_API_36.0", "emulator-5556": "BetterC0de_Test" }
  const testAvd = "BetterC0de_Test"
  assert.equal(chooseDevice({ attached, avds, wanted: "", testAvd }), "emulator-5556")
  assert.equal(chooseDevice({ attached, avds, wanted: "R5CT12345", testAvd }), "R5CT12345")
  // Someone's own emulator or phone is never picked on its own.
  assert.equal(chooseDevice({ attached: ["emulator-5554", "R5CT12345"], avds, wanted: "", testAvd }), null)
  assert.throws(() => chooseDevice({ attached, avds, wanted: "emulator-5560", testAvd }), /ANDROID_SERIAL=emulator-5560 is not attached/)
})

test("boots the test emulator on a port no other emulator uses", () => {
  assert.equal(freeEmulatorPort([]), 5554)
  assert.equal(freeEmulatorPort(["emulator-5554", "R5CT12345"]), 5556)
  assert.equal(freeEmulatorPort(["emulator-5556"]), 5554)
})

test("lists the devices adb can use", () => {
  const output = [
    "List of devices attached",
    "emulator-5554\tdevice",
    "0A1B2C3D\tunauthorized",
    "emulator-5556\toffline",
    "R5CT12345\tdevice",
    "",
  ].join("\n")
  assert.deepEqual(parseAdbDevices(output), ["emulator-5554", "R5CT12345"])
})
