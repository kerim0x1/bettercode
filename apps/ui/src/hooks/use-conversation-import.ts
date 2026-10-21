import type {
  ChatThread,
  ConversationImportCandidate,
  ConversationImportList,
} from "@betterc0de/schema"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cacheThreadSettings, useChatStore } from "@/lib/chat-store"
import {
  CONVERSATION_IMPORT_UI_BATCH,
  conversationImportKey,
  filterConversationCandidates,
  groupConversationCandidates,
  isImportable,
  type ConversationImportFilter,
  type ConversationImportGroup,
} from "@/lib/conversation-import"
import { mergeStoredThreadSettings } from "@/lib/thread-settings-sync"
import {
  importConversations,
  listConversationImports,
} from "@/services/backend/conversation-import-api"
import { mergePersistedThreadSkeletons } from "@/hooks/use-persisted-threads"

export interface ConversationImportOutcome {
  imported: number
  /** Already in BetterC0de. */
  skipped: number
  failed: Array<{ key: string; title: string; error: string }>
}

export interface ConversationImportState {
  list: ConversationImportList | null
  loading: boolean
  loadError: string | null
  filter: ConversationImportFilter
  setFilter: (filter: ConversationImportFilter) => void
  /** The filtered sessions, grouped by project. */
  groups: ConversationImportGroup[]
  /** Sessions shown under the filter that can still be imported. */
  importableCount: number
  selected: ReadonlySet<string>
  /** Selected sessions that can be imported, under any filter. */
  selectedCount: number
  setSelected: (selected: ReadonlySet<string>) => void
  toggle: (candidate: ConversationImportCandidate) => void
  importing: boolean
  progress: { done: number; total: number } | null
  outcome: ConversationImportOutcome | null
  reload: (refresh?: boolean) => void
  runImport: () => Promise<ConversationImportOutcome | null>
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** Puts imported chats into the chat list without reloading it. */
function addImportedThreads(threads: ChatThread[]): void {
  if (threads.length === 0) return
  useChatStore.setState((state) => ({
    settingsByThread: mergeStoredThreadSettings(
      state.settingsByThread,
      threads,
      state.settingsByThread
    ).settingsByThread,
    threads: mergePersistedThreadSkeletons(state.threads, threads),
  }))
  cacheThreadSettings()
}

/**
 * The conversation import picker's state: the sessions the backend found,
 * the selection, and an import that runs in small batches so the picker can
 * show its progress. The scan starts when the picker mounts.
 */
export function useConversationImport(): ConversationImportState {
  const [list, setList] = useState<ConversationImportList | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ConversationImportFilter>("all")
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  )
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<{
    done: number
    total: number
  } | null>(null)
  const [outcome, setOutcome] = useState<ConversationImportOutcome | null>(null)
  const mounted = useRef(true)
  const loadSeq = useRef(0)

  const reload = useCallback((refresh = false) => {
    const seq = ++loadSeq.current
    setLoading(true)
    setLoadError(null)
    listConversationImports({ refresh })
      .then((next) => {
        if (!mounted.current || seq !== loadSeq.current) return
        setList(next)
      })
      .catch((error: unknown) => {
        if (!mounted.current || seq !== loadSeq.current) return
        setLoadError(
          errorText(error, "Couldn't read the earlier conversations.")
        )
      })
      .finally(() => {
        if (mounted.current && seq === loadSeq.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    mounted.current = true
    reload()
    return () => {
      mounted.current = false
    }
  }, [reload])

  const groups = useMemo(
    () =>
      groupConversationCandidates(
        filterConversationCandidates(list?.candidates ?? [], filter)
      ),
    [list, filter]
  )
  const importableCount = useMemo(
    () =>
      groups.reduce(
        (sum, group) => sum + group.candidates.filter(isImportable).length,
        0
      ),
    [groups]
  )
  const selectedCount = useMemo(
    () =>
      (list?.candidates ?? []).filter(
        (candidate) =>
          isImportable(candidate) &&
          selected.has(conversationImportKey(candidate))
      ).length,
    [list, selected]
  )

  const toggle = useCallback((candidate: ConversationImportCandidate) => {
    if (!isImportable(candidate)) return
    const key = conversationImportKey(candidate)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const runImport =
    useCallback(async (): Promise<ConversationImportOutcome | null> => {
      const candidates = (list?.candidates ?? []).filter(
        (candidate) =>
          isImportable(candidate) &&
          selected.has(conversationImportKey(candidate))
      )
      if (candidates.length === 0 || importing) return null
      const result: ConversationImportOutcome = {
        imported: 0,
        skipped: 0,
        failed: [],
      }
      const linked = new Map<string, string>()
      setImporting(true)
      setOutcome(null)
      setProgress({ done: 0, total: candidates.length })
      for (
        let start = 0;
        start < candidates.length && mounted.current;
        start += CONVERSATION_IMPORT_UI_BATCH
      ) {
        const batch = candidates.slice(
          start,
          start + CONVERSATION_IMPORT_UI_BATCH
        )
        try {
          const response = await importConversations(batch)
          const threads: ChatThread[] = []
          for (const item of response.results) {
            const key = conversationImportKey(item)
            if (item.threadId) linked.set(key, item.threadId)
            if (item.status === "imported") {
              result.imported += 1
              if (item.thread) threads.push(item.thread)
            } else if (item.status === "skipped") {
              result.skipped += 1
            } else {
              result.failed.push({
                key,
                title:
                  batch.find(
                    (candidate) => conversationImportKey(candidate) === key
                  )?.title ?? "",
                error: item.error ?? "This conversation couldn't be imported.",
              })
            }
          }
          addImportedThreads(threads)
        } catch (error) {
          const message = errorText(
            error,
            "These conversations couldn't be imported."
          )
          for (const candidate of batch) {
            result.failed.push({
              key: conversationImportKey(candidate),
              title: candidate.title,
              error: message,
            })
          }
        }
        if (mounted.current) {
          setProgress({
            done: Math.min(start + batch.length, candidates.length),
            total: candidates.length,
          })
        }
      }
      if (!mounted.current) return result
      // Imported sessions now show as in BetterC0de and leave the selection.
      setList((current) =>
        current
          ? {
              ...current,
              candidates: current.candidates.map((candidate) => {
                const threadId = linked.get(conversationImportKey(candidate))
                return threadId ? { ...candidate, threadId } : candidate
              }),
            }
          : current
      )
      setSelected((current) => {
        const next = new Set(current)
        for (const key of linked.keys()) next.delete(key)
        return next
      })
      setImporting(false)
      setProgress(null)
      setOutcome(result)
      return result
    }, [importing, list, selected])

  return {
    list,
    loading,
    loadError,
    filter,
    setFilter,
    groups,
    importableCount,
    selected,
    selectedCount,
    setSelected,
    toggle,
    importing,
    progress,
    outcome,
    reload,
    runImport,
  }
}
