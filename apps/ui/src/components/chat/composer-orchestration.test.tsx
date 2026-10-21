// @vitest-environment jsdom
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatOrchestration } from "@betterc0de/schema"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useOrchestrationDraft } from "@/lib/orchestration-composer-store"
import type { UiProvider } from "@/lib/provider-types"
import {
  ComposerOrchestrationBadge,
  ComposerOrchestrationMenu,
} from "./composer-orchestration"

const state = vi.hoisted(() => ({
  settings: { orchestratorEnabled: true },
  threads: {} as Record<
    string,
    { orchestration?: ChatOrchestration; orchestrationWorker?: boolean }
  >,
  update: vi.fn(),
  setThreadSetting: vi.fn(),
  status: vi.fn(),
  stop: vi.fn(),
}))

vi.mock("@/lib/settings-store", () => {
  const getState = () => ({ ...state.settings, update: state.update })
  return {
    useSettingsStore: Object.assign(
      (select: (value: ReturnType<typeof getState>) => unknown) =>
        select(getState()),
      { getState }
    ),
  }
})
vi.mock("@/lib/chat-store", () => {
  const getState = () => ({
    settingsByThread: state.threads,
    setThreadSetting: state.setThreadSetting,
  })
  return {
    useChatStore: Object.assign(
      (select: (value: ReturnType<typeof getState>) => unknown) =>
        select(getState()),
      { getState }
    ),
  }
})
vi.mock("@/services/backend/orchestratorApi", () => ({
  getOrchestratorStatus: state.status,
  stopOrchestrator: state.stop,
}))

const claude: UiProvider = {
  id: "claude",
  providerKind: "claude",
  providerInstanceId: "claude",
  name: "Claude",
  logo: "",
  models: [],
}
const codex: UiProvider = {
  id: "codex",
  providerKind: "codex",
  providerInstanceId: "work",
  name: "Codex",
  logo: "",
  models: [
    {
      id: "test-codex",
      name: "Codex model",
      context: "1m",
      tier: "Main",
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            type: "select",
            label: "Thinking",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
}
const grok: UiProvider = {
  id: "grok",
  providerKind: "grok_cli",
  providerInstanceId: "grok",
  name: "Grok",
  logo: "",
  models: [
    { id: "test-grok", name: "Grok model", context: "1m", tier: "Main" },
  ],
}

// All interactions stay in jsdom; no app window or desktop input is used.
describe("orchestration panel", () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    state.settings.orchestratorEnabled = true
    state.threads = {}
    state.update.mockReset().mockImplementation(async () => {
      state.settings.orchestratorEnabled = true
    })
    state.setThreadSetting.mockReset()
    state.status.mockReset().mockResolvedValue({ status: "ready" })
    state.stop.mockReset().mockResolvedValue(undefined)
    useOrchestrationDraft.getState().set({ enabled: false })
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })
  async function render(
    props: Partial<ComponentProps<typeof ComposerOrchestrationMenu>> = {}
  ) {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ComposerOrchestrationMenu
            threadId={null}
            currentProvider={claude}
            currentModelName="Claude model"
            providers={[claude, codex, grok]}
            isStreaming={false}
            {...props}
          />
        </TooltipProvider>
      )
    )
  }
  async function renderBadge(
    props: Partial<ComponentProps<typeof ComposerOrchestrationBadge>> = {}
  ) {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ComposerOrchestrationBadge
            threadId={null}
            currentProvider={claude}
            providers={[claude, codex, grok]}
            isStreaming={false}
            {...props}
          />
        </TooltipProvider>
      )
    )
  }
  function named(label: string) {
    const element = [
      ...document.querySelectorAll<HTMLElement>("[aria-label]"),
    ].find((item) => item.getAttribute("aria-label") === label)
    expect(element, label).toBeDefined()
    return element!
  }
  async function click(element: HTMLElement) {
    await act(async () => {
      if (element.getAttribute("data-slot") === "dropdown-menu-trigger") {
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          })
        )
      } else element.click()
    })
  }
  async function key(element: Element, key: string) {
    await act(async () => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  async function open() {
    await click(host.querySelector("button")!)
  }
  async function hover(element: HTMLElement) {
    await act(async () => {
      const event = new MouseEvent("pointermove", { bubbles: true })
      Object.defineProperty(event, "pointerType", { value: "mouse" })
      element.dispatchEvent(event)
      await new Promise((resolve) => setTimeout(resolve, 175))
    })
  }

  it("lists selected models and reveals each model's live thinking only on hover or focus", async () => {
    const personal: UiProvider = {
      ...codex,
      providerInstanceId: "personal",
      name: "Personal account",
      models: [
        {
          ...codex.models[0]!,
          name: "Personal model",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                type: "select",
                label: "Thinking",
                options: [{ id: "xhigh", label: "Extra High" }],
              },
            ],
          },
        },
      ],
    }
    const workModel = {
      providerKind: "codex" as const,
      providerInstanceId: "work",
      modelId: "test-codex",
      reasoningEffort: "high",
    }
    const personalModel = {
      ...workModel,
      providerInstanceId: "personal",
      reasoningEffort: "xhigh",
    }
    useOrchestrationDraft.getState().set({
      enabled: true,
      providers: ["codex"],
      models: [workModel, personalModel],
    })
    await renderBadge({ providers: [claude, personal, codex, grok] })
    expect(named("Selected agent models").children).toHaveLength(2)
    const workBadge = named("Codex model, Codex")
    const personalBadge = named("Personal model, Personal account")
    expect(host.textContent).toContain("Orchestration")
    expect(host.textContent).toContain("2 models")
    expect(host.textContent).not.toContain("High")
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    await hover(workBadge)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      "ThinkingHigh"
    )
    expect(workBadge.getAttribute("aria-describedby")).toBe(
      document.querySelector('[role="tooltip"]')?.id
    )
    await key(workBadge, "Escape")
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => personalBadge.focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      "ThinkingExtra High"
    )
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
    expect(host.textContent).not.toContain("Grok model")
    await act(async () =>
      useOrchestrationDraft.getState().set({
        enabled: true,
        providers: ["codex"],
        models: [{ ...personalModel, reasoningEffort: null }],
      })
    )
    expect(named("Selected agent models").children).toHaveLength(1)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      "ThinkingAutoProvider default"
    )
    expect(personalBadge.isConnected).toBe(true)
    expect(host.textContent).toContain("1 model")
    await key(personalBadge, "Escape")
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    expect(document.activeElement).toBe(personalBadge)
    await act(async () =>
      useOrchestrationDraft.getState().set({ enabled: false })
    )
    expect(host.childElementCount).toBe(0)
  })

  it("uses the saved thread pool, keeps cached and missing models visible, shows a saved Ultracode as Auto, and excludes the main provider", async () => {
    const cachedClaude: UiProvider = {
      ...claude,
      modelsReady: false,
      models: [
        {
          id: "test-claude",
          name: "Claude model",
          context: "1m",
          tier: "Main",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                type: "select",
                label: "Thinking",
                options: [{ id: "ultracode", label: "Ultra Code" }],
              },
            ],
          },
        },
      ],
    }
    useOrchestrationDraft
      .getState()
      .set({ enabled: true, providers: ["codex"] })
    state.threads.chat = {
      orchestration: {
        enabled: true,
        providers: ["claude", "codex", "grok_cli"],
        models: [
          {
            providerKind: "claude",
            providerInstanceId: "claude",
            modelId: "test-claude",
            reasoningEffort: "ultracode",
          },
          {
            providerKind: "codex",
            providerInstanceId: "removed-account",
            modelId: "removed-model",
            reasoningEffort: "custom-effort",
          },
          {
            providerKind: "grok_cli",
            providerInstanceId: "grok",
            modelId: "test-grok",
          },
        ],
      },
    }
    await renderBadge({
      threadId: "chat",
      currentProvider: grok,
      providers: [cachedClaude, codex, grok],
    })
    expect(named("Selected agent models").children).toHaveLength(2)
    const claudeBadge = named("Claude model, Claude")
    const missingBadge = named("removed-model, removed-account")
    expect(host.textContent).toContain("2 models")
    await act(async () => claudeBadge.focus())
    // Ultracode starts its own agents, so workers never keep it.
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      "ThinkingAutoProvider default"
    )
    expect(
      document.querySelector('[role="tooltip"]')?.textContent
    ).not.toContain("Ultra Code")
    await act(async () => missingBadge.focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      "custom-effort"
    )
    expect(host.textContent).not.toContain("Grok model")
    expect(host.textContent).not.toContain("Codex model")
  })

  it("expands legacy provider selections after discovery and hides disabled orchestration", async () => {
    useOrchestrationDraft
      .getState()
      .set({ enabled: true, providers: ["codex"] })
    await renderBadge({ providers: [claude, { ...codex, modelsReady: false }] })
    expect(host.textContent).toContain("Loading selected models")
    await renderBadge()
    expect(named("Codex model, Codex").tagName).toBe("BUTTON")
    state.settings.orchestratorEnabled = false
    await renderBadge()
    expect(host.childElementCount).toBe(0)
  })

  it("collapses a long row into a count and adjusts thinking from an entry", async () => {
    const many: UiProvider = {
      ...codex,
      models: Array.from({ length: 6 }, (_, index) => ({
        ...codex.models[0]!,
        id: `model-${index + 1}`,
        name: `Model ${index + 1}`,
      })),
    }
    useOrchestrationDraft.getState().set({
      enabled: true,
      providers: ["codex"],
      models: many.models.map((model) => ({
        providerKind: "codex" as const,
        providerInstanceId: "work",
        modelId: model.id,
      })),
    })
    await renderBadge({ providers: [claude, many, grok] })
    expect(host.textContent).toContain("6 models")
    expect(named("Selected agent models").children).toHaveLength(5)
    const more = named("2 more models")
    expect(more.textContent).toBe("+2")
    await act(async () => more.focus())
    const preview = document.querySelector('[role="tooltip"]')?.textContent
    expect(preview).toContain("Model 5")
    expect(preview).toContain("Model 6")
    expect(preview).not.toContain("Model 4")
    await key(more, "Escape")

    // A click on an entry opens that model's thinking slider.
    const first = named("Model 1, Codex")
    await key(first, "Enter")
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!
    expect(slider).not.toBeNull()
    expect(document.activeElement).toBe(slider)
    await key(slider, "End")
    expect(slider.getAttribute("aria-valuetext")).toBe("High")
    expect(useOrchestrationDraft.getState().selection).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({
          modelId: "model-1",
          reasoningEffort: "high",
        }),
      ]),
    })
    await key(slider, "Escape")
    expect(document.querySelector('[role="slider"]')).toBeNull()
    expect(document.activeElement).toBe(first)

    // The count lists the collapsed models, each with its own slider.
    await key(more, "Enter")
    await key(named("Model 6 thinking"), "ArrowRight")
    const nested = document.querySelector<HTMLElement>('[role="slider"]')!
    expect(document.activeElement).toBe(nested)
    await key(nested, "End")
    expect(useOrchestrationDraft.getState().selection).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({
          modelId: "model-6",
          reasoningEffort: "high",
        }),
      ]),
    })
    await key(nested, "Escape")
    expect(document.querySelector('[role="menu"]')).toBeNull()

    // Thinking stays visible but read-only while a turn runs.
    await renderBadge({ providers: [claude, many, grok], isStreaming: true })
    await key(named("Model 2, Codex"), "Enter")
    expect(document.querySelector('[role="slider"]')).toBeNull()
    expect(
      document.querySelector('[data-slot="dropdown-menu-content"]')?.textContent
    ).toContain("after this turn finishes")
  })

  it("edits model choices and thinking in one panel, then restores focus on Escape", async () => {
    await render()
    const trigger = named("Orchestration: Off")
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu")
    await open()
    const panel = document.querySelector('[data-slot="dropdown-menu-content"]')!
    expect(panel.textContent).toContain("Experimental")
    expect(document.activeElement).toBe(named("Enable orchestration"))
    await click(named("OpenAI subagent models"))
    await click(named("Codex model"))
    expect(useOrchestrationDraft.getState().selection).toMatchObject({
      enabled: true,
      models: [{ modelId: "test-codex" }],
    })
    const thinking = named("Codex model thinking")
    expect(thinking.getAttribute("role")).toBe("menuitem")
    await act(async () => named("Codex model").focus())
    await key(named("Codex model"), "ArrowDown")
    expect(document.activeElement).toBe(thinking)
    await key(thinking, "ArrowRight")
    expect(document.querySelector("select")).toBeNull()
    const slider = document.querySelector<HTMLElement>('[role="slider"]')!
    expect(slider).not.toBeNull()
    expect(document.activeElement).toBe(slider)
    await key(slider, "End")
    expect(slider.getAttribute("aria-valuetext")).toBe("High")
    expect(useOrchestrationDraft.getState().selection).toMatchObject({
      models: [{ reasoningEffort: "high" }],
    })
    await click(named("Reset to Auto"))
    expect(useOrchestrationDraft.getState().selection).toMatchObject({
      models: [{ reasoningEffort: null }],
    })
    await key(slider, "End")
    await key(slider, "Escape")
    expect(document.querySelector('[role="slider"]')).toBeNull()
    // The shared dropdown dismisses its complete menu chain on Escape.
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    await open()
    await click(named("Grok subagent models"))
    await click(named("Grok model"))
    expect(useOrchestrationDraft.getState().selection).toMatchObject({
      enabled: true,
      models: [
        { modelId: "test-codex", reasoningEffort: "high" },
        { modelId: "test-grok" },
      ],
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "2 models selected for delegation."
    )
    expect(
      document.querySelectorAll('[data-slot="dropdown-menu-content"]')
    ).toHaveLength(1)
    expect(named("Orchestration: On")).toBe(trigger)
    await key(document.activeElement!, "Escape")
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it("toggles off a ready thread session through the existing stop flow", async () => {
    state.threads.chat = {
      orchestration: {
        enabled: true,
        providers: ["codex"],
        models: [
          {
            providerKind: "codex",
            providerInstanceId: "work",
            modelId: "test-codex",
          },
        ],
      },
    }
    await render({ threadId: "chat" })
    await open()
    await click(named("Enable orchestration"))
    expect(state.status).toHaveBeenCalledWith("chat")
    expect(state.stop).toHaveBeenCalledWith("chat")
    expect(state.setThreadSetting).toHaveBeenCalledWith(
      "chat",
      "orchestration",
      { enabled: false }
    )
  })

  it.each(["streaming", "worker"])(
    "locks mutations for a %s chat while allowing inspection",
    async (lock) => {
      if (lock === "worker") state.threads.chat = { orchestrationWorker: true }
      await render({
        threadId: lock === "worker" ? "chat" : null,
        isStreaming: lock === "streaming",
      })
      await open()
      expect(named("Enable orchestration").getAttribute("aria-disabled")).toBe(
        "true"
      )
      await click(named("OpenAI subagent models"))
      const model = named("Codex model")
      expect(model.getAttribute("aria-disabled")).toBe("true")
      await click(model)
      expect(useOrchestrationDraft.getState().selection).toEqual({
        enabled: false,
      })
      expect(state.update).not.toHaveBeenCalled()
      expect(state.setThreadSetting).not.toHaveBeenCalled()
    }
  )

  it("explains unavailable catalogs and prevents enabling an empty pool", async () => {
    await render({ providers: [claude] })
    await open()
    expect(named("Enable orchestration").getAttribute("aria-disabled")).toBe(
      "true"
    )
    expect(document.body.textContent).toContain(
      "Connect another provider in Settings"
    )
    await click(named("OpenAI subagent models"))
    expect(document.body.textContent).toContain(
      "No supported models available."
    )
  })

  it("keeps failures visible and allows retry without closing the panel", async () => {
    state.settings.orchestratorEnabled = false
    state.update.mockRejectedValueOnce(new Error("Could not save settings"))
    await render()
    await open()
    await click(named("Enable orchestration"))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not save settings"
    )
    expect(useOrchestrationDraft.getState().selection).toEqual({
      enabled: false,
    })
    expect(
      named("Enable orchestration").getAttribute("aria-disabled")
    ).not.toBe("true")
    await click(named("Enable orchestration"))
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(useOrchestrationDraft.getState().selection).toMatchObject({
      enabled: true,
      providers: ["codex"],
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })
})
