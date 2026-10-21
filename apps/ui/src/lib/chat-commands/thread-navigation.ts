import type { ChatThread } from "@/lib/chat-store"

/**
 * Which thread a navigation command lands on.
 *
 * Pure resolvers over a thread list: parent, child, sibling, the next one in
 * the session or project ring, a pinned slot, and the archive set. None of
 * them touch a store or the network, which is why they can live outside the
 * submit hook and be tested directly.
 */
export function resolveParentThread(
  threads: readonly ChatThread[],
  threadId: string | null | undefined
): ChatThread | null {
  if (!threadId) return null
  const current = threads.find((thread) => thread.id === threadId)
  if (!current?.parentThreadId) return null
  return threads.find((thread) => thread.id === current.parentThreadId) ?? null
}

export function resolveAdjacentSessionThread(
  threads: readonly ChatThread[],
  threadId: string | null | undefined,
  direction: 1 | -1
): ChatThread | null {
  if (threads.length < 2) return null
  const currentIndex = threads.findIndex((thread) => thread.id === threadId)
  const startIndex = currentIndex === -1 ? 0 : currentIndex
  const nextIndex = (startIndex + direction + threads.length) % threads.length
  return threads[nextIndex] ?? null
}

export function resolveAdjacentProjectThread(
  threads: readonly ChatThread[],
  threadId: string | null | undefined,
  direction: 1 | -1
): ChatThread | null {
  const byProject = new Map<string, ChatThread>()
  for (const thread of [...threads].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  )) {
    const key = projectNavigationKey(thread)
    if (!key || byProject.has(key)) continue
    byProject.set(key, thread)
  }
  const projectThreads = [...byProject.values()]
  if (projectThreads.length < 2) return null

  const current = threads.find((thread) => thread.id === threadId)
  const currentKey = current ? projectNavigationKey(current) : ""
  const currentIndex = projectThreads.findIndex(
    (thread) => projectNavigationKey(thread) === currentKey
  )
  const startIndex = currentIndex === -1 ? 0 : currentIndex
  const nextIndex =
    (startIndex + direction + projectThreads.length) % projectThreads.length
  return projectThreads[nextIndex] ?? null
}

function projectNavigationKey(thread: ChatThread): string {
  return (thread.projectPath || thread.worktreePath || "")
    .trim()
    .replace(/\\/g, "/")
    .toLowerCase()
}

export function resolveChildThread(
  threads: readonly ChatThread[],
  threadId: string | null | undefined,
  query = ""
): ChatThread | null {
  if (!threadId) return null
  const children = threads
    .filter((thread) => thread.parentThreadId === threadId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  if (children.length === 0) return null

  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return children[0] ?? null
  return (
    children.find((thread) => {
      const title = thread.title.toLowerCase()
      return (
        thread.id.toLowerCase().startsWith(normalizedQuery) ||
        title.includes(normalizedQuery)
      )
    }) ?? null
  )
}

export function resolveSiblingChildThread(
  threads: readonly ChatThread[],
  threadId: string | null | undefined,
  direction: 1 | -1
): ChatThread | null {
  if (!threadId) return null
  const current = threads.find((thread) => thread.id === threadId)
  if (!current?.parentThreadId) return null
  const siblings = threads
    .filter((thread) => thread.parentThreadId === current.parentThreadId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  if (siblings.length < 2) return null
  const currentIndex = siblings.findIndex((thread) => thread.id === threadId)
  if (currentIndex === -1) return null
  const nextIndex =
    (currentIndex + direction + siblings.length) % siblings.length
  return siblings[nextIndex] ?? null
}

export function resolvePinnedThreadSlot(
  threads: readonly ChatThread[],
  pinnedThreadIds: ReadonlySet<string>,
  slot: number
): ChatThread | null {
  if (!Number.isInteger(slot) || slot < 1 || slot > 9) return null
  const pinned = [...pinnedThreadIds]
    .map((id) => threads.find((thread) => thread.id === id) ?? null)
    .filter((thread): thread is ChatThread => Boolean(thread))
  return pinned[slot - 1] ?? null
}

export function resolveSessionCommandThread(
  threads: readonly ChatThread[],
  activeThreadId: string | null | undefined,
  query: string
): ChatThread | null {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return threads.find((thread) => thread.id === activeThreadId) ?? null
  }
  return (
    threads.find((thread) => thread.id.toLowerCase() === normalized) ??
    threads.find((thread) => thread.id.toLowerCase().startsWith(normalized)) ??
    threads.find((thread) => thread.title.toLowerCase().includes(normalized)) ??
    null
  )
}

export function archivedThreadIdsAfterAction(
  currentIds: readonly string[],
  threadId: string,
  action: "archive" | "unarchive"
): string[] {
  const ids = new Set(currentIds)
  if (action === "archive") ids.add(threadId)
  else ids.delete(threadId)
  return [...ids]
}
