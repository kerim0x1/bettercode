import { useEffect, useState } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Onboarding } from "@/components/onboarding"
import { ErrorBoundary } from "@/components/error-boundary"
import { Titlebar } from "@/components/layout/titlebar"
import { LeftSidebar } from "@/components/layout/left-sidebar"
import { MainArea } from "@/components/layout/main-area"
import { WorkspaceRightPanel } from "@/components/layout/workspace-right-panel"
import { UsagePage } from "@/components/usage-page"
import type {
  TitlebarProps,
  LeftSidebarProps,
  MainAreaProps,
  WorkspaceRightPanelProps,
} from "@/hooks/use-app-shell-bundles"

/**
 * Top-level app layout shell. Composes:
 *  - `<TooltipProvider>` + `<Onboarding>` providers/overlays.
 *  - Titlebar (frameless Electron mode).
 *  - Three-column body: `<LeftSidebar>` (collapsible), `<MainArea>` (chat
 *    column + dialogs), `<WorkspaceRightPanel>` (agent mode only).
 *
 * Passed prop bags rather than destructured individually because the
 * three child components each need ~30 props — laying them out
 * individually here would just duplicate the long prop lists. The
 * indirection keeps `App.tsx` focused on hook wiring rather than JSX
 * plumbing.
 */
export function AppShell({
  titlebarProps,
  sidebarOpen,
  leftSidebarProps,
  mainAreaProps,
  workspaceRightPanelProps,
  showWorkspaceRightPanel,
}: {
  titlebarProps: TitlebarProps
  sidebarOpen: boolean
  leftSidebarProps: LeftSidebarProps
  mainAreaProps: MainAreaProps
  workspaceRightPanelProps: WorkspaceRightPanelProps
  showWorkspaceRightPanel: boolean
}) {
  const [usageOpen, setUsageOpen] = useState(false)

  useEffect(() => {
    const openUsage = () => setUsageOpen(true)
    window.addEventListener("betterc0de:open-usage", openUsage)
    return () => window.removeEventListener("betterc0de:open-usage", openUsage)
  }, [])

  useEffect(() => {
    if (!usageOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUsageOpen(false)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [usageOpen])

  // Codex-style shell in agent mode: the main body floats as its own
  // rounded card on the dark sidebar surface (gap all around), and the
  // right workspace panel floats next to it as a second card.
  //
  // Canvas gets the same frame. Its sidebar is already an inset card
  // (`my-2 ml-2 rounded-xl` in LeftSidebar), so a square body butting
  // straight against that card's rounded corner left a visible cut in the
  // seam. Editor keeps the flush IDE layout.
  const floatingShell =
    leftSidebarProps.appMode === "agent" ||
    leftSidebarProps.appMode === "design"
  return (
    <TooltipProvider>
      <Onboarding />
      <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
        <ErrorBoundary label="Titlebar">
          <Titlebar {...titlebarProps} />
        </ErrorBoundary>
        <div className="flex min-h-0 flex-1 overflow-hidden bg-sidebar">
          <ErrorBoundary label="Left Sidebar">
            <LeftSidebar {...leftSidebarProps} collapsed={!sidebarOpen} />
          </ErrorBoundary>
          {floatingShell ? (
            <div className="flex min-h-0 min-w-0 flex-1 gap-2 overflow-hidden p-2 pl-1">
              {/* Main body card — every direct child stretches to fill it
                  (MainArea's root has no flex-1 of its own). */}
              <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border border-border/40 bg-background shadow-[0_18px_50px_-32px_rgba(0,0,0,0.9)] [&>*]:min-w-0 [&>*]:flex-1 [&>*]:bg-background">
                {usageOpen ? (
                  <UsagePage onClose={() => setUsageOpen(false)} />
                ) : (
                  <ErrorBoundary label="Main Area">
                    <MainArea {...mainAreaProps} />
                  </ErrorBoundary>
                )}
              </div>
              {showWorkspaceRightPanel && (
                <ErrorBoundary label="Workspace Right Panel">
                  <WorkspaceRightPanel {...workspaceRightPanelProps} />
                </ErrorBoundary>
              )}
            </div>
          ) : (
            <>
              {usageOpen ? (
                <UsagePage onClose={() => setUsageOpen(false)} />
              ) : (
                <ErrorBoundary label="Main Area">
                  <MainArea {...mainAreaProps} />
                </ErrorBoundary>
              )}
              {showWorkspaceRightPanel && (
                <ErrorBoundary label="Workspace Right Panel">
                  <WorkspaceRightPanel {...workspaceRightPanelProps} />
                </ErrorBoundary>
              )}
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
