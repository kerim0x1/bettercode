import type { ChatFolder, SnoozedChat } from "@betterc0de/schema"
import { useChatStore } from "@/lib/chat-store"
import {
  chatPlacements,
  placeChatsInFolder,
  removeChatFolder,
  removeChatsFromFolders,
  restoreChatFolder,
  restoreChatPlacements,
} from "@/lib/chat-folders"
import { useChatListUndoStore } from "@/lib/chat-list-undo"
import {
  arePinned,
  pinChats as pinIds,
  restorePinnedChats,
  unpinChats as unpinIds,
} from "@/lib/chat-pins"
import {
  formatSnoozeTime,
  restoreSnoozes,
  snoozeChats as snoozeIds,
  snoozeEntryFor,
  unsnoozeChats as unsnoozeIds,
} from "@/lib/chat-snooze"
import {
  DELETE_UNDO_MS,
  pendingThreadDeletes,
} from "@/lib/pending-thread-deletes"
import { useSettingsStore } from "@/lib/settings-store"
import { toast } from "@/lib/toast"

/**
 * What the chat lists' menus, bulk bar, drag and drop and `/pin` do with
 * chats: pin, snooze, file, archive and delete them. Each change is saved
 * to settings and pushed on the undo stack (`chat-list-undo.ts`), with a
 * toast offering Undo while toasts are on. Deleting goes through
 * `pending-thread-deletes.ts`, so it is undoable for a few seconds.
 */

const UNDO_TOAST_ID = "chat-list-undo"
const UNDO_TOAST_MS = 6_000

export interface ChatListActionOptions {
  /** Offer Undo in a toast (default). The undo stack gets it either way. */
  toast?: boolean
}

type ListSettingsPatch = {
  pinned_thread_ids?: string[]
  snoozed_threads?: SnoozedChat[]
  chat_folders?: ChatFolder[]
  archived_thread_ids?: string[]
}

function unique(threadIds: readonly string[]): string[] {
  return [...new Set(threadIds)]
}

function saveListSettings(patch: ListSettingsPatch): void {
  if (Object.keys(patch).length === 0) return
  void useSettingsStore.getState().update(patch)
}

/** “Fix login flow”, or “3 chats”. */
export function chatListLabel(threadIds: readonly string[]): string {
  if (threadIds.length !== 1) return `${threadIds.length} chats`
  const title =
    useChatStore
      .getState()
      .threads.find((thread) => thread.id === threadIds[0])
      ?.title?.trim() || "New Chat"
  return `“${title.length > 40 ? `${title.slice(0, 39)}…` : title}”`
}

function record(
  label: string,
  undo: () => void,
  options: ChatListActionOptions & { ttlMs?: number; toastMs?: number } = {}
): string {
  const id = useChatListUndoStore.getState().push({
    label,
    undo,
    ttlMs: options.ttlMs,
  })
  if (options.toast !== false && useSettingsStore.getState().toastEnabled) {
    toast.action(label, {
      id: UNDO_TOAST_ID,
      duration: options.toastMs ?? UNDO_TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => {
          undoChatListChange(id)
        },
      },
    })
  }
  return id
}

/**
 * Undoes the change with `id` (a toast's), or the newest one (Ctrl/Cmd+Z).
 * Returns false when there is nothing left to undo.
 */
export function undoChatListChange(id?: string): boolean {
  const entry = useChatListUndoStore.getState().undo(id)
  if (!entry) return false
  if (useSettingsStore.getState().toastEnabled) {
    toast.success("Undone", {
      id: UNDO_TOAST_ID,
      description: entry.label,
      duration: 2_500,
    })
  } else {
    toast.dismiss(UNDO_TOAST_ID)
  }
  return true
}

// ── Pins ────────────────────────────────────────────────────────────────

/**
 * Pins chats before `beforeId` (or at the end). Dragging pinned chats into
 * a new order is undoable too, without a toast.
 */
export function pinChats(
  threadIds: readonly string[],
  options: ChatListActionOptions & { beforeId?: string | null } = {}
): void {
  const ids = unique(threadIds)
  const previous = useSettingsStore.getState().pinnedThreadIds
  const next = pinIds(previous, ids, options.beforeId ?? null)
  if (next === previous) return
  saveListSettings({ pinned_thread_ids: next })
  const added = ids.filter((id) => !previous.includes(id))
  record(
    added.length > 0
      ? `Pinned ${chatListLabel(added)}`
      : `Moved ${chatListLabel(ids)} in Pinned`,
    () => {
      const current = useSettingsStore.getState().pinnedThreadIds
      const restored = restorePinnedChats(current, ids, previous)
      if (restored !== current) {
        saveListSettings({ pinned_thread_ids: restored })
      }
    },
    { toast: added.length > 0 && options.toast !== false }
  )
}

export function unpinChats(
  threadIds: readonly string[],
  options: ChatListActionOptions = {}
): void {
  const ids = unique(threadIds)
  const previous = useSettingsStore.getState().pinnedThreadIds
  const next = unpinIds(previous, ids)
  if (next === previous) return
  saveListSettings({ pinned_thread_ids: next })
  record(
    `Unpinned ${chatListLabel(ids.filter((id) => previous.includes(id)))}`,
    () => {
      const current = useSettingsStore.getState().pinnedThreadIds
      const restored = restorePinnedChats(current, ids, previous)
      if (restored !== current) {
        saveListSettings({ pinned_thread_ids: restored })
      }
    },
    options
  )
}

/** Unpins when every chat is pinned, else pins them all. */
export function togglePinnedChats(
  threadIds: readonly string[],
  options: ChatListActionOptions = {}
): "pinned" | "unpinned" {
  if (arePinned(useSettingsStore.getState().pinnedThreadIds, threadIds)) {
    unpinChats(threadIds, options)
    return "unpinned"
  }
  pinChats(threadIds, options)
  return "pinned"
}

// ── Folders ─────────────────────────────────────────────────────────────

/**
 * Files chats in a folder (before `beforeThreadId`, or at its end), or takes
 * them out of every folder with a null target. Filing a pinned chat unpins
 * it, so it shows where it was put. Reordering inside one folder is
 * undoable without a toast.
 */
export function moveChatsToFolder(
  threadIds: readonly string[],
  target: { folderId: string; beforeThreadId?: string | null } | null,
  options: ChatListActionOptions = {}
): void {
  const ids = unique(threadIds)
  const settings = useSettingsStore.getState()
  const previousFolders = settings.chatFolders
  const previousPins = settings.pinnedThreadIds
  const placements = chatPlacements(previousFolders, ids)
  const nextFolders = placeChatsInFolder(previousFolders, ids, target)
  // Only chats that landed in the folder leave Pinned (a full folder
  // takes none).
  const filed = target
    ? new Set(
        nextFolders.find((folder) => folder.id === target.folderId)
          ?.thread_ids ?? []
      )
    : null
  const nextPins = filed
    ? unpinIds(
        previousPins,
        ids.filter((id) => filed.has(id))
      )
    : previousPins
  if (nextFolders === previousFolders && nextPins === previousPins) return
  const patch: ListSettingsPatch = {}
  if (nextFolders !== previousFolders) patch.chat_folders = nextFolders
  if (nextPins !== previousPins) patch.pinned_thread_ids = nextPins
  saveListSettings(patch)

  const folderName = target
    ? previousFolders.find((folder) => folder.id === target.folderId)?.name
    : undefined
  const reorderOnly =
    target !== null &&
    nextPins === previousPins &&
    placements.every((entry) => entry.folderId === target.folderId)
  record(
    target
      ? `Moved ${chatListLabel(ids)} to “${folderName ?? "folder"}”`
      : `Took ${chatListLabel(ids)} out of ${ids.length === 1 ? "its folder" : "their folders"}`,
    () => {
      const current = useSettingsStore.getState()
      const undo: ListSettingsPatch = {}
      const folders = restoreChatPlacements(current.chatFolders, placements)
      if (folders !== current.chatFolders) undo.chat_folders = folders
      const pins = restorePinnedChats(
        current.pinnedThreadIds,
        ids,
        previousPins
      )
      if (pins !== current.pinnedThreadIds) undo.pinned_thread_ids = pins
      saveListSettings(undo)
    },
    { toast: !reorderOnly && options.toast !== false }
  )
}

/** Removes a folder; its chats go back to the list. Undo brings it back. */
export function removeChatFolderWithUndo(folderId: string): void {
  const folders = useSettingsStore.getState().chatFolders
  const index = folders.findIndex((folder) => folder.id === folderId)
  const folder = folders[index]
  if (!folder) return
  saveListSettings({ chat_folders: removeChatFolder(folders, folderId) })
  record(`Removed folder “${folder.name}”`, () => {
    const current = useSettingsStore.getState().chatFolders
    const restored = restoreChatFolder(current, folder, index)
    if (restored !== current) saveListSettings({ chat_folders: restored })
  })
}

// ── Snooze ──────────────────────────────────────────────────────────────

function runningThreadIds(threadIds: readonly string[]): Set<string> {
  const chat = useChatStore.getState()
  return new Set(
    threadIds.filter(
      (id) =>
        chat.streamingByThread[id]?.isStreaming === true ||
        Boolean(
          chat.threads.find((thread) => thread.id === id)?.session?.activeTurnId
        )
    )
  )
}

export function snoozeChats(
  threadIds: readonly string[],
  until: Date,
  options: ChatListActionOptions = {}
): void {
  const ids = unique(threadIds)
  if (ids.length === 0 || !(until.getTime() > Date.now())) return
  const previous = useSettingsStore.getState().snoozedThreads
  const now = new Date()
  const next = snoozeIds(previous, ids, until, now, runningThreadIds(ids))
  saveListSettings({ snoozed_threads: next })
  record(
    `Snoozed ${chatListLabel(ids)} until ${formatSnoozeTime(until, now)}`,
    () => {
      const current = useSettingsStore.getState().snoozedThreads
      const restored = restoreSnoozes(current, ids, previous)
      if (restored !== current) saveListSettings({ snoozed_threads: restored })
    },
    options
  )
}

/**
 * Wakes snoozed chats, or with `seen` clears the Back mark of chats that
 * already came back.
 */
export function unsnoozeChats(
  threadIds: readonly string[],
  options: ChatListActionOptions & { seen?: boolean } = {}
): void {
  const ids = unique(threadIds)
  const previous = useSettingsStore.getState().snoozedThreads
  const next = unsnoozeIds(previous, ids)
  if (next === previous) return
  saveListSettings({ snoozed_threads: next })
  const affected = ids.filter((id) => snoozeEntryFor(previous, id))
  record(
    options.seen
      ? `Marked ${chatListLabel(affected)} as seen`
      : `Unsnoozed ${chatListLabel(affected)}`,
    () => {
      const current = useSettingsStore.getState().snoozedThreads
      const restored = restoreSnoozes(current, ids, previous)
      if (restored !== current) saveListSettings({ snoozed_threads: restored })
    },
    options
  )
}

/**
 * Opening a chat ends its snooze: it was back, or the user wants it now.
 * Quiet and not on the undo stack.
 */
export function clearSnoozeOnOpen(threadId: string): void {
  const entries = useSettingsStore.getState().snoozedThreads
  if (!snoozeEntryFor(entries, threadId)) return
  saveListSettings({ snoozed_threads: unsnoozeIds(entries, [threadId]) })
}

// ── Archive and delete ──────────────────────────────────────────────────

export function archiveChats(
  threadIds: readonly string[],
  options: ChatListActionOptions = {}
): string | null {
  const previous = useSettingsStore.getState().archivedThreadIds
  const adding = unique(threadIds).filter((id) => !previous.includes(id))
  if (adding.length === 0) return null
  saveListSettings({ archived_thread_ids: [...previous, ...adding] })
  return record(
    `Archived ${chatListLabel(adding)}`,
    () => {
      const current = useSettingsStore.getState().archivedThreadIds
      const next = current.filter((id) => !adding.includes(id))
      if (next.length !== current.length) {
        saveListSettings({ archived_thread_ids: next })
      }
    },
    options
  )
}

export function unarchiveChats(
  threadIds: readonly string[],
  options: ChatListActionOptions = {}
): string | null {
  const previous = useSettingsStore.getState().archivedThreadIds
  const removing = unique(threadIds).filter((id) => previous.includes(id))
  if (removing.length === 0) return null
  saveListSettings({
    archived_thread_ids: previous.filter((id) => !removing.includes(id)),
  })
  return record(
    `Restored ${chatListLabel(removing)}`,
    () => {
      const current = useSettingsStore.getState().archivedThreadIds
      const adding = removing.filter((id) => !current.includes(id))
      if (adding.length > 0) {
        saveListSettings({ archived_thread_ids: [...current, ...adding] })
      }
    },
    options
  )
}

/**
 * Hides chats now and deletes them after {@link DELETE_UNDO_MS} unless
 * undone. Returns the undo entry id (for an Undo of the caller's own).
 */
export function deleteChats(
  threadIds: readonly string[],
  options: ChatListActionOptions = {}
): string | null {
  const ids = unique(threadIds)
  if (ids.length === 0) return null
  const label = `Deleted ${chatListLabel(ids)}`
  const batchId = pendingThreadDeletes.schedule(ids)
  // Expires a moment before the deletion runs, so Undo never claims to
  // bring back a chat that is already gone.
  return record(
    label,
    () => {
      pendingThreadDeletes.cancel(batchId)
    },
    { ...options, ttlMs: DELETE_UNDO_MS - 250, toastMs: DELETE_UNDO_MS }
  )
}

/**
 * Forgets deleted chats in the pins, snoozes, folders and archive. Called
 * when chats leave the chat store, whichever way they were deleted.
 */
export function forgetDeletedChats(threadIds: readonly string[]): void {
  const ids = unique(threadIds)
  if (ids.length === 0) return
  const settings = useSettingsStore.getState()
  if (!settings.loaded) return
  const removing = new Set(ids)
  const patch: ListSettingsPatch = {}
  const pins = unpinIds(settings.pinnedThreadIds, ids)
  if (pins !== settings.pinnedThreadIds) patch.pinned_thread_ids = pins
  const snoozes = unsnoozeIds(settings.snoozedThreads, ids)
  if (snoozes !== settings.snoozedThreads) patch.snoozed_threads = snoozes
  const folders = removeChatsFromFolders(settings.chatFolders, ids)
  if (folders !== settings.chatFolders) patch.chat_folders = folders
  const archived = settings.archivedThreadIds.filter((id) => !removing.has(id))
  if (archived.length !== settings.archivedThreadIds.length) {
    patch.archived_thread_ids = archived
  }
  saveListSettings(patch)
}
