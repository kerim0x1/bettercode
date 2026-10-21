// The settings encryption key (shared/settings-key.cjs) and the adoption of
// a legacy installation's key (shared/legacy-data.cjs), extracted from
// main.cjs and now tested directly.
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const {
  SETTINGS_KEY_FILENAME,
  createSettingsKeyStore,
} = require("../apps/shell/shared/settings-key.cjs")
const {
  adoptLegacySettingsKeyIfNeeded,
  containsValidLegacyDatabase,
  legacyDataCandidates,
} = require("../apps/shell/shared/legacy-data.cjs")

const quiet = { warn() {}, log() {} }

/** An OS keychain stand-in: "wraps" by prefixing, refuses anything else. */
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`wrapped:${text}`, "utf8"),
    decryptString: (buffer) => {
      const text = Buffer.from(buffer).toString("utf8")
      if (!text.startsWith("wrapped:")) throw new Error("not wrapped by this keychain")
      return text.slice("wrapped:".length)
    },
  }
}

function tempDir(t, label) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bc0de-${label}-`)))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("a new key is created once, stored wrapped, and read back on the next start", (t) => {
  const dataDir = tempDir(t, "settings-key")
  const adopted = []
  const store = () => createSettingsKeyStore({
    resolveDataDir: () => dataDir,
    getSafeStorage: () => fakeSafeStorage(),
    adoptLegacyKey: (keyPath) => adopted.push(keyPath),
    log: quiet,
  })
  const first = store()
  const key = first.ensureSettingsEncryptionKey()
  assert.equal(Buffer.from(key, "base64").length, 32)
  assert.equal(first.getSecretsEncryptionAvailable(), true)
  const keyPath = path.join(dataDir, SETTINGS_KEY_FILENAME)
  assert.equal(fs.readFileSync(keyPath, "utf8"), `wrapped:${key}`, "only the wrapped key is on disk")
  assert.deepEqual(adopted, [keyPath], "legacy adoption is tried before a key is created")
  assert.deepEqual(fs.readdirSync(dataDir), [SETTINGS_KEY_FILENAME], "no staging file is left behind")
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600)
  }

  assert.equal(store().ensureSettingsEncryptionKey(), key)
})

test("a key file that cannot be unwrapped is never replaced", (t) => {
  const dataDir = tempDir(t, "settings-key")
  const keyPath = path.join(dataDir, SETTINGS_KEY_FILENAME)
  fs.writeFileSync(keyPath, "wrapped by another machine")
  const store = createSettingsKeyStore({
    resolveDataDir: () => dataDir,
    getSafeStorage: () => fakeSafeStorage(),
    log: quiet,
  })
  assert.throws(() => store.ensureSettingsEncryptionKey(), /refusing to replace it/)
  assert.equal(fs.readFileSync(keyPath, "utf8"), "wrapped by another machine")
})

test("without OS credential storage settings stay plaintext, unless encrypted data already exists", (t) => {
  const dataDir = tempDir(t, "settings-key")
  const store = () => createSettingsKeyStore({
    resolveDataDir: () => dataDir,
    getSafeStorage: () => fakeSafeStorage({ available: false }),
    log: quiet,
  })
  const plain = store()
  assert.equal(plain.ensureSettingsEncryptionKey(), "")
  assert.equal(plain.getSecretsEncryptionAvailable(), false)

  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ apiKey: "enc:v1:abc" }))
  assert.throws(() => store().ensureSettingsEncryptionKey(), /Encrypted settings exist/)

  fs.rmSync(path.join(dataDir, "settings.json"))
  fs.writeFileSync(path.join(dataDir, SETTINGS_KEY_FILENAME), "wrapped:x")
  assert.throws(() => store().ensureSettingsEncryptionKey(), /Encrypted settings key exists/)
})

test("availability is read from the keychain when no key was requested yet", () => {
  const unavailable = createSettingsKeyStore({
    resolveDataDir: () => { throw new Error("not needed") },
    getSafeStorage: () => { throw new Error("no keychain module") },
  })
  assert.equal(unavailable.getSecretsEncryptionAvailable(), false)
})

test("legacy candidates follow the backend migration's order and keep dev data separate", () => {
  const home = path.resolve("/home/me")
  const devTarget = path.join(home, ".betterc0de-dev", "userdata", "betterc0de.db")
  assert.deepEqual(legacyDataCandidates(devTarget, { home }), [path.join(home, ".betterc0de-dev")])

  const target = path.join(home, ".betterc0de", "userdata", "betterc0de.db")
  assert.deepEqual(
    legacyDataCandidates(target, { home, platform: "win32", env: { APPDATA: path.resolve("/roaming") } }),
    [path.join(home, ".betterc0de"), path.join(path.resolve("/roaming"), "betterc0de")],
  )
  assert.deepEqual(
    legacyDataCandidates(target, { home, platform: "darwin", env: {} }),
    [path.join(home, ".betterc0de"), path.join(home, "Library", "Application Support", "betterc0de")],
  )
  assert.deepEqual(
    legacyDataCandidates(target, { home, platform: "linux", env: {} }),
    [path.join(home, ".betterc0de"), path.join(home, ".config", "betterc0de")],
  )
  assert.throws(() => legacyDataCandidates(target, {}), /home directory/)
})

/** better-sqlite3 stand-in: every opened database is intact with one table. */
class HealthyDatabase {
  pragma() { return "ok" }
  prepare() { return { get: () => ({ count: 1 }) } }
  close() {}
}

function legacyInstall(t, { settings = '{"key":"enc:v1:abc"}', wrappedKey } = {}) {
  const home = tempDir(t, "legacy-home")
  const legacyDir = path.join(home, ".betterc0de")
  fs.mkdirSync(legacyDir)
  fs.writeFileSync(path.join(legacyDir, "betterc0de.db"), Buffer.alloc(64, 1))
  fs.writeFileSync(path.join(legacyDir, "settings.json"), settings)
  const key = crypto.randomBytes(32).toString("base64")
  fs.writeFileSync(path.join(legacyDir, SETTINGS_KEY_FILENAME), wrappedKey ?? `wrapped:${key}`)
  const targetDir = path.join(legacyDir, "userdata")
  fs.mkdirSync(targetDir)
  return { home, key, targetKeyPath: path.join(targetDir, SETTINGS_KEY_FILENAME) }
}

test("the wrapped key of the installation whose database is migrated is adopted", (t) => {
  const { home, key, targetKeyPath } = legacyInstall(t)
  adoptLegacySettingsKeyIfNeeded(targetKeyPath, fakeSafeStorage(), {
    home, platform: "linux", env: {}, Database: HealthyDatabase,
  })
  assert.equal(fs.readFileSync(targetKeyPath, "utf8"), `wrapped:${key}`)
})

test("a legacy key the keychain cannot unwrap is not adopted", (t) => {
  const { home, targetKeyPath } = legacyInstall(t, { wrappedKey: "garbage" })
  assert.throws(
    () => adoptLegacySettingsKeyIfNeeded(targetKeyPath, fakeSafeStorage(), {
      home, platform: "linux", env: {}, Database: HealthyDatabase,
    }),
    /not wrapped by this keychain/,
  )
  assert.equal(fs.existsSync(targetKeyPath), false)
})

test("encrypted target settings without a recoverable legacy key are refused", (t) => {
  const home = tempDir(t, "legacy-home")
  const targetDir = path.join(home, ".betterc0de", "userdata")
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, "settings.json"), '{"key":"enc:v1:abc"}')
  assert.throws(
    () => adoptLegacySettingsKeyIfNeeded(path.join(targetDir, SETTINGS_KEY_FILENAME), fakeSafeStorage(), {
      home, platform: "linux", env: {}, Database: HealthyDatabase,
    }),
    /no matching recoverable settings key/,
  )
})

test("plaintext legacy settings need no key; an existing target key is kept", (t) => {
  const { home, targetKeyPath } = legacyInstall(t, { settings: '{"key":"plain"}' })
  adoptLegacySettingsKeyIfNeeded(targetKeyPath, fakeSafeStorage(), {
    home, platform: "linux", env: {}, Database: HealthyDatabase,
  })
  assert.equal(fs.existsSync(targetKeyPath), false)

  fs.writeFileSync(targetKeyPath, "already here")
  adoptLegacySettingsKeyIfNeeded(targetKeyPath, fakeSafeStorage(), { home, Database: HealthyDatabase })
  assert.equal(fs.readFileSync(targetKeyPath, "utf8"), "already here")
})

test("legacy database validity: missing, tiny, corrupt and empty files do not count", (t) => {
  const directory = tempDir(t, "legacy-db")
  const file = path.join(directory, "betterc0de.db")
  assert.equal(containsValidLegacyDatabase(file, { Database: HealthyDatabase }), false)
  fs.writeFileSync(file, "tiny")
  assert.equal(containsValidLegacyDatabase(file, { Database: HealthyDatabase }), false)
  fs.writeFileSync(file, Buffer.alloc(64, 1))
  class Corrupt {
    constructor() { throw Object.assign(new Error("file is not a database"), { code: "SQLITE_NOTADB" }) }
  }
  assert.equal(containsValidLegacyDatabase(file, { Database: Corrupt }), false)
  class Empty extends HealthyDatabase {
    prepare() { return { get: () => ({ count: 0 }) } }
  }
  assert.equal(containsValidLegacyDatabase(file, { Database: Empty }), false)
  assert.equal(containsValidLegacyDatabase(file, { Database: HealthyDatabase }), true)
})
