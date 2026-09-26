import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { WorkspaceTab } from "@/lib/preferences-store"

vi.mock("@/lib/chat-store", () => ({
  useChatStore: Object.assign(
    (select: (store: unknown) => unknown) => select({ threads: [] }),
    { setState: () => {}, getState: () => ({ threads: [] }) }
  ),
  useThreadActivities: () => [],
  useThreadMessages: () => [],
}))
vi.mock("@/hooks/use-chat-streaming-state", () => ({
  useChatStreamingState: () => ({ isPlanStreaming: false, allPlans: [] }),
}))
vi.mock("@/hooks/use-open-targets", () => ({
  useOpenTargets: () => ({ targets: [], loading: false }),
}))
vi.mock("@/services/backend", () => ({
  openInEditor: vi.fn(),
  pickFolder: vi.fn(),
}))
vi.mock("@/components/diff-panel", () => ({ DiffPanel: () => null }))
vi.mock("@/components/git-panel", () => ({ GitPanel: () => null }))
vi.mock("@/components/file-tree/project-file-tree", () => ({
  ProjectFileTree: () => null,
}))
vi.mock("@/components/layout/workspace-status-bar", () => ({
  WorkspaceStatusBar: () => null,
}))
vi.mock("@/components/layout/workspace-overview-card", () => ({
  WorkspaceOverviewCard: () => null,
}))
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: () => null,
}))
import { WorkspaceRightPanel } from "./workspace-right-panel"

function render(open: boolean, workspaceTab: WorkspaceTab = "diff") {
  return renderToStaticMarkup(
    <TooltipProvider>
      <WorkspaceRightPanel
        rightSidebarOpen={open}
        setRightSidebarOpen={() => {}}
        rightSidebarWidth={320}
        onResizeStart={() => {}}
        isResizingRight={false}
        workspaceTab={workspaceTab}
        setWorkspaceTab={() => {}}
        activeThread={{
          id: "t1",
          projectPath: "C:\\repo",
          projectName: "repo",
        }}
        setPlanModalContent={() => {}}
        setEditingFile={() => {}}
      />
    </TooltipProvider>
  )
}

describe("workspace panel header", () => {
  // The pane-bar toggle that opens the panel disappears once the panel takes
  // focus, so the way out has to live in the panel itself, beside the view
  // picker the user is already looking at.
  it("puts a close control right after the view picker", () => {
    const html = render(true)
    const openIn = html.indexOf(">Open in<")
    const picker = html.indexOf("Change workspace view")
    const close = html.indexOf('aria-label="Close workspace"')
    expect(openIn).toBeGreaterThan(-1)
    expect(picker).toBeGreaterThan(openIn)
    expect(close).toBeGreaterThan(picker)
    // No other control sits between the picker and the close button.
    const closeTag = html.lastIndexOf("<button", close)
    expect(html.slice(picker, closeTag)).not.toContain("<button")
  })

  it("hides the whole panel, controls included, while closed", () => {
    const html = render(false)
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain("inert")
  })

  it("shows the browser preview in the Agent workspace view", () => {
    const html = render(true, "browser")
    expect(html).toContain("Current view: Browser")
    expect(html).toContain('aria-label="Loading browser preview"')
  })
})
