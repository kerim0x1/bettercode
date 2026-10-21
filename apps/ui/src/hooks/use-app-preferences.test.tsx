import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAppPreferences } from "@/hooks/use-app-preferences"
import { useChatStore } from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { selectComposerModel } from "@/lib/composer-preferences"

// Render the real hook against current store snapshots without a DOM. Keep
// the real store actions so consecutive callbacks exercise persisted state.
vi.mock("@/lib/preferences-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/preferences-store")>()
  const store = actual.usePreferencesStore
  return {
    ...actual,
    usePreferencesStore: Object.assign(() => store.getState(), store),
  }
})

vi.mock("@/lib/chat-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat-store")>()
  const store = actual.useChatStore
  return {
    ...actual,
    useChatStore: Object.assign(
      <T,>(selector: (state: ReturnType<typeof store.getState>) => T) =>
        selector(store.getState()),
      store
    ),
  }
})

vi.mock("@/services/backend/chatApi", () => ({
  saveThreadModelSwitchActivity: vi.fn().mockResolvedValue(undefined),
}))

function preferences(threadId?: string | null) {
  let result!: ReturnType<typeof useAppPreferences>
  function Probe() {
    result = useAppPreferences(threadId)
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return result
}

describe("composer model changes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePreferencesStore.setState({
      selectedProviderId: "codex",
      selectedModel: "gpt-5.6-sol",
      modelSelectionByProvider: {
        codex: { selectedModel: "gpt-5.6-sol", thinkingMode: "High" },
        claude: { selectedModel: "claude-opus-5", thinkingMode: "max" },
      },
    })
    useChatStore.setState({
      activeThreadId: null,
      settingsByThread: {},
      activitiesByThread: {},
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it.each([null, "thread-a"])(
    "keeps Astra when the same dropdown click also updates context and reasoning (thread: %s)",
    (threadId) => {
      if (threadId) {
        useChatStore.setState({
          activeThreadId: threadId,
          settingsByThread: {
            [threadId]: {
              selectedProviderId: "codex",
              selectedModel: "gpt-5.6-sol",
              modelSelectionByProvider: {
                codex: { selectedModel: "gpt-5.6-sol", thinkingMode: "High" },
              },
            },
          },
        })
      }
      const before = preferences()
      before.setSelectedProviderId("codex")
      before.setSelectedModel("gpt-6-astra", "codex")
      before.setContextWindow("1m", "codex")
      before.setThinkingMode("ultra", "codex")

      expect(preferences().selectedModel).toBe("gpt-6-astra")
      expect(preferences().thinkingMode).toBe("ultra")
      expect(
        usePreferencesStore.getState().modelSelectionByProvider.codex
      ).toMatchObject({
        selectedModel: "gpt-6-astra",
        contextWindow: "1m",
        thinkingMode: "ultra",
      })
      expect(
        usePreferencesStore.getState().modelSelectionByProvider.claude
      ).toEqual({
        selectedModel: "claude-opus-5",
        thinkingMode: "max",
      })
    }
  )

  it("keeps both changes when models in different providers change before a rerender", () => {
    const before = preferences()
    before.setSelectedModel("gpt-6-astra", "codex")
    before.setSelectedModel("claude-sonnet-5", "claude")
    const selections = usePreferencesStore.getState().modelSelectionByProvider
    expect(selections.codex.selectedModel).toBe("gpt-6-astra")
    expect(selections.claude.selectedModel).toBe("claude-sonnet-5")
  })

  it("uses a pane's selected model for dispatch without overwriting another thread", () => {
    useChatStore.setState({
      activeThreadId: "thread-a",
      settingsByThread: {
        "thread-a": {
          selectedProviderId: "codex",
          selectedModel: "gpt-5.6-sol",
          modelSelectionByProvider: {
            codex: { selectedModel: "gpt-5.6-sol", thinkingMode: "High" },
          },
        },
        "thread-b": {
          selectedProviderId: "codex",
          selectedModel: "gpt-5.5",
          modelSelectionByProvider: {
            codex: { selectedModel: "gpt-5.5", thinkingMode: "Medium" },
          },
        },
      },
    })
    selectComposerModel("thread-b", "gpt-6-astra", "codex")
    expect(preferences().selectedModel).toBe("gpt-5.6-sol")
    expect(useChatStore.getState().settingsByThread["thread-b"]).toMatchObject({
      selectedModel: "gpt-6-astra",
      modelSelectionByProvider: {
        codex: { selectedModel: "gpt-6-astra", thinkingMode: "Medium" },
      },
    })
    useChatStore.setState({ activeThreadId: "thread-b" })
    expect(preferences().selectedModel).toBe("gpt-6-astra")
    selectComposerModel("thread-b", "gpt-5.5", "codex")
    expect(preferences().selectedModel).toBe("gpt-5.5")
    expect(
      useChatStore.getState().settingsByThread["thread-a"].selectedModel
    ).toBe("gpt-5.6-sol")
  })

  it("keeps legacy selections in both panes when the other pane changes its model", () => {
    useChatStore.setState({
      activeThreadId: "right",
      settingsByThread: {
        left: {
          selectedProviderId: "codex",
          selectedModel: "gpt-6-astra",
          thinkingMode: "ultra",
        },
        right: {
          selectedProviderId: "codex",
          selectedModel: "gpt-5.5",
          thinkingMode: "Medium",
        },
      },
    })
    expect(preferences("left").selectedModel).toBe("gpt-6-astra")
    expect(preferences("right").selectedModel).toBe("gpt-5.5")
    const left = preferences("left")
    left.setSelectedProviderId("codex")
    left.setSelectedModel("gpt-5.6-sol", "codex")
    left.setContextWindow("1m", "codex")
    left.setThinkingMode("High", "codex")
    expect(preferences("right").selectedModel).toBe("gpt-5.5")
    expect(preferences("right").thinkingMode).toBe("Medium")
    preferences("right").setSelectedModel("gpt-6-astra", "codex")
    expect(preferences("left").selectedModel).toBe("gpt-5.6-sol")
  })
})
