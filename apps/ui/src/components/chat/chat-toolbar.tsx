import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitCommitVerticalIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { createLogger } from "@/lib/logger"
import { Badge } from "@/components/ui/badge"
import { ForkIntoRepoBadge } from "@/components/chat/fork-into-repo-badge"
import { ProviderIcon } from "@/components/provider-icon"
import type { UiProvider } from "@/lib/provider-types"

const log = createLogger("chat-toolbar")
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getThreadStream, useChatStore } from "@/lib/chat-store"
import { usePrompt } from "@/components/dialogs/prompt-provider"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import { OpenTargetIcon } from "@/components/icons/open-target-icons"
import { useOpenTargets } from "@/hooks/use-open-targets"
import {
  gitCommit,
  gitInit,
  gitPush,
  gitStatus,
  isGitRepo,
  openInEditor,
  pickFolder,
} from "@/services/backend"

/**
 * The thin toolbar that sits above the chat messages (or in side-panel mode,
 * along the side). Shows thread title + project badge, live git status for
 * the project working directory, and inline quick-actions: open in
 * Cursor/VS Code/Zed, commit + push, toggle diff panel, rename/delete.
 *
 * Two layout variants (`"top"` vs `"side"`) share all behavior — only the
 * flex direction / button sizing differs. Layout is flagged at the call
 * site rather than media-queried here so the parent can decide based on
 * its own breakpoints.
 */
export function ChatToolbar({
  thread,
  onToggleDiff,
  onConfirm,
  mode = "agent",
  onOpenFileExplorer,
  onOpenGit,
  minimal,
  layout = "top",
  selectedProvider,
  selectedModel,
  gitStatusOnly = false,
  gitStatusClassName,
}: {
  thread: {
    id: string
    title: string
    projectName: string
    projectPath: string
    worktreePath?: string | null
  } | null
  onToggleTerminal?: () => void
  onToggleDiff?: () => void
  onConfirm?: (opts: {
    title: string
    description: string
    action: () => void
  }) => void
  mode?: "agent" | "editor" | "design"
  onOpenFileExplorer?: () => void
  onOpenGit?: () => void
  minimal?: boolean
  layout?: "top" | "side"
  selectedProvider?: UiProvider
  selectedModel?: string
  /** Render a slim variant with just the git status pill (and the No-Git
   *  Init action). All other badges/buttons are skipped. Editor mode uses
   *  this so the chat panel mirrors Agent mode 1:1 except for the
   *  context-rich git indicator. */
  gitStatusOnly?: boolean
  /** Container override for the `gitStatusOnly` variant — lets callers embed
   *  the pill inside an existing row instead of it owning a full-width bar. */
  gitStatusClassName?: string
}) {
  const prompt = usePrompt()
  const confirm = useConfirm()
  const [commitMsg, setCommitMsg] = useState("")
  const [showCommit, setShowCommit] = useState(false)
  const [isGit, setIsGit] = useState<boolean | null>(null)
  const [gitDirty, setGitDirty] = useState(false)
  const [gitChanges, setGitChanges] = useState(0)
  const [showRemoteInput, setShowRemoteInput] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState("")
  const [addingRemote, setAddingRemote] = useState(false)
  const sideLayout = layout === "side"
  const editorCompact = mode === "editor"
  const sideActionClass = sideLayout ? "w-full justify-start" : ""
  const selectedModelMeta = selectedProvider?.models.find(
    (model) => model.id === selectedModel
  )
  const selectedModelLabel = selectedModelMeta?.name ?? selectedModel
  const providerLabel = selectedProvider?.name ?? selectedProvider?.id

  // The project path — NEVER "." (which would be the IDE itself)
  const cwd =
    thread?.worktreePath?.trim() || thread?.projectPath?.trim() || null

  // Installed external tools for the "Open In" menu (shared cache with
  // the right panel's header menu).
  const { targets: openTargets } = useOpenTargets(mode === "agent" && !!cwd)

  // Check git status when cwd changes
  useEffect(() => {
    let active = true
    setGitDirty(false)
    setGitChanges(0)
    if (!cwd) {
      setIsGit(null)
      return
    }

    const loadGitStatus = async () => {
      try {
        const repo = await isGitRepo(cwd)
        if (!active) return
        setIsGit(repo)
        if (!repo) return

        const s = await gitStatus(cwd)
        if (!active) return
        const changes =
          ((s.staged as string[])?.length || 0) +
          ((s.modified as string[])?.length || 0) +
          ((s.untracked as string[])?.length || 0)
        setGitDirty(changes > 0)
        setGitChanges(changes)
      } catch {
        if (!active) return
        setIsGit(false)
        log.warn("Failed to fetch initial git status")
      }
    }
    void loadGitStatus()
    return () => {
      active = false
    }
  }, [cwd])

  const refreshGit = useCallback(async () => {
    if (!cwd) return
    try {
      const repo = await isGitRepo(cwd)
      setIsGit(repo)
      if (!repo) {
        setGitDirty(false)
        setGitChanges(0)
        return
      }
      const s = await gitStatus(cwd)
      const changes =
        ((s.staged as string[])?.length || 0) +
        ((s.modified as string[])?.length || 0) +
        ((s.untracked as string[])?.length || 0)
      setGitDirty(changes > 0)
      setGitChanges(changes)
    } catch {
      setIsGit(false)
      setGitDirty(false)
      setGitChanges(0)
      log.warn("Failed to refresh git status")
    }
  }, [cwd])

  const confirmGitMutation = useCallback(
    (input: { title: string; description: string; action: () => void }) => {
      if (onConfirm) {
        onConfirm(input)
        return
      }
      // No `onConfirm` supplied: ask through the app's own dialog rather than
      // the native one, which blocks the renderer and ignores the theme.
      void confirm({
        title: input.title,
        description: input.description,
        confirmLabel: "Continue",
      }).then((ok) => {
        if (ok) input.action()
      })
    },
    [onConfirm, confirm]
  )

  // Auto-refresh git status when an AI turn completes
  const toolbarIsStreaming = useChatStore(
    (s) => getThreadStream(s, thread?.id ?? null).isStreaming
  )
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    if (prevStreamingRef.current && !toolbarIsStreaming) {
      refreshGit()
    }
    prevStreamingRef.current = toolbarIsStreaming
  }, [toolbarIsStreaming, refreshGit])

  if (!thread) return null

  if (gitStatusOnly) {
    // No git context (no project path attached, or fetch hasn't resolved):
    // render nothing rather than an empty bar — keeps the Editor chat panel
    // as close as possible to Agent-mode chrome when there's no useful
    // git signal to show.
    if (!cwd) return null
    const hasGitBadge = isGit === false || (isGit && true)
    if (!hasGitBadge) return null
    return (
      <div
        className={
          gitStatusClassName ??
          "flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-1.5"
        }
      >
        {isGit === false && (
          <Badge
            variant="outline"
            className="cursor-pointer gap-1.5 py-0.5 text-xs text-amber-600 hover:bg-amber-500/10"
            onClick={async () => {
              try {
                await gitInit(cwd)
                refreshGit()
                const { gitListRemotes } = await import("@/services/backend")
                const remotes = await gitListRemotes(cwd)
                if (remotes.length === 0) setShowRemoteInput(true)
              } catch {
                log.warn("Failed to initialize git repository")
              }
            }}
          >
            <GitBranchIcon className="size-3" />
            No Git — Init?
          </Badge>
        )}
        {isGit && gitDirty && (
          <Badge
            variant="outline"
            className="shrink-0 gap-1.5 border-transparent bg-amber-500/10 py-0.5 text-xs text-amber-600 tabular-nums dark:text-amber-400"
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            {gitChanges} change{gitChanges !== 1 ? "s" : ""}
          </Badge>
        )}
        {isGit && !gitDirty && (
          <Badge
            variant="outline"
            className="shrink-0 gap-1.5 border-transparent bg-emerald-500/10 py-0.5 text-xs text-emerald-600 dark:text-emerald-400"
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            Clean
          </Badge>
        )}
        {showRemoteInput && (
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              className="h-6 w-56 rounded-md border border-border bg-transparent px-2 text-xs focus:border-ring focus:outline-none"
              autoFocus
            />
            <Button
              size="xs"
              disabled={!remoteUrl.trim() || addingRemote}
              onClick={() => {
                if (!remoteUrl.trim()) return
                const requestedRemote = remoteUrl.trim()
                confirmGitMutation({
                  title: "Add remote and push?",
                  description: `Add origin (${requestedRemote}) and push this repository to it.`,
                  action: async () => {
                    setAddingRemote(true)
                    try {
                      const { gitAddRemote } =
                        await import("@/services/backend")
                      await gitAddRemote(cwd, "origin", requestedRemote)
                      await gitPush(cwd)
                      setShowRemoteInput(false)
                      setRemoteUrl("")
                      refreshGit()
                    } catch {
                      log.warn("Failed to add remote and push")
                    } finally {
                      setAddingRemote(false)
                    }
                  },
                })
              }}
            >
              {addingRemote ? "Pushing..." : "Add & Push"}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setShowRemoteInput(false)}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        "mx-auto flex w-full items-center border-b border-border/40",
        editorCompact
          ? "max-w-none gap-1 px-2 py-1 text-[11px]"
          : "gap-2 px-4 py-1.5 text-xs",
        !editorCompact &&
          (minimal ? "max-w-[900px]" : "max-w-[var(--chat-max-width)]"),
        sideLayout &&
          "mx-0 max-w-none flex-col items-stretch gap-3 rounded-xl border border-sidebar-border/80 bg-sidebar-accent/25 px-3 py-3"
      )}
    >
      {/* Left: Title + Project + Git Status */}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center overflow-hidden",
          editorCompact ? "gap-1.5" : "gap-2.5",
          sideLayout &&
            "w-full flex-none flex-col items-start gap-2 overflow-visible"
        )}
      >
        <h2
          className={cn(
            "min-w-0 shrink truncate font-semibold",
            editorCompact ? "text-[11px]" : "text-xs"
          )}
          title={thread.title}
        >
          {thread.title || "New Chat"}
        </h2>
        {thread.projectPath ? (
          <Badge
            variant="outline"
            className={cn(
              "shrink-0 gap-1 py-0.5",
              editorCompact ? "px-1.5 text-[10px]" : "gap-1.5 text-xs"
            )}
          >
            <FolderOpenIcon className={editorCompact ? "size-3" : "size-3.5"} />
            {thread.projectName}
          </Badge>
        ) : (
          <>
            <Badge
              variant="outline"
              className="shrink-0 cursor-pointer gap-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              onClick={async () => {
                const folder = await pickFolder()
                if (folder) {
                  const name = folder.split(/[/\\]/).pop() || "Project"
                  useChatStore.setState((s) => ({
                    threads: s.threads.map((t) =>
                      t.id === thread.id
                        ? { ...t, projectPath: folder, projectName: name }
                        : t
                    ),
                  }))
                }
              }}
            >
              <FolderOpenIcon className="size-3.5" />
              Attach Folder
            </Badge>
            <ForkIntoRepoBadge threadId={thread.id} />
          </>
        )}
        {editorCompact && selectedProvider && (
          <Badge
            variant="outline"
            className="min-w-0 shrink-0 gap-1 px-1.5 py-0.5 text-[10px]"
            title={`${providerLabel ?? "Provider"}${selectedModelLabel ? ` - ${selectedModelLabel}` : ""}`}
          >
            <ProviderIcon provider={selectedProvider} className="!size-3" />
            <span className="truncate">{providerLabel ?? "Provider"}</span>
            {selectedModelLabel && (
              <span className="max-w-[92px] truncate text-muted-foreground">
                {selectedModelLabel}
              </span>
            )}
          </Badge>
        )}
        {isGit === false && cwd && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge
              variant="outline"
              className="cursor-pointer gap-1.5 py-0.5 text-xs text-amber-600 hover:bg-amber-500/10"
              onClick={async () => {
                try {
                  await gitInit(cwd)
                  refreshGit()
                  const { gitListRemotes } = await import("@/services/backend")
                  const remotes = await gitListRemotes(cwd)
                  if (remotes.length === 0) setShowRemoteInput(true)
                } catch {
                  log.warn("Failed to initialize git repository")
                }
              }}
            >
              <GitBranchIcon className="size-3" />
              No Git — Init?
            </Badge>
            {showRemoteInput && (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  className="h-6 w-56 rounded-md border border-border bg-transparent px-2 text-xs focus:border-ring focus:outline-none"
                  autoFocus
                />
                <Button
                  size="xs"
                  disabled={!remoteUrl.trim() || addingRemote}
                  onClick={() => {
                    if (!remoteUrl.trim()) return
                    const requestedRemote = remoteUrl.trim()
                    confirmGitMutation({
                      title: "Add remote and push?",
                      description: `Add origin (${requestedRemote}) and push this repository to it.`,
                      action: async () => {
                        setAddingRemote(true)
                        try {
                          const { gitAddRemote } =
                            await import("@/services/backend")
                          await gitAddRemote(cwd, "origin", requestedRemote)
                          await gitPush(cwd)
                          setShowRemoteInput(false)
                          setRemoteUrl("")
                          refreshGit()
                        } catch {
                          log.warn("Failed to add remote and push")
                        } finally {
                          setAddingRemote(false)
                        }
                      },
                    })
                  }}
                >
                  {addingRemote ? "Pushing..." : "Add & Push"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setShowRemoteInput(false)}
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
            )}
          </div>
        )}
        {isGit && gitDirty && (
          <Badge
            variant="outline"
            className="shrink-0 gap-1.5 border-transparent bg-amber-500/10 py-0.5 text-xs text-amber-600 tabular-nums dark:text-amber-400"
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            {gitChanges} change{gitChanges !== 1 ? "s" : ""}
          </Badge>
        )}
        {isGit && !gitDirty && (
          <Badge
            variant="outline"
            className="shrink-0 gap-1.5 border-transparent bg-emerald-500/10 py-0.5 text-xs text-emerald-600 dark:text-emerald-400"
          >
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            Clean
          </Badge>
        )}
      </div>

      {/* Right: Actions */}
      <div
        className={cn(
          "flex shrink-0 items-center",
          editorCompact ? "gap-1" : "gap-1.5",
          sideLayout && "w-full flex-col items-stretch gap-1.5"
        )}
      >
        {/* File Explorer + Source Control — agent mode only */}
        {mode === "agent" && cwd && onOpenFileExplorer && (
          <Button
            variant="outline"
            size="xs"
            className={cn(
              editorCompact ? "h-6 gap-1 px-1.5 text-[10px]" : "gap-1.5",
              sideActionClass
            )}
            onClick={onOpenFileExplorer}
          >
            <FolderOpenIcon className="size-3.5" />
            Files
          </Button>
        )}
        {mode === "agent" && cwd && onOpenGit && (
          <Button
            variant="outline"
            size="xs"
            className={cn(
              editorCompact ? "h-6 gap-1 px-1.5 text-[10px]" : "gap-1.5",
              sideActionClass
            )}
            onClick={onOpenGit}
          >
            <GitBranchIcon className="size-3.5" />
            Git
          </Button>
        )}
        {mode === "agent" && cwd ? (
          <Button
            variant="outline"
            size="xs"
            className={cn(
              editorCompact ? "h-6 gap-1 px-1.5 text-[10px]" : "gap-1.5",
              sideActionClass
            )}
            onClick={() => openInEditor(cwd, "explorer")}
          >
            <ExternalLinkIcon className="size-3.5" />
            Explorer
          </Button>
        ) : mode === "agent" ? (
          <Button
            variant="outline"
            size="xs"
            className={cn(
              editorCompact ? "h-6 gap-1 px-1.5 text-[10px]" : "gap-1.5",
              sideActionClass
            )}
            onClick={async () => {
              const folder = await pickFolder()
              if (folder && thread) {
                const name = folder.split(/[/\\]/).pop() || "Project"
                useChatStore.setState((state) => ({
                  threads: state.threads.map((t) =>
                    t.id === thread.id
                      ? { ...t, projectPath: folder, projectName: name }
                      : t
                  ),
                }))
                const updated = useChatStore
                  .getState()
                  .threads.find((t) => t.id === thread.id)
                if (updated) {
                  import("@/services/backend").then(({ upsertThreadMeta }) =>
                    upsertThreadMeta(updated)
                  )
                }
              }
            }}
          >
            <FolderOpenIcon className="size-3.5" />
            Open Folder
          </Button>
        ) : null}

        {/* Open in Editor (agent mode only) — items come from the backend's
            installed-tool detection, shared with the right panel's menu. */}
        {mode === "agent" && cwd && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="xs"
                className={cn("gap-1.5", sideActionClass)}
              >
                <ExternalLinkIcon className="size-3.5" />
                Open In
                <ChevronDownIcon className="size-3 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[190px]">
              {!openTargets ? (
                <DropdownMenuItem disabled>Detecting…</DropdownMenuItem>
              ) : (
                openTargets
                  .filter((t) => t.available)
                  .map((target, index, available) => (
                    <React.Fragment key={target.id}>
                      {index > 0 &&
                        available[index - 1]!.group !== target.group && (
                          <DropdownMenuSeparator />
                        )}
                      <DropdownMenuItem
                        onClick={() => openInEditor(cwd, target.id)}
                        className="gap-2.5"
                      >
                        <OpenTargetIcon id={target.id} className="size-4" />
                        {target.label}
                      </DropdownMenuItem>
                    </React.Fragment>
                  ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Git Actions (agent mode only) */}
        {mode === "agent" && cwd && isGit && (
          <>
            {showCommit ? (
              <div
                className={cn(
                  "flex items-center gap-1.5",
                  sideLayout && "w-full flex-col items-stretch"
                )}
              >
                <input
                  type="text"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="Commit message..."
                  className={cn(
                    "h-6 w-44 rounded-md border border-border bg-transparent px-2 text-xs focus:border-ring focus:outline-none",
                    sideLayout && "w-full"
                  )}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && commitMsg.trim()) {
                      gitCommit(cwd, commitMsg)
                        .then(() => {
                          setCommitMsg("")
                          setShowCommit(false)
                          refreshGit()
                        })
                        .catch(() => {
                          log.warn("Git commit failed (keyboard submit)")
                        })
                    }
                    if (e.key === "Escape") setShowCommit(false)
                  }}
                  autoFocus
                />
                <Button
                  size="sm"
                  className={cn(sideLayout && "w-full justify-start")}
                  disabled={!commitMsg.trim()}
                  onClick={() => {
                    if (commitMsg.trim())
                      gitCommit(cwd, commitMsg)
                        .then(() => {
                          setCommitMsg("")
                          setShowCommit(false)
                          refreshGit()
                        })
                        .catch(() => {
                          log.warn("Git commit failed (button submit)")
                        })
                  }}
                >
                  <CheckIcon className="size-3.5" />
                  Commit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(sideLayout && "w-full justify-start")}
                  onClick={() => setShowCommit(false)}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="xs"
                className={cn("gap-1.5", sideActionClass)}
                onClick={() => setShowCommit(true)}
                disabled={!gitDirty}
              >
                <GitCommitVerticalIcon className="size-3.5" />
                Commit
              </Button>
            )}

            <Button
              variant="outline"
              size="xs"
              className={cn("gap-1.5", sideActionClass)}
              onClick={() =>
                confirmGitMutation({
                  title: "Push commits?",
                  description:
                    "Push the current branch to its configured remote.",
                  action: () => {
                    void gitPush(cwd)
                      .then(() => refreshGit())
                      .catch(() => {
                        log.warn("Git push failed")
                      })
                  },
                })
              }
            >
              <ArrowUpIcon className="size-3.5" />
              Push
            </Button>
          </>
        )}

        {/* Diff toggle */}
        {cwd && (
          <Button
            variant="outline"
            size="xs"
            className={cn("gap-1.5", sideActionClass)}
            onClick={onToggleDiff}
          >
            <CodeIcon className={editorCompact ? "size-3" : "size-3.5"} />
            Diff
          </Button>
        )}

        {/* More menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size={sideLayout ? "sm" : editorCompact ? "icon-xs" : "icon-sm"}
              className={cn(
                editorCompact && "size-6 rounded",
                sideLayout && "w-full justify-between"
              )}
            >
              <MoreHorizontalIcon className="size-3.5" />
              {sideLayout && <span className="text-xs">More</span>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={async () => {
                const newTitle = await prompt({
                  title: "Rename thread",
                  defaultValue: thread.title,
                  confirmLabel: "Rename",
                })
                if (newTitle?.trim())
                  useChatStore
                    .getState()
                    .updateThreadTitle(thread.id, newTitle.trim())
              }}
            >
              <PencilIcon className="size-3.5" /> Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() =>
                onConfirm?.({
                  title: "Delete chat?",
                  description:
                    "This chat and all its messages will be permanently deleted.",
                  action: () => useChatStore.getState().deleteThread(thread.id),
                })
              }
            >
              <Trash2Icon className="size-3.5" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
