import fs from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { logger } from "../observability/logger"

/**
 * One-shot migration from any pre-BetterC0de-layout data directories into the
 * current `~/.betterc0de[-dev]/userdata/` location chosen by `defaultDataDir`
 * (apps/backend/src/config.ts) or by the desktop's `resolveUserDataDir`
 * (apps/shell/shared/runtime-paths.cjs). The desktop adopts a legacy
 * installation's settings key first, with the same candidate list
 * (apps/shell/shared/legacy-data.cjs).
 *
 * Legacy locations probed, newest-first (first match with real data wins):
 *   1. `~/.betterc0de/betterc0de.db`              — super-legacy flat layout
 *   2. `%APPDATA%/betterc0de/betterc0de.db`       — Electron Roaming (Windows)
 *   3. `~/Library/Application Support/betterc0de` — macOS platform userData
 *   4. `~/.config/betterc0de/betterc0de.db`       — Linux XDG userData
 *
 * Only publishes a database when:
 *   - the target DB is absent or fails SQLite validation
 *   - target and source paths differ (no-op if the user already lives here)
 *   - the source DB passes SQLite `quick_check` and contains application tables
 *
 * SQLite's online snapshot path incorporates committed WAL contents. The
 * encryption key is published atomically before encrypted settings, and both
 * companions are committed before the validated database becomes the
 * migration's durable completion marker.
 *
 * Idempotent: subsequent starts validate the target and can repair an exact
 * encrypted-settings/missing-key companion pair left by an older migration.
 * Integrity or identity conflicts fail closed so startup never silently
 * replaces an existing installation with an empty or undecryptable state.
 */
export function migrateLegacyDbIfNeeded(targetDbPath: string): void {
  let releaseMigrationLock: (() => void) | null = null
  let migrationFailed = false
  let migrationError: unknown
  let releaseFailed = false
  let releaseError: unknown
  try {
    fs.mkdirSync(path.dirname(targetDbPath), { recursive: true })
    releaseMigrationLock = acquireMigrationLock(targetDbPath)
    const runMigration = (): void => {
      let marker = readMigrationMarker(targetDbPath)
      const targetState = inspectDatabase(targetDbPath)

      if (marker && targetState === "valid") {
        if (marker.phase === "prepared") {
          throw new Error(
            "A valid target database appeared before the recorded companion phase completed."
          )
        }
        assertTargetCompanionsMatchMarker(targetDbPath, marker)
        removeMigrationMarker(targetDbPath)
        logger.info(
          { source: marker.sourceDir, target: path.dirname(targetDbPath) },
          "Completed an interrupted legacy data migration"
        )
        return
      }

      if (targetState === "valid") {
        // Repair a companion copy interrupted by an older release after it had
        // already published the database, but never import settings into an
        // otherwise independent valid target. Exact encrypted settings must
        // already exist at the target and only the key may be missing.
        const targetDir = path.dirname(targetDbPath)
        const targetSettings = path.join(targetDir, "settings.json")
        const targetKey = path.join(targetDir, "settings-key.bin")
        if (fs.existsSync(targetSettings) && !fs.existsSync(targetKey)) {
          const targetSettingsBytes = readRegularFileBounded(
            targetSettings,
            MAX_LEGACY_SETTINGS_BYTES
          )
          if (targetSettingsBytes.includes(Buffer.from("enc:v1:", "utf8"))) {
            const source = pickLegacySource(targetDbPath)
            if (source) {
              migrateSettingsCompanions(source.dir, targetDir)
            }
          }
        }
        return
      }

      const source = marker
        ? sourceFromMigrationMarker(targetDbPath, marker)
        : pickLegacySource(targetDbPath)
      if (!source) return

      const targetDir = path.dirname(targetDbPath)
      if (!marker) {
        marker = createMigrationMarker(targetDbPath, source)
      }
      migrateSettingsCompanions(source.dir, targetDir)
      marker = updateMigrationMarkerPhase(
        targetDbPath,
        marker,
        "companions_published"
      )
      migrateSqliteSnapshot(source.dbPath, targetDbPath)
      marker = updateMigrationMarkerPhase(
        targetDbPath,
        marker,
        "database_published"
      )
      removeMigrationMarker(targetDbPath)

      logger.info(
        { source: source.dir, target: targetDir },
        "Migrated legacy data dir to ~/.betterc0de/userdata"
      )
    }
    runMigration()
  } catch (err) {
    migrationFailed = true
    migrationError = err
    logger.error(
      { err: (err as Error).message, target: targetDbPath },
      "Legacy data migration failed; refusing to start with an empty or partial database"
    )
  } finally {
    if (releaseMigrationLock) {
      try {
        releaseMigrationLock()
      } catch (error) {
        releaseFailed = true
        releaseError = error
        logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            target: targetDbPath,
          },
          "Could not safely release the legacy migration lock"
        )
      }
    }
  }
  if (releaseFailed) {
    if (migrationFailed) {
      throw new AggregateError(
        [migrationError, releaseError],
        "Legacy migration failed and its interprocess lock could not be released safely."
      )
    }
    throw releaseError
  }
  if (migrationFailed) throw migrationError
}

const MAX_LEGACY_SETTINGS_BYTES = 16 * 1024 * 1024
const MAX_LEGACY_WRAPPED_KEY_BYTES = 1024 * 1024
const MAX_MIGRATION_LOCK_BYTES = 4 * 1024
const MIGRATION_LOCK_STALE_MS = 10 * 60 * 1000
const MIGRATION_MARKER_FILENAME = ".betterc0de-legacy-migration.json"
const MAX_MIGRATION_MARKER_BYTES = 16 * 1024

type LegacySource = { dir: string; dbPath: string }
type MigrationPhase = "prepared" | "companions_published" | "database_published"

interface MigrationMarker {
  version: 1
  sourceDir: string
  sourceDbPath: string
  sourceDev: string
  sourceIno: string
  targetSettingsHash: string | null
  targetKeyHash: string | null
  phase: MigrationPhase
  createdAt: string
}

function processAppearsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // EPERM is a protected or foreign process, not proof that this migration
    // owner is still running. The database lock in db.ts dropped the same
    // check because a recycled pid otherwise blocks every later start.
    return false
  }
}

function sameFileEntry(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  // Path-based Windows stats report dev=0 while handle stats expose the
  // volume serial. The NTFS file index remains stable for the same entry.
  return (
    left.ino === right.ino &&
    (process.platform === "win32" || left.dev === right.dev)
  )
}

function syncDirectory(directoryPath: string): void {
  if (process.platform === "win32") return
  const handle = fs.openSync(directoryPath, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
}

function acquireMigrationLock(targetDbPath: string): () => void {
  const lockPath = path.join(
    path.dirname(targetDbPath),
    ".betterc0de-legacy-migration.lock"
  )
  const nonce = randomUUID()
  const lockBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      pid: process.pid,
      createdAt: Date.now(),
      nonce,
    }),
    "utf8"
  )
  const noFollow =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: number | null = null
    let createdState: fs.BigIntStats | null = null
    try {
      handle = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          noFollow,
        0o600
      )
      createdState = fs.fstatSync(handle, { bigint: true })
      fs.writeFileSync(handle, lockBytes)
      fs.fsyncSync(handle)
      fs.closeSync(handle)
      handle = null
      syncDirectory(path.dirname(lockPath))

      return () => {
        const lockState = fs.lstatSync(lockPath, { bigint: true })
        const currentBytes = readRegularFileBounded(
          lockPath,
          MAX_MIGRATION_LOCK_BYTES
        )
        if (!currentBytes.equals(lockBytes)) {
          throw new Error(
            "Legacy migration lock ownership changed before release."
          )
        }

        const releasePath = `${lockPath}.release-${nonce}`
        fs.renameSync(lockPath, releasePath)
        const releasedState = fs.lstatSync(releasePath, { bigint: true })
        const releasedBytes = readRegularFileBounded(
          releasePath,
          MAX_MIGRATION_LOCK_BYTES
        )
        if (
          !sameFileEntry(lockState, releasedState) ||
          !releasedBytes.equals(lockBytes)
        ) {
          if (!fs.existsSync(lockPath)) {
            fs.renameSync(releasePath, lockPath)
          }
          throw new Error(
            "Legacy migration lock changed while it was being released."
          )
        }
        fs.rmSync(releasePath, { force: false })
        syncDirectory(path.dirname(lockPath))
      }
    } catch (error) {
      if (handle !== null) {
        try {
          fs.closeSync(handle)
        } catch {
          // Preserve the operation that caused lock creation to fail.
        }
      }
      if (createdState) {
        try {
          const current = fs.lstatSync(lockPath, { bigint: true })
          if (sameFileEntry(createdState, current)) {
            fs.rmSync(lockPath, { force: false })
          }
        } catch {
          // Never remove an entry whose identity cannot be proven to be ours.
        }
      }
      if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
        throw error
      }

      let lockState: fs.BigIntStats
      try {
        lockState = fs.lstatSync(lockPath, { bigint: true })
      } catch (statError) {
        if (isMissingFileError(statError)) continue
        throw statError
      }
      if (!lockState.isFile() || lockState.isSymbolicLink()) {
        throw new Error(
          "Legacy migration lock is not a regular file; refusing to continue."
        )
      }

      const existingBytes = readRegularFileBounded(
        lockPath,
        MAX_MIGRATION_LOCK_BYTES
      )
      let ownerPid = 0
      let createdAt = Number(lockState.mtimeMs)
      try {
        const record = JSON.parse(existingBytes.toString("utf8")) as {
          pid?: unknown
          createdAt?: unknown
        }
        if (typeof record.pid === "number") ownerPid = record.pid
        if (typeof record.createdAt === "number") createdAt = record.createdAt
      } catch {
        // A partial lock can only be reclaimed after the filesystem timestamp
        // crosses the same stale threshold as a well-formed lock.
      }

      const stale =
        Date.now() - Math.max(createdAt, Number(lockState.mtimeMs)) >=
        MIGRATION_LOCK_STALE_MS
      if (!stale || processAppearsAlive(ownerPid)) {
        throw new Error(
          `Legacy data migration is already active (owner pid ${ownerPid || "unknown"}).`
        )
      }

      const stalePath = `${lockPath}.stale-${randomUUID()}`
      try {
        fs.renameSync(lockPath, stalePath)
      } catch (renameError) {
        if (isMissingFileError(renameError)) continue
        throw renameError
      }
      const movedState = fs.lstatSync(stalePath, { bigint: true })
      if (!sameFileEntry(lockState, movedState)) {
        if (!fs.existsSync(lockPath)) fs.renameSync(stalePath, lockPath)
        throw new Error(
          "Legacy migration lock changed while stale ownership was reclaimed."
        )
      }
      fs.rmSync(stalePath, { force: false })
      syncDirectory(path.dirname(lockPath))
    }
  }

  throw new Error("Could not acquire the legacy data migration lock.")
}

function migrationMarkerPath(targetDbPath: string): string {
  return path.join(path.dirname(targetDbPath), MIGRATION_MARKER_FILENAME)
}

function parseMigrationMarker(bytes: Buffer): MigrationMarker {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("Legacy migration marker contains invalid JSON.")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Legacy migration marker has an invalid shape.")
  }
  const record = value as Record<string, unknown>
  const phase = record.phase
  const validHash = (hash: unknown): boolean =>
    hash === null || (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
  if (
    record.version !== 1 ||
    typeof record.sourceDir !== "string" ||
    !path.isAbsolute(record.sourceDir) ||
    typeof record.sourceDbPath !== "string" ||
    !path.isAbsolute(record.sourceDbPath) ||
    typeof record.sourceDev !== "string" ||
    !/^\d+$/.test(record.sourceDev) ||
    typeof record.sourceIno !== "string" ||
    !/^\d+$/.test(record.sourceIno) ||
    !validHash(record.targetSettingsHash) ||
    !validHash(record.targetKeyHash) ||
    (phase !== "prepared" &&
      phase !== "companions_published" &&
      phase !== "database_published") ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new Error("Legacy migration marker failed validation.")
  }
  return record as unknown as MigrationMarker
}

function readMigrationMarker(targetDbPath: string): MigrationMarker | null {
  const markerPath = migrationMarkerPath(targetDbPath)
  try {
    return parseMigrationMarker(
      readRegularFileBounded(markerPath, MAX_MIGRATION_MARKER_BYTES)
    )
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

function writeMigrationMarker(
  targetDbPath: string,
  marker: MigrationMarker,
  createOnly: boolean
): void {
  const markerPath = migrationMarkerPath(targetDbPath)
  const bytes = Buffer.from(`${JSON.stringify(marker)}\n`, "utf8")
  if (bytes.length > MAX_MIGRATION_MARKER_BYTES) {
    throw new Error("Legacy migration marker exceeds its storage limit.")
  }
  const stagedPath = `${markerPath}.tmp-${randomUUID()}`
  const handle = fs.openSync(
    stagedPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600
  )
  try {
    try {
      fs.writeFileSync(handle, bytes)
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    if (createOnly) {
      fs.linkSync(stagedPath, markerPath)
    } else {
      const current = fs.lstatSync(markerPath, { bigint: true })
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new Error(
          "Legacy migration marker changed before its phase update."
        )
      }
      fs.renameSync(stagedPath, markerPath)
    }
    syncDirectory(path.dirname(markerPath))
  } finally {
    fs.rmSync(stagedPath, { force: true })
  }
}

function removeMigrationMarker(targetDbPath: string): void {
  const markerPath = migrationMarkerPath(targetDbPath)
  let initial: fs.BigIntStats
  try {
    initial = fs.lstatSync(markerPath, { bigint: true })
  } catch (error) {
    if (isMissingFileError(error)) return
    throw error
  }
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new Error("Legacy migration marker changed before completion.")
  }
  const completedPath = `${markerPath}.complete-${randomUUID()}`
  fs.renameSync(markerPath, completedPath)
  const completed = fs.lstatSync(completedPath, { bigint: true })
  if (!sameFileEntry(initial, completed)) {
    if (!fs.existsSync(markerPath)) {
      fs.renameSync(completedPath, markerPath)
    }
    throw new Error(
      "Legacy migration marker changed while it was being completed."
    )
  }
  fs.rmSync(completedPath, { force: false })
  syncDirectory(path.dirname(markerPath))
}

function createMigrationMarker(
  targetDbPath: string,
  source: LegacySource
): MigrationMarker {
  const sourceState = fs.lstatSync(source.dbPath, { bigint: true })
  if (!sourceState.isFile() || sourceState.isSymbolicLink()) {
    throw new Error(
      `Legacy SQLite source is not a regular file: ${source.dbPath}`
    )
  }
  const marker: MigrationMarker = {
    version: 1,
    sourceDir: path.resolve(source.dir),
    sourceDbPath: path.resolve(source.dbPath),
    sourceDev: sourceState.dev.toString(),
    sourceIno: sourceState.ino.toString(),
    targetSettingsHash: null,
    targetKeyHash: null,
    phase: "prepared",
    createdAt: new Date().toISOString(),
  }
  writeMigrationMarker(targetDbPath, marker, true)
  return marker
}

function hashRegularFileIfPresent(
  filePath: string,
  maxBytes: number
): string | null {
  try {
    return createHash("sha256")
      .update(readRegularFileBounded(filePath, maxBytes))
      .digest("hex")
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

function captureTargetCompanionHashes(targetDbPath: string): {
  targetSettingsHash: string | null
  targetKeyHash: string | null
} {
  const targetDir = path.dirname(targetDbPath)
  return {
    targetSettingsHash: hashRegularFileIfPresent(
      path.join(targetDir, "settings.json"),
      MAX_LEGACY_SETTINGS_BYTES
    ),
    targetKeyHash: hashRegularFileIfPresent(
      path.join(targetDir, "settings-key.bin"),
      MAX_LEGACY_WRAPPED_KEY_BYTES
    ),
  }
}

function assertTargetCompanionsMatchMarker(
  targetDbPath: string,
  marker: MigrationMarker
): void {
  const current = captureTargetCompanionHashes(targetDbPath)
  if (
    current.targetSettingsHash !== marker.targetSettingsHash ||
    current.targetKeyHash !== marker.targetKeyHash
  ) {
    throw new Error(
      "Migrated settings companions no longer match the durable migration marker."
    )
  }
}

function updateMigrationMarkerPhase(
  targetDbPath: string,
  marker: MigrationMarker,
  phase: MigrationPhase
): MigrationMarker {
  if (phase === "database_published") {
    assertTargetCompanionsMatchMarker(targetDbPath, marker)
  }
  const companionHashes =
    phase === "companions_published"
      ? captureTargetCompanionHashes(targetDbPath)
      : {
          targetSettingsHash: marker.targetSettingsHash,
          targetKeyHash: marker.targetKeyHash,
        }
  const updated = { ...marker, ...companionHashes, phase }
  writeMigrationMarker(targetDbPath, updated, false)
  return updated
}

function sourceFromMigrationMarker(
  targetDbPath: string,
  marker: MigrationMarker
): LegacySource {
  const allowed = legacyCandidates(targetDbPath).some(
    (candidate) => path.resolve(candidate) === path.resolve(marker.sourceDir)
  )
  if (
    !allowed ||
    path.resolve(marker.sourceDbPath) !==
      path.resolve(marker.sourceDir, "betterc0de.db")
  ) {
    throw new Error(
      "Legacy migration marker refers to a source outside the approved legacy locations."
    )
  }
  const sourceState = fs.lstatSync(marker.sourceDbPath, { bigint: true })
  if (
    !sourceState.isFile() ||
    sourceState.isSymbolicLink() ||
    sourceState.dev.toString() !== marker.sourceDev ||
    sourceState.ino.toString() !== marker.sourceIno
  ) {
    throw new Error(
      "Legacy migration source no longer matches the durable migration marker."
    )
  }
  if (inspectDatabase(marker.sourceDbPath) !== "valid") {
    throw new Error(
      "Legacy migration source recorded in the marker is no longer valid."
    )
  }
  return {
    dir: marker.sourceDir,
    dbPath: marker.sourceDbPath,
  }
}

/**
 * Commit the encryption identity before the database becomes the migration's
 * idempotency marker. Existing target settings always win. Encrypted legacy
 * settings are accepted only with an absent or byte-identical target key.
 */
function migrateSettingsCompanions(sourceDir: string, targetDir: string): void {
  const sourceSettings = path.join(sourceDir, "settings.json")
  const sourceKey = path.join(sourceDir, "settings-key.bin")
  const targetSettings = path.join(targetDir, "settings.json")
  const targetKey = path.join(targetDir, "settings-key.bin")

  if (!fs.existsSync(sourceSettings)) return

  const settingsBytes = readRegularFileBounded(
    sourceSettings,
    MAX_LEGACY_SETTINGS_BYTES
  )
  const encrypted = settingsBytes.includes(Buffer.from("enc:v1:", "utf8"))
  const sourceKeyBytes = fs.existsSync(sourceKey)
    ? readRegularFileBounded(sourceKey, MAX_LEGACY_WRAPPED_KEY_BYTES)
    : null

  if (fs.existsSync(targetSettings)) {
    const targetSettingsBytes = readRegularFileBounded(
      targetSettings,
      MAX_LEGACY_SETTINGS_BYTES
    )
    const targetEncrypted = targetSettingsBytes.includes(
      Buffer.from("enc:v1:", "utf8")
    )
    if (!targetEncrypted) return
    const settingsMatch = targetSettingsBytes.equals(settingsBytes)
    const targetKeyExists = fs.existsSync(targetKey)
    if (!settingsMatch) {
      if (!targetKeyExists) {
        throw new Error(
          "Encrypted target settings differ from the legacy source and have no target settings key."
        )
      }
      return
    }
    if (targetKeyExists) {
      if (
        sourceKeyBytes &&
        !readRegularFileBounded(targetKey, MAX_LEGACY_WRAPPED_KEY_BYTES).equals(
          sourceKeyBytes
        )
      ) {
        throw new Error(
          "Encrypted migrated settings and the target settings key do not match."
        )
      }
      return
    }
    if (!sourceKeyBytes) {
      throw new Error(
        "Encrypted target settings are missing their key and cannot be matched to the legacy source."
      )
    }
    publishBytesAtomicallyIfAbsent(
      sourceKeyBytes,
      targetKey,
      MAX_LEGACY_WRAPPED_KEY_BYTES
    )
    return
  }

  if (encrypted && !sourceKeyBytes) {
    throw new Error(
      "Legacy settings contain encrypted values but settings-key.bin is missing."
    )
  }

  if (fs.existsSync(targetKey)) {
    if (
      encrypted &&
      sourceKeyBytes &&
      !readRegularFileBounded(targetKey, MAX_LEGACY_WRAPPED_KEY_BYTES).equals(
        sourceKeyBytes
      )
    ) {
      throw new Error(
        "Refusing to migrate encrypted legacy settings with a different target settings key."
      )
    }
  } else if (sourceKeyBytes) {
    publishBytesAtomicallyIfAbsent(
      sourceKeyBytes,
      targetKey,
      MAX_LEGACY_WRAPPED_KEY_BYTES
    )
  }

  // Key first, settings second. A crash between these atomic publishes leaves
  // a matching key and no settings, which the next startup safely retries.
  publishBytesAtomicallyIfAbsent(
    settingsBytes,
    targetSettings,
    MAX_LEGACY_SETTINGS_BYTES
  )
}

function readRegularFileBounded(filePath: string, maxBytes: number): Buffer {
  const initial = fs.lstatSync(filePath, { bigint: true })
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new Error(
      `Legacy migration source is not a regular file: ${filePath}`
    )
  }
  if (initial.size > BigInt(maxBytes)) {
    throw new Error(
      `Legacy migration source exceeds ${maxBytes} bytes: ${filePath}`
    )
  }
  const noFollow =
    typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  const handle = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = fs.fstatSync(handle, { bigint: true })
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.size > BigInt(maxBytes) ||
      !sameFileEntry(initial, opened)
    ) {
      throw new Error(
        `Legacy migration source changed while opening: ${filePath}`
      )
    }
    const output = Buffer.allocUnsafe(Number(opened.size))
    let offset = 0
    while (offset < output.length) {
      const read = fs.readSync(
        handle,
        output,
        offset,
        output.length - offset,
        offset
      )
      if (read === 0) break
      offset += read
    }
    if (offset !== output.length) {
      throw new Error(
        `Legacy migration source was truncated while reading: ${filePath}`
      )
    }
    return output
  } finally {
    fs.closeSync(handle)
  }
}

function publishBytesAtomicallyIfAbsent(
  bytes: Buffer,
  targetPath: string,
  maxBytes: number
): void {
  if (fs.existsSync(targetPath)) {
    if (!readRegularFileBounded(targetPath, maxBytes).equals(bytes)) {
      throw new Error(
        `Migration companion was concurrently created with different contents: ${targetPath}`
      )
    }
    return
  }
  const stagedPath = path.join(
    path.dirname(targetPath),
    `.betterc0de-companion-${randomUUID()}.tmp`
  )
  const handle = fs.openSync(
    stagedPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600
  )
  try {
    try {
      let offset = 0
      while (offset < bytes.length) {
        offset += fs.writeSync(
          handle,
          bytes,
          offset,
          bytes.length - offset,
          offset
        )
      }
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    try {
      // A hard-link is an atomic no-overwrite publish on every supported
      // platform. `rename` would replace a concurrently created target on
      // POSIX and could silently mix two startup attempts.
      fs.linkSync(stagedPath, targetPath)
    } catch (error) {
      if (
        !fs.existsSync(targetPath) ||
        !readRegularFileBounded(targetPath, maxBytes).equals(bytes)
      ) {
        throw error
      }
    }
    syncDirectory(path.dirname(targetPath))
  } finally {
    fs.rmSync(stagedPath, { force: true })
  }
}

type DatabaseInspection = "absent" | "valid" | "invalid"

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

function isSqliteCorruptionError(error: unknown): boolean {
  const code = String(
    (error as { code?: unknown } | null)?.code ?? ""
  ).toUpperCase()
  return (
    code === "SQLITE_CORRUPT" ||
    code === "SQLITE_NOTADB" ||
    code === "SQLITE_FORMAT"
  )
}

function inspectDatabase(targetDbPath: string): DatabaseInspection {
  let entry: fs.Stats
  try {
    entry = fs.lstatSync(targetDbPath)
  } catch (error) {
    if (isMissingFileError(error)) return "absent"
    throw error
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(
      `SQLite migration path is not a regular file: ${targetDbPath}`
    )
  }

  let db: Database.Database | null = null
  try {
    db = new Database(targetDbPath, { readonly: true, fileMustExist: true })
    const quickCheck = db.pragma("quick_check", { simple: true })
    if (quickCheck !== "ok") return "invalid"
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
      )
      .get() as { count: number }
    return row.count > 0 ? "valid" : "invalid"
  } catch (error) {
    if (isSqliteCorruptionError(error)) return "invalid"
    throw error
  } finally {
    db?.close()
  }
}

function pickLegacySource(
  targetDbPath: string
): { dir: string; dbPath: string } | null {
  const candidates = legacyCandidates(targetDbPath)
  for (const dir of candidates) {
    const dbPath = path.join(dir, "betterc0de.db")
    if (path.resolve(dbPath) === path.resolve(targetDbPath)) continue
    const state = inspectDatabase(dbPath)
    if (state === "valid") return { dir, dbPath }
  }
  return null
}

function migrateSqliteSnapshot(
  sourceDbPath: string,
  targetDbPath: string
): void {
  const targetDir = path.dirname(targetDbPath)
  const tempDbPath = path.join(
    targetDir,
    `.betterc0de-migration-${randomUUID()}.sqlite`
  )
  let sourceDb: Database.Database | null = null
  const displaced: Array<{ original: string; backup: string }> = []

  try {
    const initialSourceState = fs.lstatSync(sourceDbPath, { bigint: true })
    if (!initialSourceState.isFile() || initialSourceState.isSymbolicLink()) {
      throw new Error(
        `Legacy SQLite source is not a regular file: ${sourceDbPath}`
      )
    }
    sourceDb = new Database(sourceDbPath, {
      readonly: true,
      fileMustExist: true,
    })
    const openedSourceState = fs.lstatSync(sourceDbPath, { bigint: true })
    if (
      openedSourceState.dev !== initialSourceState.dev ||
      openedSourceState.ino !== initialSourceState.ino
    ) {
      throw new Error("Legacy SQLite source changed while it was being opened.")
    }
    sourceDb.exec(`VACUUM INTO ${sqliteStringLiteral(tempDbPath)}`)
    const completedSourceState = fs.lstatSync(sourceDbPath, { bigint: true })
    if (
      completedSourceState.dev !== initialSourceState.dev ||
      completedSourceState.ino !== initialSourceState.ino
    ) {
      throw new Error(
        "Legacy SQLite source changed while its snapshot was being created."
      )
    }
    sourceDb.close()
    sourceDb = null

    if (inspectDatabase(tempDbPath) !== "valid") {
      throw new Error("Migrated SQLite snapshot failed quick_check.")
    }

    let published = false
    try {
      for (const suffix of ["", "-wal", "-shm"] as const) {
        const original = targetDbPath + suffix
        let originalState: fs.BigIntStats
        try {
          originalState = fs.lstatSync(original, { bigint: true })
        } catch (error) {
          if (isMissingFileError(error)) continue
          throw error
        }
        if (!originalState.isFile() || originalState.isSymbolicLink()) {
          throw new Error(
            `Refusing to displace a non-regular SQLite target: ${original}`
          )
        }

        const backup = `${original}.pre-migration-${randomUUID()}`
        fs.renameSync(original, backup)
        displaced.push({ original, backup })
        const backupState = fs.lstatSync(backup, { bigint: true })
        if (
          backupState.dev !== originalState.dev ||
          backupState.ino !== originalState.ino
        ) {
          throw new Error(
            `SQLite target changed while it was being displaced: ${original}`
          )
        }
      }

      if (displaced.length > 0) syncDirectory(targetDir)
      // Publish without replacing a database created by another standalone
      // backend after our inspection. The snapshot and target share a
      // directory/filesystem, so link() is an atomic no-overwrite commit.
      fs.linkSync(tempDbPath, targetDbPath)
      published = true
      syncDirectory(targetDir)
    } catch (error) {
      const rollbackErrors: Error[] = []
      if (!published) {
        for (const entry of [...displaced].reverse()) {
          try {
            if (fs.existsSync(entry.original)) {
              throw new Error(
                `Cannot restore displaced SQLite file because its path was recreated: ${entry.original}`
              )
            }
            if (fs.existsSync(entry.backup)) {
              fs.renameSync(entry.backup, entry.original)
            }
          } catch (rollbackError) {
            rollbackErrors.push(
              rollbackError instanceof Error
                ? rollbackError
                : new Error(String(rollbackError))
            )
          }
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "SQLite migration failed and one or more displaced files could not be restored."
        )
      }
      throw error
    }

    for (const entry of displaced) {
      try {
        fs.rmSync(entry.backup, { force: true })
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            backup: entry.backup,
          },
          "Could not remove a committed legacy SQLite migration backup"
        )
      }
    }
    if (displaced.length > 0) syncDirectory(targetDir)
  } finally {
    sourceDb?.close()
    fs.rmSync(tempDbPath, { force: true })
  }
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function legacyCandidates(targetDbPath: string): string[] {
  const home = os.homedir()
  const devRoot = path.resolve(home, ".betterc0de-dev")
  const resolvedTarget = path.resolve(targetDbPath)
  const relativeToDevRoot = path.relative(devRoot, resolvedTarget)
  if (
    relativeToDevRoot === "" ||
    (!relativeToDevRoot.startsWith("..") && !path.isAbsolute(relativeToDevRoot))
  ) {
    // Development storage must never silently import a packaged
    // installation's database, settings, or provider credentials.
    return [devRoot]
  }

  const out = [path.join(home, ".betterc0de")] // super-legacy flat

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming")
    out.push(path.join(appData, "betterc0de"))
  } else if (process.platform === "darwin") {
    out.push(path.join(home, "Library", "Application Support", "betterc0de"))
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
    out.push(path.join(xdg, "betterc0de"))
  }
  return out
}
