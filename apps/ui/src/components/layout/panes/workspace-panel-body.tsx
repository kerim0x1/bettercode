import { ErrorBoundary } from "@/components/error-boundary"
import { TerminalPanel } from "@/components/terminal-panel"
import { DiffPanel } from "@/components/diff-panel"
import { GitPanel } from "@/components/git-panel"
import { ProjectFileTree } from "@/components/file-tree/project-file-tree"
import { PlanListBody } from "@/components/layout/panes/plan-list-body"
import { NoFolderEmptyState } from "@/components/layout/panes/no-folder-empty-state"
import type { PaneTabKind } from "@/hooks/use-panes"
import type { SetPlanModalContent } from "@/lib/plan-modal"

/**
 * Renders one non-chat pane tab (terminal / plan / diff / files / git), bound
 * to the pane's own thread + projectPath. Each body is the existing standalone
 * component, just parameterized per-pane instead of reading global state.
 */
export function WorkspacePanelBody({
  kind,
  projectPath,
  threadId,
  setPlanModalContent,
  setEditingFile,
  onCloseToChat,
}: {
  kind: Exclude<PaneTabKind, "chat">
  projectPath: string | null | undefined
  threadId: string | null
  setPlanModalContent: SetPlanModalContent
  setEditingFile: (path: string) => void
  onCloseToChat: () => void
}) {
  // Plans are about the chat thread, not the folder — always available.
  if (kind === "plan") {
    return (
      <PlanListBody
        threadId={threadId}
        setPlanModalContent={setPlanModalContent}
      />
    )
  }

  if (!projectPath) return <NoFolderEmptyState />

  if (kind === "terminal") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ErrorBoundary label="Terminal">
          <TerminalPanel
            threadId={threadId}
            open
            onClose={onCloseToChat}
            cwd={projectPath}
            mode="agent"
            variant="fill"
          />
        </ErrorBoundary>
      </div>
    )
  }

  if (kind === "diff") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DiffPanel
          open
          onClose={onCloseToChat}
          cwd={projectPath}
          threadId={threadId}
        />
      </div>
    )
  }

  if (kind === "git") {
    return (
      <div className="h-full min-h-0">
        <ErrorBoundary label="Git">
          <GitPanel cwd={projectPath} appMode="agent" />
        </ErrorBoundary>
      </div>
    )
  }

  // files
  return (
    <div className="h-full min-h-0 overflow-y-auto p-2">
      <ProjectFileTree
        projectPath={projectPath}
        defaultOpen
        onFileSelect={(relPath) => {
          // searchEntries returns paths RELATIVE to projectPath; prepend the
          // project root unless already absolute (mirrors WorkspaceRightPanel).
          const alreadyAbs =
            /^[A-Za-z]:[\\/]/.test(relPath) ||
            relPath.startsWith("/") ||
            relPath.startsWith("\\\\")
          if (alreadyAbs) {
            setEditingFile(relPath)
            return
          }
          const sep = projectPath.includes("\\") ? "\\" : "/"
          const base = projectPath.replace(/[\\/]+$/, "")
          setEditingFile(`${base}${sep}${relPath}`)
        }}
      />
    </div>
  )
}
