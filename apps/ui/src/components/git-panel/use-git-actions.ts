import { useCallback, useEffect, useRef, useState } from "react"
import type { GitStatus } from "@betterc0de/schema"
import {
  gitCheckoutBranch,
  gitCommit,
  gitDiscard,
  gitFetch,
  gitInit,
  gitPull,
  gitPush,
  gitStage,
  gitStageAll,
  gitStash,
  gitStashPop,
  gitUnstage,
  gitUnstageAll,
} from "@/services/backend/gitApi"
import { generateWorkspaceCommitMessage } from "@/lib/git-commit-message"
import { createLogger } from "@/lib/logger"
import type { GitConfirmAction } from "./git-panel-utils"

const log = createLogger("git-panel")

export interface UseGitActionsInput {
  cwd: string
  status: GitStatus | null
  refresh: (silent?: boolean) => Promise<void>
  refreshBranches: () => Promise<void>
  syncActiveThreadBranch: (branch: string | null | undefined) => void
  setCurrentBranch: (branch: string) => void
  applyFetchedStatus: (status: GitStatus) => void
}

/**
 * The git panel's actions and the state they drive: the commit message and
 * its generation, remote fetch/push/pull progress and errors, branch creation
 * and checkout, staging, discarding and stashing. Destructive and remote
 * actions are not run directly; they set `confirmAction`, which the panel's
 * confirmation dialog runs.
 */
export function useGitActions({
  cwd,
  status,
  refresh,
  refreshBranches,
  syncActiveThreadBranch,
  setCurrentBranch,
  applyFetchedStatus,
}: UseGitActionsInput) {
  const [commitMsg, setCommitMsg] = useState("")
  const [commitError, setCommitError] = useState<string | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [isCommitting, setIsCommitting] = useState(false)
  const [isGeneratingCommit, setIsGeneratingCommit] = useState(false)
  const [isPushing, setIsPushing] = useState(false)
  const [isPulling, setIsPulling] = useState(false)
  const [isFetching, setIsFetching] = useState(false)
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null)
  const remoteFetchRef = useRef({ id: 0 })
  const [confirmAction, setConfirmAction] = useState<GitConfirmAction | null>(
    null
  )
  const [newBranchName, setNewBranchName] = useState("")
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
      applyFetchedStatus(result.status)
      setLastFetchedAt(new Date())
    } catch (err) {
      if (request !== remoteFetchRef.current.id) return
      setLastFetchedAt(null)
      setRemoteError(err instanceof Error ? err.message : String(err))
    } finally {
      if (request === remoteFetchRef.current.id) setIsFetching(false)
    }
  }, [cwd, isFetching, isPushing, isPulling, isCommitting, applyFetchedStatus])

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
    [cwd, refresh, refreshBranches, syncActiveThreadBranch, setCurrentBranch]
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
  }, [
    cwd,
    newBranchName,
    refresh,
    refreshBranches,
    syncActiveThreadBranch,
    setCurrentBranch,
  ])

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

  const handleInit = useCallback(async () => {
    try {
      await gitInit(cwd)
      refresh()
    } catch (err) {
      log.warn("Git init failed", err)
    }
  }, [cwd, refresh])

  return {
    commitMsg,
    setCommitMsg,
    commitError,
    setCommitError,
    remoteError,
    setRemoteError,
    isCommitting,
    isGeneratingCommit,
    isPushing,
    isPulling,
    isFetching,
    lastFetchedAt,
    confirmAction,
    setConfirmAction,
    newBranchName,
    setNewBranchName,
    handleCommit,
    handleGenerateCommitMessage,
    handleFetch,
    handlePush,
    handlePull,
    handleDiscard,
    handleStageFile,
    handleUnstageFile,
    handleStageAll,
    handleUnstageAll,
    handleCheckout,
    handleCreateBranch,
    handleStash,
    handleStashPop,
    handleInit,
  }
}
