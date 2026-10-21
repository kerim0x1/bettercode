// @ts-check
/**
 * The settings encryption key (`settings-key.bin`).
 *
 * Provision (or load) the symmetric key used by the backend to encrypt
 * provider API keys in settings.json. The raw 32-byte key is kept only in
 * memory; on disk we store the OS-bound ciphertext produced by Electron's
 * `safeStorage` (backed by DPAPI on Windows, Keychain on macOS, and
 * libsecret / kwallet on Linux). When safeStorage is unavailable — e.g.
 * Linux without a working keyring — we skip key provisioning and the
 * backend transparently falls back to plaintext settings, matching the
 * pre-encryption behaviour rather than blocking the app.
 *
 * `ensureSettingsEncryptionKey` must be called after `app.whenReady()`.
 * main.cjs owns the call (after the first window exists, before the backend
 * starts); this module only holds the logic and the file helpers that the
 * legacy-data adoption (shared/legacy-data.cjs) shares.
 */

const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

const SETTINGS_KEY_FILENAME = "settings-key.bin"

/**
 * The part of Electron's `safeStorage` this module uses.
 * @typedef {object} SafeStorageLike
 * @property {() => boolean} isEncryptionAvailable
 * @property {(plainText: string) => Buffer} encryptString
 * @property {(encrypted: Buffer) => string} decryptString
 */

/**
 * Read a regular, non-symlinked file of at most `maxBytes`, refusing a file
 * that is swapped or truncated while it is open.
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Buffer}
 */
function readBoundedRegularFileSync(filePath, maxBytes) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error(`Unsafe or oversized legacy companion: ${filePath}`)
  }
  const noFollow =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = fs.fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      // Node can report a volume identifier from fstat() while path-based
      // stat() reports dev=0 on Windows. The inode/file index remains the
      // stable identity there; POSIX requires both device and inode.
      (process.platform !== "win32" && opened.dev !== stat.dev) ||
      opened.ino !== stat.ino
    ) {
      throw new Error(`Legacy companion changed while opening: ${filePath}`)
    }
    const bytes = Buffer.allocUnsafe(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    if (offset !== bytes.length) {
      throw new Error(`Legacy companion was truncated while reading: ${filePath}`)
    }
    return bytes
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Durably publish `bytes` at `targetPath` unless something already exists
 * there. Returns true when this call created the file, false when another
 * writer won.
 * @param {string} targetPath
 * @param {Buffer} bytes
 * @param {string} temporaryPrefix
 * @returns {boolean}
 */
function publishBufferAtomicallyIfAbsentSync(
  targetPath,
  bytes,
  temporaryPrefix,
) {
  const directory = path.dirname(targetPath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const staged = path.join(
    directory,
    `.${temporaryPrefix}-${crypto.randomUUID()}.tmp`,
  )
  const fd = fs.openSync(
    staged,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  )
  try {
    let offset = 0
    while (offset < bytes.length) {
      offset += fs.writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
    }
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.linkSync(staged, targetPath)
    // The staged file contents are durable above; persist the new directory
    // entry as well before the backend can write settings encrypted by this
    // key. Windows does not support opening directories through Node's fs API
    // consistently, so its filesystem/OS remains the durability boundary.
    if (process.platform !== "win32") {
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY)
      try {
        fs.fsyncSync(directoryFd)
      } finally {
        fs.closeSync(directoryFd)
      }
    }
    return true
  } catch (error) {
    try {
      fs.lstatSync(targetPath)
      return false
    } catch (targetError) {
      if (/** @type {NodeJS.ErrnoException} */ (targetError)?.code !== "ENOENT") throw targetError
      throw error
    }
  } finally {
    fs.rmSync(staged, { force: true })
  }
}

/**
 * Unwrap an OS-bound key and check that it is a base64 32-byte key.
 * @param {SafeStorageLike} safeStorage
 * @param {Buffer} wrapped
 * @returns {string} the base64 key
 */
function decryptSettingsKeyBytes(safeStorage, wrapped) {
  const keyB64 = safeStorage.decryptString(wrapped)
  if (typeof keyB64 !== "string" || keyB64.length === 0) {
    throw new Error("settings-key.bin decrypted to an empty key")
  }
  const decoded = Buffer.from(keyB64, "base64")
  if (decoded.length !== 32) {
    throw new Error("settings-key.bin does not contain a 32-byte key")
  }
  return keyB64
}

/**
 * @param {SafeStorageLike} safeStorage
 * @param {string} keyPath
 * @returns {string} the base64 key
 */
function decryptSettingsKeyFile(safeStorage, keyPath) {
  const wrapped = readBoundedRegularFileSync(keyPath, 1024 * 1024)
  return decryptSettingsKeyBytes(safeStorage, wrapped)
}

/**
 * @typedef {object} SettingsKeyStoreOptions
 * @property {() => string} resolveDataDir The BetterC0de data directory (created on demand).
 * @property {(keyPath: string, safeStorage: SafeStorageLike) => void} [adoptLegacyKey]
 *   Adopts a wrapped key from a legacy installation before a new one is made.
 * @property {() => SafeStorageLike} [getSafeStorage] Defaults to Electron's `safeStorage`.
 * @property {Pick<Console, "warn">} [log]
 */

/**
 * @typedef {object} SettingsKeyStore
 * @property {() => string} ensureSettingsEncryptionKey
 *   The base64 key, or "" when OS credential storage is unavailable.
 * @property {() => boolean} getSecretsEncryptionAvailable
 *   Whether the OS keyring is available (surfaced to the renderer by `app:info`).
 */

/**
 * @param {SettingsKeyStoreOptions} options
 * @returns {SettingsKeyStore}
 */
function createSettingsKeyStore({
  resolveDataDir,
  adoptLegacyKey = () => {},
  getSafeStorage = () => require("electron").safeStorage,
  log = console,
}) {
  // S4: track once whether the OS keyring is available so the renderer can
  // show a persistent warning banner when API keys are stored in plaintext.
  // Set during the first call to `ensureSettingsEncryptionKey` and surfaced
  // via the AppInfo handler.
  /** @type {boolean | null} */
  let secretsEncryptionAvailable = null

  function getSecretsEncryptionAvailable() {
    if (secretsEncryptionAvailable === null) {
      try {
        const safeStorage = getSafeStorage()
        secretsEncryptionAvailable = !!safeStorage.isEncryptionAvailable()
      } catch {
        secretsEncryptionAvailable = false
      }
    }
    return secretsEncryptionAvailable
  }

  function ensureSettingsEncryptionKey() {
    const safeStorage = getSafeStorage()

    if (!safeStorage.isEncryptionAvailable()) {
      secretsEncryptionAvailable = false
      const dataDir = resolveDataDir()
      const existingKeyPath = path.join(dataDir, SETTINGS_KEY_FILENAME)
      const existingSettingsPath = path.join(dataDir, "settings.json")
      if (fs.existsSync(existingKeyPath)) {
        throw new Error(
          "Encrypted settings key exists, but OS credential storage is unavailable",
        )
      }
      if (fs.existsSync(existingSettingsPath)) {
        const settingsBytes = readBoundedRegularFileSync(
          existingSettingsPath,
          16 * 1024 * 1024,
        )
        if (settingsBytes.includes(Buffer.from("enc:v1:", "utf8"))) {
          throw new Error(
            "Encrypted settings exist, but OS credential storage is unavailable",
          )
        }
      }
      log.warn("[electron] safeStorage unavailable — provider API keys will remain plaintext on disk")
      return ""
    }
    secretsEncryptionAvailable = true

    const keyPath = path.join(resolveDataDir(), SETTINGS_KEY_FILENAME)
    adoptLegacyKey(keyPath, safeStorage)
    try {
      return decryptSettingsKeyFile(safeStorage, keyPath)
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== "ENOENT") {
        throw new Error(
          "Existing settings-key.bin could not be read or decrypted; refusing to replace it",
          { cause: err },
        )
      }
    }

    const keyB64 = crypto.randomBytes(32).toString("base64")
    const wrapped = safeStorage.encryptString(keyB64)
    publishBufferAtomicallyIfAbsentSync(
      keyPath,
      wrapped,
      "settings-key-create",
    )
    // A concurrent creator may have won the no-overwrite publish. Always read
    // the durable winner rather than returning an unpublished in-memory key.
    return decryptSettingsKeyFile(safeStorage, keyPath)
  }

  return { ensureSettingsEncryptionKey, getSecretsEncryptionAvailable }
}

module.exports = {
  SETTINGS_KEY_FILENAME,
  createSettingsKeyStore,
  decryptSettingsKeyBytes,
  decryptSettingsKeyFile,
  publishBufferAtomicallyIfAbsentSync,
  readBoundedRegularFileSync,
}
