import { create, type StoreApi, type UseBoundStore } from "zustand"
import { useChatStore } from "@/lib/chat-store"

/**
 * Deleting a chat from the sidebar is undoable: the chat leaves the lists at
 * once, and the real deletion runs when the undo window passes, when the
 * window closes or reloads, or at the next start if the app quit before it
 * could. Undo inside the window cancels it. A journal in local storage
 * remembers deletions that are due, so a quit never resurrects a chat the
 * user deleted.
 */

export const DELETE_UNDO_MS = 8_000

const JOURNAL_KEY = "betterc0de:pending-thread-deletes"

type JournalEntry = { id: string; at: number }

type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

interface PendingDeletesState {
  /** Chats waiting for deletion or deleted in this session: hidden. */
  hidden: Readonly<Record<string, true>>
}

export interface PendingThreadDeletes {
  store: UseBoundStore<StoreApi<PendingDeletesState>>
  /** Hides the chats and deletes them after the delay; returns a batch id. */
  schedule: (threadIds: readonly string[]) => string
  /** Cancels a batch that has not run yet; false when it already ran. */
  cancel: (batchId: string) => boolean
  /** Runs every waiting deletion now (window closing). */
  flush: () => void
  /** Runs journaled deletions that were due when the app last quit. */
  resume: (now?: number) => string[]
  isPending: (batchId: string) => boolean
}

function readJournal(storage: JournalStorage | null): JournalEntry[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(JOURNAL_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is JournalEntry =>
        Boolean(entry) &&
        typeof (entry as JournalEntry).id === "string" &&
        typeof (entry as JournalEntry).at === "number"
    )
  } catch {
    return []
  }
}

function writeJournal(
  storage: JournalStorage | null,
  entries: readonly JournalEntry[]
): void {
  if (!storage) return
  try {
    if (entries.length === 0) storage.removeItem(JOURNAL_KEY)
    else storage.setItem(JOURNAL_KEY, JSON.stringify(entries))
  } catch {
    // Storage is optional; the deletion still runs in this session.
  }
}

export function createPendingThreadDeletes(deps: {
  commit: (threadId: string) => void
  storage: JournalStorage | null
  delayMs?: number
}): PendingThreadDeletes {
  const delayMs = deps.delayMs ?? DELETE_UNDO_MS
  const store = create<PendingDeletesState>(() => ({ hidden: {} }))
  const batches = new Map<
    string,
    { ids: string[]; timer: ReturnType<typeof setTimeout> }
  >()
  let sequence = 0

  const hide = (ids: readonly string[]) =>
    store.setState((state) => {
      const hidden = { ...state.hidden }
      for (const id of ids) hidden[id] = true
      return { hidden }
    })

  const unhide = (ids: readonly string[]) =>
    store.setState((state) => {
      const hidden = { ...state.hidden }
      for (const id of ids) delete hidden[id]
      return { hidden }
    })

  const forget = (ids: readonly string[]) => {
    const removing = new Set(ids)
    writeJournal(
      deps.storage,
      readJournal(deps.storage).filter((entry) => !removing.has(entry.id))
    )
  }

  const run = (batchId: string) => {
    const batch = batches.get(batchId)
    if (!batch) return
    clearTimeout(batch.timer)
    batches.delete(batchId)
    for (const id of batch.ids) deps.commit(id)
    forget(batch.ids)
  }

  return {
    store,

    schedule: (threadIds) => {
      const ids = [...new Set(threadIds)]
      sequence += 1
      const batchId = `delete-${Date.now().toString(36)}-${sequence}`
      if (ids.length === 0) return batchId
      hide(ids)
      const at = Date.now() + delayMs
      const removing = new Set(ids)
      writeJournal(deps.storage, [
        ...readJournal(deps.storage).filter((entry) => !removing.has(entry.id)),
        ...ids.map((id) => ({ id, at })),
      ])
      const timer = setTimeout(() => run(batchId), delayMs)
      batches.set(batchId, { ids, timer })
      return batchId
    },

    cancel: (batchId) => {
      const batch = batches.get(batchId)
      if (!batch) return false
      clearTimeout(batch.timer)
      batches.delete(batchId)
      forget(batch.ids)
      unhide(batch.ids)
      return true
    },

    flush: () => {
      for (const batchId of [...batches.keys()]) run(batchId)
    },

    resume: (now = Date.now()) => {
      // Entries not yet due belong to another window's undo window.
      const due = readJournal(deps.storage).filter((entry) => entry.at <= now)
      const ids = [...new Set(due.map((entry) => entry.id))]
      if (ids.length === 0) return []
      hide(ids)
      for (const id of ids) deps.commit(id)
      forget(ids)
      return ids
    },

    isPending: (batchId) => batches.has(batchId),
  }
}

function browserStorage(): JournalStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

export const pendingThreadDeletes = createPendingThreadDeletes({
  commit: (threadId) => useChatStore.getState().deleteThread(threadId),
  storage: browserStorage(),
})

export const usePendingDeletesStore = pendingThreadDeletes.store
