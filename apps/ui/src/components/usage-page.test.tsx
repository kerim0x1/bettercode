import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { ProviderUsageReport } from "@/services/backend"
import type { ReactNode } from "react"

const state = vi.hoisted(() => ({
  reports: [] as ProviderUsageReport[],
  loading: false,
  error: null as string | null,
  load: vi.fn(),
}))
vi.mock("@/lib/usage-store", () => ({ useUsageStore: () => state }))
// Render the portal's content inline so SSR can inspect both provider choices.
vi.mock("@/components/ui/simple-dropdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/simple-dropdown")>()),
  SimpleDropdown: ({
    trigger,
    children,
  }: {
    trigger: ReactNode
    children: ReactNode
  }) => (
    <>
      {trigger}
      {children}
    </>
  ),
}))
import { UsagePage, UsageLimitRow } from "./usage-page"

describe("usage overview", () => {
  beforeEach(() => {
    state.reports = []
    state.loading = false
    state.error = null
  })

  it("offers only Claude Code and Codex with their theme-aware logos before data loads", () => {
    state.loading = true
    const html = renderToStaticMarkup(<UsagePage onClose={() => {}} />)
    expect(html).toContain('src="/icons/providers/claude.svg"')
    expect(html).toContain('src="/icons/providers/openai.svg"')
    expect(html).toContain("dark:invert")
    expect(html).not.toContain("Grok")
    expect(html).toContain('aria-label="Select usage provider"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-busy="true"')
  })

  it("exposes request errors above the report", () => {
    state.error = "Could not update usage. Try refreshing again."
    const html = renderToStaticMarkup(<UsagePage onClose={() => {}} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain(state.error)
  })

  it.each([
    [0, "Available"],
    [75, "Getting close"],
    [95, "Almost at limit"],
    [100, "Limit reached"],
  ])(
    "gives %s percent limits an accessible meter and a text status",
    (usedPercent, status) => {
      const html = renderToStaticMarkup(
        <UsageLimitRow
          limit={{
            id: "weekly",
            label: "Weekly limit",
            usedPercent,
            resetsAt: null,
            resetLabel: "Resets tomorrow",
          }}
        />
      )
      expect(html).toContain('role="meter"')
      expect(html).toContain(`aria-valuenow="${usedPercent}"`)
      expect(html).toContain(status)
      expect(html).toContain("Resets tomorrow")
    }
  )

  it("keeps out-of-range provider values inside the meter bounds", () => {
    const html = renderToStaticMarkup(
      <UsageLimitRow
        limit={{
          id: "weekly",
          label: "Weekly limit",
          usedPercent: 110,
          resetsAt: null,
          resetLabel: null,
        }}
      />
    )
    expect(html).toContain('aria-valuenow="100"')
    expect(html).toContain("scaleX(1)")
  })
})
