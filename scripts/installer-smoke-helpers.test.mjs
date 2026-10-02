import assert from "node:assert/strict"
import test from "node:test"

import {
  findLinuxExecutable,
  findUninstallEntries,
  isForeignNativeBuild,
  macSignatureProblems,
  machOArchName,
  nsisInstallArgs,
  parseCodesignDetails,
  parseLipoArchs,
  parseRegQuery,
  parseSpctlAssessment,
  samePath,
  selectInstallers,
  single,
} from "./installer-smoke-helpers.mjs"

test("Windows selection keeps the setup executable and ignores uninstallers", () => {
  const result = selectInstallers(
    [
      "BetterC0de-Setup-0.1.0-beta.3.exe",
      "BetterC0de-Setup-0.1.0-beta.3.exe.blockmap",
      "__uninstaller-nsis-betterc0de.exe",
      "latest.yml",
    ],
    "win32",
    "x64"
  )
  assert.deepEqual(result.nsis, ["BetterC0de-Setup-0.1.0-beta.3.exe"])
  assert.deepEqual(result.foreign, [])
})

test("macOS selection separates the runner's arch from mislabeled artifacts", () => {
  // The 0.1.0-beta.2 x64 runner emitted both of these from one x64 app.
  const files = [
    "BetterC0de-0.1.0-beta.2-arm64-mac.zip",
    "BetterC0de-0.1.0-beta.2-arm64.dmg",
    "BetterC0de-0.1.0-beta.2-mac.zip",
    "BetterC0de-0.1.0-beta.2.dmg",
    "BetterC0de-0.1.0-beta.2.dmg.blockmap",
    "latest-mac.yml",
  ]
  const x64 = selectInstallers(files, "darwin", "x64")
  assert.deepEqual(x64.dmg, ["BetterC0de-0.1.0-beta.2.dmg"])
  assert.deepEqual(x64.zip, ["BetterC0de-0.1.0-beta.2-mac.zip"])
  assert.deepEqual(x64.foreign, [
    "BetterC0de-0.1.0-beta.2-arm64.dmg",
    "BetterC0de-0.1.0-beta.2-arm64-mac.zip",
  ])

  const arm64 = selectInstallers(files, "darwin", "arm64")
  assert.deepEqual(arm64.dmg, ["BetterC0de-0.1.0-beta.2-arm64.dmg"])
  assert.deepEqual(arm64.zip, ["BetterC0de-0.1.0-beta.2-arm64-mac.zip"])
  assert.equal(arm64.foreign.length, 2)
})

test("Linux selection maps x64 and arm64 to each package format's arch name", () => {
  const files = [
    "BetterC0de-0.1.0.AppImage",
    "betterc0de-0.1.0.tar.gz",
    "betterc0de-0.1.0.x86_64.rpm",
    "betterc0de_0.1.0_amd64.deb",
    "latest-linux.yml",
  ]
  assert.deepEqual(selectInstallers(files, "linux", "x64"), {
    deb: ["betterc0de_0.1.0_amd64.deb"],
    rpm: ["betterc0de-0.1.0.x86_64.rpm"],
    appImage: ["BetterC0de-0.1.0.AppImage"],
    tarGz: ["betterc0de-0.1.0.tar.gz"],
    foreign: [],
  })

  const arm = selectInstallers(
    [...files, "betterc0de_0.1.0_arm64.deb", "BetterC0de-0.1.0-arm64.AppImage"],
    "linux",
    "arm64"
  )
  assert.deepEqual(arm.deb, ["betterc0de_0.1.0_arm64.deb"])
  assert.deepEqual(arm.appImage, ["BetterC0de-0.1.0-arm64.AppImage"])
  assert.ok(arm.foreign.includes("betterc0de_0.1.0_amd64.deb"))
  assert.ok(arm.foreign.includes("betterc0de-0.1.0.x86_64.rpm"))
})

test("selection rejects architectures electron-builder is not configured for", () => {
  assert.throws(() => selectInstallers([], "linux", "ia32"), /Unsupported architecture/)
  assert.throws(() => selectInstallers([], "freebsd", "x64"), /Unsupported platform/)
})

test("single() names what it found when the count is wrong", () => {
  assert.equal(single(["a"], "installer"), "a")
  assert.throws(() => single([], "installer"), /exactly one installer, found none/)
  assert.throws(() => single(["a", "b"], "installer"), /found a, b/)
})

test("lipo output maps to the electron-builder arch names", () => {
  assert.deepEqual(parseLipoArchs("x86_64 arm64\n"), ["x86_64", "arm64"])
  assert.deepEqual(parseLipoArchs(""), [])
  assert.equal(machOArchName("x64"), "x86_64")
  assert.equal(machOArchName("arm64"), "arm64")
})

test("native module arch check skips other platforms' bundled prebuilds", () => {
  const unpacked = "BetterC0de.app/Contents/Resources/app.asar.unpacked/node_modules"
  const foreign = (file, arch) => isForeignNativeBuild(`${unpacked}/${file}`, "darwin", arch)
  // Loaded at runtime: electron-rebuild output and the matching prebuild.
  assert.equal(foreign("better-sqlite3/build/Release/better_sqlite3.node", "arm64"), false)
  assert.equal(foreign("node-pty/build/Release/pty.node", "arm64"), false)
  assert.equal(foreign("node-pty/bin/darwin-arm64-145/node-pty.node", "arm64"), false)
  assert.equal(foreign("node-pty/prebuilds/darwin-arm64/pty.node", "arm64"), false)
  assert.equal(foreign("node-pty/prebuilds/darwin-x64+arm64/pty.node", "arm64"), false)
  // Inert: the other Mac arch and other operating systems.
  assert.equal(foreign("node-pty/prebuilds/darwin-x64/pty.node", "arm64"), true)
  assert.equal(foreign("node-pty/prebuilds/win32-x64/conpty.node", "arm64"), true)
  assert.equal(foreign("node-pty/bin/darwin-x64-145/node-pty.node", "arm64"), true)
  assert.equal(foreign("node-pty/prebuilds/darwin-arm64/pty.node", "x64"), true)
})

test("reg query parsing finds this product's uninstall entry only", () => {
  const output = [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\56cb9707-d0cd-5b19-b4e0-985b27e048b7",
    "    DisplayName    REG_SZ    BetterC0de 0.1.0-beta.2",
    '    QuietUninstallString    REG_SZ    "C:\\Users\\me\\AppData\\Local\\Programs\\BetterC0de\\Uninstall BetterC0de.exe" /currentuser /S',
    "    InstallLocation    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\BetterC0de",
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other",
    "    DisplayName    REG_SZ    BetterC0de Companion Tools",
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Unrelated",
    "    DisplayName    REG_SZ    BetterC0deX",
    "",
    "End of search: 5 match(es) found.",
  ].join("\r\n")
  const entries = parseRegQuery(output)
  assert.equal(entries.length, 3)
  assert.equal(
    entries[0].values.InstallLocation,
    "C:\\Users\\me\\AppData\\Local\\Programs\\BetterC0de"
  )
  const ours = findUninstallEntries(entries, "BetterC0de")
  // "BetterC0de Companion Tools" is a prefix match by design: any entry that
  // could be this product has to block an install test on a used machine.
  assert.deepEqual(
    ours.map((entry) => entry.key.split("\\").at(-1)),
    ["56cb9707-d0cd-5b19-b4e0-985b27e048b7", "Other"]
  )
})

test("NSIS arguments keep /D= last and unquoted", () => {
  assert.deepEqual(nsisInstallArgs("C:\\Temp\\bc0de install\\BetterC0de"), [
    "/S",
    "/currentuser",
    "/D=C:\\Temp\\bc0de install\\BetterC0de",
  ])
  assert.throws(() => nsisInstallArgs('C:\\Temp\\"quoted"'), /cannot be passed/)
})

test("path comparison is case-insensitive only on Windows", () => {
  assert.equal(samePath("C:\\Temp\\App\\", "c:/temp/app", "win32"), true)
  assert.equal(samePath("/opt/App", "/opt/app", "linux"), false)
  assert.equal(samePath("/opt/App/", "/opt/App", "linux"), true)
})

test("Linux executable lookup accepts only /opt/<product>/<package>", () => {
  const listing = [
    "/.",
    "/opt",
    "/opt/BetterC0de",
    "/opt/BetterC0de/betterc0de",
    "/opt/BetterC0de/resources/app.asar",
    "/opt/BetterC0de/resources/betterc0de",
    "/usr/share/applications/betterc0de.desktop",
  ].join("\n")
  assert.equal(findLinuxExecutable(listing, "betterc0de"), "/opt/BetterC0de/betterc0de")
  assert.throws(() => findLinuxExecutable("/usr/bin/other", "betterc0de"), /found none/)
})

const NOTARIZED_CODESIGN = `Executable=/tmp/Applications/BetterC0de.app/Contents/MacOS/BetterC0de
Identifier=com.betterc0de.ide
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1023 flags=0x10000(runtime) hashes=21+7 location=embedded
Signature size=9038
Authority=Developer ID Application: Example GmbH (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=2. Oct 2026 at 10:12:03
Notarization Ticket=stapled
Info.plist entries=31
TeamIdentifier=ABCDE12345
Runtime Version=15.0.0
Sealed Resources version=2 rules=13 files=412
Internal requirements count=1 size=192`

const NOTARIZED_SPCTL = `/tmp/Applications/BetterC0de.app: accepted
source=Notarized Developer ID
origin=Developer ID Application: Example GmbH (ABCDE12345)`

const expected = { teamId: "ABCDE12345", identifier: "com.betterc0de.ide", stapled: true }

test("codesign details expose authority, team, runtime, timestamp and ticket", () => {
  assert.deepEqual(parseCodesignDetails(NOTARIZED_CODESIGN), {
    identifier: "com.betterc0de.ide",
    authorities: [
      "Developer ID Application: Example GmbH (ABCDE12345)",
      "Developer ID Certification Authority",
      "Apple Root CA",
    ],
    teamIdentifier: "ABCDE12345",
    hardenedRuntime: true,
    timestamp: "2. Oct 2026 at 10:12:03",
    notarizationTicket: "stapled",
  })
  const adhoc = parseCodesignDetails(
    "Identifier=Electron\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1\nSignature=adhoc\nTeamIdentifier=not set"
  )
  assert.deepEqual(adhoc.authorities, [])
  assert.equal(adhoc.teamIdentifier, null)
  assert.equal(adhoc.hardenedRuntime, false)
})

test("Gatekeeper's verdict and its source are parsed", () => {
  assert.deepEqual(parseSpctlAssessment(NOTARIZED_SPCTL), {
    accepted: true,
    source: "Notarized Developer ID",
    origin: "Developer ID Application: Example GmbH (ABCDE12345)",
  })
  assert.deepEqual(parseSpctlAssessment("/x/BetterC0de.app: rejected\nsource=Unnotarized Developer ID"), {
    accepted: false,
    source: "Unnotarized Developer ID",
    origin: null,
  })
})

test("a notarized, stapled Developer ID build passes", () => {
  assert.deepEqual(
    macSignatureProblems(parseCodesignDetails(NOTARIZED_CODESIGN), parseSpctlAssessment(NOTARIZED_SPCTL), expected),
    []
  )
})

test("every reason for the Gatekeeper warning is reported", () => {
  const details = parseCodesignDetails(
    NOTARIZED_CODESIGN.replace("Developer ID Application: Example GmbH (ABCDE12345)", "Apple Development: dev@example.com (XYZ)")
      .replace("TeamIdentifier=ABCDE12345", "TeamIdentifier=ZZZZZ99999")
      .replace("flags=0x10000(runtime)", "flags=0x0(none)")
      .replace(/^Timestamp=.*$/m, "")
      .replace("Notarization Ticket=stapled", "")
  )
  const problems = macSignatureProblems(
    details,
    parseSpctlAssessment("/x/BetterC0de.app: accepted\nsource=Unnotarized Developer ID"),
    expected
  )
  assert.deepEqual(problems, [
    'signed by "Apple Development: dev@example.com (XYZ)", expected a Developer ID Application certificate',
    "signed by team ZZZZZ99999, expected ABCDE12345",
    "the hardened runtime is off; notarization requires it",
    "the signature has no secure timestamp",
    "no notarization ticket is stapled; offline first launches would be blocked",
    'Gatekeeper accepts it as "Unnotarized Developer ID", not "Notarized Developer ID"',
  ])
  assert.deepEqual(
    macSignatureProblems(parseCodesignDetails(NOTARIZED_CODESIGN), parseSpctlAssessment("x: rejected"), expected),
    ["Gatekeeper rejects the app"]
  )
})
