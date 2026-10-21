import { useState, useEffect, useCallback, useRef } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  gitStatus,
  gitCommit,
  gitPush,
  gitPull,
  gitFetch,
  gitDiscard,
  isGitRepo,
  gitInit,
  gitDiff,
  gitStage,
  gitUnstage,
  gitStageAll,
  gitUnstageAll,
  gitLog,
  gitListBranches,
  gitCheckoutBranch,
  gitStash,
  gitStashPop,
} from "@/services/backend"
import { useEditorStore } from "@/lib/editor-store"
import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { useChatStore } from "@/lib/chat-store"
import { resolveLiveThreadBranchUpdate } from "@/lib/git-thread-branch"
import { generateWorkspaceCommitMessage } from "@/lib/git-commit-message"
import { getFileIconUrl } from "@/lib/file-icons"
import { createLogger } from "@/lib/logger"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import type { GitStatus } from "@betterc0de/schema"
import "./diff-panel.css"
import "./git-panel.css"

const log = createLogger("git-panel")
import {
  RefreshCwIcon,
  ChevronDownIcon,
  CheckIcon,
  CloudUploadIcon,
  CloudDownloadIcon,
  GitBranchIcon,
  PlusIcon,
  Loader2Icon,
  Undo2Icon,
  MinusIcon,
  GitCommitVerticalIcon,
  ArchiveIcon,
  XIcon,
  SparklesIcon,
  MoreHorizontalIcon,
  SearchIcon,
} from "lucide-react"

interface FileDiffStats {
  additions: number
  deletions: number
}

/** VS-Code-style git status colors — letter + chevron tint per section.
 *  Filenames stay `text-foreground`; only the compact status letter carries
 *  the color so the list scans without shouting. */
const GIT_STATUS_META: Record<string, { label: string; className: string }> = {
  A: { label: "Staged", className: "text-success" },
  M: { label: "Modified", className: "text-warning" },
  U: { label: "Untracked", className: "text-primary" },
}

interface GitLogEntry {
  hash: string
  message: string
  author: string
  date: string
}

function parseDiffStats(diffText: string): Record<string, FileDiffStats> {
  const result: Record<string, FileDiffStats> = {}
  if (!diffText) return result
  const chunks = diffText.split(/^diff --git /m).filter(Boolean)
  for (const chunk of chunks) {
    const pathMatch = chunk.match(/a\/(.+?)\s+b\//)
    if (!pathMatch) continue
    const filePath = pathMatch[1]
    let additions = 0
    let deletions = 0
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++
    }
    result[filePath] = { additions, deletions }
  }
  return result
}

function normalizeFsPathForCompare(value: string | null | undefined): string {
  return (value ?? "").replace(/[\\/]+$/, "")
}

function threadMatchesPanelCwd(
  thread: { projectPath?: string | null; worktreePath?: string | null },
  cwd: string
): boolean {
  const normalizedCwd = normalizeFsPathForCompare(cwd)
  if (!normalizedCwd) return false
  return (
    normalizeFsPathForCompare(thread.projectPath) === normalizedCwd ||
    normalizeFsPathForCompare(thread.worktreePath) === normalizedCwd
  )
}

export function GitPanel({
  cwd,
  appMode,
  diffTabs = appMode === "editor",
}: {
  cwd: string
  appMode: "agent" | "editor" | "design"
  diffTabs?: boolean
}) {
  const isAgent = appMode === "agent"
  const [isRepo, setIsRepo] = useState<boolean | null>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [diffStats, setDiffStats] = useState<Record<string, FileDiffStats>>({})
  const [commitMsg, setCommitMsg] = useState("")
  const [fileFilter, setFileFilter] = useState("")
  const [commitError, setCommitError] = useState<string | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [isCommitting, setIsCommitting] = useState(false)
  const [isGeneratingCommit, setIsGeneratingCommit] = useState(false)
  const [isPushing, setIsPushing] = useState(false)
  const [isPulling, setIsPulling] = useState(false)
  const [isFetching, setIsFetching] = useState(false)
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null)
  const remoteFetchRef = useRef({ id: 0 })
  const [stagedOpen, setStagedOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(true)
  const [untrackedOpen, setUntrackedOpen] = useState(true)
  const [confirmAction, setConfirmAction] = useState<{
    title: string
    description: string
    action: () => void
  } | null>(null)

  // Branch management
  const [branches, setBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState("")
  const [, _setShowBranches] = useState(false)
  const [newBranchName, setNewBranchName] = useState("")

  // Git log
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  const [, _setShowLog] = useState(false)

  // Tabs: changes | log | branches
  const [activeTab, setActiveTab] = useState<"changes" | "log" | "branches">(
    "changes"
  )

  const inFlightRef = useRef<{ cwd: string } | null>(null)
  const lastStatusKeyRef = useRef("")
  const lastDiffTextRef = useRef("")
  const commitGenerationRef = useRef({ id: 0 })

  useEffect(() => {
    setIsFetching(false)
    setLastFetchedAt(null)
    setRemoteError(null)
    setCommitMsg("")
    setCommitError(null)
    setIsGeneratingCommit(false)
    const generation = commitGenerationRef.current
    const remoteGeneration = remoteFetchRef.current
    return () => {
      generation.id++
      remoteGeneration.id++
    }
  }, [cwd])

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

  // Load branches and log when their tabs become active
  useEffect(() => {
    if (activeTab === "branches" && isRepo) refreshBranches()
    if (activeTab === "log" && isRepo) refreshLog()
  }, [activeTab, isRepo, refreshBranches, refreshLog])

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim() || isCommitting || isGeneratingCommit) return
    setIsCommitting(true)
    setCommitError(null)
    try {
      // VS Code-style smart commit: if the user has unstaged changes
      // (modified files or untracked files) but nothing in the index,
      // stage everything before the commit. Without this, clicking
      // Commit on a freshly modified file is a no-op — `git commit`
      // only commits what's in the index, and the prior implementation
      // silently looked successful because the backend swallows
      // "nothing to commit" as a non-error.
      const hasStaged = (status?.staged.length ?? 0) > 0
      const hasUnstaged =
        (status?.modified.length ?? 0) > 0 ||
        (status?.untracked.length ?? 0) > 0
      if (!hasStaged && hasUnstaged) {
        await gitStageAll(cwd)
      }
      await gitCommit(cwd, commitMsg.trim())
      setCommitMsg("")
      refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn("Git commit failed", err)
      setCommitError(message)
    }
    setIsCommitting(false)
  }, [cwd, commitMsg, isCommitting, isGeneratingCommit, status, refresh])

  const handleGenerateCommitMessage = useCallback(async () => {
    if (!status || isGeneratingCommit || isCommitting) return
    const request = ++commitGenerationRef.current.id
    setIsGeneratingCommit(true)
    setCommitError(null)
    try {
      const message = await generateWorkspaceCommitMessage(cwd)
      if (commitGenerationRef.current.id === request) setCommitMsg(message)
    } catch (error) {
      if (commitGenerationRef.current.id !== request) return
      setCommitError(
        error instanceof Error
          ? error.message
          : "Commit message generation failed."
      )
    } finally {
      if (commitGenerationRef.current.id === request)
        setIsGeneratingCommit(false)
    }
  }, [cwd, isGeneratingCommit, isCommitting, status])

  const handleFetch = useCallback(async () => {
    if (isFetching || isPushing || isPulling || isCommitting) return
    const request = ++remoteFetchRef.current.id
    setIsFetching(true)
    setRemoteError(null)
    try {
      const result = await gitFetch(cwd)
      if (request !== remoteFetchRef.current.id) return
      // Ignore any local status poll that began before the fetch completed.
      inFlightRef.current = null
      lastStatusKeyRef.current = JSON.stringify(result.status)
      setStatus(result.status)
      setLastFetchedAt(new Date())
    } catch (err) {
      if (request !== remoteFetchRef.current.id) return
      setLastFetchedAt(null)
      setRemoteError(err instanceof Error ? err.message : String(err))
    } finally {
      if (request === remoteFetchRef.current.id) setIsFetching(false)
    }
  }, [cwd, isFetching, isPushing, isPulling, isCommitting])

  const handlePush = useCallback(() => {
    const branch = status?.branch || "main"
    const upstream = status?.upstream ?? null
    const ahead = status?.ahead ?? 0
    const isPublish = !upstream
    setConfirmAction({
      title: isPublish ? "Publish branch?" : "Push to remote?",
      description: isPublish
        ? `Branch "${branch}" has no upstream — publish to origin/${branch} now? Future pushes will go there automatically.`
        : `Push ${ahead} ${ahead === 1 ? "commit" : "commits"} on "${branch}" to ${upstream}.`,
      action: async () => {
        setIsPushing(true)
        setRemoteError(null)
        try {
          if (isPublish) {
            await gitPush(cwd, { setUpstream: true, branch })
          } else {
            await gitPush(cwd)
          }
          refresh()
        } catch (err) {
          // Backend's git service classifies common push failures
          // (no upstream, no remote, auth, non-fast-forward, …) into
          // user-friendly messages with a 4xx status; sanitizeError
          // passes those through verbatim. Anything we couldn't
          // classify still arrives as the generic 500 envelope.
          const message = err instanceof Error ? err.message : String(err)
          log.warn("Git push failed", err)
          setRemoteError(message)
        }
        setIsPushing(false)
      },
    })
  }, [cwd, status, refresh])

  const handlePull = useCallback(() => {
    setConfirmAction({
      title: "Pull from remote?",
      description: `Pull latest changes from the remote into "${status?.branch || "main"}".`,
      action: async () => {
        setIsPulling(true)
        setRemoteError(null)
        try {
          await gitPull(cwd)
          refresh()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn("Git pull failed", err)
          setRemoteError(message)
        }
        setIsPulling(false)
      },
    })
  }, [cwd, status, refresh])

  const handleDiscard = useCallback(
    (file: string) => {
      setConfirmAction({
        title: "Discard changes?",
        description: `All changes to "${file}" will be permanently lost. This cannot be undone.`,
        action: async () => {
          try {
            await gitDiscard(cwd, file)
            refresh()
          } catch {
            refresh()
          }
        },
      })
    },
    [cwd, refresh]
  )

  const handleStageFile = useCallback(
    async (file: string) => {
      try {
        await gitStage(cwd, [file])
        refresh()
      } catch (err) {
        log.warn("Failed to stage file:", file, err)
      }
    },
    [cwd, refresh]
  )

  const handleUnstageFile = useCallback(
    async (file: string) => {
      try {
        await gitUnstage(cwd, [file])
        refresh()
      } catch (err) {
        log.warn("Failed to unstage file:", file, err)
      }
    },
    [cwd, refresh]
  )

  const handleStageAll = useCallback(async () => {
    try {
      await gitStageAll(cwd)
      refresh()
    } catch (err) {
      log.warn("Failed to stage all files", err)
    }
  }, [cwd, refresh])

  const handleUnstageAll = useCallback(async () => {
    try {
      await gitUnstageAll(cwd)
      refresh()
    } catch (err) {
      log.warn("Failed to unstage all files", err)
    }
  }, [cwd, refresh])

  const handleCheckout = useCallback(
    (branch: string) => {
      setConfirmAction({
        title: "Switch branch?",
        description: `Switch the workspace to "${branch}"? Git will stop if local changes cannot be carried safely.`,
        action: async () => {
          try {
            await gitCheckoutBranch(cwd, branch)
            setCurrentBranch(branch)
            syncActiveThreadBranch(branch)
            refresh()
            refreshBranches()
          } catch (err) {
            log.warn("Failed to checkout branch:", branch, err)
          }
        },
      })
    },
    [cwd, refresh, refreshBranches, syncActiveThreadBranch]
  )

  const handleCreateBranch = useCallback(async () => {
    const branch = newBranchName.trim()
    if (!branch) return
    try {
      await gitCheckoutBranch(cwd, branch, true)
      setNewBranchName("")
      setCurrentBranch(branch)
      syncActiveThreadBranch(branch)
      refresh()
      refreshBranches()
    } catch (err) {
      log.warn("Failed to create branch:", newBranchName, err)
    }
  }, [cwd, newBranchName, refresh, refreshBranches, syncActiveThreadBranch])

  const handleStash = useCallback(() => {
    setConfirmAction({
      title: "Stash changes?",
      description:
        "Move tracked workspace changes into a Git stash and restore the working tree.",
      action: async () => {
        try {
          await gitStash(cwd)
          refresh()
        } catch (err) {
          log.warn("Git stash failed", err)
        }
      },
    })
  }, [cwd, refresh])

  const handleStashPop = useCallback(() => {
    setConfirmAction({
      title: "Apply latest stash?",
      description:
        "Apply and remove the latest stash. Overlapping workspace edits may produce merge conflicts.",
      action: async () => {
        try {
          await gitStashPop(cwd)
          refresh()
        } catch (err) {
          log.warn("Git stash pop failed", err)
        }
      },
    })
  }, [cwd, refresh])

  const openFile = useCallback(
    (filePath: string, source: "staged" | "unstaged" | null = "unstaged") => {
      if (appMode === "editor") {
        if (diffTabs && source)
          useEditorStore.getState().openDiff({ cwd, path: filePath, source })
        else
          void useEditorStore
            .getState()
            .openFile(resolveWorkspaceFilePath(cwd, filePath))
      }
    },
    [cwd, appMode, diffTabs]
  )

  // Not a git repo — render a prominent empty-state with a clear
  // call-to-action. Without this the user sees the same minimal sidebar
  // they'd see while loading and assumes the panel is stuck.
  if (isRepo === false) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-3 px-4 py-6 text-center",
          isAgent && "diff-panel diff-empty"
        )}
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-muted/40">
          <GitBranchIcon
            className="size-6 text-muted-foreground/70"
            strokeWidth={1.5}
          />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-[13px] font-medium text-foreground">
            Not a git repository
          </p>
          <p className="max-w-[220px] text-[11px] leading-snug text-muted-foreground">
            Initialize git here to track changes, commit, and push to a remote.
          </p>
        </div>
        <Button
          size="sm"
          className="mt-1 gap-1.5 text-xs"
          onClick={async () => {
            try {
              await gitInit(cwd)
              refresh()
            } catch (err) {
              log.warn("Git init failed", err)
            }
          }}
        >
          <GitBranchIcon className="size-3.5" /> Initialize Repository
        </Button>
        <p className="mt-1 max-w-[220px] text-[10px] text-muted-foreground/70">
          Equivalent of{" "}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono">
            git init
          </code>{" "}
          in this folder.
        </p>
      </div>
    )
  }

  if (isRepo === null || !status) {
    return (
      <div
        className={cn(
          "flex items-center justify-center py-4",
          isAgent && "diff-panel diff-empty"
        )}
        role="status"
        aria-label="Loading Git status"
      >
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const totalChanges =
    status.staged.length + status.modified.length + status.untracked.length
  const totalAdditions = Object.values(diffStats).reduce(
    (s, d) => s + d.additions,
    0
  )
  const totalDeletions = Object.values(diffStats).reduce(
    (s, d) => s + d.deletions,
    0
  )

  const visibleFiles = (files: string[]) =>
    (appMode === "editor" || isAgent) && fileFilter.trim()
      ? files.filter((file) =>
          file.toLowerCase().includes(fileFilter.trim().toLowerCase())
        )
      : files
  const visibleCount = visibleFiles([
    ...status.staged,
    ...status.modified,
    ...status.untracked,
  ]).length
  const repositorySummary = (
    <div
      className={cn(
        "git-repository-summary flex items-center gap-2 px-3 py-1.5 text-[10.5px] text-muted-foreground",
        !isAgent && "border-t border-border/60"
      )}
    >
      <GitBranchIcon className="size-3 shrink-0" strokeWidth={1.75} />
      <span className="truncate font-medium text-foreground">
        {status.branch || "main"}
      </span>
      {status.is_clean ? (
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-success" aria-hidden />
          clean
        </span>
      ) : (
        <span className="flex items-center gap-2 tabular-nums">
          <span>
            {totalChanges} change{totalChanges !== 1 ? "s" : ""}
          </span>
          {totalAdditions > 0 && (
            <span className="text-success">+{totalAdditions}</span>
          )}
          {totalDeletions > 0 && (
            <span className="text-destructive">−{totalDeletions}</span>
          )}
        </span>
      )}
      {!isAgent && (
        <button
          type="button"
          onClick={() => refresh()}
          className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-accent-foreground"
          title="Refresh"
          aria-label="Refresh git status"
        >
          <RefreshCwIcon className="size-3" />
        </button>
      )}
    </div>
  )
  const tabs = (
    <div className={isAgent ? "diff-toolbar" : undefined}>
      <div
        className={
          isAgent
            ? "diff-tabs"
            : "mx-3 mb-2 flex rounded-lg bg-muted/30 p-0.5 text-[11px]"
        }
        role="group"
        aria-label="Git view"
      >
        {(["changes", "log", "branches"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            aria-pressed={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={
              isAgent
                ? "capitalize"
                : cn(
                    "flex-1 rounded-md px-2 py-1 font-medium capitalize transition-colors",
                    activeTab === tab
                      ? "bg-muted text-foreground shadow-sm ring-1 ring-border/50 ring-inset"
                      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  )
            }
          >
            {tab}
            {isAgent && tab === "changes" && <span>{totalChanges}</span>}
          </button>
        ))}
      </div>
      {isAgent && (
        <button
          type="button"
          className="diff-toolbar-button ml-auto"
          aria-label="Refresh git status"
          title="Refresh git status"
          onClick={() => refresh()}
        >
          <RefreshCwIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
  return (
    <div
      className={cn(
        "flex flex-col text-[12px]",
        appMode === "editor" && "editor-git-panel",
        isAgent && "diff-panel git-panel-agent"
      )}
    >
      {isAgent && (
        <>
          {tabs}
          {repositorySummary}
        </>
      )}
      {appMode === "editor" && (
        <div className="px-3 pb-2">
          <div className="flex h-8 items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("branches")}
              title="Manage branches"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-xs font-medium hover:text-foreground"
            >
              <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{status.branch || "No branch"}</span>
              <ChevronDownIcon className="size-3 text-muted-foreground" />
            </button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh git status"
              onClick={() => refresh()}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
            <span>
              {status.is_clean
                ? "Working tree clean"
                : `${totalChanges} changed files`}
            </span>
            {totalAdditions > 0 && (
              <span className="text-success">
                +{totalAdditions.toLocaleString()}
              </span>
            )}
            {totalDeletions > 0 && (
              <span className="text-destructive">
                −{totalDeletions.toLocaleString()}
              </span>
            )}
          </div>
        </div>
      )}
      {/* Commit input — uses the shadcn Input pattern (bg-input/50 +
          focus ring) so it reads as a native form field instead of a
          handcrafted box on the sidebar bg. */}
      <div
        className={cn(
          "git-commit-form px-3 pt-2.5 pb-2.5",
          (appMode === "editor" || isAgent) &&
            activeTab !== "changes" &&
            "hidden"
        )}
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-1 text-[10px] text-muted-foreground">
          <span className="text-[11px] font-medium text-foreground">
            Commit
          </span>
          <span className="tabular-nums">
            {status.staged.length > 0
              ? `${status.staged.length} staged`
              : `${totalChanges} changed`}
          </span>
        </div>
        {/* Composer card: textarea + action bar share one surface so the
            whole thing reads as a single form field (chat-composer pattern)
            instead of a box with a loose row of buttons underneath. No
            border — the muted fill alone separates it from the panel. */}
        <div
          className={cn(
            "git-commit-card flex flex-col overflow-hidden rounded-lg bg-muted/40 transition-[box-shadow,background-color] focus-within:bg-muted/60 focus-within:ring-2 focus-within:ring-ring/25",
            commitError && "ring-2 ring-destructive/40"
          )}
        >
          <textarea
            aria-label="Commit message"
            readOnly={isGeneratingCommit || isCommitting}
            aria-busy={isGeneratingCommit}
            value={commitMsg}
            onChange={(e) => {
              setCommitMsg(e.target.value)
              if (commitError) setCommitError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleCommit()
            }}
            placeholder={"Summary of the changes\n\n- What changed and why"}
            rows={Math.min(12, Math.max(4, commitMsg.split("\n").length + 1))}
            className="max-h-80 min-h-24 w-full resize-y bg-transparent px-3 py-2.5 text-xs leading-relaxed outline-none placeholder:text-muted-foreground/60"
          />
          <div
            className={cn(
              "git-commit-actions flex items-center gap-1 px-1.5 pb-1.5",
              (appMode === "editor" || isAgent) && "flex-wrap"
            )}
          >
            <Button
              variant="outline"
              size="xs"
              className="gap-1.5"
              disabled={
                isGeneratingCommit || isCommitting || totalChanges === 0
              }
              onClick={handleGenerateCommitMessage}
              title="Generate a commit message from the reviewed changes"
            >
              {isGeneratingCommit ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <SparklesIcon className="size-3.5" />
              )}
              {isGeneratingCommit ? "Generating…" : "Generate"}
            </Button>
            <Button
              variant="outline"
              size="icon-xs"
              className="ml-auto"
              onClick={handleStash}
              title="Stash uncommitted changes"
              aria-label="Stash uncommitted changes"
            >
              <ArchiveIcon className="size-3.5" />
            </Button>
            <Button
              size="xs"
              className="gap-1.5 px-3"
              disabled={
                !commitMsg.trim() ||
                isCommitting ||
                isGeneratingCommit ||
                totalChanges === 0
              }
              onClick={handleCommit}
              title="Commit (Ctrl+Enter)"
            >
              {isCommitting ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <CheckIcon className="size-3.5" />
              )}
              Commit
            </Button>
          </div>
        </div>
        {isGeneratingCommit && (
          <p role="status" className="mt-1.5 text-[11px] text-muted-foreground">
            Reading changes and writing a commit summary…
          </p>
        )}
        {commitError && (
          <p
            role="alert"
            className="mt-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
          >
            {commitError}
          </p>
        )}
        {(() => {
          // ── Push / Pull state ─────────────────────────────────────────
          // `ahead`/`behind` come from `git rev-list --left-right --count
          // HEAD...@{upstream}` on the backend, so they reflect what's in
          // the LOCAL ref database — no implicit network call. The
          // `upstream` field tells us whether a tracking branch is
          // configured at all: if null the branch was never published, so
          // the Push button switches to "Publish branch" mode (which on
          // the backend still runs `git push` — git creates the upstream
          // when one isn't set, provided `push.autoSetupRemote=true` or
          // the user has it configured).
          const ahead = status.ahead ?? 0
          const behind = status.behind ?? 0
          const upstream = status.upstream ?? null
          const branchLabel = upstream ?? `origin/${status.branch || "main"}`
          const pluralCommits = (n: number) =>
            `${n} ${n === 1 ? "commit" : "commits"}`
          const pushTitle = !upstream
            ? `Publish "${status.branch || "main"}" to remote`
            : ahead > 0
              ? `Push ${pluralCommits(ahead)} to ${branchLabel}`
              : `Up to date with ${branchLabel}`
          const pullTitle = !upstream
            ? `No upstream — set one before pulling`
            : behind > 0
              ? `Pull ${pluralCommits(behind)} from ${branchLabel}`
              : `Check ${branchLabel} for new commits and pull updates`
          const remoteBusy =
            isPushing || isPulling || isCommitting || isFetching
          const pushDisabled = remoteBusy || (Boolean(upstream) && ahead === 0)
          const pullDisabled = remoteBusy || !upstream
          return (
            <div
              className="git-remote-sync"
              role="group"
              aria-label="Remote synchronization"
            >
              <div className="git-remote-heading">
                <span>Remote</span>
                <span
                  className="git-remote-upstream"
                  title={upstream ?? "Publish this branch to set an upstream"}
                >
                  {upstream ?? "Branch not published"}
                </span>
              </div>
              {/* One toolbar row: Fetch is the quiet check, Push/Pull are
                    the real actions. Whichever has pending work gets the
                    filled treatment so the eye lands on it. */}
              <div className="git-remote-actions">
                <Button
                  variant="outline"
                  size="xs"
                  className="git-remote-fetch gap-1.5"
                  onClick={handleFetch}
                  disabled={remoteBusy}
                  aria-label="Fetch remote updates"
                  aria-busy={isFetching}
                  title="Fetch remote updates to check for incoming commits without changing your files"
                >
                  <RefreshCwIcon
                    className={cn("size-3.5", isFetching && "animate-spin")}
                    aria-hidden="true"
                  />
                  <span>{isFetching ? "Fetching…" : "Fetch"}</span>
                </Button>
                <Button
                  variant={!upstream || ahead > 0 ? "default" : "outline"}
                  size="xs"
                  className="git-remote-button ml-auto gap-1.5"
                  data-pending={!upstream || ahead > 0 ? "true" : undefined}
                  onClick={handlePush}
                  disabled={pushDisabled}
                  title={pushTitle}
                  aria-busy={isPushing}
                >
                  {isPushing ? (
                    <Loader2Icon
                      className="size-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <CloudUploadIcon
                      className="size-3.5"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  )}
                  <span>
                    {isPushing
                      ? !upstream
                        ? "Publishing…"
                        : "Pushing…"
                      : !upstream
                        ? "Publish"
                        : "Push"}
                  </span>
                  {upstream && ahead > 0 && (
                    <span
                      className="git-remote-count"
                      aria-label={`${pluralCommits(ahead)} to push`}
                    >
                      {ahead}
                    </span>
                  )}
                </Button>
                <Button
                  variant={behind > 0 ? "default" : "outline"}
                  size="xs"
                  className="git-remote-button gap-1.5"
                  data-pending={behind > 0 ? "true" : undefined}
                  onClick={handlePull}
                  disabled={pullDisabled}
                  title={pullTitle}
                  aria-busy={isPulling}
                >
                  {isPulling ? (
                    <Loader2Icon
                      className="size-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <CloudDownloadIcon
                      className="size-3.5"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  )}
                  <span>{isPulling ? "Pulling…" : "Pull"}</span>
                  {behind > 0 && (
                    <span
                      className="git-remote-count"
                      aria-label={`${pluralCommits(behind)} to pull`}
                    >
                      {behind}
                    </span>
                  )}
                </Button>
              </div>
              <p
                className="git-remote-status"
                role="status"
                title={
                  lastFetchedAt
                    ? `Last fetched at ${lastFetchedAt.toLocaleTimeString()}`
                    : undefined
                }
              >
                {isFetching
                  ? "Checking for remote updates…"
                  : lastFetchedAt
                    ? !upstream
                      ? "Remote checked · publish to track this branch"
                      : behind > 0
                        ? `${pluralCommits(behind)} available to pull`
                        : "No incoming commits · remote checked"
                    : "Fetch to check for incoming commits"}
              </p>
            </div>
          )
        })()}
        {remoteError && (
          <div
            role="alert"
            className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
          >
            <span className="flex-1 leading-snug">{remoteError}</span>
            <button
              type="button"
              onClick={() => setRemoteError(null)}
              className="shrink-0 rounded p-0.5 transition-colors hover:bg-destructive/20"
              title="Dismiss"
              aria-label="Dismiss error"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        )}
      </div>

      {/* Branch info + diff summary — monochrome, theme tokens only.
          The +/- adopts the muted-foreground tint with a single accent
          weight bump, no rings, no colored backgrounds. */}
      {appMode !== "editor" && !isAgent && repositorySummary}

      {!isAgent && tabs}

      {isAgent && activeTab === "changes" && totalChanges > 0 && (
        <div className="diff-file-list-header">
          <div className="diff-filter">
            <SearchIcon className="size-3.5" aria-hidden="true" />
            <input
              aria-label="Filter changed files"
              placeholder="Find a file..."
              value={fileFilter}
              onChange={(event) => setFileFilter(event.target.value)}
            />
          </div>
        </div>
      )}

      {appMode === "editor" && activeTab === "changes" && totalChanges > 0 && (
        <div className="px-3 pb-3">
          <input
            aria-label="Filter changed files"
            placeholder="Filter changed files"
            value={fileFilter}
            onChange={(event) => setFileFilter(event.target.value)}
            className="h-9 w-full rounded-lg border border-border/50 bg-background/50 px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          {fileFilter && (
            <p role="status" className="mt-2 text-[11px] text-muted-foreground">
              {visibleCount} of {totalChanges} files
            </p>
          )}
        </div>
      )}
      {/* Tab content */}
      <div className="git-tab-content overflow-y-auto border-t border-border/40">
        {activeTab === "changes" && (
          <>
            {/* Stage All / Unstage All — bordered so they read as actions;
                as bare text they looked like stray labels. */}
            {totalChanges > 0 && (
              <div className="git-bulk-actions flex items-center gap-0.5 px-2 py-1">
                <button
                  type="button"
                  onClick={handleStageAll}
                  className="git-bulk-button rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  Stage All
                </button>
                {status.staged.length > 0 && (
                  <button
                    type="button"
                    onClick={handleUnstageAll}
                    className="git-bulk-button rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    Unstage All
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleStashPop}
                  className="git-bulk-button ml-auto rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                  Pop Stash
                </button>
              </div>
            )}

            {visibleFiles(status.staged).length > 0 && (
              <FileSection
                title="Staged Changes"
                count={visibleFiles(status.staged).length}
                open={stagedOpen}
                onOpenChange={setStagedOpen}
                files={visibleFiles(status.staged)}
                editorMode={appMode === "editor"}
                statusChar="A"
                diffStats={diffStats}
                onFileClick={(file) => openFile(file, "staged")}
                onUnstage={handleUnstageFile}
              />
            )}

            {visibleFiles(status.modified).length > 0 && (
              <FileSection
                title="Changes"
                count={visibleFiles(status.modified).length}
                open={changesOpen}
                onOpenChange={setChangesOpen}
                files={visibleFiles(status.modified)}
                editorMode={appMode === "editor"}
                statusChar="M"
                diffStats={diffStats}
                onFileClick={openFile}
                onDiscard={handleDiscard}
                onStage={handleStageFile}
              />
            )}

            {visibleFiles(status.untracked).length > 0 && (
              <FileSection
                title="Untracked"
                count={visibleFiles(status.untracked).length}
                open={untrackedOpen}
                onOpenChange={setUntrackedOpen}
                files={visibleFiles(status.untracked)}
                editorMode={appMode === "editor"}
                statusChar="U"
                diffStats={diffStats}
                onFileClick={(file) => openFile(file, null)}
                onStage={handleStageFile}
              />
            )}

            {(appMode === "editor" || isAgent) &&
              fileFilter &&
              visibleCount === 0 && (
                <p className="diff-no-matches" role="status">
                  No changed files match this filter.
                </p>
              )}
            {totalChanges === 0 && (
              <p className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">
                No changes — working tree is clean.
              </p>
            )}
          </>
        )}

        {activeTab === "log" && (
          <div className="space-y-0">
            {logEntries.length === 0 && (
              <p className="px-3 py-3 text-center text-[10px] text-muted-foreground/50">
                No commits
              </p>
            )}
            {logEntries.map((entry) => (
              <div
                key={entry.hash}
                className="git-log-entry flex items-start gap-2 border-b border-border/20 px-3 py-1.5 transition-colors hover:bg-accent/50"
              >
                <GitCommitVerticalIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground/40" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] leading-snug">
                    {entry.message}
                  </p>
                  <div className="mt-0.5 flex items-center gap-2 text-[9.5px] text-muted-foreground/60">
                    <span className="rounded bg-muted/60 px-1 py-px font-mono tabular-nums">
                      {entry.hash?.slice(0, 7)}
                    </span>
                    <span className="truncate">{entry.author}</span>
                    <span className="shrink-0">
                      {entry.date
                        ? new Date(entry.date).toLocaleDateString()
                        : ""}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === "branches" && (
          <div>
            {/* New branch input */}
            <div className="git-new-branch flex items-center gap-1 border-b border-border/20 px-2 py-1.5">
              <input
                aria-label="New branch name"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateBranch()
                }}
                placeholder="New branch name..."
                className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/40"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 rounded-md px-2 text-[10px]"
                disabled={!newBranchName.trim()}
                onClick={handleCreateBranch}
              >
                <PlusIcon className="size-3" /> Create
              </Button>
            </div>
            {/* Branch list */}
            {branches.map((branch) => (
              <button
                key={branch}
                type="button"
                onClick={() => handleCheckout(branch)}
                className={cn(
                  "git-branch-row flex w-full items-center gap-2 px-3 py-1 text-[11px] transition-colors hover:bg-accent/50",
                  branch === currentBranch && "font-medium text-foreground"
                )}
              >
                <GitBranchIcon className="size-3 shrink-0" />
                <span className="flex-1 truncate text-left">{branch}</span>
                {branch === currentBranch && (
                  <CheckIcon className="size-3 shrink-0" />
                )}
              </button>
            ))}
            {branches.length === 0 && (
              <p className="px-3 py-3 text-center text-[10px] text-muted-foreground/50">
                No branches found
              </p>
            )}
          </div>
        )}
      </div>

      {isAgent && activeTab === "changes" && (
        <div className="diff-file-count">
          {fileFilter.trim() ? `${visibleCount} of ` : ""}
          {totalChanges} file{totalChanges !== 1 && "s"} changed
        </div>
      )}

      {/* Confirm dialog */}
      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null)
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogTitle>{confirmAction?.title}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {confirmAction?.description}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmAction(null)}>
              Cancel
            </Button>
            <Button
              variant={
                confirmAction?.title?.includes("Discard")
                  ? "destructive"
                  : "default"
              }
              onClick={() => {
                confirmAction?.action()
                setConfirmAction(null)
              }}
            >
              {confirmAction?.title?.includes("Discard")
                ? "Discard"
                : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FileSection({
  title,
  count,
  open,
  onOpenChange,
  files,
  statusChar,
  diffStats,
  onFileClick,
  onDiscard,
  onStage,
  onUnstage,
  editorMode = false,
}: {
  title: string
  count: number
  open: boolean
  onOpenChange: (v: boolean) => void
  files: string[]
  statusChar: string
  diffStats: Record<string, FileDiffStats>
  onFileClick: (path: string) => void
  onDiscard?: (path: string) => void
  onStage?: (path: string) => void
  onUnstage?: (path: string) => void
  editorMode?: boolean
}) {
  const statusMeta = GIT_STATUS_META[statusChar]
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        className={cn(
          "git-section-heading flex w-full items-center gap-1.5 bg-muted/20 px-3 py-1 text-[9.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase transition-colors hover:text-foreground",
          editorMode &&
            "min-h-9 text-xs font-medium tracking-normal normal-case"
        )}
      >
        <ChevronDownIcon
          className={cn("size-2.5 transition-transform", !open && "-rotate-90")}
          strokeWidth={2.5}
        />
        <span className="flex-1 text-left">{title}</span>
        <span className="tracking-normal text-muted-foreground/60 tabular-nums">
          {count}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {files.map((file) => {
          const fileName = file.split(/[/\\]/).pop() || file
          const dirPath = file.includes("/")
            ? file.slice(0, file.lastIndexOf("/") + 1)
            : file.includes("\\")
              ? file.slice(0, file.lastIndexOf("\\") + 1)
              : ""
          const stats = diffStats[file]
          if (editorMode) {
            return (
              <div
                key={file}
                className="group flex min-w-0 items-center gap-2 px-3 py-2 transition-colors hover:bg-accent/50"
              >
                <button
                  type="button"
                  onClick={() => onFileClick(file)}
                  title={file}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                >
                  <img
                    src={getFileIconUrl(fileName)}
                    alt=""
                    className="mt-0.5 size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {fileName}
                    </span>
                    <span className="mt-0.5 flex min-w-0 gap-2 text-[10px] text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate">
                        {dirPath || "/"}
                      </span>
                      {stats && (
                        <span className="flex shrink-0 gap-1.5 tabular-nums">
                          {stats.additions > 0 && (
                            <span className="text-success">
                              +{stats.additions}
                            </span>
                          )}
                          {stats.deletions > 0 && (
                            <span className="text-destructive">
                              −{stats.deletions}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                <span
                  title={statusMeta?.label}
                  className={cn(
                    "shrink-0 text-[10px] font-medium",
                    statusMeta?.className
                  )}
                >
                  {statusChar}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${file}`}
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                    >
                      <MoreHorizontalIcon className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onFileClick(file)}>
                      Open file
                    </DropdownMenuItem>
                    {onStage && (
                      <DropdownMenuItem onSelect={() => onStage(file)}>
                        <PlusIcon />
                        Stage file
                      </DropdownMenuItem>
                    )}
                    {onUnstage && (
                      <DropdownMenuItem onSelect={() => onUnstage(file)}>
                        <MinusIcon />
                        Unstage file
                      </DropdownMenuItem>
                    )}
                    {onDiscard && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => onDiscard(file)}>
                          <Undo2Icon />
                          Discard changes…
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          }
          return (
            <div
              key={file}
              className="git-file-row group flex w-full items-center gap-2 px-3 py-1 transition-colors hover:bg-accent/50"
            >
              <button
                type="button"
                onClick={() => onFileClick(file)}
                title={file}
                className="git-file-select flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <img
                  src={getFileIconUrl(fileName)}
                  alt=""
                  className="size-3.5 shrink-0"
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).style.display = "none"
                  }}
                />
                <span className="git-file-label min-w-0 flex-1 truncate text-[11.5px] text-foreground">
                  {fileName}
                  {dirPath && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground/70">
                      {dirPath}
                    </span>
                  )}
                </span>
              </button>
              {stats && (stats.additions > 0 || stats.deletions > 0) && (
                <span className="git-file-stats flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
                  {stats.additions > 0 && (
                    <span className="text-success">+{stats.additions}</span>
                  )}
                  {stats.deletions > 0 && (
                    <span className="text-destructive">−{stats.deletions}</span>
                  )}
                </span>
              )}
              <span
                className={cn(
                  "w-3 shrink-0 text-center font-mono text-[11px] font-semibold",
                  statusMeta?.className ?? "text-muted-foreground"
                )}
                title={statusMeta?.label}
              >
                {statusChar}
              </span>
              {/* Stage button */}
              {onStage && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onStage(file)
                  }}
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground"
                  title="Stage file"
                >
                  <PlusIcon className="size-3.5" strokeWidth={2} />
                </button>
              )}
              {/* Unstage button */}
              {onUnstage && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onUnstage(file)
                  }}
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground"
                  title="Unstage file"
                >
                  <MinusIcon className="size-3.5" strokeWidth={2} />
                </button>
              )}
              {/* Discard button */}
              {onDiscard && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDiscard(file)
                  }}
                  className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-accent hover:text-destructive"
                  title="Discard changes"
                >
                  <Undo2Icon className="size-3.5" strokeWidth={2} />
                </button>
              )}
            </div>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}
