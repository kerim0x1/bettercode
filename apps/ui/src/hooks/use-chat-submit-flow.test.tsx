import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useChatSubmit } from "@/hooks/use-chat-submit"
import { useMessageQueueStore } from "@/lib/message-queue-store"
import { useChatStore } from "@/lib/chat-store"
import { usePreferencesStore } from "@/lib/preferences-store"
import { useSettingsStore } from "@/lib/settings-store"
import { sendChatMessage, sendGoalControl } from "@/services/backend"
import { resolveProviderTarget } from "@/lib/resolve-provider-target"
import {
  buildBetterC0deDefaultAgentContext,
  providerSkillSlashPrompt,
  runRegisteredSlashCommand,
} from "@/lib/slash-command-runtime"
import { selectComposerModel } from "@/lib/composer-preferences"
import type { UiProvider } from "@/lib/provider-types"
import { HttpError } from "@/lib/errors/types"
import { useBrowserContextStore } from "@/lib/browser-context-store"
import { readBrowserElementAttachment } from "@betterc0de/schema"

vi.mock("@/services/backend", () => ({
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
  sendGoalControl: vi.fn().mockResolvedValue(undefined),
  saveThreadMessage: vi.fn().mockResolvedValue(undefined),
  upsertThreadMeta: vi.fn().mockResolvedValue(undefined),
  saveThreadModelSwitchActivity: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/resolve-provider-target", () => ({
  resolveProviderTarget: vi.fn().mockResolvedValue({
    providerKind: "codex",
    providerInstanceId: "codex",
    openaiTransport: null,
  }),
}))
vi.mock("@/lib/slash-command-runtime", () => ({
  buildBetterC0deDefaultAgentContext: vi.fn().mockResolvedValue(null),
  buildBetterC0deDefaultCommandPrompt: () => null,
  buildBetterC0dePrTerminalCommand: () => ({ shouldOpen: false }),
  buildBetterC0dePrTerminalOutput: vi.fn(),
  buildProjectCommandPrompt: vi.fn().mockResolvedValue(null),
  buildProjectReferenceMentionContext: vi.fn(),
  buildProjectSkillCommandPrompt: vi.fn().mockResolvedValue(null),
  defaultPromptForMode: vi.fn(),
  dispatchPrefilledTerminalCommand: vi.fn(),
  extractBetterC0deMentions: () => [],
  isProviderNativeSlashCommand: vi.fn(),
  listProjectReferencesSafe: vi.fn(),
  listProjectRuntimeSkills: vi.fn(),
  listProjectRuntimeSubagents: vi.fn(),
  mergeRuntimeSkills: vi.fn(),
  mergeRuntimeSubagents: vi.fn(),
  normalizeChatAttachments: () => [],
  readActiveProviderComposerSelection: () => null,
  recordPromptHistory: vi.fn(),
  providerSkillSlashPrompt: vi.fn().mockReturnValue(null),
  resolveProjectCommandModelOverride: () => null,
  runRegisteredSlashCommand: vi.fn(),
  stripModeSlashPrompt: vi.fn(),
}))

const codex: UiProvider = {
  id: "codex",
  name: "Codex",
  providerKind: "codex",
  providerInstanceId: "codex",
  logo: "",
  models: ["gpt-6-astra", "gpt-5.6-sol"].map((id) => ({
    id,
    name: id,
    context: "runtime",
    tier: "Runtime",
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "medium", label: "Medium" },
            { id: "ultra", label: "Ultra" },
          ],
        },
      ],
    },
  })),
}
const threads = ["a", "b"].map((id) => ({
  id,
  title: id,
  projectName: id,
  projectPath: `/repo-${id}`,
  messages: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
}))

function handler(providers: UiProvider[] = [codex]) {
  let submit!: ReturnType<typeof useChatSubmit>
  function Probe() {
    submit = useChatSubmit({
      providers,
      appMode: "agent",
      closeSlash: vi.fn(),
      closeMention: vi.fn(),
    })
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  return submit
}

describe("chat submission ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    useMessageQueueStore.setState({ messages: [] })
    useBrowserContextStore.setState({ byThread: {} })
    useSettingsStore.setState({ autoSaveConversations: false })
    usePreferencesStore.setState({
      selectedProviderId: "codex",
      selectedModel: "gpt-6-astra",
      modelSelectionByProvider: {},
      thinkingMode: "ultra",
      chatMode: "agent",
      specialMode: null,
      permissionLevel: "read-only",
      fastMode: false,
    })
    useChatStore.setState({
      threads: threads.map((thread) => ({ ...thread, messages: [] })),
      activeThreadId: "a",
      streamingByThread: {},
      settingsByThread: {},
      activitiesByThread: {},
      messagesLoadedByThread: { a: true, b: true },
      activitiesLoadedByThread: { a: true, b: true },
    })
  })

  it("does not send a stored model withdrawn from the ready catalog", async () => {
    const provider = {
      ...codex,
      modelsReady: true,
      models: codex.models.slice(1),
    }
    await handler([provider])({ text: "Hello", files: [] })
    expect(sendChatMessage).not.toHaveBeenCalled()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it.each(["/goal pause", "/goal status", "/goal clear"])(
    "sends %s immediately to its own chat without resolving or starting a provider",
    async (text) => {
      useChatStore.getState().appendStreamDelta("a", "Working")
      const queued = useMessageQueueStore
        .getState()
        .enqueue("a", { text: "Later", files: [], browserElements: [] })
      await handler()({ text, files: [], threadId: "a" })
      expect(sendGoalControl).toHaveBeenCalledExactlyOnceWith(
        "a",
        text,
        "gpt-6-astra"
      )
      expect(resolveProviderTarget).not.toHaveBeenCalled()
      expect(sendChatMessage).not.toHaveBeenCalled()
      expect(
        useMessageQueueStore.getState().messages.map((entry) => entry.id)
      ).toEqual([queued.id])
      expect(useChatStore.getState().threads[0].messages).toHaveLength(0)
      expect(useChatStore.getState().streamingByThread.a.isStreaming).toBe(true)
    }
  )

  it.each(["claude", "grok_cli", "codex"])(
    "routes goals through the selected %s provider without adding a normal chat message",
    async (providerKind) => {
      const provider: UiProvider = {
        ...codex,
        id: providerKind,
        providerKind,
        providerInstanceId: `${providerKind}-instance`,
      }
      usePreferencesStore.setState({ selectedProviderId: provider.id })
      for (const text of ["/goal Fix My UI", "/goal continue"]) {
        vi.mocked(resolveProviderTarget).mockResolvedValueOnce({
          providerKind,
          providerInstanceId: provider.providerInstanceId!,
          openaiTransport: null,
        })
        await handler([provider])({ text, files: [], threadId: "a" })
        expect(resolveProviderTarget).toHaveBeenLastCalledWith(
          provider,
          "gpt-6-astra"
        )
        const request = vi.mocked(sendChatMessage).mock.calls.at(-1)!
        expect(request.slice(0, 4)).toEqual([
          "a",
          text,
          "gpt-6-astra",
          providerKind,
        ])
        expect(request[6]).toBe("/repo-a")
        expect(request[8]).toBe("read-only")
        expect(request[11]).toBe(provider.providerInstanceId)
      }
      expect(runRegisteredSlashCommand).not.toHaveBeenCalled()
      expect(useChatStore.getState().threads[0].messages).toHaveLength(0)
      expect(useChatStore.getState().streamingByThread.a?.isStreaming).not.toBe(
        true
      )
    }
  )

  it("sends edited multiline text and literal paste markers intact to their own chats", async () => {
    const textA =
      "Edited introduction\n  const count = 42\n\n" +
      "long pasted text ".repeat(100) +
      "\n[Pasted ~3 lines #1]"
    const textB = "Another chat\n  different pasted text\n[Pasted ~3 lines #1]"
    await handler()({ text: textA, files: [], threadId: "a" })
    await handler()({ text: textB, files: [], threadId: "b" })
    expect(
      vi.mocked(sendChatMessage).mock.calls.map((call) => call.slice(0, 2))
    ).toEqual([
      ["a", textA],
      ["b", textB],
    ])
    expect(
      useChatStore
        .getState()
        .threads.map((thread) => thread.messages[0].content)
    ).toEqual([textA, textB])
  })

  it("retains editable pasted text when queued delivery fails and is retried", async () => {
    const text =
      "Edited paste\n  original indentation\n\n" +
      "content ".repeat(100) +
      "\n[Pasted ~3 lines #1]"
    useChatStore.getState().appendStreamDelta("a", "Working")
    await handler()({ text, files: [], threadId: "a" })
    const entry = useMessageQueueStore.getState().messages[0]
    expect(entry.payload.text).toBe(text)
    useChatStore.getState().clearStreaming("a")
    useChatStore.getState().setActiveThread("b")
    const payload = {
      ...entry.payload,
      threadId: "a",
      queuedSubmission: {
        id: entry.id,
        createdAt: entry.createdAt,
        browserElements: [],
      },
    }
    vi.mocked(sendChatMessage).mockRejectedValueOnce(
      new Error("Connection lost")
    )
    await expect(handler()(payload)).rejects.toThrow("Connection lost")
    await handler()(payload)
    expect(
      vi.mocked(sendChatMessage).mock.calls.map((call) => call.slice(0, 2))
    ).toEqual([
      ["a", text],
      ["a", text],
    ])
    expect(useChatStore.getState().threads[1].messages).toEqual([])
  })

  it("dispatches a typed skill through the existing turn path and retains the user's slash text", async () => {
    vi.mocked(providerSkillSlashPrompt).mockReturnValueOnce(
      "$seo-audit inspect this project"
    )
    await handler()({
      text: "/seo-audit inspect this project",
      files: [],
      threadId: "a",
    })
    expect(runRegisteredSlashCommand).not.toHaveBeenCalled()
    const request = vi.mocked(sendChatMessage).mock.calls[0]
    expect(request[0]).toBe("a")
    expect(request[1]).toBe("$seo-audit inspect this project")
    expect(request[14]).toMatchObject({
      content: "/seo-audit inspect this project",
    })
    expect(useChatStore.getState().threads[0].messages[0].content).toBe(
      "/seo-audit inspect this project"
    )
  })

  it("sends captured element references with their owning chat and retains later picks", async () => {
    const element = {
      url: "https://example.com/",
      selector: "#buy",
      tagName: "button",
      text: "Buy",
      label: "Buy",
    }
    useBrowserContextStore.getState().add("a", element)
    const entered = Promise.withResolvers<void>()
    const context = Promise.withResolvers<string | null>()
    vi.mocked(buildBetterC0deDefaultAgentContext).mockImplementationOnce(() => {
      entered.resolve()
      return context.promise
    })
    const sending = handler()({
      text: "Make this smaller",
      files: [],
      threadId: "a",
    })
    await entered.promise
    useChatStore.getState().setActiveThread("b")
    useBrowserContextStore
      .getState()
      .add("a", { ...element, selector: "#later" })
    useBrowserContextStore.getState().add("b", element)
    context.resolve(null)
    await sending
    const request = vi.mocked(sendChatMessage).mock.calls[0]!
    expect(request[0]).toBe("a")
    expect(request[1]).toContain('"selector":"#buy"')
    expect(request[1]).not.toContain("#later")
    expect(request[14]).toMatchObject({ content: "Make this smaller" })
    expect(readBrowserElementAttachment(request[18]![0])).toEqual(element)
    expect(useChatStore.getState().threads[0].messages[0].attachments).toEqual(
      request[18]
    )
    expect(
      useBrowserContextStore.getState().byThread.a.map((item) => item.selector)
    ).toEqual(["#later"])
    expect(useBrowserContextStore.getState().byThread.b).toEqual([element])
  })

  it("retains selected elements when dispatch fails", async () => {
    const element = {
      url: "https://example.com/",
      selector: "#buy",
      tagName: "button",
      text: "Buy",
      label: "Buy",
    }
    useBrowserContextStore.getState().add("a", element)
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error("Offline"))
    await handler()({ text: "Change this", files: [], threadId: "a" })
    expect(useBrowserContextStore.getState().byThread.a).toEqual([element])
  })

  it("captures queued tags and attachments without consuming tags picked again for the next draft", async () => {
    const element = {
      url: "https://example.com/",
      selector: "#buy",
      tagName: "button",
      text: "Buy",
      label: "Buy",
    }
    const file = {
      type: "file",
      url: "data:text/plain;base64,SGk=",
      filename: "notes.txt",
    }
    useBrowserContextStore.getState().add("a", element)
    useChatStore.getState().appendStreamDelta("a", "Working")
    expect(
      await handler()({
        text: "Change this next",
        files: [file],
        threadId: "a",
      })
    ).toBe(true)
    const entry = useMessageQueueStore.getState().messages[0]
    expect(entry.payload.files).toEqual([file])
    expect(entry.payload.browserElements).toEqual([element])
    expect(useBrowserContextStore.getState().byThread.a).toEqual([])
    useBrowserContextStore.getState().add("a", element)
    useBrowserContextStore
      .getState()
      .add("a", { ...element, selector: "#later" })
    useChatStore.getState().clearStreaming("a")
    await handler()({
      ...entry.payload,
      threadId: "a",
      queuedSubmission: {
        id: entry.id,
        createdAt: entry.createdAt,
        browserElements: entry.payload.browserElements,
      },
    })
    expect(vi.mocked(sendChatMessage).mock.calls[0][1]).toContain(
      '"selector":"#buy"'
    )
    expect(vi.mocked(sendChatMessage).mock.calls[0][1]).not.toContain("#later")
    expect(
      useBrowserContextStore
        .getState()
        .byThread.a.map((value) => value.selector)
    ).toEqual(["#buy", "#later"])
  })

  it("reports failed queued delivery to the runner instead of dropping the pending message", async () => {
    const entry = useMessageQueueStore
      .getState()
      .enqueue("a", { text: "Pending", files: [], browserElements: [] })
    const payload = {
      ...entry.payload,
      threadId: "a",
      queuedSubmission: {
        id: entry.id,
        createdAt: entry.createdAt,
        browserElements: [],
      },
    }
    vi.mocked(sendChatMessage).mockRejectedValueOnce(
      new Error("Connection lost")
    )
    await expect(handler()(payload)).rejects.toThrow("Connection lost")
    expect(useMessageQueueStore.getState().messages[0].id).toBe(entry.id)
    await handler()(payload)
    expect(
      useChatStore
        .getState()
        .threads[0].messages.filter((message) => message.id === entry.id)
    ).toHaveLength(1)
  })

  it("queues additional messages during preparation without blocking another thread", async () => {
    const entered = Promise.withResolvers<void>()
    const context = Promise.withResolvers<string | null>()
    vi.mocked(buildBetterC0deDefaultAgentContext).mockImplementationOnce(() => {
      entered.resolve()
      return context.promise
    })
    const sending = handler()({ text: "First", files: [], threadId: "a" })
    await entered.promise
    expect(
      await handler()({ text: "Follow-up", files: [], threadId: "a" })
    ).toBe(true)
    expect(useMessageQueueStore.getState().messages[0]).toMatchObject({
      threadId: "a",
      payload: { text: "Follow-up" },
      status: "queued",
    })
    await handler()({ text: "Independent", files: [], threadId: "b" })
    context.resolve(null)
    await sending
    expect(
      vi.mocked(sendChatMessage).mock.calls.map((call) => call[0])
    ).toEqual(["b", "a"])
    expect(
      useChatStore
        .getState()
        .threads[0].messages.filter((m) => m.role === "user")
    ).toHaveLength(1)
    expect(
      await handler()({ text: "Still busy", files: [], threadId: "a" })
    ).toBe(true)
    useChatStore.getState().clearStreaming("a")
    const entry = useMessageQueueStore.getState().messages[0]
    await handler()({
      ...entry.payload,
      threadId: "a",
      queuedSubmission: {
        id: entry.id,
        createdAt: entry.createdAt,
        browserElements: entry.payload.browserElements,
      },
    })
    expect(sendChatMessage).toHaveBeenCalledTimes(3)
    expect(vi.mocked(sendChatMessage).mock.calls[2][14]).toMatchObject({
      id: entry.id,
      content: "Follow-up",
      createdAt: entry.createdAt,
    })
  })

  it("does not erase an active stream or generate error bubbles on a busy conflict", async () => {
    vi.mocked(sendChatMessage).mockImplementationOnce(async () => {
      useChatStore.getState().setActiveTurnId("a", "running-turn")
      useChatStore.getState().appendStreamDelta("a", "Existing work")
      throw new HttpError(
        "Thread 'a' already has active provider work.",
        409,
        "/chat/send"
      )
    })
    expect(await handler()({ text: "Hello", files: [], threadId: "a" })).toBe(
      false
    )
    expect(useChatStore.getState().streamingByThread.a).toMatchObject({
      isStreaming: true,
      activeTurnId: "running-turn",
      streamingText: "Existing work",
    })
    expect(
      useChatStore
        .getState()
        .threads[0].messages.some((m) => m.content.startsWith("Error:"))
    ).toBe(false)
    expect(await handler()({ text: "Retry", files: [], threadId: "a" })).toBe(
      true
    )
    expect(sendChatMessage).toHaveBeenCalledTimes(1)
  })

  it("keeps a pending message in its original chat when the user switches tabs", async () => {
    const entered = Promise.withResolvers<void>()
    const context = Promise.withResolvers<string | null>()
    vi.mocked(buildBetterC0deDefaultAgentContext).mockImplementationOnce(() => {
      entered.resolve()
      return context.promise
    })
    const sending = handler()({ text: "Review this project", files: [] })
    await entered.promise
    useChatStore.getState().setActiveThread("b")
    context.resolve("Context from project A")
    await sending

    expect(vi.mocked(sendChatMessage).mock.calls[0]?.[0]).toBe("a")
    expect(vi.mocked(sendChatMessage).mock.calls[0]?.[6]).toBe("/repo-a")
    expect(
      useChatStore.getState().threads.find((thread) => thread.id === "b")
        ?.messages
    ).toEqual([])
  })

  it("ends the spinner and shows the error when provider routing fails", async () => {
    vi.mocked(resolveProviderTarget).mockRejectedValueOnce(
      new Error("provider is unavailable")
    )
    await expect(
      handler()({ text: "Hello", files: [] })
    ).resolves.toBeUndefined()
    expect(useChatStore.getState().streamingByThread.a?.isStreaming).not.toBe(
      true
    )
    expect(
      useChatStore
        .getState()
        .threads.find((thread) => thread.id === "a")
        ?.messages.at(-1)?.content
    ).toContain("provider is unavailable")
    expect(sendChatMessage).not.toHaveBeenCalled()
  })

  it("uses a model selected after the last render and captures ownership before the lazy import", async () => {
    const submit = handler()
    selectComposerModel("a", "gpt-5.6-sol", "codex")
    const sending = submit({ text: "Hello", files: [] })
    useChatStore.getState().setActiveThread("b")
    await sending
    const request = vi.mocked(sendChatMessage).mock.calls[0]!
    expect(request[0]).toBe("a")
    expect(request[2]).toBe("gpt-5.6-sol")
    expect(useChatStore.getState().activeThreadId).toBe("b")
    expect(
      useChatStore.getState().threads.find((thread) => thread.id === "b")
        ?.messages
    ).toEqual([])
  })

  it("uses the explicit pane's model, reasoning, mode and permissions without a focus rerender", async () => {
    useChatStore.setState({
      settingsByThread: {
        a: { permissionLevel: "bypass", chatMode: "agent" },
        b: {
          selectedProviderId: "codex",
          selectedModel: "gpt-6-astra",
          permissionLevel: "read-only",
          chatMode: "plan",
          modelSelectionByProvider: {
            codex: {
              selectedModel: "gpt-5.6-sol",
              thinkingMode: "medium",
              fastMode: true,
            },
          },
        },
      },
    })
    await handler()({ threadId: "b", text: "Check B", files: [] })
    const request = vi.mocked(sendChatMessage).mock.calls[0]!
    expect(request.slice(0, 9)).toEqual([
      "b",
      "Check B",
      "gpt-5.6-sol",
      "codex",
      "Medium",
      "plan",
      "/repo-b",
      null,
      "read-only",
    ])
    expect(request[10]).toBe(true)
    expect(
      useChatStore.getState().threads.find((thread) => thread.id === "a")
        ?.messages
    ).toEqual([])
    expect(useChatStore.getState().settingsByThread.a?.permissionLevel).toBe(
      "bypass"
    )
  })

  it("keeps submitted provider options when routing finishes after another selection", async () => {
    const entered = Promise.withResolvers<void>()
    const routing =
      Promise.withResolvers<Awaited<ReturnType<typeof resolveProviderTarget>>>()
    const options = [{ id: "variant", value: "original" }]
    useChatStore.setState({
      settingsByThread: {
        a: {
          modelSelectionByProvider: { codex: { optionSelections: options } },
        },
        b: {
          modelSelectionByProvider: {
            codex: { optionSelections: [{ id: "variant", value: "other" }] },
          },
        },
      },
    })
    vi.mocked(resolveProviderTarget).mockImplementationOnce(() => {
      entered.resolve()
      return routing.promise
    })
    const sending = handler()({ text: "Hello", files: [] })
    await entered.promise
    useChatStore.getState().setActiveThread("b")
    useChatStore.getState().setThreadSetting("a", "modelSelectionByProvider", {
      codex: { optionSelections: [] },
    })
    routing.resolve({
      providerKind: "codex",
      providerInstanceId: "codex",
      openaiTransport: null,
    })
    await sending
    expect(vi.mocked(sendChatMessage).mock.calls[0]?.[19]).toEqual(options)
  })

  it("reports context failures in the source chat without clearing another chat's stream", async () => {
    const entered = Promise.withResolvers<void>()
    const context = Promise.withResolvers<string | null>()
    vi.mocked(buildBetterC0deDefaultAgentContext).mockImplementationOnce(() => {
      entered.resolve()
      return context.promise
    })
    const sending = handler()({ text: "Hello", files: [] })
    await entered.promise
    useChatStore.getState().setActiveThread("b")
    useChatStore.getState().appendStreamDelta("b", "Working")
    context.reject(new Error("Context could not be loaded"))
    await expect(sending).resolves.toBeUndefined()
    expect(sendChatMessage).not.toHaveBeenCalled()
    expect(
      useChatStore
        .getState()
        .threads.find((thread) => thread.id === "a")
        ?.messages.at(-1)?.content
    ).toContain("Context could not be loaded")
    expect(
      useChatStore.getState().threads.find((thread) => thread.id === "a")
        ?.messages[0]?.content
    ).toBe("Hello")
    expect(useChatStore.getState().streamingByThread.b?.isStreaming).toBe(true)
    expect(
      useChatStore.getState().threads.find((thread) => thread.id === "b")
        ?.messages
    ).toEqual([])
  })

  it("does not dispatch a prepared message after its source chat was deleted", async () => {
    const entered = Promise.withResolvers<void>()
    const context = Promise.withResolvers<string | null>()
    vi.mocked(buildBetterC0deDefaultAgentContext).mockImplementationOnce(() => {
      entered.resolve()
      return context.promise
    })
    const sending = handler()({ text: "Hello", files: [] })
    await entered.promise
    useChatStore.setState((state) => ({
      threads: state.threads.filter((thread) => thread.id !== "a"),
      activeThreadId: "b",
    }))
    context.resolve(null)
    await sending
    expect(sendChatMessage).not.toHaveBeenCalled()
    expect(useChatStore.getState().threads).toHaveLength(1)
    expect(useChatStore.getState().threads[0].messages).toEqual([])
  })

  it("creates a pending new chat with its original settings without stealing changed focus", async () => {
    useChatStore.setState({ activeThreadId: null })
    const entered = Promise.withResolvers<void>()
    const context = Promise.withResolvers<string | null>()
    vi.mocked(buildBetterC0deDefaultAgentContext).mockImplementationOnce(() => {
      entered.resolve()
      return context.promise
    })
    const sending = handler()({ text: "New conversation", files: [] })
    await entered.promise
    useChatStore.getState().setActiveThread("b")
    selectComposerModel("b", "gpt-5.6-sol", "codex")
    context.resolve(null)
    await sending
    const request = vi.mocked(sendChatMessage).mock.calls[0]!
    expect(request[0]).not.toBe("b")
    expect(request[2]).toBe("gpt-6-astra")
    expect(request[6]).toBeNull()
    expect(
      useChatStore.getState().settingsByThread[request[0]]?.selectedModel
    ).toBe("gpt-6-astra")
    expect(useChatStore.getState().activeThreadId).toBe("b")
    expect(
      useChatStore.getState().threads.find((thread) => thread.id === "b")
        ?.messages
    ).toEqual([])
  })
})
