import {
  CHAT_FOLDER_LIMIT,
  CHAT_FOLDER_NAME_MAX,
  CHAT_FOLDER_THREAD_LIMIT,
  type ChatFolder,
} from "@betterc0de/schema"

/**
 * Edits of the compact chat list's folders (`settings.chat_folders`). A chat
 * lives in at most one folder. Every edit returns a new array, or the input
 * itself when nothing changes, so a caller can skip writing settings by
 * comparing references.
 */

export type { ChatFolder }

/** A folder name as settings keep it, or null when nothing is left. */
export function chatFolderName(raw: string): string | null {
  const name = raw
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_FOLDER_NAME_MAX)
    .trim()
  return name || null
}

/** Unique enough for a list of at most a hundred folders, and available in
 *  a paired browser on plain HTTP, where `crypto.randomUUID` is not. */
export function newChatFolderId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `folder-${random}`
}

export function folderOfThread(
  folders: readonly ChatFolder[],
  threadId: string
): ChatFolder | undefined {
  return folders.find((folder) => folder.thread_ids.includes(threadId))
}

export function canAddChatFolder(folders: readonly ChatFolder[]): boolean {
  return folders.length < CHAT_FOLDER_LIMIT
}

/** Adds a folder at the end, optionally with one chat moved into it. */
export function addChatFolder(
  folders: ChatFolder[],
  folder: { id: string; name: string },
  threadId?: string
): ChatFolder[] {
  if (!canAddChatFolder(folders)) return folders
  const emptied = threadId
    ? placeChatInFolder(folders, threadId, null)
    : folders
  return [
    ...emptied,
    {
      id: folder.id,
      name: folder.name,
      thread_ids: threadId ? [threadId] : [],
    },
  ]
}

export function renameChatFolder(
  folders: ChatFolder[],
  folderId: string,
  name: string
): ChatFolder[] {
  const target = folders.find((folder) => folder.id === folderId)
  if (!target || target.name === name) return folders
  return folders.map((folder) =>
    folder.id === folderId ? { ...folder, name } : folder
  )
}

/** Removes a folder; its chats go back to the list. */
export function removeChatFolder(
  folders: ChatFolder[],
  folderId: string
): ChatFolder[] {
  const next = folders.filter((folder) => folder.id !== folderId)
  return next.length === folders.length ? folders : next
}

/** Moves a folder before `beforeId`, or to the end when it is null. */
export function moveChatFolder(
  folders: ChatFolder[],
  folderId: string,
  beforeId: string | null
): ChatFolder[] {
  const moving = folders.find((folder) => folder.id === folderId)
  if (!moving || beforeId === folderId) return folders
  const rest = folders.filter((folder) => folder.id !== folderId)
  const index =
    beforeId === null
      ? rest.length
      : rest.findIndex((folder) => folder.id === beforeId)
  if (index < 0) return folders
  const next = [...rest.slice(0, index), moving, ...rest.slice(index)]
  return next.every((folder, i) => folder === folders[i]) ? folders : next
}

/** One step up (-1) or down (1), for the folder menu. */
export function shiftChatFolder(
  folders: ChatFolder[],
  folderId: string,
  step: -1 | 1
): ChatFolder[] {
  const index = folders.findIndex((folder) => folder.id === folderId)
  if (index < 0) return folders
  if (step === -1) {
    return index === 0
      ? folders
      : moveChatFolder(folders, folderId, folders[index - 1]!.id)
  }
  if (index === folders.length - 1) return folders
  return moveChatFolder(folders, folderId, folders[index + 2]?.id ?? null)
}

/**
 * Puts a chat into a folder, before `beforeThreadId` or at the folder's end,
 * and out of any other folder. A null target takes it out of every folder.
 */
export function placeChatInFolder(
  folders: ChatFolder[],
  threadId: string,
  target: { folderId: string; beforeThreadId?: string | null } | null
): ChatFolder[] {
  if (target?.beforeThreadId === threadId) return folders
  if (target) {
    const destination = folders.find((folder) => folder.id === target.folderId)
    if (!destination) return folders
    if (
      !destination.thread_ids.includes(threadId) &&
      destination.thread_ids.length >= CHAT_FOLDER_THREAD_LIMIT
    ) {
      return folders
    }
  }
  let changed = false
  const next = folders.map((folder) => {
    const ids = folder.thread_ids.filter((id) => id !== threadId)
    if (!target || folder.id !== target.folderId) {
      if (ids.length === folder.thread_ids.length) return folder
      changed = true
      return { ...folder, thread_ids: ids }
    }
    const at = target.beforeThreadId ? ids.indexOf(target.beforeThreadId) : -1
    const index = at < 0 ? ids.length : at
    const placed = [...ids.slice(0, index), threadId, ...ids.slice(index)]
    if (placed.every((id, i) => id === folder.thread_ids[i])) return folder
    changed = true
    return { ...folder, thread_ids: placed }
  })
  return changed ? next : folders
}

/**
 * {@link placeChatInFolder} for several chats (a dragged selection), which
 * keep the order given. A position on one of the moving chats lands before
 * the next chat of that folder that stays.
 */
export function placeChatsInFolder(
  folders: ChatFolder[],
  threadIds: readonly string[],
  target: { folderId: string; beforeThreadId?: string | null } | null
): ChatFolder[] {
  const moving = [...new Set(threadIds)]
  let beforeThreadId = target?.beforeThreadId ?? null
  if (target && beforeThreadId && moving.includes(beforeThreadId)) {
    const destination = folders.find((folder) => folder.id === target.folderId)
    const ids = destination?.thread_ids ?? []
    const start = ids.indexOf(beforeThreadId)
    beforeThreadId =
      start < 0
        ? null
        : (ids.slice(start).find((id) => !moving.includes(id)) ?? null)
  }
  let next = folders
  for (const threadId of moving) {
    next = placeChatInFolder(
      next,
      threadId,
      target ? { folderId: target.folderId, beforeThreadId } : null
    )
  }
  return next
}

/** Where each chat is filed now: folder and position, or null. */
export function chatPlacements(
  folders: readonly ChatFolder[],
  threadIds: readonly string[]
): Array<{ threadId: string; folderId: string | null; index: number }> {
  return threadIds.map((threadId) => {
    for (const folder of folders) {
      const index = folder.thread_ids.indexOf(threadId)
      if (index >= 0) return { threadId, folderId: folder.id, index }
    }
    return { threadId, folderId: null, index: -1 }
  })
}

/**
 * Undo of a move: each chat goes back to the folder and position it had
 * (or out of every folder). A folder removed since then is skipped.
 */
export function restoreChatPlacements(
  folders: ChatFolder[],
  placements: ReadonlyArray<{
    threadId: string
    folderId: string | null
    index: number
  }>
): ChatFolder[] {
  const restoring = new Set(placements.map((entry) => entry.threadId))
  let changed = false
  let next = folders.map((folder) => {
    const ids = folder.thread_ids.filter((id) => !restoring.has(id))
    if (ids.length === folder.thread_ids.length) return folder
    changed = true
    return { ...folder, thread_ids: ids }
  })
  const filed = [...placements]
    .filter((entry) => entry.folderId !== null)
    .sort((a, b) => a.index - b.index)
  for (const entry of filed) {
    next = next.map((folder) => {
      if (folder.id !== entry.folderId) return folder
      if (folder.thread_ids.length >= CHAT_FOLDER_THREAD_LIMIT) return folder
      changed = true
      const ids = [...folder.thread_ids]
      ids.splice(Math.min(entry.index, ids.length), 0, entry.threadId)
      return { ...folder, thread_ids: ids }
    })
  }
  if (!changed) return folders
  const unchanged =
    next.length === folders.length &&
    next.every(
      (folder, i) =>
        folder.id === folders[i]!.id &&
        folder.thread_ids.length === folders[i]!.thread_ids.length &&
        folder.thread_ids.every((id, j) => id === folders[i]!.thread_ids[j])
    )
  return unchanged ? folders : next
}

/**
 * Undo of removing a folder: it comes back at `index` with its chats,
 * except chats filed elsewhere since. Nothing happens when a folder with
 * that id exists again or the limit is reached.
 */
export function restoreChatFolder(
  folders: ChatFolder[],
  folder: ChatFolder,
  index: number
): ChatFolder[] {
  if (folders.some((entry) => entry.id === folder.id)) return folders
  if (!canAddChatFolder(folders)) return folders
  const filed = new Set(folders.flatMap((entry) => entry.thread_ids))
  const restored: ChatFolder = {
    ...folder,
    thread_ids: folder.thread_ids.filter((id) => !filed.has(id)),
  }
  const at = Math.max(0, Math.min(index, folders.length))
  return [...folders.slice(0, at), restored, ...folders.slice(at)]
}

/** Takes chats out of every folder (deleted chats). */
export function removeChatsFromFolders(
  folders: ChatFolder[],
  threadIds: readonly string[]
): ChatFolder[] {
  return placeChatsInFolder(folders, threadIds, null)
}
