import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PREFERENCE_DEFAULTS,
  providerActivationKeys,
  usePreferencesStore,
} from "@/lib/preferences-store"

if (typeof globalThis.localStorage === "undefined") {
  const storage = new Map<string, string>()
  ;(
    globalThis as unknown as {
      localStorage: Pick<
        Storage,
        "clear" | "getItem" | "removeItem" | "setItem"
      >
    }
  ).localStorage = {
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    removeItem: (key) => {
      storage.delete(key)
    },
    setItem: (key, value) => {
      storage.set(key, value)
    },
  }
}

const STORAGE_KEY = "betterc0de-preferences"

describe("PREFERENCE_DEFAULTS", () => {
  beforeEach(() => {
    localStorage.clear()
    usePreferencesStore.setState(PREFERENCE_DEFAULTS)
  })

  afterEach(() => {
    usePreferencesStore.getState().reset()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it("starts new chats on the Claude CLI default provider/model", () => {
    expect(PREFERENCE_DEFAULTS.selectedProviderId).toBe("claude")
    expect(PREFERENCE_DEFAULTS.selectedModel).toBe("claude-fable-5-1")
    expect(PREFERENCE_DEFAULTS.modelSelectionByProvider).toEqual({})
    expect(PREFERENCE_DEFAULTS.editorWordWrap).toBe(false)
    expect(PREFERENCE_DEFAULTS.editorMinimap).toBe(true)
    expect(PREFERENCE_DEFAULTS.editorStickyScroll).toBe(true)
    expect(PREFERENCE_DEFAULTS.editorRenderWhitespace).toBe(false)
    expect(PREFERENCE_DEFAULTS.editorInlayHints).toBe(true)
    expect(PREFERENCE_DEFAULTS.editorLineNumbers).toBe(true)
    expect(PREFERENCE_DEFAULTS.hiddenProviders).toEqual([
      "or-qwen",
      "or-deepseek",
    ])
    expect(PREFERENCE_DEFAULTS.promptHistoryEntries).toEqual([])
    expect(PREFERENCE_DEFAULTS.promptStashEntries).toEqual([])
    expect(PREFERENCE_DEFAULTS.providerVisibilityDefaultsVersion).toBe(12)
  })

  it("restores the Agent workspace browser view from saved preferences", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...PREFERENCE_DEFAULTS, workspaceTab: "browser" })
    )

    usePreferencesStore.getState().load()

    expect(usePreferencesStore.getState().workspaceTab).toBe("browser")
  })

  it("treats OpenRouter and direct provider ids as the same activation family", () => {
    expect(providerActivationKeys("or-qwen")).toEqual(["or-qwen", "qwen"])
    expect(providerActivationKeys("qwen")).toEqual(["or-qwen", "qwen"])
    expect(providerActivationKeys("or-deepseek")).toEqual([
      "or-deepseek",
      "deepseek",
    ])
    expect(providerActivationKeys("deepseek")).toEqual([
      "or-deepseek",
      "deepseek",
    ])
  })

  it.each([8, 10, 11])(
    "rolls hidden Qwen and DeepSeek defaults forward for existing visibility version %s",
    (providerVisibilityDefaultsVersion) => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...PREFERENCE_DEFAULTS,
          hiddenProviders: [],
          providerVisibilityDefaultsVersion,
        })
      )

      usePreferencesStore.getState().load()

      expect(usePreferencesStore.getState().hiddenProviders).toEqual([
        "or-qwen",
        "or-deepseek",
      ])
      expect(
        usePreferencesStore.getState().providerVisibilityDefaultsVersion
      ).toBe(12)
    }
  )

  it.each([
    ["or-qwen", ["or-deepseek"]],
    ["qwen", ["or-deepseek"]],
    ["qwen-work", ["or-deepseek"]],
    ["or-deepseek", ["or-qwen"]],
    ["deepseek", ["or-qwen"]],
    ["deepseek-main", ["or-qwen"]],
  ])(
    "keeps activated hidden-default provider family %s visible",
    (selectedProviderId, expectedHiddenProviders) => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...PREFERENCE_DEFAULTS,
          selectedProviderId,
          hiddenProviders: [],
          providerVisibilityDefaultsVersion: 8,
        })
      )

      usePreferencesStore.getState().load()

      expect(usePreferencesStore.getState().hiddenProviders).toEqual(
        expectedHiddenProviders
      )
    }
  )

  it("keeps Qwen visible when an older preference has Qwen model selection state", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...PREFERENCE_DEFAULTS,
        selectedProviderId: "codex",
        modelSelectionByProvider: {
          "qwen-work": { selectedModel: "qwen/qwen3-235b-a22b:free" },
        },
        hiddenProviders: [],
        providerVisibilityDefaultsVersion: 8,
      })
    )

    usePreferencesStore.getState().load()

    expect(usePreferencesStore.getState().hiddenProviders).toEqual([
      "or-deepseek",
    ])
  })

  it("keeps DeepSeek visible when an older preference has DeepSeek favorites", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...PREFERENCE_DEFAULTS,
        selectedProviderId: "codex",
        favorites: ["deepseek-main::deepseek/deepseek-r1:free"],
        hiddenProviders: [],
        providerVisibilityDefaultsVersion: 8,
      })
    )

    usePreferencesStore.getState().load()

    expect(usePreferencesStore.getState().hiddenProviders).toEqual(["or-qwen"])
  })

  it("rejects malformed collection preferences instead of hydrating crash-prone values", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        selectedProviderId: "codex",
        hiddenProviders: "not-an-array",
        hiddenModels: { invalid: true },
        favorites: 42,
        promptHistoryEntries: "invalid-history",
        promptStashEntries: [null, { id: "missing-fields" }],
        modelSelectionByProvider: [],
        appMode: "not-a-mode",
        providerVisibilityDefaultsVersion: 12,
        injectedUnknownField: "must not enter the store",
      })
    )

    usePreferencesStore.getState().load()

    const state = usePreferencesStore.getState()
    expect(state.hiddenProviders).toEqual(PREFERENCE_DEFAULTS.hiddenProviders)
    expect(state.hiddenModels).toEqual([])
    expect(state.favorites).toEqual([])
    expect(state.promptHistoryEntries).toEqual([])
    expect(state.promptStashEntries).toEqual([])
    expect(state.modelSelectionByProvider).toEqual({})
    expect(state.appMode).toBe(PREFERENCE_DEFAULTS.appMode)
    expect(
      (state as unknown as Record<string, unknown>).injectedUnknownField
    ).toBeUndefined()
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").injectedUnknownField
    ).toBeUndefined()
  })

  it("removes malformed preference JSON after falling back to defaults", () => {
    localStorage.setItem(STORAGE_KEY, "{broken")

    usePreferencesStore.getState().load()

    expect(usePreferencesStore.getState().selectedModel).toBe(
      PREFERENCE_DEFAULTS.selectedModel
    )
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("validates and bounds persisted prompt history and stash entries", () => {
    const entries = Array.from({ length: 60 }, (_, index) => ({
      id: `entry-${index}`,
      input: `prompt ${index}`,
      timestamp: index,
      threadId: index % 2 === 0 ? `thread-${index}` : null,
      projectPath: null,
    }))
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...PREFERENCE_DEFAULTS,
        promptHistoryEntries: [
          { id: "invalid", input: 123, timestamp: 0 },
          ...entries,
        ],
        promptStashEntries: entries,
      })
    )

    usePreferencesStore.getState().load()

    const state = usePreferencesStore.getState()
    expect(state.promptHistoryEntries).toHaveLength(50)
    expect(state.promptHistoryEntries[0]?.id).toBe("entry-10")
    expect(state.promptHistoryEntries.at(-1)?.id).toBe("entry-59")
    expect(state.promptStashEntries).toHaveLength(50)
    expect(state.promptStashEntries[0]?.id).toBe("entry-10")
  })

  it("merges a debounced dirty key with preferences saved by another window", () => {
    vi.useFakeTimers()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...PREFERENCE_DEFAULTS,
        selectedModel: "remote-model",
        sidebarWidth: 320,
      })
    )

    usePreferencesStore.getState().set("sidebarWidth", 444)
    vi.advanceTimersByTime(100)

    const persisted = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}"
    ) as Record<string, unknown>
    expect(persisted.selectedModel).toBe("remote-model")
    expect(persisted.sidebarWidth).toBe(444)
  })

  it("deep-merges independent provider selection changes", () => {
    vi.useFakeTimers()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...PREFERENCE_DEFAULTS,
        modelSelectionByProvider: {
          codex: { selectedModel: "remote-codex", fastMode: true },
          claude: { selectedModel: "remote-claude" },
        },
      })
    )

    usePreferencesStore.getState().set("modelSelectionByProvider", {
      codex: { thinkingMode: "High" },
    })
    vi.advanceTimersByTime(100)

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as {
      modelSelectionByProvider: Record<string, Record<string, unknown>>
    }
    expect(persisted.modelSelectionByProvider.codex).toEqual({
      selectedModel: "remote-codex",
      fastMode: true,
      thinkingMode: "High",
    })
    expect(persisted.modelSelectionByProvider.claude).toEqual({
      selectedModel: "remote-claude",
    })
  })

  it("cancels a pending debounced save during reset", () => {
    vi.useFakeTimers()
    usePreferencesStore.getState().set("selectedModel", "pending-model")

    usePreferencesStore.getState().reset()
    vi.advanceTimersByTime(100)

    expect(usePreferencesStore.getState().selectedModel).toBe(
      PREFERENCE_DEFAULTS.selectedModel
    )
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("uses the reset epoch to stop an old window flush before its storage event", async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const firstWindow = await import("@/lib/preferences-store")
    firstWindow.usePreferencesStore
      .getState()
      .set("selectedModel", "stale-window-model")

    vi.resetModules()
    const secondWindow = await import("@/lib/preferences-store")
    secondWindow.usePreferencesStore.getState().reset()
    vi.advanceTimersByTime(100)

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("syncs storage events, preserves local dirty keys, and installs one listener", async () => {
    vi.useFakeTimers()
    const listeners = new Map<string, Set<(event: unknown) => void>>()
    const fakeWindow = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        const registered = listeners.get(type) ?? new Set()
        registered.add(listener)
        listeners.set(type, registered)
      },
      removeEventListener: (
        type: string,
        listener: (event: unknown) => void
      ) => {
        listeners.get(type)?.delete(listener)
      },
    }
    vi.stubGlobal("window", fakeWindow)

    try {
      vi.resetModules()
      await import("@/lib/preferences-store")
      vi.resetModules()
      const activeWindow = await import("@/lib/preferences-store")
      expect(listeners.get("storage")?.size).toBe(1)

      activeWindow.usePreferencesStore.setState(
        activeWindow.PREFERENCE_DEFAULTS
      )
      activeWindow.usePreferencesStore.getState().set("sidebarWidth", 480)
      activeWindow.usePreferencesStore.getState().set("appMode", "agent")
      const remoteValue = JSON.stringify({
        ...activeWindow.PREFERENCE_DEFAULTS,
        selectedModel: "external-model",
        sidebarWidth: 360,
        appMode: "design",
      })
      localStorage.setItem(STORAGE_KEY, remoteValue)
      const storageListener = [...(listeners.get("storage") ?? [])][0]
      storageListener?.({ key: STORAGE_KEY, newValue: remoteValue })

      expect(activeWindow.usePreferencesStore.getState().selectedModel).toBe(
        "external-model"
      )
      expect(activeWindow.usePreferencesStore.getState().sidebarWidth).toBe(480)
      expect(activeWindow.usePreferencesStore.getState().appMode).toBe("agent")

      // Even after this window has saved its changes, a neighbouring window
      // may change its own mode without switching this one.
      activeWindow.usePreferencesStore.getState().save()
      storageListener?.({ key: STORAGE_KEY, newValue: remoteValue })
      expect(activeWindow.usePreferencesStore.getState().appMode).toBe("agent")

      localStorage.removeItem(STORAGE_KEY)
      storageListener?.({ key: STORAGE_KEY, newValue: null })
      vi.advanceTimersByTime(100)
      expect(activeWindow.usePreferencesStore.getState().sidebarWidth).toBe(
        activeWindow.PREFERENCE_DEFAULTS.sidebarWidth
      )
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    } finally {
      const registrationOwner = globalThis as typeof globalThis & {
        __bcPreferencesListenerRegistration?: { dispose: () => void }
      }
      registrationOwner.__bcPreferencesListenerRegistration?.dispose()
      delete registrationOwner.__bcPreferencesListenerRegistration
      vi.unstubAllGlobals()
    }
  })
})
