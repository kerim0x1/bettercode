import { create } from "zustand"

/**
 * The workspace browser's tabs, history and favorites. Not tied to a
 * project, so the browser works without an open folder. Kept in this
 * window's local storage: a convenience, never shared or synced.
 */

export interface BrowserTab {
  id: string
  /** Null until the tab navigates: the start page. */
  url: string | null
  title: string | null
  favicon: string | null
}

export interface BrowserVisit {
  url: string
  title: string | null
  favicon: string | null
  visitedAt: number
}

export interface BrowserFavorite {
  url: string
  title: string | null
  favicon: string | null
}

interface BrowserState {
  tabs: BrowserTab[]
  activeTabId: string
  history: BrowserVisit[]
  favorites: BrowserFavorite[]
  historyOpen: boolean
  openTab: (url?: string | null) => string
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  /** A tab's page changed: its tab, and its visit in the history. */
  updatePage: (
    id: string,
    page: { url?: string; title?: string | null; favicon?: string | null }
  ) => void
  toggleFavorite: (page: BrowserFavorite) => void
  removeVisit: (url: string) => void
  clearHistory: () => void
  setHistoryOpen: (open: boolean) => void
}

const STORAGE_KEY = "betterc0de-browser"
const MAX_HISTORY = 300
const MAX_TABS = 12

interface StoredBrowser {
  tabs?: Array<Pick<BrowserTab, "url" | "title" | "favicon">>
  activeIndex?: number
  history?: BrowserVisit[]
  favorites?: BrowserFavorite[]
  historyOpen?: boolean
}

function newTab(url: string | null = null): BrowserTab {
  return { id: crypto.randomUUID(), url, title: null, favicon: null }
}

function isHttp(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url)
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function load(): Pick<
  BrowserState,
  "tabs" | "activeTabId" | "history" | "favorites" | "historyOpen"
> {
  let stored: StoredBrowser = {}
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")
  } catch {
    stored = {}
  }
  const tabs = (Array.isArray(stored.tabs) ? stored.tabs : [])
    .slice(0, MAX_TABS)
    .map((tab) => ({
      ...newTab(isHttp(tab?.url) ? tab.url : null),
      title: textOrNull(tab?.title),
      favicon: isHttp(tab?.favicon) ? tab.favicon : null,
    }))
  if (tabs.length === 0) tabs.push(newTab())
  const activeIndex =
    typeof stored.activeIndex === "number" &&
    stored.activeIndex >= 0 &&
    stored.activeIndex < tabs.length
      ? stored.activeIndex
      : 0
  const history = (Array.isArray(stored.history) ? stored.history : [])
    .filter(
      (visit) => isHttp(visit?.url) && typeof visit.visitedAt === "number"
    )
    .slice(0, MAX_HISTORY)
    .map((visit) => ({
      url: visit.url,
      title: textOrNull(visit.title),
      favicon: isHttp(visit.favicon) ? visit.favicon : null,
      visitedAt: visit.visitedAt,
    }))
  const favorites = (Array.isArray(stored.favorites) ? stored.favorites : [])
    .filter((favorite) => isHttp(favorite?.url))
    .map((favorite) => ({
      url: favorite.url,
      title: textOrNull(favorite.title),
      favicon: isHttp(favorite.favicon) ? favorite.favicon : null,
    }))
  return {
    tabs,
    activeTabId: tabs[activeIndex]!.id,
    history,
    favorites,
    historyOpen: stored.historyOpen === true,
  }
}

/** Records a visit: a repeat of the newest entry updates it in place. */
export function withVisit(
  history: readonly BrowserVisit[],
  page: { url: string; title?: string | null; favicon?: string | null },
  now = Date.now()
): BrowserVisit[] {
  const [latest, ...rest] = history
  if (latest && latest.url === page.url) {
    return [
      {
        ...latest,
        title: page.title !== undefined ? page.title : latest.title,
        favicon: page.favicon !== undefined ? page.favicon : latest.favicon,
        visitedAt: now,
      },
      ...rest,
    ]
  }
  return [
    {
      url: page.url,
      title: page.title ?? null,
      favicon: page.favicon ?? null,
      visitedAt: now,
    },
    ...history,
  ].slice(0, MAX_HISTORY)
}

/**
 * A title or icon that arrived after the navigation: fills in the newest
 * visit of that address instead of recording another one.
 */
export function withVisitInfo(
  history: readonly BrowserVisit[],
  url: string,
  info: { title?: string | null; favicon?: string | null }
): BrowserVisit[] {
  const index = history.findIndex((visit) => visit.url === url)
  if (index < 0) return [...history]
  return history.map((visit, position) =>
    position === index ? { ...visit, ...info } : visit
  )
}

/** The newest visit of each address, for the start page's Recents. */
export function recentPages(
  history: readonly BrowserVisit[],
  limit = 8
): BrowserVisit[] {
  const seen = new Set<string>()
  const recent: BrowserVisit[] = []
  for (const visit of history) {
    if (seen.has(visit.url)) continue
    seen.add(visit.url)
    recent.push(visit)
    if (recent.length >= limit) break
  }
  return recent
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  ...load(),
  openTab: (url = null) => {
    const tab = newTab(url)
    set((state) => ({
      tabs: [...state.tabs, tab].slice(-MAX_TABS),
      activeTabId: tab.id,
    }))
    return tab.id
  },
  closeTab: (id) => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const remaining = tabs.filter((tab) => tab.id !== id)
    if (remaining.length === 0) remaining.push(newTab())
    const nextActive =
      activeTabId === id
        ? remaining[Math.min(index, remaining.length - 1)]!.id
        : activeTabId
    set({ tabs: remaining, activeTabId: nextActive })
  },
  activateTab: (id) => {
    if (get().tabs.some((tab) => tab.id === id)) set({ activeTabId: id })
  },
  updatePage: (id, page) => {
    set((state) => {
      const tabs = state.tabs.map((tab) => {
        if (tab.id !== id) return tab
        const navigated = page.url !== undefined && page.url !== tab.url
        return {
          ...tab,
          url: page.url ?? tab.url,
          // A new address starts without the old page's title and icon.
          title:
            page.title !== undefined
              ? page.title
              : navigated
                ? null
                : tab.title,
          favicon:
            page.favicon !== undefined
              ? page.favicon
              : navigated
                ? null
                : tab.favicon,
        }
      })
      const tab = tabs.find((entry) => entry.id === id)
      const info = {
        ...(page.title !== undefined ? { title: page.title } : {}),
        ...(page.favicon !== undefined ? { favicon: page.favicon } : {}),
      }
      const history =
        !tab?.url || !isHttp(tab.url)
          ? state.history
          : page.url !== undefined
            ? withVisit(state.history, { url: tab.url, ...info })
            : withVisitInfo(state.history, tab.url, info)
      const favorites = tab?.url
        ? state.favorites.map((favorite) =>
            favorite.url === tab.url
              ? {
                  ...favorite,
                  title: tab.title ?? favorite.title,
                  favicon: tab.favicon ?? favorite.favicon,
                }
              : favorite
          )
        : state.favorites
      return { tabs, history, favorites }
    })
  },
  toggleFavorite: (page) => {
    set((state) => ({
      favorites: state.favorites.some((favorite) => favorite.url === page.url)
        ? state.favorites.filter((favorite) => favorite.url !== page.url)
        : [...state.favorites, page],
    }))
  },
  removeVisit: (url) => {
    set((state) => ({
      history: state.history.filter((visit) => visit.url !== url),
    }))
  },
  clearHistory: () => set({ history: [] }),
  setHistoryOpen: (open) => set({ historyOpen: open }),
}))

useBrowserStore.subscribe((state) => {
  const stored: StoredBrowser = {
    tabs: state.tabs.map(({ url, title, favicon }) => ({
      url,
      title,
      favicon,
    })),
    activeIndex: state.tabs.findIndex((tab) => tab.id === state.activeTabId),
    history: state.history,
    favorites: state.favorites,
    historyOpen: state.historyOpen,
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // Storage can be unavailable; the browser still works for this session.
  }
})
