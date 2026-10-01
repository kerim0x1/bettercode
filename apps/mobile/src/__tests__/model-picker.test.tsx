import { describe, expect, it, jest } from "@jest/globals"
import { fireEvent, render, screen } from "@testing-library/react-native"
import type { NineRouterConnectionView } from "@betterc0de/schema"
import { ModelPicker } from "@/components/model-picker"
import { providerLogoMark } from "@/components/provider-logo"
import { modelOptions } from "@/lib/provider-selection"
import type { ModelOption, ProviderInstance } from "@/types/remote"

const claude: ProviderInstance = {
  instanceId: "claude",
  driver: "claude",
  displayName: "Claude",
  enabled: true,
  configured: true,
  installed: true,
  status: "ready",
  availability: "available",
  models: [{ slug: "claude-opus-5-5", name: "Opus 5.5" }],
}

function connection(id: string, name: string): NineRouterConnectionView {
  return {
    id,
    name,
    baseUrl: "",
    dashboardUrl: "",
    enabled: true,
    tokenSaver: true,
    secret: { configured: true, storage: "encrypted" },
    customModels: [],
    hiddenModels: [],
    status: {
      state: "online",
      message: null,
      version: null,
      latestVersion: null,
      latencyMs: 10,
      modelCount: 3,
      checkedAt: 1,
    },
    models: [
      {
        slug: "fast-combo",
        name: "fast-combo",
        tier: "Combos",
        isCustom: false,
        hidden: false,
      },
      {
        slug: "cc/claude-opus-5-5",
        name: "Claude Opus 5.5",
        tier: "Claude Code",
        isCustom: false,
        hidden: false,
      },
      {
        slug: "cx/gpt-5.5",
        name: "GPT-5.5",
        tier: "Codex",
        isCustom: false,
        hidden: false,
      },
    ],
  }
}

function renderPicker(onSelect: (option: ModelOption) => void = () => {}) {
  const options = modelOptions([claude], {
    enabled: true,
    connections: [connection("laptop", "Laptop"), connection("vps", "VPS")],
  })
  return render(
    <ModelPicker
      visible
      options={options}
      selected={options[0] ?? null}
      onSelect={onSelect}
      onClose={() => {}}
    />
  )
}

describe("ModelPicker with 9Router", () => {
  it("shows each 9Router connection as its own group, after the CLIs", async () => {
    await renderPicker()
    expect(
      screen
        .getAllByText(/^(Claude|9Router · \w+)$/)
        .map((label) => label.props.children)
    ).toEqual(["Claude", "9Router · Laptop", "9Router · VPS"])
    expect(
      screen.getAllByText("Claude Code · cc/claude-opus-5-5")
    ).toHaveLength(2)
    expect(screen.getAllByTestId("provider-logo-ninerouter")).toHaveLength(6)
  })

  it("filters a long 9Router list by its group and picks the model as listed", async () => {
    const onSelect = jest.fn((_option: ModelOption) => {})
    await renderPicker(onSelect)
    await fireEvent.changeText(
      screen.getByLabelText("Filter provider or model"),
      "codex"
    )
    expect(screen.queryByText("Claude Opus 5.5")).toBeNull()
    const rows = screen.getAllByText("GPT-5.5")
    expect(rows).toHaveLength(2)
    await fireEvent.press(rows[1]!)
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKind: "ninerouter",
        providerInstanceId: "ninerouter:vps",
        modelId: "cx/gpt-5.5",
      })
    )
  })
})

describe("provider logo", () => {
  it("shows the 9Router mark for both spellings of the kind", () => {
    expect(providerLogoMark("ninerouter")).toBe("ninerouter")
    expect(providerLogoMark("9Router")).toBe("ninerouter")
    expect(providerLogoMark("claude")).toBe("claude")
    expect(providerLogoMark("codex")).toBe("openai")
    expect(providerLogoMark("demo")).toBeNull()
  })
})
