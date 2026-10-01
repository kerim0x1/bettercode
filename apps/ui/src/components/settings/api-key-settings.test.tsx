import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ApiKeyPoolView } from "@betterc0de/schema"
import { ApiKeySettingsPanel } from "./api-key-settings"

function render(
  view: ApiKeyPoolView | null,
  overrides: Partial<Parameters<typeof ApiKeySettingsPanel>[0]> = {}
) {
  return renderToStaticMarkup(
    <ApiKeySettingsPanel
      view={view}
      busy={false}
      error={null}
      label=""
      draftKey=""
      editing={null}
      editLabel=""
      replacement=""
      onLabelChange={() => {}}
      onKeyChange={() => {}}
      onEditLabelChange={() => {}}
      onReplacementChange={() => {}}
      onEdit={() => {}}
      onAdd={() => {}}
      onSave={() => {}}
      onEnable={() => {}}
      onRemove={() => {}}
      onTest={() => {}}
      onRetry={() => {}}
      onMove={() => {}}
      onUseExternal={() => {}}
      {...overrides}
    />
  )
}
const view: ApiKeyPoolView = {
  provider: "openai",
  enabled: true,
  managed: true,
  keys: [
    {
      id: "primary",
      label: "Primary",
      enabled: true,
      source: "settings",
      secret: { configured: true, storage: "encrypted" },
      status: "ready",
      message: null,
      retryAt: null,
      checkedAt: 1,
    },
    {
      id: "backup",
      label: "Backup",
      enabled: true,
      source: "settings",
      secret: { configured: true, storage: "encrypted" },
      status: "quota",
      message: "Update billing first.",
      retryAt: null,
      checkedAt: 1,
    },
  ],
}

describe("API key settings", () => {
  it("displays priority, visible status and encryption without filling saved credentials", () => {
    const html = render(view)
    expect(html).toContain("Priority 1")
    expect(html).toContain("Priority 2")
    expect(html).toContain("Available")
    expect(html).toContain("Billing required")
    expect(html).toContain("Encrypted on this device")
    expect(html).toContain("does not confirm remaining credits")
    expect(html).toContain('aria-label="New API key"')
    expect(html).toContain('type="password"')
    expect(html).toContain('value=""')
    expect(html).not.toMatch(/text-(?:emerald|red|amber)-/)
  })
  it("disables first-up and last-down movement and keeps keyboard-accessible action names", () => {
    const html = render(view)
    expect(
      html.match(/<button[^>]*aria-label="Move Primary up"[^>]*>/)?.[0]
    ).toContain('disabled=""')
    expect(
      html.match(/<button[^>]*aria-label="Move Backup down"[^>]*>/)?.[0]
    ).toContain('disabled=""')
    expect(html).toContain('aria-label="Enable Primary"')
    expect(html).toContain('aria-label="Remove Backup"')
  })
  it("keeps external credentials read-only and discloses when saved keys take over", () => {
    const html = render({
      ...view,
      managed: false,
      keys: [{ ...view.keys[0], source: "environment" }],
    })
    expect(html).toContain("Supplied by environment or CLI configuration")
    expect(html).toContain("switches this provider to your saved list")
    expect(html).not.toContain('aria-label="Remove Primary"')
    expect(html).not.toContain('aria-label="Enable Primary"')
  })
  it("shows loading, disabled-provider, empty, error and plain-storage states accurately", () => {
    expect(render(null)).toContain("Loading API keys")
    expect(render({ ...view, enabled: false, keys: [] })).toContain(
      "This provider is disabled"
    )
    expect(render({ ...view, keys: [] })).toContain("Add your first key")
    const html = render(
      {
        ...view,
        keys: [
          {
            ...view.keys[0],
            secret: { configured: true, storage: "plaintext" },
          },
        ],
      },
      { error: "Could not save." }
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain("Stored in plaintext on this device")
    expect(html).not.toContain("Encrypted on this device")
  })
  it("holds all mutations during a save and prevents checks until a server cooldown ends", () => {
    const waiting = {
      ...view,
      keys: [
        {
          ...view.keys[0],
          status: "cooldown" as const,
          retryAt: Date.now() + 60_000,
        },
      ],
    }
    const html = render(waiting, {
      busy: true,
      editing: "primary",
      editLabel: "Primary",
    })
    for (const button of html.match(/<button[^>]*>/g) ?? [])
      expect(button).toContain('disabled=""')
    expect(html).toContain('aria-label="Replacement API key"')
    expect(html).toContain("Retry after")
  })
})
