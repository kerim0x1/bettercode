import { FileSection } from "./file-section"
import type { FileDiffStats, GitFileSource } from "./git-panel-utils"

/**
 * The "changes" tab: bulk stage/unstage/pop-stash actions and the staged,
 * modified and untracked file groups (already narrowed by the file filter).
 */
export function ChangesSection({
  staged,
  modified,
  untracked,
  stagedTotal,
  totalChanges,
  visibleCount,
  diffStats,
  editorMode,
  showFilterEmptyState,
  stagedOpen,
  onStagedOpenChange,
  changesOpen,
  onChangesOpenChange,
  untrackedOpen,
  onUntrackedOpenChange,
  onOpenFile,
  onStageAll,
  onUnstageAll,
  onStashPop,
  onStageFile,
  onUnstageFile,
  onDiscard,
}: {
  /** Visible staged files. */
  staged: string[]
  /** Visible modified files. */
  modified: string[]
  /** Visible untracked files. */
  untracked: string[]
  /** All staged files, filtered or not. */
  stagedTotal: number
  totalChanges: number
  visibleCount: number
  diffStats: Record<string, FileDiffStats>
  editorMode: boolean
  /** A filter is active in a mode that has one; say when nothing matches. */
  showFilterEmptyState: boolean
  /** Group expansion lives in the panel so it survives switching tabs. */
  stagedOpen: boolean
  onStagedOpenChange: (open: boolean) => void
  changesOpen: boolean
  onChangesOpenChange: (open: boolean) => void
  untrackedOpen: boolean
  onUntrackedOpenChange: (open: boolean) => void
  onOpenFile: (filePath: string, source?: GitFileSource) => void
  onStageAll: () => void
  onUnstageAll: () => void
  onStashPop: () => void
  onStageFile: (file: string) => void
  onUnstageFile: (file: string) => void
  onDiscard: (file: string) => void
}) {
  return (
    <>
      {/* Stage All / Unstage All — bordered so they read as actions;
          as bare text they looked like stray labels. */}
      {totalChanges > 0 && (
        <div className="git-bulk-actions flex items-center gap-0.5 px-2 py-1">
          <button
            type="button"
            onClick={onStageAll}
            className="git-bulk-button rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            Stage All
          </button>
          {stagedTotal > 0 && (
            <button
              type="button"
              onClick={onUnstageAll}
              className="git-bulk-button rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              Unstage All
            </button>
          )}
          <button
            type="button"
            onClick={onStashPop}
            className="git-bulk-button ml-auto rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            Pop Stash
          </button>
        </div>
      )}

      {staged.length > 0 && (
        <FileSection
          title="Staged Changes"
          count={staged.length}
          open={stagedOpen}
          onOpenChange={onStagedOpenChange}
          files={staged}
          editorMode={editorMode}
          statusChar="A"
          diffStats={diffStats}
          onFileClick={(file) => onOpenFile(file, "staged")}
          onUnstage={onUnstageFile}
        />
      )}

      {modified.length > 0 && (
        <FileSection
          title="Changes"
          count={modified.length}
          open={changesOpen}
          onOpenChange={onChangesOpenChange}
          files={modified}
          editorMode={editorMode}
          statusChar="M"
          diffStats={diffStats}
          onFileClick={onOpenFile}
          onDiscard={onDiscard}
          onStage={onStageFile}
        />
      )}

      {untracked.length > 0 && (
        <FileSection
          title="Untracked"
          count={untracked.length}
          open={untrackedOpen}
          onOpenChange={onUntrackedOpenChange}
          files={untracked}
          editorMode={editorMode}
          statusChar="U"
          diffStats={diffStats}
          onFileClick={(file) => onOpenFile(file, null)}
          onStage={onStageFile}
        />
      )}

      {showFilterEmptyState && visibleCount === 0 && (
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
  )
}
