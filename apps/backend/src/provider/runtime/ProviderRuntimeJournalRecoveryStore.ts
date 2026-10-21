import { isRecord } from "@betterc0de/schema"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { LegacyProviderEvent } from "../types"
import type { ProviderRuntimeEvent as CanonicalProviderRuntimeEvent } from "./contracts"
import {
  journalEntryEventType,
  journalEntryThreadId,
  type JournalTruncationRecord,
  type ProviderRuntimeJournalEntry,
} from "./journalEntry"
import type { ProviderRuntimeIngestionLogger } from "./ProviderRuntimeIngestion"

const RECORD_FILE = /^\d{20}-\d{13}-[a-f0-9-]{36}\.json$/
const DEFAULT_MAX_FILES = 10_000
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

/**
 * On-disk record. Version 3 carries the entry `shape` next to the event;
 * versions 1 and 2 predate canonical journaling and are always legacy-shaped
 * (version 1 also has no `eventId`; one is derived from the file name).
 */
interface ProviderRuntimeRecoveryEnvelope {
  readonly version: 3
  readonly eventId: string
  readonly queuedAt: string
  readonly projectionSequence: number
  readonly entry: ProviderRuntimeJournalEntry
}

export interface ProviderRuntimeJournalRecoveryTarget {
  persist(
    entry: ProviderRuntimeJournalEntry,
    sequence: number,
    recoveryEventId?: string
  ):
    | number
    | void
    | {
        readonly sequence: number
        readonly entry: ProviderRuntimeJournalEntry
        readonly truncation?: JournalTruncationRecord | null
      }
}

export interface ProviderRuntimeJournalRecoveryReplayResult {
  readonly replayed: number
  readonly quarantined: number
  readonly pending: number
}

export function providerRuntimeJournalRecoveryBlocksStartup(
  result: ProviderRuntimeJournalRecoveryReplayResult
): boolean {
  return result.pending > 0 || result.quarantined > 0
}

/** Filesystem fallback for provider events that could not reach SQLite on shutdown. */
export class ProviderRuntimeJournalRecoveryStore {
  private readonly maxFiles: number
  private readonly maxBytes: number

  constructor(
    private readonly directory: string,
    private readonly options: {
      readonly maxFiles?: number
      readonly maxBytes?: number
      readonly logger?: ProviderRuntimeIngestionLogger
    } = {}
  ) {
    this.maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES)
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  enqueue(
    entry: ProviderRuntimeJournalEntry,
    input: { readonly projectionSequence: number }
  ): boolean {
    if (
      !Number.isSafeInteger(input.projectionSequence) ||
      input.projectionSequence <= 0
    ) {
      return false
    }
    const queuedAt = new Date().toISOString()
    const eventId = randomUUID()
    const meta = {
      thread: journalEntryThreadId(entry),
      eventType: journalEntryEventType(entry),
    }
    let serialized: string
    try {
      serialized = `${JSON.stringify({
        version: 3,
        eventId,
        queuedAt,
        projectionSequence: input.projectionSequence,
        shape: entry.shape,
        event: entry.event,
      })}\n`
    } catch (error) {
      this.options.logger?.error(
        { err: error, ...meta },
        "provider runtime recovery record is not serializable"
      )
      return false
    }

    const bytes = Buffer.byteLength(serialized, "utf8")
    const footprint = directoryFootprint(this.directory)
    if (
      bytes > this.maxBytes ||
      footprint.files >= this.maxFiles ||
      footprint.bytes + bytes > this.maxBytes
    ) {
      this.options.logger?.error(
        {
          ...meta,
          bytes,
          currentFiles: footprint.files,
          currentBytes: footprint.bytes,
          maxFiles: this.maxFiles,
          maxBytes: this.maxBytes,
        },
        "provider runtime journal recovery spool is full"
      )
      return false
    }

    const stamp = Date.parse(queuedAt).toString().padStart(13, "0")
    const targetPath = path.join(
      this.directory,
      `${input.projectionSequence.toString().padStart(20, "0")}-${stamp}-${randomUUID()}.json`
    )
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | null = null
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600)
      fs.writeFileSync(descriptor, serialized, "utf8")
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = null
      fs.renameSync(temporaryPath, targetPath)
      fsyncDirectoryBestEffort(this.directory)
      return true
    } catch (error) {
      this.options.logger?.error(
        { err: error, ...meta },
        "failed to spool provider runtime journal event"
      )
      return false
    } finally {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor)
        } catch {
          // Best effort cleanup after the primary write failure.
        }
      }
      try {
        fs.rmSync(temporaryPath, { force: true })
      } catch {
        // Best effort cleanup after the primary write failure.
      }
    }
  }

  replay(
    target: ProviderRuntimeJournalRecoveryTarget
  ): ProviderRuntimeJournalRecoveryReplayResult {
    const files = this.recordFiles()
    const existingQuarantined = this.quarantinedCount()
    if (existingQuarantined > 0) {
      return {
        replayed: 0,
        quarantined: existingQuarantined,
        pending: files.length,
      }
    }

    let replayed = 0
    for (const fileName of files) {
      const filePath = path.join(this.directory, fileName)
      let envelope: ProviderRuntimeRecoveryEnvelope
      try {
        envelope = parseEnvelope(fs.readFileSync(filePath, "utf8"), fileName)
      } catch (error) {
        this.quarantine(filePath, error)
        break
      }
      try {
        target.persist(
          envelope.entry,
          envelope.projectionSequence,
          envelope.eventId
        )
        fs.rmSync(filePath, { force: true })
        fsyncDirectoryBestEffort(this.directory)
        replayed += 1
      } catch (error) {
        this.options.logger?.warn(
          {
            err: error,
            thread: journalEntryThreadId(envelope.entry),
            eventType: journalEntryEventType(envelope.entry),
          },
          "provider runtime journal recovery replay remains pending"
        )
        break
      }
    }
    return {
      replayed,
      quarantined: this.quarantinedCount(),
      pending: this.recordFiles().length,
    }
  }

  pendingCount(): number {
    return this.recordFiles().length
  }

  private recordFiles(): string[] {
    try {
      return fs
        .readdirSync(this.directory)
        .filter((name) => RECORD_FILE.test(name))
        .sort()
    } catch (error) {
      if (isMissingFileError(error)) return []
      throw error
    }
  }

  private quarantinedCount(): number {
    const quarantineDirectory = path.join(this.directory, "quarantine")
    try {
      return fs
        .readdirSync(quarantineDirectory)
        .filter((name) => name.endsWith(".bad")).length
    } catch (error) {
      if (isMissingFileError(error)) return 0
      throw error
    }
  }

  private quarantine(filePath: string, error: unknown): void {
    const quarantineDirectory = path.join(this.directory, "quarantine")
    fs.mkdirSync(quarantineDirectory, { recursive: true, mode: 0o700 })
    const target = path.join(
      quarantineDirectory,
      `${path.basename(filePath)}.${randomUUID()}.bad`
    )
    try {
      fs.renameSync(filePath, target)
      fsyncDirectoryBestEffort(this.directory)
      fsyncDirectoryBestEffort(quarantineDirectory)
    } catch (renameError) {
      this.options.logger?.error(
        { err: renameError, sourceError: error, filePath },
        "failed to quarantine provider runtime recovery record"
      )
    }
  }
}

function parseEnvelope(
  raw: string,
  fileName: string
): ProviderRuntimeRecoveryEnvelope {
  const value = JSON.parse(raw) as unknown
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3)
  ) {
    throw new Error("Unsupported provider runtime recovery record.")
  }
  if (
    typeof value.queuedAt !== "string" ||
    typeof value.projectionSequence !== "number" ||
    !Number.isSafeInteger(value.projectionSequence) ||
    value.projectionSequence <= 0 ||
    !isRecord(value.event)
  ) {
    throw new Error("Malformed provider runtime recovery record.")
  }
  const eventId =
    value.version === 1
      ? `legacy-provider-runtime-recovery:${fileName}`
      : value.eventId
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new Error("Malformed provider runtime recovery record.")
  }
  const shape = value.version === 3 ? value.shape : "legacy"
  if (shape !== "legacy" && shape !== "canonical") {
    throw new Error("Malformed provider runtime recovery record.")
  }
  const event = value.event
  if (shape === "canonical") {
    if (
      typeof event.type !== "string" ||
      event.type.length === 0 ||
      typeof event.threadId !== "string" ||
      event.threadId.length === 0 ||
      typeof event.eventId !== "string" ||
      event.eventId.length === 0
    ) {
      throw new Error("Malformed provider runtime recovery record.")
    }
    return {
      version: 3,
      eventId,
      queuedAt: value.queuedAt,
      projectionSequence: value.projectionSequence,
      entry: {
        shape: "canonical",
        event: event as unknown as CanonicalProviderRuntimeEvent,
      },
    }
  }
  if (
    typeof event.event_type !== "string" ||
    typeof event.thread_id !== "string" ||
    !isRecord(event.payload)
  ) {
    throw new Error("Malformed provider runtime recovery record.")
  }
  return {
    version: 3,
    eventId,
    queuedAt: value.queuedAt,
    projectionSequence: value.projectionSequence,
    entry: {
      shape: "legacy",
      // Passed through whole, not rebuilt from its three fields: the journal
      // serializes what it is given, and a spool record replayed after a
      // commit-then-crash is matched against the committed row by payload bytes.
      event: event as unknown as LegacyProviderEvent,
    },
  }
}

function directoryFootprint(directory: string): {
  files: number
  bytes: number
} {
  let files = 0
  let bytes = 0
  // Crash leftovers and quarantined records consume the same disk budget as
  // replayable records. Do not follow symlinks outside this private spool.
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = directoryFootprint(entryPath)
      files += nested.files
      bytes += nested.bytes
      continue
    }
    try {
      bytes += fs.lstatSync(entryPath).size
      files += 1
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
  }
  return { files, bytes }
}

function fsyncDirectoryBestEffort(directory: string): void {
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(directory, "r")
    fs.fsyncSync(descriptor)
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  )
}
