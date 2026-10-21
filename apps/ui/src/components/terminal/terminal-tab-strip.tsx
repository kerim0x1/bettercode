import { useState } from "react"
import { Columns2Icon, XIcon } from "lucide-react"
import { ShellIcon } from "@/components/terminal/shell-icon"
import {
  MAX_TERMINAL_TAB_TITLE_CHARS,
  layoutTerminalIds,
  type TerminalTab,
} from "@/lib/terminal-layout"
import { terminalDisplayName } from "@/lib/terminal-protocol"
import type { TerminalInfo } from "@/lib/terminal-sessions"
import { cn } from "@/lib/utils"

/** A tab's name: the user's, else its focused terminal's. */
export function terminalTabLabel(
  tab: TerminalTab,
  terminals: Readonly<Record<string, TerminalInfo>>,
  titlesEnabled: boolean
): string {
  if (tab.title) return tab.title
  const info = terminals[tab.activeTerminalId]
  return info ? terminalDisplayName(info, titlesEnabled) : "Terminal"
}

/**
 * The terminal panel's tabs: shell mark and name, a split mark when the tab
 * holds several panes, close on hover or on the active tab. Double-click or
 * F2 renames a tab; middle-click closes it.
 */
export function TerminalTabStrip({
  tabs,
  activeTabId,
  terminals,
  titlesEnabled,
  onSelect,
  onClose,
  onRename,
}: {
  tabs: readonly TerminalTab[]
  activeTabId: string | null
  terminals: Readonly<Record<string, TerminalInfo>>
  titlesEnabled: boolean
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onRename: (tabId: string, title: string) => void
}) {
  const [editingTabId, setEditingTabId] = useState<string | null>(null)

  return (
    <div
      role="tablist"
      aria-label="Terminals"
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        const label = terminalTabLabel(tab, terminals, titlesEnabled)
        const info = terminals[tab.activeTerminalId]
        const panes = layoutTerminalIds(tab.layout).length
        const ended =
          info?.status === "exited" ||
          info?.status === "ended" ||
          info?.status === "failed"
        return (
          <div
            key={tab.id}
            className={cn(
              "group/tab flex h-7 max-w-[184px] min-w-[84px] shrink items-center rounded-md transition-colors duration-150",
              active
                ? "bg-muted/70 text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            )}
          >
            {editingTabId === tab.id ? (
              <TabNameInput
                initial={tab.title ?? label}
                onDone={(title) => {
                  setEditingTabId(null)
                  if (title !== null) onRename(tab.id, title)
                }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={`${label}${ended ? " (ended)" : ""} · Double-click to rename`}
                onClick={() => onSelect(tab.id)}
                onDoubleClick={() => setEditingTabId(tab.id)}
                onKeyDown={(event) => {
                  if (event.key !== "F2") return
                  event.preventDefault()
                  setEditingTabId(tab.id)
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) onClose(tab.id)
                }}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-2 text-left text-[12px] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
              >
                <ShellIcon
                  shell={info?.shellKind ?? info?.shell}
                  className={cn(ended && "opacity-50")}
                />
                <span className={cn("truncate", ended && "opacity-60")}>
                  {label}
                </span>
                {ended ? <span className="sr-only">(ended)</span> : null}
                {panes > 1 ? (
                  <span
                    className="flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums"
                    aria-label={`${panes} terminals`}
                  >
                    <Columns2Icon className="size-3" aria-hidden="true" />
                    {panes}
                  </span>
                ) : null}
              </button>
            )}
            <button
              type="button"
              aria-label={`Close ${label}`}
              title="Close tab"
              onClick={() => onClose(tab.id)}
              className={cn(
                "mr-1 grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
                active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"
              )}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** Enter keeps the name, Escape drops it; an empty name gives the default back. */
function TabNameInput({
  initial,
  onDone,
}: {
  initial: string
  onDone: (title: string | null) => void
}) {
  const [value, setValue] = useState(initial)
  const [done, setDone] = useState(false)
  const finish = (title: string | null) => {
    if (done) return
    setDone(true)
    onDone(title)
  }
  return (
    <input
      autoFocus
      aria-label="Tab name"
      value={value}
      maxLength={MAX_TERMINAL_TAB_TITLE_CHARS}
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          finish(value)
        } else if (event.key === "Escape") {
          event.preventDefault()
          finish(null)
        }
      }}
      className="mx-1 h-5 min-w-0 flex-1 rounded bg-background px-1.5 text-[12px] text-foreground ring-1 ring-ring/40 outline-none"
    />
  )
}
