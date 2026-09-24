import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  PAGE_SIZE_16K,
  apkSigners,
  elfLoadSegmentAlignments,
  misalignedLibraries,
  nativeAbis,
  normalizeFingerprint,
  parseApksignerOutput,
  parseBadging,
  parseKeytoolFingerprint,
  readZipEntries,
  readZipEntry,
} from "./android-apk.mjs"
import { makeElf, makeZip, schemeBlock, withSigningBlock } from "./fixtures/mobile/apk.mjs"

test("reads stored and deflated entries, with local padding the central directory does not have", () => {
  const manifest = Buffer.from("<manifest/>".repeat(40))
  const archive = makeZip([
    { name: "AndroidManifest.xml", data: manifest },
    { name: "resources.arsc", data: Buffer.from("table"), method: 0, alignTo: 4 },
  ])
  const entries = readZipEntries(archive)
  assert.deepEqual(
    entries.map(({ name, method }) => ({ name, method })),
    [
      { name: "AndroidManifest.xml", method: 8 },
      { name: "resources.arsc", method: 0 },
    ]
  )
  assert.equal(entries[1].dataOffset % 4, 0)
  assert.deepEqual(readZipEntry(archive, entries[0]), manifest)
  assert.equal(readZipEntry(archive, entries[1]).toString(), "table")
  assert.equal(entries[0].unixMode, 0o100644)
})

test("refuses what is not a ZIP archive", () => {
  assert.throws(() => readZipEntries(Buffer.alloc(64)), /Not a ZIP archive/)
})

test("reads the alignment of an ELF library's loadable segments, 64- and 32-bit", () => {
  assert.deepEqual(elfLoadSegmentAlignments(makeElf([0x4000, 0x4000])), [0x4000, 0x4000])
  assert.deepEqual(elfLoadSegmentAlignments(makeElf([0x1000], { bits: 32 })), [0x1000])
  assert.throws(() => elfLoadSegmentAlignments(Buffer.alloc(64)), /Not an ELF file/)
})

test("names the ABIs an APK carries libraries for", () => {
  const archive = makeZip([
    { name: "lib/arm64-v8a/libapp.so", data: makeElf([0x4000]) },
    { name: "lib/x86_64/libapp.so", data: makeElf([0x4000]) },
    { name: "lib/x86_64/libother.so", data: makeElf([0x4000]) },
    { name: "assets/lib/fake.so", data: Buffer.from("x") },
  ])
  assert.deepEqual(nativeAbis(readZipEntries(archive)), ["arm64-v8a", "x86_64"])
})

test("finds 64-bit libraries a 16 KB page device could not load", () => {
  const archive = makeZip([
    { name: "lib/arm64-v8a/libgood.so", data: makeElf([0x4000, 0x10000]) },
    { name: "lib/x86_64/libold.so", data: makeElf([0x1000, 0x4000]) },
    // 32-bit ABIs never run on 16 KB page devices.
    { name: "lib/armeabi-v7a/libold.so", data: makeElf([0x1000], { bits: 32 }) },
    // Uncompressed libraries are mapped straight from the APK.
    { name: "lib/arm64-v8a/libstored.so", data: makeElf([0x4000]), method: 0, alignTo: 4 },
    { name: "lib/x86_64/libstoredaligned.so", data: makeElf([0x4000]), method: 0, alignTo: PAGE_SIZE_16K },
  ])
  const problems = misalignedLibraries(archive)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /^lib\/x86_64\/libold\.so: segments aligned to 4096 bytes$/)
  const stored = readZipEntries(archive).find((entry) => entry.name === "lib/arm64-v8a/libstored.so")
  if (stored.dataOffset % PAGE_SIZE_16K === 0) {
    assert.fail("the test archive should place libstored.so off a page boundary")
  }
  assert.match(problems[1], /^lib\/arm64-v8a\/libstored\.so: stored at offset \d+, not on a 16384-byte page$/)
})

test("reads the signers apksigner reports", () => {
  const output = [
    "Verifies",
    "Verified using v1 scheme (JAR signing): false",
    "Verified using v2 scheme (APK Signature Scheme v2): true",
    "Verified using v3 scheme (APK Signature Scheme v3): true",
    "Verified using v3.1 scheme (APK Signature Scheme v3.1): false",
    "Verified using v4 scheme (APK Signature Scheme v4): false",
    "Verified for SourceStamp: false",
    "Number of signers: 1",
    "Signer #1 certificate DN: CN=BetterC0de Remote, C=DE",
    "Signer #1 certificate SHA-256 digest: 0a1B2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
    "Signer #1 certificate SHA-1 digest: 0123456789abcdef0123456789abcdef01234567",
    "Signer #1 certificate MD5 digest: 0123456789abcdef0123456789abcdef",
  ].join("\r\n")
  assert.deepEqual(parseApksignerOutput(output), {
    verified: true,
    schemes: { v1: false, v2: true, v3: true, "v3.1": false, v4: false },
    signerCount: 1,
    signers: [
      {
        dn: "CN=BetterC0de Remote, C=DE",
        sha256: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
      },
    ],
  })
  assert.equal(parseApksignerOutput("DOES NOT VERIFY\nERROR: JAR signer CERT.RSA").verified, false)
})

test("reads package, SDK levels, ABIs, permissions and debuggability from aapt2 badging", () => {
  const output = [
    "package: name='com.betterc0de.remote' versionCode='100302' versionName='0.1.0-beta.2' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'",
    "minSdkVersion:'24'",
    "targetSdkVersion:'36'",
    "uses-permission: name='android.permission.INTERNET'",
    "uses-permission: name='android.permission.CAMERA'",
    "uses-permission: name='android.permission.READ_EXTERNAL_STORAGE' maxSdkVersion='32'",
    "application-label:'BetterC0de Remote'",
    "launchable-activity: name='com.betterc0de.remote.MainActivity'  label='' icon=''",
    "native-code: 'x86_64' 'arm64-v8a' 'armeabi-v7a'",
  ].join("\n")
  assert.deepEqual(parseBadging(output), {
    packageName: "com.betterc0de.remote",
    versionCode: 100302,
    versionName: "0.1.0-beta.2",
    minSdk: 24,
    targetSdk: 36,
    nativeCode: ["arm64-v8a", "armeabi-v7a", "x86_64"],
    permissions: ["android.permission.CAMERA", "android.permission.INTERNET", "android.permission.READ_EXTERNAL_STORAGE"],
    debuggable: false,
  })
  assert.equal(parseBadging(`${output}\napplication-debuggable`).debuggable, true)
  // The older aapt names the minimum SDK differently.
  assert.equal(parseBadging(output.replace("minSdkVersion:", "sdkVersion:")).minSdk, 24)
})

test("reads the SHA-256 fingerprint keytool prints, in one spelling", () => {
  const output = [
    "Alias name: androiddebugkey",
    "Certificate fingerprints:",
    "\t SHA1: 5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25",
    "\t SHA256: FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C",
  ].join("\n")
  assert.equal(
    parseKeytoolFingerprint(output),
    "fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c"
  )
  assert.equal(parseKeytoolFingerprint("no certificate here"), null)
  assert.equal(normalizeFingerprint("AA:bb:0C"), "aabb0c")
})

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")

test("reads the certificates each signature scheme names, skipping other blocks", () => {
  const release = Buffer.from("release certificate (DER)")
  const intermediate = Buffer.from("second certificate (DER)")
  const archive = withSigningBlock(makeZip([{ name: "AndroidManifest.xml", data: Buffer.from("<manifest/>") }]), [
    [0x7109871a, schemeBlock([release, intermediate])],
    [0x42726577, Buffer.alloc(64)], // verity padding
    [0xf05368c0, schemeBlock([release], { v3: true })],
  ])
  assert.deepEqual(apkSigners(archive), [
    { scheme: "v2", certificates: [sha256(release), sha256(intermediate)] },
    { scheme: "v3", certificates: [sha256(release)] },
  ])
  // The entries are still readable after the block.
  assert.equal(readZipEntries(archive)[0].name, "AndroidManifest.xml")
})

test("an APK without a signing block names no signers; a damaged one is refused", () => {
  const plain = makeZip([{ name: "AndroidManifest.xml", data: Buffer.from("<manifest/>") }])
  assert.deepEqual(apkSigners(plain), [])
  const archive = withSigningBlock(plain, [[0x7109871a, schemeBlock([Buffer.from("certificate")])]])
  const centralDirectory = archive.readUInt32LE(archive.length - 22 + 16)
  const damaged = Buffer.from(archive)
  // Claim a signer longer than the block.
  const blockStart = centralDirectory - Number(archive.readBigUInt64LE(centralDirectory - 24)) - 8
  damaged.writeUInt32LE(0xffff, blockStart + 8 + 12)
  assert.throws(() => apkSigners(damaged), /The APK Signing Block is damaged/)
})
