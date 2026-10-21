import { useState } from "react"
import { SearchIcon } from "lucide-react"
import {
  displayAddress,
  pageLabel,
  resolveAddress,
} from "@/lib/browser-address"
import { recentPages, useBrowserStore } from "@/lib/browser-store"
import { BrowserPageIcon } from "./browser-page-icon"

/**
 * A new tab: one search-or-address field and the recently visited pages.
 * Works without a project, so the browser is useful from an empty window.
 */
export function BrowserStartPage({
  onNavigate,
}: {
  onNavigate: (url: string) => void
}) {
  const [query, setQuery] = useState("")
  const history = useBrowserStore((state) => state.history)
  const recents = recentPages(history)

  return (
    <div className="size-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-[480px] flex-col px-6 pt-[12%] pb-8">
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            const url = resolveAddress(query)
            if (url) onNavigate(url)
          }}
        >
          <label className="flex h-9 items-center gap-2 rounded-full border border-border/60 bg-muted/30 px-3.5 transition-colors focus-within:border-ring/60 focus-within:bg-muted/40">
            <SearchIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search or enter URL"
              placeholder="Search or enter URL…"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </label>
        </form>

        <h2 className="mt-7 mb-1.5 px-2 text-[12px] font-normal text-muted-foreground">
          Recents
        </h2>
        {recents.length === 0 ? (
          <p className="px-2 text-[12px] text-muted-foreground/60">
            Pages you open show up here.
          </p>
        ) : (
          <ul className="flex flex-col">
            {recents.map((page) => (
              <li key={page.url}>
                <button
                  type="button"
                  onClick={() => onNavigate(page.url)}
                  title={page.url}
                  className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  <BrowserPageIcon src={page.favicon} />
                  <span className="max-w-[60%] shrink-0 truncate text-[12.5px] text-foreground">
                    {pageLabel(page)}
                  </span>
                  <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                    {displayAddress(page.url)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
