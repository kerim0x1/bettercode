/**
 * A chat's own settings are kept by the backend with the chat (PATCH
 * /threads/:id `{ settings }`): its permission level, model selection and
 * orchestration. The chat store stays the renderer's copy and its
 * localStorage cache; this module writes the store's changes through and
 * merges the backend's copy in when the chat list loads, moving settings
 * that so far lived only in localStorage to the backend on that first load.
 * A change made on another client arrives as a `thread.metadata` push and is
 * applied at once, except where this window has its own change on the way.
 *
 * The validation schemas load with the first write or push, not with the
 * store.
 */
import type {
  ChatThread,
  ThreadSettings as StoredThreadSettings,
  ThreadSettingsPatch,
} from "@betterc0de/schema"
import type { ThreadSettings } from "@/lib/chat/types"
import { HttpError } from "@/lib/errors"
import { updateThreadSettings } from "@/services/backend/coreApi"

/** The composer settings the backend keeps with a chat (`threadSettingsSchema`). */
export const STORED_THREAD_SETTING_KEYS = [
  "permissionLevel",
  "selectedProviderId",
  "selectedModel",
  "modelSelectionByProvider",
  "orchestration",
  "compareGroupId",
] as const satisfies ReadonlyArray<
  keyof StoredThreadSettings & keyof ThreadSettings
>

type StoredKey = (typeof STORED_THREAD_SETTING_KEYS)[number]

/** A change to send: a key with a value sets it, `null` clears it. */
export type ThreadSettingsChange = Partial<Record<StoredKey, unknown>>

type ThreadSettingsMap = Record<string, ThreadSettings>

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === ""
}

/**
 * What changed in the backend-kept keys between two copies of a chat's
 * settings, or `null` when nothing did.
 */
export function threadSettingsChange(
  previous: ThreadSettings | undefined,
  next: ThreadSettings | undefined
): ThreadSettingsChange | null {
  const change: ThreadSettingsChange = {}
  for (const key of STORED_THREAD_SETTING_KEYS) {
    const before = previous?.[key]
    const after = next?.[key]
    if (sameValue(before, after)) continue
    change[key] = isUnset(after) ? null : after
  }
  return Object.keys(change).length > 0 ? change : null
}

// ── Write-through ─────────────────────────────────────────────────────────

const FLUSH_DELAY_MS = 400
const RETRY_DELAY_MS = 3_000
/** A chat the backend has not stored yet (just created) gets a few tries. */
const MAX_ATTEMPTS = 4

const pending = new Map<string, ThreadSettingsChange>()
/** The change of each chat whose write is on its way to the backend. */
const inFlight = new Map<string, ThreadSettingsChange>()
const attempts = new Map<string, number>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushing = false

function scheduleFlush(delayMs: number): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, delayMs)
}

/** Queues a chat's settings change for the backend; changes in a burst go together. */
export function queueThreadSettingsChange(
  threadId: string | null | undefined,
  change: ThreadSettingsChange | null
): void {
  if (!threadId || !change) return
  pending.set(threadId, { ...pending.get(threadId), ...change })
  scheduleFlush(FLUSH_DELAY_MS)
}

/**
 * The keys the backend accepts, each checked alone, so one value it would
 * refuse does not hold back the others.
 */
async function acceptedPatch(
  change: ThreadSettingsChange
): Promise<ThreadSettingsPatch | null> {
  const { threadSettingsPatchSchema } = await import("@betterc0de/schema")
  const patch: Record<string, unknown> = {}
  for (const key of STORED_THREAD_SETTING_KEYS) {
    if (!(key in change)) continue
    const parsed = threadSettingsPatchSchema.shape[key].safeParse(change[key])
    if (parsed.success) patch[key] = parsed.data
  }
  return Object.keys(patch).length > 0 ? (patch as ThreadSettingsPatch) : null
}

function isRetriable(error: unknown): boolean {
  if (!(error instanceof HttpError)) return true
  // Not stored yet, or busy with a checkpoint recovery: try again. A refusal
  // (a value the backend does not accept, a paired device's limit) is final;
  // the renderer's copy stays as the user set it.
  return error.status === 404 || error.status === 409 || error.status >= 500
}

async function flush(): Promise<void> {
  if (flushing) {
    scheduleFlush(FLUSH_DELAY_MS)
    return
  }
  flushing = true
  let retry = false
  try {
    const batch = [...pending.entries()]
    pending.clear()
    // Until its write is done, a change is this window's to make: another
    // client's push does not overwrite it (`unsettledThreadSettingKeys`).
    for (const [threadId, change] of batch) inFlight.set(threadId, change)
    for (const [threadId, change] of batch) {
      try {
        const patch = await acceptedPatch(change)
        if (patch) await updateThreadSettings(threadId, patch)
        attempts.delete(threadId)
      } catch (error) {
        const tries = (attempts.get(threadId) ?? 0) + 1
        if (isRetriable(error) && tries < MAX_ATTEMPTS) {
          attempts.set(threadId, tries)
          // A newer change queued meanwhile wins over the one that failed.
          pending.set(threadId, { ...change, ...pending.get(threadId) })
          retry = true
        } else {
          attempts.delete(threadId)
        }
      } finally {
        inFlight.delete(threadId)
      }
    }
  } finally {
    flushing = false
  }
  if (retry) scheduleFlush(RETRY_DELAY_MS)
}

// ── The backend's copy on load ────────────────────────────────────────────

/**
 * Merges the settings the backend keeps with each listed chat into the
 * renderer's copies: a key the backend has wins. A key only the renderer
 * has (kept in localStorage before the backend kept settings) is returned
 * as a change to send, which moves it to the backend once. A chat whose
 * settings changed while the list was loading keeps the newer local copy
 * (its own write-through carries it).
 */
export function mergeStoredThreadSettings(
  current: ThreadSettingsMap,
  persisted: ReadonlyArray<Pick<ChatThread, "id" | "settings">>,
  beforeLoad: ThreadSettingsMap
): {
  settingsByThread: ThreadSettingsMap
  migrations: Array<[string, ThreadSettingsChange]>
} {
  let settingsByThread = current
  const migrations: Array<[string, ThreadSettingsChange]> = []
  for (const thread of persisted) {
    const local = current[thread.id]
    if (local !== beforeLoad[thread.id]) continue
    const stored: StoredThreadSettings = thread.settings ?? {}
    let merged: ThreadSettings | undefined
    const migration: ThreadSettingsChange = {}
    for (const key of STORED_THREAD_SETTING_KEYS) {
      const storedValue = stored[key]
      const localValue = local?.[key]
      if (storedValue !== undefined && storedValue !== null) {
        if (sameValue(storedValue, localValue)) continue
        merged = Object.assign(merged ?? { ...local }, {
          [key]: storedValue,
        })
      } else if (!isUnset(localValue)) {
        migration[key] = localValue
      }
    }
    if (merged) {
      if (settingsByThread === current) settingsByThread = { ...current }
      settingsByThread[thread.id] = merged
    }
    if (Object.keys(migration).length > 0) {
      migrations.push([thread.id, migration])
    }
  }
  return { settingsByThread, migrations }
}

// ── Changes from other clients ────────────────────────────────────────────

/**
 * The keys of a chat this window changed and has not finished writing to
 * the backend. A push from another client leaves them alone: this window's
 * own write follows and is the newer one.
 */
export function unsettledThreadSettingKeys(threadId: string): Set<string> {
  return new Set([
    ...Object.keys(pending.get(threadId) ?? {}),
    ...Object.keys(inFlight.get(threadId) ?? {}),
  ])
}

/**
 * The settings another client just stored for a chat (the `settings` of a
 * `thread.metadata` push, whole), as a change to this window's copy: a key
 * the backend keeps sets it, a key it no longer keeps clears it (`null`).
 * Each key is checked alone, so a value this window cannot read is left
 * out and its own copy stays.
 */
export async function storedThreadSettingsChange(
  stored: Readonly<Record<string, unknown>>
): Promise<ThreadSettingsChange> {
  const { threadSettingsSchema } = await import("@betterc0de/schema")
  const change: ThreadSettingsChange = {}
  for (const key of STORED_THREAD_SETTING_KEYS) {
    const value = stored[key]
    if (value === undefined || value === null) {
      change[key] = null
      continue
    }
    const parsed = threadSettingsSchema.shape[key].safeParse(value)
    if (parsed.success) change[key] = parsed.data
  }
  return change
}

/**
 * A chat's settings with another client's change applied, or `null` when
 * nothing changes. `unsettled` keys (this window's own changes on their way
 * to the backend) keep their value.
 */
export function applyThreadSettingsChange(
  local: ThreadSettings | undefined,
  change: ThreadSettingsChange,
  unsettled: ReadonlySet<string>
): ThreadSettings | null {
  let next: ThreadSettings | undefined
  for (const key of STORED_THREAD_SETTING_KEYS) {
    if (!(key in change) || unsettled.has(key)) continue
    const value = change[key]
    if (value === null || value === undefined) {
      if (!local || !(key in local)) continue
      next ??= { ...local }
      delete next[key]
      continue
    }
    if (sameValue(local?.[key], value)) continue
    next = Object.assign(next ?? { ...local }, { [key]: value })
  }
  return next ?? null
}
