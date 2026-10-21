import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FolderIcon,
  GitBranchIcon,
  RefreshCwIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { gitInit, gitStatus, isGitRepo } from "@/services/backend/gitApi"
import { useChatStore, getThreadStream } from "@/lib/chat-store"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import { createLogger } from "@/lib/logger"

const log = createLogger("workspace-status-bar")

interface RepoState {
  isRepo: boolean | null
  branch: string
  changes: number
  ahead: number
  behind: number
  upstream: string | null
}

const EMPTY_STATE: RepoState = {
  isRepo: null,
  branch: "",
  changes: 0,
  ahead: 0,
  behind: 0,
  upstream: null,
}

/**
 * Status bar pinned to the bottom of the workspace panel.
 *
 * Surfaces the workspace the panel is currently bound to (it follows the
 * focused chat) plus a live git summary: branch, working-tree state and how
 * far the branch has drifted from its upstream. When the folder isn't a git
 * repository yet it offers a one-click `git init` instead of going blank —
 * that's the one case where the bar is actionable rather than informational.
 *
 * Refresh strategy mirrors the git panel: poll while the window is visible,
 * plus an immediate refresh whenever an agent turn finishes (that's when the
 * working tree most likely changed).
 */
export function WorkspaceStatusBar({
  projectName,
  projectPath,
  isWorktree,
}: {
  projectName: string
  projectPath: string | null
  isWorktree: boolean
}) {
  const [state, setState] = useState<RepoState>(EMPTY_STATE)
  const [initializing, setInitializing] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (!projectPath || inFlight.current) return
    inFlight.current = true
    try {
      let repo = false
      try {
        repo = await isGitRepo(projectPath)
      } catch {
        setState({ ...EMPTY_STATE, isRepo: false })
        return
      }
      if (!repo) {
        setState({ ...EMPTY_STATE, isRepo: false })
        return
      }
      const status = await gitStatus(projectPath).catch(() => null)
      if (!status) {
        setState((prev) => ({ ...prev, isRepo: true }))
        return
      }
      setState({
        isRepo: true,
        branch: status.branch,
        changes:
          status.staged.length +
          status.modified.length +
          status.untracked.length,
        ahead: status.ahead,
        behind: status.behind,
        upstream: status.upstream,
      })
    } finally {
      inFlight.current = false
    }
  }, [projectPath])

  useEffect(() => {
    setState(EMPTY_STATE)
    void refresh()
  }, [refresh])

  useVisibilityInterval(() => void refresh(), 8000, {
    enabled: !!projectPath,
  })

  // An agent turn that just ended almost always touched files — refresh once
  // on the streaming → idle edge instead of waiting out the poll interval.
  const isStreaming = useChatStore(
    (s) => getThreadStream(s, s.activeThreadId).isStreaming
  )
  const prevStreaming = useRef(false)
  useEffect(() => {
    if (prevStreaming.current && !isStreaming) void refresh()
    prevStreaming.current = isStreaming
  }, [isStreaming, refresh])

  const handleInit = async () => {
    if (!projectPath || initializing) return
    setInitializing(true)
    try {
      await gitInit(projectPath)
      await refresh()
    } catch (error) {
      log.warn("Failed to initialize git repository", error)
    } finally {
      setInitializing(false)
    }
  }

  const { isRepo, branch, changes, ahead, behind, upstream } = state
  const clean = isRepo === true && changes === 0

  return (
    <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-sidebar px-3 py-1.5 text-[10.5px] text-muted-foreground">
      {/* Workspace */}
      <span
        className="flex min-w-0 items-center gap-1.5"
        title={projectPath ?? undefined}
      >
        <FolderIcon
          className="size-3 shrink-0 text-muted-foreground/60"
          strokeWidth={1.75}
        />
        <span className="truncate font-medium text-foreground">
          {projectName}
        </span>
        {isWorktree && (
          <span
            className="shrink-0 rounded bg-muted px-1 text-[9px] tracking-wide uppercase"
            title="This chat runs in a git worktree"
          >
            wt
          </span>
        )}
      </span>

      {/* Git summary */}
      {isRepo === false && (
        <button
          type="button"
          onClick={handleInit}
          disabled={initializing}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-amber-500 transition-colors hover:bg-accent disabled:opacity-60"
          title="Run git init in this folder"
        >
          <GitBranchIcon className="size-3" strokeWidth={1.75} />
          {initializing ? "Initializing…" : "Not a Git repository — Initialize"}
        </button>
      )}

      {isRepo === true && (
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <GitBranchIcon className="size-3 shrink-0" strokeWidth={1.75} />
            <span className="truncate font-medium text-foreground">
              {branch || "detached HEAD"}
            </span>
          </span>

          <span
            className="flex shrink-0 items-center gap-1.5"
            title={
              clean
                ? "Working tree is clean"
                : `${changes} uncommitted change${changes === 1 ? "" : "s"}`
            }
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                clean ? "bg-emerald-500" : "bg-amber-500"
              )}
            />
            <span className="tabular-nums">
              {clean ? "Clean" : `${changes} change${changes === 1 ? "" : "s"}`}
            </span>
          </span>

          {/* Upstream drift. No tracking branch is worth calling out — it's
              why Push shows "Publish" over in the Git tab. */}
          {!upstream ? (
            <span
              className="shrink-0 text-muted-foreground/60"
              title="This branch has no upstream yet"
            >
              No upstream
            </span>
          ) : (
            (ahead > 0 || behind > 0) && (
              <span
                className="flex shrink-0 items-center gap-2 tabular-nums"
                title={`${ahead} to push, ${behind} to pull (${upstream})`}
              >
                {ahead > 0 && (
                  <span className="flex items-center gap-0.5">
                    <ArrowUpIcon className="size-2.5" strokeWidth={2} />
                    {ahead}
                  </span>
                )}
                {behind > 0 && (
                  <span className="flex items-center gap-0.5">
                    <ArrowDownIcon className="size-2.5" strokeWidth={2} />
                    {behind}
                  </span>
                )}
              </span>
            )
          )}
        </>
      )}

      <button
        type="button"
        onClick={() => void refresh()}
        className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground"
        title="Refresh git status"
        aria-label="Refresh git status"
      >
        <RefreshCwIcon className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  )
}
