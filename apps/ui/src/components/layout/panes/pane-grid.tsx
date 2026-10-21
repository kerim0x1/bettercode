import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { Pane, type PaneChatBag } from "@/components/layout/panes/pane"
import { PaneDropZone } from "@/components/layout/panes/pane-drop-zone"
import type {
  PaneLayout,
  PanePlacementInput,
  PaneTabKind,
} from "@/hooks/use-panes"

/**
 * Agent-mode pane grid — renders the columns-of-rows layout from
 * use-panes: a flex row of columns, each column a flex stack of panes.
 * Every column fills the full height, so the whole surface is covered by
 * pane drop zones (no dead auto-flow cells), and the 5-way drop overlay
 * matches what actually happens: left/right = new column, top/bottom =
 * stack within the column, center = tab into the pane.
 * Falls back to horizontal scroll when columns would drop below a usable
 * width.
 */
const MIN_PANE_WIDTH = 320

export function PaneGrid({
  layout,
  chatBag,
  setActivePane,
  closePane,
  setActiveTab,
  closeTab,
  addTab,
  moveTabToPane,
  openThreadOnPane,
}: {
  layout: PaneLayout
  chatBag: PaneChatBag
  setActivePane: (id: string) => void
  closePane: (id: string) => void
  setActiveTab: (paneId: string, tabId: string) => void
  closeTab: (paneId: string, tabId: string) => void
  addTab: (paneId: string, kind: PaneTabKind) => void
  moveTabToPane: (
    fromPaneId: string,
    tabId: string,
    toPaneId: string,
    mode: PanePlacementInput
  ) => void
  openThreadOnPane: (
    threadId: string,
    label: string | undefined,
    toPaneId: string,
    mode: PanePlacementInput
  ) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // `layout.maximizedPaneId` is ignored on purpose: the maximize control was
  // retired from the pane bar, and honouring a layout persisted while a pane
  // was maximized would show one pane with no way back to the others.
  const columns = layout.columns
  const overflow = width > 0 && width / columns.length < MIN_PANE_WIDTH

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 flex-1 gap-px bg-border/40",
        overflow && "overflow-x-auto"
      )}
    >
      {columns.map((column) => (
        <div
          key={column[0]!.id}
          className={cn(
            "flex min-h-0 flex-col gap-px",
            overflow ? "w-[320px] flex-none" : "min-w-0 flex-1"
          )}
        >
          {column.map((pane) => (
            <PaneDropZone
              key={pane.id}
              onDropTab={(fromPaneId, tabId, zone) =>
                moveTabToPane(
                  fromPaneId,
                  tabId,
                  pane.id,
                  zone === "center" ? "into" : zone
                )
              }
              onDropThread={(threadId, label, zone) =>
                openThreadOnPane(
                  threadId,
                  label,
                  pane.id,
                  zone === "center" ? "into" : zone
                )
              }
            >
              <Pane
                pane={pane}
                isActive={pane.id === layout.activePaneId}
                canClose={layout.panes.length > 1}
                chatBag={chatBag}
                onActivate={() => setActivePane(pane.id)}
                onClose={() => closePane(pane.id)}
                onSelectTab={(tabId) => setActiveTab(pane.id, tabId)}
                onCloseTab={(tabId) => closeTab(pane.id, tabId)}
                onAddTab={(kind) => addTab(pane.id, kind)}
              />
            </PaneDropZone>
          ))}
        </div>
      ))}
    </div>
  )
}
