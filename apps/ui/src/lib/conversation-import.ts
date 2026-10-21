import type {
  ConversationImportCandidate,
  ConversationImportProvider,
} from "@betterc0de/schema"

/**
 * Pure helpers for the conversation import picker
 * (`components/conversation-import/`): grouping sessions by project,
 * selection state and the labels rows show.
 */

export type ConversationImportFilter = "all" | ConversationImportProvider

/** Sessions an import request names at once; small enough for steady progress. */
export const CONVERSATION_IMPORT_UI_BATCH = 5

export const CONVERSATION_IMPORT_PROVIDER_NAMES: Record<
  ConversationImportProvider,
  string
> = {
  claude: "Claude Code",
  codex: "Codex",
}

/** `claude:<session id>`, the picker's selection key. */
export function conversationImportKey(candidate: {
  provider: ConversationImportProvider
  sessionId: string
}): string {
  return `${candidate.provider}:${candidate.sessionId}`
}

/** Not in a BetterC0de chat yet. */
export function isImportable(candidate: ConversationImportCandidate): boolean {
  return candidate.threadId === null
}

export interface ConversationImportGroup {
  key: string
  /** The project's name, or null for sessions without a known folder. */
  name: string | null
  path: string | null
  folderExists: boolean
  candidates: ConversationImportCandidate[]
}

/**
 * Sessions grouped by their project folder, in the order of each group's
 * newest session (the candidates arrive newest first). Sessions without a
 * folder form one group of their own.
 */
export function groupConversationCandidates(
  candidates: readonly ConversationImportCandidate[]
): ConversationImportGroup[] {
  const groups = new Map<string, ConversationImportGroup>()
  for (const candidate of candidates) {
    const key = candidate.projectPath ?? ""
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        name: candidate.projectPath ? candidate.projectName : null,
        path: candidate.projectPath,
        folderExists: candidate.folderExists,
        candidates: [],
      }
      groups.set(key, group)
    }
    group.candidates.push(candidate)
  }
  return [...groups.values()]
}

export function filterConversationCandidates(
  candidates: readonly ConversationImportCandidate[],
  filter: ConversationImportFilter
): ConversationImportCandidate[] {
  return filter === "all"
    ? [...candidates]
    : candidates.filter((candidate) => candidate.provider === filter)
}

/** A group's checkbox: all, none or some of its importable sessions selected. */
export function groupSelectionState(
  group: ConversationImportGroup,
  selected: ReadonlySet<string>
): boolean | "indeterminate" {
  const keys = group.candidates.filter(isImportable).map(conversationImportKey)
  if (keys.length === 0) return false
  const count = keys.filter((key) => selected.has(key)).length
  if (count === 0) return false
  return count === keys.length ? true : "indeterminate"
}

/** `selected` with every importable session of `candidates` added or removed. */
export function withSelection(
  selected: ReadonlySet<string>,
  candidates: readonly ConversationImportCandidate[],
  checked: boolean
): Set<string> {
  const next = new Set(selected)
  for (const candidate of candidates) {
    if (!isImportable(candidate)) continue
    const key = conversationImportKey(candidate)
    if (checked) next.add(key)
    else next.delete(key)
  }
  return next
}

/** "3h ago" within a week, else the date ("12 Mar", with the year when it differs). */
export function formatSessionDate(iso: string, now = new Date()): string {
  const date = new Date(iso)
  const time = date.getTime()
  if (!Number.isFinite(time)) return ""
  const minutes = Math.floor((now.getTime() - time) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== now.getFullYear()
      ? { year: "numeric" as const }
      : {}),
  })
}

/** "24 messages", "1 message", or "" while the count is unknown. */
export function formatMessageCount(count: number | null): string {
  if (count === null) return ""
  return `${count} ${count === 1 ? "message" : "messages"}`
}
