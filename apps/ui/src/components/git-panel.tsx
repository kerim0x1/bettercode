import { useState, useEffect, useCallback } from "react"
import { cn } from "@/lib/utils"
import { useEditorStore } from "@/lib/editor-store"
import { resolveWorkspaceFilePath } from "@/lib/editor-path"
import { SearchIcon } from "lucide-react"
import { BranchesSection } from "./git-panel/branches-section"
import { ChangesSection } from "./git-panel/changes-section"
import { CommitBox } from "./git-panel/commit-box"
import {
  filterChangedFiles,
  type GitFileSource,
  type GitPanelTab,
} from "./git-panel/git-panel-utils"
import {
  GitConfirmDialog,
  GitLoadingState,
  GitNotRepositoryState,
} from "./git-panel/git-panel-states"
import { HistorySection } from "./git-panel/history-section"
import {
  RemoteErrorAlert,
  RemoteSyncSection,
} from "./git-panel/remote-sync-section"
import {
  EditorGitHeader,
  GitViewTabs,
  RepositorySummary,
} from "./git-panel/repository-header"
import { useGitActions } from "./git-panel/use-git-actions"
import { useGitRepoState } from "./git-panel/use-git-repo-state"
import { PullRequestSection } from "./git-panel/pull-request-section"
import "./diff-panel.css"
import "./git-panel.css"

/**
 * Source control for one folder. Data comes from `useGitRepoState` (status,
 * diff stats, branches, log), actions from `useGitActions`; the sections in
 * `./git-panel/` render them. This component owns only the view state: the
 * active tab, the file filter and which file groups are expanded.
 */
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
  const {
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
  } = useGitRepoState(cwd)
  const {
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
  } = useGitActions({
    cwd,
    status,
    refresh,
    refreshBranches,
    syncActiveThreadBranch,
    setCurrentBranch,
    applyFetchedStatus,
  })
  const [fileFilter, setFileFilter] = useState("")
  const [stagedOpen, setStagedOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(true)
  const [untrackedOpen, setUntrackedOpen] = useState(true)

  // Tabs: changes | log | branches
  const [activeTab, setActiveTab] = useState<GitPanelTab>("changes")

  // Load branches and log when their tabs become active
  useEffect(() => {
    if (activeTab === "branches" && isRepo) refreshBranches()
    if (activeTab === "log" && isRepo) refreshLog()
  }, [activeTab, isRepo, refreshBranches, refreshLog])

  const openFile = useCallback(
    (filePath: string, source: GitFileSource = "unstaged") => {
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

  if (isRepo === false) {
    return <GitNotRepositoryState isAgent={isAgent} onInitialize={handleInit} />
  }

  if (isRepo === null || !status) {
    return <GitLoadingState isAgent={isAgent} />
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

  const filterEnabled = appMode === "editor" || isAgent
  const visibleFiles = (files: string[]) =>
    filterChangedFiles(files, fileFilter, filterEnabled)
  const visibleCount = visibleFiles([
    ...status.staged,
    ...status.modified,
    ...status.untracked,
  ]).length
  const repositorySummary = (
    <RepositorySummary
      isAgent={isAgent}
      status={status}
      totalChanges={totalChanges}
      totalAdditions={totalAdditions}
      totalDeletions={totalDeletions}
      onRefresh={refresh}
    />
  )
  const tabs = (
    <GitViewTabs
      isAgent={isAgent}
      activeTab={activeTab}
      totalChanges={totalChanges}
      onTabChange={setActiveTab}
      onRefresh={refresh}
    />
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
        <EditorGitHeader
          status={status}
          totalChanges={totalChanges}
          totalAdditions={totalAdditions}
          totalDeletions={totalDeletions}
          onManageBranches={() => setActiveTab("branches")}
          onRefresh={refresh}
        />
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
        <CommitBox
          stagedCount={status.staged.length}
          totalChanges={totalChanges}
          commitMsg={commitMsg}
          commitError={commitError}
          isCommitting={isCommitting}
          isGeneratingCommit={isGeneratingCommit}
          wrapActions={appMode === "editor" || isAgent}
          onCommitMsgChange={setCommitMsg}
          onCommitErrorChange={setCommitError}
          onCommit={handleCommit}
          onGenerateCommitMessage={handleGenerateCommitMessage}
          onStash={handleStash}
        />
        <RemoteSyncSection
          status={status}
          isPushing={isPushing}
          isPulling={isPulling}
          isCommitting={isCommitting}
          isFetching={isFetching}
          lastFetchedAt={lastFetchedAt}
          onFetch={handleFetch}
          onPush={handlePush}
          onPull={handlePull}
        />
        {remoteError && (
          <RemoteErrorAlert
            error={remoteError}
            onDismiss={() => setRemoteError(null)}
          />
        )}
        <PullRequestSection
          cwd={cwd}
          status={status}
          totalChanges={totalChanges}
          commitMessage={commitMsg}
          busy={isCommitting || isPushing || isPulling}
          onCommitted={() => {
            setCommitMsg("")
            void refresh()
          }}
        />
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
          <ChangesSection
            staged={visibleFiles(status.staged)}
            modified={visibleFiles(status.modified)}
            untracked={visibleFiles(status.untracked)}
            stagedTotal={status.staged.length}
            totalChanges={totalChanges}
            visibleCount={visibleCount}
            diffStats={diffStats}
            editorMode={appMode === "editor"}
            showFilterEmptyState={
              (appMode === "editor" || isAgent) && Boolean(fileFilter)
            }
            stagedOpen={stagedOpen}
            onStagedOpenChange={setStagedOpen}
            changesOpen={changesOpen}
            onChangesOpenChange={setChangesOpen}
            untrackedOpen={untrackedOpen}
            onUntrackedOpenChange={setUntrackedOpen}
            onOpenFile={openFile}
            onStageAll={handleStageAll}
            onUnstageAll={handleUnstageAll}
            onStashPop={handleStashPop}
            onStageFile={handleStageFile}
            onUnstageFile={handleUnstageFile}
            onDiscard={handleDiscard}
          />
        )}

        {activeTab === "log" && <HistorySection logEntries={logEntries} />}

        {activeTab === "branches" && (
          <BranchesSection
            branches={branches}
            currentBranch={currentBranch}
            newBranchName={newBranchName}
            onNewBranchNameChange={setNewBranchName}
            onCreateBranch={handleCreateBranch}
            onCheckout={handleCheckout}
          />
        )}
      </div>

      {isAgent && activeTab === "changes" && (
        <div className="diff-file-count">
          {fileFilter.trim() ? `${visibleCount} of ` : ""}
          {totalChanges} file{totalChanges !== 1 && "s"} changed
        </div>
      )}

      {/* Confirm dialog */}
      <GitConfirmDialog
        confirmAction={confirmAction}
        onClose={() => setConfirmAction(null)}
      />
    </div>
  )
}
