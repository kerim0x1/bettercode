import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { ProviderUsageReport } from "@/services/backend/coreApi"
import { TooltipProvider } from "@/components/ui/tooltip"
import { localDayKey } from "@/lib/usage-overview"

const state = vi.hoisted(() => ({
  reports: [] as ProviderUsageReport[],
  loading: false,
  error: null as string | null,
  loadedAt: 0,
  load: vi.fn(() => Promise.resolve()),
}))
vi.mock("@/lib/usage-store", () => {
  const useUsageStore = (selector?: (value: typeof state) => unknown) =>
    selector ? selector(state) : state
  useUsageStore.getState = () => state
  return { useUsageStore }
})
import { UsagePage, type UsageView } from "./usage-page"

function render(view: UsageView = "cost") {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UsagePage onClose={() => {}} view={view} onViewChange={() => {}} />
    </TooltipProvider>
  )
}

function report(
  partial: Partial<ProviderUsageReport> & Pick<ProviderUsageReport, "provider">
): ProviderUsageReport {
  return {
    label: partial.provider,
    status: "ready",
    installed: true,
    authenticated: true,
    version: null,
    plan: null,
    source: "",
    fetchedAt: new Date().toISOString(),
    scannedMs: 0,
    summary: {
      totalTokens: 1000,
      tokens: {
        input: 100,
        output: 100,
        reasoning: 0,
        cacheRead: 700,
        cacheWrite: 100,
      },
      peakDayTokens: 0,
      peakDayDate: null,
      longestSessionMs: 0,
      currentStreakDays: 0,
      longestStreakDays: 0,
      sessions: 3,
      messages: 0,
      activeDays: 1,
      firstActivity: null,
      lastActivity: null,
      cost: null,
    },
    daily: [],
    pricing: null,
    pricesFile: null,
    models: [],
    insights: [],
    lists: [],
    limits: [],
    limitsObservedAt: null,
    limitNotes: [],
    notes: [],
    ...partial,
  }
}

describe("usage page", () => {
  beforeEach(() => {
    state.reports = []
    state.loading = false
    state.error = null
  })

  it("offers Cost, Tokens and Limits and shows both providers' logos while loading", () => {
    state.loading = true
    const html = render()
    expect(html).toContain('role="tablist"')
    for (const label of ["Cost", "Tokens", "Limits"]) {
      expect(html).toContain(`>${label}</button>`)
    }
    expect(html).toContain('src="/icons/providers/claude.svg"')
    expect(html).toContain('src="/icons/providers/openai.svg"')
    expect(html).toContain("dark:invert")
    expect(html).not.toContain("Grok")
    expect(html).toContain('aria-busy="true"')
  })

  it("exposes request errors above the views", () => {
    state.error = "Could not update usage. Try refreshing again."
    const html = render()
    expect(html).toContain('role="alert"')
    expect(html).toContain(state.error)
  })

  it("adds the providers into one total with their share", () => {
    const today = localDayKey(Date.now())
    const day = (tokens: number) => [
      { date: today, tokens, messages: 0, sessions: 1 },
    ]
    state.reports = [
      report({ provider: "claude", daily: day(3000) }),
      report({ provider: "codex", daily: day(1000) }),
    ]
    const html = render("tokens")
    // Today's 3K + 1K tokens in the 30-day range, Claude's share of them.
    expect(html).toContain("4K")
    expect(html).toContain("75.0%")
    expect(html).toContain("Where the tokens go")
  })

  it.each([
    [0, "Available"],
    [75, "Getting close"],
    [95, "Almost at limit"],
    [100, "Limit reached"],
  ])(
    "gives a %s percent used limit an accessible meter and a text status",
    (usedPercent, status) => {
      state.reports = [
        report({
          provider: "codex",
          limits: [
            {
              id: "weekly",
              label: "Weekly limit",
              usedPercent,
              resetsAt: null,
              resetLabel: "Resets someday",
            },
          ],
        }),
      ]
      const html = render("limits")
      expect(html).toContain('role="meter"')
      expect(html).toContain(`aria-valuenow="${100 - usedPercent}"`)
      expect(html).toContain(status)
      expect(html).toContain("someday")
    }
  )
})
