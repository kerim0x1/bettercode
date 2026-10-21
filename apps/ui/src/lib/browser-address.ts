import { previewUrl } from "@/components/browser-preview/url"

/**
 * What the browser's address field means by its text: a URL to open, or a
 * search. Local addresses default to http (dev servers rarely speak TLS),
 * everything else to https; text that does not look like an address goes to
 * the web search.
 */
export const SEARCH_URL = "https://www.google.com/search?q="

const LOCAL_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|[\w-]+\.local)(?::\d+)?(?:[/?#]|$)/i
const HOST_LIKE = /^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#]\S*)?$/

export function resolveAddress(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) return previewUrl(text)
  if (!/\s/.test(text)) {
    if (LOCAL_HOST.test(text)) return previewUrl(`http://${text}`)
    if (HOST_LIKE.test(text)) return previewUrl(`https://${text}`)
  }
  return `${SEARCH_URL}${encodeURIComponent(text)}`
}

/** `cursor.com/changelog`: host without `www.` plus the path, for lists. */
export function displayAddress(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.host.replace(/^www\./, "")
    const path = parsed.pathname === "/" ? "" : parsed.pathname
    return `${host}${path}`
  } catch {
    return url
  }
}

/** The page's title, else its address. */
export function pageLabel(page: {
  url: string | null
  title?: string | null
}): string {
  const title = page.title?.trim()
  if (title) return title
  return page.url ? displayAddress(page.url) : "New Tab"
}

export interface HistoryGroup<T> {
  label: "Today" | "Yesterday" | "This week" | "Older"
  entries: T[]
}

/** Visits grouped by local day, newest first; empty groups are left out. */
export function groupVisits<T extends { visitedAt: number }>(
  visits: readonly T[],
  now = Date.now()
): HistoryGroup<T>[] {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const startOfToday = today.getTime()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 6)
  const groups: HistoryGroup<T>[] = [
    { label: "Today", entries: [] },
    { label: "Yesterday", entries: [] },
    { label: "This week", entries: [] },
    { label: "Older", entries: [] },
  ]
  for (const visit of [...visits].sort((a, b) => b.visitedAt - a.visitedAt)) {
    const group =
      visit.visitedAt >= startOfToday
        ? groups[0]
        : visit.visitedAt >= yesterday.getTime()
          ? groups[1]
          : visit.visitedAt >= weekAgo.getTime()
            ? groups[2]
            : groups[3]
    group!.entries.push(visit)
  }
  return groups.filter((group) => group.entries.length > 0)
}
