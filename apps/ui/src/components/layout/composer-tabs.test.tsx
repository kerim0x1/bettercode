import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ComposerTabs } from "./composer-tabs"

function renderTwoTabs() {
  return renderToStaticMarkup(
    <ComposerTabs
      composerTabs={[
        { id: "one", threadId: null, label: "Review" },
        { id: "two", threadId: null, label: "Implement" },
      ]}
      activeComposerTab="one"
      setActiveComposerTab={() => {}}
      closeComposerTab={() => {}}
      addComposerTab={() => {}}
    />
  )
}

describe("editor chat tabs", () => {
  // The shortcut labels follow navigator.platform, which Node reports from
  // the host OS; pin it so each expectation holds on every CI runner.
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("marks an unavailable saved conversation while keeping its close action", () => {
    const html = renderToStaticMarkup(
      <ComposerTabs
        composerTabs={[
          { id: "removed", threadId: "not-loaded", label: "Review" },
        ]}
        activeComposerTab="removed"
        setActiveComposerTab={() => {}}
        closeComposerTab={() => {}}
      />
    )
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain("Review (unavailable)")
    expect(html).toContain('aria-label="Close Review"')
  })
  it("provides a separate layout control and a single keyboard entry point", () => {
    vi.stubGlobal("navigator", { platform: "Win32" })
    const html = renderTwoTabs()
    expect(html).toContain('aria-label="Chat layout"')
    expect(html).toContain('aria-label="New chat"')
    expect(html).toContain('aria-selected="true" tabindex="0"')
    expect(html).toContain('aria-selected="false" tabindex="-1"')
    expect(html).not.toContain("right-click: plain tab")
    expect(html).not.toContain("<kbd")
    expect(html).toContain('title="Review (Ctrl 1)"')
    expect(html).toContain('aria-keyshortcuts="Control+1"')
  })

  it("labels the tab shortcuts with the Command key on macOS", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" })
    const html = renderTwoTabs()
    expect(html).toContain('title="Review (⌘1)"')
    expect(html).toContain('aria-keyshortcuts="Meta+1"')
    expect(html).not.toContain("Ctrl 1")
  })
})
