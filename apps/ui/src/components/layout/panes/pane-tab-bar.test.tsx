import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { Pane } from "@/hooks/use-panes"

const prefs = vi.hoisted(() => ({ workspaceOpen: false }))
vi.mock("@/lib/chat-store", () => ({
  useChatStore: (select: (store: unknown) => unknown) =>
    select({ threads: [] }),
}))
vi.mock("@/lib/preferences-store", () => ({
  usePreferencesStore: Object.assign(
    (select: (store: unknown) => unknown) =>
      select({ rightSidebarOpen: prefs.workspaceOpen }),
    { getState: () => ({ set: () => {} }) }
  ),
}))
vi.mock("@/components/attention/attention-badge", () => ({
  AttentionBadge: () => null,
}))
vi.mock("@/components/layout/panes/pane-running-dot", () => ({
  PaneRunningDot: () => null,
}))
vi.mock("@/components/chat/compare-group", () => ({
  CompareSwitcher: () => null,
}))
vi.mock("@/components/pull-requests/thread-pull-request-chip", () => ({
  ThreadPullRequestChip: () => null,
}))
import { PaneTabBar } from "./pane-tab-bar"

const chatTab = {
  id: "t-chat",
  kind: "chat",
  title: "Chat",
  threadId: "thread-1",
} as const

function render(pane: Pane, isActive = true, workspaceOpen = false) {
  prefs.workspaceOpen = workspaceOpen
  return renderToStaticMarkup(
    <PaneTabBar
      pane={pane}
      chatTitle="New Chat"
      isActive={isActive}
      canClose
      onSelectTab={() => {}}
      onCloseTab={() => {}}
      onAddTab={() => {}}
      onClose={() => {}}
    />
  )
}

const solo = {
  id: "pane-1",
  tabs: [chatTab],
  activeTabId: chatTab.id,
  primaryThreadId: "thread-1",
} as unknown as Pane

const tabbed = {
  ...solo,
  tabs: [
    chatTab,
    { id: "t-diff", kind: "diff", title: "Diff", threadId: "thread-1" },
  ],
} as unknown as Pane

describe("pane tab bar controls", () => {
  it.each([
    ["a single chat", solo],
    ["several tabs", tabbed],
  ])("offers workspace and close but no maximize for %s", (_label, pane) => {
    const html = render(pane)
    expect(html).toContain('aria-label="Open workspace"')
    expect(html).toContain('aria-label="Close pane"')
    // The user retired the maximize control; it must not come back.
    expect(html).not.toContain("Maximize pane")
    expect(html).not.toContain("Restore pane")
    expect(html).not.toContain("lucide-maximize-2")
  })

  it("shows the workspace toggle only on the active pane", () => {
    expect(render(solo, false)).not.toContain('aria-label="Open workspace"')
  })

  // The open panel's header carries the close control beside the view
  // picker; a second glyph in the pane bar showed the same icon twice.
  it("steps aside while the workspace panel is open", () => {
    const html = render(solo, true, true)
    expect(html).not.toContain("workspace")
    expect(html).toContain('aria-label="Close pane"')
  })
})
