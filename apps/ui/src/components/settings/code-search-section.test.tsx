import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { CodeSearchSettingsPanel } from "./code-search-section"

vi.mock("@/services/backend/coreApi", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}))
vi.mock("@/lib/settings-store", () => ({
  SETTINGS_UPDATED_EVENT: "settings-updated",
}))

function render(
  settings: {
    enabled: boolean
    configured: boolean
    storage: "encrypted" | "plaintext"
  } | null,
  saving = false
) {
  return renderToStaticMarkup(
    <CodeSearchSettingsPanel
      settings={settings}
      saving={saving}
      draftKey=""
      error={null}
      onKeyChange={() => {}}
      onEnabledChange={() => {}}
      onSaveKey={() => {}}
      onRemoveKey={() => {}}
    />
  )
}

describe("Jev settings disclosure and controls", () => {
  it("keeps activation disabled before settings load and before a key is configured", () => {
    for (const settings of [
      null,
      { enabled: false, configured: false, storage: "encrypted" as const },
    ]) {
      const html = render(settings)
      const toggle = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0]
      expect(toggle).toContain('disabled=""')
      expect(toggle).toContain('aria-checked="false"')
      expect(html).toContain(
        "selected file paths and short code excerpts to TypeSafe AI"
      )
      expect(html).toContain("New sessions receive the tools")
    }
  })

  it("allows revocation even if an enabled integration has lost its key", () => {
    const html = render({
      enabled: true,
      configured: false,
      storage: "encrypted",
    })
    const toggle = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0]
    expect(toggle).toContain('aria-checked="true"')
    expect(toggle).not.toContain('disabled=""')
  })

  it("renders a blank replacement field and does not claim encryption when storage is plaintext", () => {
    const html = render({
      enabled: false,
      configured: true,
      storage: "plaintext",
    })
    expect(html).toContain("Key saved in plaintext on this device")
    expect(html).toContain('type="password"')
    expect(html).toContain('placeholder="Replace saved key"')
    expect(html).toContain('value=""')
    expect(html).toContain("Remove key")
    expect(html).not.toContain("Key saved and encrypted")
  })

  it("disables activation while a mutation is being saved", () => {
    const html = render(
      { enabled: false, configured: true, storage: "encrypted" },
      true
    )
    expect(html.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).toContain(
      'disabled=""'
    )
  })

  it("says it is off by default and shows the CLIs that receive the tools", () => {
    const html = render(null)
    expect(html).toContain("Off by default.")
    for (const name of ["Claude Code", "Codex", "Cursor", "Grok CLI"]) {
      expect(html).toContain(`alt="${name}"`)
    }
    expect(html).toContain("Jev is TypeSafe AI&#x27;s ranking model")
  })
})
