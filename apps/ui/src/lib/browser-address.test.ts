import { describe, expect, it } from "vitest"
import {
  SEARCH_URL,
  displayAddress,
  groupVisits,
  pageLabel,
  resolveAddress,
} from "@/lib/browser-address"
import { recentPages, withVisit, withVisitInfo } from "@/lib/browser-store"
import { deviceUserAgent } from "@/components/browser-preview/constants"

describe("deviceUserAgent", () => {
  const base =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) betterc0de/0.1.0 Chrome/146.0.7680.216 Electron/41.5.0 Safari/537.36"

  it("claims a phone or a tablet on the app's own Chrome version", () => {
    expect(deviceUserAgent("mobile", base)).toContain("Mobile Safari")
    expect(deviceUserAgent("mobile", base)).toContain("Chrome/146.0.0.0")
    expect(deviceUserAgent("tablet", base)).not.toContain("Mobile")
    expect(deviceUserAgent("tablet", base)).toContain("Android")
  })

  it("keeps the guest's own user agent on desktop", () => {
    expect(deviceUserAgent("desktop", base)).toBeNull()
  })
})

describe("resolveAddress", () => {
  it.each([
    ["https://cursor.com/docs", "https://cursor.com/docs"],
    ["cursor.com/changelog", "https://cursor.com/changelog"],
    ["localhost:5173", "http://localhost:5173/"],
    ["127.0.0.1:3000/app", "http://127.0.0.1:3000/app"],
    ["myhost.local", "http://myhost.local/"],
  ])("opens %s as %s", (input, url) => {
    expect(resolveAddress(input)).toBe(url)
  })

  it("searches anything that is not an address", () => {
    expect(resolveAddress("react server components")).toBe(
      `${SEARCH_URL}react%20server%20components`
    )
    expect(resolveAddress("tailwind")).toBe(`${SEARCH_URL}tailwind`)
    expect(resolveAddress("   ")).toBeNull()
  })

  it("never opens another scheme", () => {
    expect(resolveAddress("javascript:alert(1)")).toBe(
      `${SEARCH_URL}javascript%3Aalert(1)`
    )
  })
})

describe("labels", () => {
  it("shows host and path without www", () => {
    expect(displayAddress("https://www.cursor.com/changelog")).toBe(
      "cursor.com/changelog"
    )
    expect(displayAddress("https://cursor.com/")).toBe("cursor.com")
  })

  it("prefers the title, then the address, then New Tab", () => {
    expect(pageLabel({ url: "https://a.dev/x", title: "A" })).toBe("A")
    expect(pageLabel({ url: "https://a.dev/x", title: " " })).toBe("a.dev/x")
    expect(pageLabel({ url: null })).toBe("New Tab")
  })
})

describe("groupVisits", () => {
  it("groups by local day, newest first", () => {
    const now = new Date(2026, 9, 15, 12).getTime()
    const at = (day: number) => new Date(2026, 9, day, 9).getTime()
    const groups = groupVisits(
      [
        { url: "a", visitedAt: at(15) },
        { url: "b", visitedAt: at(14) },
        { url: "c", visitedAt: at(11) },
        { url: "d", visitedAt: at(1) },
      ],
      now
    )
    expect(groups.map((group) => [group.label, group.entries[0]!.url])).toEqual(
      [
        ["Today", "a"],
        ["Yesterday", "b"],
        ["This week", "c"],
        ["Older", "d"],
      ]
    )
  })
})

describe("browser history", () => {
  const visit = (url: string, visitedAt: number) => ({
    url,
    title: null,
    favicon: null,
    visitedAt,
  })

  it("updates a repeat of the newest visit instead of adding one", () => {
    const history = withVisit(
      [visit("https://a.dev/", 1)],
      {
        url: "https://a.dev/",
        title: "A",
      },
      5
    )
    expect(history).toEqual([
      { url: "https://a.dev/", title: "A", favicon: null, visitedAt: 5 },
    ])
  })

  it("fills a late title into the newest visit of that address", () => {
    const history = [visit("https://b.dev/", 3), visit("https://a.dev/", 2)]
    expect(
      withVisitInfo(history, "https://a.dev/", { title: "A" })[1]
    ).toMatchObject({ title: "A", visitedAt: 2 })
    expect(
      withVisitInfo(history, "https://a.dev/", { title: "A" })
    ).toHaveLength(2)
  })

  it("lists each address once in Recents", () => {
    const history = [
      visit("https://a.dev/", 3),
      visit("https://b.dev/", 2),
      visit("https://a.dev/", 1),
    ]
    expect(recentPages(history).map((page) => page.url)).toEqual([
      "https://a.dev/",
      "https://b.dev/",
    ])
  })
})
