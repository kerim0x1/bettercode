import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import zlib from "node:zlib"

import {
  MAESTRO_PIN_FILE,
  REQUIRED_JDK,
  androidRequirements,
  androidSdkCandidates,
  androidSdkPackages,
  emulatorImage,
  extractZip,
  findJdk,
  javaMajorVersion,
  maestroCacheRoot,
  maestroFailures,
  maestroTestArgs,
  missingSdkPackages,
  parseAvdList,
  parseVersionCatalog,
  parseXcodeMajor,
  readMaestroPin,
  sdkPackagePath,
} from "./mobile-toolchain.mjs"

/**
 * A fake file system holding JDK `release` files. Paths split on either
 * separator, so the Windows and POSIX cases run on every host.
 */
function fakeJdks(homes, directories) {
  return {
    readFileSync(file) {
      const home = /^(.*)[\\/]release$/.exec(file)?.[1]
      if (home !== undefined && home in homes) return `JAVA_VERSION="${homes[home]}"\n`
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    },
    readdirSync(folder) {
      if (folder in directories) return directories[folder]
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    },
  }
}

test("reads the versions table of a Gradle version catalog", () => {
  const catalog = [
    "[versions]",
    '# Android versions',
    'minSdk = "24"',
    'buildTools = "36.0.0" # pinned',
    'ndkVersion = "27.1.12297006"',
    "",
    "[libraries]",
    'minSdk = "not a version"',
  ].join("\n")
  assert.deepEqual(parseVersionCatalog(catalog), {
    minSdk: "24",
    buildTools: "36.0.0",
    ndkVersion: "27.1.12297006",
  })
})

test("takes the Android SDK levels from the installed React Native", () => {
  const requirements = androidRequirements()
  assert.equal(Number.isInteger(requirements.minSdk) && requirements.minSdk >= 24, true)
  assert.equal(requirements.targetSdk >= requirements.minSdk, true)
  assert.match(requirements.buildTools, /^\d+\.\d+\.\d+$/)
  assert.match(requirements.ndk, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(androidSdkPackages(requirements), [
    "platform-tools",
    `platforms;android-${requirements.compileSdk}`,
    `build-tools;${requirements.buildTools}`,
    `ndk;${requirements.ndk}`,
  ])
  assert.equal(androidSdkPackages(requirements, { emulator: true }).at(-1), "emulator")
  assert.equal(emulatorImage({ targetSdk: 36 }, "x64"), "system-images;android-36;google_apis;x86_64")
  assert.equal(emulatorImage({ targetSdk: 36 }, "arm64"), "system-images;android-36;google_apis;arm64-v8a")
  assert.equal(sdkPackagePath("build-tools;36.0.0"), path.join("build-tools", "36.0.0"))
})

test("reads the major version of a JDK, old and new numbering", () => {
  assert.equal(javaMajorVersion('IMPLEMENTOR="Microsoft"\nJAVA_VERSION="17.0.17"\n'), 17)
  assert.equal(javaMajorVersion('JAVA_VERSION="25"'), 25)
  assert.equal(javaMajorVersion('JAVA_VERSION="1.8.0_481"'), 8)
  assert.equal(javaMajorVersion("no version"), null)
})

test("uses JAVA_HOME only when it is JDK 17, and otherwise finds an installed 17", () => {
  const programFiles = "C:\\Program Files"
  const corretto25 = path.win32.join(programFiles, "Amazon Corretto", "jdk25.0.4_7")
  const microsoft17 = path.win32.join(programFiles, "Microsoft", "jdk-17.0.17.10-hotspot")
  const microsoft21 = path.win32.join(programFiles, "Microsoft", "jdk-21.0.9.10-hotspot")
  const fsImpl = fakeJdks(
    { [corretto25]: "25.0.4", [microsoft17]: "17.0.17", [microsoft21]: "21.0.9" },
    {
      [path.win32.join(programFiles, "Microsoft")]: ["jdk-21.0.9.10-hotspot", "jdk-17.0.17.10-hotspot"],
      [path.win32.join(programFiles, "Amazon Corretto")]: ["jdk25.0.4_7"],
    }
  )
  const env = { ProgramFiles: programFiles, JAVA_HOME: corretto25 }
  assert.deepEqual(findJdk({ env, platform: "win32", fsImpl }), { home: microsoft17, source: "installed JDKs" })
  assert.deepEqual(findJdk({ env: { ...env, JAVA_HOME: microsoft17 }, platform: "win32", fsImpl }), {
    home: microsoft17,
    source: "JAVA_HOME",
  })
})

test("insists on JDK 17 when one is named explicitly, and explains a missing one", () => {
  const home = "/opt/jdk-21"
  const fsImpl = fakeJdks({ [home]: "21.0.2" }, {})
  const refused = findJdk({ env: { BETTERC0DE_JAVA_HOME: home }, platform: "linux", fsImpl })
  assert.match(refused.problem, /BETTERC0DE_JAVA_HOME \(\/opt\/jdk-21\) is JDK 21; it must be JDK 17/)
  const missing = findJdk({ env: { JAVA_HOME: home }, platform: "linux", fsImpl })
  assert.match(missing.problem, new RegExp(`JDK ${REQUIRED_JDK} was not found\\. JAVA_HOME points to JDK 21, which is not used\\.`))
})

test("finds JDKs in macOS bundles", () => {
  const bundle = "/Library/Java/JavaVirtualMachines/temurin-17.jdk"
  const home = path.posix.join(bundle, "Contents", "Home")
  const fsImpl = fakeJdks({ [home]: "17.0.12" }, { "/Library/Java/JavaVirtualMachines": ["temurin-17.jdk"] })
  assert.deepEqual(findJdk({ env: {}, platform: "darwin", fsImpl }), { home, source: "installed JDKs" })
})

test("looks for the SDK where the environment says, then where Android Studio puts it", () => {
  assert.deepEqual(
    androidSdkCandidates({ ANDROID_HOME: "D:\\sdk", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a"),
    ["D:\\sdk", "C:\\Users\\a\\AppData\\Local\\Android\\Sdk"]
  )
  assert.deepEqual(androidSdkCandidates({}, "darwin", "/Users/a"), ["/Users/a/Library/Android/sdk"])
  assert.deepEqual(androidSdkCandidates({ ANDROID_SDK_ROOT: "/sdk" }, "linux", "/home/a"), [
    "/sdk",
    "/home/a/Android/Sdk",
  ])
})

test("names the SDK packages a folder lacks", () => {
  const present = new Set([path.join("/sdk", "platform-tools"), path.join("/sdk", "build-tools", "36.0.0")])
  const fsImpl = { existsSync: (file) => present.has(file) }
  assert.deepEqual(missingSdkPackages("/sdk", ["platform-tools", "build-tools;36.0.0", "ndk;27.1.12297006"], { fsImpl }), [
    "ndk;27.1.12297006",
  ])
})

test("lists AVD names without the emulator's own messages", () => {
  const output = "INFO    | Storing crashdata in: C:\\tmp\nBetterC0de_Test\nMedium_Phone_API_36.0\n\n"
  assert.deepEqual(parseAvdList(output), ["BetterC0de_Test", "Medium_Phone_API_36.0"])
})

test("pins Maestro to a release and its checksum", () => {
  const pin = readMaestroPin()
  assert.match(pin.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pin.url, `https://github.com/mobile-dev-inc/maestro/releases/download/cli-${pin.version}/maestro.zip`)
  assert.match(pin.sha256, /^[0-9a-f]{64}$/)

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-pin-"))
  try {
    const file = path.join(folder, "maestro.json")
    fs.writeFileSync(file, JSON.stringify({ ...pin, url: "https://example.com/maestro.zip" }))
    assert.throws(() => readMaestroPin(file), /"url" must be a Maestro release download/)
    fs.writeFileSync(file, JSON.stringify({ ...pin, sha256: "abc" }))
    assert.throws(() => readMaestroPin(file), /"sha256" must be 64 hex digits/)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
  assert.equal(path.basename(path.dirname(MAESTRO_PIN_FILE)), "maestro")
})

test("caches Maestro per user, or where BETTERC0DE_MAESTRO_HOME says", () => {
  assert.equal(
    maestroCacheRoot({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a"),
    "C:\\Users\\a\\AppData\\Local\\betterc0de\\maestro"
  )
  assert.equal(maestroCacheRoot({}, "linux", "/home/a"), "/home/a/.cache/betterc0de/maestro")
  assert.equal(maestroCacheRoot({ BETTERC0DE_MAESTRO_HOME: "/cache/m" }, "linux", "/home/a"), "/cache/m")
})

test("extracts an archive, and refuses entries that point outside the target", () => {
  const zip = (name) => {
    const data = Buffer.from("echo maestro")
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(zlib.crc32(data), 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    const localRecord = Buffer.concat([local, nameBytes, data])
    const directory = Buffer.concat([central, nameBytes])
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(1, 8)
    end.writeUInt16LE(1, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(localRecord.length, 16)
    return Buffer.concat([localRecord, directory, end])
  }
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "extract-"))
  try {
    extractZip(zip("maestro/bin/maestro"), target)
    assert.equal(fs.readFileSync(path.join(target, "maestro", "bin", "maestro"), "utf8"), "echo maestro")
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(target, "maestro", "bin", "maestro")).mode & 0o111, 0o111)
    }
    assert.throws(() => extractZip(zip("../escaped.txt"), target), /points outside the target folder/)
    assert.equal(fs.existsSync(path.join(path.dirname(target), "escaped.txt")), false)
  } finally {
    fs.rmSync(target, { recursive: true, force: true })
  }
})

test("runs every flow on one device and keeps a report", () => {
  const args = maestroTestArgs("emulator-5554", "flows", "out")
  assert.deepEqual(args.slice(0, 4), ["--device", "emulator-5554", "test", "flows"])
  assert.deepEqual(args.slice(4, 6), ["--format", "JUNIT"])
  assert.equal(args.includes(path.join("out", "maestro-junit.xml")), true)
})

/** A Maestro output folder: its JUnit report, and each flow's commands.json by flow name. */
function maestroOutput(testcases, commands = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestro-output-"))
  fs.writeFileSync(
    path.join(dir, "maestro-junit.xml"),
    `<?xml version='1.0' encoding='UTF-8'?>\n<testsuites>\n  <testsuite name="Test Suite" tests="${testcases.length}">\n${testcases.join("\n")}\n  </testsuite>\n</testsuites>\n`
  )
  for (const [name, entries] of Object.entries(commands)) {
    fs.mkdirSync(path.join(dir, "maestro", name), { recursive: true })
    fs.writeFileSync(path.join(dir, "maestro", name, "commands.json"), JSON.stringify(entries))
  }
  return dir
}

test("tells a flow the emulator dropped out of from one that failed a check", () => {
  // As Maestro 2.10 wrote them in CI: JUnit says only "Unknown error" for a
  // lost device; the flow's commands.json has adb's message.
  const dir = maestroOutput(
    [
      `    <testcase id="The demo link opens the demo" name="The demo link opens the demo" file="apps/mobile/maestro/flows/demo-link.yaml" status="ERROR">
      <properties><property name="tags" value="demo"/></properties>
      <failure>Unknown error</failure>
    </testcase>`,
      `    <testcase id="Pairing" name="Pairing checks the input &amp; refuses a bare code" file="apps/mobile/maestro/flows/pairing-input.yaml" status="ERROR">
      <failure>Assertion is false: id: pair-error is visible</failure>
    </testcase>`,
      `    <testcase id="Demo" name="The demo from the pairing screen to Exit demo" file="apps/mobile/maestro/flows/demo-chat.yaml" status="SUCCESS"/>`,
    ],
    {
      "The demo link opens the demo": [
        { command: { defineVariablesCommand: {} }, metadata: { status: "COMPLETED" } },
        {
          command: { launchAppCommand: {} },
          metadata: {
            status: "FAILED",
            error: { message: "Command failed (host:transport:emulator-5554): device offline" },
          },
        },
      ],
    }
  )
  try {
    assert.deepEqual(maestroFailures(dir), [
      {
        name: "The demo link opens the demo",
        file: "apps/mobile/maestro/flows/demo-link.yaml",
        reason: "Command failed (host:transport:emulator-5554): device offline",
        lostDevice: true,
      },
      {
        name: "Pairing checks the input & refuses a bare code",
        file: "apps/mobile/maestro/flows/pairing-input.yaml",
        reason: "Assertion is false: id: pair-error is visible",
        lostDevice: false,
      },
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("finds no failures in a run that passed", () => {
  const dir = maestroOutput([
    `    <testcase id="a" name="A flow" file="flows/a.yaml" status="SUCCESS">
      <properties><property name="tags" value="demo"/></properties>
    </testcase>`,
  ])
  try {
    assert.deepEqual(maestroFailures(dir), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("reads the Xcode version", () => {
  assert.equal(parseXcodeMajor("Xcode 26.0.1\nBuild version 17A400\n"), 26)
  assert.equal(parseXcodeMajor("Xcode 16.4\nBuild version 16F6\n"), 16)
  assert.equal(parseXcodeMajor("xcode-select: error: tool 'xcodebuild' requires Xcode"), null)
})
