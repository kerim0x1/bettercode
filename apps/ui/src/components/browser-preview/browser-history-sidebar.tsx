import { useMemo, useState } from "react"
import { ChevronDownIcon, SearchIcon, XIcon } from "lucide-react"
import { groupVisits, pageLabel } from "@/lib/browser-address"
import { useBrowserStore, type BrowserVisit } from "@/lib/browser-store"
import { cn } from "@/lib/utils"
import { BrowserPageIcon } from "./browser-page-icon"

/**
 * The browser's right-hand list: a filter, the favorites, then the history
 * by day (Today, Yesterday, This week, Older), each group collapsible.
 */
export function BrowserHistorySidebar({
  onNavigate,
}: {
  onNavigate: (url: string) => void
}) {
  const [query, setQuery] = useState("")
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const history = useBrowserStore((state) => state.history)
  const favorites = useBrowserStore((state) => state.favorites)
  const removeVisit = useBrowserStore((state) => state.removeVisit)

  const needle = query.trim().toLowerCase()
  const matches = (page: { url: string; title: string | null }) =>
    !needle ||
    page.url.toLowerCase().includes(needle) ||
    (page.title ?? "").toLowerCase().includes(needle)
  const shownFavorites = favorites.filter(matches)
  const groups = useMemo(() => {
    // One row per address and day group: the newest visit wins.
    const seen = new Set<string>()
    return groupVisits(history)
      .map((group) => ({
        ...group,
        entries: group.entries.filter((visit) => {
          const key = `${group.label}\0${visit.url}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }),
      }))
      .map((group) => ({
        ...group,
        entries: group.entries.filter(
          (visit) =>
            !needle ||
            visit.url.toLowerCase().includes(needle) ||
            (visit.title ?? "").toLowerCase().includes(needle)
        ),
      }))
      .filter((group) => group.entries.length > 0)
  }, [history, needle])

  const toggle = (label: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })

  return (
    <aside
      aria-label="Browser history"
      className="flex w-[220px] shrink-0 flex-col border-l border-border/40 bg-sidebar"
    >
      <div className="p-2">
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 focus-within:border-ring/60">
          <SearchIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search history"
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/70"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {shownFavorites.length > 0 ? (
          <section className="mb-1.5">
            <h3 className="px-2 pt-0.5 pb-1 text-[11.5px] font-normal text-muted-foreground">
              Favorites
            </h3>
            {shownFavorites.map((favorite) => (
              <PageRow
                key={favorite.url}
                page={favorite}
                onOpen={() => onNavigate(favorite.url)}
              />
            ))}
          </section>
        ) : null}
        {groups.map((group) => {
          const open = !collapsed.has(group.label)
          return (
            <section key={group.label} className="mb-1">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(group.label)}
                className="flex h-6 w-full items-center gap-1 rounded-md px-1.5 text-left text-[11.5px] text-muted-foreground hover:text-foreground focus-visible:bg-muted/50 focus-visible:outline-none"
              >
                <ChevronDownIcon
                  className={cn(
                    "size-3 transition-transform duration-150",
                    !open && "-rotate-90"
                  )}
                />
                {group.label}
              </button>
              {open
                ? group.entries.map((visit) => (
                    <PageRow
                      key={`${visit.url}-${visit.visitedAt}`}
                      page={visit}
                      indent
                      onOpen={() => onNavigate(visit.url)}
                      onRemove={() => removeVisit(visit.url)}
                    />
                  ))
                : null}
            </section>
          )
        })}
        {groups.length === 0 && shownFavorites.length === 0 ? (
          <p className="px-2 pt-1 text-[11.5px] text-muted-foreground/60">
            {needle ? "No matching pages." : "No history yet."}
          </p>
        ) : null}
      </div>
    </aside>
  )
}

function PageRow({
  page,
  indent = false,
  onOpen,
  onRemove,
}: {
  page: Pick<BrowserVisit, "url" | "title" | "favicon">
  indent?: boolean
  onOpen: () => void
  onRemove?: () => void
}) {
  const label = pageLabel(page)
  return (
    <div className="group/row relative">
      <button
        type="button"
        onClick={onOpen}
        title={page.url}
        className={cn(
          "flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-6 text-left text-[12px] text-foreground/90 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
          indent ? "pl-4" : "pl-2"
        )}
      >
        <BrowserPageIcon src={page.favicon} />
        <span className="truncate">{label}</span>
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${label} from history`}
          onClick={onRemove}
          className="absolute top-1.5 right-1 grid size-4 place-items-center rounded text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  )
}
