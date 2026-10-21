import "./diff-panel.css"
import { DiffHunkLines, useDiffSyntax } from "./diff-code"
import { copyText } from "@/lib/clipboard"
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type CSSProperties,
} from "react"
import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { LayoutAlignLeftIcon } from "@hugeicons/core-free-icons"
import {
  RefreshCwIcon,
  PlusIcon,
  MinusIcon,
  ChevronDownIcon,
  SplitIcon,
  AlignJustifyIcon,
  FileDiffIcon,
  SearchIcon,
  CopyIcon,
  CheckIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  XIcon,
  Undo2Icon,
  FileCode2Icon,
} from "lucide-react"
import {
  gitApplyHunk,
  gitDiff,
  gitDiffStaged,
  gitStage,
  gitUnstage,
} from "@/services/backend"
import { useChatStore } from "@/lib/chat-store"
import { useEditorStore } from "@/lib/editor-store"
import { getFileIconUrl } from "@/lib/file-icons"
import { useSettingsStore } from "@/lib/settings-store"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import { useDiffFileListResize } from "@/hooks/use-diff-file-list-resize"
import { createLogger } from "@/lib/logger"
import { parseGitDiff, type DiffFile, type DiffHunk } from "@/lib/git-diff"
import { HttpError } from "@/lib/errors/types"
import { toast } from "@/lib/toast"
import { dispatchEditorRevealFile } from "@/lib/editor-reveal-event"
import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { editorDiffKey, type EditorDiffTarget } from "@/lib/editor-diff"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

// M11: route catches through the shared logger.
const log = createLogger("diff-panel")

interface DiffPanelProps {
  open: boolean
  onClose: () => void
  cwd?: string
  /** When set, auto-refresh keys off THIS thread's stream end (per-pane);
   *  falls back to the globally active thread when omitted. */
  threadId?: string | null
  /** A fixed comparison document; never fall back to a different file. */
  fileTarget?: EditorDiffTarget
  /** The editor sidebar lists files and opens their comparisons in editor tabs. */
  onSelectDiff?: (target: EditorDiffTarget, preview: boolean) => void
  selectedDiff?: EditorDiffTarget | null
}

type DiffViewMode = "unified" | "split"

// ------------------------------------------------------------------
// Tiny presentational helpers — keep them out of the main render so the
// JSX reads top-to-bottom as layout, not as inline style soup.
// ------------------------------------------------------------------

function StatPill({
  kind,
  value,
  size = "sm",
}: {
  kind: "add" | "del"
  value: number
  size?: "xs" | "sm"
}) {
  if (value <= 0) return null
  return (
    <span
      className={cn(
        "diff-stat inline-flex items-center font-medium tabular-nums",
        size === "xs" ? "text-[10px]" : "text-[11px]",
        kind === "add" ? "text-success" : "text-destructive"
      )}
    >
      {kind === "add" ? "+" : "−"}
      {value}
    </span>
  )
}

function StatusBadge({ kind }: { kind: "new" | "del" | "mod" }) {
  const map = {
    new: {
      label: "N",
      title: "New file",
      cls: "text-success",
    },
    del: {
      label: "D",
      title: "Deleted",
      cls: "text-destructive",
    },
    mod: {
      label: "M",
      title: "Modified",
      cls: "text-warning",
    },
  } as const
  const v = map[kind]
  return (
    <span
      title={v.title}
      className={cn(
        "inline-flex size-4 items-center justify-center text-[10px] font-medium",
        v.cls
      )}
    >
      {v.label}
    </span>
  )
}

function ToolbarButton({
  onClick,
  disabled,
  title,
  children,
  active,
  className,
}: {
  onClick?: () => void
  disabled?: boolean
  title: string
  children: React.ReactNode
  active?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn("diff-toolbar-button", active && "is-active", className)}
    >
      {children}
    </button>
  )
}

export function DiffPanel({
  open,
  onClose: _onClose,
  cwd,
  threadId,
  fileTarget,
  onSelectDiff,
  selectedDiff,
}: DiffPanelProps) {
  const listOnly = Boolean(onSelectDiff)
  const diffWordWrap = useSettingsStore((state) => state.diffWordWrap)
  const diffStyle = useSettingsStore((state) => state.diffStyle)
  const updateSettings = useSettingsStore((state) => state.update)
  const [files, setFiles] = useState<DiffFile[]>([])
  const [stagedFiles, setStagedFiles] = useState<DiffFile[]>([])
  const [loading, setLoading] = useState(false)
  /** Server capped the diff payload; the view is showing a prefix. */
  const [diffTruncated, setDiffTruncated] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<DiffViewMode>(
    fileTarget ? "split" : "unified"
  )
  const [stagedSelected, setShowStaged] = useState(false)
  const showStaged = fileTarget
    ? fileTarget.source === "staged"
    : stagedSelected
  useEffect(() => {
    if (listOnly && selectedDiff && selectedDiff.cwd === cwd) {
      setShowStaged(selectedDiff.source === "staged")
    }
  }, [listOnly, selectedDiff, cwd])
  const [collapsedHunks, setCollapsedHunks] = useState<Set<string>>(new Set())
  const [fileListOpen, setFileListOpen] = useState(true)
  const fileListToggleRef = useRef<HTMLButtonElement>(null)
  const [filter, setFilter] = useState("")
  const [copied, setCopied] = useState(false)
  const [pendingHunkAction, setPendingHunkAction] = useState<string | null>(
    null
  )
  const [hunkConflict, setHunkConflict] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const inFlightRef = useRef<object | null>(null)
  const lastDiffTextRef = useRef("")
  const openDiffFile = useCallback(
    (file: DiffFile | null | undefined) => {
      if (!cwd || !file || file.isDeleted) return
      const path = resolveWorkspaceFilePath(cwd, file.name)
      if (fileTarget) {
        void useEditorStore.getState().openFile(path)
        return
      }
      dispatchEditorRevealFile(path, {
        defer: true,
      })
    },
    [cwd, fileTarget]
  )
  const lastStagedTextRef = useRef("")

  const refresh = useCallback(
    async (silent = false) => {
      if (!cwd) return
      if (inFlightRef.current) return
      const request = {}
      inFlightRef.current = request
      if (!silent) setLoading(true)
      try {
        const [unstaged, staged] = await Promise.all([
          gitDiff(cwd),
          gitDiffStaged(cwd),
        ])
        if (inFlightRef.current !== request) return
        setLoadError(null)
        const text = (unstaged.diff_text as string) || ""
        const stagedText = (staged.diff_text as string) || ""
        // The server bounds the payload (see DISPLAY_DIFF_MAX_BYTES). Say so
        // rather than rendering a prefix that looks like the complete diff.
        setDiffTruncated(
          unstaged.truncated === true || staged.truncated === true
        )
        if (text !== lastDiffTextRef.current) {
          lastDiffTextRef.current = text
          setFiles(parseGitDiff(text))
        }
        if (stagedText !== lastStagedTextRef.current) {
          lastStagedTextRef.current = stagedText
          setStagedFiles(parseGitDiff(stagedText))
        }
      } catch (error) {
        if (inFlightRef.current !== request) return
        setLoadError(
          error instanceof Error ? error.message : "Could not load changes."
        )
      } finally {
        if (inFlightRef.current === request) {
          inFlightRef.current = null
          setLoading(false)
        }
      }
    },
    [cwd]
  )

  useEffect(() => {
    inFlightRef.current = null
    setFiles([])
    setStagedFiles([])
    setLoadError(null)
    if (open && cwd) {
      lastDiffTextRef.current = ""
      lastStagedTextRef.current = ""
      refresh()
    }
    return () => {
      inFlightRef.current = null
    }
  }, [open, cwd, refresh])

  const isStreaming = useChatStore((s) => {
    const tid = threadId ?? s.activeThreadId
    return tid ? (s.streamingByThread[tid]?.isStreaming ?? false) : false
  })
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    if (open && cwd && prevStreamingRef.current && !isStreaming) refresh()
    prevStreamingRef.current = isStreaming
  }, [isStreaming, open, cwd, refresh])

  useEffect(() => {
    if (!open || !cwd) return
    let pending: ReturnType<typeof setTimeout> | null = null
    const onFileChanged = () => {
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        refresh()
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
  }, [open, cwd, refresh])

  // Visibility-aware refresh: 5s poll while the window is visible + the
  // diff panel is open. Pauses automatically when the user switches away.
  useVisibilityInterval(
    () => {
      refresh(true)
    },
    5000,
    { enabled: open && !!cwd }
  )

  const handleStageFile = useCallback(
    async (filePath: string) => {
      if (!cwd) return
      try {
        await gitStage(cwd, [filePath])
        window.dispatchEvent(
          new CustomEvent("betterc0de:file-changed", {
            detail: { cwd, path: filePath, source: "diff-review" },
          })
        )
        refresh()
      } catch (e) {
        log.warn("Failed to stage file:", filePath, e)
      }
    },
    [cwd, refresh]
  )

  const handleUnstageFile = useCallback(
    async (filePath: string) => {
      if (!cwd) return
      try {
        await gitUnstage(cwd, [filePath])
        window.dispatchEvent(
          new CustomEvent("betterc0de:file-changed", {
            detail: { cwd, path: filePath, source: "diff-review" },
          })
        )
        refresh()
      } catch (e) {
        log.warn("Failed to unstage file:", filePath, e)
      }
    },
    [cwd, refresh]
  )

  const handleHunkAction = useCallback(
    async (
      filePath: string,
      hunk: DiffHunk,
      hunkIndex: number,
      action: "accept" | "reject" | "unstage"
    ) => {
      if (!cwd || !hunk.patch) return
      const actionKey = `${showStaged ? "staged" : "unstaged"}:${filePath}:${hunkIndex}:${action}`
      setPendingHunkAction(actionKey)
      setHunkConflict(null)
      try {
        await gitApplyHunk({
          cwd,
          path: filePath,
          source: showStaged ? "staged" : "unstaged",
          action,
          patch: hunk.patch,
        })
        window.dispatchEvent(
          new CustomEvent("betterc0de:file-changed", {
            detail: { cwd, path: filePath, source: "diff-review" },
          })
        )
        await refresh()
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          const message =
            "This hunk changed since it was loaded. The diff was refreshed; review the latest version before trying again."
          setHunkConflict(message)
          toast.warning("Hunk review needs attention", {
            description: message,
            id: `git-hunk-conflict:${filePath}`,
          })
          await refresh()
        } else {
          log.warn("Failed to apply hunk action:", action, filePath, error)
          toast.error("Hunk action failed", {
            description:
              error instanceof Error ? error.message : "Please try again.",
            id: `git-hunk-action:${filePath}`,
          })
        }
      } finally {
        setPendingHunkAction(null)
      }
    },
    [cwd, refresh, showStaged]
  )

  const toggleHunk = useCallback((fileHunkKey: string) => {
    setCollapsedHunks((prev) => {
      const next = new Set(prev)
      if (next.has(fileHunkKey)) next.delete(fileHunkKey)
      else next.add(fileHunkKey)
      return next
    })
  }, [])

  const displayFiles = showStaged ? stagedFiles : files
  const filteredFiles = useMemo(() => {
    if (!filter.trim()) return displayFiles
    const q = filter.trim().toLowerCase()
    return displayFiles.filter((f) => f.name.toLowerCase().includes(q))
  }, [displayFiles, filter])

  const activeFile = fileTarget
    ? displayFiles.find((file) => file.name === fileTarget.path)
    : (selectedFile && displayFiles.find((f) => f.name === selectedFile)) ||
      filteredFiles[0] ||
      displayFiles[0]
  const totalAdd = displayFiles.reduce((s, f) => s + f.additions, 0)
  const totalDel = displayFiles.reduce((s, f) => s + f.deletions, 0)

  const syntax = useDiffSyntax(open && !listOnly ? activeFile : undefined)
  const activeFileName = activeFile?.name.split("/").pop() || activeFile?.name
  const activeFileDir = activeFile?.name.includes("/")
    ? activeFile.name.slice(0, activeFile.name.lastIndexOf("/") + 1)
    : ""
  const effectiveViewMode = diffStyle === "stacked" ? "unified" : viewMode
  const fileListVisible =
    !fileTarget && (listOnly || (fileListOpen && displayFiles.length > 0))
  const fileListResize = useDiffFileListResize(
    open && fileListVisible && !listOnly
  )

  // All hunks of the active file collapsed?
  const allCollapsed = useMemo(() => {
    if (!activeFile || activeFile.hunks.length === 0) return false
    return activeFile.hunks.every((_, i) =>
      collapsedHunks.has(`${activeFile.name}:${i}`)
    )
  }, [activeFile, collapsedHunks])

  const toggleAllHunks = useCallback(() => {
    if (!activeFile) return
    setCollapsedHunks((prev) => {
      const next = new Set(prev)
      const keys = activeFile.hunks.map((_, i) => `${activeFile.name}:${i}`)
      if (allCollapsed) {
        for (const k of keys) next.delete(k)
      } else {
        for (const k of keys) next.add(k)
      }
      return next
    })
  }, [activeFile, allCollapsed])

  const copyDiff = useCallback(async () => {
    if (!activeFile) return
    try {
      if (!(await copyText(activeFile.rawText))) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard may be unavailable — silent */
    }
  }, [activeFile])

  const fileListToggle = (
    <button
      ref={fileListToggleRef}
      type="button"
      className="diff-toolbar-button diff-file-list-toggle"
      aria-label={fileListVisible ? "Hide file list" : "Show file list"}
      title={fileListVisible ? "Hide file list" : "Show file list"}
      aria-expanded={fileListVisible}
      onClick={() => {
        setFileListOpen((value) => !value)
        requestAnimationFrame(() =>
          fileListToggleRef.current?.focus({ preventScroll: true })
        )
      }}
    >
      <HugeiconsIcon
        icon={LayoutAlignLeftIcon}
        strokeWidth={2}
        className="size-4"
      />
    </button>
  )

  if (!open) return null

  return (
    <section
      className={cn(
        "diff-panel",
        listOnly && "diff-panel-files",
        fileTarget && "diff-panel-document"
      )}
      aria-label="File changes"
      aria-busy={loading}
    >
      <div className="diff-toolbar">
        {fileTarget ? (
          <div className="diff-comparison-label">
            <FileDiffIcon className="size-3.5" aria-hidden="true" />
            <span>{showStaged ? "HEAD → Index" : "Index → Working tree"}</span>
          </div>
        ) : (
          <div className="diff-tabs" role="group" aria-label="Change set">
            <button
              type="button"
              aria-pressed={!showStaged}
              onClick={() => setShowStaged(false)}
            >
              Unstaged <span>{files.length}</span>
            </button>
            <button
              type="button"
              aria-pressed={showStaged}
              onClick={() => setShowStaged(true)}
            >
              Staged <span>{stagedFiles.length}</span>
            </button>
          </div>
        )}
        {!listOnly && !fileTarget && (
          <div
            className="diff-total"
            aria-label={`${totalAdd} added, ${totalDel} removed lines`}
          >
            <StatPill kind="add" value={totalAdd} />
            <StatPill kind="del" value={totalDel} />
          </div>
        )}
        <div className="diff-view-controls">
          {!listOnly && (
            <>
              <div
                className="diff-layout-control"
                role="group"
                aria-label="Diff layout"
              >
                <ToolbarButton
                  title="Unified view"
                  active={effectiveViewMode === "unified"}
                  onClick={() => setViewMode("unified")}
                >
                  <AlignJustifyIcon className="size-3.5" />
                  <span>Unified</span>
                </ToolbarButton>
                <ToolbarButton
                  title="Split view"
                  active={effectiveViewMode === "split"}
                  onClick={() => {
                    setViewMode("split")
                    if (diffStyle === "stacked")
                      void updateSettings({ diff_style: "auto" })
                  }}
                >
                  <SplitIcon className="size-3.5" />
                  <span>Split</span>
                </ToolbarButton>
              </div>
              <ToolbarButton
                className="diff-wrap-control"
                title={
                  diffWordWrap
                    ? "Disable diff wrapping"
                    : "Enable diff wrapping"
                }
                active={diffWordWrap}
                onClick={() => {
                  void updateSettings({ diff_word_wrap: !diffWordWrap })
                }}
              >
                <span>Wrap</span>
              </ToolbarButton>
            </>
          )}
          <ToolbarButton
            title="Refresh changes"
            disabled={loading}
            onClick={() => {
              void refresh()
            }}
          >
            <RefreshCwIcon className="size-3.5" />
          </ToolbarButton>
        </div>
      </div>
      {loadError && (
        <Alert variant="destructive" className="m-3 w-auto">
          <AlertTitle>Could not load changes</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      {listOnly && diffTruncated && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          Change list truncated. More changes may exist in this checkout.
        </p>
      )}
      <div
        ref={fileListResize.bodyRef}
        className="diff-panel-body"
        data-resizing={fileListResize.isResizing}
        style={
          {
            "--diff-file-list-width": `${fileListResize.width}px`,
          } as CSSProperties
        }
      >
        {fileListVisible && (
          <aside className="diff-file-list" aria-label="Changed files">
            <div className="diff-file-list-header">
              {!listOnly && fileListToggle}
              <div className="diff-filter">
                <SearchIcon className="size-3.5" aria-hidden="true" />
                <input
                  aria-label="Filter changed files"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Find a file..."
                />
              </div>
            </div>
            <ul>
              {filteredFiles.map((file) => {
                const selected = listOnly
                  ? Boolean(
                      cwd &&
                      selectedDiff &&
                      editorDiffKey(selectedDiff) ===
                        editorDiffKey({
                          cwd,
                          path: file.name,
                          source: showStaged ? "staged" : "unstaged",
                        })
                    )
                  : activeFile?.name === file.name
                const name = file.name.split("/").pop() || file.name
                const dir = file.name.includes("/")
                  ? file.name.slice(0, file.name.lastIndexOf("/"))
                  : ""
                return (
                  <li
                    key={file.name}
                    className="diff-file-row"
                    data-active={selected}
                  >
                    <button
                      type="button"
                      className="diff-file-select"
                      aria-current={selected ? "true" : undefined}
                      title={file.name}
                      onClick={() => {
                        if (onSelectDiff && cwd)
                          onSelectDiff(
                            {
                              cwd,
                              path: file.name,
                              source: showStaged ? "staged" : "unstaged",
                            },
                            true
                          )
                        else setSelectedFile(file.name)
                      }}
                      onDoubleClick={() => {
                        if (onSelectDiff && cwd)
                          onSelectDiff(
                            {
                              cwd,
                              path: file.name,
                              source: showStaged ? "staged" : "unstaged",
                            },
                            false
                          )
                        else openDiffFile(file)
                      }}
                    >
                      <img
                        src={getFileIconUrl(name)}
                        alt=""
                        className="size-4 shrink-0"
                      />
                      <span className="diff-file-label">
                        <span>{name}</span>
                        {dir && <small>{dir}</small>}
                      </span>
                      <span className="diff-file-stats">
                        <StatPill kind="add" value={file.additions} size="xs" />
                        <StatPill kind="del" value={file.deletions} size="xs" />
                      </span>
                      <StatusBadge
                        kind={
                          file.isNew ? "new" : file.isDeleted ? "del" : "mod"
                        }
                      />
                    </button>
                    <button
                      type="button"
                      className="diff-file-stage"
                      disabled={Boolean(loadError)}
                      aria-label={`${showStaged ? "Unstage" : "Stage"} ${file.name}`}
                      title={showStaged ? "Unstage file" : "Stage file"}
                      onClick={() => {
                        if (showStaged) void handleUnstageFile(file.name)
                        else void handleStageFile(file.name)
                      }}
                    >
                      {showStaged ? (
                        <MinusIcon className="size-3.5" />
                      ) : (
                        <PlusIcon className="size-3.5" />
                      )}
                    </button>
                  </li>
                )
              })}
              {!filteredFiles.length && (
                <li className="diff-no-matches" role="status">
                  {loading
                    ? "Loading changes…"
                    : loadError
                      ? "Changes are unavailable."
                      : filter.trim()
                        ? "No files match your search."
                        : showStaged
                          ? "Nothing staged yet."
                          : "Working tree is clean."}
                </li>
              )}
            </ul>
            <div className="diff-file-count">
              {filter.trim() ? `${filteredFiles.length} of ` : ""}
              {displayFiles.length} file{displayFiles.length !== 1 && "s"}{" "}
              changed
            </div>
          </aside>
        )}
        {fileListVisible && !listOnly && (
          <div
            className="diff-file-list-resizer"
            {...fileListResize.handleProps}
          />
        )}
        {!listOnly && (
          <div className="diff-main">
            {activeFile && (
              <div className="diff-file-header">
                {!fileListVisible && !fileTarget && fileListToggle}
                <img
                  src={getFileIconUrl(activeFileName ?? "")}
                  alt=""
                  className="size-4 shrink-0"
                />
                <div className="diff-active-path" title={activeFile.name}>
                  <span>{activeFileName}</span>
                  {activeFileDir && <small>{activeFileDir.slice(0, -1)}</small>}
                </div>
                <div className="diff-header-stats">
                  <StatPill kind="add" value={activeFile.additions} />
                  <StatPill kind="del" value={activeFile.deletions} />
                </div>
                <span className="diff-hunk-count">
                  {activeFile.hunks.length} change
                  {activeFile.hunks.length !== 1 && "s"}
                </span>
                <div className="diff-header-actions">
                  {activeFile.hunks.length > 0 && (
                    <ToolbarButton
                      title={
                        allCollapsed ? "Expand all hunks" : "Collapse all hunks"
                      }
                      onClick={toggleAllHunks}
                    >
                      {allCollapsed ? (
                        <ChevronsUpDownIcon className="size-3.5" />
                      ) : (
                        <ChevronsDownUpIcon className="size-3.5" />
                      )}
                    </ToolbarButton>
                  )}
                  <ToolbarButton
                    title={
                      activeFile.isDeleted
                        ? "Deleted files cannot be opened"
                        : "Open file in editor"
                    }
                    disabled={activeFile.isDeleted}
                    onClick={() => openDiffFile(activeFile)}
                  >
                    <FileCode2Icon className="size-3.5" />
                  </ToolbarButton>
                  <ToolbarButton
                    title="Copy diff to clipboard"
                    onClick={copyDiff}
                  >
                    {copied ? (
                      <CheckIcon className="size-3.5 text-success" />
                    ) : (
                      <CopyIcon className="size-3.5" />
                    )}
                  </ToolbarButton>
                </div>
              </div>
            )}
            <div className="diff-scroll" tabIndex={0} aria-label="Code diff">
              {hunkConflict && (
                <Alert variant="destructive" className="m-3 w-auto">
                  <AlertTitle>Diff changed</AlertTitle>
                  <AlertDescription>{hunkConflict}</AlertDescription>
                </Alert>
              )}
              {diffTruncated && (
                <Alert className="m-3 w-auto">
                  <AlertTitle>Diff truncated</AlertTitle>
                  <AlertDescription>
                    This change set is too large to display in full. Actions
                    apply to the visible hunks; review the complete diff in the
                    terminal.
                  </AlertDescription>
                </Alert>
              )}
              {!activeFile && loading && (
                <div className="diff-empty" role="status">
                  <RefreshCwIcon className="size-5" />
                  <p>Loading changes...</p>
                </div>
              )}
              {!activeFile && !loading && !loadError && (
                <div className="diff-empty">
                  <div className="diff-empty-icon">
                    {showStaged ? (
                      <FileDiffIcon className="size-6" />
                    ) : (
                      <CheckIcon className="size-6" />
                    )}
                  </div>
                  <h3>
                    {fileTarget
                      ? diffTruncated
                        ? "File not in the displayed diff"
                        : "No changes in this comparison"
                      : showStaged
                        ? "Nothing staged yet"
                        : "Working tree is clean"}
                  </h3>
                  <p>
                    {fileTarget
                      ? `${fileTarget.path} has no displayed ${showStaged ? "staged" : "unstaged"} changes.`
                      : showStaged
                        ? "Stage changes to prepare your next commit."
                        : "Your local changes will appear here."}
                  </p>
                  {!fileTarget && showStaged && files.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowStaged(false)}
                    >
                      View unstaged changes
                    </Button>
                  )}
                </div>
              )}
              {activeFile?.isBinary ? (
                <div className="diff-empty">
                  <FileDiffIcon className="size-6" />
                  <h3>Binary file changed</h3>
                  <p>This file has no text diff.</p>
                </div>
              ) : (
                activeFile?.hunks.map((hunk, index) => {
                  const key = `${activeFile.name}:${index}`
                  const collapsed = collapsedHunks.has(key)
                  return (
                    <div key={key} className="diff-hunk">
                      <div className="diff-hunk-header">
                        <button
                          type="button"
                          className="diff-hunk-toggle"
                          aria-expanded={!collapsed}
                          aria-label={`${collapsed ? "Expand" : "Collapse"} change ${index + 1}`}
                          title={hunk.header}
                          onClick={() => toggleHunk(key)}
                        >
                          <ChevronDownIcon
                            className={cn(
                              "size-3.5 shrink-0",
                              collapsed && "-rotate-90"
                            )}
                          />
                          <span>Change {index + 1}</span>
                          <small>Line {hunk.newStart || hunk.oldStart}</small>
                        </button>
                        <div className="diff-hunk-actions">
                          {showStaged ? (
                            <button
                              type="button"
                              disabled={
                                pendingHunkAction !== null || Boolean(loadError)
                              }
                              onClick={() => {
                                void handleHunkAction(
                                  activeFile.name,
                                  hunk,
                                  index,
                                  "unstage"
                                )
                              }}
                              title="Move this change back to unstaged files"
                            >
                              <Undo2Icon className="size-3.5" />
                              Unstage
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={
                                  pendingHunkAction !== null ||
                                  Boolean(loadError)
                                }
                                onClick={() => {
                                  void handleHunkAction(
                                    activeFile.name,
                                    hunk,
                                    index,
                                    "accept"
                                  )
                                }}
                                title="Accept and stage this change"
                              >
                                <CheckIcon className="size-3.5" />
                                Stage
                              </button>
                              <button
                                type="button"
                                className="diff-discard"
                                disabled={
                                  pendingHunkAction !== null ||
                                  Boolean(loadError)
                                }
                                onClick={() => {
                                  void handleHunkAction(
                                    activeFile.name,
                                    hunk,
                                    index,
                                    "reject"
                                  )
                                }}
                                title="Discard this change and restore the original"
                              >
                                <XIcon className="size-3.5" />
                                Discard
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {!collapsed && (
                        <>
                          {effectiveViewMode === "split" && (
                            <div className="diff-revision-labels">
                              <span>Original</span>
                              <span>
                                {showStaged ? "Staged" : "Working tree"}
                              </span>
                            </div>
                          )}
                          <DiffHunkLines
                            hunk={hunk}
                            mode={effectiveViewMode}
                            wrap={diffWordWrap}
                            syntax={syntax}
                          />
                        </>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
