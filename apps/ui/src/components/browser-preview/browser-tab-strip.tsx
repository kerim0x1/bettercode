import { PlusIcon, XIcon } from "lucide-react"
import { pageLabel } from "@/lib/browser-address"
import { useBrowserStore } from "@/lib/browser-store"
import { cn } from "@/lib/utils"
import { BrowserPageIcon } from "./browser-page-icon"

/**
 * The workspace browser's tabs, in the right panel's header: page icon and
 * title per tab, a close button on hover or on the active tab, and `+` for a
 * new tab on the start page.
 */
export function BrowserTabStrip({ className }: { className?: string }) {
  const tabs = useBrowserStore((state) => state.tabs)
  const activeTabId = useBrowserStore((state) => state.activeTabId)
  const activateTab = useBrowserStore((state) => state.activateTab)
  const closeTab = useBrowserStore((state) => state.closeTab)
  const openTab = useBrowserStore((state) => state.openTab)

  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-0.5", className)}>
      <div
        role="tablist"
        aria-label="Browser tabs"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const label = pageLabel(tab)
          return (
            <div
              key={tab.id}
              className={cn(
                "group/tab flex h-7 max-w-[168px] min-w-[72px] shrink items-center rounded-md transition-colors duration-150",
                active
                  ? "bg-muted/70 text-foreground"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.url ?? label}
                onClick={() => activateTab(tab.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) closeTab(tab.id)
                }}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pl-2 text-left text-[12px] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
              >
                <BrowserPageIcon src={tab.favicon} />
                <span className="truncate">{label}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${label}`}
                onClick={() => closeTab(tab.id)}
                className={cn(
                  "mr-1 grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100",
                  active
                    ? "opacity-100"
                    : "opacity-0 group-hover/tab:opacity-100"
                )}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        aria-label="New tab"
        title="New tab"
        onClick={() => openTab()}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  )
}
