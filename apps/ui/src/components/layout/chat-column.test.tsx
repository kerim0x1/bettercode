import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatColumn } from "./chat-column"
import { useChatStore } from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import type { ChatInputArea } from "@/components/chat/chat-input-area"
import type { UiProvider } from "@/lib/provider-types"

const rendered = vi.hoisted(() => ({
  input: null as ComponentProps<typeof ChatInputArea> | null,
}))
vi.mock("@/components/layout/chat-top-bar", () => ({ ChatTopBar: () => null }))
vi.mock("@/components/chat/chat-transcript", () => ({
  ChatTranscript: () => null,
}))
vi.mock("@/components/chat/provider-status-banner", () => ({
  ProviderStatusBanner: () => null,
}))
vi.mock("@/components/layout/agent-terminal-diff", () => ({
  AgentTerminalDiff: () => null,
}))
vi.mock("@/hooks/use-chat-streaming-state", () => ({
  useChatStreamingState: () => ({ allPlans: [], isStreaming: false }),
  useThreadPersistedPlans: () => [],
}))
vi.mock("@/components/chat/chat-input-area", () => ({
  ChatInputArea: (props: ComponentProps<typeof ChatInputArea>) => {
    rendered.input = props
    return createElement(
      "span",
      { "aria-label": props.composerProps.currentModelName },
      props.thinkingMode
    )
  },
}))
vi.mock("@/lib/preferences-store", async (original) => {
  const actual = await original<typeof import("@/lib/preferences-store")>()
  return {
    ...actual,
    usePreferencesStore: Object.assign(
      () => actual.usePreferencesStore.getState(),
      actual.usePreferencesStore
    ),
  }
})
vi.mock("@/lib/chat-store", async (original) => {
  const actual = await original<typeof import("@/lib/chat-store")>()
  const store = actual.useChatStore
  return {
    ...actual,
    useChatStore: Object.assign(
      <T,>(selector: (state: ReturnType<typeof store.getState>) => T) =>
        selector(store.getState()),
      store
    ),
    useThreadById: (id: string) =>
      store.getState().threads.find((thread) => thread.id === id),
    useThreadMessages: () => [],
    useThreadActivities: () => [],
  }
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("chat pane composer", () => {
  it("renders and updates its own settings and submits an explicit thread id", async () => {
    vi.useFakeTimers()
    const provider: UiProvider = {
      id: "codex",
      name: "Codex",
      logo: "",
      models: [
        {
          id: "gpt-6-astra",
          name: "GPT-6 Astra",
          context: "runtime",
          tier: "Runtime",
        },
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          context: "runtime",
          tier: "Runtime",
        },
      ],
      modelsReady: false,
    }
    usePreferencesStore.setState({
      selectedProviderId: "codex",
      selectedModel: "gpt-5.6-sol",
      modelSelectionByProvider: {},
    })
    useChatStore.setState({
      activeThreadId: "a",
      threads: [],
      messagesLoadedByThread: { b: true },
      activitiesLoadedByThread: { b: true },
      settingsByThread: {
        a: {
          permissionLevel: "bypass",
          thinkingMode: "low",
          selectedModel: "gpt-5.6-sol",
        },
        b: {
          permissionLevel: "read-only",
          selectedProviderId: "codex",
          selectedModel: "gpt-5.6-sol",
          modelSelectionByProvider: {
            codex: {
              selectedModel: "gpt-6-astra",
              thinkingMode: "ultra",
              fastMode: true,
            },
          },
        },
      },
    })
    const otherSettings = useChatStore.getState().settingsByThread.a
    const handleSubmit = vi.fn()
    type Props = ComponentProps<typeof ChatColumn>
    const props: Props = {
      threadId: "b",
      tabId: "pane-b",
      isActive: false,
      onActivate: vi.fn(),
      appMode: "agent",
      handleSubmit,
      sidebarOpen: false,
      setSidebarOpen: vi.fn(),
      minimalChat: true,
      chatMode: "agent",
      setConfirmAction: vi.fn(),
      setPlanModalContent: vi.fn(),
      selectedProvider: provider,
      selectedModel: "gpt-5.6-sol",
      thinkingMode: "low",
      specialMode: null,
      permissionLevel: "bypass",
      // The composer is mocked; it never reads these.
      deepgram: null as unknown as Props["deepgram"],
      terminalOpen: false,
      setTerminalOpen: vi.fn(),
      diffOpen: false,
      setDiffOpen: vi.fn(),
      composerProps: {
        providers: [provider],
        selectedProvider: provider,
        currentProvider: provider,
        selectedModel: "gpt-5.6-sol",
        currentModelName: "GPT-5.6 Sol",
        thinkingMode: "low",
        permissionLevel: "bypass",
      } as unknown as Props["composerProps"],
    }
    const html = renderToStaticMarkup(createElement(ChatColumn, props))
    expect(html).toContain('aria-label="GPT-6 Astra"')
    expect(html).toContain("ultra")
    expect(html).not.toContain("GPT-5.6 Sol")
    expect(html).not.toContain("data-editor-empty-chat")
    useChatStore.setState({
      threads: [
        {
          id: "b",
          title: "B",
          projectName: "B",
          projectPath: "/repo-b",
          messages: [],
          createdAt: "2026-09-13T00:00:00Z",
          updatedAt: "2026-09-13T00:00:00Z",
        },
      ],
    })
    const emptyEditor = renderToStaticMarkup(
      createElement(ChatColumn, { ...props, appMode: "editor" })
    )
    expect(emptyEditor).toContain("data-editor-empty-chat")
    expect(emptyEditor.indexOf("data-editor-empty-chat")).toBeLessThan(
      emptyEditor.indexOf('aria-label="GPT-6 Astra"')
    )
    useChatStore.setState({ threads: [] })
    expect(rendered.input?.permissionLevel).toBe("read-only")
    expect(rendered.input?.composerProps.fastMode).toBe(true)
    rendered.input?.composerProps.setThinkingMode("medium", "codex")
    rendered.input?.composerProps.setPermissionLevel("ask-on-edit")
    expect(useChatStore.getState().settingsByThread.b?.permissionLevel).toBe(
      "ask-on-edit"
    )
    expect(
      useChatStore.getState().settingsByThread.b?.modelSelectionByProvider
        ?.codex.thinkingMode
    ).toBe("medium")
    expect(useChatStore.getState().settingsByThread.a).toBe(otherSettings)
    rendered.input?.setPlanModalContent("Implement this plan")
    expect(props.setPlanModalContent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Implement this plan",
        threadId: "b",
      })
    )
    await rendered.input?.composerProps.handleSubmit({
      text: "Hello",
      files: [],
    })
    expect(handleSubmit).toHaveBeenCalledWith({
      threadId: "b",
      text: "Hello",
      files: [],
    })
    rendered.input = null
    const unavailable = renderToStaticMarkup(
      createElement(ChatColumn, { ...props, appMode: "editor" })
    )
    expect(unavailable).toContain("Conversation unavailable")
    expect(rendered.input).toBeNull()

    // Canvas mode mounts this same column: per-thread settings, the shared
    // composer, no editor-only chrome or gate.
    const design = renderToStaticMarkup(
      createElement(ChatColumn, { ...props, appMode: "design" })
    )
    expect(design).toContain('aria-label="GPT-6 Astra"')
    expect(design).not.toContain("Conversation unavailable")
    expect(design).not.toContain("data-editor-empty-chat")
    expect(rendered.input?.composerProps.appMode).toBe("design")
    expect(rendered.input?.composerProps.minimalChat).toBe(true)
  })
})
