// [PACKAGING] electron-builder `afterPack` hook: flips the Electron fuses of
// every packaged build, then reads them back and fails the build if any is
// not in the state below.
//
// Fuses are bits compiled into the Electron binary that switch off runtime
// features an installed app does not need but an attacker on the same
// machine could use to run code under BetterC0de's identity (and on macOS
// inherit its privacy grants, such as the microphone). They are flipped here,
// after packing and before electron-builder signs the app, so a signed build
// carries them inside its signature. Development runs (`npm run dev`) use the
// stock Electron binary and are unaffected.
//
// The hook goes through electron-builder's documented
// `packager.addElectronFuses` so binary paths and the universal-build handling
// match electron-builder's own; `@electron/fuses` (a direct devDependency)
// supplies the option enums and the read-back.

const path = require("path")

/**
 * The fuse state of every packaged build. Each comment says why.
 */
const ELECTRON_FUSES = Object.freeze({
  // ON, deliberately. The backend is started with `child_process.fork()`,
  // which re-runs this Electron binary with ELECTRON_RUN_AS_NODE=1 (main.cjs
  // startSpawnedBackend). Turning the fuse off would stop the backend from
  // starting. It can be turned off once the backend runs in an Electron
  // `utilityProcess` instead of a forked child.
  runAsNode: true,
  // Chromium's cookie store is encrypted with the OS key store, like Chrome.
  // One-way: turning it off again would leave existing cookies unreadable.
  enableCookieEncryption: true,
  // NODE_OPTIONS (e.g. `--require evil.js`) and NODE_EXTRA_CA_CERTS are
  // ignored, in the app and in the forked backend.
  enableNodeOptionsEnvironmentVariable: false,
  // `--inspect`, `--inspect-brk` and SIGUSR1 cannot attach a debugger.
  enableNodeCliInspectArguments: false,
  // app.asar is checked against the hash electron-builder embeds (macOS
  // Info.plist, Windows resource); Linux has no embedded hash and ignores it.
  enableEmbeddedAsarIntegrityValidation: true,
  // Only app.asar is loaded, never a loose `resources/app` folder next to it.
  onlyLoadAppFromAsar: true,
})

const FUSE_OPTION_NAMES = Object.freeze({
  runAsNode: "RunAsNode",
  enableCookieEncryption: "EnableCookieEncryption",
  enableNodeOptionsEnvironmentVariable: "EnableNodeOptionsEnvironmentVariable",
  enableNodeCliInspectArguments: "EnableNodeCliInspectArguments",
  enableEmbeddedAsarIntegrityValidation: "EnableEmbeddedAsarIntegrityValidation",
  onlyLoadAppFromAsar: "OnlyLoadAppFromAsar",
})

// Wire bytes (`@electron/fuses` FuseState): ASCII "1" / "0".
const FUSE_ENABLED = 0x31
const FUSE_DISABLED = 0x30

function loadFusesModule() {
  return require("@electron/fuses")
}

/** The `@electron/fuses` config for one platform. */
function buildFuseConfig(fusesModule, electronPlatformName) {
  const { FuseVersion, FuseV1Options } = fusesModule
  const config = {
    version: FuseVersion.V1,
    // Flipping a fuse edits the binary and invalidates its signature. Release
    // macOS builds are not signed by a certificate, and Apple Silicon refuses
    // to run a binary whose ad-hoc signature no longer matches, so re-sign
    // ad hoc. A certificate-signed build is signed again right after this.
    resetAdHocDarwinSignature: electronPlatformName === "darwin" || electronPlatformName === "mas",
  }
  for (const [key, enabled] of Object.entries(ELECTRON_FUSES)) {
    const option = FuseV1Options[FUSE_OPTION_NAMES[key]]
    if (typeof option !== "number") {
      throw new Error(`@electron/fuses does not know the ${FUSE_OPTION_NAMES[key]} fuse`)
    }
    config[option] = enabled
  }
  return config
}

/** Same path electron-builder's `addElectronFuses` flips. */
function electronBinaryPath(context) {
  const { appOutDir, electronPlatformName, packager } = context
  if (electronPlatformName === "darwin" || electronPlatformName === "mas") {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`)
  }
  if (electronPlatformName === "win32") {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.exe`)
  }
  return path.join(appOutDir, packager.executableName || packager.appInfo.productFilename)
}

/** Throws unless every fuse in `ELECTRON_FUSES` reads back as configured. */
function assertFuseWire(fusesModule, wire) {
  const { FuseV1Options } = fusesModule
  const wrong = []
  for (const [key, enabled] of Object.entries(ELECTRON_FUSES)) {
    const name = FUSE_OPTION_NAMES[key]
    const actual = wire[FuseV1Options[name]]
    const expected = enabled ? FUSE_ENABLED : FUSE_DISABLED
    if (actual !== expected) {
      wrong.push(`${name}: expected ${enabled ? "on" : "off"}, found byte ${actual}`)
    }
  }
  if (wrong.length > 0) {
    throw new Error(`Electron fuses were not applied:\n  ${wrong.join("\n  ")}`)
  }
}

async function afterPack(context) {
  const fusesModule = loadFusesModule()
  const config = buildFuseConfig(fusesModule, context.electronPlatformName)
  await context.packager.addElectronFuses(context, config)
  const binary = electronBinaryPath(context)
  assertFuseWire(fusesModule, await fusesModule.getCurrentFuseWire(binary))
  console.log(`[after-pack-fuses] fuses verified for ${binary}`)
}

module.exports = afterPack
module.exports.default = afterPack
module.exports.afterPack = afterPack
module.exports.ELECTRON_FUSES = ELECTRON_FUSES
module.exports.buildFuseConfig = buildFuseConfig
module.exports.assertFuseWire = assertFuseWire
module.exports.electronBinaryPath = electronBinaryPath
