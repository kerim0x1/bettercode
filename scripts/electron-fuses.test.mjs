import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const hook = require("./after-pack-fuses.cjs")
const fuses = require("@electron/fuses")
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const entitlements = readFileSync(new URL("../apps/shell/build/entitlements.mac.plist", import.meta.url), "utf8")

test("packaged builds flip the hardening fuses, keeping RunAsNode for the forked backend", () => {
  assert.deepEqual({ ...hook.ELECTRON_FUSES }, {
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  })
  const { FuseV1Options, FuseVersion } = fuses
  const config = hook.buildFuseConfig(fuses, "win32")
  assert.equal(config.version, FuseVersion.V1)
  assert.equal(config.resetAdHocDarwinSignature, false)
  assert.equal(config[FuseV1Options.RunAsNode], true)
  assert.equal(config[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false)
  assert.equal(config[FuseV1Options.EnableNodeCliInspectArguments], false)
  assert.equal(config[FuseV1Options.OnlyLoadAppFromAsar], true)
  // file:// still serves the renderer, so this fuse is left as Electron ships it.
  assert.equal(FuseV1Options.GrantFileProtocolExtraPrivileges in config, false)
  // Unsigned Apple Silicon builds must be re-signed ad hoc after flipping.
  assert.equal(hook.buildFuseConfig(fuses, "darwin").resetAdHocDarwinSignature, true)
})

test("the hook flips through electron-builder and refuses a binary whose fuses did not change", async () => {
  const { FuseV1Options } = fuses
  const flipped = []
  const wire = { version: "1" }
  for (const option of Object.values(FuseV1Options).filter((value) => typeof value === "number")) {
    wire[option] = 0x31
  }
  const context = {
    appOutDir: path.join("release", "win-unpacked"),
    electronPlatformName: "win32",
    packager: {
      appInfo: { productFilename: "BetterC0de" },
      addElectronFuses: async (ctx, config) => { flipped.push(config) },
    },
  }
  assert.equal(hook.electronBinaryPath(context), path.join("release", "win-unpacked", "BetterC0de.exe"))
  assert.equal(
    hook.electronBinaryPath({ ...context, electronPlatformName: "darwin" }),
    path.join("release", "win-unpacked", "BetterC0de.app"),
  )

  // Electron's defaults (everything on) must fail the read-back.
  assert.throws(() => hook.assertFuseWire(fuses, wire), /EnableNodeOptionsEnvironmentVariable/)
  wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable] = 0x30
  wire[FuseV1Options.EnableNodeCliInspectArguments] = 0x30
  assert.doesNotThrow(() => hook.assertFuseWire(fuses, wire))
  assert.equal(flipped.length, 0)
})

test("package.json runs the fuse hook after packing", () => {
  assert.equal(manifest.build.afterPack, "scripts/after-pack-fuses.cjs")
  assert.ok(manifest.devDependencies["@electron/fuses"], "@electron/fuses is a direct devDependency")
  assert.equal(typeof hook, "function")
  assert.equal(hook.afterPack, hook)
})

test("macOS entitlements grant no DYLD injection and no sandbox-only keys", () => {
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])
  assert.deepEqual(keys, [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ])
})
