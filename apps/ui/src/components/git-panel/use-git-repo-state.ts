import { useCallback, useEffect, useRef, useState } from "react"
import type { GitStatus } from "@betterc0de/schema"
import {
  gitDiff,
  gitListBranches,
  gitLog,
  gitStatus,
  isGitRepo,
} from "@/services/backend/gitApi"
import { useChatStore } from "@/lib/chat-store"
import { resolveLiveThreadBranchUpdate } from "@/lib/git-thread-branch"
import { createLogger } from "@/lib/logger"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import {
  parseDiffStats,
  threadMatchesPanelCwd,
  type FileDiffStats,
  type GitLogEntry,
} from "./git-panel-utils"

const log = createLogger("git-panel")

/**
 * The git panel's data layer: whether `cwd` is a repository, its status and
 * diff stats (polled every 5s while the window is visible and refreshed on
 * `betterc0de:file-changed`), and the branch list and commit log, which load
 * on demand through `refreshBranches` / `refreshLog`.
 *
 * Also keeps the active thread's recorded branch in step with the checked-out
 * branch when the thread works in this folder.
 */
export function useGitRepoState(cwd: string) {
  const [isRepo, setIsRepo] = useState<boolean | null>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [diffStats, setDiffStats] = useState<Record<string, FileDiffStats>>({})

  // Branch management
  const [branches, setBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState("")

  // Git log
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])

  const inFlightRef = useRef<{ cwd: string } | null>(null)
  const lastStatusKeyRef = useRef("")
  const lastDiffTextRef = useRef("")

  const syncActiveThreadBranch = useCallback(
    (branch: string | null | undefined) => {
      const store = useChatStore.getState()
      const activeThread = store.activeThreadId
        ? store.threads.find((thread) => thread.id === store.activeThreadId)
        : null
      if (!activeThread || !threadMatchesPanelCwd(activeThread, cwd)) return
      const update = resolveLiveThreadBranchUpdate({
        threadBranch: activeThread.branch,
        gitBranch: branch,
      })
      if (!update) return
      store.updateThreadContext(activeThread.id, { branch: update.branch })
    },
    [cwd]
  )

  const refresh = useCallback(
    async (silent = false) => {
      if (inFlightRef.current?.cwd === cwd) return
      const request = { cwd }
      inFlightRef.current = request
      try {
        let repo: boolean
        try {
          repo = await isGitRepo(cwd)
        } catch {
          if (inFlightRef.current !== request) return
          if (silent) return
          setIsRepo(false)
          return
        }
        if (inFlightRef.current !== request) return
        setIsRepo(repo)
        if (!repo) {
          setStatus(null)
          setDiffStats({})
          lastStatusKeyRef.current = ""
          lastDiffTextRef.current = ""
          return
        }
        const [statusResult, diffResult] = await Promise.all([
          gitStatus(cwd).catch(() => null),
          gitDiff(cwd).catch(() => null),
        ])
        if (inFlightRef.current !== request) return
        if (statusResult) {
          const key = JSON.stringify(statusResult)
          if (key !== lastStatusKeyRef.current) {
            lastStatusKeyRef.current = key
            setStatus(statusResult)
          }
        }
        if (diffResult !== null) {
          const text = (diffResult as { diff_text?: string }).diff_text || ""
          if (text !== lastDiffTextRef.current) {
            lastDiffTextRef.current = text
            setDiffStats(parseDiffStats(text))
          }
        }
      } finally {
        if (inFlightRef.current === request) inFlightRef.current = null
      }
    },
    [cwd]
  )

  const refreshBranches = useCallback(async () => {
    try {
      const result = await gitListBranches(cwd)
      setBranches(result.branches || [])
      setCurrentBranch(result.current || "")
    } catch (err) {
      log.warn("Failed to list git branches", err)
    }
  }, [cwd])

  const refreshLog = useCallback(async () => {
    try {
      const result = await gitLog(cwd, 30)
      setLogEntries((result.commits || []) as GitLogEntry[])
    } catch (err) {
      log.warn("Failed to load git log", err)
    }
  }, [cwd])

  /**
   * Publish the status a remote fetch returned. Any local status poll that
   * began before the fetch completed is ignored.
   */
  const applyFetchedStatus = useCallback((next: GitStatus) => {
    inFlightRef.current = null
    lastStatusKeyRef.current = JSON.stringify(next)
    setStatus(next)
  }, [])

  useEffect(() => {
    lastStatusKeyRef.current = ""
    lastDiffTextRef.current = ""
    refresh()
  }, [refresh])

  useEffect(() => {
    syncActiveThreadBranch(status?.branch)
  }, [status?.branch, syncActiveThreadBranch])

  // Poll every 5s — but only while the window is actually visible. When the
  // user switches tabs / minimizes / locks the screen, the interval is torn
  // down so we stop spawning git child processes in the background.
  useVisibilityInterval(
    () => {
      refresh(true)
    },
    5000,
    { enabled: !!cwd, runOnVisible: true }
  )

  useEffect(() => {
    if (!cwd) return
    let pending: ReturnType<typeof setTimeout> | null = null
    const onFileChanged = () => {
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        refresh(true)
        pending = null
      }, 300)
    }
    window.addEventListener(
      "betterc0de:file-changed",
      onFileChanged as EventListener
    )
    return () => {
      window.removeEventListener(
        "betterc0de:file-changed",
        onFileChanged as EventListener
      )
      if (pending) clearTimeout(pending)
    }
  }, [cwd, refresh])

  return {
    isRepo,
    status,
    diffStats,
    branches,
    currentBranch,
    setCurrentBranch,
    logEntries,
    refresh,
    refreshBranches,
    refreshLog,
    syncActiveThreadBranch,
    applyFetchedStatus,
  }
}
