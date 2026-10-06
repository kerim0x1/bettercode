import { copyText } from "@/lib/clipboard"
import { useState } from "react"
import { ChevronRightIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { HugeiconsIcon } from "@hugeicons/react"
import { FileAddIcon, FolderAddIcon } from "@hugeicons/core-free-icons"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import type { FileTreeDragState } from "@/hooks/use-file-tree-drag-drop"
import { getFileIconUrl, getFolderIconUrl } from "@/lib/file-icons"
import { InlineCreateInput } from "@/components/file-tree/inline-create-input"
import {
  FolderContextMenu,
  type FolderContextAction,
} from "@/components/file-tree/folder-context-menu"

export interface TreeEntry {
  name: string
  path: string
  type: "file" | "folder"
  children?: TreeEntry[]
}

export interface FileTreeOpenOptions {
  preview?: boolean
}

/**
 * A single row in the file tree — folder or file — plus, for folders, the
 * recursive render of its children when expanded.
 *
 * The component is fully controlled: `expandedPaths`, `renaming`, and
 * `creating` all live in the parent tree component and are threaded back
 * in as props. That keeps sibling rows in sync (e.g. only one rename input
 * can be active at a time) without lifting any state into a global store.
 *
 * Hover actions (new file, new folder, rename, delete) appear on the right
 * edge of each row via `opacity-0 group-hover/row:opacity-100` so they
 * don't add visual noise to the default tree density.
 */
export function FileTreeNode({
  item,
  depth,
  expandedPaths,
  loadingDirectoryPaths,
  failedDirectoryPaths,
  moreDirectoryPaths,
  onLoadMore,
  toggleExpanded,
  selectedPath,
  revealedPath,
  dragState,
  onFileSelect,
  creating,
  renaming,
  onStartCreate,
  onCommitCreate,
  onCancelCreate,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
  resolveEntryPath,
  relativeEntryPath,
}: {
  item: TreeEntry
  depth: number
  expandedPaths: Set<string>
  loadingDirectoryPaths: Set<string>
  failedDirectoryPaths: Set<string>
  moreDirectoryPaths?: ReadonlySet<string>
  onLoadMore?: (path: string) => void
  toggleExpanded: (path: string) => void
  selectedPath?: string
  revealedPath?: string | null
  dragState?: FileTreeDragState
  onFileSelect?: (path: string, options?: FileTreeOpenOptions) => void
  creating: { parent: string; type: "file" | "folder" } | null
  renaming: string | null
  onStartCreate: (parent: string, type: "file" | "folder") => void
  onCommitCreate: (name: string) => void
  onCancelCreate: () => void
  onStartRename: (path: string) => void
  onCommitRename: (oldPath: string, newName: string) => void
  onCancelRename: () => void
  onDelete: (path: string, isFolder: boolean) => void
  resolveEntryPath: (path: string) => string
  relativeEntryPath: (path: string) => string
}) {
  const isFolder = item.type === "folder"
  const isExpanded = expandedPaths.has(item.path)
  const isSelected = !isFolder && selectedPath === item.path
  const isRevealed = revealedPath === item.path
  const isRenaming = renaming === item.path
  const indentPx = depth * 12 + 4
  const absolutePath = resolveEntryPath(item.path)
  const relativePath = relativeEntryPath(item.path)

  const handleRowClick = () => {
    if (isRenaming) return
    if (isFolder) toggleExpanded(item.path)
    else onFileSelect?.(item.path, { preview: true })
  }

  const handleRowDoubleClick = () => {
    if (isRenaming || isFolder) return
    onFileSelect?.(item.path, { preview: false })
  }

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  // Right-click → context menu. Suppressed during inline rename so the
  // user can still use the OS-native textbox context menu (cut/copy)
  // without our overlay stealing the click.
  const handleContextMenu = (e: React.MouseEvent) => {
    if (isRenaming) return
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  const copyToClipboard = (value: string) => {
    void copyText(value).catch((err) => {
      console.warn("[file-tree] copy path failed:", err)
    })
  }

  // Action set differs by entry type. Folders get an "Open in Editor
  // Mode" entry that spawns a secondary BrowserWindow scoped to that
  // folder's path; files don't (yet — open-in-window for files would
  // need a separate mode that boots into a single-file editor view).
  const ctxActions: FolderContextAction[] = []
  if (isFolder) {
    ctxActions.push({
      id: "open-in-editor",
      label: "Open in Editor Mode",
      icon: "open-external",
      hint: "Opens this folder in a new window in editor mode",
      onClick: () => {
        void window.electronAPI?.windowOpenWith?.({
          mode: "editor",
          cwd: absolutePath,
        })
      },
    })
  }
  ctxActions.push({
    id: "copy-relative-path",
    label: "Copy Relative Path",
    icon: "copy",
    hint: relativePath,
    onClick: () => copyToClipboard(relativePath),
  })
  ctxActions.push({
    id: "copy-path",
    label: "Copy Path",
    icon: "copy",
    hint: absolutePath,
    onClick: () => copyToClipboard(absolutePath),
  })
  ctxActions.push({
    id: "open-in-os",
    label: "Open in OS",
    icon: isFolder ? "folder-open" : "open-external",
    hint: isFolder
      ? "Open folder with system default"
      : "Open file with system default",
    onClick: () => {
      void window.electronAPI?.openPath?.(absolutePath).catch((err) => {
        console.warn("[file-tree] open path failed:", err)
      })
    },
  })
  ctxActions.push({
    id: "rename",
    label: "Rename",
    icon: "rename",
    onClick: () => onStartRename(item.path),
  })
  ctxActions.push({
    id: "delete",
    label: "Delete",
    icon: "delete",
    destructive: true,
    onClick: () => onDelete(item.path, isFolder),
  })

  return (
    <div>
      <FolderContextMenu
        position={ctxMenu}
        actions={ctxActions}
        onClose={() => setCtxMenu(null)}
      />
      <div
        className={cn(
          "group/row relative flex min-h-7 cursor-pointer items-center gap-1.5 rounded px-1 py-px transition-[background-color,box-shadow,color]",
          isSelected ? "bg-muted text-foreground" : "hover:bg-muted/50",
          dragState?.sourcePath === item.path && "opacity-50",
          isFolder &&
            !dragState?.insertion &&
            dragState?.targetDirectory === item.path &&
            "bg-sidebar-accent ring-1 ring-sidebar-ring ring-inset",
          isRevealed &&
            "bg-sidebar-accent text-sidebar-foreground shadow-[inset_2px_0_0_var(--sidebar-primary)] ring-1 ring-sidebar-ring/40"
        )}
        style={{ paddingLeft: indentPx }}
        onClick={handleRowClick}
        onDoubleClick={handleRowDoubleClick}
        onContextMenu={handleContextMenu}
        data-betterc0de-file-tree-path={item.path}
        data-betterc0de-file-tree-kind={item.type}
        data-file-tree-drop-target={
          isFolder &&
          !dragState?.insertion &&
          dragState?.targetDirectory === item.path
            ? "true"
            : undefined
        }
        draggable={!isRenaming && !creating}
        data-betterc0de-file-tree-selected={isSelected ? "true" : undefined}
        data-betterc0de-file-tree-revealed={isRevealed ? "true" : undefined}
        aria-current={isSelected ? "page" : undefined}
      >
        {dragState?.insertion?.path === item.path && (
          <span
            aria-hidden="true"
            data-file-tree-insertion={dragState.insertion.edge}
            className={cn(
              "pointer-events-none absolute right-1 z-20 h-0.5 rounded-full bg-sidebar-ring",
              dragState.insertion.edge === "before" ? "top-0" : "bottom-0"
            )}
            style={{ left: indentPx }}
          />
        )}
        {isFolder ? (
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/60 transition-transform 2xl:size-4",
              isExpanded && "rotate-90"
            )}
          />
        ) : (
          <span className="w-2.5 shrink-0" />
        )}
        {isFolder ? (
          <img
            src={getFolderIconUrl(isExpanded, item.path)}
            alt=""
            draggable={false}
            className="size-[18px] shrink-0 2xl:size-5"
          />
        ) : (
          <img
            src={getFileIconUrl(item.path)}
            alt=""
            draggable={false}
            className="size-[18px] shrink-0 2xl:size-5"
          />
        )}
        {isRenaming ? (
          <input
            type="text"
            autoFocus
            defaultValue={item.name}
            className="h-6 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1 text-xs outline-none 2xl:text-[13px]"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter") {
                e.preventDefault()
                onCommitRename(item.path, (e.target as HTMLInputElement).value)
              } else if (e.key === "Escape") {
                e.preventDefault()
                onCancelRename()
              }
            }}
            onFocus={(e) => {
              const v = e.target.value
              const dot = v.lastIndexOf(".")
              if (dot > 0) e.target.setSelectionRange(0, dot)
              else e.target.select()
            }}
            onBlur={(e) => {
              const v = e.target.value
              if (v.trim() && v !== item.name) onCommitRename(item.path, v)
              else onCancelRename()
            }}
          />
        ) : (
          <>
            <span className="flex-1 truncate text-xs leading-5 2xl:text-[13px]">
              {item.name}
            </span>
            <div
              className={cn(
                "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100",
                dragState?.sourcePath && "pointer-events-none invisible"
              )}
            >
              {isFolder && (
                <>
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground/60 hover:bg-muted/70 hover:text-foreground"
                    title="New file"
                    aria-label={`New file in ${item.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onStartCreate(item.path, "file")
                    }}
                  >
                    <HugeiconsIcon
                      icon={FileAddIcon}
                      aria-hidden="true"
                      className="size-3.5"
                      strokeWidth={2}
                    />
                  </button>
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground/60 hover:bg-muted/70 hover:text-foreground"
                    title="New folder"
                    aria-label={`New folder in ${item.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onStartCreate(item.path, "folder")
                    }}
                  >
                    <HugeiconsIcon
                      icon={FolderAddIcon}
                      aria-hidden="true"
                      className="size-3.5"
                      strokeWidth={2}
                    />
                  </button>
                </>
              )}
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground/60 hover:bg-muted/70 hover:text-foreground"
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation()
                  onStartRename(item.path)
                }}
              >
                <PencilIcon className="size-3" />
              </button>
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground/60 hover:bg-muted/70 hover:text-destructive"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(item.path, isFolder)
                }}
              >
                <Trash2Icon className="size-3" />
              </button>
            </div>
          </>
        )}
      </div>
      {isFolder && isExpanded && (
        <div>
          {creating?.parent === item.path && (
            <InlineCreateInput
              type={creating.type}
              depth={depth + 1}
              onCommit={onCommitCreate}
              onCancel={onCancelCreate}
            />
          )}
          {loadingDirectoryPaths.has(item.path) ? (
            <p
              className="py-1 text-[10px] text-muted-foreground/55"
              style={{ paddingLeft: indentPx + 28 }}
            >
              Loading folder…
            </p>
          ) : failedDirectoryPaths.has(item.path) ? (
            <p
              className="py-1 text-[10px] text-destructive/80"
              style={{ paddingLeft: indentPx + 28 }}
            >
              Could not load folder. Collapse and retry.
            </p>
          ) : item.children?.length === 0 ? (
            <p
              className="py-1 text-[10px] text-muted-foreground/45"
              style={{ paddingLeft: indentPx + 28 }}
            >
              Empty folder
            </p>
          ) : null}
          {item.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              item={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              loadingDirectoryPaths={loadingDirectoryPaths}
              failedDirectoryPaths={failedDirectoryPaths}
              moreDirectoryPaths={moreDirectoryPaths}
              onLoadMore={onLoadMore}
              toggleExpanded={toggleExpanded}
              selectedPath={selectedPath}
              revealedPath={revealedPath}
              dragState={dragState}
              onFileSelect={onFileSelect}
              creating={creating}
              renaming={renaming}
              onStartCreate={onStartCreate}
              onCommitCreate={onCommitCreate}
              onCancelCreate={onCancelCreate}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onDelete={onDelete}
              resolveEntryPath={resolveEntryPath}
              relativeEntryPath={relativeEntryPath}
            />
          ))}
          {moreDirectoryPaths?.has(item.path) && onLoadMore && (
            <Button
              variant="ghost"
              size="sm"
              className="my-1 w-full justify-start rounded-md text-[11px] text-muted-foreground"
              style={{ paddingLeft: indentPx + 28 }}
              disabled={loadingDirectoryPaths.has(item.path)}
              onClick={() => onLoadMore(item.path)}
              aria-label={`Load more files in ${item.name}`}
            >
              {loadingDirectoryPaths.has(item.path)
                ? "Loading more files…"
                : "Load more files"}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
