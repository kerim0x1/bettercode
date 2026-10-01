import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type {
  NineRouterConnectionView,
  NineRouterProviderView,
} from "@betterc0de/schema"
import {
  NineRouterSettingsPanel,
  type NineRouterSettingsPanelProps,
} from "./ninerouter-settings"

function render(overrides: Partial<NineRouterSettingsPanelProps> = {}) {
  return renderToStaticMarkup(
    <NineRouterSettingsPanel
      view={null}
      detection={null}
      busy={null}
      error={null}
      onToggleProvider={() => {}}
      onDetect={() => {}}
      onAdd={async () => true}
      onEdit={async () => true}
      onToggleConnection={() => {}}
      onTest={() => {}}
      onRemove={() => {}}
      onSetHidden={() => {}}
      onSetCustom={() => {}}
      onOpenExternal={() => {}}
      {...overrides}
    />
  )
}

const online: NineRouterConnectionView = {
  id: "vps",
  name: "VPS",
  baseUrl: "https://router.example.com/v1",
  dashboardUrl: "https://router.example.com/dashboard",
  enabled: true,
  tokenSaver: false,
  secret: { configured: true, storage: "encrypted" },
  customModels: [],
  hiddenModels: [],
  status: {
    state: "online",
    message: null,
    version: "0.5.95",
    latestVersion: "0.5.96",
    latencyMs: 42,
    modelCount: 1,
    checkedAt: 1,
  },
  models: [
    {
      slug: "cc/claude-opus-5-5",
      name: "cc/claude-opus-5-5",
      tier: "Claude Code",
      isCustom: false,
      hidden: false,
    },
  ],
}

const view = (
  connections: NineRouterConnectionView[]
): NineRouterProviderView => ({ enabled: true, connections })

describe("NineRouterSettingsPanel", () => {
  it("shows loading before the first response", () => {
    expect(render()).toContain("Loading 9Router connections")
  })

  it("guides setup when no router is connected", () => {
    const html = render({
      view: view([]),
      detection: {
        found: false,
        baseUrl: null,
        version: null,
        alreadyConnected: false,
      },
    })
    expect(html).toContain("npx 9router")
    expect(html).toContain("Look for a local router")
    expect(html).toContain("No router answered on localhost:20128")
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Add and check/)
  })

  it("offers a detected local router", () => {
    const html = render({
      view: view([]),
      detection: {
        found: true,
        baseUrl: "http://localhost:20128/v1",
        version: "0.5.95",
        alreadyConnected: false,
      },
    })
    expect(html).toContain("9Router is running on this computer")
    expect(html).toContain("v0.5.95")
    expect(html).toContain("Use this router")
    expect(html).toContain('role="status"')
  })

  it("hides the detection banner once the router is connected", () => {
    const html = render({
      view: view([online]),
      detection: {
        found: true,
        baseUrl: "http://localhost:20128/v1",
        version: "0.5.95",
        alreadyConnected: true,
      },
    })
    expect(html).not.toContain("9Router is running on this computer")
  })

  it("shows a connection's status, key state and actions without the key", () => {
    const html = render({ view: view([online]) })
    expect(html).toContain("VPS")
    expect(html).toContain("https://router.example.com/v1")
    expect(html).toContain("Online")
    expect(html).toContain("v0.5.95 · 42 ms · 1 model")
    expect(html).toContain("API key saved · encrypted")
    expect(html).toContain("Token saver off")
    expect(html).toContain("9Router 0.5.96 is available")
    expect(html).toContain("Check and reload models")
    expect(html).toContain("Dashboard")
    expect(html).toContain('aria-label="Remove VPS"')
    expect(html).toContain("Models (1)")
    expect(html).toContain('type="password"')
    expect(html).not.toMatch(/text-(emerald|red|amber)-/)
  })

  it("explains a router that needs a key", () => {
    const html = render({
      view: view([
        {
          ...online,
          secret: { configured: false, storage: "encrypted" },
          status: {
            ...online.status,
            state: "auth_required",
            message:
              "This 9Router requires an API key. Create one in the 9Router dashboard (Keys) and add it here.",
          },
        },
      ]),
    })
    expect(html).toContain("Needs API key")
    expect(html).toContain("No API key")
    expect(html).toContain("requires an API key")
    expect(html).toContain("text-warning")
  })

  it("disables actions while a change is saved", () => {
    const html = render({ view: view([online]), busy: "vps" })
    expect(html).toContain("Checking…")
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>.*Check and reload models/
    )
    expect(html).toContain('aria-busy="true"')
  })

  it("announces errors", () => {
    const html = render({ view: view([]), error: "Enter the 9Router address" })
    expect(html).toContain('role="alert"')
    expect(html).toContain("Enter the 9Router address")
  })
})
