import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Onboarding } from "@/components/onboarding"
import { ErrorBoundary } from "@/components/error-boundary"
import { Titlebar } from "@/components/layout/titlebar"
import { LeftSidebar } from "@/components/layout/left-sidebar"
import { MainArea } from "@/components/layout/main-area"
import { WorkspaceRightPanel } from "@/components/layout/workspace-right-panel"
import { useAppUiStore } from "@/lib/app-ui-store"
import type {
  TitlebarProps,
  LeftSidebarProps,
  MainAreaProps,
  WorkspaceRightPanelProps,
} from "@/hooks/use-app-shell-bundles"
import type { UsageView } from "@/components/usage-page"
import { useAutomationRunChats } from "@/hooks/use-automation-run-chats"
import { OPEN_AUTOMATIONS_EVENT } from "@/lib/automations-page"
import {
  OPEN_PULL_REQUESTS_EVENT,
  pullRequestsPageTarget,
  type PullRequestsPageTarget,
} from "@/lib/pull-requests-page"

// The usage page is a whole dashboard that only appears once the user asks
// for it, so a static import parked it in the entry chunk and pushed it past
// the pre-first-paint budget. Lazy keeps it off the critical path.
const UsagePage = lazy(() =>
  import("@/components/usage-page").then((m) => ({ default: m.UsagePage }))
)
const SettingsPage = lazy(() =>
  import("@/components/settings/settings-page").then((m) => ({
    default: m.SettingsPage,
  }))
)
const AutomationsPage = lazy(() =>
  import("@/components/automations/automations-page").then((m) => ({
    default: m.AutomationsPage,
  }))
)
const PullRequestsPage = lazy(() =>
  import("@/components/pull-requests/pull-requests-page").then((m) => ({
    default: m.PullRequestsPage,
  }))
)

/** Escape closes a page, but not from a field or a menu that took it. */
function closesPage(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false
  const target = event.target as HTMLElement | null
  return !target?.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]'
  )
}

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
  // Cost, Tokens or Limits; "open Limits" opens Usage on its Limits view.
  const [usageView, setUsageView] = useState<UsageView>("cost")
  // Settings is a page in the main area like Usage; its open state and tab
  // stay in the app UI store, where every "open Settings" call sets them.
  const settingsOpen = useAppUiStore((s) => s.settingsOpen)
  const settingsTab = useAppUiStore((s) => s.settingsTab)
  const setSettingsOpen = useAppUiStore((s) => s.setSettingsOpen)
  const setSettingsTab = useAppUiStore((s) => s.setSettingsTab)
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    setSettingsTab("general")
  }, [setSettingsOpen, setSettingsTab])
  // Automations is a page too (sidebar "Scheduled", Ctrl+Shift+A).
  const [automationsOpen, setAutomationsOpen] = useState(false)
  // Chats that automation runs start in the background join the chat list.
  useAutomationRunChats()

  useEffect(() => {
    const openAutomations = () => {
      setAutomationsOpen(true)
      setUsageOpen(false)
      closeSettings()
    }
    // Opening a chat (the sidebar, a run's "Open chat") leaves the page.
    const leaveAutomations = () => setAutomationsOpen(false)
    window.addEventListener(OPEN_AUTOMATIONS_EVENT, openAutomations)
    window.addEventListener("betterc0de:open-thread", leaveAutomations)
    return () => {
      window.removeEventListener(OPEN_AUTOMATIONS_EVENT, openAutomations)
      window.removeEventListener("betterc0de:open-thread", leaveAutomations)
    }
  }, [closeSettings])

  useEffect(() => {
    const openUsage = () => {
      setUsageView((view) => (view === "limits" ? "cost" : view))
      setUsageOpen(true)
      setAutomationsOpen(false)
      closeSettings()
    }
    const openLimits = () => {
      setUsageView("limits")
      setUsageOpen(true)
      setAutomationsOpen(false)
      closeSettings()
    }
    window.addEventListener("betterc0de:open-usage", openUsage)
    window.addEventListener("betterc0de:open-limits", openLimits)
    return () => {
      window.removeEventListener("betterc0de:open-usage", openUsage)
      window.removeEventListener("betterc0de:open-limits", openLimits)
    }
  }, [closeSettings])

  // Pull Requests is a page too (sidebar, command palette, a chat's pull
  // request chip); the target is the pull request it shows, if any.
  const [pullRequestsOpen, setPullRequestsOpen] = useState(false)
  const [pullRequestTarget, setPullRequestTarget] =
    useState<PullRequestsPageTarget | null>(null)
  useEffect(() => {
    const openPullRequests = (event: Event) => {
      setPullRequestTarget(pullRequestsPageTarget(event))
      setPullRequestsOpen(true)
      setUsageOpen(false)
      setAutomationsOpen(false)
      closeSettings()
    }
    // Opening a chat (a row, "Work on this PR") leaves the page.
    const leavePullRequests = () => setPullRequestsOpen(false)
    window.addEventListener(OPEN_PULL_REQUESTS_EVENT, openPullRequests)
    window.addEventListener("betterc0de:open-thread", leavePullRequests)
    return () => {
      window.removeEventListener(OPEN_PULL_REQUESTS_EVENT, openPullRequests)
      window.removeEventListener("betterc0de:open-thread", leavePullRequests)
    }
  }, [closeSettings])
  // Any other page takes its place.
  useEffect(() => {
    if (settingsOpen || usageOpen || automationsOpen) setPullRequestsOpen(false)
  }, [settingsOpen, usageOpen, automationsOpen])
  // Escape steps back: from a pull request to the list, then to the chat.
  useEffect(() => {
    if (!pullRequestsOpen) return
    const stepBack = (event: KeyboardEvent) => {
      if (!closesPage(event)) return
      if (pullRequestTarget) setPullRequestTarget(null)
      else setPullRequestsOpen(false)
    }
    window.addEventListener("keydown", stepBack)
    return () => window.removeEventListener("keydown", stepBack)
  }, [pullRequestsOpen, pullRequestTarget])

  // One page at a time: opening Settings closes Usage and Automations.
  useEffect(() => {
    if (!settingsOpen) return
    setUsageOpen(false)
    setAutomationsOpen(false)
  }, [settingsOpen])

  useEffect(() => {
    if (!usageOpen && !settingsOpen && !automationsOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (!closesPage(event)) return
      if (settingsOpen) closeSettings()
      else if (usageOpen) setUsageOpen(false)
      else setAutomationsOpen(false)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [usageOpen, settingsOpen, automationsOpen, closeSettings])

  const mainBody = settingsOpen ? (
    <Suspense fallback={<div className="min-h-0 flex-1 bg-background" />}>
      <ErrorBoundary label="Settings">
        <SettingsPage
          tab={settingsTab}
          onTabChange={setSettingsTab}
          onClose={closeSettings}
        />
      </ErrorBoundary>
    </Suspense>
  ) : usageOpen ? (
    <Suspense fallback={<div className="min-h-0 flex-1 bg-background" />}>
      <ErrorBoundary label="Usage">
        <UsagePage
          onClose={() => setUsageOpen(false)}
          view={usageView}
          onViewChange={setUsageView}
        />
      </ErrorBoundary>
    </Suspense>
  ) : automationsOpen ? (
    <Suspense fallback={<div className="min-h-0 flex-1 bg-background" />}>
      <ErrorBoundary label="Automations">
        <AutomationsPage onClose={() => setAutomationsOpen(false)} />
      </ErrorBoundary>
    </Suspense>
  ) : pullRequestsOpen ? (
    <Suspense fallback={<div className="min-h-0 flex-1 bg-background" />}>
      <ErrorBoundary label="Pull Requests">
        <PullRequestsPage
          onClose={() => setPullRequestsOpen(false)}
          target={pullRequestTarget}
          onTargetChange={setPullRequestTarget}
        />
      </ErrorBoundary>
    </Suspense>
  ) : (
    <ErrorBoundary label="Main Area">
      <MainArea {...mainAreaProps} />
    </ErrorBoundary>
  )

  // Codex-style shell in agent mode: the main body floats as its own
  // rounded card on the dark sidebar surface (gap all around), and the
  // right workspace panel floats next to it as a second card.
  //
  // Canvas gets the same frame next to the same flush sidebar. Editor keeps
  // the flush IDE layout, whose panels bring their own rounded frames —
  // except for the Settings and Usage pages, which have no frame of their
  // own and would otherwise sit edge to edge against the sidebar.
  const pageOpen =
    settingsOpen || usageOpen || automationsOpen || pullRequestsOpen
  const floatingShell =
    pageOpen ||
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
                {mainBody}
              </div>
              {showWorkspaceRightPanel && (
                <ErrorBoundary label="Workspace Right Panel">
                  <WorkspaceRightPanel {...workspaceRightPanelProps} />
                </ErrorBoundary>
              )}
            </div>
          ) : (
            <>
              {mainBody}
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
