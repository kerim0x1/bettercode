import { useRef } from "react"
import { TerminalPaneView } from "@/components/terminal/terminal-pane-view"
import {
  MAX_TERMINAL_SPLIT_RATIO,
  MIN_TERMINAL_SPLIT_RATIO,
  layoutTerminalIds,
  type TerminalLayoutNode,
  type TerminalTab,
} from "@/lib/terminal-layout"
import { setTerminalSplitRatio } from "@/lib/terminal-sessions"
import { cn } from "@/lib/utils"

interface SplitViewContext {
  scopeKey: string
  tabId: string
  activeTerminalId: string
  showHeaders: boolean
  titlesEnabled: boolean
  onRequestClose: (terminalId: string) => void
}

/**
 * A tab's terminals: one pane, or splits side by side (`row`) and stacked
 * (`column`) with a draggable, keyboard-adjustable divider between them.
 */
export function TerminalSplitView({
  scopeKey,
  tab,
  titlesEnabled,
  onRequestClose,
}: {
  scopeKey: string
  tab: TerminalTab
  titlesEnabled: boolean
  onRequestClose: (terminalId: string) => void
}) {
  const context: SplitViewContext = {
    scopeKey,
    tabId: tab.id,
    activeTerminalId: tab.activeTerminalId,
    showHeaders: layoutTerminalIds(tab.layout).length > 1,
    titlesEnabled,
    onRequestClose,
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <LayoutNode node={tab.layout} context={context} />
    </div>
  )
}

function LayoutNode({
  node,
  context,
}: {
  node: TerminalLayoutNode
  context: SplitViewContext
}) {
  if (node.type === "pane") {
    return (
      <TerminalPaneView
        key={node.terminalId}
        scopeKey={context.scopeKey}
        terminalId={node.terminalId}
        active={node.terminalId === context.activeTerminalId}
        showHeader={context.showHeaders}
        titlesEnabled={context.titlesEnabled}
        onRequestClose={context.onRequestClose}
      />
    )
  }
  return <Split node={node} context={context} />
}

const KEYBOARD_STEP = 0.05

function Split({
  node,
  context,
}: {
  node: Extract<TerminalLayoutNode, { type: "split" }>
  context: SplitViewContext
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const row = node.direction === "row"
  const setRatio = (ratio: number) =>
    setTerminalSplitRatio(context.scopeKey, context.tabId, node.id, ratio)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current
    if (!container || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const rect = container.getBoundingClientRect()
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      setRatio(
        row
          ? (moveEvent.clientX - rect.left) / Math.max(1, rect.width)
          : (moveEvent.clientY - rect.top) / Math.max(1, rect.height)
      )
    }
    const end = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", end)
      handle.removeEventListener("pointercancel", end)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", end)
    handle.addEventListener("pointercancel", end)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEYBOARD_STEP * 2 : KEYBOARD_STEP
    const back = row ? "ArrowLeft" : "ArrowUp"
    const forward = row ? "ArrowRight" : "ArrowDown"
    if (event.key === back) setRatio(node.ratio - step)
    else if (event.key === forward) setRatio(node.ratio + step)
    else if (event.key === "Home") setRatio(MIN_TERMINAL_SPLIT_RATIO)
    else if (event.key === "End") setRatio(MAX_TERMINAL_SPLIT_RATIO)
    else return
    event.preventDefault()
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 min-w-0 flex-1",
        row ? "flex-row" : "flex-col"
      )}
    >
      <div
        className="flex min-h-0 min-w-0"
        style={{ flex: `${node.ratio} 1 0%` }}
      >
        <LayoutNode node={node.first} context={context} />
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label={
          row ? "Resize terminals side by side" : "Resize stacked terminals"
        }
        aria-orientation={row ? "vertical" : "horizontal"}
        aria-valuemin={Math.round(MIN_TERMINAL_SPLIT_RATIO * 100)}
        aria-valuemax={Math.round(MAX_TERMINAL_SPLIT_RATIO * 100)}
        aria-valuenow={Math.round(node.ratio * 100)}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className={cn(
          "relative z-10 shrink-0 bg-border/60 transition-colors duration-150 outline-none before:absolute hover:bg-primary/40 focus-visible:bg-primary/60",
          row
            ? "w-px cursor-col-resize before:inset-y-0 before:-right-1 before:-left-1"
            : "h-px cursor-row-resize before:inset-x-0 before:-top-1 before:-bottom-1"
        )}
      />
      <div
        className="flex min-h-0 min-w-0"
        style={{ flex: `${1 - node.ratio} 1 0%` }}
      >
        <LayoutNode node={node.second} context={context} />
      </div>
    </div>
  )
}
