import { create } from "zustand"

/**
 * The chat lists' undo stack: archive, delete, pin, snooze, filing a chat
 * and removing a folder each push an entry that puts things back. Ctrl/Cmd+Z
 * (outside text fields) takes the newest one, the toast's Undo button its
 * own. Entries expire, so an old change is not undone by surprise, and a
 * deletion stops being undoable once it ran.
 */

export interface ChatListUndoEntry {
  id: string
  /** What the change did, for the toast after undoing it ("Archived “x”"). */
  label: string
  createdAt: number
  expiresAt: number
  undo: () => void
}

export const UNDO_STACK_LIMIT = 20
/** How long a change stays undoable by default. */
export const UNDO_ENTRY_TTL_MS = 10 * 60 * 1000

let undoSequence = 0

function newUndoId(): string {
  undoSequence += 1
  return `chat-undo-${Date.now().toString(36)}-${undoSequence}`
}

/** Adds an entry on top, dropping expired ones and the oldest past the limit. */
export function pushUndoEntry(
  entries: readonly ChatListUndoEntry[],
  entry: ChatListUndoEntry,
  now: number
): ChatListUndoEntry[] {
  const live = entries.filter((item) => item.expiresAt > now)
  const next = [...live, entry]
  return next.slice(Math.max(0, next.length - UNDO_STACK_LIMIT))
}

/**
 * Takes the entry with `id`, or the newest one still live, off the stack.
 * Expired entries are dropped on the way.
 */
export function takeUndoEntry(
  entries: readonly ChatListUndoEntry[],
  now: number,
  id?: string
): { entry: ChatListUndoEntry | null; rest: ChatListUndoEntry[] } {
  const live = entries.filter((item) => item.expiresAt > now)
  const index =
    id === undefined
      ? live.length - 1
      : live.findIndex((item) => item.id === id)
  if (index < 0) return { entry: null, rest: live }
  return {
    entry: live[index] ?? null,
    rest: [...live.slice(0, index), ...live.slice(index + 1)],
  }
}

interface ChatListUndoState {
  entries: ChatListUndoEntry[]
  /** Records a change; returns the entry id for the toast's Undo button. */
  push: (change: { label: string; undo: () => void; ttlMs?: number }) => string
  /** Undoes the entry with `id`, or the newest one; returns it, or null. */
  undo: (id?: string) => ChatListUndoEntry | null
  /** Forgets an entry that can no longer be undone (a deletion that ran). */
  discard: (id: string) => void
  clear: () => void
}

export const useChatListUndoStore = create<ChatListUndoState>((set, get) => ({
  entries: [],

  push: ({ label, undo, ttlMs = UNDO_ENTRY_TTL_MS }) => {
    const now = Date.now()
    const entry: ChatListUndoEntry = {
      id: newUndoId(),
      label,
      createdAt: now,
      expiresAt: now + ttlMs,
      undo,
    }
    set({ entries: pushUndoEntry(get().entries, entry, now) })
    return entry.id
  },

  undo: (id) => {
    const { entry, rest } = takeUndoEntry(get().entries, Date.now(), id)
    set({ entries: rest })
    if (!entry) return null
    entry.undo()
    return entry
  },

  discard: (id) => {
    const entries = get().entries
    const next = entries.filter((entry) => entry.id !== id)
    if (next.length !== entries.length) set({ entries: next })
  },

  clear: () => set({ entries: [] }),
}))
