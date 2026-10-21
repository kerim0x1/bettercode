import { runEditorSave } from "@/lib/editor-save"
import { useMemo } from "react"
import {
  FilesIcon,
  FolderOpenIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PinIcon,
  SaveIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react"
import { EditorFileSection } from "./editor-file-section"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { confirmCloseDirtyEditorTabs } from "@/lib/editor-close-confirmation"
import {
  buildEditorRecentFileItems,
  type EditorRecentFileItem,
} from "@/lib/editor-recent-files"
import { useEditorStore, type EditorTab } from "@/lib/editor-store"
import { dispatchEditorGotoLine } from "@/lib/editor-go-to-line"
import { dispatchEditorRevealFile } from "@/lib/editor-reveal-event"
import { relativeEditorPath } from "@/lib/editor-path"
import { getFileIconUrl } from "@/lib/file-icons"
import { editorDiffLabel } from "@/lib/editor-diff"
import { cn } from "@/lib/utils"

const actionClass =
  "flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline focus-visible:outline-ring"

function FileLabel({
  fileName,
  relativePath,
  preview = false,
}: {
  fileName: string
  relativePath: string
  preview?: boolean
}) {
  const directory = relativePath
    .replace(/\\/g, "/")
    .split("/")
    .slice(0, -1)
    .join("/")
  return (
    <>
      <img
        src={getFileIconUrl(fileName)}
        alt=""
        className="size-[18px] shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[13px]", preview && "italic")}>
          {fileName}
        </span>
        {directory && (
          <span className="block truncate text-[10px] text-muted-foreground/70">
            {directory}
          </span>
        )}
        {preview && <span className="sr-only">Preview editor</span>}
      </span>
    </>
  )
}

export function EditorRecentFilesList({
  projectPath,
}: {
  projectPath: string
}) {
  const tabs = useEditorStore((state) => state.tabs)
  const recentFiles = useEditorStore((state) => state.recentFiles)
  const items = useMemo(
    () =>
      buildEditorRecentFileItems({ projectPath, tabs, recentFiles, limit: 6 }),
    [projectPath, tabs, recentFiles]
  )

  const openRecentFile = async (item: EditorRecentFileItem) => {
    await useEditorStore.getState().openFile(item.filePath, {
      line: item.line,
      column: item.column,
      // Its own tab, like a click in the file tree.
      preview: false,
    })
    dispatchEditorGotoLine(
      {
        filePath: item.filePath,
        line: item.line,
        column: item.column,
        preserveNavigation: true,
      },
      { defer: true }
    )
  }

  return (
    <EditorFileSection
      sectionId="recent-files"
      title="Recent Files"
      icon={HistoryIcon}
      count={items.length}
    >
      {items.length === 0 ? (
        <p className="px-4 pb-3 text-[11px] text-muted-foreground/70">
          Recently closed files appear here.
        </p>
      ) : (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
          {items.map((item) => (
            <li key={item.filePath}>
              <button
                type="button"
                onClick={() => void openRecentFile(item)}
                title={`${item.relativePath}:${item.line}:${item.column}`}
                className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline focus-visible:outline-ring"
              >
                <FileLabel
                  fileName={item.fileName}
                  relativePath={item.relativePath}
                />
                <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
                  Ln {item.line}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </EditorFileSection>
  )
}

export function EditorOpenEditorsList({
  projectPath,
}: {
  projectPath: string
}) {
  const tabs = useEditorStore((state) => state.tabs)
  const activeTabId = useEditorStore((state) => state.activeTabId)
  const recentlyClosedCount = useEditorStore(
    (state) => state.recentlyClosedTabs.length
  )
  const dirtyCount = tabs.filter((tab) => tab.isDirty).length
  const closableTabs = tabs.filter((tab) => !tab.isPinned)
  const closeFile = (tab: EditorTab) => {
    if (confirmCloseDirtyEditorTabs([tab], "closing this editor"))
      useEditorStore.getState().closeTab(tab.id)
  }
  const closeAllFiles = () => {
    if (confirmCloseDirtyEditorTabs(closableTabs, "closing all editors"))
      useEditorStore.getState().closeAllTabs()
  }

  return (
    <EditorFileSection
      sectionId="open-files"
      title="Open Files"
      icon={FilesIcon}
      count={tabs.length}
      modifiedCount={dirtyCount}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={actionClass}
              aria-label="Open Files actions"
              title="Open Files actions"
            >
              <MoreHorizontalIcon className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              disabled={dirtyCount === 0}
              onSelect={() =>
                void runEditorSave(() =>
                  useEditorStore.getState().saveAllTabs()
                )
              }
            >
              <SaveIcon />
              Save all modified files
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={recentlyClosedCount === 0}
              onSelect={() => void useEditorStore.getState().reopenClosedTab()}
            >
              <Undo2Icon />
              Reopen closed file
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!closableTabs.some((tab) => !tab.isDirty)}
              onSelect={() => useEditorStore.getState().closeSavedTabs()}
            >
              <XIcon />
              Close saved files
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={closableTabs.length === 0}
              onSelect={closeAllFiles}
            >
              <XIcon />
              Close all unpinned files
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {tabs.length === 0 ? (
        <p className="px-4 pb-3 text-[11px] text-muted-foreground/70">
          Open a file from the explorer.
        </p>
      ) : (
        <ul className="max-h-52 space-y-0.5 overflow-y-auto px-1.5 pb-1.5">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId
            const relativePath = relativeEditorPath(projectPath, tab.filePath)
            return (
              <li
                key={tab.id}
                className={cn(
                  "group flex min-h-10 min-w-0 items-center rounded-md transition-colors",
                  active
                    ? "bg-muted/70 text-foreground"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                )}
              >
                <button
                  type="button"
                  onClick={() => useEditorStore.getState().setActiveTab(tab.id)}
                  aria-current={active ? "page" : undefined}
                  title={relativePath}
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left focus-visible:outline focus-visible:outline-ring"
                >
                  <FileLabel
                    fileName={tab.fileName}
                    relativePath={relativePath}
                    preview={tab.isPreview}
                  />
                  {tab.diff && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {editorDiffLabel(tab.diff)}
                    </span>
                  )}
                  {tab.isPinned && (
                    <span role="img" aria-label="Pinned file">
                      <PinIcon
                        aria-hidden="true"
                        className="size-3 text-muted-foreground"
                      />
                    </span>
                  )}
                  {tab.isDirty && (
                    <span
                      role="img"
                      aria-label="Unsaved changes"
                      className="size-1.5 shrink-0 rounded-full bg-warning"
                    />
                  )}
                </button>
                <div
                  className={cn(
                    "flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
                    active && "opacity-100"
                  )}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={actionClass}
                        aria-label={`Actions for ${tab.fileName}`}
                        title="File actions"
                      >
                        <MoreHorizontalIcon className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuCheckboxItem
                        checked={!!tab.isPinned}
                        onCheckedChange={() =>
                          useEditorStore.getState().togglePinTab(tab.id)
                        }
                      >
                        <PinIcon />
                        Pinned
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuItem
                        onSelect={() => dispatchEditorRevealFile(tab.filePath)}
                      >
                        <FolderOpenIcon />
                        Reveal in Explorer
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    type="button"
                    className={actionClass}
                    aria-label={`Close ${tab.fileName}`}
                    title={
                      tab.isDirty
                        ? "Close unsaved file"
                        : tab.isPinned
                          ? "Close pinned file"
                          : "Close file"
                    }
                    onClick={() => closeFile(tab)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </EditorFileSection>
  )
}
