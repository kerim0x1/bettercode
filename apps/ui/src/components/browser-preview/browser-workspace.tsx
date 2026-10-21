import { useEffect, useState } from "react"
import { BrowserPreviewPanel } from "@/components/browser-preview-panel"
import { useBrowserStore } from "@/lib/browser-store"
import { cn } from "@/lib/utils"
import { BrowserHistorySidebar } from "./browser-history-sidebar"

/** Tabs kept loaded; each is a webview with its own renderer process. */
const MAX_LIVE_TABS = 4

/**
 * The right panel's browser: one `BrowserPreviewPanel` per tab of the
 * browser store, the history and favorites beside the page. Switching tabs
 * keeps a page as it was; the oldest hidden tabs beyond `MAX_LIVE_TABS` are
 * unloaded and reopen their address when shown again. Needs no project.
 */
export function BrowserWorkspace({
  active,
  projectPath,
  threadId,
  onClose,
}: {
  active: boolean
  projectPath: string | null
  threadId: string | null
  onClose: () => void
}) {
  const tabs = useBrowserStore((state) => state.tabs)
  const activeTabId = useBrowserStore((state) => state.activeTabId)
  const favorites = useBrowserStore((state) => state.favorites)
  const historyOpen = useBrowserStore((state) => state.historyOpen)
  const setHistoryOpen = useBrowserStore((state) => state.setHistoryOpen)
  const updatePage = useBrowserStore((state) => state.updatePage)
  const toggleFavorite = useBrowserStore((state) => state.toggleFavorite)
  // Loaded tabs, the most recently shown last.
  const [live, setLive] = useState<string[]>(() => [activeTabId])
  useEffect(() => {
    setLive((current) =>
      [
        ...current.filter(
          (id) => id !== activeTabId && tabs.some((tab) => tab.id === id)
        ),
        activeTabId,
      ].slice(-MAX_LIVE_TABS)
    )
  }, [activeTabId, tabs])

  return (
    <div className="relative size-full min-h-0">
      {live.map((id) => {
        const tab = tabs.find((entry) => entry.id === id)
        if (!tab) return null
        const shown = id === activeTabId
        return (
          <div
            key={id}
            className={cn("absolute inset-0 flex", !shown && "hidden")}
            aria-hidden={!shown}
            inert={!shown}
          >
            <BrowserPreviewPanel
              initialUrl={tab.url}
              projectPath={projectPath}
              threadId={threadId}
              active={active && shown}
              compact
              className="min-h-0 min-w-0 flex-1"
              onClose={onClose}
              onPageChange={(page) => updatePage(id, page)}
              renderSidePanel={(navigate) => (
                <BrowserHistorySidebar onNavigate={navigate} />
              )}
              sidePanelOpen={historyOpen}
              onToggleSidePanel={() => setHistoryOpen(!historyOpen)}
              favorite={
                !!tab.url &&
                favorites.some((favorite) => favorite.url === tab.url)
              }
              onToggleFavorite={() => {
                if (!tab.url) return
                toggleFavorite({
                  url: tab.url,
                  title: tab.title,
                  favicon: tab.favicon,
                })
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
