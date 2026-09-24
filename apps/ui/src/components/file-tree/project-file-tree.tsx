import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { FileAddIcon, FolderAddIcon } from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import { getFolderIconUrl } from "@/lib/file-icons"
import { useConfirm } from "@/components/dialogs/confirm-provider"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { getThreadStream, useChatStore } from "@/lib/chat-store"
import { confirmCloseDirtyEditorTabs } from "@/lib/editor-close-confirmation"
import { useEditorStore } from "@/lib/editor-store"
import {
  deleteWorkspacePath,
  moveWorkspacePath,
  searchEntriesDetailed,
  type WorkspaceSearchEntry,
} from "@/services/backend"
import { SearchTruncationNotice } from "@/components/search-truncation-notice"
import { searchTruncationMessage } from "@/lib/search-truncation"
import { InlineCreateInput } from "@/components/file-tree/inline-create-input"
import { createTreeEntry, treeCreateErrorMessage } from "@/lib/file-tree-create"
import { toast } from "@/lib/toast"
import {
  FileTreeNode,
  type FileTreeOpenOptions,
  type TreeEntry,
} from "@/components/file-tree/file-tree-node"
import { useVisibilityInterval } from "@/hooks/use-visibility-interval"
import { useFileTreeDragDrop } from "@/hooks/use-file-tree-drag-drop"
import {
  type FileTreeMove,
  resolveFileTreeMove,
  fileTreeMoveError,
} from "@/lib/file-tree-move"
import {
  editorPathAncestors,
  isAbsoluteEditorPath,
  isEditorPathEqualOrInside,
  normalizeEditorPath,
  rebaseEditorPath,
  resolveWorkspaceFilePath,
  workspaceRelativeEditorPath,
} from "@/lib/editor-path"
import {
  EDITOR_REVEAL_FILE_EVENT,
  type EditorRevealFileEventDetail,
} from "@/lib/editor-reveal-event"
import { resolveFileTreeRevealTarget } from "@/lib/file-tree-reveal"
import { listDirectoryFs } from "@/services/backend/filesystem"
import {
  mergeProjectTreeChildren,
  projectDirectoryEntries,
} from "@/lib/project-file-tree-data"

/**
 * Group the flat `{path, name, is_dir}` list returned by `/workspace/search`
 * into a nested tree that {@link FileTreeNode} can render recursively.
 *
 * The backend's walk emits every directory it visits *and* its children
 * (with project-relative, forward-slash paths), so we have all the parent
 * nodes available — we just attach each entry to its immediate parent by
 * path. Entries whose parent wasn't returned (e.g. `.gitignore` filtered
 * the parent for some reason) surface as roots so they remain visible
 * instead of disappearing.
 *
 * Children are sorted folders-first, then alphabetical case-insensitive,
 * matching VS Code / file-explorer conventions.
 */
function buildTree(flat: readonly WorkspaceSearchEntry[]): TreeEntry[] {
  const byPath = new Map<string, TreeEntry>()
  for (const e of flat) {
    byPath.set(e.path, {
      name: e.name,
      path: e.path,
      type: e.is_dir ? "folder" : "file",
      children: e.is_dir ? [] : undefined,
    })
  }

  const roots: TreeEntry[] = []
  for (const node of byPath.values()) {
    const sepIdx = node.path.lastIndexOf("/")
    if (sepIdx < 0) {
      roots.push(node)
      continue
    }
    const parentPath = node.path.slice(0, sepIdx)
    const parent = byPath.get(parentPath)
    if (parent?.children) {
      parent.children.push(node)
    } else {
      // Parent missing (orphan) — surface at root so the file is still reachable.
      roots.push(node)
    }
  }

  const sortNodes = (nodes: TreeEntry[]): void => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    })
    for (const n of nodes) {
      if (n.children) sortNodes(n.children)
    }
  }
  sortNodes(roots)
  return roots
}

function toProjectTreePath(
  projectPath: string,
  targetPath: string
): string | null {
  return (
    resolveFileTreeRevealTarget(projectPath, targetPath)?.relativePath ?? null
  )
}

function toProjectRelativeCopyPath(
  projectPath: string,
  targetPath: string
): string {
  return (
    workspaceRelativeEditorPath(projectPath, targetPath) ??
    (isAbsoluteEditorPath(targetPath)
      ? normalizeEditorPath(targetPath)
      : normalizeEditorPath(targetPath).replace(/^\/+/, ""))
  )
}

function splitTreeEntryPath(
  projectPath: string,
  entryPath: string
): { cwd: string; name: string } {
  const normalized = normalizeEditorPath(entryPath).replace(/\/+$/, "")
  const index = normalized.lastIndexOf("/")
  if (index < 0) {
    return { cwd: projectPath, name: normalized }
  }
  const parent = normalized.slice(0, index)
  return {
    cwd: resolveWorkspaceFilePath(projectPath, parent),
    name: normalized.slice(index + 1),
  }
}

/**
 * The entry count shown in the tree header. When the backend stopped its walk
 * early the number is a floor, not a total: it gets a trailing "+" and a
 * title that says why, so a 5,000-entry cap never reads as "this project has
 * exactly 5,000 files". Pure so the wording is testable without a DOM.
 */
export function fileTreeCountLabel(
  totalCount: number,
  truncation: { truncated: boolean; reason?: string }
): { text: string; title: string | undefined } {
  if (!truncation.truncated) {
    return { text: String(totalCount), title: undefined }
  }
  return {
    text: `${totalCount}+`,
    title: `Partial count — ${searchTruncationMessage({
      subject: "the workspace scan was",
      reason: truncation.reason,
      hint: "expand a folder to load the rest",
    })}`,
  }
}

/**
 * Top-level project file tree shown in the agent-mode right sidebar.
 *
 * Responsibilities kept in this component (vs. {@link FileTreeNode}):
 *  - Loading + caching the flat entry list from the backend
 *    (`searchEntriesDetailed`), including whether a cap cut that list short.
 *  - Owning the "creating" / "renaming" / "expanded" state so all descendants
 *    agree on what's in-flight without redux/store indirection.
 *  - Auto-refreshing the tree while the agent is streaming, since a turn may
 *    write new files (polling every 3s, plus an instant refresh on the
 *    custom `betterc0de:file-changed` event emitted from tool hooks).
 *
 * Collapsible state can be controlled (`open` + `onOpenChange`) or left
 * internal — the parent sidebar controls it so the tree stays open across
 * tab switches.
 */
export function ProjectFileTree({
  projectPath,
  open,
  onOpenChange,
  defaultOpen = false,
  openStorageKey,
  onFileSelect,
  completeRootListing = false,
}: {
  projectPath: string
  completeRootListing?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  openStorageKey?: string
  onFileSelect?: (path: string, options?: FileTreeOpenOptions) => void
}) {
  const confirm = useConfirm()
  const [entries, setEntries] = useState<TreeEntry[]>([])
  // `entries` is the *root level* after tree-building; for the header badge
  // we want the project-wide total (files + folders) so the count doesn't
  // collapse to "however many top-level entries exist".
  const [totalCount, setTotalCount] = useState(0)
  // Set when the backend stopped its walk early: the tree and the count are
  // then partial, and folders past the cut only fill in on expand.
  const [truncation, setTruncation] = useState<{
    truncated: boolean
    reason?: string
  }>({ truncated: false })
  const [internalOpen, setInternalOpen] = useState(() => {
    try {
      const saved = openStorageKey ? localStorage.getItem(openStorageKey) : null
      return saved === "closed" ? false : saved === "open" ? true : defaultOpen
    } catch {
      return defaultOpen
    }
  })
  const isOpen = open ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen
  useEffect(() => {
    if (!openStorageKey) return
    try {
      localStorage.setItem(openStorageKey, isOpen ? "open" : "closed")
    } catch {
      /* The workspace remains collapsible when storage is unavailable. */
    }
  }, [isOpen, openStorageKey])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const activeProjectPathRef = useRef(projectPath)
  activeProjectPathRef.current = projectPath
  const isStreaming = useChatStore(
    (s) => getThreadStream(s, s.activeThreadId).isStreaming
  )
  const activeEditorTab = useEditorStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId)
  )
  const selectedFilePath = activeEditorTab
    ? (toProjectTreePath(projectPath, activeEditorTab.filePath) ?? undefined)
    : undefined
  const treeContentRef = useRef<HTMLDivElement | null>(null)
  const revealResetTimerRef = useRef<number | null>(null)
  const refreshTree = useCallback(() => {
    if (!projectPath) return
    setLoadError(false)
    const requestedProjectPath = projectPath
    return Promise.all([
      searchEntriesDetailed(projectPath, ""),
      completeRootListing
        ? listDirectoryFs(projectPath, { showHidden: true })
        : Promise.resolve(null),
    ])
      .then(([data, root]) => {
        if (activeProjectPathRef.current !== requestedProjectPath) return
        const indexed = new Map(
          data.entries.map((entry) => [entry.path, entry])
        )
        // A capped recursive scan can miss entire root folders. Keep every
        // root reachable in the editor; expansion loads its children on demand.
        for (const entry of root?.entries ?? []) {
          if (entry.name === ".git" || entry.name === "node_modules") continue
          indexed.set(entry.name, {
            path: entry.name,
            name: entry.name,
            is_dir: entry.isDir,
          })
        }
        setEntries(buildTree([...indexed.values()]))
        setTotalCount(indexed.size)
        setTruncation({
          truncated: data.truncated || Boolean(root?.truncated),
          reason: data.truncatedReason,
        })
        setLoaded(true)
      })
      .catch(() => {
        if (activeProjectPathRef.current === requestedProjectPath) {
          setLoaded(true)
          setLoadError(true)
        }
      })
  }, [projectPath, completeRootListing])

  // ── Create / Rename state ──
  const [creating, setCreating] = useState<{
    parent: string
    type: "file" | "folder"
  } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [loadedDirectoryPaths, setLoadedDirectoryPaths] = useState<Set<string>>(
    new Set()
  )
  const [loadingDirectoryPaths, setLoadingDirectoryPaths] = useState<
    Set<string>
  >(new Set())
  const [failedDirectoryPaths, setFailedDirectoryPaths] = useState<Set<string>>(
    new Set()
  )
  const [revealedPath, setRevealedPath] = useState<string | null>(null)
  const moveInProgress = useRef(false)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)

  const expandPathSet = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return
    setExpandedPaths((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const path of paths) {
        if (!next.has(path)) {
          next.add(path)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const expandAncestors = useCallback(
    (relativePath: string) => expandPathSet(editorPathAncestors(relativePath)),
    [expandPathSet]
  )

  const flashRevealedPath = useCallback((relativePath: string) => {
    setRevealedPath(relativePath)
    if (revealResetTimerRef.current) {
      window.clearTimeout(revealResetTimerRef.current)
    }
    revealResetTimerRef.current = window.setTimeout(() => {
      setRevealedPath((current) => (current === relativePath ? null : current))
      revealResetTimerRef.current = null
    }, 1600)
  }, [])

  const scrollFileIntoView = useCallback((relativePath: string) => {
    if (typeof window === "undefined") return
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const rows = treeContentRef.current?.querySelectorAll<HTMLElement>(
          "[data-betterc0de-file-tree-path]"
        )
        const target = Array.from(rows ?? []).find(
          (row) => row.dataset.betterc0deFileTreePath === relativePath
        )
        target?.scrollIntoView({ block: "center" })
      })
    })
  }, [])

  const resolveTreeEntryPath = useCallback(
    (entryPath: string) => resolveWorkspaceFilePath(projectPath, entryPath),
    [projectPath]
  )

  const loadDirectory = useCallback(
    async (entryPath: string) => {
      const requestedProjectPath = projectPath
      setLoadingDirectoryPaths((current) => new Set(current).add(entryPath))
      setFailedDirectoryPaths((current) => {
        const next = new Set(current)
        next.delete(entryPath)
        return next
      })
      try {
        const listing = await listDirectoryFs(resolveTreeEntryPath(entryPath), {
          showHidden: true,
        })
        if (activeProjectPathRef.current !== requestedProjectPath) return
        const children = projectDirectoryEntries(projectPath, listing.entries)
        setEntries((current) =>
          mergeProjectTreeChildren(current, entryPath, children)
        )
        setLoadedDirectoryPaths((current) => new Set(current).add(entryPath))
      } catch {
        if (activeProjectPathRef.current === requestedProjectPath) {
          setFailedDirectoryPaths((current) => new Set(current).add(entryPath))
        }
      } finally {
        if (activeProjectPathRef.current === requestedProjectPath) {
          setLoadingDirectoryPaths((current) => {
            const next = new Set(current)
            next.delete(entryPath)
            return next
          })
        }
      }
    },
    [projectPath, resolveTreeEntryPath]
  )

  const toggleExpanded = useCallback(
    (entryPath: string) => {
      const isExpanding = !expandedPaths.has(entryPath)
      setExpandedPaths((current) => {
        const next = new Set(current)
        if (next.has(entryPath)) next.delete(entryPath)
        else next.add(entryPath)
        return next
      })
      if (
        isExpanding &&
        !loadedDirectoryPaths.has(entryPath) &&
        !loadingDirectoryPaths.has(entryPath)
      ) {
        void loadDirectory(entryPath)
      }
    },
    [expandedPaths, loadDirectory, loadedDirectoryPaths, loadingDirectoryPaths]
  )

  const relativeTreeEntryPath = useCallback(
    (entryPath: string) => toProjectRelativeCopyPath(projectPath, entryPath),
    [projectPath]
  )

  const expandDropDirectory = useCallback(
    (directory: string) => {
      setOpen(true)
      if (!directory) return
      expandPathSet([...editorPathAncestors(directory), directory])
      if (
        !loadedDirectoryPaths.has(directory) &&
        !loadingDirectoryPaths.has(directory)
      ) {
        void loadDirectory(directory)
      }
    },
    [
      setOpen,
      expandPathSet,
      loadedDirectoryPaths,
      loadingDirectoryPaths,
      loadDirectory,
    ]
  )

  const moveEntry = useCallback(
    async (move: FileTreeMove) => {
      if (moveInProgress.current) return
      const directory = move.toRelativePath.split("/").slice(0, -1).join("/")
      const validMove = resolveFileTreeMove(move.fromRelativePath, directory)
      if (!validMove || validMove.toRelativePath !== move.toRelativePath) return
      moveInProgress.current = true
      setMoving(true)
      setMoveError(null)
      const root = projectPath
      try {
        await moveWorkspacePath(
          root,
          move.fromRelativePath,
          move.toRelativePath
        )
        useEditorStore
          .getState()
          .handlePathMoved(
            resolveWorkspaceFilePath(root, move.fromRelativePath),
            resolveWorkspaceFilePath(root, move.toRelativePath)
          )
        if (activeProjectPathRef.current !== root) return
        setExpandedPaths(
          (current) =>
            new Set([
              ...Array.from(
                current,
                (path) =>
                  rebaseEditorPath(
                    path,
                    move.fromRelativePath,
                    move.toRelativePath
                  ) ?? path
              ),
              ...editorPathAncestors(move.toRelativePath),
            ])
        )
        setLoadedDirectoryPaths(new Set())
        setFailedDirectoryPaths(new Set())
        setOpen(true)
        await refreshTree()
        if (activeProjectPathRef.current !== root) return
        if (directory) await loadDirectory(directory)
        flashRevealedPath(move.toRelativePath)
        scrollFileIntoView(move.toRelativePath)
      } catch (error) {
        if (activeProjectPathRef.current === root) {
          setMoveError(fileTreeMoveError(error))
        }
      } finally {
        moveInProgress.current = false
        setMoving(false)
      }
    },
    [
      projectPath,
      setOpen,
      refreshTree,
      loadDirectory,
      flashRevealedPath,
      scrollFileIntoView,
    ]
  )

  const { dragState, dragHandlers } = useFileTreeDragDrop({
    projectPath,
    busy: moving || creating !== null || renaming !== null,
    onMove: (move) => {
      void moveEntry(move)
    },
    onExpand: expandDropDirectory,
  })

  const commitCreate = useCallback(
    async (name: string) => {
      if (!creating || !name.trim()) {
        setCreating(null)
        return
      }
      const trimmed = name.trim()
      const { parent, type } = creating
      const parentCwd = resolveTreeEntryPath(parent)
      setCreating(null)
      try {
        await createTreeEntry(parentCwd, trimmed, type)
        if (type === "file") {
          onFileSelect?.(resolveWorkspaceFilePath(parentCwd, trimmed), {
            preview: false,
          })
        }
        // Make sure the parent folder is expanded so the new item is visible
        setExpandedPaths((prev) => new Set(prev).add(parent))
        refreshTree()
      } catch (err) {
        console.error("[file-tree] create failed:", err)
        toast.error(`Could not create "${trimmed}"`, {
          description: treeCreateErrorMessage(err),
        })
      }
    },
    [creating, refreshTree, onFileSelect, resolveTreeEntryPath]
  )

  const startCreate = useCallback(
    (parent: string, type: "file" | "folder") => {
      setOpen(true)
      setCreating({ parent, type })
      setExpandedPaths((prev) => new Set(prev).add(parent))
    },
    [setOpen]
  )

  const commitRename = useCallback(
    async (oldPath: string, newName: string) => {
      if (!newName.trim()) {
        setRenaming(null)
        return
      }
      const trimmed = newName.trim()
      const { cwd, name: oldName } = splitTreeEntryPath(projectPath, oldPath)
      if (trimmed === oldName) {
        setRenaming(null)
        return
      }
      const oldAbsPath = resolveTreeEntryPath(oldPath)
      const newAbsPath = resolveWorkspaceFilePath(cwd, trimmed)
      setRenaming(null)
      try {
        await moveWorkspacePath(cwd, oldName, trimmed)
        useEditorStore.getState().handlePathMoved(oldAbsPath, newAbsPath)
        refreshTree()
      } catch (err) {
        console.error("[file-tree] rename failed:", err)
      }
    },
    [projectPath, refreshTree, resolveTreeEntryPath]
  )

  const handleDelete = useCallback(
    async (path: string, isFolder: boolean) => {
      const name = path.split(/[/\\]/).pop() || path
      const okToDelete = await confirm({
        title: `Delete ${isFolder ? "folder" : "file"}?`,
        description: `"${name}" will be permanently deleted.`,
        confirmLabel: "Delete",
        destructive: true,
      })
      if (!okToDelete) return
      const { cwd, name: target } = splitTreeEntryPath(projectPath, path)
      const absoluteTarget = resolveTreeEntryPath(path)
      const affectedTabs = useEditorStore
        .getState()
        .tabs.filter((tab) =>
          isEditorPathEqualOrInside(tab.filePath, absoluteTarget)
        )
      if (
        !confirmCloseDirtyEditorTabs(
          affectedTabs,
          `deleting this ${isFolder ? "folder" : "file"}`
        )
      )
        return
      try {
        await deleteWorkspacePath(cwd, target, isFolder)
        useEditorStore.getState().handlePathDeleted(absoluteTarget)
        refreshTree()
      } catch (err) {
        console.error("[file-tree] delete failed:", err)
      }
    },
    [confirm, projectPath, refreshTree, resolveTreeEntryPath]
  )

  // Initial load
  useEffect(() => {
    setLoaded(false)
    setEntries([])
    setTotalCount(0)
    setTruncation({ truncated: false })
    setExpandedPaths(new Set())
    setLoadedDirectoryPaths(new Set())
    setLoadingDirectoryPaths(new Set())
    setFailedDirectoryPaths(new Set())
    refreshTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])

  // Keep the active editor's parent folders expanded so the selection is
  // visible whenever the Explorer is open or gets mounted later.
  useEffect(() => {
    if (!selectedFilePath) return
    expandAncestors(selectedFilePath)
  }, [expandAncestors, selectedFilePath])

  // Poll every 3s while AI is streaming (creating/editing files). Pauses
  // automatically when the window is hidden so a streaming session in a
  // background tab / minimized window doesn't keep spinning the FS.
  useVisibilityInterval(refreshTree, 3000, { enabled: isStreaming })

  // Refresh once when streaming ends (turn completed)
  const prevStreaming = useRef(false)
  useEffect(() => {
    if (prevStreaming.current && !isStreaming) {
      setTimeout(refreshTree, 500)
    }
    prevStreaming.current = isStreaming
  }, [isStreaming, refreshTree])

  // Instant refresh when AI writes files (tool_result hook).
  useEffect(() => {
    const projectRoot = projectPath.replace(/\\/g, "/").toLowerCase()
    const onFileChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string }>).detail
      const changed = (detail?.path || "").replace(/\\/g, "/").toLowerCase()
      if (!changed || !changed.startsWith(projectRoot)) return
      refreshTree()
    }
    window.addEventListener(
      "betterc0de:file-changed",
      onFileChanged as EventListener
    )
    return () =>
      window.removeEventListener(
        "betterc0de:file-changed",
        onFileChanged as EventListener
      )
  }, [projectPath, refreshTree])

  useEffect(() => {
    return () => {
      if (revealResetTimerRef.current) {
        window.clearTimeout(revealResetTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const onRevealFile = (event: Event) => {
      const detail = (event as CustomEvent<EditorRevealFileEventDetail>).detail
      const targetPath = detail?.filePath ?? activeEditorTab?.filePath
      if (!targetPath) return
      const target = resolveFileTreeRevealTarget(projectPath, targetPath)
      if (!target) return
      setOpen(true)
      expandPathSet(target.ancestorPaths)
      flashRevealedPath(target.relativePath)
      scrollFileIntoView(target.relativePath)
    }
    window.addEventListener(
      EDITOR_REVEAL_FILE_EVENT,
      onRevealFile as EventListener
    )
    return () =>
      window.removeEventListener(
        EDITOR_REVEAL_FILE_EVENT,
        onRevealFile as EventListener
      )
  }, [
    activeEditorTab?.filePath,
    expandPathSet,
    flashRevealedPath,
    projectPath,
    scrollFileIntoView,
    setOpen,
  ])

  if (!projectPath || (!loaded && !completeRootListing)) return null

  const folderName =
    projectPath
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || "Project"
  const countLabel = fileTreeCountLabel(totalCount, truncation)

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setOpen}
      data-project-file-tree
      aria-busy={moving}
      {...dragHandlers}
    >
      <div
        data-file-tree-drop-target={
          dragState.targetDirectory === "" && !dragState.insertion
            ? "true"
            : undefined
        }
        className={cn(
          "sticky top-0 z-10 flex min-h-10 items-center rounded-md bg-sidebar",
          dragState.targetDirectory === "" &&
            !dragState.insertion &&
            "bg-sidebar-accent ring-1 ring-sidebar-ring ring-inset"
        )}
      >
        <CollapsibleTrigger
          type="button"
          aria-label={`Workspace: ${folderName}`}
          title={`${projectPath}\nDrop files or folders here to move them to the workspace root`}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-xs font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-ring"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
              isOpen && "rotate-90"
            )}
          />
          <img
            src={getFolderIconUrl(isOpen, projectPath, true)}
            alt=""
            draggable={false}
            className="size-[18px] shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{folderName}</span>
          {loaded && !loadError && (
            <span
              className="min-w-4 shrink-0 rounded bg-muted/45 px-1 text-center text-[10px] text-muted-foreground tabular-nums"
              title={countLabel.title}
            >
              {countLabel.text}
            </span>
          )}
        </CollapsibleTrigger>
        <div
          role="group"
          aria-label="Workspace file actions"
          className="flex shrink-0 items-center"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => startCreate(projectPath, "file")}
                aria-label="New file"
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline focus-visible:outline-ring"
              >
                <HugeiconsIcon
                  icon={FileAddIcon}
                  aria-hidden="true"
                  className="size-4 shrink-0"
                  strokeWidth={2}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New file</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => startCreate(projectPath, "folder")}
                aria-label="New folder"
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline focus-visible:outline-ring"
              >
                <HugeiconsIcon
                  icon={FolderAddIcon}
                  aria-hidden="true"
                  className="size-4 shrink-0"
                  strokeWidth={2}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New folder</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={refreshTree}
                aria-label="Refresh workspace files"
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline focus-visible:outline-ring"
              >
                <RefreshCwIcon aria-hidden="true" className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Refresh workspace files
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      {moving && (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          Moving…
        </p>
      )}
      {moveError && (
        <p role="alert" className="px-2 py-2 text-xs text-destructive">
          {moveError}
        </p>
      )}
      <CollapsibleContent>
        {!loaded ? (
          <p role="status" className="px-3 py-4 text-xs text-muted-foreground">
            Loading files…
          </p>
        ) : loadError ? (
          <div
            role="alert"
            className="space-y-2 px-3 py-4 text-xs text-muted-foreground"
          >
            <p>
              Could not load this folder. Check that it is available and
              accessible.
            </p>
            <button
              type="button"
              onClick={refreshTree}
              className="min-h-10 rounded-md border border-border px-3 text-foreground hover:bg-sidebar-accent"
            >
              Try again
            </button>
          </div>
        ) : null}
        <div ref={treeContentRef} className="text-[10.5px]">
          {creating?.parent === projectPath && (
            <InlineCreateInput
              type={creating.type}
              depth={0}
              onCommit={commitCreate}
              onCancel={() => setCreating(null)}
            />
          )}
          {loaded && !loadError && entries.length === 0 && !creating ? (
            <p className="px-1.5 py-1 text-[10px] text-muted-foreground/40">
              Empty folder
            </p>
          ) : (
            entries.map((entry) => (
              <FileTreeNode
                key={entry.path}
                item={entry}
                depth={0}
                expandedPaths={expandedPaths}
                loadingDirectoryPaths={loadingDirectoryPaths}
                failedDirectoryPaths={failedDirectoryPaths}
                toggleExpanded={toggleExpanded}
                selectedPath={selectedFilePath}
                revealedPath={revealedPath}
                dragState={dragState}
                onFileSelect={onFileSelect}
                creating={creating}
                renaming={renaming}
                onStartCreate={startCreate}
                onCommitCreate={commitCreate}
                onCancelCreate={() => setCreating(null)}
                onStartRename={setRenaming}
                onCommitRename={commitRename}
                onCancelRename={() => setRenaming(null)}
                onDelete={handleDelete}
                resolveEntryPath={resolveTreeEntryPath}
                relativeEntryPath={relativeTreeEntryPath}
              />
            ))
          )}
          <SearchTruncationNotice
            truncated={truncation.truncated}
            reason={truncation.reason}
            subject="Tree"
            hint="expand a folder to load the rest"
            className="px-1.5"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
