/**
 * Adoption of a legacy installation's settings key.
 *
 * Older builds kept their data in other directories (Roaming AppData,
 * `~/Library/Application Support`, `~/.config`, …). The backend migrates the
 * settings file and the SQLite snapshot from the first valid candidate
 * (apps/backend/src/persistence/migrateLegacyDb.ts); before that, the main
 * process must adopt the matching wrapped `settings-key.bin`, or the migrated
 * encrypted settings could never be decrypted.
 *
 * The candidate list and the database validity check must stay identical to
 * the backend migration.
 */

const fs = require("fs")
const path = require("path")
const {
  SETTINGS_KEY_FILENAME,
  decryptSettingsKeyBytes,
  publishBufferAtomicallyIfAbsentSync,
  readBoundedRegularFileSync,
} = require("./settings-key.cjs")

/**
 * Data directories of earlier installations, in the backend migration's
 * order. A development data directory only ever looks at other development
 * data.
 */
function legacyDataCandidates(
  targetDbPath,
  { home, platform = process.platform, env = process.env } = {},
) {
  if (typeof home !== "string" || !home) {
    throw new TypeError("legacyDataCandidates needs the user's home directory")
  }
  const devRoot = path.resolve(home, ".betterc0de-dev")
  const resolvedTarget = path.resolve(targetDbPath)
  const relativeToDevRoot = path.relative(devRoot, resolvedTarget)
  if (
    relativeToDevRoot === "" ||
    (
      !relativeToDevRoot.startsWith("..") &&
      !path.isAbsolute(relativeToDevRoot)
    )
  ) {
    // Development data must never silently import production credentials.
    return [devRoot]
  }
  const candidates = [path.join(home, ".betterc0de")]
  if (platform === "win32") {
    candidates.push(
      path.join(
        env.APPDATA || path.join(home, "AppData", "Roaming"),
        "betterc0de",
      ),
    )
  } else if (platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "betterc0de"),
    )
  } else {
    candidates.push(
      path.join(
        env.XDG_CONFIG_HOME || path.join(home, ".config"),
        "betterc0de",
      ),
    )
  }
  return candidates
}

/**
 * True when `filePath` is an intact SQLite database with at least one user
 * table. `Database` is better-sqlite3 (injectable for tests).
 */
function containsValidLegacyDatabase(filePath, { Database } = {}) {
  const SqliteDatabase = Database ?? require("better-sqlite3")
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`SQLite migration path is not a regular file: ${filePath}`)
  }
  if (stat.size < 16) return false

  let db = null
  try {
    db = new SqliteDatabase(filePath, { readonly: true, fileMustExist: true })
    const quickCheck = db.pragma("quick_check", { simple: true })
    if (quickCheck !== "ok") return false
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .get()
    return Number(row?.count) > 0
  } catch (error) {
    const code = String(error?.code || "").toUpperCase()
    if (
      code === "SQLITE_CORRUPT" ||
      code === "SQLITE_NOTADB" ||
      code === "SQLITE_FORMAT"
    ) {
      return false
    }
    throw error
  } finally {
    db?.close()
  }
}

/**
 * Adopt only the wrapped legacy key before provisioning a new one. The
 * backend subsequently migrates settings first and the SQLite snapshot last.
 * This ordering ensures the raw key passed to the backend matches encrypted
 * legacy settings even on the very first migrated boot.
 *
 * `options.home` is the user's home directory; `platform`, `env` and
 * `Database` are injectable for tests.
 */
function adoptLegacySettingsKeyIfNeeded(targetKeyPath, safeStorage, options = {}) {
  if (fs.existsSync(targetKeyPath)) return
  const targetSettingsPath = path.join(
    path.dirname(targetKeyPath),
    "settings.json",
  )
  let targetSettings = null
  let targetSettingsEncrypted = false
  if (fs.existsSync(targetSettingsPath)) {
    targetSettings = readBoundedRegularFileSync(
      targetSettingsPath,
      16 * 1024 * 1024,
    )
    // Plaintext target settings do not need a legacy encryption identity.
    targetSettingsEncrypted = targetSettings.includes(
      Buffer.from("enc:v1:", "utf8"),
    )
    if (!targetSettingsEncrypted) return
  }

  const targetDbPath = path.join(path.dirname(targetKeyPath), "betterc0de.db")
  for (const sourceDir of legacyDataCandidates(targetDbPath, options)) {
    if (path.resolve(sourceDir) === path.resolve(path.dirname(targetKeyPath))) {
      continue
    }
    const sourceDb = path.join(sourceDir, "betterc0de.db")
    const sourceSettings = path.join(sourceDir, "settings.json")
    if (!containsValidLegacyDatabase(sourceDb, options)) continue
    // Keep candidate ordering identical to the backend migration. Once a
    // database candidate wins, never borrow a key from a later installation.
    if (!fs.existsSync(sourceSettings)) {
      if (targetSettingsEncrypted) {
        throw new Error(
          `Encrypted target settings have no matching legacy settings at ${sourceDir}`,
        )
      }
      return
    }
    const settings = readBoundedRegularFileSync(
      sourceSettings,
      16 * 1024 * 1024,
    )
    if (targetSettings && !targetSettings.equals(settings)) {
      throw new Error(
        `Encrypted target settings do not match the selected legacy database at ${sourceDir}`,
      )
    }
    if (!settings.includes(Buffer.from("enc:v1:", "utf8"))) {
      if (targetSettingsEncrypted) {
        throw new Error(
          `Encrypted target settings do not have an encrypted legacy companion at ${sourceDir}`,
        )
      }
      return
    }

    const sourceKey = path.join(sourceDir, SETTINGS_KEY_FILENAME)
    if (!fs.existsSync(sourceKey)) {
      throw new Error(
        `Encrypted legacy settings at ${sourceDir} have no ${SETTINGS_KEY_FILENAME}`,
      )
    }
    const wrappedKey = readBoundedRegularFileSync(sourceKey, 1024 * 1024)
    // Validate the OS-bound ciphertext before publishing it. A moved/corrupt
    // legacy key must not become an immutable target file that blocks all
    // subsequent recovery attempts.
    decryptSettingsKeyBytes(safeStorage, wrappedKey)
    publishBufferAtomicallyIfAbsentSync(
      targetKeyPath,
      wrappedKey,
      "settings-key-migration",
    )
    console.log(`[electron] Adopted legacy ${SETTINGS_KEY_FILENAME}`)
    return
  }
  if (targetSettingsEncrypted) {
    throw new Error(
      "Encrypted settings exist, but no matching recoverable settings key was found",
    )
  }
}

module.exports = {
  adoptLegacySettingsKeyIfNeeded,
  containsValidLegacyDatabase,
  legacyDataCandidates,
}
