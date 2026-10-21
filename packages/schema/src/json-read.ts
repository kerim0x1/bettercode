/**
 * Readers for untyped JSON: provider wire payloads, journal rows, settings
 * files, IPC frames. Every consumer used to carry its own copy of these few
 * lines with slightly different edge cases; these are the canonical ones,
 * and a file that needs one of them imports it instead of redeclaring it.
 *
 * Two string readers exist on purpose. `readTrimmed` is for identifiers,
 * enum names and modes, where surrounding whitespace is noise. `readString`
 * is for text a model streamed: " local" and " changes." arrive as separate
 * chunks, and trimming each one glues them into "Reviewinglocalchanges."
 */

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The record itself, or an empty one for anything that is not a plain object. */
export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

/**
 * The record itself, or `undefined` for anything that is not a plain object.
 * Named for its result so it cannot be mistaken for `asRecord` (which never
 * returns undefined) when a call site is copied between modules.
 */
export function recordOrUndefined(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

/** The value when it is a non-empty string, untouched; otherwise undefined. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** The first of `keys` holding a non-empty string, returned untouched. */
export function readString(
  record: JsonRecord,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/** The first of `keys` holding a non-blank string, trimmed. */
export function readTrimmed(
  record: JsonRecord,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

/** The first of `keys` holding a finite number. */
export function readNumber(
  record: JsonRecord,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

/** The boolean at `key`, or `fallback` when it is anything else. */
export function readBoolean(
  record: JsonRecord,
  key: string,
  fallback: boolean
): boolean {
  const value = record[key]
  return typeof value === "boolean" ? value : fallback
}
